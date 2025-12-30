/** @type {import('next').NextConfig} */
const mount = process.env.COSMIC_MOUNT_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  basePath: mount,
  assetPrefix: mount,
};

module.exports = nextConfig;
