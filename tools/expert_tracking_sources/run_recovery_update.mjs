#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..", "..");
const statusFile = path.join(workspace, "outputs", "expert_tracking", "update_status.json");
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

try {
  const status = JSON.parse(await fs.readFile(statusFile, "utf8"));
  if (status.targetDate === today && status.overall === "healthy" && status.deployed === true) {
    console.log(`${today} 已健康发布，补救任务无需重复抓取。`);
    process.exit(0);
  }
} catch {}

console.log(`${today} 尚未健康发布，启动补救更新。`);
const child = spawn(process.execPath, [path.join(import.meta.dirname, "run_stable_update.mjs"), "--date", today], {
  cwd: workspace, stdio: "inherit", windowsHide: true, env: process.env,
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
