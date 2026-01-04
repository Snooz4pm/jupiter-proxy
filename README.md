# Jupiter Proxy Server

Railway-hosted Node.js proxy for Jupiter v6 API to bypass Vercel DNS resolution issues.

## Why This Exists

Vercel's Node.js runtime cannot resolve `quote-api.jup.ag` DNS (ENOTFOUND error). This proxy runs on Railway's infrastructure which has no such limitations.

## Endpoints

### `GET /health`
Health check endpoint
```
Response: { "status": "ok", "service": "jupiter-proxy" }
```

### `GET /quote`
Proxies Jupiter v6 quote requests

**Query Parameters:**
- `inputMint` (required): Input token mint address
- `outputMint` (required): Output token mint address
- `amount` (required): Amount in lamports
- `slippageBps` (optional): Slippage in basis points (default: 50)
- `swapMode` (optional): Swap mode (default: ExactIn)

**Example:**
```
GET /quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=50&swapMode=ExactIn
```

### `POST /swap`
Proxies Jupiter v6 swap transaction requests

**Body:**
```json
{
  "quoteResponse": { ... },
  "userPublicKey": "string",
  "wrapAndUnwrapSol": true,
  "feeAccount": "string (optional)",
  "prioritizationFeeLamports": number (optional)
}
```

## Deployment to Railway

### 1. Create GitHub Repository

```bash
cd jupiter-proxy
git init
git add .
git commit -m "Initial commit: Jupiter v6 proxy server"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/jupiter-proxy.git
git push -u origin main
```

### 2. Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your `jupiter-proxy` repository
5. Railway will auto-detect the Node.js project

### 3. Configure Environment Variables

In Railway dashboard, add:

- `ALLOWED_ORIGINS`: Your Vercel domain (e.g., `https://your-app.vercel.app`)
- `PORT`: Railway auto-sets this (leave empty)

### 4. Get Your Deployment URL

After deployment completes:
1. Go to Settings > Domains
2. Click "Generate Domain"
3. Copy the URL (e.g., `https://jupiter-proxy-production.up.railway.app`)

### 5. Update Vercel Environment Variables

In your Vercel project settings, add:

```
JUPITER_PROXY_URL=https://jupiter-proxy-production.up.railway.app
```

## Local Development

```bash
npm install
npm run dev
```

Server runs on `http://localhost:3001`

## Testing

```bash
# Health check
curl http://localhost:3001/health

# Quote request (0.1 SOL → USDC)
curl "http://localhost:3001/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=50&swapMode=ExactIn"
```

## Integration with Vercel App

Once deployed, update your Solana API routes to use the proxy:

```typescript
const JUPITER_API = process.env.JUPITER_PROXY_URL || 'https://quote-api.jup.ag/v6';
```

This allows fallback to direct Jupiter API in local development while using the proxy in production.

## Architecture

```
User Browser
  ↓
Vercel (Next.js API)
  ↓
Railway (This Proxy)
  ↓
Jupiter API
```

## License

MIT
