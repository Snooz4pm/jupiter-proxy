/**
 * Smart Router
 * Orchestrates multiple swap executors with intelligent routing
 * 
 * Route Priority:
 * 1. Jupiter (multi-hop, best price)
 * 2. Raydium direct (single-hop)
 * 3. Orca direct (single-hop)
 * 4. Phoenix orderbook
 * 5. OpenBook orderbook
 */

import { SwapExecutor, SwapParams, Quote, SwapResult, USDC_MINT, USDT_MINT, SOL_MINT } from './types';
import { JupiterExecutor } from './jupiter';
import { RaydiumExecutor } from './raydium';
import { OrcaExecutor } from './orca';
import { PhoenixExecutor } from './phoenix';
import { OpenBookExecutor } from './openbook';

// Initialize all executors
const executors: SwapExecutor[] = [
  new JupiterExecutor(),
  new RaydiumExecutor(),
  new OrcaExecutor(),
  new PhoenixExecutor(),
  new OpenBookExecutor(),
];

// USDC value thresholds (in base units, 6 decimals)
const SMALL_AMOUNT_THRESHOLD = 500_000; // 0.5 USDC
const MIN_LIQUIDITY_THRESHOLD = 50_000_000_000; // $50,000 worth

interface RouteConfig {
  skipJupiter: boolean;
  preferSingleHop: boolean;
  executorOrder: string[];
}

/**
 * Determine routing strategy based on swap parameters
 */
function getRouteConfig(params: SwapParams, tokenAge?: number, liquidity?: number): RouteConfig {
  const amount = Number(params.amount);
  const isStablePair = 
    (params.inputMint === USDC_MINT || params.inputMint === USDT_MINT) &&
    (params.outputMint === USDC_MINT || params.outputMint === USDT_MINT);

  // Default order
  let executorOrder = ['jupiter', 'raydium', 'orca', 'phoenix', 'openbook'];
  let skipJupiter = false;
  let preferSingleHop = false;

  // Small amounts: skip Jupiter, try direct DEXs first
  if (amount < SMALL_AMOUNT_THRESHOLD) {
    console.log('[Router] Small amount detected, prioritizing direct DEXs');
    skipJupiter = true;
    executorOrder = ['raydium', 'orca', 'phoenix', 'jupiter', 'openbook'];
  }

  // Fresh tokens (< 48h): skip Jupiter, try Raydium first
  if (tokenAge !== undefined && tokenAge < 48 * 60 * 60 * 1000) {
    console.log('[Router] Fresh token detected, prioritizing Raydium');
    skipJupiter = true;
    executorOrder = ['raydium', 'orca', 'jupiter', 'phoenix', 'openbook'];
  }

  // Low liquidity: force single-hop
  if (liquidity !== undefined && liquidity < MIN_LIQUIDITY_THRESHOLD) {
    console.log('[Router] Low liquidity, forcing single-hop');
    preferSingleHop = true;
    executorOrder = ['raydium', 'orca', 'phoenix', 'jupiter', 'openbook'];
  }

  // Stable pairs: Phoenix often has best rates
  if (isStablePair) {
    console.log('[Router] Stable pair, prioritizing orderbooks');
    executorOrder = ['phoenix', 'jupiter', 'raydium', 'orca', 'openbook'];
  }

  return { skipJupiter, preferSingleHop, executorOrder };
}

/**
 * Get the best quote across all executors
 */
export async function getBestQuote(
  params: SwapParams,
  tokenAge?: number,
  liquidity?: number
): Promise<Quote | null> {
  const config = getRouteConfig(params, tokenAge, liquidity);
  
  console.log(`[Router] Getting quote for ${params.inputMint} -> ${params.outputMint}`);
  console.log(`[Router] Executor order: ${config.executorOrder.join(' -> ')}`);

  // Try executors in priority order
  for (const executorName of config.executorOrder) {
    const executor = executors.find(e => e.name === executorName);
    if (!executor) continue;

    // Skip Jupiter if configured
    if (config.skipJupiter && executorName === 'jupiter') {
      console.log('[Router] Skipping Jupiter (config)');
      continue;
    }

    // Check if executor can handle this swap
    if (!executor.canHandle(params)) {
      console.log(`[Router] ${executorName} cannot handle this pair`);
      continue;
    }

    try {
      const quote = await executor.quote(params);
      
      if (quote && quote.outAmount && quote.outAmount !== '0') {
        console.log(`[Router] ✓ ${executorName} returned quote: ${quote.outAmount}`);
        return quote;
      }
      
      console.log(`[Router] ✗ ${executorName} returned no route`);
    } catch (err) {
      console.error(`[Router] ${executorName} error:`, err);
    }
  }

  console.log('[Router] No route found across all executors');
  return null;
}

/**
 * Execute a swap using the quote's source executor
 */
export async function executeSwap(
  quote: Quote,
  userPublicKey: string
): Promise<SwapResult | null> {
  const executor = executors.find(e => e.name === quote.source);
  
  if (!executor) {
    console.error(`[Router] Unknown executor: ${quote.source}`);
    return null;
  }

  console.log(`[Router] Executing swap via ${quote.source}`);
  return executor.swap(quote, userPublicKey);
}

/**
 * Get all available quotes (for comparison UI)
 */
export async function getAllQuotes(params: SwapParams): Promise<Quote[]> {
  const quotes: Quote[] = [];

  const quotePromises = executors
    .filter(e => e.canHandle(params))
    .map(async (executor) => {
      try {
        const quote = await executor.quote(params);
        if (quote && quote.outAmount && quote.outAmount !== '0') {
          return quote;
        }
      } catch (err) {
        console.error(`[Router] ${executor.name} error:`, err);
      }
      return null;
    });

  const results = await Promise.allSettled(quotePromises);
  
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      quotes.push(result.value);
    }
  }

  // Sort by output amount (best first)
  quotes.sort((a, b) => Number(b.outAmount) - Number(a.outAmount));

  return quotes;
}

export { executors };
