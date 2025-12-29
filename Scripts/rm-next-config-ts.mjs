import fs from "node:fs";

try {
  if (fs.existsSync("next.config.ts")) {
    fs.rmSync("next.config.ts");
    console.log("[prebuild] removed next.config.ts (Webflow override)");
  } else {
    console.log("[prebuild] next.config.ts not present");
  }
} catch (e) {
  console.error("[prebuild] failed to remove next.config.ts:", e);
  process.exit(1);
}
