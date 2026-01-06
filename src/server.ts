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
  res.json({ status: 'ok', service: 'jupiter-proxy' });
});

// ============================================
// TOKEN LIST ENDPOINT (PRIMARY DATA SOURCE)
// ============================================
app.get('/tokens', async (req, res) => {
  try {
    console.log('[TOKENS] Fetching Jupiter token list...');

    // Try Jupiter /all endpoint
    const jupiterRes = await fetch('https://token.jup.ag/all', {
      headers: { 'User-Agent': 'ZenithScores/1.0' },
      signal: AbortSignal.timeout(8000)
    });

    if (!jupiterRes.ok) {
      throw new Error(`Jupiter API returned ${jupiterRes.status}`);
    }

    const tokens = await jupiterRes.json();
    console.log(`[TOKENS] Successfully fetched ${tokens.length} tokens from Jupiter`);

    // Return first 200 tokens (performance)
    return res.json({
      source: 'jupiter',
      count: tokens.length,
      tokens: tokens.slice(0, 200)
    });

  } catch (jupiterError: any) {
    console.error('[TOKENS] Jupiter failed, trying DexScreener fallback:', jupiterError.message);

    try {
      // Fallback to DexScreener
      const dexRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=SOL');
      const dexData: any = await dexRes.json();

      if (dexData.pairs && dexData.pairs.length > 0) {
        console.log(`[TOKENS] Fallback: DexScreener returned ${dexData.pairs.length} pairs`);

        // Transform DexScreener pairs to Jupiter token format
        const transformedTokens = dexData.pairs
          .filter((pair: any) => pair.baseToken && pair.baseToken.address)
          .map((pair: any) => ({
            address: pair.baseToken.address,
            symbol: pair.baseToken.symbol || 'UNKNOWN',
            name: pair.baseToken.name || pair.baseToken.symbol || 'Unknown Token',
            decimals: 9, // Standard Solana decimals
            logoURI: pair.info?.imageUrl || null,
            tags: ['dexscreener'],
            // Include price data for immediate use
            priceUsd: parseFloat(pair.priceUsd) || 0,
            liquidity: parseFloat(pair.liquidity?.usd) || 0,
            volume24h: parseFloat(pair.volume?.h24) || 0,
            priceChange24h: parseFloat(pair.priceChange?.h24) || 0
          }));

        return res.json({
          source: 'dexscreener',
          count: transformedTokens.length,
          tokens: transformedTokens.slice(0, 50)
        });
      }

      throw new Error('DexScreener returned no data');

    } catch (fallbackError: any) {
      console.error('[TOKENS] All sources failed:', fallbackError.message);

      // Return empty but valid response
      return res.status(503).json({
        source: 'none',
        count: 0,
        tokens: [],
        error: 'Token data sources temporarily unavailable'
      });
    }
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
  console.log(`� CORS enabled for: ${allowedOrigins.join(', ')}`);
});
