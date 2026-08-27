import process from "node:process";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

export function deepseekConfigured() {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export async function deepseekJson({ system, user, model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL, maxTokens = 1200 }) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("未配置 DEEPSEEK_API_KEY；确定性抓取继续运行，AI 增强已跳过。");
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const body = {
    model,
    messages: [
      { role: "system", content: `${system}\n只输出合法 json 对象，不得编造输入中没有的事实。` },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    max_tokens: maxTokens,
    temperature: 0.1,
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500).replaceAll(apiKey, "[REDACTED]");
        const error = new Error(`DeepSeek HTTP ${response.status}: ${detail}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (!content?.trim()) throw new Error("DeepSeek 返回空内容");
      const parsed = JSON.parse(content);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("DeepSeek 未返回 JSON 对象");
      return { data: parsed, model: payload.model || model, usage: payload.usage || null };
    } catch (error) {
      lastError = error;
      if (attempt === 3 || error.retryable === false) break;
      await wait(attempt * 3000);
    }
  }
  throw lastError;
}
