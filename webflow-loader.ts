import config from "./webflow-next-config";

const basePath = config.basePath || "";
const assetPrefix = config.assetPrefix || basePath;

export { basePath, assetPrefix };
