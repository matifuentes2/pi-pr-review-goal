import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.env.PI_CODEX_GOAL_ROOT;
if (!root) throw new Error("Set PI_CODEX_GOAL_ROOT to the tested companion checkout (see companion-ref.json).");
const loader = resolve(root, "node_modules/tsx/dist/loader.mjs");
if (!existsSync(loader) || !existsSync(resolve(root, "dist/index.js"))) {
  throw new Error("Run npm ci --ignore-scripts && npm run build in the companion checkout first.");
}
const result = spawnSync(process.execPath, ["--import", pathToFileURL(loader).href, "--test", "test/integration/companion.test.mts"], {
  stdio: "inherit", env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
