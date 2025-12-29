// webflow-loader.ts (ROOT)
// On ne dépend pas de next.config.* (TS ne le résout pas en build Webflow Cloud)

const cfg = require("./webflow-next-config.cjs");

export const basePath = cfg.basePath ?? "";
export const assetPrefix = cfg.assetPrefix ?? basePath;
