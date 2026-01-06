/**
 * Jupiter Executor
 * Multi-hop routing, best prices for established tokens
 * With DNS hardening for Railway deployment
 */

import { SwapExecutor, SwapParams, Quote, SwapResult } from './types';

// Multiple Jupiter endpoints for DNS failover
const JUPITER_QUOTE_ENDPOINTS = [
  'https://quote-api.jup.ag/v6/quote',
  'https://public.jupiterapi.com/quote',
];

const JUPITER_SWAP_ENDPOINTS = [
  'https://quote-api.jup.ag/v6/swap',
  'https://public.jupiterapi.com/swap',
];

// Quote cache (15s TTL)
const quoteCache = new Map<string, { data: any; expires: number }>();

function getCacheKey(p: SwapParams): string {
  return `${p.inputMint}:${p.outputMint}:${p.amount}:${p.slippageBps}`;
}

/**
 * Fetch with failover across multiple endpoints
 */
async function fetchWithFailover(
  urls: string[],
  options: RequestInit = {},
  timeoutMs = 8000
): Promise<Response | null> {
  let lastError: any;

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      console.log(`[Jupiter] Trying: ${url.slice(0, 60)}...`);
      
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        console.log(`[Jupiter] ✓ Success from ${new URL(url).hostname}`);
        return res;
      }

      // Log non-OK but continue to next endpoint
      console.log(`[Jupiter] ${new URL(url).hostname} returned ${res.status}`);
      
      if (res.status === 429) {
        // Rate limited, try next
        continue;
      }
      
      // Return response for other errors (400, 404, etc.)
      return res;
    } catch (err: any) {
      lastError = err;
      const errMsg = err.code || err.name || err.message || 'unknown';
      console.log(`[Jupiter] ${new URL(url).hostname} failed: ${errMsg}`);
    }
  }

  console.error('[Jupiter] All endpoints failed');
  return null;
}

/**
 * Retry helper
 */
async function retry<T>(fn: () => Promise<T>, retries = 2, delayMs = 500): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(r => setTimeout(r, delayMs));
    return retry(fn, retries - 1, delayMs * 1.5);
  }
}

export class JupiterExecutor implements SwapExecutor {
  name = 'jupiter';

  canHandle(params: SwapParams): boolean {
    // Jupiter handles most swaps
    // Skip for very small amounts (< 0.001 SOL worth)
    const amountNum = Number(params.amount);
    if (amountNum < 1000) return false; // Dust
    return true;
  }

  async quote(params: SwapParams): Promise<Quote | null> {
    const cacheKey = getCacheKey(params);
    const now = Date.now();
    
    // Check cache first
    const cached = quoteCache.get(cacheKey);
    if (cached && cached.expires > now) {
      console.log('[Jupiter] ✓ Using cached quote');
      return cached.data;
    }

    try {
      const queryParams = new URLSearchParams({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: String(params.slippageBps),
      });

      console.log(`[Jupiter] Getting quote: ${params.inputMint.slice(0,8)}... -> ${params.outputMint.slice(0,8)}...`);

      // Build URLs for all endpoints
      const urls = JUPITER_QUOTE_ENDPOINTS.map(ep => `${ep}?${queryParams}`);
      
      const response = await fetchWithFailover(urls, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!response) {
        console.log('[Jupiter] All endpoints failed');
        return null;
      }

      if (!response.ok) {
        if (response.status === 429) {
          console.log('[Jupiter] Rate limited');
          return null;
        }
        console.log('[Jupiter] Quote failed:', response.status);
        return null;
      }

      const data = await response.json();

      // Check for valid route
      if (!data.outAmount || data.outAmount === '0') {
        console.log('[Jupiter] No route (zero output)');
        return null;
      }

      if (!data.routePlan || data.routePlan.length === 0) {
        console.log('[Jupiter] No route plan');
        return null;
      }

      console.log('[Jupiter] ✓ Quote success, output:', data.outAmount);

      const quote: Quote = {
        source: 'jupiter',
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: data.inAmount,
        outAmount: data.outAmount,
        priceImpactPct: data.priceImpactPct || '0',
        slippageBps: params.slippageBps,
        routePlan: data.routePlan,
        _raw: data
      };

      // Cache the quote (15s TTL)
      quoteCache.set(cacheKey, {
        data: quote,
        expires: now + 15_000,
      });

      return quote;
    } catch (err) {
      console.error('[Jupiter] Quote error:', err);
      return null;
    }
  }

  async swap(quote: Quote, userPublicKey: string): Promise<SwapResult | null> {
    try {
      console.log('[Jupiter] Building swap transaction');
      console.log('[Jupiter] Quote _raw exists:', !!quote._raw);
      
      if (!quote._raw) {
        console.error('[Jupiter] Missing _raw quote data - cannot build swap');
        return null;
      }

      const swapPayload = {
        quoteResponse: quote._raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      };

      const response = await fetchWithFailover(JUPITER_SWAP_ENDPOINTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(swapPayload)
      });

      if (!response) {
        console.log('[Jupiter] All swap endpoints failed');
        return null;
      }

      if (!response.ok) {
        const errText = await response.text();
        console.log('[Jupiter] Swap failed:', response.status, errText);
        return null;
      }

      const data = await response.json();

      if (!data.swapTransaction) {
        console.log('[Jupiter] No transaction returned');
        return null;
      }

      console.log('[Jupiter] ✓ Transaction built successfully');
      return {
        swapTransaction: data.swapTransaction,
        source: 'jupiter'
      };
    } catch (err) {
      console.error('[Jupiter] Swap error:', err);
      return null;
    }
  }
}
