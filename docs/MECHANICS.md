# MECHANICS — domain reference extracted from Umbra

Umbra is a private OTC block-trading venue built on Canton Network in Daml. This document
describes its **domain model** — roles, lifecycle, invariants and the failure modes hit while
running it live. It contains no source code and no Daml. Nothing here is a design proposal.

Source: 186 commits across `main`, `v1` and `wallet-integration`; the Daml modules and their
test suites; the backend route surface; the README and demo script.

> **Provenance caveat.** This extraction was produced by a session that had already read the
> Sotto blueprint, contrary to the usual isolation rule. It was written by deliberately
> reporting what the source says rather than what would fit that design, but where this
> document and the blueprint agree, treat the agreement as weaker evidence than if it had
> been extracted blind. The failure modes in §4 are drawn from commit messages written during
> live debugging and are the least susceptible to that bias.

---

## 1. Roles

Umbra has four durable party types plus two that appeared as the venue matured.

| Role | May do | Must never be able to do |
|---|---|---|
| **Requester** (buyer / initiator) | Raise a request naming an offered asset, an offered amount and a wanted asset. Invite named dealers. Cancel the request. Lift a quote while it is firm. Commit its own offer leg. Withdraw its own proposal or allocation. Abort a settlement before execution. | See a dealer's quote before it is submitted. Lift a quote after its firmness window. Move a dealer's asset. Cause its own leg to move without the counter-leg moving. |
| **Dealer** | Answer an invitation with a price, or decline. Commit its own want leg. Accept a settlement proposal. Withdraw its own allocation. List and delist itself from the dealer directory. | See another dealer's price, another dealer's existence, or how many rivals were invited. Quote after the request window closes. Be paid a rival's price. Have its asset moved without receiving the offer leg. |
| **Operator** (the venue) | Curate the on-ledger set of tradeable assets. Observe requests, invitations, proposals and settlements. Fire the execution choice once both principals have signed. Perform bookkeeping steps under an explicit standing mandate. | Forge any party's authority. Observe a quote. Move value on its own signature alone. Commit a party to a price. |
| **Asset admin / issuer** | Issue holdings of its own asset. Observe holdings and allocations of its asset. Supply the registry context needed to execute a real allocation. | Participate in price formation. See a quote or a request. |
| **Fee party** (added later) | Receive a venue fee as a third leg in the same transaction as the trade. | Cause the trade to succeed or fail independently of the fee, in either direction. |
| **Wallet party** (bring-your-own-wallet) | Everything its underlying role can do, signing with a key the venue never holds, hosted on its own validator. | Be acted for by the venue. Be visible to the venue's participant at all if the venue does not host it. |

The critical structural property: **the operator is deliberately not an observer on a quote.**
That is the blind auction working as intended, and it has consequences throughout the backend
— the venue genuinely cannot read a contract it is not a stakeholder on, so any endpoint that
needs quote data must take it explicitly rather than looking it up.

---

## 2. RFQ state machine

### States

| State | Created by | Signed by | Visible to |
|---|---|---|---|
| **Request open** | Requester raises a request | Requester | Operator, invited dealers |
| **Invited** | Requester invites one dealer | Requester | That dealer only |
| **Quoted** | Dealer submits a price | Dealer | Requester only |
| **Awarded / proposed** | Requester lifts a quote | Requester | Dealer, operator |
| **One leg committed** | Requester commits its offer leg | Requester | Dealer, operator |
| **Pending counterparty** | Requester proposes a real settlement | Requester | Dealer, operator |
| **Settled record** | Both principals' authority gathered | Requester **and** dealer | Operator |
| **Executed** | Operator fires execution | — | Terminal; both legs moved |

### Transitions

| From | Transition | Authorised by | Guard |
|---|---|---|---|
| Request open | Invite a dealer | Requester | Dealer must be on the request's invited list |
| Request open | Cancel the request | Requester | — |
| Invited | Submit a quote | Dealer | Price positive; **now before the request's expiry**; firmness deadline in the future |
| Invited | Decline | Dealer | — |
| Quoted | Lift the quote | Requester | **Now before the quote's firmness deadline** |
| Awarded | Commit offer leg (stand-in) | Requester | — |
| Offer committed | Commit want leg (stand-in) | Dealer | — |
| Awarded | Record a real swap | Requester **and** dealer jointly | — |
| Awarded | Propose a real swap (signed mode) | Requester | — |
| Pending counterparty | Accept | Dealer | — |
| Pending counterparty | Withdraw | Requester | — |
| Settled record | Execute (stand-in) | Operator | Record must be marked stand-in |
| Settled record | Execute real | Operator | Record must be marked real; registry contexts supplied |
| Settled record | Abort | Requester | Before execution |

Two paths exist to the same settled record because **interactive submission accepts only
single-party submissions**. The two-party joint transition works when the venue holds both
keys; the propose-then-accept pair exists so that each step is one party's signature, which is
what a wallet can produce. Both converge on an identical settled record.

### Timeouts, by state

| State | Timeout | Effect |
|---|---|---|
| Request open | Request expiry | Dealers can no longer quote. Enforced by the ledger, not the UI. |
| Quoted | Quote firmness deadline | Requester can no longer lift that price. Ledger-enforced. |
| Awarded, legs allocated | Allocation deadline | The allocation may no longer be executed. |
| Awarded, legs allocated | Settlement deadline | **The registry clears the lock by itself.** Measured on a deliberately stranded trade: the holding was returned untouched 2m22s after the settlement deadline, with no action by the owner. |
| Pending counterparty | None inherent | A proposal sits until accepted or withdrawn — a state that stalled trades in practice (see §4). |

Request windows were originally hardcoded at fifteen minutes and later made buyer-selectable
from five minutes to a day. Quote firmness originally *inherited* the request's close time,
which silently committed a dealer to holding a price for a full day once long requests became
possible; it was subsequently capped independently, defaulting to thirty minutes.

---

## 3. Invariants

These are the rules the system must never violate. They are the most valuable part of the
repository. Those marked **proven** have a headless test that fails if the property breaks.

### Value conservation

1. **No settlement may mint.** A leg must never deliver more than the sender's backing holding
   contains. This was violated once and is the single most important lesson in the repo: the
   original execute body archived the input holding and credited the receiver the full leg
   amount *regardless of balance*, so an underfunded trade settled anyway and created value
   from nothing. Both legs now assert the holding covers the amount. **Proven, both legs
   independently.**
2. **Both legs move or neither does.** Execution of the two legs happens in one indivisible
   transaction. **Proven.**
3. **Change returns to the sender.** Over-funding a leg returns the remainder to the sender in
   the same transaction. **Proven.**
4. **A failed settlement strands nothing.** Allocations are released and the request re-opens.
   With one honest exception: legs allocated by an external wallet are *never* withdrawn by the
   venue, because the venue has no authority over them — they expire on their own deadline
   instead.
5. **Backing is checked against the sum of holdings, not the largest one.** A party with
   fragmented balances must not be told it is short when its total is sufficient.
6. **A fee, if charged, moves in the same transaction as the trade.** It must not be possible
   for the fee to succeed while the trade fails, or the reverse.

### Authority

7. **Each party commits its own leg under its own authority.** The sender is the signatory on
   its own allocation. The venue never signs for a principal.
8. **Execution requires authority gathered from both principals.** The settled record carries
   both signatures, so the operator's execution choice inherits every authority the nested leg
   transfers need. The operator alone cannot move anything.
9. **A party's asset may only be moved by a transaction that party signed.** In signed mode
   this holds even though the venue coordinates the flow.
10. **The venue must not be able to be the unintended recipient of a leg.** Violated once, in
    the most serious settlement bug in the repository (§4).

### Privacy

11. **A dealer can never see a rival's quote, price, count or existence.** Enforced by ledger
    disclosure, not by the frontend. Verifiable by role-scoped reads returning different
    results for the same endpoint.
12. **The operator is not a stakeholder on a quote.** The venue itself cannot read prices
    during the auction.
13. **A public reader sees nothing at all.**
14. **Each dealer is paid its own quoted price, never a rival's.** Explicitly tested by running
    two concurrent trades on the same pair *and the same offer amount*, so that nothing could
    be matched by amount, then interleaving their settlement rounds.

### Temporal

15. **A late quote is refused by the ledger.** Not greyed out in the UI — refused. **Proven.**
16. **A stale price cannot be lifted.** **Proven.**
17. **Expiry is terminal.** An expired request does not reopen.

### Referential integrity

18. **A quote must be attributable to exactly the request it answers**, by identity, not by
    guessing from matching amounts. The request's identity is threaded down through the
    invitation to the quote.
19. **Cancelling a request must actually cancel it.** Invitations and quotes are separate
    contracts that outlive the request; without an explicit check back to the request, a
    cancelled request remained quotable and liftable. Both the quote and the accept steps must
    re-read the request they answer.
20. **An asset is tradeable only if listed in the on-ledger registry.** The valid asset set is
    auditable, not a hidden backend constant. Listing is idempotent. **Proven.**
21. **A run must identify the request it created by identity**, because a non-consuming request
    outlives a run and a naive matcher will reuse an older one and stack duplicate invitations
    onto it.

### Settlement engine shape

22. **No per-asset branches.** Every asset is an ordinary asset identified by issuer plus
    symbol; two holdings are fungible only if both match. The same path settles every pairing,
    including two non-cash legs against each other. There is no privileged "cash leg".
23. **The registry is resolved from the asset's own issuer**, never from a default. Two assets
    worked by coincidence when they happened to map to the default registry; a third did not.
24. **A settled trade must record what was traded**, not merely point at the allocations.
    Allocations are consumed on execution, so a settlement holding only pointers left no
    readable trace of the trade afterwards.
25. **Record the absence of a price rather than inventing one.** Where no reliable public price
    exists, the mark is recorded as absent, and the UI shows a dash with a stated reason.

---

## 4. Failure modes

The payload. Every item below was hit in practice. Grouped by class, because the classes
recur.

### 4.1 The mint hole — the most serious bug in the repository

**What broke.** The allocation execute body archived the sender's input holding and credited
the receiver the full leg amount without ever comparing the amount to the holding's balance.

**Symptom.** An underfunded trade settled successfully. Cash appeared from nothing. There was
no error, because nothing checked.

**Fix.** Explicit assertions in both legs that the holding covers the amount, plus two separate
headless tests — one funding the buyer short, one funding the seller short — that assert the
whole transaction aborts. The tests exist specifically so the hole cannot silently reopen.

**Lesson.** The dangerous class here is not a transfer that fails; it is a transfer that
succeeds when it should not. A settlement engine needs a test that a *bad* trade is refused,
not only that a good trade works.

### 4.2 Leg misrouting — the want leg paid to the venue

**What broke.** Legs were allocated using the literal role name as sender and receiver, and
the requester was hardcoded to the demo party across the settlement, execution, request,
invite and accept endpoints.

**Symptom.** Invisible while the venue *was* the requester — every demo passed. With any
non-demo requester, **the want leg was paid to the venue rather than to the party that raised
the request.** Separately, the execution step submitted as the requester when the choice is
controlled by the operator: identical while those were the same party, wrong the moment they
differed.

**Fix.** Read the requester from the contract payload, and take an explicit requester where the
venue cannot see the contract — which it often cannot, because the operator is deliberately not
an observer on a quote.

**Lesson.** Any place where a role name stands in for a party identity is a latent misrouting
bug that a single-party demo cannot reveal. Test with the venue and the counterparty as
*different* parties.

### 4.3 The async-acceptance race — a long, expensive investigation

This one ran for days and is worth reading as a sequence, because each fix revealed the next
layer.

**What broke.** In signed mode, submission is asynchronous: an HTTP 200 means *admitted*, not
*committed*. Nothing read the ledger's completion stream, so a slow commit, an outright
rejection and a genuinely lost transaction were indistinguishable — all surfaced as one
timeout, with the ledger's real reason discarded.

**Symptom.** Settlements reported "timed out waiting for the pending contract". Of five
submissions, all five had actually committed; two landed inside the polling window and settled,
three landed outside it, were declared failures, had their allocations withdrawn, and left
orphaned pending contracts on the ledger. The rollback stranded a live pending swap against
allocations that had just been withdrawn — *the rollback was the damage*.

**Fixes, in the order they were applied:**

1. A read-only diagnostic that separated the candidate causes from ledger state — late commit,
   silent rejection, or a package filter that could not see the contract — submitting nothing,
   so it was safe to run against the live deployment.
2. Read command completions. Correlate a submission with its completion by generating the
   command id up front and returning it. Report the ledger's real rejection reason.
3. **Never roll back after the propose has committed.** This was the actual damage mechanism.
4. Widen the window, and make every window an environment variable rather than a constant.
5. Measure the commit latency instead of guessing it.

**The measurement that reframed the problem.** Two different submissions both reported
committing after an identical 6231ms. An identical figure from two independent submissions is
not a latency measurement — it is the polling cadence of the completion reader, which holds the
stream open for a fixed idle timeout before returning. Real commit time was well under that,
plausibly around three seconds, and therefore *comfortably inside* the original window that had
been timing out. Which left the real question unanswered: if the commit is that fast, why did
the poll fail?

**The answer, and the generalisable lesson:** a completion can arrive *before* the contract is
visible in the active-contract set. The poll was not waiting on commit at all — it was waiting
on **contract visibility**, which is a different and later quantity. Every timeout in the file
had been sized against the wrong measurement. The final change was to log time-to-visibility
directly, so the window could be sized against the quantity it actually waits on.

**Lesson.** When a distributed system times out, establish *which* quantity you are waiting on
before tuning the wait. Three separate windows in this codebase had been set by estimate, and
all three were estimating the wrong thing.

### 4.4 Diagnostics that lie

**What broke.** The orphan-detection script read allocation field names taken from the *choice
arguments* rather than the *contract fields*. Both reads returned nothing.

**Symptom.** The "is this dead?" test short-circuited to false, so every orphaned contract was
reported as "allocations intact — may still be completable". A reassuring verdict produced
entirely by reading absent fields.

**Fix.** Read the correct names, and report *unknown* rather than a reassuring default when the
fields are absent.

**Related.** A "no verdict, falling back to polling" message was logged even when the feature
was simply switched off, which read like a ledger failure when it meant nothing at all.

**Lesson.** A diagnostic that returns a comforting answer when its inputs are missing is worse
than no diagnostic. Absent input must produce *unknown*, never *fine*.

### 4.5 Registry resolution

**What broke.** The registry was resolved from a default URL rather than from the asset's own
issuer. Two of the three assets mapped to the default and worked *by coincidence*; the third
lives on a different service.

**Symptom.** A misleading "given holdings are invalid" from the wrong registry. Separately,
accepting a transfer of the third asset returned "offer not found". The main trading path
always passed the registry explicitly, so only direct callers — such as a wallet — hit it.

**Lesson.** A default that happens to be correct for most cases hides the bug until a new case
arrives, and then reports it as something else entirely.

### 4.6 Ordering and lifecycle

- **Allocate the real legs before running the auction**, not after — the registry requires that
  ordering.
- **A consuming choice leaves the trade unreachable.** The propose step archives the proposal,
  so the next settlement call returned a 404 and the UI reported the settlement refused when it
  was merely awaiting the counterparty. Endpoints were added to reach a trade in that
  intermediate state.
- **Both sides need a route back in.** Settlement alternates between two wallets and neither
  browser can sign for the other. A winning dealer had no route to allocate or accept, so the
  trade stalled with the buyer's funds locked and nothing on screen explaining why.
- **A party with its own wallet had no withdraw route at all.** The rollback path skips wallet
  legs because the venue holds no key, and the withdraw endpoint had no branch for them — so a
  settlement that died on the counterparty left that side locked with no way out.

### 4.7 Upgrade and packaging

- **A Daml upgrade may only append fields.** Reordering the settlement record's fields had the
  participant reject the package outright.
- **New fields in an upgrade must be optional.** Mandatory new fields made the version an
  illegal upgrade of the already-vetted predecessor, and package vetting rejected it.
- **Choose fallbacks that fail safe.** When the new deadline fields were made optional, the
  fallback was set to a time deliberately in the past, so a pre-upgrade record reads to a
  wallet as *already expired* rather than as a settlement with no deadline at all.
- **Publish the version you actually run.** Vetting instructions pointed at an older build than
  the deployment, so an operator following them would vet a version that could not take part in
  a fee-bearing trade.
- **A wallet cannot sign for a package its validator has not vetted.** An earlier claim to the
  contrary was corrected after a real wallet refused. A party whose participant lacks the
  package sees nothing at all — which renders as an empty venue with no explanation unless the
  app checks and says so.

### 4.8 Authority gaps

- **A fee receiver must authorise its own allocation.** The first fee implementation failed
  because the receiver was not a signatory on the settlement, leaving the transaction one
  authority short. Resolved by collecting the fee to a party the operator already holds
  authority for, as the controller of the execution choice.
- **Batching invitations is blocked by the submission model.** Inviting every dealer in one
  transaction requires creating and exercising in one step, and interactive submission rejects
  a transaction with more than one root node. The workaround is a choice on an *existing*
  contract — which is also what made a standing mandate viable, dropping a two-dealer trade
  from eleven wallet signatures to six and making request-opening cost none.
- **In signed mode the operator is itself an external party**, so a plain submit-and-wait is
  refused; those submissions must go through the signing path too.

### 4.9 Rate limits and third-party quotas

- Reading a party's data through a hosted wallet API at the venue's normal two-and-a-half
  second cadence earned **a run of HTTP 429s within a minute**. A wallet-backed party was moved
  to a fifteen-second cadence.
- Guarding by slowing the poll was insufficient, because the load function runs on every effect
  re-run and its identity changes often — the interval was never the only trigger. The guard
  had to move to the call site, spacing calls and stopping for a minute after a rejection.
- The backoff that was meant to trigger never fired, because the status code never reached the
  message being matched.
- A read is somebody else's quota. Poll accordingly.

### 4.10 UI failures that destroyed trust in the system

These matter more than they look: several made a working settlement *appear* broken.

- **A settlement receipt telling the user they would receive nothing.** The amount formatter
  capped at three decimals, so a small leg rendered as zero.
- **A live price rendered as `0.0000`** by a fixed four-decimal format, making a real mark look
  like a broken feed.
- **`[object Object]` in the fee display**, because the formatter returned a rendered element
  below a threshold and a string above it — so concatenation worked for ordinary sizes and
  broke for exactly the range the fee occupied.
- **A basis-point figure reading "plus one and a half million"** for a block priced far from the
  mid, which reads as a broken calculation rather than a mispriced trade. Replaced with a
  plain "off market".
- **An unkillable failure banner**, from three independent defects at once: dismissal was
  local-only and a polling effect reset it every eight seconds; the alerts had no id, no expiry
  and no acknowledge route, so they were dropped only by a length trim; and the alert was
  pushed unconditionally while ignoring the flag saying whether the request had actually
  reopened — so a dealer was invited to re-quote on a request that did not exist. It outlived
  the trade, the request and its expiry, and only a restart cleared it.
- **A successful settlement displayed as a failure**, because the success check read a field
  that was undefined.
- **The same asset shown under two different tickers** in two panels, one reading the raw ledger
  id and the other the mapped symbol.
- **A holdings panel showing assets the party did not own**, from an issuer-observer/owner
  mismatch in the query.
- **Sign-out that bounced straight back in**, because it cleared the app role but left the
  wallet connected, and the sign-in screen re-entered as soon as a wallet resolved.
- **A restored session with broken signing**, because the session store held who was signed in
  but the wallet connection is established by the sign-in screen, which a restored session
  skips.
- **The venue appearing to quote against itself**, because the dealer directory advertised every
  onboarded party — including an abandoned test wallet and the venue's own fee party, the
  latter selectable to price a block.
- **A wallet extension prompting for a signature on page load**, from loading a redundant
  bundle, which looked like the venue asking for a signature nobody requested.

### 4.11 Security

**Private keys were committed to the repository.** The ignore rule matched the pattern but
never untracks an already-committed file, so the demo parties' keys remained in git history and
had to be treated as public from that point on.

**Lesson.** Adding a pattern to the ignore file does nothing about what is already tracked.
Check what is tracked *before* the first push, not after — and once a key is in history, treat
it as compromised rather than trying to remove it.

---

## 5. API shape

Roughly sixty routes, in four families. Names and responsibilities only.

### Legacy RFQ and DvP

| Route family | Responsibility |
|---|---|
| Create request; invite a dealer | Open a request and issue private per-dealer invitations |
| Quote an invitation | A dealer prices a request |
| Read quotes | **Role-scoped** — the same route returns different results per caller, and nothing to the public. This is the privacy demonstration. |
| Accept a quote | Lift a price and lock the first leg |
| Settle | Fire the two-leg atomic swap |
| Fund cash / fund instrument | Seed demo balances |
| Award | Run the auction and settle in one call |

### Unified swap engine

| Route family | Responsibility |
|---|---|
| Create request; invite; close | Lifecycle of a generalised request |
| Quote; accept | Dealer prices; requester lifts |
| Commit offer leg; commit want leg | Each party commits its own side |
| Execute | Fire the stand-in settlement |
| Settle real | Drive the real-registry settlement path |
| History; holdings; registry; seed registry | Read the book, balances and the tradeable asset set |
| Alerts; acknowledge alert | Dealer-facing failure notifications, acknowledged server-side |

### Real-registry integration

| Route family | Responsibility |
|---|---|
| Holdings; raw; allocations; pending | Read-only probes against the real registries. Each was added as a *diagnostic first*, before the corresponding write path. |
| Allocate | Lock a real holding into an allocation |
| Accept pending transfer | Land an incoming registry transfer |
| Settle; execute | Atomic multi-leg execution with registry contexts and disclosures |
| Withdraw | Release an allocation |
| Send | Move real tokens between parties |
| Award | Auction plus real settlement end to end |

### External signing and wallets

| Route family | Responsibility |
|---|---|
| Onboard prepare / confirm | Allocate a party from a **public key only**, so the server never holds the private key. Split so the wallet signs the topology hash itself. |
| Prepare / execute | Split interactive submission so the signature step stays with the party's wallet. Execute reports the ledger's verdict rather than a bare async-accepted 200. |
| Mode | Toggle signed mode; also serves the fee schedule so the UI can show a dealer its cost before the price is sealed |
| Package | Serve the package so a validator operator can vet it themselves |
| Ledger end; contract by id | Read the ledger directly — backs a "click a settled contract id and read the record off the ledger" proof |

**Shape lessons.** Read-only probes preceded every write path, and the probes are what found
the bugs. Health, ledger-end and contract-by-id exist so a claim can be verified against the
ledger rather than believed from the UI. A build flag on the registry routes returns assembled
commands and disclosures instead of submitting, which is what lets a wallet sign them.

---

## 6. Demo lessons

**The reveal is the demo.** The scripted sequence is built around one moment: two dealers
quote; the same quotes endpoint is called as dealer one, then dealer two, then the requester.
The first two return one quote each — their own. The third returns both. The privacy claim is
demonstrated by three calls to one endpoint returning three different answers, and it is
annotated in the script as *the reveal*.

**The abort is scripted as a first-class scene**, not an afterthought: fund short, accept a
quote that exceeds the funding, show the rejection. The failure path was demoed deliberately
from the very first demo script.

**Show the failure honestly or the success is not believed.** Repeated commits pull the
presentation *back* from claims: no bid/ask spread is shown because a public feed provides only
a mid and inventing a spread in a trading venue is worse than showing nothing; a pair with no
reliable price shows a dash with a stated reason; the README explicitly states which custody
properties are and are not proven. A claim that a wallet could sign without vetting was
retracted once a real wallet refused.

**Roles need to be visible at a glance.** Two dealers were run as two separate browser sessions
so neither could see the other, which is what makes the privacy claim legible on camera rather
than asserted.

**Small numbers break demos.** Multiple formatting bugs made real values render as zero — a
receipt that said the user would receive nothing, a live mark shown as `0.0000`. In a venue
demo, the numbers *are* the product.

**A stalled trade with no explanation is the worst demo outcome.** Several failures showed as a
frozen screen with funds locked and nothing on screen saying why. The recurring fix was to
surface the real reason and offer the route back in.

**Diagnostics had to be written in a different language than the shell** because a party
identifier was being mangled passing through the shell into the runtime — a reminder that demo
tooling is itself a source of demo failures. Separately, demo scripts submitting a ledger id
where the UI submits a ticker caused the same asset to display under two names.

**The infrastructure resets.** The deployment ran on a network that resets periodically, with
balances re-funded from issuer faucets — so the demo environment had to be re-seeded, and
seeding was a routine step rather than a one-off.

**Diagnostics only existed in one place.** Eleven diagnostic scripts lived only on the
deployment host and one only on the dev box, so a single machine failure would have lost all of
them. They were committed after a scan for secrets.

---

*End of extraction.*
