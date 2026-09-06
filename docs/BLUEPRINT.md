# Sotto — Hedera Build Blueprint

**Target:** ETHOnline 2026 → Hedera → Tokenization of Anything ($6,000, up to 3 teams at $2,000)
**Window:** 4–16 September 2026. Effective build window from 5 Sept: 9 days + 2 days for video and submission.
**Network:** Hedera Testnet
**Repo:** public, MIT/Apache-2.0

**How to use this document.** It exists in two formats with identical content. The `.docx` is for humans — read it, print it, mark it up. The `.md` is for the agents: commit it to the repo as `docs/BLUEPRINT.md` and point both Claude Code sessions at that path. Do not paste the `.docx` into an agent's context; it is a zip of XML and it mangles the code blocks.

---

## 0. One-paragraph pitch

ATS lets an issuer mint a compliant bond. It does not let anyone *trade* one. Sotto is the missing secondary market: a request-for-quote block-trading venue where a bondholder puts size up for bid, dealers compete under commit–reveal so nobody can last-look off a rival's price, and the winning trade settles as a single atomic delivery-versus-payment transaction — security leg and cash leg, both or neither. Compliance is enforced by ATS at the transfer itself, not bolted on by the venue. Every quote, award and fill is timestamped on the Hedera Consensus Service, so the venue is auditable without being transparent while the auction is live. Coupons and maturity redemption are scheduled by the contract itself using HIP-1215 on-chain scheduled calls.

---

## 0.1 The name, and what is and isn't inherited

**Sotto.** From *sotto voce* — in a low voice. A block trade is negotiated quietly and printed loudly, which is exactly what the commit–reveal RFQ does. Short, unclaimed, and it does not collide with the Canton project.

Contracts are `SottoSettlement.sol` and `SottoCouponScheduler.sol`. The demo bond is `STO-BOND-A`. Run a quick search and a domain check before committing to it; two backups that fit the same register are **Cairn** (a stacked marker left as proof of passage — fits the HCS audit trail) and **Halyard** (the line that raises a signal flag).

**Sotto is not Umbra ported.** Be precise about this, in the README and on camera, because a judge who finds the Canton repo and thinks you resubmitted an old project will mark you down for it.

| Inherited from Umbra | Not inherited |
|---|---|
| The thesis: block trades need bilateral negotiation and atomic settlement, not an order book | Any line of code — Daml does not translate to Solidity |
| The RFQ lifecycle and role model (issuer, holder/seller, dealer, venue) | The privacy model — Canton has native sub-transaction privacy, Hedera does not |
| Hard-won invariants and failure modes from running it live | The settlement mechanism — `prepareSignExecuteMulti` becomes ATS holds + HIP-551 batches |
| The judgement about what a settlement demo has to show | The frontend — Canton portal components carry Daml-shaped data assumptions |

Umbra is prior art you wrote. Sotto is a new build on a different ledger with a different settlement primitive. That is a strength — say it plainly rather than hiding the lineage.

---

## 0.2 Day zero — environment setup

Do all of this before either agent writes a line. It takes fifteen minutes and it stops both agents from inventing SDK method names, which on a codebase this young they will otherwise do constantly.

### Hedera docs MCP

Run this **in your terminal, not inside a Claude Code session** — you are configuring the server before starting a conversation:

```bash
claude mcp add --transport http --scope project hedera-docs https://docs.hedera.com/mcp
claude mcp list          # confirm hedera-docs shows as connected
```

`--scope project` writes a `.mcp.json` into the project root, so both agents pick it up from the same repo instead of you configuring it twice. Use `--scope user` if you'd rather have it everywhere.

**Using the Claude Code desktop app instead of the terminal?** Skip the command entirely and write the file by hand. Create `.mcp.json` in the project root and commit it:

```json
{
  "mcpServers": {
    "hedera-docs": {
      "type": "http",
      "url": "https://docs.hedera.com/mcp"
    }
  }
}
```

Claude Code reads `.mcp.json` at session start on every surface — desktop app, CLI, VS Code, and the web. The first time it sees the file you get an approval prompt; approve it, or run `/mcp` inside the session if you missed it. It only reloads at session start, so restart after editing. Committing the file also configures your frontend dev with no extra step on their side.

The desktop app's Settings -> Connectors -> Add custom connector route works too, but there are open reports of custom connectors showing as connected in that UI while their tools never reach a Claude Code session. `.mcp.json` does not have that failure mode. Prefer it.

Plugins are unaffected either way — `/plugin` is a slash command inside a session and behaves identically in the app.

It is a remote HTTP server hosted by Mintlify — nothing is downloaded or executed locally, your agent just queries the docs over HTTPS. **Can Claude Code install it itself?** An agent with bash access can run the command, but the server isn't picked up until the session restarts, so you gain nothing. Run it yourself and start clean.

One thing to watch: the server rate-limits at 200 requests/hour per IP. Two agents grinding on the same connection share that budget. If searches start failing mid-build, that's why — back off, don't debug it.

### ATS source as a local reference — do not skip this

**The Hedera docs MCP does not contain the ATS contract API.** Tested and confirmed: Hedera's published ATS documentation is three pages (index, faq, web-ui), all user- and architecture-level. The word "facet" does not appear in them. There is no `HoldByPartition` reference and no function signatures anywhere.

The MCP remains the right source for native Hedera — HTS, HCS, HIP-1215, HIP-551, the system contracts. For ATS it is empty, and an agent that cannot find a signature will invent a plausible one.

So clone the source into the working tree where it can be grepped:

```bash
mkdir reference && cd reference
git clone --depth 1 --filter=blob:none --sparse https://github.com/hashgraph/asset-tokenization-studio.git ats
cd ats && git sparse-checkout set packages/ats/contracts/contracts docs
```

Add `reference/` to `.gitignore`. It is a read-only reference, not a dependency — never import from it. Every ATS signature in this blueprint came from reading it directly, and the agents should do the same:

```bash
rg "function createHoldByPartition" reference/ats/
```

### Hedera Skills plugins

`/plugin` is a Claude Code **terminal** command. The desktop app does not recognise it and will say so. The CLI and the app share plugin state, so install once from a terminal and restart your app session:

```bash
claude plugin marketplace add hedera-dev/hedera-skills
claude plugin marketplace list                      # confirm the marketplace name
claude plugin install system-contracts@hedera-skills
claude plugin install native-services-js@hedera-skills
claude plugin list --installed
```

Priority order for this build:

- **`system-contracts`** — the one that matters most. Covers HTS at `0x167` and **HSS at `0x16b`, including HIP-755, HIP-756 and HIP-1215**. That is your coupon scheduler, documented, with Solidity signatures and response codes. Install this on the backend agent without fail.
- **`native-services-js`** — HCS and HTS through the JS SDK. Your audit trail and cash token live here.
- **`hackathon-helper`** — feed it this document plus the track text; it will produce a PRD you can hand straight to the agents.
- **`hedera-harness`** — useful if you end up wanting the Open Source track as a second submission.

Skip `oracles`, `cross-chain` and `agent-kit-plugin`. They're out of scope and each one you install spends context you'd rather give the task.

If plugin installation fights you, skip it entirely — skills are just markdown. Clone `hedera-dev/hedera-skills` into `reference/` beside ATS and point the agent at the relevant `SKILL.md`. Same information, no tooling risk. Do not spend more than fifteen minutes on this.

---

## 0.3 Inheriting from Umbra — how the agent should read the old repo

The failure mode here is specific and worth naming: **hand an agent the Umbra repo and it will try to translate the Daml.** It will fail. Daml's model — contracts as immutable state, signatories and controllers as first-class authorization, no shared global state — has no Solidity analogue. A translated contract will look plausible and be wrong in ways that surface on day 6.

What crosses over is the **domain model**, not the code. Run the extraction as its own session, with a hard stop, before any building starts.

### Phase 1 — extraction (one session, read-only, ~1 hour)

Clone the Umbra repo as a **sibling directory**, not a submodule and not inside the new repo, so nothing can accidentally be committed into a public repository:

```
~/build/
  umbra/     ← private, read-only reference
  sotto/     ← new public repo
```

Give the extraction agent this instruction verbatim:

> Read the repository at `../umbra/`. It is a private OTC block-trading venue built on Canton Network in Daml. You are reading it as a **domain reference only**. Do not translate any Daml to Solidity. Do not copy any file. Do not modify anything in that directory.
>
> Produce a single file `docs/MECHANICS.md` in this repo containing, in prose and tables only — **no code from the source repo**:
>
> 1. **Roles.** Every party type, what each can do, and what each must never be able to do.
> 2. **RFQ state machine.** Exact states, every transition, who is authorised to trigger each one, and what happens on timeout in each state.
> 3. **Invariants.** Every rule the system must never violate. Be exhaustive. These are the most valuable thing in the repo.
> 4. **Failure modes.** Every bug, race, or edge case visible in the commit history, issues, or comments — what broke, what the symptom was, what fixed it. Read the commit messages carefully; the ones written during live debugging are worth more than the code.
> 5. **API shape.** The endpoint list and the responsibility of each. Names and purposes, not implementations.
> 6. **Demo lessons.** Anything in the repo indicating what worked or failed when the system was shown to people.
>
> Then stop. Do not propose an architecture, do not write code, do not read the new blueprint. Output `MECHANICS.md` and end the session.

The hard stop matters. If you let the same session roll into building, it will carry Daml-shaped assumptions into Solidity and you won't notice until the shapes stop fitting.

### Session sequence — run these as three separate sessions, not one

| Session | Reads | Writes | Never touches |
|---|---|---|---|
| **1. Extraction** | `../umbra/` only | `docs/MECHANICS.md` | This blueprint. Do not let it read ahead. |
| **2. Backend agent** | `docs/BLUEPRINT.md`, `docs/MECHANICS.md` | `/contracts`, `/backend`, `/packages/shared` | `/frontend`, `../umbra/` |
| **3. Frontend agent** | `docs/BLUEPRINT.md`, `docs/MECHANICS.md` | `/frontend` | `/backend`, `/contracts`, `/packages/shared`, `../umbra/` |

**`/packages/shared` is owned by the backend agent alone.** It holds the types, the EIP-712 domain and the commit formula, and it is the one place both sides depend on. Two agents editing it produces the same merge mess you hit on Mnemo. The frontend agent imports from it and requests changes; it does not edit it.

Work on separate branches and merge deliberately, or accept the directory ownership above as absolute. Either works. Doing neither does not.

Install the plugins from §0.2 in each build session before you paste the brief — they load at session start, not on demand.

### Phase 2 — build

New sessions. The two build agents get **this document plus `docs/MECHANICS.md`**. They never open `../umbra/`. If an agent asks for it, the answer is no — anything it needs is either in MECHANICS.md or should be added to MECHANICS.md by going back to Phase 1.

Section 4 of MECHANICS.md is the payload. Failure modes you hit under real conditions — the settlement timeout during a network upgrade, the want-leg bug — cannot be re-derived from first principles by any agent. They're the reason this build should go faster and land harder than a from-scratch entry. Everything else in the old repo you can afford to leave behind.

**Licensing note:** the Umbra repo is private. Sotto's repo must be public and every file in it written for Sotto. Extraction produces a description; it must not produce a copy.


---

## 1. Why this design, in one page

### The gap is real and documented

ATS ships a `Hold` primitive (`packages/ats/contracts/contracts/facets/hold/`). Reading `IHoldTypes.sol`:

```solidity
struct Hold {
    uint256 amount;
    uint256 expirationTimestamp;  // 0 = never expires
    address escrow;               // ONLY address authorised to execute
    address to;                   // intended recipient on execute
    bytes   data;
}
```

Operations: `Execute` (transfer to `to`), `Release` (return to holder), `Reclaim` (return after expiry, callable by anyone).

The ATS hold-operations guide opens by listing **"Secondary Market Trading"** as scenario one: *"When placing a sell order, the marketplace needs ability to transfer your tokens to a buyer. Tokens are held in escrow until the order is matched."*

They built the escrow for a marketplace. The marketplace does not exist. The track brief confirms it: *"A secondary market for ATS-issued assets, which the Studio does not have today."*

### What ATS gives us for free

| Primitive | Where | What we get |
|---|---|---|
| `createHoldByPartition` / `executeHoldByPartition` / `releaseHoldByPartition` | `facets/holdByPartition/` | Single-sided escrow with named escrow agent, fixed recipient, expiry |
| `protectedCreateHoldByPartition` | `facets/protectedHoldByPartition/` | Hold authorised by **off-chain EIP-712 signature** + deadline + nonce |
| ERC-3643 / ERC-1400 compliance modules | `facets/compliance*`, `facets/controlList`, `facets/externalKycListManagement` | KYC gates, freezes, transfer restrictions enforced *inside* the token |
| Coupon + corporate actions | `facets/coupon`, `facets/corporateActions` | Coupon schedule, snapshots, distributions |
| Deployed testnet factory | Factory Proxy `0.0.7708432`, BLR Proxy `0.0.7707874` (v4.0.0) | We do **not** deploy the ATS stack. We deploy assets from the existing factory. Saves ~2 days. |

### What we build (the missing half)

1. **The cash leg.** ATS has no payment side. Nothing.
2. **Two-legged atomic DvP.** `Clearing` is only a one-sided approval gate — an agent approves a pending transfer. There is no counter-leg, no payment, no atomicity across two assets.
3. **Price discovery.** No orders, no quotes, no auction.
4. **The audit trail.** HCS-timestamped RFQ lifecycle.
5. **On-chain lifecycle automation.** Contract-scheduled coupons via HIP-1215.

### The privacy substitution — read this before writing code

The original Umbra was private because Canton has native sub-transaction privacy. **Hedera's EVM is fully public.** Do not claim privacy we don't have. A judge will catch it.

We substitute **commit–reveal**, which is honest and arguably a better story:

- **Quote window open:** each dealer submits `commit = keccak256(abi.encode(price, quantity, nonce, dealerAddr))`. The commit hash goes to HCS. Nobody — including the seller and the venue operator — can read a price.
- **Window closes.** No further commits accepted (enforced by consensus timestamp from HCS, not server clock).
- **Reveal phase:** dealers publish `(price, nonce)`. Backend verifies each against its commit. A dealer who doesn't reveal forfeits and is marked on the audit trail.
- **Award:** best valid revealed price wins.

Result: no last-look, no front-running off a rival's quote, and every losing quote is provably timestamped before it was readable. **The audit trail is the privacy mechanism.** That is the line to say on camera.

### Hedera-specific facts that shape the build

- **HIP-551 atomic batch transactions** — live, SDK support via `setBatchKey()` / `batchify()`. Multiple HAPI transactions, each signed by its own party, execute all-or-nothing in one network transaction. Max 50 inner transactions, 6KB total batch size, all inner transactions must execute within the standard ~3-minute validity window. Mirror node `/api/v1/transactions/{id}` returns the inner transactions for an outer batch ID. **This is native multi-party external signing — the Hedera equivalent of Canton's `prepareSignExecuteMulti`.** See §2.1.
- **Consensus Node v0.76.3 (announced 31 Aug 2026) changed the batch rules:** a batch may contain **at most one `ContractExecuteTransaction`, and it must be the last inner transaction.** Our design already puts the cash leg first and the single contract call last, so it complies as written — but do not add a second contract call to the batch.
- **HIP-1215 generalized scheduled contract calls** — live on testnet (Nov 2025) and mainnet (18 Dec 2025). Schedule Service system contract at `0x16b`. A contract can schedule arbitrary future calls to other contracts or itself. Use it for coupon dates and maturity. Use `hasScheduleCapacity(expiry, gasLimit)` to find a free second before scheduling.
- **ECRECOVER works natively** for ECDSA Hedera accounts (aliases are `keccak256(pubkey)`, Ethereum-compatible). EIP-712 verification in Solidity is fine.
- **HCS is NOT callable from the EVM.** HIP-478 was proposed and never shipped. There is no HCS precompile. All HCS writes go through the backend using the JS SDK. **Do not let an agent go looking for `0x16c`.**
- **HTS token association.** Every account must be associated with an HTS token before it can receive it. This will break your demo if you skip it. Associate all demo accounts in the seed script.
- **HTS tokens have an ERC-20 facade** at their EVM address (HIP-218/719), so `IERC20(cashToken).transferFrom(...)` works after an allowance. This is how the cash leg settles.
- **Contract size / gas:** Hedera supports up to 24KB contract creation inline. Our settlement contract is small; not a concern.

---

## 2. System architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js)                                                   │
│  Issuer portal │ Seller portal │ Dealer portal │ Settlement theatre    │
└──────────────┬───────────────────────────────────────────────────────┘
               │ REST + WebSocket (the wire contract, §3)
               │ EIP-712 signing in-browser (wagmi/viem)
┌──────────────▼───────────────────────────────────────────────────────┐
│  BACKEND (Node 20 + TypeScript, Fastify, SQLite/Postgres)             │
│  RFQ engine (commit→reveal→award)                                     │
│  EIP-712 typed-data builder + verifier                                │
│  HCS writer (@hashgraph/sdk) → audit topic                            │
│  ATS SDK adapter (issue bond, KYC grant, read holds/balances)         │
│  Mirror-node poller (confirm settlement events)                       │
└──────────────┬───────────────────────────────────────────────────────┘
               │ ethers/viem → Hedera JSON-RPC relay
┌──────────────▼───────────────────────────────────────────────────────┐
│  CONTRACTS (Solidity, Hardhat)                                        │
│  SottoSettlement.sol   — escrow agent + atomic DvP                    │
│  SottoCouponScheduler.sol — HIP-1215 on-chain cron                    │
└──────────────┬───────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│  HEDERA TESTNET                                                       │
│  ATS bond (diamond, from Factory 0.0.7708432)                         │
│  HTS cash token (test USDC)                                           │
│  HCS audit topic                                                      │
│  Schedule Service 0x16b                                               │
└──────────────────────────────────────────────────────────────────────┘
```

### The settlement flow — the thing the whole project exists to demo

```
1. Seller holds 1,000 STO-BOND-A (nominal 1 USDC/unit — sized to the faucet, see A3).
   Calls createHoldByPartition(partition, Hold{
       amount: 250,
       expirationTimestamp: now + 48h,
       escrow: address(SottoSettlement),
       to: address(0),               // recipient decided at award
       data: abi.encode(rfqId)
   })
   → Available balance drops to 750. Held balance 250.
   → Seller still earns coupons on all 1,000. (ATS pays on total balance.)

2. RFQ opens. Dealers commit hashed quotes. Commits → HCS.

3. Window closes. Dealers reveal. Backend verifies commits.

4. Seller awards to best price. Winning dealer signs an EIP-712 Trade
   and grants the settlement contract a cash allowance.

5. SottoSettlement.settle(trade, sellerSig, buyerSig):
      a. verify both EIP-712 signatures
      b. check hold: escrow == self, amount >= qty, not expired
      c. IERC20(cash).transferFrom(buyer, seller, notional)   ← CASH LEG
      d. executeHoldByPartition(holdId, buyer, qty)           ← SECURITY LEG
                                                                (ATS runs
                                                                 compliance
                                                                 here)
      e. emit Settled(tradeId, ...)
   ANY failure → whole transaction reverts. Neither leg moves.

6. Backend sees Settled via mirror node → writes final HCS record.

7. If no award before expiry: anyone calls reclaimHoldByPartition.
   Seller's 250 returns to available. No trust required.
```

**The money shot for the demo video:** run step 5 with the buyer's KYC revoked, or with the buyer's cash allowance one unit short. Show the revert. Show on HashScan that the seller's held balance is untouched and the buyer received nothing. *That* is what separates a settlement system from a token transfer.

### 2.1 Two settlement paths — build both, demo both

The flow above is **Path A**. There is a second, more Hedera-native path worth building on top of it. They share the same RFQ engine, the same EIP-712 Trade, the same hold. Only the final settlement transaction differs.

**Path A — EVM allowance (primary, trustless).**
Buyer grants the settlement contract an ERC-20 allowance on the cash token. `settle()` does `transferFrom` then `executeHoldByPartition` inside one EVM transaction. Atomicity comes from EVM revert semantics. The contract itself enforces that the cash moved — nobody can take delivery without paying, because the same function does both.
*Cost:* one extra approval click, and the buyer temporarily trusts the contract with an allowance.

**Path B — HIP-551 atomic batch (flagship, Hedera-only).**
```
BatchTransaction (batchKey = venue relayer)
  ├── inner 1: TransferTransaction   cash buyer → seller   [signed by buyer]
  └── inner 2: ContractExecuteTransaction
                 SottoSettlement.deliver(trade, sellerSig, buyerSig)   ← must be LAST
```
Each party signs only their own leg. No allowance. The cash leg is a **native HTS transfer**, not an ERC-20 facade call. Atomicity is provided by the network, not by the contract.

This is the Umbra pattern rebuilt on Hedera's own primitive, and it's a thing EVM chains structurally cannot do. It's the strongest single claim in the submission.

**Say the tradeoff out loud — do not hide it.** In Path B the contract *cannot introspect its batch siblings*. `deliver()` has no way to verify from inside the EVM that inner transaction 1 exists or succeeded. It relies entirely on batch atomicity. That means a malicious assembler holding a valid signed Trade could call `deliver()` standalone and take delivery without including the cash leg.

Mitigation, and state it plainly in the README: `deliver()` is gated to a `RELAYER_ROLE`, while `settle()` (Path A) is permissionless. So the trustless path is the open one and the elegant path is the permissioned one. Naming this tradeoff is worth more with judges than pretending it doesn't exist — it's exactly the kind of thing a settlement engineer notices and a demo-builder doesn't.

**Risk to check on day 1:** whether HashPack / WalletConnect will sign an inner transaction carrying a `batchKey`. If browser wallets can't, run Path B with backend-held demo keys for the video and say so. Path A remains the wallet-signed path either way. Do not let this block anything — Path A is the day-5 gate, Path B is upside.

---

## 3. The wire contract — FREEZE THIS ON DAY 1

Both agents code against this. Neither waits for the other. Nobody changes it without both agreeing.

### 3.1 Shared types (`packages/shared/src/types.ts`)

```ts
export type RfqStatus = 'OPEN' | 'REVEALING' | 'AWARDED' | 'SETTLED' | 'EXPIRED' | 'FAILED';

export interface Rfq {
  id: string;                    // uuid
  assetToken: string;            // 0x… ATS diamond address
  assetSymbol: string;
  partition: string;             // bytes32 hex
  cashToken: string;             // 0x… HTS token EVM address
  quantity: string;              // base units, decimal string
  seller: string;                // 0x…
  holdId: number | null;         // set once hold is on-chain
  commitDeadline: number;        // unix seconds
  revealDeadline: number;        // unix seconds
  status: RfqStatus;
  createdAt: number;
  hcsSequenceNumber: number | null;
}

export interface QuoteCommit {
  rfqId: string;
  dealer: string;
  commitHash: string;            // 0x… keccak256
  submittedAt: number;
  hcsSequenceNumber: number | null;
}

export interface QuoteReveal {
  rfqId: string;
  dealer: string;
  price: string;                 // cash base units per 1 whole asset unit
  nonce: string;                 // 0x… bytes32
  valid: boolean;                // did it match the commit?
  revealedAt: number;
}

export interface Trade {                 // EIP-712 payload — MUST match Solidity struct
  rfqId: string;                         // bytes32 — see rfqIdToBytes32 below
  assetToken: string;
  partition: string;                     // bytes32
  holdId: string;                        // uint256 as string
  cashToken: string;
  seller: string;
  buyer: string;
  quantity: string;                      // uint256
  notional: string;                      // uint256 — total cash, precomputed
  deadline: string;                      // uint256 unix seconds
  nonce: string;                         // uint256
}

export interface AuditEvent {
  rfqId: string;
  kind: 'RFQ_OPENED' | 'HOLD_PLACED' | 'QUOTE_COMMITTED' | 'WINDOW_CLOSED'
      | 'QUOTE_REVEALED' | 'REVEAL_FAILED' | 'AWARDED' | 'SETTLED'
      | 'SETTLEMENT_REVERTED' | 'EXPIRED';
  payload: Record<string, unknown>;
  hcsSequenceNumber: number;
  consensusTimestamp: string;
  topicId: string;
}
```

**`Rfq.id` is a UUID string; `Trade.rfqId` is `bytes32`. The conversion is fixed and reversible:**

```ts
// A UUID is 128 bits; bytes32 is 256. It fits with room to spare, so do NOT hash it.
// Right-padding keeps it reversible: anyone reading a Settled event on HashScan
// can recover the RFQ id without access to our database. Auditability is the
// whole point of this project — do not throw it away for a keccak.
export function rfqIdToBytes32(uuid: string): `0x${string}` {
  return ('0x' + uuid.replace(/-/g, '') + '0'.repeat(32)) as `0x${string}`;
}

export function bytes32ToRfqId(b: string): string {
  const h = b.slice(2, 34);
  return [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20,32)].join('-');
}
```

### 3.2 EIP-712 domain — identical in Solidity and TS

```ts
export const EIP712_DOMAIN = {
  name: 'Sotto',
  version: '1',
  chainId: 296,                  // Hedera testnet
  verifyingContract: SETTLEMENT_ADDRESS,
};

export const TRADE_TYPES = {
  Trade: [
    { name: 'rfqId',      type: 'bytes32' },
    { name: 'assetToken', type: 'address' },
    { name: 'partition',  type: 'bytes32' },
    { name: 'holdId',     type: 'uint256' },
    { name: 'cashToken',  type: 'address' },
    { name: 'seller',     type: 'address' },
    { name: 'buyer',      type: 'address' },
    { name: 'quantity',   type: 'uint256' },
    { name: 'notional',   type: 'uint256' },
    { name: 'deadline',   type: 'uint256' },
    { name: 'nonce',      type: 'uint256' },
  ],
} as const;
```

### 3.3 Commit formula — one implementation, in shared, used by both sides

```ts
export function computeCommit(
  price: bigint, quantity: bigint, nonce: `0x${string}`, dealer: `0x${string}`
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{type:'uint256'},{type:'uint256'},{type:'bytes32'},{type:'address'}],
      [price, quantity, nonce, dealer]
    )
  );
}
```

### 3.4 REST API

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `POST` | `/api/rfq` | `{assetToken, partition, quantity, cashToken, commitWindowSecs, revealWindowSecs}` | `Rfq` |
| `POST` | `/api/rfq/:id/hold` | `{holdId, txHash}` | `Rfq` — seller reports the on-chain hold |
| `GET` | `/api/rfq` | `?status=OPEN` | `Rfq[]` |
| `GET` | `/api/rfq/:id` | — | `{rfq, commits, reveals, award, audit}` |
| `POST` | `/api/rfq/:id/commit` | `{dealer, commitHash}` | `QuoteCommit` — 409 after `commitDeadline` |
| `POST` | `/api/rfq/:id/reveal` | `{dealer, price, nonce}` | `QuoteReveal` — 409 outside reveal window |
| `POST` | `/api/rfq/:id/award` | `{dealer}` | `{trade, digest}` — unsigned Trade for both parties to sign |
| `POST` | `/api/rfq/:id/settle` | `{trade, sellerSig, buyerSig}` | `{txHash, status}` |
| `GET` | `/api/rfq/:id/audit` | — | `AuditEvent[]` with HCS sequence numbers |
| `GET` | `/api/assets` | — | issued bonds with coupon schedule + HashScan links |
| `POST` | `/api/admin/issue` | bond params | `{assetToken, txHash}` — issuer only |
| `POST` | `/api/admin/kyc` | `{assetToken, account, granted}` | `{txHash}` |
| `GET` | `/api/health` | — | `{ok, network, topicId, settlementAddress, blockHeight}` |

### 3.5 WebSocket

`ws://host/ws` — subscribe `{type:'subscribe', rfqId}`. Server pushes:

```ts
{ type: 'rfq.updated',   rfq: Rfq }
{ type: 'quote.committed', rfqId, dealer, commitHash, count }   // never a price
{ type: 'window.closed', rfqId }
{ type: 'quote.revealed', rfqId, dealer, price, valid }
{ type: 'awarded',       rfqId, dealer, trade }
{ type: 'settled',       rfqId, txHash, hashscanUrl }
{ type: 'reverted',      rfqId, reason }
{ type: 'audit',         event: AuditEvent }
```

### 3.6 Error envelope

```json
{ "error": { "code": "COMMIT_WINDOW_CLOSED", "message": "…", "detail": {} } }
```

Codes: `COMMIT_WINDOW_CLOSED`, `REVEAL_WINDOW_CLOSED`, `COMMIT_MISMATCH`, `HOLD_NOT_FOUND`, `HOLD_EXPIRED`, `INSUFFICIENT_ALLOWANCE`, `KYC_REJECTED`, `SIGNATURE_INVALID`, `SETTLEMENT_REVERTED`, `TOKEN_NOT_ASSOCIATED`.

### 3.7 Mock server — build this in hour one

Backend agent ships `npm run mock` on day 1: the full API above returning fixtures, with a scripted RFQ that advances through every state on a 90-second loop. Frontend builds the entire UI against it and never blocks on chain work. This is non-negotiable — it is the single highest-leverage thing in the plan.

---

## 4. Workstream A — Contracts + Backend

**Owner: backend agent. Deliverables in dependency order.**

### A1. Contracts (`/contracts`, Hardhat)

**`SottoSettlement.sol`**

```solidity
// Core surface — implement exactly this signature set.

// Path A: permissionless. Verifies sigs, pulls cash, executes hold. Atomic by EVM revert.
function settle(Trade calldata t, bytes calldata sellerSig, bytes calldata buyerSig)
    external returns (bool);

// Path B: delivery leg only, for use as the LAST inner tx of a HIP-551 batch.
// Gated to RELAYER_ROLE — the contract cannot verify its batch siblings. See §2.1.
function deliver(Trade calldata t, bytes calldata sellerSig, bytes calldata buyerSig)
    external onlyRole(RELAYER_ROLE) returns (bool);

// Escrow-side release when an RFQ dies BEFORE the hold expires, so the seller
// does not sit through a 48-hour timeout. Escrow-authorised only.
function releaseHold(address assetToken, bytes32 partition, address holder, uint256 holdId, uint256 amount)
    external;

function nonces(address account) external view returns (uint256);
```

**There is deliberately no reclaim function here.** ATS distinguishes the two paths and so do we:

| | Who can call | When | Our code |
|---|---|---|---|
| `releaseHoldByPartition` | the escrow (us) | before expiry | wrapped as `releaseHold` above |
| `reclaimHoldByPartition` | **anyone** | after expiry | none needed — a direct ATS call |

Reclaim requires no venue code at all. Say so in the README under *Known limitations*: **if Sotto disappears entirely, a seller's tokens are still recoverable by any address once the hold expires.** The venue cannot trap collateral. That is a real property, it costs nothing, and it is exactly what a settlement judge looks for.

`settle` and `deliver` must consume the **same nonce space** so a Trade cannot be settled twice, once down each path. Factor the shared logic — signature recovery, hold validation, nonce consumption, hold execution — into one internal function; `settle` wraps it with the cash pull, `deliver` wraps it with the role check.

`settle` body, in order — do not reorder. The reason is **not** that a revert would otherwise leave cash stranded; inside one EVM transaction a revert unwinds both legs whatever the order. The reason is HIP-551: a batch may contain at most one `ContractExecuteTransaction` and it must be the **last** inner transaction, so Path B's cash leg has to be a native transfer that precedes the contract call. Path A mirrors that ordering so both paths reason identically and the tests transfer between them.

1. `require(block.timestamp <= t.deadline)` → `DeadlineExpired`
2. Recover both signatures over the EIP-712 digest; `require(signer == t.seller)` and `require(signer == t.buyer)`; consume nonces.
3. Read the hold via `getHoldForByPartition`; assert `escrow == address(this)`, `amount >= t.quantity`, `expirationTimestamp > block.timestamp`.
4. `IERC20(t.cashToken).transferFrom(t.buyer, t.seller, t.notional)` — check the boolean return.
5. Execute the hold **and check the return**. The signature is `executeHoldByPartition(...) external returns (bool success_, bytes32 partition_)` — a two-value return, verified against `reference/ats/`:

   ```solidity
   (bool success_, ) = IHoldByPartition(t.assetToken).executeHoldByPartition(
       IHoldTypes.HoldIdentifier(t.partition, t.seller, t.holdId), t.buyer, t.quantity
   );
   require(success_, "delivery failed");
   ```

   **This `require` is load-bearing.** If ATS ever signals a compliance failure by returning `false` rather than reverting, then without it the cash has moved and the bond has not — precisely the outcome this entire project exists to make impossible. Do not drop it because "it reverts anyway."

   Same rule for step 4: `IERC20.transferFrom` returns a bool. Check it.
6. `emit Settled(t.rfqId, t.seller, t.buyer, t.quantity, t.notional, t.assetToken, t.cashToken)`.

Reentrancy guard on `settle`. No admin key that can move user funds — say this in the README, judges look for it.

**`SottoCouponScheduler.sol`** — HIP-1215

- `scheduleCoupon(address assetToken, uint256 couponDate, uint256 gasLimit)`
- Probe `hasScheduleCapacity(expiry, gasLimit)` on the `0x16b` system contract, walking forward second-by-second until a free slot is found (bounded loop, ~60 tries).
- Call `scheduleCall` targeting the ATS coupon distribution.
- `scheduleMaturity(...)` — same pattern for redemption at maturity.
- Emit `CouponScheduled(assetToken, couponDate, scheduleAddress)` so the frontend can show pending scheduled calls.

**If HIP-1215 fights you, timebox it to 4 hours.** Fall back to a backend scheduler that calls the same coupon function, keep the contract in the repo, and say plainly in the README that the on-chain path is implemented but the demo used the backend trigger. An honest fallback beats a broken flagship feature. But try it — this is the highest-differentiation item in the build.

**Tests** (`npx hardhat test`) — these double as evidence for judges:

- happy path DvP
- revert when buyer allowance is short → assert seller's held balance unchanged
- revert when buyer KYC is revoked → assert no cash moved
- revert on expired hold
- revert on replayed signature (nonce consumed)
- reclaim after expiry returns tokens to seller
- settle called by a random third party with valid sigs → succeeds (permissionless relay, this is a feature)

### A2. ATS integration (`/backend/src/ats/`)

- **Source of truth for every ATS call is `reference/ats/`, not the MCP and not memory.** The docs MCP will report that a facet does not exist, because ATS contracts are not in Hedera's published docs. That is a gap in the docs, not evidence the facet is missing. Grep the source.
- Use the **deployed testnet Factory `0.0.7708432`**. Do not deploy the ATS stack.
- **Issuance — corrected 5 Sep 2026 against `reference/ats/` source. The original line here was wrong in four ways; see `docs/ATS-SPIKE.md`.**
  - **The SDK has no server-key path.** `SupportedWallets` is `METAMASK`, `HWALLETCONNECT`, `DFNS`, `FIREBLOCKS`, `AWSKMS` — `CLIENT` is **commented out**. The only headless options are custodial (AWS KMS / DFNS / Fireblocks), all too heavy for this window. **So the backend issues by calling `Factory.deployBond` directly with ethers over the JSON-RPC relay, using the ISSUER key.** The ABI comes from `reference/ats/.../factory/IFactory.sol`. The issuer portal can drive the same factory through a wallet for the camera.
  - **Use `Bond.createFixedRate()` semantics, not `create()`.** `Factory.deployBond` returns `SecurityType.BondVariableRate`; a fixed 4.5% coupon needs the fixed-rate path, which adds `rate` and `rateDecimals`.
  - **Coupon rate and frequency are NOT issuance parameters.** They appear on no create request. Coupons are scheduled *after* creation via `setCoupon()` (start/end dates) and read with `getAllCoupons()`. `issueBond()` is therefore two steps.
  - **`configId` (32-byte hex) and `configVersion` are required.** Do not invent or hardcode them — resolve at runtime via `resolveLatestConfigVersion` / `GetConfigInfo`.
  - Required flags the old line omitted, each of which changes whether settlement works: `isMultiPartition` (the whole hold flow is `...ByPartition`), `arePartitionsProtected` (gates the EIP-712 protected hold), `clearingActive`, **`internalKycActivated` — without it there is no internal KYC to revoke, and the failure demo has nothing to show**, `isControllable`, `isWhiteList`. Plus `currency`, `numberOfUnits`, `nominalValue`, `nominalValueDecimals`, `startingDate`, `maturityDate`, `decimals`.
- `grantKyc(assetToken, account)` / `revokeKyc(...)` — needed for the failure demo.
- `readHold(assetToken, partition, holder, holdId)`.
- `readBalances(assetToken, account)` → `{total, available, held, locked}`. The frontend needs all four; the whole story is visible in these numbers.

### A3. Cash token — use real USDC, not a play token

The cash leg settles in **Circle's actual USDC on Hedera testnet: token `0.0.429274`, 6 decimals.** Not a self-minted stand-in. Settling a tokenised bond against real Circle USDC reads completely differently to a judge, and it puts you on the same rails as Archax's live streaming-cash-flow deployment on Hedera rather than on a toy.

- **Free public faucet: faucet.circle.com.** No account, no key — paste a wallet address, pick Hedera Testnet. It serves EURC as well as USDC, so a second settlement currency is available if you want one (get the Hedera EURC token id from `developers.circle.com/stablecoins/eurc-contract-addresses` — do not guess it).
- **Verify the rate limit on day 0, because the published figures disagree.** The faucet's own FAQ states 20 USDC per address per blockchain every 2 hours. Circle's developer docs state 10 USDC once per 24 hours. Go and drip once, note the cooldown the UI shows you, and plan from that. Do not take either number on trust.
- **RESOLVED 5 Sep 2026 — no custom token. `USDX` is struck from this build.** The limit is **20 USDC per address, per chain, every 2 hours** (the higher figure). Verified end to end: 20 USDC landed on the ISSUER and DEALER accounts. Every settlement runs on real Circle USDC and nothing is minted for convenience — the materially stronger claim. Do not build a stand-in token; if a rehearsal runs short, wait out a 2-hour window or drip a second address.
- **Only the buyer needs a cash balance.** The cash leg is `transferFrom(buyer, seller, notional)`, so the winning dealer pays and the seller only receives. Funding the dealer account is sufficient to settle.
- **A failed drip still consumes the 2-hour window.** Associate the token *first* (see below), then drip — a drip into an unassociated account is silently lost and costs you the window.
- **Size the demo bond to the budget you confirm.** A nominal of 1 USDC per unit and a block of around 20 units at 98.35 puts the notional near 20 USDC. The UI can display institution-scale figures; the settled amounts have to fit what the faucet actually gave you.
- **Demo a second currency for free.** `cashToken` is already a parameter, so the venue is currency-agnostic by construction. Settle one trade in USDC and one in HBAR (unlimited from the Hedera Portal faucet) and you have demonstrated a general settlement engine rather than a USDC-specific one. Ten seconds of video, no extra code.
- **Associate every demo account** with USDC and the ATS bond, explicitly. Put it in `seed.ts` and run it before every demo. `backend/src/scripts/associate.ts` already does this for USDC.

**Why the bond is still self-issued, in contrast.** The track requires the video to show *issuance* as a named deliverable, so minting is not optional. More importantly, the failure demo needs you to hold `ISSUER` and `CONTROLLER` roles on that token — you cannot revoke KYC on an asset someone else issued. Cash leg: borrow something real. Security leg: issue it yourself. Different answers, for different reasons.

### A4. RFQ engine (`/backend/src/rfq/`)
- State machine `OPEN → REVEALING → AWARDED → SETTLED`, plus `EXPIRED` and `FAILED`.
- Commit window and reveal window enforced against **HCS consensus timestamps**, not `Date.now()`. This is a real integrity property — say it out loud in the video.
- Commit verification on reveal using the shared `computeCommit`.
- Award: best valid revealed price. Tie → earliest HCS sequence number.

### A5. HCS audit trail (`/backend/src/hcs/`)
- Create one topic at boot; persist the topic ID; expose it on `/api/health`.
- Every `AuditEvent` → `TopicMessageSubmitTransaction`. Store `sequenceNumber` + `consensusTimestamp` back on the row.
- Message body: `{v:1, rfqId, kind, payload, ts}` JSON, under 1024 bytes. Chunk if larger.
- `GET /api/rfq/:id/audit` returns the ordered event list. Include the HashScan topic URL.

### A6. Mirror node poller
- Poll for `Settled` and `HoldByPartitionExecuted` events, reconcile against local DB, push `settled` over WS.
- Testnet mirror node lags a beat behind consensus. Poll every 2s, and never let the UI wait on the poller — optimistically flip on the transaction receipt and let the poller confirm.

### A7. Deployment
- Backend + frontend on a VPS behind Caddy, pm2, TLS. You've done this exact deploy twice.
- Hardcode nothing. `.env.example` committed, real `.env` gitignored.
- **Do not put a Hedera operator key anywhere a screenshot can reach it.**

---

## 5. Workstream B — Frontend

**Owner: frontend agent. Starts hour one against the mock server. Never blocked.**

### B0. Foundation

> **THE BACKEND IS ALREADY BUILT AND LIVE ON TESTNET.** Read this block before writing
> anything — it will save you a day.

**Live addresses (also served by `GET /api/health`, never hardcode them):**

| | |
|---|---|
| Bond `STO-BOND-A` | `0xD53072649037FEecD305920087791a37dF8D517F` |
| Equity `STO-EQ-A` | `0x21C3E7368a77756E896D58a6f97C3099Cc9C47e0` |
| SottoSettlement | `0x73195C1f91899Bc1E822bb1D039033Eb38926931` (Sourcify `exact_match`) |
| SottoNavOracle | `0xe8E7c39ba776C3B0778BE4571e72F5669f662c04` |
| SottoDealerBond | `0x192565BD006c559afFe12B4eAD0Cd749581702aF` |
| SottoCouponScheduler | `0xe23f19786E146fADdBd6b3EEa9994e9feC0cf847` |
| HCS audit topic | `0.0.10383803` |
| Cash | real Circle USDC `0.0.429274`, EVM `0x0000000000000000000000000000000000068cDa`, **6 dp** |

**Build against the LIVE API. `npm run serve`, port 4000, real testnet.** Everything below is
deployed and working, so there is no reason to build against fixtures.

`npm run mock` still exists on **port 4010** for offline work when testnet is down or you are
styling a state repeatedly. It is fixtures, not the chain. It deliberately does NOT share a
port with the live API: when it did, it silently shadowed it and `/api/health` answered
`mock: true` with fixture addresses while we believed we were reading testnet. **Never record
a demo against it.** `GET /api/health` returns `mock: true|false` — check it before you film.

**Traps that will cost you hours if you meet them cold:**

- **`balanceOf` returns AVAILABLE, not total.** Total is `balanceOf + getHeldAmountFor`. Use
  `GET /api/balances/:account`, which returns all four numbers already computed. If you call
  `balanceOf` yourself, placing a hold looks like the seller *lost* tokens — and B2's whole
  animation is built on total staying still.
- **TypeScript 7 breaks ts-node-based tooling.** `npm i -D typescript` now installs 7.x, whose
  compiler API ts-node cannot read; you get `Cannot read properties of undefined (reading
  'fileExists')`. Pin `typescript@^5.6`.
- **viem rejects non-EIP-55-checksummed addresses at encode time.** Run every hardcoded
  address through `getAddress()`.
- **Hedera needs `evmVersion: 'cancun'`** if you compile anything (OpenZeppelin uses `mcopy`).
- The mock and the live server both bind **:4000**. Kill one before starting the other, or you
  will read fixtures believing they are chain data — on Windows `pkill` silently does nothing;
  kill by port.

**Stack:** Next.js App Router, TypeScript, Tailwind, `wagmi` + `viem`. EIP-712 signing is
`signTypedData` with the domain from `packages/shared/src/eip712.ts` — do not redefine it, the
contract verifies against exactly those fields.

**Wallets — use existing libraries, never roll your own:**

- HashPack / Blade → `@hashgraph/hedera-wallet-connect` (Hedera WalletConnect 2.0). Needs a
  projectId from cloud.walletconnect.com.
- MetaMask → wagmi's injected connector on chainId `296`.
- The contract does not care where a signature came from: today's settlements are signed by
  `ethers.Wallet` and a HashPack signature over the same typed data recovers to the same
  address. **Nothing in the backend needs to change when you add wallets.**
- **Day-1 unknown worth testing early:** whether a browser wallet will sign an inner
  transaction carrying a `batchKey` (Path B). If it will not, Path A stays wallet-signed and
  Path B runs with backend keys for the video — say so on camera rather than hiding it.
- `docs/MECHANICS.md` §4 has a large amount of hard-won wallet material — rate limits on
  wallet-hosted APIs, CIP-0103 discovery, session restore, provider fallback. Read it before
  starting wallet work, not after.

- Hedera testnet chain config: chainId `296`, JSON-RPC relay `https://testnet.hashio.io/api`, explorer `https://hashscan.io/testnet`.
- Role switcher in the header — Issuer / Seller / Dealer — driven by connected address, with a demo override. Judges watch a 5-minute video; they need to see which hat you're wearing without you explaining it.

### B1. Issuer portal
- Issue-bond form: name, symbol, ISIN, nominal, coupon rate, frequency, maturity.
- **ISIN is checksum-validated on-chain (ISO 6166) — validate it client-side before
  submitting, or the user gets an opaque revert.** `XS0000000001` is invalid; `XS0000000009`
  is valid. The check digit algorithm is in `docs/ATS-SPIKE.md`.
- **Asset-class switch: Bond or Equity.** The track is judged on *"real asset classes and real
  lifecycle management… over a token with a name on it"* — plural. Equity uses a different ATS
  configuration and a different lifecycle (dividends and voting rights rather than coupons and
  maturity), and the same RFQ engine and the same `settle()` handle both with no per-asset
  branch. Showing one venue trading two asset classes is what turns this from "an RFQ for one
  bond" into secondary-market infrastructure.
- KYC panel: grant/revoke per account, with a visible toggle. **This toggle is what you flip on camera to trigger the failed settlement.** Make it prominent.
- Coupon schedule view: each coupon date, its scheduled-call address, and status (`Scheduled` / `Executed`).

### B2. Seller portal
- Position card showing **Total / Available / Held / Locked** as four distinct numbers. Animate the transition when a hold is placed — available drops, held rises, total is unmoved. This one animation communicates the entire hold concept without narration.
- "Offer size" flow: choose quantity → sign `createHoldByPartition` with escrow prefilled to the settlement address → POST the resulting `holdId`.
- Live RFQ board: dealer count and commit count during the window, **prices hidden**. Show locked padlocks with commit hashes. When the window closes, reveal them one by one. This is the visual centrepiece — make it good.
- Award button on the best revealed quote. Then sign the Trade.

### B3. Dealer portal
- Open RFQ list with size, asset, maturity, coupon.
- Commit form: enter price → nonce generated client-side → commit hash computed and shown → submitted. **Persist `(price, nonce)` in localStorage keyed by rfqId** or the dealer cannot reveal. Show a warning that closing the tab before reveal forfeits the quote.
- Reveal button, enabled only during the reveal window, with a countdown.
- On award: approve cash allowance, then sign the Trade. Two clear steps, two buttons, never one ambiguous one.

### B4. Settlement theatre
The screen the video ends on. Vertical timeline, one row per stage, each row live:

```
● Hold placed          250 STO-BOND-A escrowed    [HashScan ->]  HCS #14
● Quotes committed     4 dealers, prices sealed                      HCS #15-18
● Window closed        consensus 2026-09-14T11:04:22Z                HCS #19
● Quotes revealed      98.20 · 98.35 · 98.11 · 97.90                 HCS #20-23
● Awarded              Dealer B @ 98.35                              HCS #24
● Settled atomically   cash → seller │ bond → buyer   [HashScan ->]   HCS #25
```

Two side-by-side ledgers above the timeline — seller and buyer, each showing bond and cash balances — that update **simultaneously** on settlement. Both change, or neither does. That simultaneity is the product.

### B5. Failure mode view
When settlement reverts: red state, the revert reason surfaced (`KYC_REJECTED`, `INSUFFICIENT_ALLOWANCE`), and both ledgers explicitly annotated **"unchanged"** with the pre- and post- numbers side by side. Do not hide the failure path — it is the strongest thing in the demo.

### B6. Visual direction
Dark, dense, instrument-panel. Tabular numerals everywhere — `font-variant-numeric: tabular-nums` — so figures don't jitter when they update. Monospace for addresses and hashes, always truncated `0x1234…abcd` with click-to-copy. No decorative illustration, no gradient hero. This should look like something a trading desk would tolerate. Restraint reads as competence to a judge who has just watched forty pastel landing pages.

---

## 6. Nine-day schedule

Both tracks run every day. Nothing waits.

| Day | Backend / Contracts | Frontend |
|---|---|---|
| **0** (Sep 5, am) | **Start the Circle USDC faucet drips — first thing, before anything else.** §0.2 environment setup. §0.3 Phase 1 extraction to `docs/MECHANICS.md`. Hard stop. | — |
| **1** (Sep 5, pm) | Freeze §3. Ship mock server. Hardhat + testnet account. ATS SDK spike. Kick off `npm run ats:setup` in the background. | Next.js scaffold, wallet connect, routing, role switcher, all pages wired to mock |
| **2** | `SottoSettlement.settle` happy path + unit test. HTS cash token + association script. | Seller portal + balance card with hold animation. Dealer commit form. |
| **3** | Issue a bond from Factory `0.0.7708432` on testnet. KYC grant/revoke. | RFQ board with sealed commits → reveal transition. Issuer portal. |
| **4** | RFQ engine + commit/reveal verification. Wire real API over mock shape. | Cut over from mock to live API. Fix the shape mismatches you will find. |
| **5** | **First end-to-end settlement on testnet.** Nothing else matters today. | Settlement theatre timeline, dual ledger, HashScan links. |
| **6** | HCS topic + audit writes + sequence numbers. Mirror node poller. Failure-path tests. | Audit timeline from real HCS data. Failure-mode view. |
| **7** | **Path B: HIP-551 batch settlement** (`deliver` + batch assembly). Then HIP-1215 coupon scheduler if time (4h timebox, then fall back). | Path selector in settlement view. Coupon schedule view. Polish, empty states, loading states. |
| **8** | Deploy to VPS. Verify contracts on HashScan. Seed script hardening. | Responsive pass. Copy pass. Kill every placeholder string. |
| **9** | Full dry run ×3. Fix what breaks. Write README. | Full dry run ×3. Record raw footage. |
| **10–11** (Sep 15–16) | Cut the video. Write the submission. Submit **early**. | — |

**Day 5 is the gate.** If there is no settled trade on testnet by end of day 5, cut the coupon scheduler and the issuer portal entirely and ship the settlement path alone. A working atomic DvP with a hold, a cash leg and an audit trail wins this track. A half-built five-feature platform does not.

---

## 7. Qualification checklist

| Requirement | How we satisfy it | Owner |
|---|---|---|
| Use ATS (SDK, contracts, web app, or combination) to issue or manage a tokenised asset | ATS SDK issues the bond from the deployed testnet factory; ATS Hold facet is the delivery leg of every settlement | Backend |
| Deploy and demonstrate on Hedera testnet | Live at a public URL, contracts on testnet | Both |
| Public GitHub repo, contracts verified on HashScan | Sourcify supports Hedera testnet — verify `SottoSettlement` and `SottoCouponScheduler` | Backend |
| Demo video ≤5 min: issuance, configuration, and ≥1 lifecycle operation | §8 script | Both |

### Extra-points coverage

| Extra point | Covered? |
|---|---|
| Secondary market for ATS-issued assets (which the Studio lacks) | **This is the entire project** |
| Compliance controls: KYC grants, freezes, transfer restrictions, pauses | KYC grant/revoke, enforced inside `executeHoldByPartition`, demonstrated by a deliberate failure |
| Custom fee schedules, coupon or dividend distributions | Coupon schedule on the bond + distribution |
| Oracle integration for asset pricing or NAV | *Optional stretch.* Only if day 7 is clear. |
| Scheduled Transactions for vesting, coupon payments, or maturity settlement | HIP-1215 contract-scheduled coupons and maturity |
| Contributions back upstream to ATS | **Do this.** See §9. |

---

## 8. Demo video script (target 4:50 — hard cap is 5:00)

| Time | Content |
|---|---|
| 0:00–0:25 | Cold open on the problem. "ATS lets you issue a bond. It gives you no way to sell one. The hold primitive it ships is documented for secondary market trading — and there is no secondary market." |
| 0:25–1:00 | Issuer portal: bond already issued, show the config, show coupon dates with their on-chain scheduled calls. HashScan link. |
| 1:00–1:35 | Seller holds 1,000 units. Offers a 250-unit block. Signs the hold. **Watch available drop and held rise while total does not move.** HashScan. |
| 1:35–2:20 | Dealers commit. Four sealed padlocks, no prices. Window closes on consensus timestamp. Reveal. Prices appear. |
| 2:20–3:00 | Award. Both parties sign. `settle` fires. **Both ledgers move at once.** HashScan transaction. |
| 3:00–3:50 | **The failure demo.** Revoke buyer KYC. Run a second trade. It reverts. Show both ledgers unchanged, side by side, before and after. "Both legs, or neither. This is the difference between a settlement system and a token transfer." |
| 3:50–4:15 | HCS audit timeline. Every commit hash timestamped before any price was readable. "The audit trail is what makes a public chain safe for block trades." |
| 4:15–4:40 | **Path B.** Same trade, settled as a HIP-551 atomic batch — buyer signs the native cash transfer, seller's hold executes as the last inner transaction, no allowance anywhere. Show the outer batch on HashScan with both inner transactions under it. "Each party signs only their own leg. That is not something you can do on an EVM chain." |
| 4:40–4:50 | Repo, live URL, CLPR as what's next. |

Record the failure demo **first**, while you're fresh. It's the hardest to get clean and it's the part that wins.

---

## 9. Two things that punch above their cost

1. **Open a PR upstream to ATS.** Even something small — a doc fix, a missing test, a typed helper for hold identifiers. The track lists "contributions back upstream to ATS" as an extra point and roughly nobody will do it. It costs an hour and it signals you actually read the codebase rather than importing the SDK.

2. **Name the tradeoff in §2.1 in the README.** Most submissions present a settlement mechanism and stay quiet about what it assumes. Writing down that `deliver()` cannot introspect its batch siblings, and why that forces a role gate, is the single cheapest signal that a settlement engineer built this rather than a demo builder. Two paragraphs. Put it under a heading called *Known limitations* so it's impossible to miss.

---

## 10. Known traps

- **6KB batch limit.** A batch carrying a contract call with two EIP-712 signatures is close to the ceiling. Measure it early; if it overflows, move the signatures into contract storage via a prior `preauthorize` call rather than passing them as calldata.
- **Faucet rate limit — RESOLVED.** 20 USDC per address, per chain, every 2 hours. Verified 5 Sep 2026. No custom token needed; `USDX` is struck from the build.
- **`maxAutomaticTokenAssociations = -1` does NOT mean pre-associated.** It means *unlimited auto-association slots*. An association is only created for a transfer that is **eligible** for auto-association, and the Circle USDC faucet transfer is not. Into an unassociated account the drip is silently lost — no error, no pending airdrop, no transaction at all — **and it still burns the 2-hour window.** Always run an explicit `TokenAssociateTransaction` first. This cost us a wasted drip and an hour of misdiagnosis on day 0.
- **KYC needs association too.** Granting KYC requires the token to be associated with the account *even when that account has unlimited auto-associations*. The seed script must associate every demo account with the bond **before** granting KYC, or the failure demo fails for the wrong reason.
- **Verify any token id against the mirror node before trusting it.** Testnet has dozens of impostor tokens named `USDC`. A web search confidently returned `0.0.13078`; that is `NFTBURNIUB623`, an NFT with zero supply. The real one is `0.0.429274` — name "USD Coin", 6dp, memo `"USDC HBAR"`, confirmed on-chain.
- **No HCS precompile.** HIP-478 never shipped. Backend SDK only.
- **Mirror node lag.** Confirm optimistically on the receipt; reconcile from the mirror node after.
- **ATS monorepo setup is slow.** `npm run ats:setup` compiles the whole diamond. Do it once on day 1, in the background, while you do something else.
- **Node version.** ATS needs Node ≥ 20.19.4. Pin it. `.nvmrc` is in the repo.
- **`0` expiration means never expires.** If you pass `0` thinking it means "immediate", the seller can never reclaim. Always set a real timestamp.
- **Signature replay.** Nonces must be consumed inside `settle`, not checked and forgotten.
- **The reveal-loss failure.** A dealer who closes their tab loses the nonce and forfeits. localStorage + an explicit warning.

---

## 11. Scope discipline

Ship in this order. Cut from the bottom.

1. Atomic DvP settlement with ATS holds, Path A — **non-negotiable**
2. Commit–reveal RFQ
3. HCS audit trail
4. Compliance failure demo
5. Path B — HIP-551 batch settlement
6. HIP-1215 scheduled coupons
7. Issuer portal
8. Oracle pricing

Items 1–4 win this track on their own. Item 5 is what makes it hard to place second.

**Roadmap line for the README and the last 10 seconds of the video** (costs zero build time): CLPR / Clipper, the cross-ledger protocol HIP currently open for comment, would let the cash leg settle on one ledger and the security leg on another with no bridge validator set and no wrapped asset — cross-ledger DvP for block trades. That is the natural next step for a venue built on hold-plus-batch settlement. Mention it as a direction, do not attempt it.
