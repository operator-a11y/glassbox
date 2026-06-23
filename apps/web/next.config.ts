import type { NextConfig } from 'next';

// The web app is a thin client over the local daemon — it imports no engine code.
// All /api/* calls are proxied to the daemon so the browser stays same-origin.
const DAEMON_URL = process.env.GLASSBOX_DAEMON_URL ?? 'http://127.0.0.1:4319';

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${DAEMON_URL}/api/:path*` }];
  },
};

export default nextConfig;
