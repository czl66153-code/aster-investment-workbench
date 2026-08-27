#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const configured = process.env.ASTER_PYTHON;
const localPrograms = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Programs", "Python")
  : null;
const candidates = configured
  ? [[configured, []]]
  : process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
        ...(["Python313", "Python312", "Python311", "Python310"].map((version) => [
          localPrograms ? path.join(localPrograms, version, "python.exe") : "",
          [],
        ]).filter(([command]) => command)),
      ]
    : [["python3", []], ["python", []]];

for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, "-m", "aia_engine.aster_top10", ...process.argv.slice(2)], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  const jsonOutput = (result.stdout || "").trimStart().startsWith("{");
  if (!result.error && jsonOutput) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(JSON.stringify({
  schema_version: "aster.aia.top10.cli.v1",
  status: "error",
  publishable: false,
  error: { type: "PythonNotFound", message: "Set ASTER_PYTHON to a Python 3 executable" },
}) + "\n");
process.exit(1);
