import type { NextConfig } from 'next';
const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'playwright'],
  poweredByHeader: false,
  devIndicators: false,
};
export default config;
