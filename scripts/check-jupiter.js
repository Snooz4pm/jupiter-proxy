/**
 * Jupiter Token Fetch Sanity Check
 * Run: node scripts/check-jupiter.js
 */

const ENDPOINTS = [
    "https://cache.jup.ag/tokens",
    "https://quote-api.jup.ag/v6/tokens"
];

const TIMEOUT_MS = 7000;

async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: "application/json" }
        });

        const text = await res.text();

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        if (text.startsWith("<!DOCTYPE")) {
            throw new Error("HTML response received (blocked)");
        }

        const json = JSON.parse(text);

        if (!Array.isArray(json)) {
            throw new Error("Invalid JSON structure");
        }

        return json;
    } finally {
        clearTimeout(id);
    }
}

(async () => {
    console.log("🔍 Jupiter Token Fetch Check\n");

    for (const url of ENDPOINTS) {
        console.log(`→ Testing ${url}`);

        try {
            const start = Date.now();
            const tokens = await fetchWithTimeout(url);
            const ms = Date.now() - start;

            console.log(`   ✅ Success`);
            console.log(`   📦 Tokens: ${tokens.length}`);
            console.log(`   ⏱️  Time: ${ms}ms\n`);

            if (tokens.length === 0) {
                throw new Error("Zero tokens returned");
            }

            console.log("🎉 PASS — Jupiter token feed healthy");
            process.exit(0);
        } catch (err) {
            console.warn(`   ❌ Failed: ${err.message}\n`);
        }
    }

    console.error("🚨 FAIL — All Jupiter endpoints failed");
    process.exit(1);
})();
