// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require("./webflow-next-config.cjs");

const basePath = config.basePath || "";
const assetPrefix = config.assetPrefix || basePath;

export { basePath, assetPrefix };
