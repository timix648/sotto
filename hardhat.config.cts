import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' },
  },
  paths: { sources: './contracts', tests: './contracts/test', cache: './cache', artifacts: './artifacts' },
  // Hedera testnet (296) is natively supported by Sourcify. The legacy
  // verify.hashscan.io / server-verify.hashscan.io hosts are deprecated and
  // now redirect - call sourcify.dev directly.
  sourcify: { enabled: true, apiUrl: 'https://sourcify.dev/server', browserUrl: 'https://repo.sourcify.dev' },
  etherscan: { enabled: false },
  networks: {
    hardhat: { chainId: 31337 },
    hederaTestnet: {
      url: process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api',
      chainId: 296,
      accounts: process.env.ISSUER_PRIVATE_KEY ? [process.env.ISSUER_PRIVATE_KEY] : [],
    },
  },
};
export default config;
