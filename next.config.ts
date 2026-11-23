import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  devIndicators: false,
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
