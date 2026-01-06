import express from 'express';
import cors from 'cors';

const app = express();
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
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'jupiter-proxy'
  });
});

// ============================================
// TOKEN LIST ENDPOINT (LAYER 1: Universe)
// ============================================
app.get('/tokens', async (req, res) => {
  try {
    // Hard timeout to prevent hangs
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const r = await fetch(`${JUPITER_API}/tokens`, {
      headers: {
        'accept': 'application/json',
        'user-agent': 'ZenithScores'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!r.ok) {
      throw new Error(`Jupiter HTTP ${r.status}`);
    }

    const tokens = await r.json();
    console.log(`[TOKENS] Successfully fetched ${tokens.length} tokens from Jupiter`);

    // Return normalized schema
    res.json({
      source: 'jupiter',
      count: tokens.length,
      tokens: tokens.map((t: any) => ({
        mint: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logoURI: t.logoURI,
        tags: t.tags || []
      }))
    });

  } catch (error: any) {
    console.error('JUPITER FETCH ERROR:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);

    // Return empty but valid response (never crash UI)
    res.status(500).json({
      source: 'none',
      count: 0,
      tokens: [],
      error: error.message || 'Token universe temporarily unavailable'
    });
  }
});

// ============================================
// DEXSCREENER ENDPOINT (LAYER 3: Market Data)
// ============================================
app.get('/market-data', async (req, res) => {
  try {
    console.log('[MARKET] Fetching DexScreener trending...');

    const dexRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=SOL', {
      signal: AbortSignal.timeout(8000)
    });

    if (!dexRes.ok) {
      throw new Error(`DexScreener returned ${dexRes.status}`);
    }

    const data: any = await dexRes.json();
    const solanaPairs = data.pairs?.filter((p: any) => p.chainId === 'solana') || [];

    res.json({
      source: 'dexscreener',
      count: solanaPairs.length,
      pairs: solanaPairs
    });

  } catch (error: any) {
    console.error('[MARKET] DexScreener failed:', error.message);
    res.status(503).json({
      source: 'none',
      count: 0,
      pairs: [],
      error: 'Market data temporarily unavailable'
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

app.listen(PORT, () => {
  console.log(`🚀 Jupiter Proxy running on port ${PORT}`);
  console.log(`📡 CORS enabled for: ${allowedOrigins.join(', ')}`);
  console.log(`🔗 Jupiter API: ${JUPITER_API}`);
});
