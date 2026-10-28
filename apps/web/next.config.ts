import type { NextConfig } from 'next';

const config: NextConfig = {
  // The protocol package ships TypeScript source.
  transpilePackages: ['@canutell/protocol'],
  reactStrictMode: true,
};

export default config;
