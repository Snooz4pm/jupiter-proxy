/**
 * Raydium Fallback (Single-Hop Only)
 * 
 * When Jupiter returns NO_ROUTE:
 * - Check if direct Raydium pool exists
 * - Liquidity >= $30k
 * - Single hop only (no routing graph)
 */

const RAYDIUM_POOLS_URL = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

interface RaydiumPool {
  id: string;
  baseMint: string;
  quoteMint: string;
  baseReserve: string;
  quoteReserve: string;
  lpMint: string;
  version: number;
  programId: string;
  authority: string;
  openOrders: string;
  targetOrders: string;
  baseVault: string;
  quoteVault: string;
  withdrawQueue: string;
  lpVault: string;
  marketVersion: number;
  marketProgramId: string;
  marketId: string;
  marketAuthority: string;
  marketBaseVault: string;
  marketQuoteVault: string;
  marketBids: string;
  marketAsks: string;
  marketEventQueue: string;
  lookupTableAccount?: string;
}

interface PoolCache {
  official: RaydiumPool[];
  unOfficial: RaydiumPool[];
  timestamp: number;
}

let poolCache: PoolCache | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch and cache Raydium pools
 */
export async function getRaydiumPools(): Promise<PoolCache | null> {
  // Check cache
  if (poolCache && Date.now() - poolCache.timestamp < CACHE_TTL) {
    return poolCache;
  }

  try {
    const response = await fetch(RAYDIUM_POOLS_URL);
    if (!response.ok) {
      console.error('[Raydium] Failed to fetch pools:', response.status);
      return null;
    }

    const data = await response.json();
    poolCache = {
      official: data.official || [],
      unOfficial: data.unOfficial || [],
      timestamp: Date.now(),
    };

    console.log(`[Raydium] Cached ${poolCache.official.length} official pools`);
    return poolCache;
  } catch (error) {
    console.error('[Raydium] Pool fetch error:', error);
    return null;
  }
}

/**
 * Find direct pool for token pair
 */
export async function getRaydiumPool(
  inputMint: string,
  outputMint: string
): Promise<RaydiumPool | null> {
  const pools = await getRaydiumPools();
  if (!pools) return null;

  // Check official pools first
  const pool = pools.official.find(
    (p) =>
      (p.baseMint === inputMint && p.quoteMint === outputMint) ||
      (p.baseMint === outputMint && p.quoteMint === inputMint)
  );

  return pool || null;
}

/**
 * Calculate quote using constant product formula
 * AMM: x * y = k
 */
export function raydiumQuote(
  pool: RaydiumPool,
  inputMint: string,
  amountIn: bigint
): { amountOut: bigint; priceImpact: number } {
  const isBaseToQuote = pool.baseMint === inputMint;
  
  const baseReserve = BigInt(pool.baseReserve);
  const quoteReserve = BigInt(pool.quoteReserve);

  const [reserveIn, reserveOut] = isBaseToQuote
    ? [baseReserve, quoteReserve]
    : [quoteReserve, baseReserve];

  // Constant product formula with 0.25% fee
  const amountInWithFee = amountIn * BigInt(9975);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BigInt(10000) + amountInWithFee;
  const amountOut = numerator / denominator;

  // Calculate price impact
  const spotPrice = Number(reserveOut) / Number(reserveIn);
  const executionPrice = Number(amountOut) / Number(amountIn);
  const priceImpact = Math.abs((spotPrice - executionPrice) / spotPrice);

  return { amountOut, priceImpact };
}

/**
 * Check if pool has sufficient liquidity
 */
export function hasMinimumLiquidity(
  pool: RaydiumPool,
  minLiquidityUsd: number = 30_000
): boolean {
  // This would need price data to calculate properly
  // For now, we check reserves aren't dust
  const baseReserve = BigInt(pool.baseReserve);
  const quoteReserve = BigInt(pool.quoteReserve);

  return baseReserve > BigInt(1_000_000) && quoteReserve > BigInt(1_000_000);
}
