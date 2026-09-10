/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sotto/shared'],

  webpack: (config, { webpack }) => {
    // The shared package uses Node ESM's explicit `.js` specifiers while its
    // source of truth is TypeScript. Teach webpack the same source-resolution
    // alias that tsx uses for the backend.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    // `wagmi/connectors` is a single barrel — importing walletConnect from it
    // also drags in Coinbase's Base Account SDK, which lazily imports
    // `@x402/*` payment modules that are not published as resolvable packages.
    // The build fails on them even though nothing here can ever reach that code
    // path: it lives behind Coinbase's x402 payment flow, which this venue does
    // not use. Ignoring the subtree is the narrowest fix that keeps HashPack and
    // Blade (WalletConnect) available.
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }),
      // Optional React Native persistence imported by MetaMask's connector
      // barrel; the browser-injected connector used here never executes it.
      new webpack.IgnorePlugin({
        resourceRegExp: /^@react-native-async-storage\/async-storage$/,
      })
    );
    return config;
  },
};

export default nextConfig;
