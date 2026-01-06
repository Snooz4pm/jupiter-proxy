/**
 * OpenBook Executor  
 * Decentralized order book (formerly Serum)
 */

import { SwapExecutor, SwapParams, Quote, SwapResult, SOL_MINT, USDC_MINT, USDT_MINT } from './types';

// OpenBook v2 markets
const OPENBOOK_MARKETS: Record<string, { base: string; quote: string; address: string }> = {
  'SOL/USDC': {
    base: SOL_MINT,
    quote: USDC_MINT,
    address: 'CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3' // OpenBook v2
  }
};

export class OpenBookExecutor implements SwapExecutor {
  name = 'openbook';

  canHandle(params: SwapParams): boolean {
    // OpenBook only handles specific markets
    const market = this.findMarket(params.inputMint, params.outputMint);
    return market !== null;
  }

  private findMarket(inputMint: string, outputMint: string) {
    for (const [name, market] of Object.entries(OPENBOOK_MARKETS)) {
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
        console.log('[OpenBook] No market for this pair');
        return null;
      }

      console.log(`[OpenBook] Getting quote for ${market.name}`);

      // Note: OpenBook doesn't have a simple REST API like others
      // In production, you'd use @openbook-dex/openbook-v2 SDK
      // For now, we'll skip if Jupiter already failed (OpenBook is in Jupiter's routes)
      
      // This is a placeholder - real implementation needs on-chain orderbook reads
      console.log('[OpenBook] Skipping (use Jupiter for OpenBook routes)');
      return null;
    } catch (err) {
      console.error('[OpenBook] Quote error:', err);
      return null;
    }
  }

  async swap(quote: Quote, userPublicKey: string): Promise<SwapResult | null> {
    // OpenBook swaps go through Jupiter
    console.log('[OpenBook] Swap should go through Jupiter');
    return null;
  }
}
