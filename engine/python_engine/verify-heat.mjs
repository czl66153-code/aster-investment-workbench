import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMarketPython } from "../provider_bridge.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const result = spawnSync(
  resolveMarketPython(),
  ["-m", "unittest", "python_engine.tests.test_vendor8002"],
  { cwd: projectRoot, encoding: "utf8" },
);

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) throw result.error;
process.exit(result.status ?? 1);
