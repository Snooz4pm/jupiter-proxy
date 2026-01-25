import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';

interface ScanResult {
    wallet: string;
    scannedAt: number;
    createdMints: string[];
    scanDepth: number;
    status: 'COMPLETE' | 'LIMIT_REACHED' | 'ERROR';
}

interface CacheEntry {
    timestamp: number;
    data: ScanResult;
}

const MAX_SIGNATURES = 500;
const MAX_MINTS_FOUND = 20;
const MAX_SCAN_AGE_DAYS = 30;
const THROTTLE_MS = 80; // ~12 requests/sec
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class WalletScanner {
    private connection: Connection;
    private cache: Map<string, CacheEntry>;

    constructor() {
        const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(RPC_URL, 'confirmed');
        this.cache = new Map();
    }

    private async throttle(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private getCache(wallet: string): ScanResult | null {
        const entry = this.cache.get(wallet);
        if (!entry) return null;

        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            this.cache.delete(wallet);
            return null;
        }

        return entry.data;
    }

    private setCache(wallet: string, data: ScanResult) {
        this.cache.set(wallet, {
            timestamp: Date.now(),
            data
        });
    }

    public async scan(walletAddress: string): Promise<ScanResult> {
        // 1. Check Cache
        const cached = this.getCache(walletAddress);
        if (cached) {
            console.log(`[WalletScanner] Cache hit for ${walletAddress}`);
            return cached;
        }

        console.log(`[WalletScanner] Starting scan for ${walletAddress}`);
        const createdMints: Set<string> = new Set();
        let pubkey: PublicKey;

        try {
            pubkey = new PublicKey(walletAddress);
        } catch (e) {
            throw new Error('Invalid wallet address');
        }

        try {
            // 2. Fetch Signatures (Bounded)
            const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit: MAX_SIGNATURES });
            let scanDepth = 0;

            for (const sigInfo of signatures) {
                scanDepth++;

                // 3. Age Cutoff
                if (sigInfo.blockTime) {
                    const ageDays = (Date.now() / 1000 - sigInfo.blockTime) / (60 * 60 * 24);
                    if (ageDays > MAX_SCAN_AGE_DAYS) {
                        console.log(`[WalletScanner] Age limit reached (${ageDays.toFixed(1)} days)`);
                        break;
                    }
                }

                // 4. Rate Limit
                await this.throttle(THROTTLE_MS);

                // 5. Fetch Transaction
                try {
                    const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
                        maxSupportedTransactionVersion: 0
                    });

                    if (tx) {
                        const mints = this.extractCreatedMints(tx, walletAddress);
                        mints.forEach(m => createdMints.add(m));
                    }
                } catch (err) {
                    console.warn(`[WalletScanner] Failed to parse tx ${sigInfo.signature}`, err);
                }

                // 6. Limits
                if (createdMints.size >= MAX_MINTS_FOUND) {
                    console.log(`[WalletScanner] Max mints found (${MAX_MINTS_FOUND})`);
                    break;
                }
            }

            const result: ScanResult = {
                wallet: walletAddress,
                scannedAt: Date.now(),
                createdMints: Array.from(createdMints),
                scanDepth,
                status: createdMints.size >= MAX_MINTS_FOUND || scanDepth >= MAX_SIGNATURES ? 'LIMIT_REACHED' : 'COMPLETE'
            };

            // 7. Update Cache
            this.setCache(walletAddress, result);
            return result;

        } catch (error: any) {
            console.error(`[WalletScanner] Scan failed for ${walletAddress}:`, error);
            return {
                wallet: walletAddress,
                scannedAt: Date.now(),
                createdMints: [],
                scanDepth: 0,
                status: 'ERROR'
            };
        }
    }

    private extractCreatedMints(tx: ParsedTransactionWithMeta, wallet: string): string[] {
        const found: string[] = [];

        if (!tx.meta || tx.meta.err) return found;

        // Logic: Look for 'initializeMint' instruction where the signer is the wallet
        // This is a simplified heuristic. A better one involves checking the account keys.

        const instructions = tx.transaction.message.instructions;

        for (const ix of instructions) {
            if ('parsed' in ix) {
                const type = ix.parsed.type;
                // Check specifically for SPL Token initialization
                if (type === 'initializeMint' || type === 'initializeMint2') {
                    const mint = ix.parsed.info.mint;
                    // Verify the wallet is a signer in this transaction (likely the creator)
                    const isSigner = tx.transaction.message.accountKeys.some(
                        key => key.pubkey.toBase58() === wallet && key.signer
                    );

                    if (isSigner && mint) {
                        found.push(mint);
                    }
                }
            }
        }

        return found;
    }
}
