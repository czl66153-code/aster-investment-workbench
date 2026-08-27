import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./core.mjs";

const marker = "ASTER_PROVIDER_JSON:";
const bundledRuntime = join(projectDir, "..", "quant_runtime", "bigquant_py311", "python.exe");

export function resolveMarketPython() {
  const configured = process.env.ASTER_MARKET_PYTHON || process.env.ASTER_PYTHON;
  if (configured) return configured;
  if (process.platform === "win32" && existsSync(bundledRuntime)) return bundledRuntime;
  return process.platform === "win32" ? "python" : "python3";
}

export async function runProviderBridge(command, payload = {}, options = {}) {
  const executable = resolveMarketPython();
  const script = join(projectDir, "engine", "market_provider_bridge.py");
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs || 15 * 60_000));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script, command], {
      cwd: projectDir,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let settled = false;
    const maximumBytes = Number(options.maximumBytes || 256 * 1024 * 1024);
    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${command} provider timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maximumBytes) {
        child.kill();
        finish(() => reject(new Error(`${command} provider output exceeded quality limit`)));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 2 * 1024 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (settled) return;
      const output = Buffer.concat(stdout).toString("utf8");
      const line = output.split(/\r?\n/).reverse().find((item) => item.startsWith(marker));
      let parsed;
      try { parsed = line ? JSON.parse(line.slice(marker.length)) : null; } catch {}
      if (code !== 0 || !parsed?.ok) {
        const detail = parsed?.error || Buffer.concat(stderr).toString("utf8").trim().slice(-2_000) || `exit ${code}`;
        finish(() => reject(new Error(`${command} provider failed: ${detail}`)));
        return;
      }
      finish(() => resolve(parsed));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function providerCapabilities() {
  return runProviderBridge("capabilities", {}, { timeoutMs: 30_000, maximumBytes: 2 * 1024 * 1024 });
}
