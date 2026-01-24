export type IntegrityReport = {
    contractRisk: "LOW" | "MEDIUM" | "HIGH";
    flags: string[];
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

    return {
        contractRisk,
        flags,
    };
}
