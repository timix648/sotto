# Sotto

**A request-for-quote block-trading venue for ATS-issued securities, on Hedera.**

Asset Tokenization Studio lets an issuer mint a compliant bond. It does not let anyone
*trade* one. Sotto is the missing secondary market: a bondholder puts size up for bid,
dealers compete under commit–reveal so nobody can last-look off a rival's price, and the
winning trade settles as a single atomic delivery-versus-payment transaction — security leg
and cash leg, both or neither.

Compliance is enforced by ATS at the transfer itself, not bolted on by the venue. Every
quote, award and fill is timestamped on the Hedera Consensus Service, so the venue is
auditable without being transparent while the auction is live.

---

## Live on Hedera testnet

| | |
|---|---|
| Bond (ATS diamond) | [`0xD53072649037FEecD305920087791a37dF8D517F`](https://hashscan.io/testnet/contract/0xD53072649037FEecD305920087791a37dF8D517F) |
| SottoSettlement | [`0x98164562Ac1A7005C5E0e00C1018669fc62843E8`](https://hashscan.io/testnet/contract/0x98164562Ac1A7005C5E0e00C1018669fc62843E8) |
| SottoCouponScheduler | [`0xb97BF0203d5C914d40100C12683B2ed257E9cEec`](https://hashscan.io/testnet/contract/0xb97BF0203d5C914d40100C12683B2ed257E9cEec) |
| HCS audit topic | [`0.0.10383803`](https://hashscan.io/testnet/topic/0.0.10383803) |
| Cash leg | **real Circle USDC** `0.0.429274` |

**Proven transactions, not screenshots:**

- Atomic DvP — [`0x4c90cf5b…52fd`](https://hashscan.io/testnet/transaction/0x4c90cf5b62ed65ebdabb7621bb76c80596cd78dc29cf2303c68b3ccbcab552fd) — 20 bonds ↔ 19.67 USDC, both legs, one transaction
- HIP-551 atomic batch — `0.0.10380177@1788646998.050909150` — three records, all SUCCESS
- HIP-1215 scheduled coupon — schedule `0.0.10384068`, created by the contract itself

Nothing here is mocked, and nothing was minted for convenience: the bond is issued from
Hedera's own deployed ATS factory `0.0.7708432`, and the cash leg is real Circle USDC.

---

## How settlement works

```
1. Seller escrows a block with an ATS hold whose escrow agent is SottoSettlement.
   Available balance drops, held rises, TOTAL DOES NOT MOVE.
   The seller keeps earning coupons on the whole position.

2. RFQ opens. Dealers submit keccak256(price, quantity, nonce, dealer).
   Only the hash reaches the ledger. Nobody - including the venue - can read a price.

3. Window closes on an HCS CONSENSUS timestamp, not on our clock.

4. Dealers reveal. Each reveal is recomputed against its commit and must match
   exactly. A dealer who cannot produce a matching reveal forfeits.

5. Best valid revealed price wins. Ties break on the earliest HCS sequence number.

6. Both parties sign an EIP-712 Trade. settle() then, in ONE transaction:
     verify both signatures, consume nonces
     check the hold: escrow == self, amount >= quantity, not expired
     transferFrom(buyer, seller, notional)          <- cash leg
     executeHoldByPartition(...)                    <- security leg, ATS runs compliance
   Any failure reverts everything. Neither leg moves.
```

If no award happens before expiry, **anyone** may call ATS's `reclaimHoldByPartition`
directly — no venue code is involved. Sotto cannot trap collateral. If this venue vanished
tomorrow, every seller could still recover their tokens.

---

## Two settlement paths

**Path A — EVM allowance (permissionless).** The buyer grants an ERC-20 allowance; `settle()`
pulls the cash and executes the hold in one EVM transaction. Atomicity comes from revert
semantics. Anyone may relay a fully-signed Trade — that is deliberate.

**Path B — HIP-551 atomic batch (Hedera-only).**

```
BatchTransaction (batchKey = venue relayer)
  inner 1: TransferTransaction        cash buyer -> seller   [signed by the buyer]
  inner 2: ContractExecuteTransaction deliver(...)           <- must be LAST
```

Each party signs only its own leg. No allowance anywhere. The cash leg is a **native HTS
transfer**, not an ERC-20 facade call, and atomicity is provided by the network rather than
by the contract. EVM chains structurally cannot do this.

---

## Known limitations

**`deliver()` cannot introspect its batch siblings.** From inside the EVM there is no way to
verify that inner transaction 1 exists or that it succeeded. Path B relies entirely on batch
atomicity. A malicious assembler holding a valid signed Trade could therefore call
`deliver()` standalone and take delivery without including the cash leg.

The mitigation is a role gate: `deliver()` requires `RELAYER_ROLE`, while `settle()` (Path A)
is permissionless. **So the trustless path is the open one and the elegant path is the
permissioned one.** That is a real cost of Path B, and we would rather write it down than
have you find it.

**Other limits, stated plainly:**

- The demo runs with backend-held keys. Wallet-signed flows (HashPack/Blade via Hedera
  WalletConnect, MetaMask via EIP-1193) are frontend work and are not yet wired.
- The ATS SDK has **no server-key path** — `SupportedWallets.CLIENT` is commented out and the
  only headless options are custodial. Sotto therefore calls `Factory.deployBond` directly
  with ethers rather than through the SDK.
- Testnet resets periodically; balances are re-funded from the Circle and Hedera faucets.
- There is no admin function anywhere in `SottoSettlement` that can move user funds.
  `RELAYER_ROLE` gates `deliver()` and nothing else.

---

## What we learned about ATS that is not in the docs

We built against the deployed factory rather than a local deployment, and hit several things
worth writing down. Full detail in [`docs/ATS-SPIKE.md`](docs/ATS-SPIKE.md).

**The deployed factory is contract version 4.0.0 (January 2026) and `main` is not
ABI-compatible with it.** The proxy `0.0.7708432` still points at implementation
`0.0.7708430` — never upgraded — while `main` (contracts 8.0.0) reordered all 17 fields of
`SecurityData`. Same fields, same types, different order, so a different tuple and a
different selector:

| `deployBond` field order | selector | in the deployed bytecode? |
|---|---|---|
| `main` / contracts 8.0.0 | `0x29002951` | **no** |
| releases v3.1.0 → v5.0.0 (bools first) | `0x5133f0e0` | **yes** |

The bools-first layout is stable across `v3.1.0-ats`, `v4.1.0-ats` and `v5.0.0-ats`, so the
deployed 4.0.0 uses it; the reorder landed somewhere between v5 and v8.

The failure mode is `execution reverted` with **no data and no reason string**, identical for
every `configId`, because the proxy has no function to dispatch to. It looks exactly like a
wrong configuration and is not.

**Role hashes changed too, and that one fails silently.** `_ISSUER_ROLE` is `0x5eeaf560…` at
HEAD and `0x4be32e88…` at v3.1.0. Grants made with HEAD's constants land on hashes the
deployed contract never checks — so `hasRole()` returns **true** while every guarded call
still reverts. Only `DEFAULT_ADMIN_ROLE` (`0x00`) is stable, which is the only reason it is
repairable without redeploying.

**Other things the published docs do not say:**

- ATS's own SDK reference shows `configVersion: "0"`. Every registered configuration on
  testnet is at version **1**; `0` reverts with `ResolverProxyConfigurationNoRegistered`.
- `grantKyc` is gated by `onlyIssuerListed`, so the KYC issuer must first be registered via
  `addIssuer` — which needs `_SSI_MANAGER_ROLE`, a role the issuance `rbacs` array does not
  include. Without it every KYC grant reverts with no reason.
- ISINs are checksum-validated on-chain (ISO 6166). `XS0000000001` reverts.
- `balanceOf` returns **available**, not total. Total is `balanceOf + getHeldAmountFor`.
- Hedera's published ATS documentation contains no contract API at all — the word "facet"
  does not appear. The source is the only authority.

---

## Repository layout

```
contracts/        SottoSettlement.sol, SottoCouponScheduler.sol, interfaces, mocks, tests
backend/src/
  chain/          ethers adapter for the bond, settlement and cash legs
  hcs/            HCS audit writer
  rfq/            the RFQ state machine (commit -> reveal -> award)
  mock/           fixture server, full API surface, 90s scripted RFQ
  scripts/        deploy, seed, settle, batch-settle, failure demo, HCS demo
  server.ts       the live API
packages/shared/  the wire contract: types, EIP-712 domain, commit formula
docs/             BLUEPRINT.md, MECHANICS.md, ATS-SPIKE.md
```

## Running it

```bash
npm install
cp .env.example .env          # then fill in keys and addresses
npm run build                 # hardhat compile
npm test                      # 11 contract tests
npm run mock                  # fixture server on :4000, scripted RFQ every 90s
npm run serve                 # the live API against testnet
```

Scripts, in the order they were used:

```bash
npx tsx backend/src/scripts/associate.ts        # associate USDC (see below)
npx tsx backend/src/scripts/deploy-bond.ts      # issue the bond from the ATS factory
npx tsx backend/src/scripts/deploy-settlement.ts
npx tsx backend/src/scripts/seed.ts             # roles, SSI issuer, KYC, issuance
npx tsx backend/src/scripts/settle-e2e.ts       # Path A atomic DvP
npx tsx backend/src/scripts/settle-batch.ts     # Path B HIP-551 batch
npx tsx backend/src/scripts/failure-demo.ts     # KYC revoked -> revert, ledgers unchanged
npx tsx backend/src/scripts/hcs-demo.ts         # audit trail
npx tsx backend/src/scripts/rfq-demo.ts         # full RFQ engine end to end
```

**A trap worth repeating:** `maxAutomaticTokenAssociations = -1` means *unlimited
auto-association slots*, **not** *pre-associated*. The Circle USDC faucet transfer is not
eligible for auto-association, so into an unassociated account the drip is silently lost —
no error, no pending airdrop, no transaction — and it still burns the faucet's 2-hour window.
Run `associate.ts` first.

## Roadmap

**CLPR / Clipper**, the cross-ledger protocol HIP currently open for comment, would let the
cash leg settle on one ledger and the security leg on another with no bridge validator set
and no wrapped asset — cross-ledger DvP for block trades. That is the natural next step for a
venue built on hold-plus-batch settlement.

## Licence

MIT.
