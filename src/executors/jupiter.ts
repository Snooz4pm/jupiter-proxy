/**
 * Jupiter Executor
 * Multi-hop routing, best prices for established tokens
 */

import { SwapExecutor, SwapParams, Quote, SwapResult } from './types';

// Jupiter public API - the v6 endpoint is the public one
const JUPITER_API = 'https://quote-api.jup.ag/v6';

async function fetchJupiterWithRetry(url: string, options?: RequestInit): Promise<Response | null> {
  const maxRetries = 2;
  
  for (let i = 0; i <= maxRetries; i++) {
    try {
      console.log(`[Jupiter] Fetching: ${url}`);
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(15000) // 15s timeout
      });
      
      if (response.ok) {
        console.log(`[Jupiter] Success`);
        return response;
      }
      
      if (response.status === 429 && i < maxRetries) {
        console.log(`[Jupiter] Rate limited, retry ${i + 1}...`);
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      
      console.log(`[Jupiter] Failed with status ${response.status}`);
      return response;
    } catch (err: any) {
      console.log(`[Jupiter] Fetch error:`, err.code || err.message);
      if (i < maxRetries) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }
  }
  return null;
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
    try {
      const url = `${JUPITER_API}/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}`;

      console.log(`[Jupiter] Getting quote: ${params.inputMint.slice(0,8)}... -> ${params.outputMint.slice(0,8)}...`);

      const response = await fetchJupiterWithRetry(url, {
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

      console.log('[Jupiter] Quote success, output:', data.outAmount);

      return {
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

      const response = await fetchJupiterWithRetry(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote._raw,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto'
        })
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

      console.log('[Jupiter] Transaction built successfully');
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
