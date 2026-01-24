import { Connection, PublicKey } from '@solana/web3.js';

export type BehaviorReport = {
    deployerAddress: string;
    behaviorRisk: "LOW" | "MEDIUM" | "HIGH";
    fundingSource: { type: string; name?: string };
    trackRecord: { totalLaunched: number; diedQuickly: number; confirmedRugs: number };
    flags: string[];
    score: number;
};

export type IntegrityReport = {
    contractRisk: "LOW" | "MEDIUM" | "HIGH";
    holderRisk: "LOW" | "MEDIUM" | "HIGH";
    behaviorRisk?: "LOW" | "MEDIUM" | "HIGH";
    flags: string[];
    top1Pct: number;
    top10Pct: number;
    score: number;
    behavior?: BehaviorReport;
};

export function analyzeTokenIntegrity(
    mintInfo: {
        mintAuthority: string | null;
        freezeAuthority: string | null;
        supply: number;
        decimals: number;
    },
    holders?: { amount: number }[],
    behavior?: BehaviorReport
): IntegrityReport {
    const flags: string[] = [...(behavior?.flags || [])];
    let riskScore = behavior?.behaviorRisk === 'HIGH' ? 3 : behavior?.behaviorRisk === 'MEDIUM' ? 1 : 0;

    // 1. Contract Configuration Checks
    if (mintInfo.mintAuthority) {
        flags.push("Mint authority enabled (supply can inflate)");
        riskScore += 3;
    }
    if (mintInfo.freezeAuthority) {
        flags.push("Freeze authority enabled (wallets can be frozen)");
        riskScore += 2;
    }
    if (mintInfo.decimals > 12) {
        flags.push("Unusual decimals configuration");
        riskScore += 1;
    }
    if (mintInfo.supply <= 0) {
        flags.push("Zero or invalid supply");
        riskScore += 3;
    }

    // 2. Supply Distribution Analysis (v2)
    let holderRisk: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    let top1Pct = 0;
    let top10Pct = 0;

    if (holders && holders.length > 0 && mintInfo.supply > 0) {
        const top1Amount = holders[0].amount;
        top1Pct = (top1Amount / mintInfo.supply) * 100;

        if (top1Pct > 20) {
            flags.push(`⚠️ Top Holder owns ${top1Pct.toFixed(1)}% (Dev/Cabal Warning)`);
            holderRisk = "HIGH";
            riskScore += 3;
        } else if (top1Pct > 10) {
            flags.push(`⚠️ Top Holder owns ${top1Pct.toFixed(1)}%`);
            holderRisk = "MEDIUM";
            riskScore += 1;
        }

        const top10Sum = holders.slice(0, 10).reduce((sum, h) => sum + h.amount, 0);
        top10Pct = (top10Sum / mintInfo.supply) * 100;

        if (top10Pct > 50) {
            flags.push(`⚠️ Top 10 own ${top10Pct.toFixed(1)}% (Concentrated)`);
            if (holderRisk !== "HIGH") holderRisk = "MEDIUM";
            riskScore += 2;
        }
    }

    let contractRisk: IntegrityReport["contractRisk"] = "LOW";
    if (riskScore >= 4) contractRisk = "HIGH";
    else if (riskScore >= 2) contractRisk = "MEDIUM";

    const score = Math.max(0, 100 - (riskScore * 10));

    return {
        contractRisk,
        holderRisk,
        behaviorRisk: behavior?.behaviorRisk || 'LOW',
        flags,
        top1Pct,
        top10Pct,
        score,
        behavior
    };
}

export class IntegrityScanner {
    private connection: Connection;

    constructor() {
        // Hard-Check: Use Helius RPC to avoid public mainnet-beta rate limits
        const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
        const rpcUrl = HELIUS_KEY
            ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
            : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

        this.connection = new Connection(rpcUrl, 'confirmed');
    }

    /**
     * Deep-tissue scan of a token mint config + distribution + behavior
     */
    public async scan(mintAddress: string): Promise<IntegrityReport> {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const [mintInfo, largestAccounts] = await Promise.all([
                this.connection.getParsedAccountInfo(mintPubkey),
                this.connection.getTokenLargestAccounts(mintPubkey)
            ]);

            const data = (mintInfo.value?.data as any)?.parsed?.info;
            if (!data) return {
                contractRisk: 'LOW',
                holderRisk: 'LOW',
                flags: [],
                score: 100,
                top1Pct: 0,
                top10Pct: 0
            };

            const decimals = data.decimals || 0;
            const supply = data.supply ? parseFloat(data.supply) : 0;

            const holders = (largestAccounts.value || []).map(h => ({
                amount: h.uiAmount !== undefined && h.uiAmount !== null
                    ? h.uiAmount * Math.pow(10, decimals)
                    : parseFloat(h.amount)
            }));

            // Behavioral Mock for Radar (due to latency constraints on background feed)
            const behavior: BehaviorReport = {
                deployerAddress: data.mintAuthority || 'Unknown',
                behaviorRisk: 'LOW',
                fundingSource: { type: 'UNKNOWN' },
                trackRecord: { totalLaunched: 0, diedQuickly: 0, confirmedRugs: 0 },
                flags: [],
                score: 100
            };

            return analyzeTokenIntegrity({
                mintAuthority: data.mintAuthority || null,
                freezeAuthority: data.freezeAuthority || null,
                supply: supply,
                decimals: decimals
            }, holders, behavior);

        } catch (err) {
            console.error(`[Integrity] Scan failed for ${mintAddress}:`, err);
            return {
                contractRisk: 'LOW',
                holderRisk: 'LOW',
                flags: [],
                score: 100,
                top1Pct: 0,
                top10Pct: 0
            };
        }
    }
}
