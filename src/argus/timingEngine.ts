/**
 * Argus Timing Engine - Phase 4 v4
 * Location: src/argus/timingEngine.ts (Railway Proxy Sync)
 */

export interface TimingReport {
    velocity: "STAGNANT" | "STEADY" | "ACCELERATING" | "EXHAUSTED";
    momentumScore: number;
    signals: string[];
    volumeChange24h?: number;
    priceChange24h?: number;
}

export function analyzeTiming(
    priceAction: { current: number; change24h: number },
    volumeAction: { current: number; change24h: number }
): TimingReport {
    const signals: string[] = [];
    let momentumScore = 50;

    const volChange = volumeAction.change24h;
    const priceChange = priceAction.change24h;

    let velocity: TimingReport["velocity"] = "STAGNANT";

    if (volChange > 100 && priceChange > 10) {
        velocity = "ACCELERATING";
        signals.push("🚀 Strong Bullish Momentum (High Velocity)");
        momentumScore += 30;
    } else if (volChange > 50 && priceChange > 0) {
        velocity = "STEADY";
        signals.push("📈 Healthy Accumulation Flow");
        momentumScore += 10;
    } else if (volChange > 300 && priceChange < -5) {
        velocity = "EXHAUSTED";
        signals.push("⚠️ Sell-off Surge / Exhaustion detected");
        momentumScore -= 40;
    }

    if (volChange > 500 && priceChange > 50) {
        signals.push("🚩 Parabolic Alert: High blow-off risk");
        momentumScore -= 10;
    }

    if (volChange < -50 && priceChange < 0) {
        signals.push("📉 Volume Drying: Liquidity risk increasing");
        momentumScore -= 15;
    }

    return {
        velocity,
        momentumScore: Math.min(100, Math.max(0, momentumScore)),
        signals,
        volumeChange24h: volChange,
        priceChange24h: priceChange
    };
}
