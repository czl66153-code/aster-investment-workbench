# 高手跟踪爬虫

以“具体选手/大V”为主键统一保存公开数据。当前产品接入：顽主杯、复利笔记、淘股吧具体用户、雪球热门组合；同花顺默认禁用且不进入网页交付数据。

## 一键更新

生产环境优先使用稳定更新入口。它包含单实例锁、分来源重试、数据量校验、异常文件隔离、最近有效数据兜底、历史回补、网页原子同步与健康状态记录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/expert_tracking_sources/run-stable-update.ps1
```

指定业务日期：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/expert_tracking_sources/run-stable-update.ps1 --date YYYY-MM-DD
```

仅演练聚合、同步和健康检查，不访问外部来源：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/expert_tracking_sources/run-stable-update.ps1 --date YYYY-MM-DD --skip-network
```

运行状态保存在 `outputs/expert_tracking/update_status.json`，逐次日志保存在 `outputs/expert_tracking/logs/`；网页使用 `web/expert-tracker/data/update_status.json` 显示降级状态。任一来源失败时不清空网页数据，而是继续使用该来源最近一次有效快照，并在下一次运行中重试和补历史。

建议在 A 股交易日收盘数据稳定后的 18:40 自动运行。登录 Cookie 只通过任务运行账户的环境变量提供，不写入脚本、日志和结果文件；雪球公开组合的核心路径不依赖 Cookie。

### 次日持仓两日暗测（不在网页展示）

18:40 高手稳定更新成功后会核验目标日真实持仓；当晚正式行情、筹码模型、AIA、ABCD 与热度模型更新完成后，再冻结下一交易日的每人 Top5 概率候选。实验账本位于 `data/experiments/expert_next_holding_shadow.db`，可读副本位于 `outputs/expert_tracking/next_holding_shadow/`，不会写入网页数据目录，也不会影响推荐模型。

模型将最近 1 至 5 个有效披露日作为主风格，6 至 15 日作为辅助，更早历史只作低权重先验；检测到行业偏好切换时继续压低旧样本。当前实验名单固定为 9 人，其中乌江望月以复利笔记账户作为实际标签、顽主杯账户仅作辅助风格证据。手工冻结指定截面：

```powershell
node tools/expert_tracking_sources/run_next_holding_shadow.mjs --as-of YYYY-MM-DD --target YYYY-MM-DD --predict-only
```

预测生成后不可覆盖；后续补爬只用于核验真实持仓或生成新一批预测。概率是单只股票在目标日出现于持仓中的独立概率，五只概率不要求合计 100%。

### 部署到另一台 Windows 电脑

最终调度不依赖 Codex。把运行包解压到目标电脑，安装 Node.js 20 或更高版本，然后在解压目录执行一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/expert_tracking_sources/install-windows-schedule.ps1
```

安装器会先离线演练，失败时不会注册任务；演练通过后创建两项当前用户任务：

- 工作日 18:40 主更新；任务本身失败后每 15 分钟重试，最多两次。
- 工作日 20:30 补救检查；当天已经健康发布就立即退出，否则重新执行完整稳定更新。

每次稳定更新除抓取目标日外，还会回看最近 5 个交易日的逐选手披露。某日请求成功但尚无持仓披露时，该日期记入 `pendingDates` 并在后续任务继续重试；只有取得真实 `holdDate` 的记录才会进入快照和买卖推断，因此“未披露”不会被当成空仓或卖出。重点高手会在 `update_status.json.quality.focusFreshness` 中按来源分别标注日期；至少一个声明来源达到目标日即可降级发布，全部来源齐全才标记完整。

两项任务都启用“错过后尽快运行”、三小时超时和禁止并发。业务脚本另有四小时陈旧锁清理，因此电脑休眠、临时断网、站点限流和进程异常均有明确恢复路径。卸载任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/expert_tracking_sources/uninstall-windows-schedule.ps1
```

目标网站只需部署 `web/expert-tracker/`。爬虫和定时任务可放在同机，也可放在独立采集机；若分开部署，应在稳定任务成功后把 `web/expert-tracker/data/` 原子同步到网站静态目录。`update_status.json` 可作为外部监控探针：`overall=healthy`、`deployed=true` 且 `targetDate` 为期望交易日才算成功。

Codex 内的本地自动任务只是旁路巡检，不是目标电脑运行的前提。

### AI 使用边界

生产链路不依赖 Codex、OpenAI 或任何 AI：抓取、字段校验、交易识别、集中度与换手统计、规则型风格标签、重试和发布均为确定性代码。只有自然语言风格归纳、模糊身份候选等无法可靠用规则解决的可选增强，才允许通过 `deepseek_provider.mjs` 调用 DeepSeek。

目标机可按需设置用户级环境变量（不配置也不影响主更新）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/expert_tracking_sources/configure-deepseek.ps1
```

脚本会隐藏输入并保存到当前 Windows 用户环境变量，不把密钥写入源码、配置文件或部署包。设置后重新登录 Windows，或重启任务计划程序的运行进程即可生效。

接口层强制结构化 JSON、低温度、60 秒超时、三次退避重试和密钥脱敏。AI 结果只能作为“推断/候选”，不能覆盖原始持仓、买卖事实或来源证据；接口失败时必须跳过 AI 增强并继续发布确定性结果。

旧的一键入口仍保留用于开发排查：

```powershell
node tools/expert_tracking_sources/update_all.mjs --date YYYY-MM-DD
```

若两赛当天数据已经抓过，只更新社区来源并重建档案：

```powershell
node tools/expert_tracking_sources/update_all.mjs --date YYYY-MM-DD --skip-competitions
```

更新流程会自动运行 `backfill_competition_history.mjs`：顽主杯榜单用于发现选手，并对网站已建档的全部选手按 `user_id` 拉取本赛季个人历史披露；复利笔记则对已建档选手按 `openId + 日期` 回填本赛季公开报单。两者即使选手掉出榜单也继续跟踪；未披露日期只记为待补，下一次更新自动回补，不会被解释为空仓或卖出。

雪球当前持仓与逐次调仓链可以免登录抓取；爬虫会沿公开调仓记录回溯，并把“从 0 到持有”的日期标为明确买入时间。默认每个组合回溯 12 次，可单独运行时调整：

```powershell
node tools/expert_tracking_sources/crawl_public_sources.mjs --date YYYY-MM-DD --xueqiu-history-depth 30 --skip-tonghuashun
```

`XUEQIU_COOKIE` 只用于补充批量历史和部分用户动态，并非当前持仓/逐次调仓的必需条件。若使用自己的授权登录状态，可临时设置环境变量，Cookie 不会写入输出文件：

```powershell
$env:XUEQIU_COOKIE = "你的授权 Cookie"
node tools/expert_tracking_sources/crawl_public_sources.mjs --date YYYY-MM-DD --skip-tonghuashun
```

## 增加淘股吧具体用户

从主页地址 `https://www.tgb.cn/blog/13145799` 取末尾用户 ID：

```powershell
node tools/expert_tracking_sources/crawl_tgb_people.mjs `
  --user 13145799:橘子洲炒家实战 `
  --user 其他用户ID:显示名 `
  --posts 10
```

默认名单在 `expert_roster.json`。同名跨平台账号在没有身份凭据前不自动合并。

## 主要输出

- `expert_profiles_日期_report.md`：基金经理阅读版，含核心高手最近持仓、历史高频持仓和风格。
- `expert_profiles_日期_holdings.csv`：逐人逐日持仓事实表。
- `expert_profiles_日期_transactions.csv`：相邻有效披露日推断的换仓表。
- `expert_profiles_日期_styles.csv`：仓位、集中度、换手和平台标签。
- `tgb_people_日期_signals.csv`：淘股吧文章逐股观点与短证据。

## 证据口径

- 比赛账户结构化披露：高置信事实。
- 相邻收盘日从无到有/从有到无：高置信的新进/退出；金额变化只记“疑似加减仓”。
- 相邻收盘日从有到无在档案和网页中明确标为“卖出/退出”，同时保留前一持仓金额与确认日期；未披露日不会误判为空仓或卖出。
- 社区文章：股票链接先记“提及”；必须出现明确交易措辞才记买入、持有、加仓或卖出。
- 登录、付费、验证码和关注后可见字段不绕过；统一保留“不可得”状态。
