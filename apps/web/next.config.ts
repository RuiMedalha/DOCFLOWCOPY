import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Required by apps/web/Dockerfile (Stage 2 build). Produces a self-contained
  // server in .next/standalone that bundles ONLY the runtime node_modules
  // Next.js actually needs — keeps the production image ~400 MB instead of ~1 GB+.
  output: 'standalone',

  // Ignore ESLint errors during production builds (linting runs separately in CI)
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Public runtime config for the API base — overridable at deploy time.
  // The value is read by the build (NEXT_PUBLIC_*) AND by api-client.ts at runtime.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1',
  },

  // Same-origin API proxy.
  //
  // When the web app is reached through a public tunnel (e.g. localhost.run),
  // the phone browser cannot reach the user's LAN IP that the absolute
  // NEXT_PUBLIC_API_URL would normally point at. To make a SINGLE tunnel to
  // the Next dev server (port 3000) carry both the web pages AND the API
  // calls, we set NEXT_PUBLIC_API_URL to a RELATIVE path (e.g. /api/v1) and
  // proxy those requests to the NestJS API on localhost:4000 here.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:4000/api/:path*',
      },
    ];
  },

  async headers() {
    return [
      {
        // Prevent browser/CDN caching of dynamic HTML routes
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
