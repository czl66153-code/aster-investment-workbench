#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

const node = process.execPath;
const root = process.cwd();
const dateArg = process.argv.indexOf("--date");
const date = dateArg >= 0 ? process.argv[dateArg + 1] : "";
const skipCompetitions = process.argv.includes("--skip-competitions");
const steps = [];

if (!skipCompetitions) {
  steps.push(["顽主杯", "tools/wanzhu_api_crawler/crawl_wanzhu.mjs", date ? ["--date", date] : []]);
  steps.push(["复利笔记", "tools/fuli_api_crawler/crawl_fuli.mjs", date ? ["--date", date] : []]);
}
steps.push(["淘股吧具体用户", "tools/expert_tracking_sources/crawl_tgb_people.mjs", date ? ["--date", date] : []]);
steps.push(["雪球公开组合", "tools/expert_tracking_sources/crawl_public_sources.mjs", [...(date ? ["--date", date] : []), "--skip-tonghuashun"]]);
steps.push(["比赛选手历史回填", "tools/expert_tracking_sources/backfill_competition_history.mjs", date ? ["--date", date] : []]);
steps.push(["高手档案聚合", "tools/expert_tracking_sources/build_expert_profiles.mjs", date ? ["--date", date] : []]);

function run(label, script, args) {
  return new Promise((resolve) => {
    console.log(`\n[${label}] ${script}`);
    const child = spawn(node, [path.resolve(root, script), ...args], { stdio: "inherit", cwd: root });
    child.on("exit", (code) => resolve({ label, code: code ?? 1 }));
    child.on("error", (error) => {
      console.error(`[${label}] ${error.message}`);
      resolve({ label, code: 1 });
    });
  });
}

const outcomes = [];
for (const [label, script, args] of steps) outcomes.push(await run(label, script, args));
const failures = outcomes.filter((item) => item.code !== 0);
console.log("\n更新结果：", outcomes);
if (failures.length) {
  console.error(`有 ${failures.length} 个来源失败；成功来源与档案仍已保存。`);
  process.exitCode = 1;
}
