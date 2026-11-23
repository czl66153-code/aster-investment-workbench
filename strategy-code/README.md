# Quantitative Research Portfolio

量化研究作品集的配套代码。两个样例使用合成输入，在本地运行，可直接查看策略规则和关键边界的实现。

| 研究项目 | 可运行代码 |
| --- | --- |
| [生止聚 · SZJ-v1](szj_v1/) | 收盘确认价止损、盈利后的峰值回撤退出、原退出规则优先级。 |
| [ABCD Core V3](abcd_core_v3/) | 09:35 截面的四因子加权打分、筹码候选池、行业上限和交易状态过滤。 |

## 快速运行

使用 Python 3.11 或以上版本，在仓库根目录运行。

```sh
python -m pip install -r abcd_core_v3/requirements.txt
python szj_v1/demo.py
python abcd_core_v3/demo.py
cd szj_v1
python -m unittest discover -s tests -v
```

生止聚样例输出触发退出信号及计划尝试执行的日期。ABCD 样例输出合成候选篮子，并校验打分公式、信息时点及行业上限。

历史研究结果来自作品集所述的独立实验。这里的样例只验证规则实现和输入边界。完整数据构建、成交与持仓账本、历史结果复现需要各实验对应的数据和评估程序。
