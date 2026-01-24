import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import http from 'http';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { DiscoveryEngine } from './discoveryEngine';

const app = express();
app.use(cors()); // Enable CORS for total data flow
app.use(express.json({ limit: '5mb' })); // Allow Helius payloads

// Diagnostic Middleware: Log every request to debug 404
app.use((req, res, next) => {
  console.log(`[DEBUG] ${req.method} ${req.url}`);
  next();
});

const discovery = new DiscoveryEngine();
discovery.start();

// Verification endpoint
app.get('/health', (req, res) => res.send('OK'));

// Final safety fallback for token list
const EMERGENCY_BOOTSTRAP_TOKENS = [
  { symbol: 'SOL', name: 'Solana', address: 'So11111111111111111111111111111111111111112', decimals: 9, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
  { symbol: 'USDC', name: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
  { symbol: 'USDT', name: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png' }
];

// ============================================
// ARGUS DISCOVERY FEED & WEBHOOK
// ============================================
app.get('/api/argus/feed', (req, res) => {
  const feed = discovery.getFeed();
  console.log(`[ARGUS_FEED] Dispatching ${feed.length} signals to frontend.`);
  res.json({
    timestamp: Date.now(),
    count: feed.length,
    tokens: feed
  });
});

app.post('/api/discovery/webhook', async (req, res) => {
  // Optional: Verify Authorization header if set in Helius dashboard
  await discovery.handleWebhook(req.body);
  res.sendStatus(200);
});

// ============================================
// WALLET BALANCE ENDPOINT (for frontend)
// ============================================
app.get('/api/wallet/:pubkey', async (req, res) => {
  try {
    const pubkey = req.params.pubkey;
    if (!pubkey) return res.status(400).json({ error: 'Missing pubkey' });

    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const owner = new PublicKey(pubkey);

    // Get SOL balance
    const balanceLamports = await connection.getBalance(owner);

    // Get SPL token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
    const tokens = tokenAccounts.value.map(acc => {
      const info = acc.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: parseFloat(info.tokenAmount.uiAmountString || '0'),
        decimals: info.tokenAmount.decimals
      };
    });

    res.json({ balanceLamports, tokens });
  } catch (err) {
    console.error('[WalletBalance] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch wallet snapshot' });
  }
});
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// ============================================
// JUPITER FAILOVER ENDPOINTS (DNS HARDENING)
// ============================================
// Using new Metis API (v1) - v6 is deprecated
const JUPITER_QUOTE_ENDPOINTS = [
  'https://api.jup.ag/swap/v1/quote',
  'https://quote-api.jup.ag/v6/quote', // fallback to v6
];

const JUPITER_SWAP_ENDPOINTS = [
  'https://api.jup.ag/swap/v1/swap',
  'https://quote-api.jup.ag/v6/swap', // fallback to v6
];

// Jupiter API Key (enables higher fee limits)
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '9734e999-cc55-46e5-ba68-f7def92483aa';

// ============================================
// PLATFORM FEE CONFIGURATION (REVENUE)
// ============================================
// Your wallet receives 0.5% of each swap (paid in output token)
const PLATFORM_FEE_BPS = 50; // 0.5% = 50 basis points
const FEE_WALLET = new PublicKey('GRd3X2emDp2nmSXt1GrM9KA8EDeqW4ifgP3muwoTmzqb');

// Native SOL mint address (for wrapping/unwrapping)
const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Get the Associated Token Account (ATA) for fee collection
 * Fees are collected in the OUTPUT token of the swap
 */
function getFeeTokenAccount(outputMint: string): string {
  try {
    const mintPubkey = new PublicKey(outputMint);

    // For native SOL, use wrapped SOL (WSOL) ATA
    const ata = getAssociatedTokenAddressSync(
      mintPubkey,
      FEE_WALLET,
      true, // allowOwnerOffCurve
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    return ata.toBase58();
  } catch (err) {
    console.error('[FEE] Error computing ATA:', err);
    return '';
  }
}

// ============================================
// QUOTE CACHE (15s TTL - NO SPAM)
// ============================================
type CachedQuote = { data: any; expires: number };
const quoteCache = new Map<string, CachedQuote>();

function cacheKey(p: any): string {
  return `${p.inputMint}:${p.outputMint}:${p.amount}:${p.slippageBps}`;
}

// ============================================
// FETCH WITH FAILOVER (CORE HELPER)
// ============================================
async function fetchWithFailover(
  urls: string[],
  options: RequestInit = {},
  timeoutMs = 8000
): Promise<Response | null> {
  let lastError: any;

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);

      console.log(`[Jupiter] Trying: ${url.split('?')[0]}`);

      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ZenithScores/1.0',
          'x-api-key': JUPITER_API_KEY, // Required for fee collection
          ...(options.headers || {}),
        },
      });

      clearTimeout(id);

      if (res.ok) {
        console.log(`[Jupiter] ✓ Success`);
        return res;
      }

      console.log(`[Jupiter] ${res.status} from ${new URL(url).hostname}`);

      // Rate limit - try next
      if (res.status === 429) continue;

      // Other errors - return for caller to handle
      return res;
    } catch (err: any) {
      lastError = err;
      console.log(`[Jupiter] Failed: ${err.code || err.message}`);
    }
  }

  console.error('[Jupiter] All endpoints failed');
  return null;
}

// ============================================
// SOCKET.IO (REAL-TIME FEEDS)
// ============================================
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'https://zenithscores.com',
  'https://www.zenithscores.com'
];

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] }
});

io.on('connection', (socket) => {
  console.log('[SOCKET] Connected:', socket.id);
  socket.on('disconnect', () => console.log('[SOCKET] Disconnected:', socket.id));
});

// ============================================
// CORS MIDDLEWARE
// ============================================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.zenithscores.com");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.options('*', cors());
app.use(express.json());

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'jupiter-proxy',
    mode: 'jupiter-only',
    platformFee: `${PLATFORM_FEE_BPS / 100}%`,
    feeWallet: FEE_WALLET.toBase58().slice(0, 8) + '...'
  });
});

// ============================================
// FEE ACCOUNT INFO (for debugging)
// ============================================
app.get('/fee-info', (req, res) => {
  const { mint } = req.query as { mint?: string };

  // Common tokens ATAs
  const commonMints = [
    { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
    { symbol: 'SOL (Wrapped)', mint: 'So11111111111111111111111111111111111111112' },
    { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
    { symbol: 'JLP', mint: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4' },
    { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  ];

  const accounts = commonMints.map(t => ({
    ...t,
    feeATA: getFeeTokenAccount(t.mint)
  }));

  // If specific mint requested
  let requestedATA = null;
  if (mint) {
    requestedATA = {
      mint,
      feeATA: getFeeTokenAccount(mint)
    };
  }

  res.json({
    feeWallet: FEE_WALLET.toBase58(),
    platformFeeBps: PLATFORM_FEE_BPS,
    platformFeePercent: `${PLATFORM_FEE_BPS / 100}%`,
    note: 'These ATAs must be initialized on-chain to receive fees. Use Phantom or Solana CLI to create them.',
    requestedATA,
    commonTokenATAs: accounts
  });
});

// ============================================
// TOKEN LIST (JUPITER STRICT) + CACHE
// ============================================
// Token cache (10 minute TTL)
let cachedTokenList: any[] = [];
let tokenCacheTime = 0;
const TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedTokens(): any[] {
  return cachedTokenList;
}

function setTokenCache(tokens: any[]) {
  cachedTokenList = tokens;
  tokenCacheTime = Date.now();
}

function isTokenCacheValid(): boolean {
  return Date.now() - tokenCacheTime < TOKEN_CACHE_TTL && cachedTokenList.length > 0;
}

function dedupeByAddress(tokens: any[]) {
  const map = new Map<string, any>();
  for (const t of tokens) {
    if (!t.address) continue;
    const addr = t.address.toLowerCase();
    const existing = map.get(addr);
    if (!existing || (t.volume24h || 0) > (existing.volume24h || 0)) {
      map.set(addr, t);
    }
  }
  return Array.from(map.values());
}

function backendSanityFilter(token: any) {
  // Relaxed for 'all' list: Logo not strictly required, symbol can be longer
  return token.address && token.symbol && token.name;
}

app.get('/tokens', async (req, res) => {
  try {
    // Return cached if valid
    if (isTokenCacheValid()) {
      console.log('[TOKENS] ✓ Cache hit');
      return res.json({
        source: 'memory-cache',
        count: getCachedTokens().length,
        tokens: getCachedTokens()
      });
    }

    console.log('[TOKENS] Fetching Verified Jupiter Universe...');

    const JUP_ENDPOINTS = [
      "https://cache.jup.ag/tokens",
      "https://quote-api.jup.ag/v6/tokens"
    ];

    let tokens: any[] = [];
    let source = 'none';

    for (const url of JUP_ENDPOINTS) {
      try {
        console.log(`[TOKENS] Trying: ${url}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "Accept": "application/json" }
        });
        clearTimeout(timeout);

        if (!response.ok) continue;

        const text = await response.text();
        if (text.startsWith("<!DOCTYPE")) {
          console.warn(`[TOKENS] HTML response detected from ${url}`);
          continue;
        }

        const json = JSON.parse(text);
        if (!Array.isArray(json) || json.length === 0) {
          console.warn(`[TOKENS] Empty or invalid JSON from ${url}`);
          continue;
        }

        tokens = json;
        source = url.includes('cache') ? 'jup-cache' : 'jup-v6-api';
        console.log(`[TOKENS] ✓ Success from ${source}: ${tokens.length} tokens`);
        break;
      } catch (err: any) {
        console.warn(`[TOKENS] Failed: ${url} (${err.message})`);
      }
    }

    if (tokens.length > 0) {
      const filtered = tokens.filter(backendSanityFilter);
      const deduped = dedupeByAddress(filtered);
      setTokenCache(deduped);
      return res.json({ source, count: deduped.length, tokens: deduped });
    }

    // EMERGENCY FALLBACK: Stale memory -> Bootstrap -> Error
    const stale = getCachedTokens();
    if (stale.length > 0) {
      return res.json({ source: 'stale-cache', count: stale.length, tokens: stale, warning: 'All live mirrors failed' });
    }

    // Final safety net using the hardcoded bootstrap list
    setTokenCache(EMERGENCY_BOOTSTRAP_TOKENS || []);
    return res.json({ source: 'emergency-bootstrap', count: (EMERGENCY_BOOTSTRAP_TOKENS || []).length, tokens: EMERGENCY_BOOTSTRAP_TOKENS || [] });
  } catch (err: any) {
    console.error('[TOKENS] Critical failure:', err);
    res.status(500).json({ error: 'Failed to fetch tokens', message: err.message });
  }
});

// ============================================
// QUOTE ENDPOINT (JUPITER ONLY + CACHE)
// ============================================
const quoteHandler = async (req: express.Request, res: express.Response) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = '50' } = req.query as any;

    // Guards
    if (!inputMint || !outputMint) {
      return res.status(400).json({ error: 'INVALID_PAIR', message: 'Missing inputMint or outputMint' });
    }
    if (inputMint === outputMint) {
      return res.status(400).json({ error: 'SAME_TOKEN', message: 'Cannot swap same token' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Invalid amount' });
    }

    console.log(`[QUOTE] ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}..., amount: ${amount}`);

    // Check cache
    const key = cacheKey({ inputMint, outputMint, amount, slippageBps });
    const now = Date.now();
    const cached = quoteCache.get(key);

    if (cached && cached.expires > now) {
      console.log('[QUOTE] ✓ Cache hit');
      return res.json(cached.data);
    }

    // Build URLs for failover (include platform fee)
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps,
      platformFeeBps: PLATFORM_FEE_BPS.toString()
    });
    const urls = JUPITER_QUOTE_ENDPOINTS.map(ep => `${ep}?${params}`);

    const response = await fetchWithFailover(urls, { method: 'GET' });

    if (!response) {
      return res.status(502).json({ error: 'JUPITER_UNAVAILABLE', routePlan: [] });
    }

    if (!response.ok) {
      const text = await response.text();
      console.log('[QUOTE] Jupiter error:', response.status, text);
      return res.status(200).json({ routePlan: [], error: 'NO_ROUTE', message: 'No route found' });
    }

    const quote = await response.json();

    // Check valid route
    if (!quote?.routePlan?.length) {
      console.log('[QUOTE] ✗ No route');
      return res.status(200).json({ routePlan: [], error: 'NO_ROUTE', message: 'Liquidity too thin' });
    }

    console.log(`[QUOTE] ✓ Output: ${quote.outAmount}`);

    // Cache it (15s TTL)
    quoteCache.set(key, { data: quote, expires: now + 15_000 });

    return res.json(quote);

  } catch (error) {
    console.error('[QUOTE] Error:', error);
    res.status(500).json({ error: 'Quote failed', routePlan: [] });
  }
};

app.get('/quote', quoteHandler);
app.get('/jupiter/quote', quoteHandler);

// ============================================
// SWAP ENDPOINT (JUPITER ONLY)
// ============================================
const swapHandler = async (req: express.Request, res: express.Response) => {
  try {
    const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true } = req.body;

    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({ error: 'Missing quoteResponse or userPublicKey' });
    }

    // Get the output mint from the quote to compute fee ATA
    const outputMint = quoteResponse.outputMint;
    const feeTokenAccount = getFeeTokenAccount(outputMint);

    console.log(`[SWAP] Building tx for ${userPublicKey.slice(0, 8)}...`);
    console.log(`[SWAP] Fee: ${PLATFORM_FEE_BPS}bps -> ATA: ${feeTokenAccount.slice(0, 8)}... (mint: ${outputMint.slice(0, 8)}...)`);

    // Build swap payload with fee collection
    const swapPayload: any = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    };

    // Only add feeAccount if we have a valid ATA
    // Note: The ATA must exist on-chain for fee collection to work
    if (feeTokenAccount) {
      swapPayload.feeAccount = feeTokenAccount;
    }

    const response = await fetchWithFailover(JUPITER_SWAP_ENDPOINTS, {
      method: 'POST',
      body: JSON.stringify(swapPayload)
    });

    if (!response) {
      return res.status(502).json({ error: 'Jupiter swap unavailable' });
    }

    if (!response.ok) {
      const text = await response.text();
      console.log('[SWAP] Jupiter error:', response.status, text);
      return res.status(400).json({ error: 'Swap build failed', details: text });
    }

    const data = await response.json();

    if (!data?.swapTransaction) {
      console.log('[SWAP] ✗ No transaction returned');
      return res.status(400).json({ error: 'No transaction returned' });
    }

    console.log('[SWAP] ✓ Transaction built');
    return res.json(data);

  } catch (error) {
    console.error('[SWAP] Error:', error);
    res.status(500).json({ error: 'Swap failed' });
  }
};

app.post('/swap', swapHandler);
app.post('/jupiter/swap', swapHandler);

// ============================================
// JITO BUNDLE (MEV PROTECTION)
// ============================================
const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

app.post('/jito-bundle', async (req, res) => {
  try {
    const { signedTransaction } = req.body;
    if (!signedTransaction) {
      return res.status(400).json({ error: 'Missing signedTransaction' });
    }

    console.log('[JITO] Submitting bundle...');

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
      console.error('[JITO] Error:', result.error);
      return res.status(400).json({ success: false, error: result.error.message });
    }

    console.log('[JITO] ✓ Bundle:', result.result);
    res.json({ success: true, bundleId: result.result });

  } catch (error: any) {
    console.error('[JITO] Error:', error);
    res.status(500).json({ success: false, error: error?.message });
  }
});

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

// ============================================
// TOKEN RISK CHECK
// ============================================
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL);

app.get('/token-risk/:mint', async (req, res) => {
  try {
    const mint = new PublicKey(req.params.mint);
    const mintInfo = await getMint(connection, mint);

    res.json({
      freezeAuthority: !!mintInfo.freezeAuthority,
      mintAuthority: !!mintInfo.mintAuthority,
      supply: mintInfo.supply.toString()
    });
  } catch (error) {
    res.json({ risk: 'unknown', error: String(error) });
  }
});

// ============================================
// WHALE SIGNALS (MAJOR BUYS/SELLS)
// ============================================
interface WhaleSignal {
  type: 'BUY' | 'SELL';
  wallet: string;
  token: {
    symbol: string;
    mint: string;
    logoURI?: string;
  };
  amount: number;
  amountUsd: number;
  txSignature: string;
  timestamp: number;
}

// Signal cache (refreshed every 15 seconds)
let signalCache: WhaleSignal[] = [];
let signalLastFetch = 0;
const SIGNAL_TTL = 15_000; // 15 seconds
const MIN_USD_VALUE = 10_000; // $10k minimum

// Known whale wallets (top Jupiter/Solana traders)
const WHALE_WALLETS = [
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Jupiter whale
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP team
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium
  'Hzc8CFgMJjTKfGJdW2CZZcqjfT2vvBi8nLsb1rRvFCYH', // Solana whale
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // Drift
];

// Token info cache
const tokenInfoCache = new Map<string, { symbol: string; logoURI?: string; decimals: number }>();

async function getTokenInfo(mint: string): Promise<{ symbol: string; logoURI?: string; decimals: number } | null> {
  if (tokenInfoCache.has(mint)) return tokenInfoCache.get(mint)!;

  // Try to find in our cached token list
  const cachedTokens = getCachedTokens();
  const found = cachedTokens.find((t: any) => t.address === mint);
  if (found) {
    const info = { symbol: found.symbol, logoURI: found.logoURI, decimals: found.decimals || 6 };
    tokenInfoCache.set(mint, info);
    return info;
  }

  return null;
}

// Simulated whale signals (in production, use Helius webhooks or RPC polling)
async function fetchWhaleSignals(): Promise<WhaleSignal[]> {
  // For demo, generate realistic-looking signals
  // In production: Use Helius API or poll getSignaturesForAddress

  const tokens = getCachedTokens().slice(0, 50); // Top 50 tokens
  if (tokens.length === 0) return [];

  const signals: WhaleSignal[] = [];
  const now = Date.now();

  // Generate 5-10 realistic signals
  const numSignals = 5 + Math.floor(Math.random() * 6);

  for (let i = 0; i < numSignals; i++) {
    const token = tokens[Math.floor(Math.random() * Math.min(20, tokens.length))];
    const isBuy = Math.random() > 0.45; // Slightly more buys
    const usdValue = MIN_USD_VALUE + Math.random() * 990_000; // $10k - $1M
    const wallet = WHALE_WALLETS[Math.floor(Math.random() * WHALE_WALLETS.length)];

    // Calculate token amount from USD (mock price)
    const mockPrice = token.symbol === 'SOL' ? 140 :
      token.symbol === 'JUP' ? 1.2 :
        token.symbol === 'BONK' ? 0.00002 :
          0.5 + Math.random() * 10;
    const amount = usdValue / mockPrice;

    signals.push({
      type: isBuy ? 'BUY' : 'SELL',
      wallet: wallet,
      token: {
        symbol: token.symbol,
        mint: token.address,
        logoURI: token.logoURI,
      },
      amount: Math.round(amount * 1000) / 1000,
      amountUsd: Math.round(usdValue),
      txSignature: `${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}`,
      timestamp: now - Math.floor(Math.random() * 300_000), // Last 5 minutes
    });
  }

  // Sort by timestamp (newest first)
  return signals.sort((a, b) => b.timestamp - a.timestamp);
}

app.get('/signals', async (req, res) => {
  try {
    const now = Date.now();

    // Return cached if valid
    if (now - signalLastFetch < SIGNAL_TTL && signalCache.length > 0) {
      return res.json({
        source: 'cache',
        count: signalCache.length,
        signals: signalCache,
        nextRefresh: SIGNAL_TTL - (now - signalLastFetch),
      });
    }

    // Fetch new signals
    console.log('[SIGNALS] Fetching whale activity...');
    const signals = await fetchWhaleSignals();

    signalCache = signals;
    signalLastFetch = now;

    return res.json({
      source: 'fresh',
      count: signals.length,
      signals: signals,
      nextRefresh: SIGNAL_TTL,
    });

  } catch (error: any) {
    console.error('[SIGNALS] Error:', error.message);
    return res.json({
      source: 'error',
      count: signalCache.length,
      signals: signalCache, // Return stale cache on error
      error: error.message,
    });
  }
});

// ============================================
// START SERVER
// ============================================
server.listen(PORT, () => {
  console.log(`🚀 Jupiter Proxy running on port ${PORT}`);
  console.log(`📡 Mode: Jupiter-only (no multi-DEX router)`);
  console.log(`⚠️ CORS: ${allowedOrigins.join(', ')}`);
});
