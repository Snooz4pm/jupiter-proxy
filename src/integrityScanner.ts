/**
 * Argus Integrity Engine - Phase 4 Core
 * Location: jupiter-proxy/src/integrityScanner.ts
 * 
 * Audits token safety and identifies structural traps.
 */

import { Connection, PublicKey } from '@solana/web3.js';

export interface IntegrityResult {
    contractRisk: 'LOW' | 'MEDIUM' | 'HIGH';
    holderRisk: 'LOW' | 'MEDIUM' | 'HIGH';
    flags: string[];
    score: number; // 0-100 (100 = SAFEST)
}

export class IntegrityScanner {
    private connection: Connection;

    constructor() {
        const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcUrl, 'confirmed');
    }

    /**
     * Perform deep-tissue scan of a token mint
     */
    public async scan(mintAddress: string): Promise<IntegrityResult> {
        const flags: string[] = [];
        let contractRisk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
        let holderRisk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
        let score = 100;

        try {
            const mintPubkey = new PublicKey(mintAddress);

            // 1. Fetch Mint Account Info (Mint & Freeze Authority)
            // Using Helius/DAS if possible, falling back to basic RPC info
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
            const data = (mintInfo.value?.data as any)?.parsed?.info;

            if (data) {
                // MINT AUTHORITY CHECK
                if (data.mintAuthority) {
                    flags.push('🚩 Mint Authority Active');
                    contractRisk = 'HIGH';
                    score -= 40;
                }

                // FREEZE AUTHORITY CHECK
                if (data.freezeAuthority) {
                    flags.push('🚩 Freeze Authority Active');
                    if (contractRisk !== 'HIGH') contractRisk = 'MEDIUM';
                    score -= 30;
                }
            }

            // 2. Holder Concentration Analysis
            // Pull largest accounts
            const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);
            const holders = largestAccounts.value || [];

            if (holders.length > 0) {
                const totalSupply = data?.supply ? parseFloat(data.supply) : 0;
                // We use first holder as 'Top Holder'
                const top1Amount = parseFloat(holders[0].amount);
                const top1Pct = totalSupply > 0 ? (top1Amount / totalSupply) * 100 : 0;

                if (top1Pct > 20) {
                    flags.push(`⚠️ Top Holder owns ${top1Pct.toFixed(1)}%`);
                    holderRisk = 'HIGH';
                    score -= 20;
                } else if (top1Pct > 10) {
                    flags.push(`⚠️ Top Holder owns ${top1Pct.toFixed(1)}%`);
                    holderRisk = 'MEDIUM';
                    score -= 10;
                }

                // Cumulative top 10 check
                const top10Sum = holders.slice(0, 10).reduce((sum, h) => sum + parseFloat(h.amount), 0);
                const top10Pct = totalSupply > 0 ? (top10Sum / totalSupply) * 100 : 0;

                if (top10Pct > 50) {
                    flags.push(`⚠️ Top 10 own ${top10Pct.toFixed(1)}% (Concentrated)`);
                    if (holderRisk !== 'HIGH') holderRisk = 'MEDIUM';
                    score -= 10;
                }
            }

        } catch (err) {
            console.error(`[Integrity] Scan failed for ${mintAddress}:`, err);
            // Non-blocking fallback
        }

        // Final normalization
        if (score < 40) contractRisk = 'HIGH';
        else if (score < 70 && contractRisk === 'LOW') contractRisk = 'MEDIUM';

        return {
            contractRisk,
            holderRisk,
            flags,
            score: Math.max(0, score)
        };
    }
}
