import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(directory, "run.py");
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

const failures = [];
for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, runner, "smoke"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (!result.error && result.status === 0) {
    const tests = spawnSync(command, [...prefix, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], {
      cwd: directory,
      encoding: "utf8",
    });
    if (!tests.error && tests.status === 0) {
      process.stdout.write(result.stdout);
      process.stdout.write(tests.stdout);
      process.stderr.write(tests.stderr);
      process.exit(0);
    }
    failures.push(`${command} tests: ${tests.error?.message ?? (tests.stderr || `exit ${tests.status}`).trim()}`);
    continue;
  }
  failures.push(`${command}: ${result.error?.message ?? (result.stderr || `exit ${result.status}`).trim()}`);
}

console.error("A usable Python 3 interpreter was not found or the smoke test failed.");
console.error(failures.join("\n"));
console.error("Set ASTER_PYTHON to an explicit Python 3 executable and retry.");
process.exit(1);
