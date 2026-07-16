/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Firebase Admin uses Node built-ins; keep it out of the client bundle.
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
