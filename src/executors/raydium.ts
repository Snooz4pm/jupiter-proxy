/**
 * Raydium Executor
 * Direct AMM swaps, good for fresh tokens
 */

import { SwapExecutor, SwapParams, Quote, SwapResult, SOL_MINT } from './types';

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
    // Raydium handles most direct swaps
    return true;
  }

  async quote(params: SwapParams): Promise<Quote | null> {
    try {
      const url = `${RAYDIUM_API}/compute/swap-base-in?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}&txVersion=V0`;

      console.log(`[Raydium] Getting quote: ${params.inputMint} -> ${params.outputMint}`);

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

      console.log('[Raydium] Quote success, output:', quoteData.outputAmount);

      return {
        source: 'raydium',
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: quoteData.inputAmount,
        outAmount: quoteData.outputAmount,
        priceImpactPct: String(quoteData.priceImpactPct || 0),
        slippageBps: params.slippageBps,
        routePlan: quoteData.routePlan || [{ source: 'raydium' }],
        _raw: data
      };
    } catch (err) {
      console.error('[Raydium] Quote error:', err);
      return null;
    }
  }

  async swap(quote: Quote, userPublicKey: string): Promise<SwapResult | null> {
    try {
      console.log('[Raydium] Building swap transaction for wallet:', userPublicKey);

      const isInputSol = quote.inputMint === SOL_MINT;
      const isOutputSol = quote.outputMint === SOL_MINT;

      // The _raw is the full Raydium response: {id, success, version, data: {...}}
      // We need the 'data' field which contains the FULL swap response
      const rawResponse = quote._raw;
      
      if (!rawResponse) {
        console.error('[Raydium] Missing _raw data');
        return null;
      }

      // Extract the FULL swapResponse data
      const swapResponseData = rawResponse.data || rawResponse;
      
      // Validate we have the FULL response (not just mints)
      if (!swapResponseData.routePlan || !swapResponseData.inputAmount || !swapResponseData.outputAmount) {
        console.error('[Raydium] Incomplete swapResponse! Missing required fields.');
        console.error('[Raydium] Has routePlan:', !!swapResponseData.routePlan);
        console.error('[Raydium] Has inputAmount:', !!swapResponseData.inputAmount);
        console.error('[Raydium] Has outputAmount:', !!swapResponseData.outputAmount);
        console.error('[Raydium] Keys present:', Object.keys(swapResponseData));
        return null;
      }

      // Guard: Raydium only supports single-hop swaps
      const isSingleHop = swapResponseData.routePlan?.length === 1;
      if (!isSingleHop) {
        console.log('[Raydium] Multi-hop detected, Raydium only supports single-hop');
        return null;
      }

      console.log('[Raydium] Full swapResponse validated:');
      console.log('[Raydium]   inputAmount:', swapResponseData.inputAmount);
      console.log('[Raydium]   outputAmount:', swapResponseData.outputAmount);
      console.log('[Raydium]   routePlan length:', swapResponseData.routePlan?.length);

      // Get priority fee
      let priorityFee = 100000;
      try {
        const feeRes = await fetch('https://api-v3.raydium.io/main/auto-fee');
        if (feeRes.ok) {
          const feeData = await feeRes.json();
          priorityFee = Number(feeData?.data?.default?.h || 100000);
        }
      } catch {
        // Use default
      }

      // Build the request with the FULL swapResponse
      const requestBody = {
        swapResponse: swapResponseData, // 🔥 FULL OBJECT - not just mints!
        wallet: userPublicKey,
        txVersion: 'V0',
        computeUnitPriceMicroLamports: String(priorityFee),
        wrapSol: isInputSol,
        unwrapSol: isOutputSol,
      };

      console.log('[Raydium] Sending to transaction API...');

      const response = await fetch(`${RAYDIUM_API}/transaction/swap-base-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log('[Raydium] HTTP error:', response.status, errText);
        return null;
      }

      const data = await response.json();

      if (!data.success || !data.data?.[0]?.transaction) {
        console.log('[Raydium] API returned error:', JSON.stringify(data));
        return null;
      }

      console.log('[Raydium] ✓ Transaction built successfully');
      return {
        swapTransaction: data.data[0].transaction,
        source: 'raydium'
      };
    } catch (err) {
      console.error('[Raydium] Swap error:', err);
      return null;
    }
  }
}
