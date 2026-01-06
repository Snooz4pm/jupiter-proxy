/**
 * Jupiter Executor
 * Multi-hop routing, best prices for established tokens
 */

import { SwapExecutor, SwapParams, Quote, SwapResult } from './types';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

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
      const url = new URL(`${JUPITER_API}/quote`);
      url.searchParams.set('inputMint', params.inputMint);
      url.searchParams.set('outputMint', params.outputMint);
      url.searchParams.set('amount', params.amount);
      url.searchParams.set('slippageBps', String(params.slippageBps));

      console.log(`[Jupiter] Getting quote: ${params.inputMint} -> ${params.outputMint}`);

      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/json' }
      });

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

      const response = await fetch(`${JUPITER_API}/swap`, {
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
