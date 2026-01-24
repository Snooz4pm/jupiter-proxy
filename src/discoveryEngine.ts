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

            // Survey multiple entry points for wider coverage
            const queries = ['solana', 'usdc', 'raydium'];
            const allPairs: any[] = [];

            for (const q of queries) {
                const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.pairs) allPairs.push(...data.pairs);
                }
            }

            // High-Value Filtering: Exclude majors/stablecoins
            const EXCLUSION_LIST = [
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                'So11111111111111111111111111111111111111112', // Wrapped SOL
                'mSoLzYq7mSbw61TJueRVD d69pSTB9M9v7G3S78j8',      // mSOL
                '7dHbS7qbs62EjAnfX8iHv386qz7 5dY987654321',      // stSOL
                'J1t9YjBes 1y5S3X5K 1X 1y5S3X5K'               // jitoSOL (Approx)
            ];

            for (const pair of allPairs) {
                if (pair.chainId !== 'solana' || !pair.baseToken) continue;
                if (EXCLUSION_LIST.includes(pair.baseToken.address)) continue;

                const score = this.scoreSignal(pair);
                if (score >= 3) {
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
        const liquidity = pair.liquidity?.usd || 0;
        const fdv = pair.fdv || 0;

        // 1. Volume Activity (Lowered bars for discovery)
        if (volume5m > 500) score += 1;
        if (volume5m > 5000) score += 2;
        if (volume5m > 20000) score += 3;

        // 2. Liquidity Depth
        if (liquidity > 2000) score += 1;
        if (liquidity > 10000) score += 2;
        if (liquidity > 50000) score += 3;

        // 3. Asset Pairing
        if (pair.quoteToken?.symbol === 'SOL') score += 1;
        if (pair.quoteToken?.symbol === 'USDC') score += 1;

        // 4. Sanity Filters
        if (fdv < 500) score -= 5;
        if (liquidity < 200) score -= 10;

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

        // Refined Flow Logic
        let flow = "Neutral";
        const v5m = pair.volume?.m5 || 0;
        if (v5m > 100000) flow = "🐳 Mega Inflow";
        else if (v5m > 20000) flow = "🔥 Momentum";
        else if (v5m > 5000) flow = "📈 Accumulating";
        else if (riskScore > 5) flow = "🛰️ Signal Found";

        const result: DiscoveryResult = {
            mint,
            symbol: pair.baseToken.symbol || '?',
            name: pair.baseToken.name || 'Unknown',
            price,
            supply,
            mcap,
            volume5m: v5m,
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
