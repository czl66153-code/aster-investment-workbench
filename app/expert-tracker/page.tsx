import { AsterWorkbench } from "../page";

export const metadata = {
  title: "高手持仓与持续预测 | ASTER",
  description: "公开持仓排行、次日持仓概率、选手历史盲测准度、名单迭代与策略风格",
};

export default function ExpertTrackerPage() {
  return <AsterWorkbench initialPage="experts" />;
}
