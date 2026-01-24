import { Connection, PublicKey } from '@solana/web3.js';

export type IntegrityReport = {
    contractRisk: "LOW" | "MEDIUM" | "HIGH";
    flags: string[];
    score: number; // Keep score for ranking
};

export function analyzeMintConfig(mintInfo: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    supply: number;
    decimals: number;
}): IntegrityReport {
    const flags: string[] = [];
    let riskScore = 0;

    if (mintInfo.mintAuthority) {
        flags.push("Mint authority still enabled (supply can inflate)");
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

    let contractRisk: IntegrityReport["contractRisk"] = "LOW";

    if (riskScore >= 4) contractRisk = "HIGH";
    else if (riskScore >= 2) contractRisk = "MEDIUM";

    // Calculate internal raw score (100 = safe)
    const score = Math.max(0, 100 - (riskScore * 15));

    return {
        contractRisk,
        flags,
        score
    };
}

export class IntegrityScanner {
    private connection: Connection;

    constructor() {
        const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcUrl, 'confirmed');
    }

    /**
     * Deep-tissue scan of a token mint config
     */
    public async scan(mintAddress: string): Promise<IntegrityReport> {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
            const data = (mintInfo.value?.data as any)?.parsed?.info;

            if (!data) return { contractRisk: 'LOW', flags: [], score: 100 };

            return analyzeMintConfig({
                mintAuthority: data.mintAuthority || null,
                freezeAuthority: data.freezeAuthority || null,
                supply: data.supply ? parseFloat(data.supply) : 0,
                decimals: data.decimals || 0
            });

        } catch (err) {
            console.error(`[Integrity] Scan failed for ${mintAddress}:`, err);
            return { contractRisk: 'LOW', flags: [], score: 100 };
        }
    }
}
