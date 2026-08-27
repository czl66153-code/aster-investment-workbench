#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..", "..");
const outputRoot = path.join(workspace, "outputs", "expert_tracking");
const siteDataDir = path.join(workspace, "web", "expert-tracker", "data");
const lockFile = path.join(outputRoot, ".stable-update.lock");
const statusFile = path.join(outputRoot, "update_status.json");
const logDir = path.join(outputRoot, "logs");
const rosterFile = path.join(workspace, "tools", "expert_tracking_sources", "expert_roster.json");
const dateIndex = process.argv.indexOf("--date");
const targetDate = dateIndex >= 0 ? process.argv[dateIndex + 1] : shanghaiDate();
const skipNetwork = process.argv.includes("--skip-network");
const force = process.argv.includes("--force");

function shanghaiDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function isoNow() { return new Date().toISOString(); }
function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try { await fs.rename(temporary, file); }
  catch { await fs.rm(file, { force: true }); await fs.rename(temporary, file); }
}

async function acquireLock() {
  await fs.mkdir(outputRoot, { recursive: true });
  try {
    const handle = await fs.open(lockFile, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, targetDate, startedAt: isoNow() }));
    await handle.close();
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fs.stat(lockFile);
  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  if (ageHours <= 4 && !force) throw new Error(`已有更新任务正在运行（锁文件 ${lockFile}，${ageHours.toFixed(1)} 小时）`);
  await fs.rename(lockFile, `${lockFile}.stale-${Date.now()}`);
  return acquireLock();
}

async function runProcess(script, args, label, logFile) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [path.join(workspace, script), ...args], {
      cwd: workspace, windowsHide: true, env: process.env,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { const value = chunk.toString(); stdout += value; process.stdout.write(value); });
    child.stderr.on("data", (chunk) => { const value = chunk.toString(); stderr += value; process.stderr.write(value); });
    child.on("error", (error) => resolve({ code: 1, error: error.message, stdout, stderr, durationMs: Date.now() - startedAt }));
    child.on("exit", async (code) => {
      await fs.appendFile(logFile, `\n[${isoNow()}] ${label} exit=${code ?? 1}\n${stdout}\n${stderr}\n`, "utf8");
      resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

async function validateJson(file, predicate) {
  const data = await readJson(file);
  if (!predicate(data)) throw new Error(`数据校验未通过：${file}`);
  return data;
}

async function validateFocusFreshness(file) {
  const [data, roster] = await Promise.all([readJson(file), readJson(rosterFile)]);
  if (!(data.profiles || []).length) throw new Error(`数据校验未通过：${file}`);
  const focus = (roster.mustTrack || []).map((item) => {
    const profiles = (data.profiles || []).filter((profile) => profile.personName === item.displayName);
    const sourceDates = Object.fromEntries((item.sources || []).map((source) => [source,
      profiles.flatMap((profile) => {
        const direct = profile.source === source ? [profile.latestSnapshot?.date || ""] : [];
        const variants = (profile.sourceVariants || []).filter((variant) => variant.source === source).map((variant) => variant.latestDate || "");
        return [...direct, ...variants];
      }).sort().at(-1) || null,
    ]));
    const currentSources = Object.entries(sourceDates).filter(([, date]) => date === targetDate).map(([source]) => source);
    const staleSources = Object.entries(sourceDates).filter(([, date]) => date !== targetDate).map(([source, date]) => ({ source, latestDate: date }));
    return { displayName: item.displayName, priority: item.priority || "", sourceDates, currentSources, staleSources, current: currentSources.length > 0 };
  });
  const missing = focus.filter((item) => !item.current);
  if (missing.length) throw new Error(`重点高手缺少${targetDate}有效披露：${missing.map((item) => item.displayName).join("、")}`);
  return { targetDate, focus, complete: focus.every((item) => item.staleSources.length === 0) };
}

async function validateWanzhuRosterCoverage() {
  const dailyDir = path.join(workspace, "outputs", "wanzhu");
  const archiveDir = path.join(outputRoot, "competition_history", "wanzhu");
  const names = (await fs.readdir(dailyDir)).filter((name) => /^wanzhu_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  const targetDaily = await readJson(path.join(dailyDir, `wanzhu_${targetDate}.json`));
  const matchId = String(targetDaily.match?.id || "");
  const roster = new Map();
  for (const name of names) {
    const daily = await readJson(path.join(dailyDir, name));
    if (String(daily.match?.id || "") !== matchId) continue;
    for (const group of daily.groups || []) for (const player of group.players || []) {
      const userId = String(player.user_id || "");
      if (userId) roster.set(userId, player.username || userId);
    }
  }
  const archives = new Map();
  try {
    for (const name of (await fs.readdir(archiveDir)).filter((item) => /^[^.]+\.json$/.test(item))) {
      const archive = await readJson(path.join(archiveDir, name));
      if (String(archive.match?.id || "") === matchId) archives.set(String(archive.userId || ""), archive);
    }
  } catch {}
  const missing = [...roster.entries()].filter(([userId]) => !archives.has(userId)).map(([, name]) => name);
  const stale = [...roster.entries()].filter(([userId]) => {
    const archive = archives.get(userId);
    return archive && archive.match?.endDate !== targetDate;
  }).map(([, name]) => name);
  const failed = [...roster.entries()].filter(([userId]) => archives.get(userId)?.lastError).map(([, name]) => name);
  const targetDisclosures = [...roster.keys()].filter((userId) => (archives.get(userId)?.snapshots || []).some((row) => row.date === targetDate)).length;
  const pendingTarget = [...roster.keys()].filter((userId) => archives.get(userId)?.pendingDates?.[targetDate]).length;
  const complete = roster.size > 0 && !missing.length && !stale.length && !failed.length;
  const quality = {
    targetDate, matchId, roster: roster.size, archived: [...roster.keys()].filter((userId) => archives.has(userId)).length,
    targetDisclosures, pendingTarget, missing, stale, failed, complete,
  };
  if (!complete) throw new Error(`顽主杯逐选手档案未完整更新：建档 ${quality.archived}/${quality.roster}，过期 ${stale.length}，失败 ${failed.length}`);
  return quality;
}

async function quarantine(file) {
  try {
    await fs.access(file);
    const target = `${file}.invalid-${Date.now()}`;
    await fs.rename(file, target);
    return target;
  } catch { return null; }
}

async function runStage(stage, logFile, previous) {
  const startedAt = isoNow();
  let lastError = "";
  let durationMs = 0;
  for (let attempt = 1; attempt <= stage.attempts; attempt += 1) {
    console.log(`\n[${stage.label}] 第 ${attempt}/${stage.attempts} 次`);
    const result = await runProcess(stage.script, stage.args, stage.label, logFile);
    durationMs += result.durationMs;
    try {
      if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").at(-1) || `退出码 ${result.code}`);
      if (stage.validate) await stage.validate();
      return {
        status: "success", attempts: attempt, startedAt, finishedAt: isoNow(), durationMs,
        lastSuccessAt: isoNow(), lastSuccessDate: targetDate,
      };
    } catch (error) {
      lastError = error.message;
      if (attempt < stage.attempts) await wait([0, 3000, 12000][attempt] || 12000);
    }
  }
  const quarantined = stage.output ? await quarantine(stage.output) : null;
  return {
    status: "failed", attempts: stage.attempts, startedAt, finishedAt: isoNow(), durationMs,
    error: lastError, quarantined, lastSuccessAt: previous?.lastSuccessAt || null,
    lastSuccessDate: previous?.lastSuccessDate || null,
  };
}

await fs.mkdir(logDir, { recursive: true });
await acquireLock();
const logFile = path.join(logDir, `stable_update_${targetDate}_${Date.now()}.log`);
let previousStatus = {};
try { previousStatus = await readJson(statusFile); } catch {}
const stages = {};
let focusQuality = null;
let wanzhuRosterQuality = null;

try {
  const networkStages = [
    {
      key: "wanzhu", label: "顽主杯", script: "tools/wanzhu_api_crawler/crawl_wanzhu.mjs", args: ["--date", targetDate, "--top-players", "10"], attempts: 3,
      output: path.join(workspace, "outputs", "wanzhu", `wanzhu_${targetDate}.json`),
      validate: () => validateJson(path.join(workspace, "outputs", "wanzhu", `wanzhu_${targetDate}.json`), (data) => (data.groups || []).some((group) => (group.players || []).length > 0)),
    },
    {
      key: "fuli", label: "复利笔记", script: "tools/fuli_api_crawler/crawl_fuli.mjs", args: ["--date", targetDate, "--top-players", "10"], attempts: 3,
      output: path.join(workspace, "outputs", "fuli", `fuli_${targetDate}.json`),
      validate: () => validateJson(path.join(workspace, "outputs", "fuli", `fuli_${targetDate}.json`), (data) => (data.players || []).length > 0),
    },
    {
      key: "tgb", label: "淘股吧", script: "tools/expert_tracking_sources/crawl_tgb_people.mjs", args: ["--date", targetDate], attempts: 3,
      output: path.join(outputRoot, "tgb_people", `tgb_people_${targetDate}.json`),
      validate: () => validateJson(path.join(outputRoot, "tgb_people", `tgb_people_${targetDate}.json`), (data) => (data.people || []).length > 0),
    },
    {
      key: "publicSources", label: "雪球公开组合", script: "tools/expert_tracking_sources/crawl_public_sources.mjs", args: ["--date", targetDate, "--xueqiu-history-depth", "30", "--skip-tonghuashun"], attempts: 3,
      output: path.join(outputRoot, `public_sources_${targetDate}.json`),
      validate: () => validateJson(path.join(outputRoot, `public_sources_${targetDate}.json`), (data) => (data.xueqiu?.portfolios || []).length > 0),
    },
  ];

  if (skipNetwork) {
    for (const stage of networkStages) stages[stage.key] = { status: "skipped", reason: "--skip-network 演练", lastSuccessAt: previousStatus.stages?.[stage.key]?.lastSuccessAt || null, lastSuccessDate: previousStatus.stages?.[stage.key]?.lastSuccessDate || null };
  } else {
    for (const stage of networkStages) stages[stage.key] = await runStage(stage, logFile, previousStatus.stages?.[stage.key]);
  }

  const criticalStages = [
    {
      key: "backfill", label: "历史回补", script: "tools/expert_tracking_sources/backfill_competition_history.mjs", args: ["--date", targetDate], attempts: 2,
      validate: async () => { wanzhuRosterQuality = await validateWanzhuRosterCoverage(); },
    },
    {
      key: "build", label: "档案聚合", script: "tools/expert_tracking_sources/build_expert_profiles.mjs", args: ["--date", targetDate], attempts: 2,
      validate: async () => { focusQuality = await validateFocusFreshness(path.join(outputRoot, "people_profiles", `expert_profiles_${targetDate}.json`)); },
    },
    {
      key: "sync", label: "网页原子同步", script: "web/expert-tracker/sync-data.mjs", args: ["--date", targetDate], attempts: 2,
      validate: async () => Promise.all([
        validateJson(path.join(siteDataDir, "expert_profiles.json"), (data) => (data.profiles || []).length > 0),
        validateJson(path.join(siteDataDir, "public_sources.json"), (data) => typeof data === "object"),
      ]),
    },
  ];
  for (const stage of criticalStages) {
    if (stage.key === "sync" && stages.build?.status !== "success") {
      stages.sync = { status: "skipped", reason: "重点高手新鲜度门禁未通过，网页继续保留上一有效发布版", lastSuccessAt: previousStatus.stages?.sync?.lastSuccessAt || null, lastSuccessDate: previousStatus.stages?.sync?.lastSuccessDate || null };
      continue;
    }
    if (skipNetwork && stage.key === "backfill") {
      stages[stage.key] = { status: "skipped", reason: "--skip-network 演练", lastSuccessAt: previousStatus.stages?.[stage.key]?.lastSuccessAt || null, lastSuccessDate: previousStatus.stages?.[stage.key]?.lastSuccessDate || null };
    } else {
      stages[stage.key] = await runStage(stage, logFile, previousStatus.stages?.[stage.key]);
    }
  }

  if (skipNetwork) {
    stages.shadowExperiment = { status: "skipped", reason: "--skip-network 演练不写入暗测账本" };
  } else if (stages.sync?.status !== "success") {
    stages.shadowExperiment = { status: "skipped", reason: "网页数据未成功同步，暗测拒绝使用不完整持仓" };
  } else {
    stages.shadowExperiment = await runStage({
      key: "shadowExperiment", label: "次日持仓暗测", script: "tools/expert_tracking_sources/run_next_holding_shadow.mjs",
      args: ["--as-of", targetDate, "--evaluate-only"], attempts: 1,
    }, logFile, previousStatus.stages?.shadowExperiment);
  }

  const criticalFailed = ["build", "sync"].some((key) => stages[key]?.status === "failed");
  const sourceFailed = ["wanzhu", "fuli", "tgb", "publicSources", "backfill"].some((key) => stages[key]?.status === "failed");
  const focusPartial = focusQuality?.complete === false;
  const rosterPartial = wanzhuRosterQuality?.complete === false;
  const overall = criticalFailed ? "failed" : sourceFailed || focusPartial || rosterPartial ? "degraded" : skipNetwork ? "dry-run" : "healthy";
  const status = {
    generatedAt: isoNow(), targetDate, overall, deployed: !criticalFailed,
    recovery: sourceFailed ? "失败来源已保留最近有效数据；下一次定时任务会再次抓取并回补历史。" : focusPartial ? "重点高手至少一个来源已更新，但仍有来源未披露当日数据；缺口会在后续任务重试，不会判断为空仓或卖出。" : "所有来源及聚合步骤正常。",
    quality: { focusFreshness: focusQuality, wanzhuRoster: wanzhuRosterQuality }, logFile, stages,
  };
  await atomicJson(statusFile, status);
  if (!criticalFailed) await atomicJson(path.join(siteDataDir, "update_status.json"), status);
  console.log(`\n稳定更新完成：${overall}，状态文件 ${statusFile}`);
  if (criticalFailed) process.exitCode = 1;
  else if (sourceFailed) process.exitCode = 2;
} finally {
  await fs.rm(lockFile, { force: true });
}
