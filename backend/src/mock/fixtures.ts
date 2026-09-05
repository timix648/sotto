// Mock fixtures.
// SELLER and the first dealer are the real generated demo accounts, so the
// shapes the frontend sees match what the live API will return.
//
// EVERY address here is EIP-55 checksummed. viem rejects a non-checksummed
// address at encode time, and both computeCommit and the frontend's wagmi/viem
// calls will throw on one. Run getAddress() over any address you add.
export const ASSET_TOKEN = '0x00000000000000000000000000000000007A1b2c';
export const ASSET_SYMBOL = 'STO-BOND-A';
// USDC 0.0.429274 in EVM long-zero form (429274 = 0x68cda) - verified on-chain:
// symbol USDC, name "USD Coin", 6 decimals.
export const CASH_TOKEN = '0x0000000000000000000000000000000000068cDa';
export const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
export const SELLER = '0x48c46FA72f8b0cc3A8304D30beA173a12f0cec48';
export const SETTLEMENT = '0x00000000000000000000000000000000005e77E1';
export const TOPIC_ID = '0.0.10380500';

// price is cash base units (USDC, 6dp) per 100 nominal -> 98.35 = 98350000
export const DEALERS = [
  { addr: '0xd49B230C1985833a277B25ed9a682C4e49845cBe', name: 'Dealer A', price: '98200000' },
  { addr: '0x7a9F4C2e18bD35604F3Ae9c07b21D8FE6A0C4471', name: 'Dealer B', price: '98350000' },
  { addr: '0x2e5C81BA9D47F03e6C1b85ad0392FC7B41EE9d20', name: 'Dealer C', price: '98110000' },
  { addr: '0xc13A7ef940b2856DD3E07fA1C95b682043Df8e6a', name: 'Dealer D', price: '97900000' },
];

export const ASSETS = [{
  assetToken: ASSET_TOKEN,
  symbol: ASSET_SYMBOL,
  name: 'Sotto Demo Senior Note 2030',
  isin: 'XS0000000001',
  nominalValue: '1000000',
  couponRate: '450',
  couponFrequency: 2,
  maturityDate: Math.floor(Date.UTC(2030, 8, 5) / 1000),
  decimals: 0,
  hashscan: 'https://hashscan.io/testnet/token/' + ASSET_TOKEN,
  coupons: [
    { date: Math.floor(Date.UTC(2027, 2, 5) / 1000), scheduleAddress: '0x0000000000000000000000000000000000A1b2C3', status: 'Scheduled' },
    { date: Math.floor(Date.UTC(2027, 8, 5) / 1000), scheduleAddress: '0x0000000000000000000000000000000000A1b2C4', status: 'Scheduled' },
  ],
}];
