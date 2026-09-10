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
    // AppKit's optional server-side transports refer to these Node-only
    // helpers. They are not part of the browser wallet path.
    config.externals.push('pino-pretty', 'lokijs', 'encoding');

    // Reown's connector catalog includes Coinbase, whose optional payment flow
    // imports `@x402/*`. Sotto does not enable that flow.
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }),
      // Optional React Native persistence is not used by the web application.
      new webpack.IgnorePlugin({
        resourceRegExp: /^@react-native-async-storage\/async-storage$/,
      })
    );
    return config;
  },
};

export default nextConfig;
