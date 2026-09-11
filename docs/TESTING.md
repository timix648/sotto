# Sotto — full test guide

**Test the whole venue yourself, both settlement paths, end to end.**

Written 11 September 2026 · Repo: **https://github.com/timix648/sotto**

This guide has two halves:

- **Part 1 — Before you start.** Wallets, extensions, test tokens. **None of this is
  Sotto's code.** It is the Hedera testnet environment that every dApp needs, and it
  takes about 20 minutes the first time. Do it before you sit down to test.
- **Part 2 — Testing Sotto.** The actual product, click by click, including both
  settlement paths and both deliberate failure demonstrations.

Everything below is **testnet**. Testnet HBAR and testnet USDC have no financial value.
Even so: never paste a private key into a screen recording, an issue or a commit.

---

# Part 1 — Before you start

*Environment setup. Not Sotto. Do this first.*

## 1.1 What you are setting up, and why

Sotto is a trading venue with three roles. To test it properly you act as two
counterparties, so you need **two wallets that can hold Hedera testnet assets**.

| Role | Wallet | Why that one |
|---|---|---|
| **Seller** | OKX or MetaMask | Only needs EVM. Places the hold, signs the trade |
| **Dealer** | **HashPack** | Needs EVM **and** Hedera-native (HIP-820). Only a native wallet can sign the Path B cash leg, and only a native wallet can associate a token |
| Issuer | none | Runs on the venue's own key |

**OKX cannot be the dealer.** It gives you a Hedera *EVM* account, which is fine for
signing, but it cannot establish the HIP-820 native session Path B needs, and it cannot
associate an HTS token. That is a property of the wallet, not of Sotto.

## 1.2 Install the wallets

Install from the official page only — never from a search advert, a forwarded APK or an
unofficial extension listing.

| Wallet | Download |
|---|---|
| **HashPack** (dealer — required) | [official download guide](https://hashpackapp.zendesk.com/hc/en-us/articles/17624331055633-Download-HashPack-for-desktop-and-mobile) |
| **OKX Wallet** (seller) | [web3.okx.com/download](https://web3.okx.com/download) |
| **MetaMask** (seller alternative) | [metamask.io/download](https://metamask.io/download/) |

## 1.3 Get a Hedera testnet account

Mainnet and testnet are **separate ledgers with separate account numbers**. A mainnet
account ID is useless here. If HashPack shows an account without a red *Testnet* banner,
you are on the wrong network.

1. Go to **[portal.hedera.com](https://portal.hedera.com/)** and sign in.
2. Create a **Testnet** account with an **ECDSA** key. You get an account ID, a private
   key, and **1000 HBAR**.
3. In HashPack, switch to **Testnet**, then *Import account* and paste the **HEX encoded
   private key** from the portal.
4. Confirm HashPack shows the red **Testnet** banner and roughly 1000 ℏ.

The portal's **Refill** button tops you back up to 1000 ℏ when you run low. You do not
need to press it on a fresh account.

## 1.4 Associate USDC on the dealer wallet

**Do this before anyone sends you USDC.** On Hedera an account must be *associated* with
a token before it can hold it. Send USDC to an unassociated account and it **vanishes
silently** — no error, no bounce, no pending transfer.

In HashPack (Testnet) → **Add Token** → paste:

```
0.0.429274
```

That is Circle's real testnet USDC. Testnet has dozens of impostor tokens with the same
name; this is the one with `treasury_account_id: 0.0.5176`, which you can check yourself:

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.429274 | jq '{symbol,name,treasury_account_id}'
```

The seller wallet does **not** need this step. An EVM account created by receiving HBAR
gets unlimited auto-association slots, and an ordinary transfer associates it on arrival.
Only the dealer, which must *hold* USDC in order to spend it, needs the explicit step.

## 1.5 Get testnet funds

| What | Where | Notes |
|---|---|---|
| **HBAR** | [portal.hedera.com/faucet](https://portal.hedera.com/faucet) | Gas. Both wallets need some |
| **USDC** | [faucet.circle.com](https://faucet.circle.com/) | Choose **Hedera Testnet**. Associate first (§1.4) |

If you are testing against a venue someone else is running, send them your two addresses
and ask them to fund and KYC you instead — issuing and KYC are issuer actions, not
something a visitor can do for themselves.

## 1.6 A Reown project ID

Only needed if you are running the frontend yourself. The wallet selector will not open
without one.

1. [dashboard.reown.com](https://dashboard.reown.com/) → create a project
2. Copy the **Project ID**
3. Put it in `frontend/.env.local` as `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`

## 1.7 Known wallet quirk — read this one

**HashPack's direct "connect" button can hand back an EVM session when you asked for a
native one.** This is an upstream bug, not a Sotto bug:
[hedera-wallet-connect#670](https://github.com/hashgraph/hedera-wallet-connect/issues/670).

Symptom: everything appears to connect, but Path B reports no native session.

**Always connect HashPack through the WalletConnect QR / deep-link route.**

## 1.8 Setup checklist

- [ ] HashPack installed, on **Testnet**, red banner visible
- [ ] Testnet account imported, ~1000 ℏ
- [ ] USDC `0.0.429274` **associated** in HashPack
- [ ] OKX (or MetaMask) installed with an account
- [ ] Reown project ID in `frontend/.env.local` *(only if running it yourself)*
- [ ] Both addresses sent to whoever runs the venue, for funding and KYC

---

# Part 2 — Testing Sotto

*This is the product.*

## 2.1 Start it

```bash
git clone https://github.com/timix648/sotto.git
cd sotto
npm install                      # from the ROOT, not from frontend/
cp .env.example .env             # public addresses pre-filled; keys from Timi
cp frontend/.env.example frontend/.env.local
npm run build                    # hardhat compile
```

Two terminals:

```bash
npm run serve          # the live API against Hedera testnet, port 4000
```

```bash
npm run dev:frontend   # the venue, port 3000
```

**Before anything else**, confirm you are on the live chain and not fixtures:

```bash
curl -s localhost:4000/api/health | jq '{mock, blockHeight}'
```

`mock` **must** be `false`. If it says `true` you are talking to the fixture server on
port 4010 and nothing you see is real.

Open **http://localhost:3000**. The first load of `/dealer` and `/enter` takes a while —
Next.js compiles them on demand and they pull the whole wallet stack. That is dev mode,
not a hang.

### Use two browser windows

You are playing two counterparties. One window connected as **seller** (OKX), one as
**dealer** (HashPack) — separate browser profiles work best. It also gives you the
side-by-side view of both ledgers moving, which is the most convincing thing in the demo.

## 2.2 Check the reference price first

`/issuer` → **Reference NAV**.

If it says **stale**, click **Publish NAV**. The settlement band refuses a reference older
than 24 hours, so a stale one makes every settlement revert — correctly, but with an
unhelpful on-chain message. Publishing takes one click.

This is a real control doing its job. A venue that traded against a day-old price would be
the bug.

## 2.3 The main flow — Path A

Path A settles through an ERC-20 allowance. Broad wallet support, and anyone can submit
the fully-signed trade.

| # | Screen | Who | Action |
|---|---|---|---|
| 1 | `/enter` | OKX | Connect, choose **Seller** |
| 2 | `/seller` | OKX | Open an RFQ for ~20 units |
| 3 | `/seller` | OKX | **Escrow the block** — approve the wallet transaction |
| 4 | `/enter` | HashPack | Other window: connect, choose **Dealer** |
| 5 | `/dealer` | HashPack | Enter a price **and a size** (try 12 of the 20), commit |
| 6 | `/dealer` | — | Close the window, then **Reveal** |
| 7 | `/seller` | OKX | **Award** — one signature per fill |
| 8 | `/dealer` | HashPack | **Approve** the exact USDC, then **Sign and settle** |

### Watch for these

**Step 3 — the position card.** Available drops, Held rises, **Total does not move**.
That is the whole difference between this and an escrow swap: the seller never stops being
the holder of record and keeps earning coupons on the full position.

**Step 5 — the size is sealed with the price.** The nonce lives only in that browser. A
dealer who loses it cannot reveal, and forfeits. That is the mechanism, not a bug.

**Step 7 — partial fills.** Quote for less than the block and the seller's screen shows
the ladder: who got what, at what price, and how many units went unfilled. Each dealer
pays **its own price**, never a blended one.

**Step 8 — open `/rfq/[id]`.** Both ledgers move in the same instant. That simultaneity
is the product.

## 2.4 The same flow — Path B

Path B grants **no allowance anywhere**. The dealer signs a native HTS transfer of their
own cash, the venue signs delivery, and the network guarantees both legs or neither. EVM
chains structurally cannot do this.

Steps 1–7 are **identical**. Two differences before you start:

- On `/enter`, switch the **settlement route** to **Path B**
- Connect HashPack via **WalletConnect QR**, not the direct button (§1.7)

Then step 8 differs:

| | Path A | Path B |
|---|---|---|
| Approve USDC | yes, exact notional | **no step at all** |
| Signatures | 1 — EIP-712 Trade | **2** — EIP-712 Trade, then the native cash leg |
| Wallet | any EVM | EVM **and** HIP-820 — HashPack gives both |
| Atomicity from | contract revert | the network |

Expect **two wallet prompts**: the first is the trade, the second is your own cash.

> **Status, honestly.** Path B is fully wired in the browser, and the venue side is covered
> by nine offline tests that check the signed cash leg against the trade. What nobody has
> confirmed yet is whether HashPack honours `hedera_signTransaction` for a batch inner
> transaction. If it refuses, the portal says so plainly rather than failing mysteriously,
> and `backend/src/scripts/settle-batch.ts` proves the same settlement with no wallet
> involved at all. **If you are the first to try it, please report exactly what you see.**

## 2.5 The failure demonstration

The most important thing in the product, and entirely clickable.

1. `/issuer` → **Compliance — KYC** → select the dealer → **Revoke KYC**
2. Run another RFQ through to the settle step
3. Watch it **revert**

Then check both ledgers: **nothing moved**. Not the cash, not the bond. The venue did not
refuse it — the *token* refused it, inside `executeHoldByPartition`. Compliance lives in
the asset, not in our code.

**Grant KYC again afterwards** or nothing else will settle.

## 2.6 Redemption at maturity

`/issuer` → **Redemption at maturity**, at the bottom of the page.

1. **Issue 10 units** of the short-dated note
2. **Redeem at maturity** — principal is paid in USDC first, *then* the units are burned

Paying first is deliberate: ATS burns units and does not move money, so a holder who has
not been paid still holds their claim.

The panel refuses the burn if the issuer cannot cover the principal, and says so. Before
maturity it shows a countdown and explains that the chain itself refuses an early
redemption with `BondMaturityDateWrong()` — maturity is a contract gate, not a backend
convention.

## 2.7 Worth a look

| Screen | Why |
|---|---|
| `/rulebook` | Commit–reveal, holds, compliance at transfer, both settlement paths |
| `/audit` | The HCS trail. Every commit's sequence number is **lower** than every reveal's — nobody could read a rival's price before sealing their own, and the ordering is Hedera's, not ours |
| `/` | A sealed-quote demo you can play with before connecting anything |

## 2.8 Verify it without trusting the UI

Read-only, no keys needed:

```bash
# The audit trail is public and consensus-ordered
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10383803/messages?limit=12&order=asc" \
  | jq -r '.messages[] | "\(.sequence_number) \(.message|@base64d|fromjson|.kind)"'

# The cash is real Circle USDC, not something we minted
curl -s https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.429274 \
  | jq '{symbol,name,decimals,treasury_account_id}'

# The bond is a real ATS security
curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/0xD53072649037FEecD305920087791a37dF8D517F \
  | jq '.contract_id'
```

All five Sotto contracts are verified on Sourcify as `exact_match`, so HashScan shows the
source that actually ran.

## 2.9 The chain-proven scripts

Every demo script prints before/after balances and **exits non-zero if the property it
asserts does not hold**. They are runnable assertions, not illustrations.

```bash
npx tsx backend/src/scripts/settle-e2e.ts          # Path A atomic DvP
npx tsx backend/src/scripts/settle-batch.ts        # Path B HIP-551 batch, no wallet needed
npx tsx backend/src/scripts/partial-fill-demo.ts   # one block, several dealers
npx tsx backend/src/scripts/failure-demo.ts        # KYC revoked -> revert
npx tsx backend/src/scripts/oracle-demo.ts         # off-market award refused
npx tsx backend/src/scripts/bond-demo.ts           # reveal-or-forfeit
npx tsx backend/src/scripts/redeem-demo.ts         # redemption at maturity
```

And the suites:

```bash
npm test               # 32 contract tests
npm run test:engine    # 14 RFQ engine tests
npm run test:batch     #  9 Path B cash-leg verification tests
npm run test:frontend  # 12 formatting tests
```

---

# Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/api/health` says `mock: true` | You are on the fixture server (port 4010). Point at 4000 |
| Settlement reverts with no useful message | Reference NAV is stale. `/issuer` → **Publish NAV** |
| USDC sent but never arrived | Destination was not associated. §1.4. It is gone; there is no bounce |
| Wallet connects, Path B says no native session | HashPack gave an EVM session. Use the WalletConnect QR, not the direct button (§1.7) |
| OKX connects but native methods fail | Expected. OKX is EVM-only on Hedera — use it for the seller |
| Settle button greyed out | No wallet connected (a demo desk is read-only for signing), or the seller has not signed yet, or on Path B the native session is missing |
| "Transaction sent in incorrect format" | SDK mismatch — the transaction must be built with `@hiero-ledger/sdk` |
| Dealer cannot reveal | The nonce is gone. It only ever existed in that browser. The quote is forfeit — that is the mechanism |
| A dealer was skipped in the allocation | Either someone bid better, or that dealer was all-or-none and less than their minimum was left |
| Wallet asks to add a network | Hedera testnet, chain ID **296**, RPC `https://testnet.hashio.io/api` |
| Balances look wrong after several runs | The desk drains: cash flows dealer→seller, units flow seller→dealer. Ask for a rebalance |
| Account not found on testnet | Mainnet and testnet are separate ledgers. §1.3 |
| `/dealer` or `/enter` takes ages on first load | Dev-mode on-demand compilation of the wallet stack. Normal |

---

# Reference

## Deployed on Hedera testnet

| | |
|---|---|
| Bond `STO-BOND-A` | `0xD53072649037FEecD305920087791a37dF8D517F` |
| Equity `STO-EQ-A` | `0x21C3E7368a77756E896D58a6f97C3099Cc9C47e0` |
| Short note `STO-BOND-M` | `0x9c4e704b27dda83566d6f9ce0A2b1418b2249f14` |
| `SottoSettlement` | `0x73195C1f91899Bc1E822bb1D039033Eb38926931` |
| `SottoNavOracle` | `0xe8E7c39ba776C3B0778BE4571e72F5669f662c04` |
| `SottoDealerBond` | `0xea7545EC3C5E74e0A44f8c289a657b6D849227E5` |
| `ChainlinkPriceSource` | `0xFb321627eC70D7E86D82F80553dC2eC98BEb124a` |
| `SottoCouponScheduler` | `0xe23f19786E146fADdBd6b3EEa9994e9feC0cf847` |
| HCS audit topic | `0.0.10383803` |
| Cash | Circle USDC `0.0.429274` → `0x…068cDa`, 6 dp |
| ATS factory (Hedera's) | `0.0.7708432` |

**Never hardcode these.** `GET /api/health` returns the live set; two have been redeployed
during the build, so any older copy is wrong.

## Further reading

| | |
|---|---|
| `README.md` | What Sotto is, every claim with a HashScan link, and honest limitations |
| `docs/BLUEPRINT.md` | The wire contract (§3) and the screens (§5) |
| `docs/MECHANICS.md` | Roles, invariants, and a catalogue of real failure modes |
| `docs/ATS-SPIKE.md` | What ATS actually does, including several things its docs do not say |
