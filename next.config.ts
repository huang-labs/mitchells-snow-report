import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  // Embed the public deployment origin in the static share metadata.
  env: { SITE_URL: process.env.SITE_URL || "https://mitchells-snow-report.huang.mx" },
};

export default nextConfig;
