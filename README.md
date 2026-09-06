# Sotto

**A request-for-quote block-trading venue for ATS-issued securities, on Hedera.**

Asset Tokenization Studio lets an issuer mint a compliant bond. It does not let anyone
*trade* one. Sotto is the missing secondary market: a holder puts size up for bid, dealers
compete under commit–reveal so nobody can last-look off a rival's price, and the winning
trade settles as a single atomic delivery-versus-payment transaction — security leg and cash
leg, both or neither.

Compliance is not bolted on by the venue. It is enforced by the token itself, at the moment
of transfer. Revoke a buyer's KYC and the settlement reverts on-chain, with both ledgers
untouched.

> ATS ships a `Hold` primitive whose own documentation lists **"Secondary Market Trading"** as
> use case one: *"When placing a sell order, the marketplace needs ability to transfer your
> tokens to a buyer."* They built the escrow for a marketplace. The marketplace does not
> exist. Sotto is that marketplace.

**ETHOnline 2026 · Hedera · Tokenization of Anything**

---

## Contents

- [Live on Hedera testnet](#live-on-hedera-testnet)
- [Verify it yourself](#verify-it-yourself)
- [How settlement works](#how-settlement-works)
- [Two settlement paths](#two-settlement-paths)
- [What makes this a venue and not a swap](#what-makes-this-a-venue-and-not-a-swap)
- [Known limitations](#known-limitations)
- [What we learned about ATS that is not in the docs](#what-we-learned-about-ats-that-is-not-in-the-docs)
- [Architecture](#architecture)
- [Running it](#running-it)
- [Roadmap: CLPR](#roadmap-clpr)

---

## Live on Hedera testnet

Two asset classes, both issued from Hedera's own deployed ATS factory `0.0.7708432`.
Cash is **real Circle USDC**. Nothing was minted for convenience.

| | |
|---|---|
| Bond — `STO-BOND-A` | [`0xD53072649037FEecD305920087791a37dF8D517F`](https://hashscan.io/testnet/contract/0xD53072649037FEecD305920087791a37dF8D517F) |
| Equity — `STO-EQ-A` | [`0x21C3E7368a77756E896D58a6f97C3099Cc9C47e0`](https://hashscan.io/testnet/contract/0x21C3E7368a77756E896D58a6f97C3099Cc9C47e0) |
| `SottoSettlement` | [`0x73195C1f91899Bc1E822bb1D039033Eb38926931`](https://hashscan.io/testnet/contract/0x73195C1f91899Bc1E822bb1D039033Eb38926931) |
| `SottoNavOracle` | [`0xe8E7c39ba776C3B0778BE4571e72F5669f662c04`](https://hashscan.io/testnet/contract/0xe8E7c39ba776C3B0778BE4571e72F5669f662c04) |
| `SottoDealerBond` | [`0x192565BD006c559afFe12B4eAD0Cd749581702aF`](https://hashscan.io/testnet/contract/0x192565BD006c559afFe12B4eAD0Cd749581702aF) |
| `SottoCouponScheduler` | [`0xb97BF0203d5C914d40100C12683B2ed257E9cEec`](https://hashscan.io/testnet/contract/0xb97BF0203d5C914d40100C12683B2ed257E9cEec) |
| HCS audit topic | [`0.0.10383803`](https://hashscan.io/testnet/topic/0.0.10383803) |
| Cash | Circle USDC `0.0.429274` · EVM `0x…068cDa` · 6 dp |

**All four Sotto contracts are verified on Sourcify as `exact_match`**, which HashScan reads
automatically. The source you are reading is the bytecode that ran.

### Proven on-chain, not asserted

| What | Transaction |
|---|---|
| Atomic DvP — 20 bonds ↔ 19.67 USDC, both legs, one transaction | [`0x4c90cf5b…52fd`](https://hashscan.io/testnet/transaction/0x4c90cf5b62ed65ebdabb7621bb76c80596cd78dc29cf2303c68b3ccbcab552fd) |
| **Security for security** — 10 bonds ↔ 12 shares, no stablecoin in the trade | [`0x320fdef2…a1fb`](https://hashscan.io/testnet/transaction/0x320fdef2aacea95585bfaa7479a0e1fccc0e291ac03094218edb7cea22f5a1fb) |
| HIP-551 atomic batch — 3 records, all SUCCESS, each party signs only its own leg | `0.0.10380177@1788646998.050909150` |
| HIP-1215 — the contract schedules its own coupon | schedule [`0.0.10384068`](https://hashscan.io/testnet/transaction/0x19a509cdc0b424edc4c1da43b6579f7ef772c07e7c35229cfc3253828e2c2654) |
| **Compliance failure** — KYC revoked → settlement reverts, both ledgers unchanged | see [Verify it yourself](#verify-it-yourself) |
| **Off-market award refused** — 80.00 bid against a 98.35 NAV rejected on-chain | fair price settled in [`0x35d42fb4…8997`](https://hashscan.io/testnet/transaction/0x35d42fb4df4644771020f9118bd8e4e5a5f149c1698e27dbebb3d17e8fec8997) |
| **Dealer bond slashed** — to the seller, by the seller, venue gains nothing | [`0xf4d5a59b…6677`](https://hashscan.io/testnet/transaction/0xf4d5a59ba1d91f64d25457b71972d78f20272c5b92fec53044490853b6116677) |

---

## Verify it yourself

Every claim here is checkable without trusting us. These are read-only and need no keys.

**The audit trail is public. Commit hashes are timestamped before any price is readable:**

```bash
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10383803/messages?limit=12&order=asc" \
  | jq -r '.messages[] | "\(.sequence_number) \(.consensus_timestamp) \(.message|@base64d|fromjson|.kind)"'
```

You will see `QUOTE_COMMITTED` entries with sequence numbers **strictly lower** than every
`QUOTE_REVEALED`. No dealer could read a rival's price before sealing their own, and the
ordering is Hedera's, not ours.

**The bond is a real ATS security:**

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/0xD53072649037FEecD305920087791a37dF8D517F | jq '.contract_id'
```

**The cash is real Circle USDC, not a token we minted:**

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.429274 | jq '{symbol,name,decimals,treasury_account_id}'
# {"symbol":"USDC","name":"USD Coin","decimals":6,"treasury_account_id":"0.0.5176"}
```

Testnet has dozens of impostor tokens called USDC. This one is Circle's.

**The scheduled coupon exists and was created by the contract:**

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10384068 | jq '{schedule_id,creator_account_id,expiration_time,executed_timestamp}'
```

**And the failure paths, run against the live chain:**

```bash
npx tsx backend/src/scripts/failure-demo.ts   # KYC revoked -> revert, ledgers unchanged
npx tsx backend/src/scripts/oracle-demo.ts    # off-market award refused, fair one settles
npx tsx backend/src/scripts/bond-demo.ts      # honest dealer refunded, absent dealer slashed
```

Each prints before/after balances and exits non-zero if the property it asserts does not hold.

---

## How settlement works

```
1. The seller escrows a block with an ATS hold whose escrow agent is SottoSettlement.
   Available balance drops, held rises, TOTAL DOES NOT MOVE.
   The tokens never leave the seller's account. They stay the holder of record,
   keep earning coupons on the whole position, and remain subject to freeze
   and seizure by the issuer.

2. The RFQ opens. Dealers post a bond and submit
   keccak256(price, quantity, nonce, dealer).
   Only the hash reaches the ledger. Nobody - including the venue - can read a price.

3. The window closes on an HCS CONSENSUS timestamp, not on our clock.

4. Dealers reveal. Each reveal is recomputed against its commit and must match
   exactly. A dealer who never reveals forfeits their bond TO THE SELLER.
   Each reveal carries its own firmness deadline.

5. Best valid, still-firm price wins. Ties break on the earliest HCS sequence number.
   A price more than 5% from the reference NAV cannot be awarded.

6. Both parties sign an EIP-712 Trade. settle() then, in ONE transaction:
     verify both signatures, consume nonces
     check the NAV band
     check the hold: escrow == self, amount >= quantity, not expired
     transferFrom(buyer, seller, notional)     <- cash leg
     executeHoldByPartition(...)               <- security leg, ATS runs compliance
   Any failure reverts everything. Neither leg moves.
```

**If no award happens before expiry, anyone may call ATS's `reclaimHoldByPartition`
directly** — no venue code is involved. Sotto cannot trap collateral. If this venue vanished
tomorrow, every seller could still recover their tokens, and any passer-by could do it for
them.

---

## Two settlement paths

**Path A — EVM allowance (permissionless).** The buyer grants an ERC-20 allowance; `settle()`
pulls the cash and executes the hold in one EVM transaction. Atomicity comes from revert
semantics. **Anyone may relay a fully-signed Trade** — that is deliberate, and there is a test
asserting it.

**Path B — HIP-551 atomic batch (Hedera-only).**

```
BatchTransaction (batchKey = venue relayer)
  inner 1: TransferTransaction        cash buyer -> seller   [signed by the buyer]
  inner 2: ContractExecuteTransaction deliver(...)           <- must be LAST
```

Each party signs only its own leg. **No allowance anywhere.** The cash leg is a native HTS
transfer, not an ERC-20 facade call, and atomicity is provided by the network rather than by
the contract. EVM chains structurally cannot do this.

The network permits **at most one contract call per batch and it must be last**, which is why
Path A moves cash before delivery too — both paths then reason identically and tests transfer
between them. Measured calldata is 676 bytes against a 6 KB batch ceiling.

---

## What makes this a venue and not a swap

A swap contract does atomic A↔B. So does step 6 above. The difference is everything around it.

**The hold is encumbrance, not custody.** In a swap you send tokens *into* a contract and stop
being the holder. Here the tokens never move until settlement. The seller keeps earning
coupons on the full position while part of it is on offer, stays subject to the issuer's
freeze and seizure powers, and can be reclaimed by anyone if the venue disappears. No escrow
contract can say that.

**Price discovery, not price execution.** A swap executes a price you already agreed. Sotto
*finds* it — sealed commits, consensus-ordered, no last-look. Settlement is the last five
percent of the product.

**Compliance lives in the asset.** Revoking a buyer's KYC makes delivery revert. The venue
does not check a list; the token refuses the transfer. No swap venue can do this, because no
swap venue's asset carries a compliance engine.

**Any security for any other.** `cashToken` is just an address. The contract never assumed one
side was cash, so a bond settles against an equity with no stablecoin in the middle, through
the same `settle()` with no per-asset branch.

### Mechanism design

Three adversaries the design answers, none of which a swap has to think about:

**A dealer who last-looks off a rival's price.** Commit–reveal, ordered by consensus. The
audit trail is public, so the ordering is checkable by anyone.

**A dealer who spams the book with junk commits.** Committing requires a bond. Reveal
correctly and it returns; vanish and it is slashed **to the seller**. Slashing is
*permissionless* — anyone can trigger it once the window closes, so the seller never waits on
the venue — and the contract verifies the reveal itself, so the venue cannot slash whoever it
likes. The venue never receives a slash, so it has no incentive to design for failed reveals.

**A seller who awards themselves a bad price through a colluding dealer.** The auction was
fair; the price was not. Commit–reveal does nothing about this. A NAV band does: a trade more
than 5% from the reference cannot settle, enforced **in the settlement contract**, not in our
backend — a venue that only checks its own arithmetic is asking to be trusted.

**And a seller who sits on a quote waiting for the market to move.** Each reveal carries a
firmness deadline, defaulting to 30 minutes and capped independently of the RFQ window. That
deadline becomes the `Trade.deadline`, which is enforced on-chain — so a stale quote reverts
at the chain, not merely in our engine.

---

## Known limitations

We would rather write these down than have you find them.

**`deliver()` cannot introspect its batch siblings.** From inside the EVM there is no way to
verify that inner transaction 1 exists or that it succeeded. Path B relies entirely on batch
atomicity. A malicious assembler holding a valid signed Trade could call `deliver()` standalone
and take delivery without including the cash leg.

The mitigation is a role gate: `deliver()` requires `RELAYER_ROLE`, while `settle()` is
permissionless. **So the trustless path is the open one and the elegant path is the
permissioned one.** That is a real cost of Path B.

**Other limits, plainly:**

- The demo runs with backend-held keys. Wallet-signed flows (HashPack/Blade via Hedera
  WalletConnect, MetaMask via EIP-1193) are frontend work and are not yet wired. Nothing in
  the backend has to change for them: trade signing is ordinary EIP-712 and touches no ATS SDK.
- The ATS SDK has **no server-key path** — `SupportedWallets.CLIENT` is commented out and the
  only headless options are custodial. Sotto therefore calls `Factory.deployBond` directly
  with ethers rather than through the SDK.
- The NAV reference is published by an accountable publisher with a staleness bound, not read
  from a market feed. A bond's NAV is not on a crypto price oracle; it comes from an
  administrator, as it does in traditional markets. An `IPriceSource` seam exists for assets
  that *do* have a market price — Chainlink, Pyth and Supra are all live on Hedera.
- Hedera's Exchange Rate contract at `0x168` is **not** used as a price source. Its own
  documentation says it "should not be treated as a live price oracle" — it is the HBAR/USD
  rate the network uses to charge fees.
- Partial fills are not supported; a block is awarded whole. Real desks split blocks, and this
  is the most obvious next mechanism.
- Testnet resets periodically; balances are re-funded from the Circle and Hedera faucets.
- **There is no admin function anywhere in `SottoSettlement` that can move user funds.**
  `RELAYER_ROLE` gates `deliver()`. `setNavOracle` can only cause trades to be *refused*, never
  redirected — there is a test asserting exactly that.

---

## What we learned about ATS that is not in the docs

We built against the deployed factory rather than a local deployment, and hit several things
worth writing down. Full detail in [`docs/ATS-SPIKE.md`](docs/ATS-SPIKE.md). We reported the
most damaging one upstream:
[hashgraph/asset-tokenization-studio#1395](https://github.com/hashgraph/asset-tokenization-studio/pull/1395).

**The deployed factory is contract version 4.0.0 and `main` is not ABI-compatible with it.**
The proxy `0.0.7708432` still points at implementation `0.0.7708430` — never upgraded — while
`main` (contracts 8.0.0) reordered all 17 fields of `SecurityData`. Same fields, same types,
different order, so a different tuple and a different selector:

| `deployBond` field order | selector | in the deployed bytecode? |
|---|---|---|
| `main` / contracts 8.0.0 | `0x29002951` | **no** |
| releases v3.1.0 → v5.0.0 (bools first) | `0x5133f0e0` | **yes** |

The failure mode is `execution reverted` with **no data and no reason string**, identically for
every `configId`, because the proxy has no function to dispatch to. It looks exactly like a
wrong configuration and is not.

**Role hashes changed too, and that one fails silently.** `_ISSUER_ROLE` is `0x5eeaf560…` on
`main` and `0x4be32e88…` in the deployed version. Grants made with `main`'s constants land on
hashes the deployed contract never checks — so **`hasRole()` returns `true` while every
guarded call still reverts.** Only `DEFAULT_ADMIN_ROLE` (`0x00`) is stable, which is the only
reason it is repairable without redeploying.

**Other things the published docs do not say:**

- ATS's own SDK reference shows `configVersion: "0"`. Every registered configuration on
  testnet is at version **1**; `0` reverts with `ResolverProxyConfigurationNoRegistered`.
- `grantKyc` is gated by `onlyIssuerListed`, so the KYC issuer must first be registered via
  `addIssuer` — which needs `_SSI_MANAGER_ROLE`, a role the issuance `rbacs` array does not
  include. Without it every KYC grant reverts with no reason.
- ISINs are checksum-validated on-chain (ISO 6166). `XS0000000001` reverts.
- `balanceOf` returns **available**, not total. Total is `balanceOf + getHeldAmountFor`.
- Config ids do **not** follow the `SecurityType` enum order. `0x…01` is Equity, not
  BondVariableRate. We identified each empirically by probing its facet set.
- Hedera's published ATS documentation contains no contract API at all — the word "facet" does
  not appear. The source is the only authority.

**And one that is not ATS's fault but cost us an hour:**
`maxAutomaticTokenAssociations = -1` means *unlimited auto-association slots*, **not**
*pre-associated*. The Circle USDC faucet transfer is not eligible for auto-association, so
into an unassociated account the drip is silently lost — no error, no pending airdrop, no
transaction — and it still burns the faucet's 2-hour window.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js)                                                   │
│  Issuer │ Seller │ Dealer portals │ Settlement theatre                │
└──────────────┬───────────────────────────────────────────────────────┘
               │ REST + WebSocket (the wire contract, docs/BLUEPRINT.md §3)
               │ EIP-712 signing in-browser (wagmi/viem)
┌──────────────▼───────────────────────────────────────────────────────┐
│  BACKEND (Node 20, TypeScript, Fastify)                               │
│  RFQ engine   commit → reveal → award, on CONSENSUS time              │
│  HCS writer   every lifecycle event, sequence-numbered                │
│  Chain adapter  holds, balances, KYC, settlement                      │
│  Mirror poller  reconciles Settled events                             │
└──────────────┬───────────────────────────────────────────────────────┘
               │ ethers → Hedera JSON-RPC relay
┌──────────────▼───────────────────────────────────────────────────────┐
│  CONTRACTS (Solidity 0.8.24, Hardhat, evmVersion cancun)              │
│  SottoSettlement      atomic DvP, both paths, NAV band                │
│  SottoNavOracle       reference NAV + band, pluggable market source   │
│  SottoDealerBond      reveal-or-forfeit staking                       │
│  SottoCouponScheduler HIP-1215 on-chain lifecycle automation          │
└──────────────┬───────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│  HEDERA TESTNET                                                       │
│  ATS bond + equity (diamonds from factory 0.0.7708432)                │
│  Circle USDC 0.0.429274 │ HCS topic 0.0.10383803 │ HSS 0x16b          │
└──────────────────────────────────────────────────────────────────────┘
```

```
contracts/        4 contracts, interfaces, mocks, 23 tests
backend/src/
  chain/          ethers adapter for holds, balances, KYC, settlement
  hcs/            HCS audit writer
  rfq/            the RFQ state machine + 6 unit tests
  scripts/        deploy, seed, settle, batch, failure, oracle, bond demos
  server.ts       the live API
packages/shared/  the wire contract: types, EIP-712 domain, commit formula
docs/             BLUEPRINT.md · MECHANICS.md · ATS-SPIKE.md
```

`packages/shared` is imported by both the backend and the frontend. The commit formula and the
EIP-712 domain exist **once**, so a dealer's browser and the settlement contract cannot
disagree about what was signed.

---

## Running it

```bash
npm install
cp .env.example .env      # public addresses are pre-filled; add your keys
npm run build             # hardhat compile
npm test                  # 23 contract tests
npm run test:engine       # 6 RFQ engine tests
npm run serve             # the live API against testnet, port 4000
```

Scripts, in the order they were used:

```bash
npx tsx backend/src/scripts/associate.ts          # associate USDC BEFORE dripping it
npx tsx backend/src/scripts/deploy-bond.ts        # issue the bond from the ATS factory
npx tsx backend/src/scripts/deploy-equity.ts      # issue the equity
npx tsx backend/src/scripts/deploy-settlement.ts
npx tsx backend/src/scripts/deploy-oracle.ts      # NAV oracle + band-guarded settlement
npx tsx backend/src/scripts/seed.ts [equity]      # roles, SSI issuer, KYC, issuance
npx tsx backend/src/scripts/settle-e2e.ts         # Path A atomic DvP
npx tsx backend/src/scripts/settle-batch.ts       # Path B HIP-551 batch
npx tsx backend/src/scripts/settle-cross-asset.ts # bond ↔ equity, no stablecoin
npx tsx backend/src/scripts/rfq-demo.ts           # the full RFQ engine
npx tsx backend/src/scripts/hcs-demo.ts           # audit trail
npx tsx backend/src/scripts/failure-demo.ts       # KYC revoked → revert
npx tsx backend/src/scripts/oracle-demo.ts        # off-market award refused
npx tsx backend/src/scripts/bond-demo.ts          # reveal-or-forfeit
npx tsx backend/src/scripts/verify-sourcify.ts    # verify contracts
```

---

## Roadmap: CLPR

The natural next step is **cross-ledger DvP**, and Hedera is building the protocol for it.

[**CLPR**](https://hashgraph.com/clpr/) ("clipper") is a bridgeless cross-ledger protocol.
[HIP-1535](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-clpr.md)
was filed on 18 August 2026 by Richard Bair, Edward Wertz and Leemon Baird, and opened for
public contribution on 1 September. Its shape matters for a venue like this:

- **No bridge validator set, no pooled liquidity, no new token.** Each ledger verifies
  cryptographic proofs of the other's committed state using only the two ledgers' own
  consensus and finality guarantees. If both sides are ABFT, cross-ledger delivery inherits it.
- **Verification is delegated to a pluggable verifier contract** bound to a channel for its
  lifetime. Connecting a new ledger type takes a new verifier, not a protocol change.
- **Messages move in bundles relayed by permissionless endpoints.** On a Hiero network every
  consensus node is automatically one.
- **Execution on the destination ledger is paid for by connectors**, who front the cost and
  are **slashed for non-payment**, denominated in each ledger's native token.

Sotto is already shaped for it. The security leg is an encumbrance held *in place* on the
issuing ledger; the cash leg is a separate atomic unit. Split those across a CLPR channel and
you have cross-ledger delivery-versus-payment for block trades with no wrapped asset and no
bridge — a corporate bond settling against cash that never leaves its home ledger.

Two of our own mechanisms map directly onto open questions in the draft:

- **Connector slashing.** We shipped bonded commitment with permissionless slashing and
  proceeds to the injured party rather than the venue, precisely so the operator has no
  incentive to design for failures. The same question applies to CLPR connectors.
- **Encumbrance lifetime.** A hold binds an asset in place with an expiry that *anyone* may
  reclaim after. Across a channel, a bundle that never lands must not be able to trap a
  seller's collateral indefinitely.

**We have not built against CLPR and we are not claiming to have.** HIP-1535 is `status:
Draft` with an empty `release:` field, the CLPR Service requires consensus-node changes that
are not deployed, there is no SDK or testnet endpoint, and the specification itself still
carries open design issues. Every other claim in this README opens a transaction hash; this
one would not, so it stays a roadmap item.

---

## Licence

MIT.
