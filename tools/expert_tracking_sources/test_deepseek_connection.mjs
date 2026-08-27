#!/usr/bin/env node

import { deepseekJson } from "./deepseek_provider.mjs";

try {
  const result = await deepseekJson({
    system: "你是接口连通性检查器。",
    user: "请返回 json：{\"ok\":true,\"message\":\"connected\"}",
    maxTokens: 80,
  });
  if (result.data?.ok !== true) throw new Error("接口已响应，但结构化结果未通过校验");
  console.log(JSON.stringify({ ok: true, model: result.model, usage: result.usage || null }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
