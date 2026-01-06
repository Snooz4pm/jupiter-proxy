/**
 * Swap Executor Interface
 * Each DEX implements this interface
 */

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amount: string;        // Base units (lamports)
  slippageBps: number;
  userPublicKey?: string;
}

export interface Quote {
  source: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: any[];
  // Raw response for swap execution
  _raw?: any;
}

export interface SwapResult {
  swapTransaction: string;  // Base64 encoded
  source: string;
}

export interface SwapExecutor {
  name: string;
  
  /**
   * Check if this executor can handle the swap
   * Based on amount, token type, etc.
   */
  canHandle(params: SwapParams): boolean;
  
  /**
   * Get a quote for the swap
   * Returns null if no route available
   */
  quote(params: SwapParams): Promise<Quote | null>;
  
  /**
   * Build the swap transaction
   */
  swap(quote: Quote, userPublicKey: string): Promise<SwapResult | null>;
}

// Common token addresses
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Stablecoins for routing
export const STABLECOINS = [USDC_MINT, USDT_MINT];
