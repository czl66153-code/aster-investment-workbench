#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..", "..");
const dataDir = path.join(import.meta.dirname, "data");
const dateIndex = process.argv.indexOf("--date");
const targetDate = dateIndex >= 0 ? process.argv[dateIndex + 1] : "9999-12-31";

async function latestFile(dir, pattern, dateOffset) {
  const files = (await fs.readdir(dir))
    .filter((name) => pattern.test(name) && name.slice(dateOffset, dateOffset + 10) <= targetDate)
    .sort();
  if (!files.length) throw new Error(`No matching data on or before ${targetDate} in ${dir}`);
  return path.join(dir, files.at(-1));
}

async function atomicCopy(source, destination, transform = (value) => value) {
  const body = await fs.readFile(source, "utf8");
  const parsed = transform(JSON.parse(body));
  const output = `${JSON.stringify(parsed, null, 2)}\n`;
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, output, "utf8");
  try {
    await fs.rename(temporary, destination);
  } catch {
    await fs.rm(destination, { force: true });
    await fs.rename(temporary, destination);
  }
}

const profiles = await latestFile(
  path.join(workspace, "outputs", "expert_tracking", "people_profiles"),
  /^expert_profiles_\d{4}-\d{2}-\d{2}\.json$/,
  16,
);
const tgb = await latestFile(
  path.join(workspace, "outputs", "expert_tracking", "tgb_people"),
  /^tgb_people_\d{4}-\d{2}-\d{2}\.json$/,
  11,
);
const publicSources = await latestFile(
  path.join(workspace, "outputs", "expert_tracking"),
  /^public_sources_\d{4}-\d{2}-\d{2}\.json$/,
  15,
);

await fs.mkdir(dataDir, { recursive: true });
await Promise.all([
  atomicCopy(profiles, path.join(dataDir, "expert_profiles.json"), (data) => {
    if (data.sourceStats) delete data.sourceStats.thsPeople;
    return data;
  }),
  atomicCopy(tgb, path.join(dataDir, "tgb_people.json")),
  atomicCopy(publicSources, path.join(dataDir, "public_sources.json"), (data) => {
    delete data.tonghuashun;
    if (data.validation) delete data.validation.tonghuashun;
    return data;
  }),
]);

console.log(JSON.stringify({ targetDate, profiles, tgb, publicSources, dataDir }, null, 2));
