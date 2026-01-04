import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

// Jupiter API base URL
const JUPITER_API = 'https://quote-api.jup.ag/v6';

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

    const response = await fetch(fullUrl, {
      headers: {
        'Accept': 'application/json',
      },
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
      const json = JSON.parse(text);
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

    const response = await fetch(swapUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: wrapAndUnwrapSol ?? true,
        feeAccount,
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
      const json = JSON.parse(text);
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Jupiter Proxy listening on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Jupiter API: ${JUPITER_API}`);
});
