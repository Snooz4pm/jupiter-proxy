import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import http from 'http';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// ============================================
// JUPITER FAILOVER ENDPOINTS (DNS HARDENING)
// ============================================
const JUPITER_QUOTE_ENDPOINTS = [
  'https://quote-api.jup.ag/v6/quote',
  'https://public.jupiterapi.com/quote',
];

const JUPITER_SWAP_ENDPOINTS = [
  'https://quote-api.jup.ag/v6/swap',
  'https://public.jupiterapi.com/swap',
];

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
  res.json({ status: 'ok', service: 'jupiter-proxy', mode: 'jupiter-only' });
});

// ============================================
// TOKEN LIST (JUPITER STRICT)
// ============================================
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
  return token.address && token.symbol && token.name && token.logoURI && token.symbol.length <= 10;
}

app.get('/tokens', async (req, res) => {
  try {
    console.log('[TOKENS] Fetching Jupiter strict tokens...');

    const response = await fetch('https://cache.jup.ag/strict-tokens', {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'ZenithScores/1.0' }
    });

    if (!response.ok) throw new Error(`${response.status}`);

    const tokens = await response.json();
    const filtered = tokens.filter(backendSanityFilter);
    const deduped = dedupeByAddress(filtered);

    console.log(`[TOKENS] ✓ ${deduped.length} tokens`);

    return res.json({
      source: 'jupiter-strict',
      count: deduped.length,
      tokens: deduped
    });
  } catch (error: any) {
    console.error('[TOKENS] Failed:', error.message);
    return res.status(503).json({ source: 'none', count: 0, tokens: [], error: 'Token fetch failed' });
  }
});

// ============================================
// QUOTE ENDPOINT (JUPITER ONLY + CACHE)
// ============================================
app.get('/quote', async (req, res) => {
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

    console.log(`[QUOTE] ${inputMint.slice(0,8)}... -> ${outputMint.slice(0,8)}..., amount: ${amount}`);

    // Check cache
    const key = cacheKey({ inputMint, outputMint, amount, slippageBps });
    const now = Date.now();
    const cached = quoteCache.get(key);
    
    if (cached && cached.expires > now) {
      console.log('[QUOTE] ✓ Cache hit');
      return res.json(cached.data);
    }

    // Build URLs for failover
    const params = new URLSearchParams({ inputMint, outputMint, amount, slippageBps });
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
});

// ============================================
// SWAP ENDPOINT (JUPITER ONLY)
// ============================================
app.post('/swap', async (req, res) => {
  try {
    const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true } = req.body;

    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({ error: 'Missing quoteResponse or userPublicKey' });
    }

    console.log(`[SWAP] Building tx for ${userPublicKey.slice(0,8)}...`);

    const swapPayload = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    };

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
});

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
// START SERVER
// ============================================
server.listen(PORT, () => {
  console.log(`🚀 Jupiter Proxy running on port ${PORT}`);
  console.log(`📡 Mode: Jupiter-only (no multi-DEX router)`);
  console.log(`⚠️ CORS: ${allowedOrigins.join(', ')}`);
});
