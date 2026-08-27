# 成本均线与主峰距离：离线筹码模型实验

本目录只用于审查前实验，不会注册、发布或覆盖网站当前的正式/候选筹码模型。

实验分别使用网站现有的 `formal` 正样本和 `candidate` 正样本，并沿用各在线模型已经保存的显式负样本，重拟合两份独立的 ExtraTrees 影子模型。在原有 23 个同日横截面特征上增加：

`abs(main_peak_price - cost_line_price) / cost_line_price` 的同交易日全市场百分位。

其中成本线是当日完整筹码分布的加权平均价格，优先使用 `chip_avg_price`，缺失时才回退 `avg_cost`；主峰使用同日既有 8010 主峰算法结果。该因子不读取任何未来行情或未来收益。

运行示例：

```powershell
$env:PYTHONPATH = "D:\UnifiedResearchWorkbench\python_engine\vendor_exact"
& "D:\quant_runtime\bigquant_py311\python.exe" `
  "D:\UnifiedResearchWorkbench\experiments\chip_cost_peak_distance\run_experiment.py" `
  --trade-date 2026-08-24 `
  --output "D:\UnifiedResearchWorkbench\outputs\chip_cost_peak_distance_experiment\20260824_review"
```

输出目录中的 `comparison.json` 是完整对照，`formal/` 与 `candidate/` 分别包含未上线的实验 `model.joblib` 和元数据 `model.json`。
