import { Connection, PublicKey } from '@solana/web3.js';
import { analyzeBehavior, BehaviorReport } from './argus/behaviorEngine';

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
    let finalTop1Pct = 0;
    let finalTop10Pct = 0;

    if (holders && holders.length > 0 && mintInfo.supply > 0) {
        const top1Amount = holders[0].amount;
        finalTop1Pct = (top1Amount / mintInfo.supply) * 100;

        if (finalTop1Pct > 20) {
            flags.push(`⚠️ Top Holder owns ${finalTop1Pct.toFixed(1)}% (Dev/Cabal Warning)`);
            holderRisk = "HIGH";
            riskScore += 3;
        } else if (finalTop1Pct > 10) {
            flags.push(`⚠️ Top Holder owns ${finalTop1Pct.toFixed(1)}%`);
            holderRisk = "MEDIUM";
            riskScore += 1;
        }

        const top10Sum = holders.slice(0, 10).reduce((sum, h) => sum + h.amount, 0);
        finalTop10Pct = (top10Sum / mintInfo.supply) * 100;

        if (finalTop10Pct > 50) {
            flags.push(`⚠️ Top 10 own ${finalTop10Pct.toFixed(1)}% (Concentrated)`);
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
        top1Pct: finalTop1Pct,
        top10Pct: finalTop10Pct,
        score,
        behavior
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
            const supply = data.supply ? parseFloat(data.supply) : 0;

            const holders = (largestAccounts.value || []).map(h => ({
                amount: h.uiAmount !== undefined && h.uiAmount !== null
                    ? h.uiAmount * Math.pow(10, decimals)
                    : parseFloat(h.amount)
            }));

            // 2. Fetch Deployer Address via Helius DAS (Air-Traffic Control Grade)
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

            // 3. Perform Behavioral Analysis (Human Signature DNA)
            const behaviorReport = analyzeBehavior(deployerAddress, [], {});

            return analyzeTokenIntegrity({
                mintAuthority: data.mintAuthority || null,
                freezeAuthority: data.freezeAuthority || null,
                supply: supply,
                decimals: decimals
            }, holders, behaviorReport);

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
