# Sotto — frontend handover

You own `/frontend` and nothing else. The backend, the contracts and the wire
contract already exist and are live on Hedera testnet. Your job is the face.

Read in this order: **this file → `docs/BLUEPRINT.md` §3 and §5 → `docs/MECHANICS.md` §4.**

---

## 1. Set up the Hedera docs MCP (5 minutes, do it first)

Without it an agent will invent Hedera SDK method names, and they look completely
plausible when it does. ATS, HIP-1215 and HIP-551 are all recent enough that this
happens constantly.

**Step 1 — put `.mcp.json` in the repo root.** It is in this folder. It belongs
beside `package.json`, not in `docs/`.

Windows hides known extensions, so a file saved from Notepad as `.mcp.json` is
very often really `.mcp.json.txt` and Explorer will show it to you as
`.mcp.json`. Check from a terminal:

```bash
cd C:\path\to\sotto
Get-ChildItem -Force -Name          # must show exactly: .mcp.json
```

If it is wrong: `Rename-Item ".mcp.json.txt" ".mcp.json"`

**Step 2 — open the Sotto repo root as your project** and start a NEW session.
Old sessions carry the old working directory and will not see the config.

Known quirk: some versions of the desktop app ignore the folder you pick and
reuse the last one. If step 3 shows no server, that is almost always why. The
terminal never gets this wrong:

```bash
cd C:\path\to\sotto
claude
```

**Step 3 — approve and verify.** Type `/mcp` in the session. You want:

```
hedera-docs   ... Connected
```

- *Pending approval* → run `/mcp` and approve
- *Failed to connect* → typo or whitespace in the URL; check internet
- *No MCP servers configured* → you are in the wrong folder

**Step 4 — prove it works.** Ask:

> Use the hedera-docs server to look up the Hedera Schedule Service system
> contract at 0x16b and HIP-1215. Do not answer from memory.

The output must contain a tool call labelled `hedera-docs`. If it answers with no
labelled tool call, it answered from training data and the server is not wired up.

**Do NOT test with an ATS question.** The MCP genuinely contains no ATS contract
documentation, so an ATS query returns nothing and looks like a broken connection
when the connection is fine.

Notes: `.mcp.json` is read at session start only — edit it, restart the session.
Rate limit is 200 requests/hour per IP, shared if two people are on one
connection. If doc searches start failing mid-build, back off rather than debug.

### Plugins (optional for frontend)

`/plugin` is a terminal command, not a desktop-app one. The CLI and app share
state, so install once and restart your session:

```bash
claude plugin marketplace add hedera-dev/hedera-skills
claude plugin install native-services-js@hedera-skills
```

The backend needed `system-contracts`; you probably do not.

---

## 2. What already exists — do not rebuild any of it

Live on Hedera testnet, all verified on Sourcify as `exact_match`:

| | |
|---|---|
| Bond `STO-BOND-A` | `0xD53072649037FEecD305920087791a37dF8D517F` |
| Equity `STO-EQ-A` | `0x21C3E7368a77756E896D58a6f97C3099Cc9C47e0` |
| SottoSettlement | `0x73195C1f91899Bc1E822bb1D039033Eb38926931` |
| SottoNavOracle | `0xe8E7c39ba776C3B0778BE4571e72F5669f662c04` |
| SottoDealerBond | `0x192565BD006c559afFe12B4eAD0Cd749581702aF` |
| SottoCouponScheduler | `0xb97BF0203d5C914d40100C12683B2ed257E9cEec` |
| HCS audit topic | `0.0.10383803` |
| Cash | real Circle USDC `0.0.429274` → EVM `0x0000000000000000000000000000000000068cDa`, **6 dp** |

**Never hardcode these.** `GET /api/health` returns all of them.

Working end to end on testnet already: atomic DvP both ways (EVM allowance and
HIP-551 batch), commit–reveal RFQ, HCS audit trail, a KYC-revoked settlement that
reverts with both ledgers unchanged, on-chain scheduled coupons, security-for-
security settlement with no stablecoin, an off-market award refused by the NAV
band, and a dealer bond slashed to the seller.

---

## 3. The API

```bash
npm install
npm run serve      # live API against testnet, port 4000
```

Full surface in `docs/BLUEPRINT.md` §3.4 (REST), §3.5 (WebSocket), §3.6 (errors).
That section is the **wire contract** and it is frozen — if something in it looks
wrong, say so, do not change it unilaterally.

`wire-contract/` in this folder holds the exact types, the EIP-712 domain and the
commit formula. Import them; do not retype them. The contract verifies signatures
against precisely those fields.

### A change landed after the blueprint was written

`QuoteReveal` gained **`validUntil`** — a unix second saying how long that
dealer's price stays firm, measured from the reveal's own HCS consensus
timestamp. Defaults to 30 minutes, capped independently of the RFQ window.

Show it. A dealer's quote going stale is a real state the UI has to express, and
the award button must disable when every quote is past its firmness.

---

## 4. Traps that will cost you hours if you meet them cold

**`balanceOf` returns AVAILABLE, not total.** Total is
`balanceOf + getHeldAmountFor`. Use `GET /api/balances/:account`, which returns
all four numbers already computed. If you call `balanceOf` yourself, placing a
hold looks like the seller *lost* tokens — and B2's whole animation depends on
total staying still while available drops and held rises.

**TypeScript 7 breaks ts-node-based tooling.** `npm i -D typescript` now installs
7.x, whose compiler API ts-node cannot read; you get
`Cannot read properties of undefined (reading 'fileExists')`. Pin
`typescript@^5.6`.

**viem rejects non-EIP-55-checksummed addresses at encode time.** Run every
hardcoded address through `getAddress()`.

**The mock server is on port 4010, the live API on 4000.** They used to share
4000 and the mock silently shadowed the live API — `/api/health` answered
`mock: true` with fixture addresses while we believed we were reading the chain.
**Check `mock: false` before you film anything.**

**Restart the API after `.env` changes.** Env is read at boot; a stale process
will report old contract addresses.

---

## 5. Wallets

Use existing libraries. Nothing here needs writing from scratch.

- HashPack / Blade → `@hashgraph/hedera-wallet-connect` (Hedera WalletConnect
  2.0). Needs a projectId from cloud.walletconnect.com.
- MetaMask → wagmi's injected connector, chainId `296`.
- EIP-712 signing → `signTypedData` with the domain from `wire-contract/eip712.ts`.

The ATS SDK's lack of a server-key path blocks **issuance only**. Trade signing
and bid submission touch no ATS SDK at all — they are ordinary EIP-712 signatures
and HTS transfers. The contract does not care where a signature came from:
today's settlements are signed by `ethers.Wallet`, and a HashPack signature over
the same typed data recovers to the same address. **Nothing in the backend
changes when you add wallets.**

Worth testing on day 1: whether a browser wallet will sign an inner transaction
carrying a `batchKey` (the HIP-551 path). If it will not, the allowance path
stays wallet-signed and the batch path runs with backend keys for the video — say
so on camera rather than hiding it.

`docs/MECHANICS.md` §4 has a lot of hard-won wallet material — rate limits on
wallet-hosted APIs, CIP-0103 discovery, session restore, provider fallback. Read
it before starting wallet work, not after.

---

## 6. What to build

`docs/BLUEPRINT.md` §5, in order: B0 foundation, B1 issuer portal, B2 seller
portal, B3 dealer portal, B4 settlement theatre, B5 failure view, B6 visual
direction.

Two things carry the whole demo:

- **B2's balance card** — Total / Available / Held / Locked as four numbers,
  animated so that when a hold is placed Available drops and Held rises **while
  Total does not move**. That single animation explains the hold primitive with
  no narration.
- **B4's dual ledger** — seller and buyer side by side, both updating in the same
  instant on settlement. The simultaneity *is* the product.

Visual direction is B6: dark, dense, instrument-panel. Tabular numerals
everywhere so figures do not jitter on update. Monospace truncated addresses with
click-to-copy. No gradient hero, no illustration. It should look like something a
trading desk would tolerate.

---

## 7. About `docs/MECHANICS.md`

This is the domain reference — roles, the RFQ state machine, invariants, and a
catalogue of failure modes from running a similar venue live on another ledger.
§4 is the payload; several of its entries are UI failures that made working
settlements *look* broken (a receipt telling the user they would receive nothing,
a live price rendering as `0.0000`, an unkillable error banner, a successful
settlement displayed as a failure).

**You will not be given the original repository.** It is private, and it is in
Daml, which does not translate to anything you are building. Everything relevant
has been extracted into this document. If you find something missing from it,
ask — the answer is to extend MECHANICS.md, not to open the old repo.
