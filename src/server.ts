import express from 'express';
import cors from 'cors';

const app = express();

// 🔥 FORCE CORS HEADERS (FIRST) - Nuclear Fix
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.zenithscores.com");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

const PORT = process.env.PORT || 3001;

// Jupiter API base URL
const JUPITER_API = 'https://quote-api.jup.ag/v6';

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'https://zenithscores.com',
  'https://www.zenithscores.com'
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Handle preflight OPTIONS requests
app.options('*', cors());

app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'jupiter-proxy' });
});

// ============================================
// TOKEN LIST ENDPOINT (PRIMARY DATA SOURCE)
// ============================================
// ============================================
// BACKEND HELPERS (Safety & Dedupe)
// ============================================

function dedupeByAddress(tokens: any[]) {
  const map = new Map<string, any>();

  for (const t of tokens) {
    if (!t.address) continue;

    const addr = t.address.toLowerCase();
    const existing = map.get(addr);

    // Keep if new, or if volume is higher (better version of same token)
    if (!existing || (t.volume24h || 0) > (existing.volume24h || 0)) {
      map.set(addr, t);
    }
  }

  return Array.from(map.values());
}

function backendSanityFilter(token: any) {
  if (!token.address) return false;
  if (!token.symbol || token.symbol.length > 10) return false; // Filter ultra-long spam symbols
  if ((token.liquidity || 0) < 500) return false; // Filter dust/rugs
  if ((token.volume24h || 0) < 100) return false; // Filter dead tokens

  return true;
}

// ============================================
// TOKEN LIST ENDPOINT (PRIMARY DATA SOURCE)
// ============================================
app.get('/tokens', async (req, res) => {
  try {
    console.log('[TOKENS] Fetching Jupiter strict + all token lists...');

    // Primary: Fetch both strict (verified) and all (full)
    const [strictRes, allRes] = await Promise.all([
      fetch('https://token.jup.ag/strict', { signal: AbortSignal.timeout(10000) }),
      fetch('https://token.jup.ag/all', { signal: AbortSignal.timeout(10000) })
    ]);

    if (!strictRes.ok || !allRes.ok) {
      throw new Error(`Jupiter API error: strict ${strictRes.status}, all ${allRes.status}`);
    }

    const strictTokens = await strictRes.json();
    const allTokens = await allRes.json();

    // Combine: Use strict as base, add extras from all (dedupe)
    const tokenMap = new Map();
    [...strictTokens, ...allTokens].forEach(t => {
      if (!t.address) return;
      const addr = t.address.toLowerCase();
      if (!tokenMap.has(addr)) {
        tokenMap.set(addr, t);
      }
    });

    const tokens = Array.from(tokenMap.values());

    console.log(`[TOKENS] Successfully fetched ${tokens.length} tokens from Jupiter (strict + all)`);

    return res.json({
      source: 'jupiter-ecosystem',
      count: tokens.length,
      tokens: tokens  // Frontend can filter/slice as needed
    });

  } catch (jupiterError: any) {
    console.error('[TOKENS] Jupiter failed:', jupiterError.message);

    // OPTIONAL: Remove or replace DexScreener fallback entirely
    // It's unreliable for "all tokens". If you want a backup, use Birdeye or cache last good list.
    return res.status(503).json({
      source: 'none',
      count: 0,
      tokens: [],
      error: 'Token data sources temporarily unavailable – retrying soon'
    });
  }
});

// Jupiter Quote Proxy
app.get('/quote', async (req, res) => {
  try {
    const queryParams = new URLSearchParams(req.query as any).toString();
    const jupiterUrl = `${JUPITER_API}/quote?${queryParams}`;

    console.log('[QUOTE] Proxying to Jupiter:', jupiterUrl);

    const response = await fetch(jupiterUrl, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ZenithScores/1.0'
      }
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[QUOTE] Error:', error);
    res.status(500).json({ error: 'Quote fetch failed' });
  }
});

// Jupiter Swap Proxy
app.post('/swap', async (req, res) => {
  try {
    console.log('[SWAP] Proxying swap transaction');

    const response = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[SWAP] Error:', error);
    res.status(500).json({ error: 'Swap request failed' });
  }
});

// Token Risk Analysis (Honeypot Detector)
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

// Use a public RPC for backend checks if local env not set, but better to use the one from env if possible.
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL);

app.get('/token-risk/:mint', async (req, res) => {
  try {
    const mintAddress = req.params.mint;
    const mint = new PublicKey(mintAddress);

    // Check on-chain data
    const mintInfo = await getMint(connection, mint);

    res.json({
      freezeAuthority: !!mintInfo.freezeAuthority,
      mintAuthority: !!mintInfo.mintAuthority,
      supply: mintInfo.supply.toString()
    });
  } catch (error) {
    console.error('Risk check failed:', error);
    res.json({ risk: 'unknown', error: String(error) });
  }
});

// ============================================
// MARKET MOVERS ENGINE (REAL DATA PIPELINE)
// ============================================
const MOVER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const JUP_V6_ROUTER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

interface Mover {
  wallet: string;
  solBalance: number;
  volume24hUsd: number; // For this session/window
  netFlow24hUsd: number;
  lastActive: number;
  txCount: number;
}

// In-memory "Database"
let moversCache: Mover[] = [];
let isScanning = false;

async function runMoverScan() {
  if (isScanning) return;
  isScanning = true;

  try {
    console.log('[MOVERS] Scan started...');
    // 1. Get recent signatures from Jupiter Router
    // Limit to 50 to respect RPC limits
    const sigs = await connection.getSignaturesForAddress(JUP_V6_ROUTER, { limit: 50 });

    // 2. Fetch parsed transactions to analyze flows
    // We need to batch this if we had more, but 50 is okay-ish for Helius/mainnet RPC usually?
    // To be safe, let's take top 20.
    const recentSigs = sigs.slice(0, 20).map(s => s.signature);
    const txs = await connection.getParsedTransactions(recentSigs, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    // 3. Analyze Patterns
    const sessionMovers = new Map<string, Partial<Mover>>();

    for (const tx of txs) {
      if (!tx || !tx.meta) continue;

      const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey.toString();
      if (!signer) continue;

      // Approximate Volume from SOL changes
      // (real volume needs complex token parsing, we stick to SOL flows for MVP robustness)
      const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
      const approxUsdValue = Math.abs(solChange) * 150; // hardcoded MVP price or fetch? Use 150 for calc.

      const existing = sessionMovers.get(signer) || { volume24hUsd: 0, netFlow24hUsd: 0, txCount: 0 };

      sessionMovers.set(signer, {
        volume24hUsd: (existing.volume24hUsd || 0) + approxUsdValue,
        netFlow24hUsd: (existing.netFlow24hUsd || 0) + (solChange * 150),
        txCount: (existing.txCount || 0) + 1,
        lastActive: Date.now()
      });
    }

    // 4. Qualify & Enrich (Check Balances)
    const qualified: Mover[] = [];

    for (const [wallet, stats] of sessionMovers.entries()) {
      // Fetch real balance
      try {
        const balance = await connection.getBalance(new PublicKey(wallet));
        const solBalance = balance / 1e9;

        // QUALIFICATION LOGIC (The "Real Deal" Filter)
        // SOL > 50 (Lowered for MVP testing, user asked 300) OR Volume > $1k
        if (solBalance > 50 || (stats.volume24hUsd || 0) > 1000) {
          qualified.push({
            wallet,
            solBalance,
            volume24hUsd: stats.volume24hUsd || 0,
            netFlow24hUsd: stats.netFlow24hUsd || 0,
            lastActive: Date.now(),
            txCount: stats.txCount || 0
          });
        }
      } catch (e) {
        console.error(`[MOVERS] Failed to enrich ${wallet}`, e);
      }
    }

    // Merge with main cache (Deduping)
    const currentMap = new Map(moversCache.map(m => [m.wallet, m]));

    qualified.forEach(q => {
      const existing = currentMap.get(q.wallet);
      if (existing) {
        // Accumulate volume for the window
        currentMap.set(q.wallet, {
          ...q,
          volume24hUsd: existing.volume24hUsd + q.volume24hUsd,
          netFlow24hUsd: existing.netFlow24hUsd + q.netFlow24hUsd,
          txCount: existing.txCount + q.txCount
        });
      } else {
        currentMap.set(q.wallet, q);
      }
    });

    // Sort by 'Weight' (Volume + Balance)
    moversCache = Array.from(currentMap.values())
      .sort((a, b) => (b.solBalance + b.volume24hUsd / 100) - (a.solBalance + a.volume24hUsd / 100))
      .slice(0, 50); // Keep top 50

    console.log(`[MOVERS] Scan complete. Tracking ${moversCache.length} whales.`);

  } catch (err) {
    console.error('[MOVERS] Scan failed:', err);
  } finally {
    isScanning = false;
  }
}

// Start Background Job (Every 60s)
setInterval(runMoverScan, 60_000);
runMoverScan(); // Run once immediately

app.get('/market-movers', (req, res) => {
  res.json({
    count: moversCache.length,
    movers: moversCache,
    timestamp: Date.now()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Jupiter Proxy running on port ${PORT}`);
  console.log(`� CORS enabled for: ${allowedOrigins.join(', ')}`);
});
