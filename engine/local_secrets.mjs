import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultEnvPath = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");

export function normalizeXueqiuCookie(input) {
  const value = String(input || "").trim().replace(/^cookie\s*:\s*/i, "");
  if (!value || value.length < 20) throw new Error("请粘贴雪球请求头中的完整 Cookie");
  if (value.length > 32_000 || /[\r\n\0]/.test(value)) throw new Error("雪球 Cookie 格式不正确");
  const keys = value.split(";").map((part) => part.trim().split("=", 1)[0].toLowerCase());
  if (!keys.includes("xq_a_token")) throw new Error("Cookie 中缺少 xq_a_token，请登录雪球后重新复制完整 Cookie");
  return value;
}

export function persistXueqiuCookie(input, envPath = defaultEnvPath) {
  const cookie = normalizeXueqiuCookie(input);
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `XUEQIU_COOKIE=${cookie}`;
  const updated = /^XUEQIU_COOKIE=.*$/m.test(current)
    ? current.replace(/^XUEQIU_COOKIE=.*$/m, line)
    : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
  const temporary = `${envPath}.xueqiu.tmp`;
  writeFileSync(temporary, updated, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, envPath);
  process.env.XUEQIU_COOKIE = cookie;
  return { configured: true, cookieLength: cookie.length };
}
