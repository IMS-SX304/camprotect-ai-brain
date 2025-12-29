/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // IMPORTANT : ton environnement Webflow Cloud est sur /ai
  basePath: "/ai",
  assetPrefix: "/ai",
};

module.exports = nextConfig;
