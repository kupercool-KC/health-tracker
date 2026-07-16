/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Firebase Admin uses Node built-ins; keep it out of the client bundle.
  serverExternalPackages: ["firebase-admin"],
  // Phase 1 redesign removed these routes (superseded by /today, /profile).
  // Redirect rather than leave old bookmarks/history entries 404ing forever.
  async redirects() {
    return [
      { source: "/dashboard", destination: "/today", permanent: false },
      { source: "/settings", destination: "/profile", permanent: false },
    ];
  },
};

export default nextConfig;
