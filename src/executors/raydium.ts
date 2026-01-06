/**
 * Raydium Executor
 * QUOTE-ONLY - Raydium cannot build aggregator transactions
 * Transaction building is handled by Jupiter
 */

import { SwapExecutor, SwapParams, Quote, SwapResult } from './types';

const RAYDIUM_API = 'https://transaction-v1.raydium.io';

interface RaydiumQuoteData {
  swapType: string;
  inputMint: string;
  inputAmount: string;
  outputMint: string;
  outputAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: any[];
}

export class RaydiumExecutor implements SwapExecutor {
  name = 'raydium';

  canHandle(params: SwapParams): boolean {
    return true;
  }

  async quote(params: SwapParams): Promise<Quote | null> {
    try {
      const url = `${RAYDIUM_API}/compute/swap-base-in?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}&txVersion=V0`;

      console.log(`[Raydium] Getting quote: ${params.inputMint.slice(0,8)}... -> ${params.outputMint.slice(0,8)}...`);

      const response = await fetch(url);

      if (!response.ok) {
        console.log('[Raydium] Quote failed:', response.status);
        return null;
      }

      const data = await response.json();

      if (!data.success || !data.data) {
        console.log('[Raydium] No route found');
        return null;
      }

      const quoteData: RaydiumQuoteData = data.data;

      if (!quoteData.outputAmount || quoteData.outputAmount === '0') {
        console.log('[Raydium] Zero output');
        return null;
      }

      // Single-hop check - Raydium quotes are most reliable for direct pools
      if (!quoteData.routePlan || quoteData.routePlan.length !== 1) {
        console.log('[Raydium] ❌ Multi-hop route, skipping');
        return null;
      }

      console.log('[Raydium] ✓ Quote success, output:', quoteData.outputAmount);

      return {
        source: 'raydium',
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: quoteData.inputAmount,
        outAmount: quoteData.outputAmount,
        priceImpactPct: String(quoteData.priceImpactPct || 0),
        slippageBps: params.slippageBps,
        routePlan: quoteData.routePlan,
        _raw: data
      };
    } catch (err) {
      console.error('[Raydium] Quote error:', err);
      return null;
    }
  }

  // Raydium does NOT build transactions - Jupiter handles all execution
  async swap(quote: Quote, userPublicKey: string): Promise<SwapResult | null> {
    console.log('[Raydium] ⚠️ Raydium is quote-only, Jupiter handles tx building');
    return null;
  }
}
