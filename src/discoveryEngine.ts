import { IntegrityScanner, IntegrityReport } from './integrityScanner';
import { analyzeBehavior, BehaviorReport } from './argus/behaviorEngine';
import { analyzeTiming, TimingReport } from './argus/timingEngine';
import { calculateReality, RealityMetrics } from './argus/realityEngine';
import { getPrimaryRisk, PrimaryRisk } from './argus/riskScanner';

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
    integrity?: IntegrityReport;
    behavior?: BehaviorReport;
    timing?: TimingReport;
    primaryRisk?: PrimaryRisk;
}

export class DiscoveryEngine {
    private cache: Map<string, DiscoveryResult> = new Map();
    private isPolling = false;
    private integrityScanner: IntegrityScanner;

    constructor() {
        console.log('[Discovery] Engine Initialized.');
        this.integrityScanner = new IntegrityScanner();
    }

    public start() {
        if (this.isPolling) return;
        this.isPolling = true;
        this.pollVolumeSpikes();
        // Poll every 60 seconds (Baseline surveillance)
        setInterval(() => this.pollVolumeSpikes(), 60000);
    }

    public getFeed(): DiscoveryResult[] {
        return Array.from(this.cache.values())
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50);
    }

    /**
     * Phase 2 & 3: Real-time Webhook Interception
     * Processes Helius Enhanced Transactions
     */
    public async handleWebhook(payload: any[]) {
        try {
            for (const tx of payload) {
                if (tx.transactionError) continue;

                // 1. Detect LP Creation (Raydium / Orca)
                if (tx.type === 'INIT_POOL') {
                    const mint = tx.tokenTransfers?.[0]?.mint || tx.accountData?.[0]?.account;
                    if (mint) {
                        console.log(`[Discovery] 🛰️ REAL-TIME LP INTERCEPTED: ${mint}`);
                        this.enrichAndScore(mint, '🛰️ RECENT LP', 8);
                    }
                }

                // 2. Detect New Token Mints
                if (tx.type === 'TOKEN_MINT') {
                    const mint = tx.instructions?.[0]?.accounts?.[0]; // Usually first account in InitializeMint
                    if (mint) {
                        console.log(`[Discovery] 🐣 NEWBORN TOKEN DETECTED: ${mint}`);
                        this.enrichAndScore(mint, '🐣 NEWBORN', 5);
                    }
                }
            }
        } catch (err) {
            console.error('[Discovery] Webhook processing failed:', err);
        }
    }

    /**
     * Fetch real-time data for an intercepted mint and push to radar
     */
    private async enrichAndScore(mint: string, flow: string, baseScore: number) {
        try {
            // Wait slightly for DexScreener to index (5s)
            setTimeout(async () => {
                const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                if (!res.ok) return;

                const data = await res.json();
                const pairs = data.pairs || [];
                if (pairs.length === 0) return;

                const bestPair = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
                this.processSignal(bestPair, baseScore + 5, flow);
            }, 5000);
        } catch (err) {
            console.error(`[Discovery] Enrichment failed for ${mint}:`, err);
        }
    }

    private async pollVolumeSpikes() {
        try {
            console.log('[Discovery] Interception的市场信号...');

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

            const EXCLUSION_LIST = [
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                'So11111111111111111111111111111111111111112', // Wrapped SOL
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

        if (volume5m > 500) score += 1;
        if (volume5m > 5000) score += 2;
        if (volume5m > 20000) score += 3;

        if (liquidity > 2000) score += 1;
        if (liquidity > 10000) score += 2;
        if (liquidity > 50000) score += 3;

        if (pair.quoteToken?.symbol === 'SOL') score += 1;
        if (pair.quoteToken?.symbol === 'USDC') score += 1;

        if (fdv < 500) score -= 5;
        if (liquidity < 200) score -= 10;

        return score;
    }

    private async processSignal(pair: any, riskScore: number, flowOverride?: string) {
        const mint = pair.baseToken.address;
        const price = parseFloat(pair.priceUsd || '0');
        const fdv = pair.fdv || 0;

        // Heuristic: Implied Supply
        const supply = (fdv > 0 && price > 0) ? fdv / price : 0;
        const mcap = price * supply;

        // 1. Calculate Reality (Feasibility)
        const reality = calculateReality(price, supply, price * 10);

        // Refined Flow Logic
        let flow = flowOverride || "Neutral";
        if (!flowOverride) {
            const v5m = pair.volume?.m5 || 0;
            if (v5m > 100000) flow = "🐳 Mega Inflow";
            else if (v5m > 20000) flow = "🔥 Momentum";
            else if (v5m > 5000) flow = "📈 Accumulating";
            else if (riskScore > 5) flow = "🛰️ Signal Found";
        }

        // 2. PHASE 4: Core Integrity Scan (Non-blocking but full protocol)
        let integrity: IntegrityReport | undefined;
        let behavior: BehaviorReport | undefined;
        let timing: TimingReport | undefined;
        let primaryRisk: PrimaryRisk | undefined;

        try {
            // Full Intelligence Scan
            integrity = await this.integrityScanner.scan(mint);

            // Behavior is not included in integrity report - would need separate scan
            behavior = null;

            timing = analyzeTiming(
                { current: price, change24h: pair.priceChange?.h24 || 0 },
                { current: pair.volume?.h24 || 0, change24h: 100 }
            );

            primaryRisk = getPrimaryRisk(integrity, behavior || null, timing, reality);

        } catch (e) {
            console.error(`[Integrity] Full Protocol scan failed for ${mint}`);
        }

        const result: DiscoveryResult = {
            mint,
            symbol: pair.baseToken.symbol || '?',
            name: pair.baseToken.name || 'Unknown',
            price,
            supply,
            mcap,
            volume5m: pair.volume?.m5 || 0,
            riskScore: riskScore + (integrity?.score ? (integrity.score / 10) : 0),
            feasibility: reality.feasibility,
            flow,
            timestamp: Date.now(),
            integrity,
            behavior,
            timing,
            primaryRisk
        };

        this.cache.set(mint, result);

        if (this.cache.size > 200) {
            const oldest = Array.from(this.cache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
            if (oldest) this.cache.delete(oldest[0]);
        }
    }
}
