/**
 * Argus Reality Engine
 * Location: src/argus/realityEngine.ts (Railway Proxy Sync)
 */

export type RealityFeasibility = "POSSIBLE" | "UNLIKELY" | "UNREALISTIC";

export interface RealityComparison {
    name: string;
    mcap: number;
    description: string;
}

export interface RealityMetrics {
    currentMarketCap: number;
    requiredMarketCap: number;
    growthMultiplier: number;
    growthPercent: number;
    feasibility: RealityFeasibility;
    comparison?: RealityComparison;
    meaningQuote: string;
}

const COMPARISONS: RealityComparison[] = [
    { name: "BTC", mcap: 800_000_000_000, description: "Institutional Dominance (Approaching Digital Gold scale)" },
    { name: "ETH", mcap: 300_000_000_000, description: "Ecosystem Backbone (Global Settlement Layer scale)" },
    { name: "SOL", mcap: 60_000_000_000, description: "High-Performance Network (Top 5 Asset scale)" },
    { name: "Coinbase", mcap: 40_000_000_000, description: "Public Exchange (Institutional Proxy scale)" },
    { name: "Top Meme", mcap: 5_000_000_000, description: "Viral Winner (Rare Unicorn scale)" },
    { name: "Mid-Cap Gem", mcap: 1_000_000_000, description: "Established Project (Standard Mid-Cap scale)" },
];

export function calculateReality(
    currentPrice: number,
    circulatingSupply: number,
    targetPrice: number
): RealityMetrics {
    const currentMarketCap = currentPrice * circulatingSupply;
    const requiredMarketCap = targetPrice * circulatingSupply;

    const growthMultiplier = targetPrice / currentPrice;
    const growthPercent = (growthMultiplier - 1) * 100;

    let feasibility: RealityFeasibility = "POSSIBLE";
    let meaningQuote = "This scale is attainable for successful mid-cap gems.";

    if (requiredMarketCap > 10_000_000_000) {
        feasibility = "UNREALISTIC";
        meaningQuote = "Only 0.03% of crypto assets ever reach this scale. Requires global institutional inflow.";
    } else if (requiredMarketCap > 1_000_000_000) {
        feasibility = "UNLIKELY";
        meaningQuote = "Entering Tier-1 territory. Historically, very few projects maintain this size.";
    }

    const comparison = [...COMPARISONS]
        .sort((a, b) => Math.abs(a.mcap - requiredMarketCap) - Math.abs(b.mcap - requiredMarketCap))[0];

    return {
        currentMarketCap,
        requiredMarketCap,
        growthMultiplier,
        growthPercent,
        feasibility,
        comparison,
        meaningQuote
    };
}
