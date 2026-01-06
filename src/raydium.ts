/**
 * Raydium Trade API Fallback
 * 
 * When Jupiter returns NO_ROUTE:
 * - Use Raydium's Trade API (same pattern as Jupiter)
 * - 2 requests: quote + serialize
 */

const RAYDIUM_API = 'https://transaction-v1.raydium.io';

interface RaydiumQuoteResponse {
  id: string;
  success: boolean;
  version: string;
  data: {
    swapType: string;
    inputMint: string;
    inputAmount: string;
    outputMint: string;
    outputAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    priceImpactPct: number;
    routePlan: any[];
  };
}

interface RaydiumSwapResponse {
  id: string;
  version: string;
  success: boolean;
  data: { transaction: string }[];
}

/**
 * Get quote from Raydium Trade API
 */
export async function getRaydiumQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = 50
): Promise<RaydiumQuoteResponse | null> {
  try {
    const url = `${RAYDIUM_API}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&txVersion=V0`;
    
    console.log('[Raydium] Getting quote:', url);
    
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
    
    console.log('[Raydium] Quote success, output:', data.data.outputAmount);
    return data;
  } catch (err) {
    console.error('[Raydium] Quote error:', err);
    return null;
  }
}

/**
 * Get serialized transaction from Raydium
 */
export async function getRaydiumSwapTransaction(
  swapResponse: RaydiumQuoteResponse,
  walletPubkey: string,
  inputMint: string,
  outputMint: string
): Promise<string | null> {
  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isInputSol = inputMint === SOL_MINT;
    const isOutputSol = outputMint === SOL_MINT;

    // Get priority fee
    let priorityFee = '100000'; // default 0.0001 SOL
    try {
      const feeRes = await fetch(`${RAYDIUM_API.replace('transaction-v1', 'api-v3')}/main/auto-fee`);
      if (feeRes.ok) {
        const feeData = await feeRes.json();
        priorityFee = String(feeData?.data?.default?.h || 100000);
      }
    } catch {
      console.log('[Raydium] Using default priority fee');
    }

    const response = await fetch(`${RAYDIUM_API}/transaction/swap-base-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        computeUnitPriceMicroLamports: priorityFee,
        swapResponse: swapResponse.data,
        txVersion: 'V0',
        wallet: walletPubkey,
        wrapSol: isInputSol,
        unwrapSol: isOutputSol,
      })
    });

    if (!response.ok) {
      console.log('[Raydium] Swap tx build failed:', response.status);
      return null;
    }

    const data: RaydiumSwapResponse = await response.json();
    
    if (!data.success || !data.data?.[0]?.transaction) {
      console.log('[Raydium] No transaction returned');
      return null;
    }

    console.log('[Raydium] Transaction built successfully');
    return data.data[0].transaction;
  } catch (err) {
    console.error('[Raydium] Swap tx error:', err);
    return null;
  }
}

// Legacy exports for backward compatibility (can be removed later)
export async function getRaydiumPool(inputMint: string, outputMint: string) {
  return null;
}

export function raydiumQuote(pool: any, inputMint: string, amountIn: bigint) {
  return { amountOut: BigInt(0), priceImpact: 100 };
}

export function hasMinimumLiquidity(pool: any) {
  return false;
}
