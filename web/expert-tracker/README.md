# 高手持仓共识模块

面向基金经理的可部署静态网页。数据来自工作区已有的高手档案JSON，页面本身不在浏览器中直接调用第三方网站。

## 本地运行

在 PowerShell 中执行一键启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File web/expert-tracker/start-web.ps1
```

也可以分别执行：

```powershell
node web/expert-tracker/sync-data.mjs
node web/expert-tracker/server.mjs
```

然后打开 `http://127.0.0.1:4178`。

## 原生接入另一网站

在宿主网站正式路由中挂载：

```html
<div id="expertTrackerFeature"></div>
<script type="module">
  import { mountExpertTracker } from "/expert-tracker/native-entry.js";
  const feature = await mountExpertTracker(document.getElementById("expertTrackerFeature"), {
    assetBase: "/expert-tracker/",
    dataBase: "/expert-tracker/data/",
  });
</script>
```

`native-entry.js` 负责模板、数据路径和生命周期，`embed.scoped.css` 隔离宿主全局样式。SPA 路由退出时调用 `feature.unmount()`。`native-preview.html` 是带冲突宿主样式的原生接入验收页；iframe 仅作为兼容备选。

## 更新流程

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/expert_tracking_sources/run-stable-update.ps1 --date YYYY-MM-DD
```

稳定入口包含分来源重试、单实例锁、异常隔离、最近有效数据兜底、历史回补、原子同步与健康状态。跨电脑部署使用 `install-windows-schedule.ps1` 安装收盘主更新与晚间补救任务。

比赛历史会在更新时自动回填：顽主杯对网站已建档的全部选手按 ID 拉取本赛季个人历史披露，复利笔记对已建档选手按 ID 直接补齐本赛季公开报单。选手掉出榜单后仍继续跟踪；相邻有效披露日从有到无才显示为“卖出/退出”，没有披露的日期只进入待补队列。

雪球组合会把公开的当前持仓、权重、行业、策略说明和收益缓存到本地，并沿公开调仓链回溯明确买入时间。`XUEQIU_COOKIE` 只用于补充批量历史和部分用户动态；Cookie 不会写入网页数据或版本库。

## 页面能力

- 多平台持仓共识排行，以及顽主杯、复利笔记、雪球分平台持仓排行。
- 按具体选手、来源和风格搜索。
- 自动统计可识别股票的覆盖平台、持有人与已披露敞口。
- 查看收益/仓位轨迹、最近持仓、交易变化与风格指标。
- 站内查看雪球热门组合的当前持仓、权重、行业、本地历史快照与风格画像，不需要跳转外站。
- 仅对至少 5 个有效披露日的比赛选手输出交易风格与选股风格画像，并标注样本置信度。

`data/` 是构建产物；正式网站可将同结构JSON改由后端API返回。

## 证据边界

- 比赛持仓属于结构化账户事实，可以用于集中度、换仓和回测。
- 淘股吧文章属于公开观点，只用于解释交易理念和选股偏好，不能当作真实持仓。
- 雪球组合持仓是公开模拟组合仓位，不等同于主理人的真实证券账户；完整调仓流水与用户动态若要求登录，系统保留“受限”状态，部署端可接入用户授权 Cookie 继续补充。
