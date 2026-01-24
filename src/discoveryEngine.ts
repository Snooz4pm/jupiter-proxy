/**
 * Argus Discovery Engine (Phase 1)
 * Location: jupiter-proxy/src/discoveryEngine.ts
 * 
 * Background surveillance for Solana token events.
 */

export interface DiscoveryResult {
    mint: string;
    symbol: string;
    name: string;
    price: number;
    supply: number;
    mcap: number;
    volume5m: number;
    riskScore: number;
    feasibility: 'POSSIBLE' | 'UNLIKELY' | 'UNREALISTIC';
    flow: string;
    timestamp: number;
}

export class DiscoveryEngine {
    private cache: Map<string, DiscoveryResult> = new Map();
    private isPolling = false;

    constructor() {
        console.log('[Discovery] Engine Initialized.');
    }

    public start() {
        if (this.isPolling) return;
        this.isPolling = true;
        this.pollVolumeSpikes();
        // Poll every 60 seconds
        setInterval(() => this.pollVolumeSpikes(), 60000);
    }

    public getFeed(): DiscoveryResult[] {
        return Array.from(this.cache.values())
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50);
    }

    private async pollVolumeSpikes() {
        try {
            console.log('[Discovery] Intercepting Market Signals...');

            // Hit DexScreener search for 'solana' to get recently active pairs
            const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
            if (!res.ok) return;

            const data = await res.json();
            const pairs = data.pairs || [];

            for (const pair of pairs) {
                if (pair.chainId !== 'solana' || !pair.baseToken) continue;

                const score = this.scoreSignal(pair);
                if (score >= 5) {
                    this.processSignal(pair, score);
                }
            }

            console.log(`[Discovery] Radar Status: ${this.cache.size} packets in track.`);
        } catch (err) {
            console.error('[Discovery] Pulse failed:', err);
        }
    }

    private scoreSignal(pair: any): number {
        let score = 0;

        const volume5m = pair.volume?.m5 || 0;
        const volume1h = pair.volume?.h1 || 0;
        const liquidity = pair.liquidity?.usd || 0;
        const fdv = pair.fdv || 0;

        // 1. Volume Delta Score
        if (volume5m > 5000) score += 2;
        if (volume5m > 20000) score += 3;

        // 2. Liquidity Confidence
        if (liquidity > 10000) score += 2;
        if (liquidity > 50000) score += 3;

        // 3. Asset Pairing
        if (pair.quoteToken?.symbol === 'SOL') score += 2;

        // 4. Sanity Filters
        if (fdv < 1000) score -= 5; // Likely dust/spam
        if (liquidity < 500) score -= 10; // Rug risk

        return score;
    }

    private processSignal(pair: any, riskScore: number) {
        const mint = pair.baseToken.address;
        const price = parseFloat(pair.priceUsd || '0');
        const fdv = pair.fdv || 0;

        // Heuristic: Implied Supply
        const supply = (fdv > 0 && price > 0) ? fdv / price : 0;
        const mcap = price * supply;

        // 1. Calculate Reality (Feasibility)
        let feasibility: 'POSSIBLE' | 'UNLIKELY' | 'UNREALISTIC' = 'POSSIBLE';
        const targetMcap = mcap * 10; // Baseline check at 10x

        if (targetMcap > 10_000_000_000) feasibility = 'UNREALISTIC';
        else if (targetMcap > 1_000_000_000) feasibility = 'UNLIKELY';

        // 2. Derive Flow
        let flow = "Neutral";
        const volume5m = pair.volume?.m5 || 0;
        if (riskScore >= 8 && volume5m > 50000) flow = "🐳 Smart Inflow";
        else if (volume5m > 20000) flow = "🔥 Momentum";
        else if (riskScore < 0) flow = "⚠️ Risky Surge";

        const result: DiscoveryResult = {
            mint,
            symbol: pair.baseToken.symbol || '?',
            name: pair.baseToken.name || 'Unknown',
            price,
            supply,
            mcap,
            volume5m,
            riskScore,
            feasibility,
            flow,
            timestamp: Date.now()
        };

        this.cache.set(mint, result);

        // Cleanup old signals (> 30 mins)
        if (this.cache.size > 200) {
            const oldest = Array.from(this.cache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
            if (oldest) this.cache.delete(oldest[0]);
        }
    }
}
