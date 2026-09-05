import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' },
  },
  paths: { sources: './contracts', tests: './contracts/test', cache: './cache', artifacts: './artifacts' },
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
