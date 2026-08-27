import { openDatabase } from "../core.mjs";
import {
  lockForwardSignalSnapshot,
  readForwardSignalSnapshot,
  saveForwardStage,
  verifyForwardAudit,
  voidForwardCohort,
} from "../forward_test.mjs";

const TRADE_DATE = "2026-08-24";
const db = openDatabase();

try {
  const cohort = db.prepare(`SELECT cohort_id,entry_batch_ids_json,status
    FROM forward_cohorts WHERE account_key='abcd' AND entry_trade_date=?`).get(TRADE_DATE);
  const trades = cohort ? db.prepare(`SELECT t.trade_id,t.trade_time,t.code,t.quantity,t.price,t.recommendation_batch_id,
      CASE WHEN v.trade_id IS NULL THEN 0 ELSE 1 END AS is_voided
    FROM forward_trades t LEFT JOIN forward_trade_voids v ON v.trade_id=t.trade_id
    WHERE t.cohort_id=? ORDER BY t.created_at`).all(cohort.cohort_id) : [];

  const evidence = {
    correctionPolicy: "append_only",
    reasonCode: "MISSING_LOCKED_0945_SIGNAL",
    duckdb0945EventCount: 0,
    earliestRecommendationBucket: "2026-08-24 10:00:00",
    earliestFactorTime: "2026-08-24 10:13:31",
    earliestRealtimeBar: "2026-08-24 10:10:00",
    invalidTradeIds: trades.filter((row) => !row.is_voided).map((row) => row.trade_id),
    invalidBatchIds: [...new Set(trades.filter((row) => !row.is_voided).map((row) => row.recommendation_batch_id).filter(Boolean))],
  };
  const reason = "2026-08-24未保存09:45有效ABCD信号；禁止用10:00及更晚信号补买，原买入动作按审计规则作废";

  let signal = readForwardSignalSnapshot(db, "abcd", TRADE_DATE);
  if (!signal) {
    signal = lockForwardSignalSnapshot(db, {
      accountKey: "abcd",
      tradeDate: TRADE_DATE,
      signalClock: "09:45",
      signalBucket: null,
      status: "missed",
      recommendationBatchId: null,
      sourceAsOf: null,
      payload: { reason, evidence },
    });
  }
  if (signal.status !== "missed") throw new Error(`拒绝冲正：${TRADE_DATE}的09:45信号已锁定为${signal.status}`);

  const correction = voidForwardCohort(db, {
    accountKey: "abcd",
    tradeDate: TRADE_DATE,
    reason,
    evidence,
  });
  const stage = saveForwardStage(db, TRADE_DATE, "abcd", {
    status: "signal_missed",
    batchId: null,
    signalBucket: null,
    signalReadyAt: signal.created_at,
    accounts: { abcd: { status: "skipped", reason } },
    message: "09:45信号证据缺失，当日ABCD不交易；更晚批次不得回填。",
  });
  const account = db.prepare("SELECT account_key,cash,total_fees,realized_pnl,updated_at FROM forward_accounts WHERE account_key='abcd'").get();
  const activePositions = db.prepare(`SELECT COUNT(*) AS count FROM forward_trades t
    LEFT JOIN forward_trade_voids v ON v.trade_id=t.trade_id
    WHERE t.account_key='abcd' AND v.trade_id IS NULL
    GROUP BY t.code HAVING SUM(CASE WHEN t.side='BUY' THEN t.quantity ELSE -t.quantity END)>0`).all().length;
  const audit = verifyForwardAudit(db);
  console.log(JSON.stringify({ signal, correction, stage, account, activePositions, audit, originalTrades: trades }, null, 2));
} finally {
  db.close();
}
