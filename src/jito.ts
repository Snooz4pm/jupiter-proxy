/**
 * Jito Bundle Submission
 * 
 * MEV Protection — Real way, not marketing.
 * 
 * When to use:
 * - Large trades (>$1.5k)
 * - High price impact (>0.5%)
 * - Volatile/meme tokens
 * 
 * Architecture:
 * User → Phantom signs → Frontend sends signed tx → Backend submits to Jito → Atomic inclusion
 */

import { Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

// Jito Block Engine endpoints
const JITO_BLOCK_ENGINES = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// Use primary endpoint
const JITO_RPC = JITO_BLOCK_ENGINES[0];

interface JitoBundleResult {
  success: boolean;
  bundleId?: string;
  error?: string;
}

/**
 * Send a signed transaction via Jito bundle
 * This provides MEV protection through atomic inclusion
 */
export async function sendJitoBundle(
  serializedTx: string | Buffer
): Promise<JitoBundleResult> {
  try {
    // Convert to base58 if needed
    const txBase64 = typeof serializedTx === 'string' 
      ? serializedTx 
      : serializedTx.toString('base64');

    // Jito expects base58 encoded transactions
    const txBuffer = Buffer.from(txBase64, 'base64');
    const txBase58 = require('bs58').encode(txBuffer);

    const response = await fetch(JITO_RPC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[txBase58]]
      })
    });

    const result = await response.json();

    if (result.error) {
      console.error('[JITO] Bundle submission error:', result.error);
      return {
        success: false,
        error: result.error.message || 'Bundle submission failed'
      };
    }

    console.log('[JITO] Bundle submitted:', result.result);
    return {
      success: true,
      bundleId: result.result
    };

  } catch (error: any) {
    console.error('[JITO] Error:', error);
    return {
      success: false,
      error: error?.message || 'Jito submission failed'
    };
  }
}

/**
 * Get bundle status from Jito
 */
export async function getJitoBundleStatus(bundleId: string): Promise<string> {
  try {
    const response = await fetch(JITO_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]]
      })
    });

    const result = await response.json();
    return result?.result?.value?.[0]?.confirmation_status || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Decision logic: Should we use Jito for this trade?
 */
export function shouldUseJito(params: {
  tradeUsd: number;
  priceImpactPct: number;
  isVolatileToken?: boolean;
  turboMode?: boolean;
}): boolean {
  const { tradeUsd, priceImpactPct, isVolatileToken, turboMode } = params;

  // Always use Jito in turbo mode
  if (turboMode) return true;

  // Large trades (>$1.5k)
  if (tradeUsd > 1500) return true;

  // High price impact (>0.5%)
  if (priceImpactPct > 0.5) return true;

  // Volatile/meme tokens with decent size
  if (isVolatileToken && tradeUsd > 500) return true;

  return false;
}
