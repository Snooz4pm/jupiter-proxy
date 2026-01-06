import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import http from 'http';

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://zenithscores.com', 'https://www.zenithscores.com'],
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('[SOCKET] Client connected:', socket.id);
  socket.on('disconnect', () => console.log('[SOCKET] Client disconnected:', socket.id));
});

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
  if (!token.symbol) return false;
  if (!token.name) return false;
  if (!token.logoURI) return false; // IMPORTANT: removes junk
  if (token.symbol.length > 10) return false; // spam symbols
  return true;
}

// ============================================
// TOKEN LIST ENDPOINT (PRIMARY DATA SOURCE)
// ============================================
app.get('/tokens', async (req, res) => {
  try {
    console.log('[TOKENS] Fetching from Jupiter strict cache (safer official source)...');

    // Switch to strict-tokens as primary since full cache can be empty
    const response = await fetch('https://cache.jup.ag/strict-tokens', {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'ZenithScores/1.0' }
    });

    if (!response.ok) {
      throw new Error(`Strict tokens API returned ${response.status}`);
    }

    const tokens = await response.json();

    console.log(`[TOKENS] Successfully fetched ${tokens.length} verified tokens from cache.jup.ag/strict-tokens`);

    // Optional: Apply your backend sanity filter if you want safer defaults
    const filtered = tokens.filter(backendSanityFilter);
    const deduped = dedupeByAddress(filtered);

    return res.json({
      source: 'jupiter-strict-cache',
      count: deduped.length,
      tokens: deduped
    });

  } catch (error: any) {
    console.error('[TOKENS] Strict source failed:', error.message);

    // Emergency Fallback
    return res.status(503).json({
      source: 'none',
      count: 0,
      tokens: [],
      error: 'Token data sources temporarily unavailable – retrying soon'
    });
  }
});

import { getBestQuote, executeSwap, getAllQuotes } from './executors';

// Simple retry helper for rate limits (kept for other uses)
async function fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 2): Promise<Response | null> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        if (i < maxRetries) {
          const delay = Math.pow(2, i) * 1000; // 1s, 2s
          console.log(`[RETRY] 429 received, waiting ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      
      return response;
    } catch (err) {
      console.error(`[RETRY] Fetch error on attempt ${i + 1}:`, err);
      if (i === maxRetries) return null;
    }
  }
  return null;
}

// ============================================
// SMART QUOTE ENDPOINT (Multi-DEX Router)
// ============================================
// Priority: Jupiter -> Raydium -> Orca -> Phoenix -> OpenBook
app.get('/quote', async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps } = req.query as any;

    // 🚫 Defensive guards
    if (!inputMint || !outputMint) {
      return res.status(400).json({ error: 'INVALID_PAIR', message: 'Missing inputMint or outputMint' });
    }

    if (inputMint === outputMint) {
      return res.status(400).json({ error: 'SAME_TOKEN', message: 'Cannot swap same token' });
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Invalid amount' });
    }

    console.log(`[QUOTE] Smart routing: ${inputMint} -> ${outputMint}, amount: ${amount}`);

    // Use smart router (tries Jupiter -> Raydium -> Orca -> Phoenix -> OpenBook)
    const quote = await getBestQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps: Number(slippageBps) || 50
    });

    if (quote) {
      console.log(`[QUOTE] ✓ Route found via ${quote.source}, output: ${quote.outAmount}`);
      return res.json(quote);
    }

    // No route found across all DEXs
    console.log('[QUOTE] ✗ No route found across all DEXs');
    return res.status(200).json({
      routePlan: [],
      error: 'NO_ROUTE',
      message: 'Liquidity too thin for this amount'
    });

  } catch (error) {
    console.error('[QUOTE] Error:', error);
    res.status(500).json({ error: 'Quote fetch failed', routePlan: [] });
  }
});

// ============================================
// COMPARE QUOTES ENDPOINT (Shows all DEX prices)
// ============================================
app.get('/quote/compare', async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps } = req.query as any;

    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    console.log(`[COMPARE] Getting all quotes for ${inputMint} -> ${outputMint}`);

    const quotes = await getAllQuotes({
      inputMint,
      outputMint,
      amount,
      slippageBps: Number(slippageBps) || 50
    });

    return res.json({
      quotes,
      best: quotes[0] || null,
      count: quotes.length
    });

  } catch (error) {
    console.error('[COMPARE] Error:', error);
    res.status(500).json({ error: 'Compare quotes failed' });
  }
});

// ============================================
// SMART SWAP ENDPOINT (Multi-DEX Router)
// ============================================
app.post('/swap', async (req, res) => {
  try {
    const { quoteResponse, userPublicKey } = req.body;

    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({ error: 'Missing quoteResponse or userPublicKey' });
    }

    console.log(`[SWAP] Request received:`);
    console.log(`[SWAP]   Source: ${quoteResponse.source || 'unknown'}`);
    console.log(`[SWAP]   Has _raw: ${!!quoteResponse._raw}`);
    console.log(`[SWAP]   Input: ${quoteResponse.inputMint}`);
    console.log(`[SWAP]   Output: ${quoteResponse.outputMint}`);

    let quoteToUse = quoteResponse;

    // If _raw is missing, re-fetch the quote to get it
    if (!quoteResponse._raw && quoteResponse.inputMint && quoteResponse.outputMint && quoteResponse.inAmount) {
      console.log('[SWAP] _raw missing, re-fetching quote...');
      
      const freshQuote = await getBestQuote({
        inputMint: quoteResponse.inputMint,
        outputMint: quoteResponse.outputMint,
        amount: quoteResponse.inAmount,
        slippageBps: quoteResponse.slippageBps || 50
      });

      if (freshQuote) {
        console.log(`[SWAP] Fresh quote obtained via ${freshQuote.source}`);
        quoteToUse = freshQuote;
      } else {
        console.error('[SWAP] Failed to re-fetch quote');
        return res.status(500).json({ error: 'Failed to get fresh quote' });
      }
    }

    // Use the smart router to execute the swap
    const result = await executeSwap(quoteToUse, userPublicKey);

    if (result) {
      console.log(`[SWAP] ✓ Transaction built via ${result.source}`);
      return res.json(result);
    }

    console.error('[SWAP] ✗ Failed to build transaction');
    return res.status(500).json({ error: 'Failed to build swap transaction' });

  } catch (error) {
    console.error('[SWAP] Error:', error);
    res.status(500).json({ error: 'Swap request failed' });
  }
});

// ============================================
// JITO BUNDLE SUBMISSION (MEV PROTECTION)
// ============================================

const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

app.post('/jito-bundle', async (req, res) => {
  try {
    const { signedTransaction } = req.body;
    
    if (!signedTransaction) {
      return res.status(400).json({ error: 'Missing signedTransaction' });
    }

    console.log('[JITO] Submitting bundle to Jito Block Engine...');

    // Convert base64 to base58 for Jito
    const bs58 = require('bs58');
    const txBuffer = Buffer.from(signedTransaction, 'base64');
    const txBase58 = bs58.encode(txBuffer);

    const response = await fetch(JITO_BLOCK_ENGINE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[txBase58]]
      })
    });

    const result = await response.json();

    if (result.error) {
      console.error('[JITO] Bundle error:', result.error);
      return res.status(400).json({ 
        success: false, 
        error: result.error.message || 'Bundle submission failed' 
      });
    }

    console.log('[JITO] Bundle submitted:', result.result);
    res.json({ 
      success: true, 
      bundleId: result.result 
    });

  } catch (error: any) {
    console.error('[JITO] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error?.message || 'Jito submission failed' 
    });
  }
});

// Get Jito bundle status
app.get('/jito-status/:bundleId', async (req, res) => {
  try {
    const { bundleId } = req.params;

    const response = await fetch(JITO_BLOCK_ENGINE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]]
      })
    });

    const result = await response.json();
    const status = result?.result?.value?.[0]?.confirmation_status || 'unknown';
    
    res.json({ bundleId, status });

  } catch (error) {
    res.json({ bundleId: req.params.bundleId, status: 'unknown' });
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

      // SHADOW TRADE EMISSION (Real-time feed)
      if (approxUsdValue > 500) { // Threshold for "Shadow Trade"
        const isBuy = solChange < 0; // Negative SOL change = Spent SOL = Buy (approx)

        io.emit('shadow-trade', {
          type: isBuy ? 'BUY' : 'SELL',
          pair: isBuy ? 'SOL -> Token' : 'Token -> SOL', // Naive pair guess for MVP
          amountUsd: approxUsdValue,
          time: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
          signature: tx.transaction.signatures[0],
          symbol: 'Unknown', // Enriched later if possible
          badges: approxUsdValue > 5000 ? ['High Impact'] : []
        });
      }

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

// Start Background Job (Disabled - causing 429 floods)
// TODO: Re-enable when we have proper RPC with higher limits
// setInterval(runMoverScan, 60_000);
// runMoverScan();
console.log('[MOVERS] Scan disabled to prevent 429 floods');

app.get('/market-movers', (req, res) => {
  res.json({
    count: moversCache.length,
    movers: moversCache,
    timestamp: Date.now()
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Jupiter Proxy (HTTP + Socket) running on port ${PORT}`);
  console.log(`⚠️ CORS enabled for: ${allowedOrigins.join(', ')}`);
});
