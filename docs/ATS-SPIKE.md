# ATS spike — findings

Everything below was read from `reference/ats/` source and docs, or verified on-chain via
the mirror node. Nothing is from memory. Where this contradicts `BLUEPRINT.md §A2`, the
source wins.

## Verified on-chain

| Thing | Value | Status |
|---|---|---|
| Factory Proxy | `0.0.7708432` → `0x5fA65CA30d1984701F10476664327f97c864A9D3` | live, not deleted, created 2026-01-22 |
| BLR Proxy (resolver) | `0.0.7707874` → `0xEFEF4CAe9642631Cfc6d997D6207Ee48fa78fe42` | live |
| USDC | `0.0.429274`, symbol `USDC`, name "USD Coin", 6dp, treasury `0.0.5176`, memo `"USDC HBAR"` | correct — see §Cash below |

## Version question — RESOLVED

The blueprint calls the factory "v4.0.0". The factory was deployed **2026-01-22**, when the
current SDK was **3.1.0**; SDK **8.0.0** shipped 2026-06-24, five majors later. That looked
like a serious ABI mismatch.

It is not. `reference/ats/docs/ats/developer-guides/contracts/deployed-addresses.md` — at the
repo HEAD that *ships SDK 8.0.0* — lists exactly `0.0.7708432` and `0.0.7707874` as the
current testnet deployment, and `sdk-integration.md` uses them in its own config example.
The proxy address is stable while the implementation behind it is upgraded; that is the whole
point of the proxy/BLR pattern. **SDK v8 + factory `0.0.7708432` is the documented pairing.**

Do not "fix" this by pinning an old SDK.

## Corrections to BLUEPRINT §A2

§A2 says: *"`issueBond()` — via the SDK: name, symbol, ISIN, nominal value, coupon rate,
coupon frequency, maturity date, partitions."* That list is wrong in three ways.

**1. The method is `Bond.createFixedRate()`, not `Bond.create()`.**
`Factory.deployBond` returns `SecurityType.BondVariableRate` — `Bond.create()` gives a
*variable* rate bond. Our demo bond has a fixed 4.5% coupon, so it needs
`createFixedRate()`, which adds `rate` and `rateDecimals` to the request.

Available: `create`, `createFixedRate`, `createKpiLinkedRate`,
`createSustainabilityPerformanceTargetRate`.

**2. Coupon rate and frequency are NOT issuance parameters.**
They do not appear on any create request. Coupons are scheduled *after* creation via
`Bond.setCoupon()` (with start/end dates), and read back with `Bond.getAllCoupons()`.
`Bond.cancelCoupon()` and `Bond.updateMaturityDate()` also exist. This changes the shape of
A2's `issueBond()` — it is two steps, not one.

**3. `configId` and `configVersion` are required and the blueprint never mentions them.**
`configId` is a 32-byte hex string, `configVersion` a number. An agent that has not read the
source will invent these. Do not hardcode: the SDK ships
`resolveLatestConfigVersion` and `GetConfigInfo` queries — resolve at runtime.

## Fields §A2 omits that matter to our design

These are all required booleans on the create request and each one changes whether our
settlement path works:

| Field | Why we care |
|---|---|
| `isMultiPartition` | The whole hold flow is `...ByPartition`. Get this wrong and partitions do not behave. |
| `arePartitionsProtected` | Gates `protectedCreateHoldByPartition` (the EIP-712-authorised hold). |
| `clearingActive` | The two-step settlement gate. Interacts with our `settle()`. |
| `internalKycActivated` | **Needed for the KYC-revoke failure demo.** Without it KYC lives in an external contract. |
| `isControllable` | Controller/force-transfer operations. |
| `isWhiteList` | Approval list vs blocklist — mutually exclusive, per the web-ui docs. |

Also required: `currency`, `numberOfUnits`, `nominalValue`, `nominalValueDecimals`,
`startingDate`, `maturityDate`, `decimals`. Optional but relevant: `complianceId`,
`identityRegistryId` (ERC-3643), `externalKycListsIds`, `diamondOwnerAccount`,
`regulationType`, `regulationSubType`.

## Init shape (from `docs/ats/developer-guides/sdk-integration.md`)

`Network.init(new InitializationRequest({...}))` with `network: "testnet"`, a mirrorNode
baseUrl of `https://testnet.mirrornode.hedera.com/api/v1/`, an rpcNode baseUrl of
`https://testnet.hashio.io/api`, and `configuration: { resolverAddress, factoryAddress }`.

Wallet connection is `Network.connect(new ConnectRequest({...}))` with
`SupportedWallets.HWALLETCONNECT` (HashPack/Blade, needs a WalletConnect projectId) or
`SupportedWallets.METAMASK`. **Open question for the backend:** both connect paths are
wallet-oriented; a headless server-side issuance path needs confirming.

## Cash leg / USDC

`0.0.429274` is correct — verified on-chain (name "USD Coin", memo `"USDC HBAR"`, 6dp,
treasury `0.0.5176`). Beware: testnet has **dozens** of impostor tokens named USDC. A web
search claimed the id was `0.0.13078`; that is `NFTBURNIUB623`, an NFT with zero supply.
Always verify a token id against the mirror node before trusting it.

**Faucet:** 20 USDC per address, per chain, every 2 hours (the higher of the two figures
§A3 said were in conflict). **Confirmed working 2026-09-05** — 20 USDC landed on ISSUER and
DEALER once associated.

No custom token is needed. The buyer (winning dealer) is the only account that needs a cash
balance, because the cash leg is `transferFrom(buyer, seller, notional)`; the seller only
receives. DEALER holding 20 USDC covers the ~20 USDC demo notional on its own. So every
settlement can run on real Circle USDC with nothing minted for convenience — the outcome
§A3 calls materially stronger.

**A failed drip still consumes the 2-hour window.** The pre-association attempt burned
SELLER's window, so SELLER received nothing on the retry. Associate first, then drip.

**Association trap.** `maxAutomaticTokenAssociations = -1` means *unlimited automatic
association slots*, **not** *pre-associated*. An association is only created when Hedera
processes a transfer that is eligible for auto-association, and the Circle faucet transfer is
not. Without an explicit `TokenAssociateTransaction` the faucet transfer silently never
lands — no error, no pending airdrop, nothing. Run `backend/src/scripts/associate.ts` before
dripping. This belongs in §10's trap list.

Related, and it bites the failure demo: granting KYC requires the token to be associated
with the account **even when the account has unlimited auto-associations**. The seed script
must associate every demo account with the bond before granting KYC.

## Issuance: the real calldata shape

`Factory.deployBond(BondData, FactoryRegulationData)`. `Factory.sol` imports
`./IFactory.sol` (**not** the ERC3643 variant, which is an auto-generated copy for T-REX ABI
compatibility — do not read that one).

```
BondData
  SecurityData security
  BondDetailsData bondDetails
  address[] proceedRecipients
  bytes[]   proceedRecipientsData

SecurityData
  IBusinessLogicResolver resolver          <- BLR 0xEFEF4CAe9642631Cfc6d997D6207Ee48fa78fe42
  uint256 maxSupply
  ResolverProxyConfiguration { bytes32 key; uint256 version }   <- configId + configVersion
  ERC20MetadataInfo { string name; string symbol; string isin; uint8 decimals }
  Rbac[] rbacs                              <- { bytes32 role; address[] members }
  address[] externalPauses / externalControlLists / externalKycLists
  address compliance, identityRegistry
  bool arePartitionsProtected, isMultiPartition, isControllable,
       isWhiteList, clearingActive, internalKycActivated, erc20VotesActivated

BondDetailsData
  bytes3  currency          <- BYTES3, not a string. "USD" packed.
  uint256 nominalValue
  uint8   nominalValueDecimals
  uint256 startingDate, maturityDate

FactoryRegulationData
  RegulationType    { NONE, REG_S, REG_D }
  RegulationSubType { NONE, REG_D_506_B, REG_D_506_C }
  AdditionalSecurityData { bool countriesControlListType; string listOfCountries; string info }
```

`erc20VotesActivated` is a seventh flag the SDK request list does not surface.

Roles are in `constants/roles.sol` — `DEFAULT_ADMIN_ROLE = 0x00`, plus `ROLE_ISSUER`,
`ROLE_CONTROLLER`, `ROLE_KYC`, `ROLE_INTERNAL_KYC_MANAGER`, `ROLE_CORPORATE_ACTION`,
`ROLE_PAUSER`, `ROLE_CLEARING_VALIDATOR` and ~25 others, each a precomputed bytes32.
The failure demo needs the issuer to hold `ROLE_ISSUER`, `ROLE_CONTROLLER` and the KYC roles.

## Config resolution — read from the live BLR, verified

Queried `0.0.7707874` on testnet (`backend/src/scripts/resolve-config.ts`):

- **5 registered configurations**: `0x…01` through `0x…05`
- **every one is at version `1`** — **not `0`**. The ATS docs example shows
  `configVersion: "0"`, which would fail with `ResolverProxyConfigurationNoRegistered`.
  This is a live trap in the vendor's own documentation.
- 192 registered business logics (facets)

**The SDK does not map security type to config id.** `CreateBondFixedRateCommandHandler`
throws `"Config Id not found in request"` — the caller supplies it. So the mapping is
application knowledge that exists nowhere in the SDK or the docs.

**Unproven hypothesis** for which config is which. `SecurityType` is ordered
`BondVariableRate, Equity, BondFixedRate, BondKpiLinkedRate, Loan`, and there are exactly 5
configs, suggesting `0x…01`→VariableRate, `0x…02`→Equity, **`0x…03`→BondFixedRate**,
`0x…04`→KpiLinked, `0x…05`→Loan. Facet counts are 44/47/48/48/49, which is consistent but
not conclusive — configs 3–5 share almost no facet *addresses* with 1–2, so they were likely
registered from a later deployment batch.

**Decisive test:** attempt a deployment against `0x…03` and read the emitted event. Testnet
gas is free-ish and each account holds 100 HBAR. Do not spend more time inferring.

## ⚠️ THE BIG ONE: the deployed factory is v3.1.0, and HEAD reordered the struct

**Read this before writing any ATS calldata.**

The factory proxy `0.0.7708432` has an EIP-1967 implementation slot still pointing at
`0.0.7708430` — the **January 2026 implementation, never upgraded**. The docs label that deployment **contract version 4.0.0** (deployed 2026-01-22).

Repo HEAD ships v8.0.0 and **reordered all 17 fields of `SecurityData`**. Same fields, same
types, different order — so a different tuple, a different selector, and a call that cannot
dispatch.

| | |
|---|---|
| HEAD field order → selector | `0x29002951` — **absent** from the deployed bytecode |
| bools-first order (v3.1.0-ats through v5.0.0-ats) → selector | `0x5133f0e0` — **present** ✅ |

The failure mode is brutal: `execution reverted` with **no data**, no custom error, no reason
string, identical for every configId — because the proxy has no function to dispatch to. It
looks exactly like "wrong config" and is not.

`deployed-addresses.md` is correct about *addresses* while being five months stale about
*ABI*. Do not read struct definitions from HEAD.

**Deployed `SecurityData` order** (identical in v3.1.0-ats, v4.1.0-ats and v5.0.0-ats, so the deployed 4.0.0 uses it; the reorder landed between v5 and v8):

```
bool    arePartitionsProtected
bool    isMultiPartition
address resolver
        ResolverProxyConfiguration { bytes32 key; uint256 version }
        Rbac[] rbacs
bool    isControllable
bool    isWhiteList
uint256 maxSupply
        ERC20MetadataInfo { string name; string symbol; string isin; uint8 decimals }
bool    clearingActive
bool    internalKycActivated
address[] externalPauses
address[] externalControlLists
address[] externalKycLists
bool    erc20VotesActivated
address compliance
address identityRegistry
```

`BondData`, `BondDetailsData`, `ERC20MetadataInfo`, `ResolverProxyConfiguration` and
`FactoryRegulationData` are unchanged between v3.1.0 and HEAD. Only `SecurityData` moved.

**How to read the right source:** the runbook's `--depth 1` clone has no history. Run
`git fetch --unshallow --filter=blob:none` in `reference/ats`, then read at `ad8f601`
(e.g. `git show ad8f601:packages/ats/contracts/contracts/interfaces/factory/IFactory.sol`).
Note the path differs from HEAD too — it is `contracts/interfaces/factory/`, not
`contracts/factory/`.

**This is MECHANICS.md §4.7 on a different chain.** Umbra: *"a Daml upgrade may only append
fields — reordering `SwapSettlement` had the participant reject the package outright."*
Here it is EVM selector dispatch instead of Canton package vetting, and the same rule holds.

## Role hashes ALSO differ between v3.1.0 and HEAD

The same version trap, second instance, and this one is nastier because it fails
*silently*.

| role | HEAD | v3.1.0 (deployed) |
|---|---|---|
| ISSUER | `0x5eeaf560…` | `0x4be32e88…` |
| KYC | `0x754f499f…` | `0x6fbd421e…` |
| CONTROLLER | `0xb4d2b850…` | `0xa72964c0…` |
| INTERNAL_KYC_MANAGER | `0xdd78fdcd…` | `0x3916c5c9…` |

Only `DEFAULT_ADMIN_ROLE` (`0x00`) is stable across versions.

The `rbacs` array at issuance used HEAD's constants, so every grant landed on a
hash the deployed contract never checks. **`hasRole()` returns `true` for those
hashes** — because they really were granted — **while every guarded call still
reverts**, since the contract asks about a different key. A role check that
passes and a call that reverts is a genuinely confusing pair.

`DEFAULT_ADMIN_ROLE` being stable is what makes it repairable without
redeploying: the admin can grant the correct hashes after the fact. `seed.ts`
does exactly that.

v3.1.0 roles live in **two** files — `layer_0/constants/roles.sol` and
`layer_1/constants/roles.sol`. `_KYC_ROLE` and `_SSI_MANAGER_ROLE` are only in
layer_1. HEAD has a single `constants/roles.sol`.

## Granting KYC needs an SSI issuer first

`grantKyc(account, vcId, validFrom, validTo, issuer)` is guarded by
`onlyIssuerListed(_issuer)`. The KYC issuer must be registered on the token's own
issuer list via `addIssuer(address)`, which requires `_SSI_MANAGER_ROLE` — a role
the issuance `rbacs` array did not include at all. Without this every KYC grant
reverts with no reason string.

Order that works: grant correct roles → `addIssuer` → `grantKyc` → `issueByPartition`.

`issueByPartition` takes `IssueData { bytes32 partition; address tokenHolder;
uint256 value; bytes data }`.

## Config id → security type, proven not guessed

Probed each configuration's facet addresses for type-specific selectors
(`getRate()` on the fixedRate facet, `getKpiLinkedRateInterestRate()` on kpiLinkedRate):

| config | facets | identified as |
|---|---|---|
| `0x…01` | 44 | **Equity** |
| `0x…02` | 47 | bond, no subtype marker |
| `0x…03` | 48 | **BondFixedRate** ← what we use |
| `0x…04` | 48 | bond (variable) |
| `0x…05` | 49 | bond + KPI |

The obvious guess — that configs follow `SecurityType` enum order — is **wrong**: `0x…01` is
Equity, not BondVariableRate.

## ISIN is checksum-validated on-chain

`isinValidator.sol` implements the ISO 6166 check digit. `XS0000000001` **reverts**
(`WrongISINChecksum`). The valid demo ISIN is **`XS0000000009`**. The algorithm was verified
by reproducing a real ISIN, Apple's `US0378331005`.

## Deployed demo bond

| | |
|---|---|
| Address | `0xD53072649037FEecD305920087791a37dF8D517F` |
| Name / symbol | Sotto Demo Senior Note 2030 / `STO-BOND-A` |
| Config | `0x…03` (BondFixedRate) version 1 |
| Regulation | **REG_S** — chosen because REG_D imposes a 6-month-to-1-year resale hold, which would block the secondary trading this project exists to demonstrate |
| Flags | `internalKycActivated: true` (the failure demo needs it), `isControllable: true`, `isMultiPartition: false` (default partition `0x…01`), `clearingActive: false` |
| Tx | `0xd4ed959233285ca6471cebd3abe6b0534d3444a7e353cc3a95b040609930cfb9` |

Reproduce with `npx tsx backend/src/scripts/deploy-bond.ts [--dry] [configId]`.

**Read the new address from the receipt logs, not a second `staticCall`** — after the tx the
nonce has moved, so a repeat static call predicts the *next* deployment. That bug briefly put
the wrong address in `.env`.

## Balances: `balanceOf` is AVAILABLE, not total

For B2's Total / Available / Held / Locked card, measured on the live bond after
placing a 1-unit hold against a 980-unit position:

| call | value | meaning |
|---|---|---|
| `balanceOf(account)` | 979 | **available** — total minus held |
| `balanceOfByPartition(partition, account)` | 979 | same, per partition |
| `getHeldAmountFor(account)` | 1 | **held** |
| `getHeldAmountForByPartition(partition, account)` | 1 | same, per partition |

So **Total = `balanceOf` + `getHeldAmountFor`**. `balanceOf` alone is not the
position — placing a hold makes it drop, which is exactly the animation §B2
wants ("available drops, held rises, total does not move"), but it means a naive
`balanceOf` reads as if the seller lost tokens.

`Locked` is a separate concept with its own facet (`_LOCKER_ROLE`) and is not the
same as held.

## Proven end to end on testnet

| step | result |
|---|---|
| Bond issued from factory `0.0.7708432` | `0xD53072649037FEecD305920087791a37dF8D517F` |
| SottoSettlement deployed | `0x98164562Ac1A7005C5E0e00C1018669fc62843E8` |
| KYC granted, 1000 units issued to seller | ✅ |
| **Atomic DvP: 20 units ↔ 19.67 real USDC** | tx `0x4c90cf5b…52fd`, gas 467,664 |
| **KYC-revoked settlement reverts, both ledgers unchanged** | ✅ |

The failure demo is sized so the cash leg *would* succeed (0.30 USDC notional
against a 0.33 USDC balance and a sufficient allowance), so the revert is
provably the compliance check on the delivery leg and not a funding problem.
`settle()` moves cash at step 4 and delivers at step 5, so the cash transfer does
execute before the delivery reverts — and the revert unwinds it.

## Still unknown

- Whether the SDK supports a **headless / server-key** issuance path, or whether issuance
  must go through a browser wallet. This is the next thing to establish.
- The concrete `configId` value for a bond — resolve at runtime rather than guessing.
- Whether `npm run ats:setup` is needed at all. We are not deploying the ATS stack, only
  calling a deployed factory, so probably not.
