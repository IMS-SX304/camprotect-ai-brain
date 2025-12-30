import { existsSync } from "node:fs";
import { rmSync } from "node:fs";

const path = "./next.config.ts";

if (existsSync(path)) {
  rmSync(path);
  console.log("Removed next.config.ts");
} else {
  console.log("No next.config.ts to remove");
}
