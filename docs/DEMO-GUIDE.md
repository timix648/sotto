# Sotto demo and operator guide

This guide separates three different activities that are easy to confuse:

1. reviewing Sotto without credentials;
2. running the complete Path A browser flow with the configured testnet accounts; and
3. demonstrating the proven Path B HIP-551 batch from the repository script.

Sotto is deployed on **Hedera testnet**. Testnet HBAR and testnet USDC have no financial
value. Never paste a private key into the browser, a screen recording, an issue, or a commit.

## What is live today

| Capability | Browser | Repository / chain proof |
|---|---:|---:|
| Browse the venue, rulebook, public HCS audit and deployed contracts | Yes | Yes |
| Enter a clearly labelled funded demo desk | Yes | Yes |
| Path A: EVM wallet, exact USDC allowance, EIP-712 signatures and atomic DvP | Yes | Yes |
| Path B: connect a Hedera-native HIP-820 wallet | Yes | Yes |
| Path B: sign the cash leg and settle the batch from the browser | Yes, pending a wallet check | Yes, `settle-batch.ts` |
| Issue more units of a deployed ATS security | Local issuer demo only | Yes |
| Publish the reference NAV the settlement band checks against | Yes, issuer portal | Yes |
| Redemption at maturity: principal paid, then units burned | Yes, issuer portal | Yes, `redeem-demo.ts` |
| Deploy a brand-new bond instrument | Operator script, not the venue UI | Yes |

**The reference NAV expires, and that is the point.** `SottoNavOracle` refuses a reference
older than its bound (24 hours), so a venue left alone for a day will refuse to settle anything
until an administrator republishes. The issuer portal shows the reference's age and a
**Publish NAV** button, so a stale guard reads as a stated reason rather than a mystery revert.
Nothing republishes on a timer: an automated re-stamp of an unchanging number would leave the
staleness bound looking intact on-chain while making it impossible for it ever to fire.

**A demo can drain itself.** Cash flows dealer to seller and units flow seller to dealer, so
repeated runs move both one way. Check the balances on the desk before recording, and reload
the short-dated note from the issuer portal before demonstrating redemption twice - redemption
burns the holder's whole position.

That distinction is deliberate. The interface never labels the script-backed Path B handoff as
a completed browser settlement.

## The safest three-minute judge walkthrough

This route requires no private keys and does not move funds.

1. Open the landing page and state the product in one sentence: **an RFQ secondary market for
   ATS-issued securities, with sealed dealer quotes and atomic delivery-versus-payment.**
2. Open **Rulebook**. Show commit–reveal, ATS holds, compliance at transfer, and the two
   settlement paths.
3. Open **Enter the venue**, choose a demo desk, and point out that demo values appear only after
   the user deliberately enters a demo. Public browsing never invents a wallet balance.
4. Open **Audit trail**. Follow the HCS topic to HashScan and show that quote commits have lower
   consensus sequence numbers than their reveals.
5. Open the settlement transaction and the ATS bond contract from the links in the main README.
   The important claim is not a mock animation: the security and Circle testnet USDC moved on
   Hedera, and the Sotto contracts are verified.
6. Return to **Enter the venue** and hover the settlement-route switch. Path A is the live browser
   route; Path B exposes the native-wallet connection preview and truthfully describes the
   remaining browser handoff.

The public evidence is collected in [the main README](../README.md#proven-on-chain-not-asserted).

## Prerequisites

- Node.js **20.19.4** (the repository pins this in `.nvmrc`)
- npm and Git
- a free Reown project ID from [the Reown dashboard](https://dashboard.reown.com/)
- for owner-operated Path A transactions, an EVM wallet containing the configured seller and
  dealer testnet accounts
- for the Path B connection preview, a wallet supporting Hedera-native WalletConnect/HIP-820

The official Hedera WalletConnect package documents separate EVM and native routes and currently
lists HashPack, Kabila and Dropp as Hedera wallets. Its recommended integration is Reown AppKit:
[Hedera WalletConnect](https://github.com/hashgraph/hedera-wallet-connect).

### Install wallets only from their official pages

You do not need every wallet in this table. Install one Path A wallet and, only if you want to
show the Path B native-session preview, one Path B wallet.

| Demo use | Wallet | Official download | Notes |
|---|---|---|---|
| Path A — browser extension or WalletConnect QR/mobile | MetaMask | [metamask.io/download](https://metamask.io/download/) | Add Hedera testnet when prompted. |
| Path A — browser extension or WalletConnect QR/mobile | OKX Wallet | [web3.okx.com/download](https://web3.okx.com/download) | Its Hedera EVM account is suitable for Path A, not proof of a native Path B session. |
| Path B — Hedera-native WalletConnect | HashPack | [official HashPack download guide](https://hashpackapp.zendesk.com/hc/en-us/articles/17624331055633-Download-HashPack-for-desktop-and-mobile) | Prefer WalletConnect QR/deep-link for the native-session test; see issue #670 below. |
| Path B alternative — Hedera-native WalletConnect | Kabila | [kabila.app/docs/kabila-wallet](https://kabila.app/docs/kabila-wallet) | Supports Chrome, iOS and Android; verify native testnet support in the installed version. |

Never install a wallet from a search advertisement, forwarded APK, or unofficial extension page.
The demo uses testnet-only accounts, but recovery phrases and private keys must still remain secret.

## Install and configure

```powershell
git clone https://github.com/timix648/sotto.git
Set-Location sotto
nvm use
npm ci

Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local
```

Set only public browser configuration in `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_API_BASE=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000/ws
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_reown_project_id
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`NEXT_PUBLIC_*` values are bundled into browser JavaScript. **Never put a private key there.**

The root `.env` contains the operator account IDs, EVM addresses and private keys used by the
live API and scripts. Use `.env.example` as the schema. The deployed contract addresses in that
template are public; the account keys are not. `.env` and `frontend/.env.local` are ignored by
Git and must remain untracked.

## Verify before starting

```powershell
npm run build
npm test
npm run test:engine
npm run test:frontend
npm run typecheck:frontend
npm run build:frontend
```

The current expected result is:

- 32 contract tests pass;
- 14 RFQ-engine tests pass;
- 12 frontend utility tests pass;
- frontend type-check and production build pass.

Do not run `npm audit fix --force` immediately before judging. It can introduce breaking major
dependency changes. Review and upgrade advisories deliberately after the demo branch is stable.

## Start the full application

Use two terminals from the repository root.

Terminal 1 — live Hedera testnet API:

```powershell
npm run serve
```

Terminal 2 — frontend development server:

```powershell
npm run dev:frontend
```

For a production-like local run, build first and use:

```powershell
npm run build:frontend
npm run start --workspace @sotto/frontend
```

Open [http://localhost:3000](http://localhost:3000). Verify the backend before presenting:

```powershell
Invoke-RestMethod http://localhost:4000/api/health |
  Select-Object ok,network,mock,settlementAddress,topicId
```

The response must contain `ok: true`, `network: testnet`, and `mock: false`. Port 4010 is the
fixture server and should never be used in a live-chain recording.

## Wallet modes

### Path A — live EVM browser settlement

On `/enter`, leave **Path A** selected and choose **Connect EVM wallet**. Reown AppKit discovers
installed EIP-6963 wallets and also offers WalletConnect QR/deep-link connectivity. The wallet
must be on Hedera testnet (chain ID 296).

Path A is the complete web flow:

1. the configured seller wallet creates the ATS hold and opens the RFQ;
2. the configured dealer wallet commits a sealed price and keeps its nonce in that browser;
3. after the commit window closes, the dealer reveals;
4. the seller allocates and signs the EIP-712 trade;
5. the winning dealer approves the **exact** Circle testnet USDC notional, signs, and settles;
6. the receipt shows both legs or a full revert.

Use only accounts already funded, associated with USDC, granted ATS KYC, and seeded with the
required asset. Switching to an unrelated wallet address is valid for browsing but cannot act as
one of the configured demo parties.

### Path B — native connection preview and script-backed settlement

Switch to **Path B** on `/enter`, then choose **Connect Hedera wallet**. Use WalletConnect QR or a
wallet deep link when testing the native session. An upstream Hedera WalletConnect issue reports
that HashPack's direct injected button can establish an EVM session instead of a native one;
QR/deep-link is the reliable test path until that issue is closed:
[hashgraph/hedera-wallet-connect#670](https://github.com/hashgraph/hedera-wallet-connect/issues/670).

Success for the current browser preview means the modal connects a `hedera:testnet` account and
the Sotto button displays its `0.0.x` account ID. **A connection is not a transaction signature.**
The current browser intentionally shows that Path B RFQ submission is not wired and will not
pretend a signing popup should appear.

The complete Path B proof is run by the operator script:

```powershell
npx tsx backend/src/scripts/settle-batch.ts
```

It constructs a HIP-551 `BatchTransaction` with a buyer-signed native HTS USDC transfer first
and `SottoSettlement.deliver(...)` last, then the authorised relayer assembles and submits the
batch. This command changes testnet state and requires the configured accounts to have sufficient
HBAR, USDC and bond balance.

Why the remaining browser handoff is not cosmetic: the deployed `deliver()` still verifies both
parties' EIP-712 trade signatures, while the native wallet separately signs the HTS cash
transaction. A production browser flow must collect and validate both authorisations, validate
the signed cash leg on the server, batchify it with the relayer key, and submit without ever
exposing that key. The README calls out the relayer trust trade-off explicitly.

## Funding testnet accounts

Use the [Hedera developer portal/faucet](https://portal.hedera.com/) for testnet HBAR. Circle's
official public [testnet faucet](https://faucet.circle.com/) supplies testnet USDC; Circle lists
the Hedera testnet token as `0.0.429274` in its
[contract-address reference](https://developers.circle.com/stablecoins/usdc-contract-addresses).

Before requesting USDC, associate the Hedera account with the token:

```powershell
npx tsx backend/src/scripts/associate.ts
```

Then request Hedera testnet USDC for the **`0.0.x` account ID**, not its `0x` EVM address. The
Circle faucet currently allows 20 testnet USDC per address, per chain, every two hours. Testnet
tokens have no monetary value.

## Demo mode, issuer controls and bond creation

- Demo values remain hidden until a user explicitly opens a demo desk.
- Seller and dealer demo desks are safe for inspection. Creating a hold and completing a trade
  still require the matching wallets because the venue must not sign for users.
- Issuer KYC and unit issuance are local-admin demo actions. The backend holds the issuer key, so
  those routes must not be exposed publicly without authentication or issuer-wallet signing.
- **Issue units** adds supply to the already-deployed ATS bond. It does not create a new bond.
- A brand-new bond is intentionally an operator deployment workflow in
  `backend/src/scripts/deploy-bond.ts`. Running it changes chain state and may update the active
  address in `.env`; it is not part of the normal judging walkthrough.
- Active RFQs and collected seller signatures are stored in memory. Restarting the API clears
  them, while completed on-chain transactions and HCS records remain public.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Header says the API is offline | Start `npm run serve`; verify port 4000 and `/api/health`. |
| Fixture-data warning appears | `NEXT_PUBLIC_API_BASE` points to port 4010; change it to 4000. |
| Wallet asks to add a network | Approve Hedera testnet: chain ID 296, RPC `https://testnet.hashio.io/api`. |
| OKX connects but native methods fail | That is an EVM connection. Use it for Path A; use a HIP-820 wallet for Path B. |
| HashPack direct button gives the wrong session | Use WalletConnect QR/deep-link; see upstream issue #670 above. |
| No Path B signing popup appears | Expected today: native connection is a preview; RFQ batch execution is script-backed. |
| Issuer cannot create a new bond | The UI issues units of the configured bond; new instruments use the operator script. |
| A fresh USDC faucet request disappears | Associate token `0.0.429274` before requesting the drip. |
| A new RFQ vanished | The API restarted; active RFQs are currently in memory. |

## Recording checklist

- show `mock: false` once;
- never expose `.env`, private keys, wallet recovery phrases, or QR session secrets;
- use the visible demo labels when showing fixture accounts;
- show at least one HashScan transaction and the HCS topic;
- say **testnet USDC**, not real-value dollars;
- say Path A is browser-live and Path B is chain-proven/script-backed;
- keep the video under the hackathon's five-minute limit.

Official references:

- [ETHOnline 2026 — Hedera Tokenization of Anything](https://ethglobal.com/events/ethonline2026/prizes)
- [Hedera documentation](https://docs.hedera.com/)
- [Hedera WalletConnect](https://github.com/hashgraph/hedera-wallet-connect)
- [Circle testnet faucet](https://faucet.circle.com/)
- [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [HashScan testnet](https://hashscan.io/testnet)
