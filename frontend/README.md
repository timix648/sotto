# Sotto frontend

The Next.js application is part of the root Sotto npm workspace. It uses the live Fastify API, the canonical `@sotto/shared` protocol package, and wallet-signed Hedera testnet transactions.

## Run the complete application

From the repository root:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path frontend/.env.local)) { Copy-Item frontend/.env.example frontend/.env.local }
```

Fill the private-key values in the root `.env` only. Never put a private key in `frontend/.env.local`; every `NEXT_PUBLIC_*` value is bundled into the browser.

Start the two services in separate terminals:

```powershell
npm run serve
npm run dev:frontend
```

Open [http://localhost:3000](http://localhost:3000). The live API is on port 4000 and must report `mock: false` at `/api/health`.

Useful checks:

```powershell
npm run typecheck:frontend
npm run test:frontend
npm run build:frontend
npm run test:engine
npm test
```

## Trading flow

1. The seller connects the wallet that owns the ATS security and opens an RFQ.
2. The same wallet calls `createHoldByPartition`, escrowing the offered quantity to `SottoSettlement`; the API verifies the on-chain hold.
3. Dealers commit `keccak256(price, quantity, nonce, dealer)`. The price, quantity, and nonce remain in that browser until reveal.
4. After the seller closes the commit window, dealers reveal their own bid size, minimum fill, price, and nonce.
5. The seller allocates the book. The backend preserves price priority and uses HCS sequence order for ties; partial fills and unfilled remainder are explicit.
6. The seller signs each allocated EIP-712 `Trade`. The API verifies the recovered seller address before making that signature available to the relevant dealer.
7. Each winning dealer approves the exact USDC notional, signs the same trade, and relays Path A settlement. Cash and the held security move atomically, or neither moves.

Multi-dealer allocations remain `AWARDED` until every fill has settled. Each fill has a distinct nonce and can be completed independently against the same hold.

## Boundaries

- Contract addresses and demo account addresses come from `/api/health`; none are hardcoded in runtime components.
- Protocol types, commit hashing, RFQ IDs, and EIP-712 definitions come from `packages/shared`. There is no frontend-local copy.
- The live browser flow uses permissionless Path A. The proven HIP-551 Path B remains available through the backend scripts; the API does not pretend to offer a browser Path B flow it cannot assemble.
- Issuer KYC and unit issuance controls call the trusted local admin API, which holds the issuer key. Do not expose those endpoints publicly without authentication or replacing them with issuer-wallet transactions.
- RFQ records and submitted seller signatures are in memory, matching the current backend design. Restarting the API clears active RFQs.
- `.env.local` is ignored by Git. Set a Reown project ID there: AppKit lists installed EIP-6963 desktop wallets first and keeps WalletConnect QR/mobile as a fallback.
