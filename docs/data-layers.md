# 独立投研站数据分层

## Bronze：原始提供商层

- `raw_daily_bars`：BigQuant、Tushare 各自的日线原始标准化行，主键包含 `provider`。
- `raw_daily_basic`：两家来源的换手率与流通盘字段，Tushare 保存完整字段。
- 提供商调用失败或覆盖率不足时，本层和已发布层均不写入。

## Silver：统一行情层

- `bars_daily`：正式日线。OHLCV 优先 BigQuant，缺口由 Tushare 补齐。
- `daily_basic`：日度基础数据。优先 Tushare，BigQuant 当日换手率作为备用。
- `realtime_quotes`、`bars_30m`：仅接受 AkShare 盘中快照和分钟线。
- `chip_axes_snapshot`：筹码五轴及 JSON 形式的 23 个内部模型特征。

## Gold：研究与发布层

- `factor_snapshot`：20 日量比、5/20 日动量、MA20 偏离、20 日突破、波动率、回撤，以及推荐判断需要的行业、热度和形态派生值。
- `chip_model_rank_daily`：同一完整交易日截面上的正式/候选模型分、名次、百分位和各自版本。
- `recommendation_batches`、`recommendations`：只有通过数量、证券白名单和分数门禁的推荐批次。
- `dataset_versions`、`data_quality_checks`：发布版本、来源组合、覆盖率、校验和与失败原因。

## 发布顺序

1. BigQuant 与 Tushare 同批采集，先在内存完成双源和覆盖率检查。
2. 一个事务内写入 Bronze，并按来源优先级发布到 Silver。
3. 从 Silver 的至少 21 个交易日重建量价因子。
4. 筹码五轴和 23 个内部特征覆盖完整市场后，同时运行两个 joblib 模型。
5. Gold 发布成功后才刷新推荐；任一步失败继续读取上一发布版本。

密钥不属于任何数据库层。适配器只读取进程环境或 SDK 本地凭据库，任务参数、日志、API 响应和 SQLite 均不保存密钥。
