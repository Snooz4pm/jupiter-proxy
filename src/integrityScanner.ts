import { Connection, PublicKey } from '@solana/web3.js';

export interface DistributionQuality {
    score: number;
    grade: 'HEALTHY' | 'MODERATE_RISK' | 'HIGHLY_CENTRALIZED';
}

export type IntegrityReport = {
    contractRisk: "LOW" | "MEDIUM" | "HIGH";
    holderRisk: "LOW" | "MEDIUM" | "HIGH";
    behaviorRisk?: "LOW" | "MEDIUM" | "HIGH";
    flags: string[];
    top1Pct: number;
    top10Pct: number;
    score: number;
    behavior?: BehaviorReport;
    distributionQuality?: DistributionQuality;
};

function calculateDistributionQuality(
    top1Pct: number,
    top10Pct: number
): DistributionQuality {
    let score = 100;

    if (top1Pct > 50) score -= 40;
    else if (top1Pct > 30) score -= 30;
    else if (top1Pct > 20) score -= 20;
    else if (top1Pct > 10) score -= 10;
    else if (top1Pct < 5) score += 5;

    if (top10Pct > 80) score -= 30;
    else if (top10Pct > 60) score -= 20;
    else if (top10Pct > 40) score -= 10;
    else if (top10Pct < 25) score += 5;

    score = Math.max(0, Math.min(100, score));

    let grade: DistributionQuality['grade'] = 'HEALTHY';
    if (score < 50) grade = 'HIGHLY_CENTRALIZED';
    else if (score < 80) grade = 'MODERATE_RISK';

    return { score, grade };
}

export function analyzeTokenIntegrity(
    mintInfo: {
        mintAuthority: string | null;
        freezeAuthority: string | null;
        supplyUi: number; // Human-readable supply
        decimals: number;
    },
    holders?: { uiAmount: number }[]
): IntegrityReport {
    const flags: string[] = [];
    let riskScore = 0;

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

    // 2. Supply Distribution Analysis - RECOMMENDED APPROACH (uiAmount)
    let holderRisk: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    let finalTop1Pct = 0;
    let finalTop10Pct = 0;

    console.log('=== [RAILWAY] HOLDER % CALCULATION (uiAmount) ===');
    console.log('supplyUi:', mintInfo.supplyUi);
    console.log('holders.length:', holders?.length || 0);

    if (holders && holders.length > 0 && mintInfo.supplyUi > 0) {
        const sortedHolders = [...holders].sort((a, b) => b.uiAmount - a.uiAmount);

        console.log('topHolder.uiAmount:', sortedHolders[0]?.uiAmount);

        const topHolderAmount = sortedHolders[0].uiAmount;
        finalTop1Pct = (topHolderAmount / mintInfo.supplyUi) * 100;

        console.log('FINAL Top1%:', finalTop1Pct);

        if (finalTop1Pct > 20) {
            flags.push(`⚠️ Top Holder owns ${finalTop1Pct.toFixed(1)}% (Dev/Cabal Warning)`);
            holderRisk = "HIGH";
            riskScore += 3;
        } else if (finalTop1Pct > 10) {
            flags.push(`⚠️ Top Holder owns ${finalTop1Pct.toFixed(1)}%`);
            holderRisk = "MEDIUM";
            riskScore += 1;
        }

        const top10Total = sortedHolders
            .slice(0, 10)
            .reduce((sum, h) => sum + h.uiAmount, 0);

        finalTop10Pct = (top10Total / mintInfo.supplyUi) * 100;

        console.log('top10Total:', top10Total);
        console.log('FINAL Top10%:', finalTop10Pct);

        if (finalTop10Pct > 50) {
            flags.push(`⚠️ Top 10 own ${finalTop10Pct.toFixed(1)}% (Concentrated)`);
            if (holderRisk !== "HIGH") holderRisk = "MEDIUM";
            riskScore += 2;
        }
    } else {
        console.warn('⚠️ [RAILWAY] HOLDER CALCULATION SKIPPED:', {
            hasHolders: !!holders,
            holdersLength: holders?.length || 0,
            supplyUi: mintInfo.supplyUi
        });
    }
    console.log('=== END DEBUG ===');

    let contractRisk: IntegrityReport["contractRisk"] = "LOW";
    if (riskScore >= 4) contractRisk = "HIGH";
    else if (riskScore >= 2) contractRisk = "MEDIUM";

    const score = Math.max(0, 100 - (riskScore * 10));

    // Calculate distribution quality
    const distributionQuality = calculateDistributionQuality(finalTop1Pct, finalTop10Pct);

    return {
        contractRisk,
        holderRisk,
        flags,
        top1Pct: finalTop1Pct,
        top10Pct: finalTop10Pct,
        score,
        distributionQuality
    };
}

export class IntegrityScanner {
    private connection: Connection;
    private heliusUrl: string;

    constructor() {
        const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
        this.heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
        this.connection = new Connection(this.heliusUrl, 'confirmed');
    }

    public async scan(mintAddress: string): Promise<IntegrityReport> {
        try {
            const mintPubkey = new PublicKey(mintAddress);

            // 1. Fetch Basic Info & Holders via RPC
            const [mintInfo, largestAccounts] = await Promise.all([
                this.connection.getParsedAccountInfo(mintPubkey),
                this.connection.getTokenLargestAccounts(mintPubkey)
            ]);

            const data = (mintInfo.value?.data as any)?.parsed?.info;
            if (!data) throw new Error("On-chain data missing");

            const decimals = data.decimals || 0;
            const supplyRaw = data.supply ? parseFloat(data.supply) : 0;
            const supplyUi = supplyRaw / Math.pow(10, decimals);

            // Use uiAmount directly (recommended approach)
            const holdersUi = (largestAccounts.value || [])
                .filter(h => h.uiAmount != null)
                .map(h => ({ uiAmount: h.uiAmount! }));

            // 2. Fetch Deployer Address via Helius DAS
            let deployerAddress = data.mintAuthority || 'Unknown';

            try {
                const dasRes = await fetch(this.heliusUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: "das-check",
                        method: "getAsset",
                        params: { id: mintAddress }
                    })
                });
                if (dasRes.ok) {
                    const dasData = await dasRes.json();
                    const asset = dasData.result;
                    deployerAddress = asset.authorities?.[0]?.authority || asset.creators?.[0]?.address || deployerAddress;
                }
            } catch (e) {
                console.warn(`[Integrity] DAS fallback failed for ${mintAddress}`);
            }

            return analyzeTokenIntegrity({
                mintAuthority: data.mintAuthority || null,
                freezeAuthority: data.freezeAuthority || null,
                supplyUi: supplyUi,
                decimals: decimals
            }, holdersUi);

        } catch (err: any) {
            console.error(`[Integrity] Full Protocol scan failed for ${mintAddress}:`, err.message);
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
