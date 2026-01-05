import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

// Jupiter API base URL - api.jup.ag/swap/v1 is designed for servers
const JUPITER_API = 'https://api.jup.ag/swap/v1';

// CORS configuration - allow your Vercel domain
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST'],
  credentials: true,
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'jupiter-proxy' });
});

/**
 * GET /quote
 *
 * Proxies Jupiter v6 quote requests
 * Query params: inputMint, outputMint, amount, slippageBps, swapMode
 */
app.get('/quote', async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps, swapMode } = req.query;

    // Validation
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({
        error: 'Missing required parameters: inputMint, outputMint, amount'
      });
    }

    // Build Jupiter URL
    const jupiterParams = new URLSearchParams({
      inputMint: inputMint as string,
      outputMint: outputMint as string,
      amount: amount as string,
      slippageBps: (slippageBps as string) || '50',
      swapMode: (swapMode as string) || 'ExactIn',
    });

    const fullUrl = `${JUPITER_API}/quote?${jupiterParams.toString()}`;
    console.log('[Jupiter Proxy] Quote request:', fullUrl);

    // Prepare headers
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (process.env.JUPITER_API_KEY) {
      headers['x-api-key'] = process.env.JUPITER_API_KEY;
    }

    const response = await fetch(fullUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    const text = await response.text();

    if (!response.ok) {
      console.error('[Jupiter Proxy] Quote error:', response.status, text.substring(0, 500));
      return res.status(response.status).json({
        error: 'Jupiter quote failed',
        details: text,
        status: response.status
      });
    }

    // Parse and return
    try {
      const json = (await response.json()) as any;
      console.log('[Jupiter Proxy] Quote success:', {
        hasInAmount: !!json.inAmount,
        hasOutAmount: !!json.outAmount,
        hasRoutePlan: !!json.routePlan
      });
      return res.json(json);
    } catch (e) {
      console.error('[Jupiter Proxy] Invalid JSON:', text.substring(0, 500));
      return res.status(500).json({
        error: 'Invalid JSON response from Jupiter'
      });
    }

  } catch (error: any) {
    console.error('[Jupiter Proxy] Quote fatal error:', error);
    return res.status(500).json({
      error: 'Internal proxy error',
      message: error.message
    });
  }
});

/**
 * POST /swap
 *
 * Proxies Jupiter v6 swap transaction requests
 * Body: { quoteResponse, userPublicKey, wrapAndUnwrapSol?, feeAccount? }
 */
app.post('/swap', async (req, res) => {
  try {
    const { quoteResponse, userPublicKey, wrapAndUnwrapSol, feeAccount, prioritizationFeeLamports } = req.body;

    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({
        error: 'Missing required fields: quoteResponse, userPublicKey'
      });
    }

    const swapUrl = `${JUPITER_API}/swap`;
    console.log('[Jupiter Proxy] Swap request for user:', userPublicKey);

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (process.env.JUPITER_API_KEY) {
      headers['x-api-key'] = process.env.JUPITER_API_KEY;
    }

    const response = await fetch(swapUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: wrapAndUnwrapSol ?? true,
        // Enforce fee account from environment (security hardening)
        feeAccount: process.env.ZENITH_SOL_FEE_RECIPIENT,
        prioritizationFeeLamports,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const text = await response.text();

    if (!response.ok) {
      console.error('[Jupiter Proxy] Swap error:', response.status, text.substring(0, 500));
      return res.status(response.status).json({
        error: 'Jupiter swap failed',
        details: text,
        status: response.status
      });
    }

    try {
      const json = (await response.json()) as any;
      console.log('[Jupiter Proxy] Swap success:', {
        hasSwapTransaction: !!json.swapTransaction
      });
      return res.json(json);
    } catch (e) {
      console.error('[Jupiter Proxy] Invalid JSON:', text.substring(0, 500));
      return res.status(500).json({
        error: 'Invalid JSON response from Jupiter'
      });
    }

  } catch (error: any) {
    console.error('[Jupiter Proxy] Swap fatal error:', error);
    return res.status(500).json({
      error: 'Internal proxy error',
      message: error.message
    });
  }
});

/**
 * GET /token-list
 *
 * Proxies Jupiter's Strict Token List
 * URL: https://token.jup.ag/strict
 */
app.get('/token-list', async (req, res) => {
  try {
    console.log('[Jupiter Proxy] Fetching token list...');
    const response = await fetch('https://token.jup.ag/strict', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error('[Jupiter Proxy] Token list failed:', response.status);
      return res.status(response.status).json({ error: 'Failed to fetch token list' });
    }

    const data = await response.json();
    console.log('[Jupiter Proxy] Token list fetched:', data.length, 'tokens');

    // Cache control - 1 hour
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json(data);

  } catch (error: any) {
    console.error('[Jupiter Proxy] Token list error:', error);
    return res.status(500).json({ error: 'Internal proxy error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Jupiter Proxy listening on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Jupiter API: ${JUPITER_API}`);
});
