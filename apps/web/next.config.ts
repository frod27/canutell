import type { NextConfig } from 'next';

// In a Vercel production build the game server's URL must be set (wss://api.canutell.com; docs/ALPHA.md).
// Without it the client would fall back to port 8787 on the page's own host, which only exists in dev.
if (process.env.VERCEL_ENV === 'production' && !process.env.NEXT_PUBLIC_SERVER_URL)
  throw new Error('NEXT_PUBLIC_SERVER_URL must be set for production builds (e.g. wss://api.canutell.com)');

const config: NextConfig = {
  // The protocol package ships TypeScript source.
  transpilePackages: ['@canutell/protocol'],
  reactStrictMode: true,
};

export default config;
