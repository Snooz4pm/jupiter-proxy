const https = require('https');

const JUP_ALL = 'https://token.jup.ag/all';

https.get(JUP_ALL, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const tokens = JSON.parse(data);
            const list = Array.isArray(tokens) ? tokens : (tokens.tokens || []);
            const valid = list.filter(t => t.address && t.symbol && t.name);

            console.log("-----------------------------------------");
            console.log(`📦 Total Raw Tokens: ${list.length}`);
            console.log(`🛡️  Sanity Filtered: ${valid.length}`);
            console.log("-----------------------------------------");
            if (valid.length > 50000) console.log("🚀 UNIVERSE EXPANDED.");
        } catch (e) {
            console.error("Failed to parse:", e.message);
        }
    });
}).on('error', (err) => {
    console.error("Fetch error:", err.message);
});
