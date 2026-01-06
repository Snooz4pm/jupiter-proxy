/**
 * Orca Executor
 * Whirlpool concentrated liquidity, good for major pairs
 */

import { SwapExecutor, SwapParams, Quote, SwapResult } from './types';

const ORCA_API = 'https://api.orca.so';

export class OrcaExecutor implements SwapExecutor {
  name = 'orca';

  canHandle(params: SwapParams): boolean {
    // Orca handles most swaps
    return true;
  }

  async quote(params: SwapParams): Promise<Quote | null> {
    try {
      // Orca Whirlpool quote endpoint
      const url = `${ORCA_API}/v1/whirlpool/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}&mode=ExactIn`;

      console.log(`[Orca] Getting quote: ${params.inputMint} -> ${params.outputMint}`);

      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        console.log('[Orca] Quote failed:', response.status);
        return null;
      }

      const data = await response.json();

      if (!data.estimatedAmountOut || data.estimatedAmountOut === '0') {
        console.log('[Orca] No route found');
        return null;
      }

      console.log('[Orca] Quote success, output:', data.estimatedAmountOut);

      return {
        source: 'orca',
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.amount,
        outAmount: data.estimatedAmountOut,
        priceImpactPct: String(data.priceImpact || 0),
        slippageBps: params.slippageBps,
        routePlan: [{ source: 'orca-whirlpool', pool: data.whirlpool }],
        _raw: data
      };
    } catch (err) {
      console.error('[Orca] Quote error:', err);
      return null;
    }
  }

  async swap(quote: Quote, userPublicKey: string): Promise<SwapResult | null> {
    try {
      console.log('[Orca] Building swap transaction');

      const response = await fetch(`${ORCA_API}/v1/whirlpool/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quote: quote._raw,
          userPublicKey,
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log('[Orca] Swap failed:', response.status, errText);
        return null;
      }

      const data = await response.json();

      if (!data.transaction) {
        console.log('[Orca] No transaction returned');
        return null;
      }

      console.log('[Orca] Transaction built successfully');
      return {
        swapTransaction: data.transaction,
        source: 'orca'
      };
    } catch (err) {
      console.error('[Orca] Swap error:', err);
      return null;
    }
  }
}
