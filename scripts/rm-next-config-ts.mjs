import fs from "node:fs";

if (fs.existsSync("./next.config.ts")) {
  fs.rmSync("./next.config.ts");
  console.log("[prebuild] removed next.config.ts");
} else {
  console.log("[prebuild] next.config.ts not present");
}
