/**
 * Phoenix Executor
 * Order book DEX, great for major pairs with tight spreads
 */

import { SwapExecutor, SwapParams, Quote, SwapResult, SOL_MINT, USDC_MINT, USDT_MINT } from './types';

// Phoenix markets (address -> base/quote)
const PHOENIX_MARKETS: Record<string, { base: string; quote: string; address: string }> = {
  'SOL/USDC': {
    base: SOL_MINT,
    quote: USDC_MINT,
    address: '4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg'
  },
  'SOL/USDT': {
    base: SOL_MINT,
    quote: USDT_MINT,
    address: '4xPpRp3u7vP8BWSxfvPFQW7zNcZ9NVLwTDMjFkJvoQwF'
  }
};

export class PhoenixExecutor implements SwapExecutor {
  name = 'phoenix';

  canHandle(params: SwapParams): boolean {
    // Phoenix only handles specific markets
    const market = this.findMarket(params.inputMint, params.outputMint);
    return market !== null;
  }

  private findMarket(inputMint: string, outputMint: string) {
    for (const [name, market] of Object.entries(PHOENIX_MARKETS)) {
      if (
        (market.base === inputMint && market.quote === outputMint) ||
        (market.quote === inputMint && market.base === outputMint)
      ) {
        return { ...market, name, isBuy: market.quote === inputMint };
      }
    }
    return null;
  }

  async quote(params: SwapParams): Promise<Quote | null> {
    try {
      const market = this.findMarket(params.inputMint, params.outputMint);
      if (!market) {
        console.log('[Phoenix] No market for this pair');
        return null;
      }

      console.log(`[Phoenix] Getting quote for ${market.name}`);

      // Phoenix API for order book quote
      const url = `https://api.phoenix.so/v1/markets/${market.address}/quote?amount=${params.amount}&side=${market.isBuy ? 'buy' : 'sell'}`;

      const response = await fetch(url);

      if (!response.ok) {
        console.log('[Phoenix] Quote failed:', response.status);
        return null;
      }

      const data = await response.json();

      if (!data.expectedOutput || data.expectedOutput === '0') {
        console.log('[Phoenix] No liquidity');
        return null;
      }

      console.log('[Phoenix] Quote success, output:', data.expectedOutput);

      return {
        source: 'phoenix',
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.amount,
        outAmount: data.expectedOutput,
        priceImpactPct: String(data.priceImpact || 0),
        slippageBps: params.slippageBps,
        routePlan: [{ source: 'phoenix', market: market.name }],
        _raw: { ...data, market }
      };
    } catch (err) {
      console.error('[Phoenix] Quote error:', err);
      return null;
    }
  }

  async swap(quote: Quote, userPublicKey: string): Promise<SwapResult | null> {
    try {
      console.log('[Phoenix] Building swap transaction');

      const market = quote._raw?.market;
      if (!market) {
        console.log('[Phoenix] Missing market info');
        return null;
      }

      const response = await fetch(`https://api.phoenix.so/v1/markets/${market.address}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPublicKey,
          amount: quote.inAmount,
          side: market.isBuy ? 'buy' : 'sell',
          slippageBps: quote.slippageBps
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log('[Phoenix] Swap failed:', response.status, errText);
        return null;
      }

      const data = await response.json();

      if (!data.transaction) {
        console.log('[Phoenix] No transaction returned');
        return null;
      }

      console.log('[Phoenix] Transaction built successfully');
      return {
        swapTransaction: data.transaction,
        source: 'phoenix'
      };
    } catch (err) {
      console.error('[Phoenix] Swap error:', err);
      return null;
    }
  }
}
