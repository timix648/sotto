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

## Still unknown

- Whether the SDK supports a **headless / server-key** issuance path, or whether issuance
  must go through a browser wallet. This is the next thing to establish.
- The concrete `configId` value for a bond — resolve at runtime rather than guessing.
- Whether `npm run ats:setup` is needed at all. We are not deploying the ATS stack, only
  calling a deployed factory, so probably not.
