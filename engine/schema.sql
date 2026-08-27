PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS securities (
  code TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT,
  industry TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS factor_snapshot (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  name TEXT NOT NULL,
  industry TEXT,
  close REAL,
  pct_chg REAL,
  volume REAL,
  amount REAL,
  turnover_rate REAL,
  volume_ratio_20 REAL,
  ret_5d REAL,
  ret_10d REAL,
  ret_20d REAL,
  ret_30d REAL,
  ret_60d REAL,
  stock_ret_5d_rank INTEGER,
  stock_ret_10d_rank INTEGER,
  stock_ret_30d_rank INTEGER,
  stock_ret_60d_rank INTEGER,
  stock_top50_5_10_30 INTEGER NOT NULL DEFAULT 0,
  sector_ret_5d REAL,
  sector_ret_5d_rank INTEGER,
  sector_ret_5d_rank_pct REAL,
  sector_4d_streak INTEGER,
  bigquant_heat_score REAL,
  bigquant_heat_rank INTEGER,
  bigquant_heat_rank_pct REAL,
  bigquant_heat_date TEXT,
  bias_ma20 REAL,
  breakout_20 REAL,
  volatility_20 REAL,
  drawdown_20 REAL,
  industry_ret_4d REAL,
  previous_heat_score REAL,
  previous_heat_rank_pct REAL,
  formal_model_score REAL,
  formal_model_rank INTEGER,
  formal_model_rank_pct REAL,
  candidate_model_score REAL,
  candidate_model_rank INTEGER,
  candidate_model_rank_pct REAL,
  chip_cost_peak_distance_pct REAL,
  chip_cost_peak_abs_distance_rank_pct REAL,
  abcd_a_score REAL,
  abcd_b_score REAL,
  abcd_c_score REAL,
  abcd_d_score REAL,
  aia_sector_heat REAL,
  aia_stock_heat REAL,
  aia_leadership REAL,
  aia_technical_pattern REAL,
  m30_similarity REAL,
  five_platform_heat REAL,
  four_agent_score REAL,
  taoguba_sentiment REAL,
  daily_breakout_score REAL,
  source_payload TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

-- Latest complete intraday score panel emitted by the copied 8010 ABCD engine.
-- It is deliberately separate from factor_snapshot: intraday scores may lead
-- the latest BigQuant/Tushare close date and must never rewrite formal history.
CREATE TABLE IF NOT EXISTS intraday_factor_score_snapshot (
  code TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  score_time TEXT NOT NULL,
  abcd_a_score REAL,
  abcd_b_score REAL,
  abcd_c_score REAL,
  abcd_d_score REAL,
  d_available INTEGER NOT NULL DEFAULT 0,
  chip_model_version TEXT,
  shape_score_version TEXT,
  distribution_mode TEXT,
  source_quote_time TEXT,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (code) REFERENCES securities(code)
);

-- Full-market, deliberately compact factor layer.  Recommendation-specific
-- fields stay in factor_snapshot so AIA/8002 candidate semantics are unchanged.
CREATE TABLE IF NOT EXISTS market_factor_snapshot (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  name TEXT NOT NULL,
  industry TEXT,
  close REAL,
  pct_chg REAL,
  amount REAL,
  turnover_rate REAL,
  volume_ratio_20 REAL,
  ret_5d REAL,
  ret_10d REAL,
  ret_20d REAL,
  ret_30d REAL,
  ret_60d REAL,
  stock_ret_5d_rank INTEGER,
  stock_ret_10d_rank INTEGER,
  stock_ret_30d_rank INTEGER,
  stock_ret_60d_rank INTEGER,
  stock_top50_5_10_30 INTEGER NOT NULL DEFAULT 0,
  sector_ret_5d REAL,
  sector_ret_5d_rank INTEGER,
  sector_ret_5d_rank_pct REAL,
  sector_4d_streak INTEGER,
  bigquant_heat_score REAL,
  bigquant_heat_rank INTEGER,
  bigquant_heat_rank_pct REAL,
  bigquant_heat_date TEXT,
  bias_ma20 REAL,
  breakout_20 REAL,
  volatility_20 REAL,
  drawdown_20 REAL,
  industry_ret_4d REAL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS recommendation_batches (
  batch_id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  model_version TEXT,
  factor_version_id TEXT,
  quote_version_id TEXT,
  message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS recommendations (
  batch_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  code TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL,
  reason TEXT,
  risk TEXT,
  confidence REAL,
  payload_json TEXT,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, code),
  FOREIGN KEY (batch_id) REFERENCES recommendation_batches(batch_id),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS model_definitions (
  model_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  refresh_mode TEXT NOT NULL,
  refresh_seconds INTEGER,
  logic_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Durable, versioned user controls for the three recommendation models.
-- The JSON shape is grouped because the heat model has platform, stage-one
-- and confirmation weights while AIA also has separate pattern bonuses.
CREATE TABLE IF NOT EXISTS model_weight_configs (
  model_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'original' CHECK (mode IN ('original','custom')),
  weights_json TEXT NOT NULL,
  default_weights_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_weight_config_history (
  history_id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  weights_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  changed_by TEXT NOT NULL DEFAULT 'local_ui',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_key) REFERENCES model_weight_configs(model_key)
);

-- User-owned screener recipes.  A saved recipe is a versioned rule snapshot;
-- generated candidates are immutable batches and are never confused with the
-- interactive screener result or the three recommendation engines.
CREATE TABLE IF NOT EXISTS saved_screener_strategies (
  strategy_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rule_tag TEXT NOT NULL DEFAULT '自定义',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  run_time TEXT NOT NULL DEFAULT '08:10',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  trading_days_only INTEGER NOT NULL DEFAULT 1 CHECK (trading_days_only IN (0,1)),
  filters_json TEXT NOT NULL,
  weights_json TEXT NOT NULL,
  weight_directions_json TEXT NOT NULL,
  sort_json TEXT NOT NULL,
  limit_count INTEGER NOT NULL DEFAULT 20,
  revision INTEGER NOT NULL DEFAULT 1,
  last_run_date TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS screener_candidate_batches (
  batch_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  factor_date TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled','manual')),
  status TEXT NOT NULL CHECK (status IN ('published','rejected')),
  item_count INTEGER NOT NULL DEFAULT 0,
  strategy_revision INTEGER NOT NULL,
  rule_snapshot_json TEXT NOT NULL,
  data_status_json TEXT NOT NULL,
  message TEXT,
  generated_at TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES saved_screener_strategies(strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_screener_candidate_batches_strategy_date
  ON screener_candidate_batches(strategy_id,run_date,generated_at);

CREATE TABLE IF NOT EXISTS screener_candidate_items (
  batch_id TEXT NOT NULL,
  code TEXT NOT NULL,
  rank INTEGER NOT NULL,
  composite_score REAL,
  factor_payload_json TEXT NOT NULL,
  PRIMARY KEY (batch_id,code),
  FOREIGN KEY (batch_id) REFERENCES screener_candidate_batches(batch_id),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS model_registry (
  scope TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_path TEXT,
  sample_count INTEGER,
  ready_count INTEGER,
  revision INTEGER,
  applied_revision INTEGER,
  pending_retrain INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Third chip model workspace.  It is intentionally isolated from the two
-- production registries until an independently reviewed positive-sample set
-- and validation report exist.
CREATE TABLE IF NOT EXISTS experimental_chip_models (
  scope TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  model_version TEXT NOT NULL DEFAULT 'not_trained',
  factor_spec_json TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  applied_revision INTEGER NOT NULL DEFAULT 0,
  pending_retrain INTEGER NOT NULL DEFAULT 0,
  production_enabled INTEGER NOT NULL DEFAULT 0 CHECK (production_enabled=0),
  status TEXT NOT NULL DEFAULT 'sample_collection',
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS experimental_chip_samples (
  sample_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  sample_label INTEGER NOT NULL DEFAULT 1 CHECK (sample_label IN (0,1)),
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  profile_ready INTEGER NOT NULL DEFAULT 0,
  main_peak_price REAL,
  second_peak_price REAL,
  profit_ratio REAL,
  peak2_ratio REAL,
  peak_width_70 REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(scope,code,trade_date),
  FOREIGN KEY (scope) REFERENCES experimental_chip_models(scope),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS chip_samples (
  sample_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('formal','candidate')),
  sample_label INTEGER NOT NULL DEFAULT 1 CHECK (sample_label IN (0,1)),
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  name TEXT,
  reason TEXT,
  source TEXT,
  profile_ready INTEGER NOT NULL DEFAULT 0,
  main_peak_price REAL,
  second_peak_price REAL,
  profit_ratio REAL,
  peak2_ratio REAL,
  peak_width_70 REAL,
  created_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Compact, independently stored points used to render positive-sample chip
-- profiles.  Points are materialized from this deployment's own DuckDB and
-- survive without any of the legacy web services.
CREATE TABLE IF NOT EXISTS chip_distribution_points (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  point_index INTEGER NOT NULL,
  price REAL NOT NULL,
  chips_ratio REAL NOT NULL,
  close REAL,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, trade_date, point_index),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS bars_30m (
  code TEXT NOT NULL,
  trade_time TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL,
  amount REAL,
  source TEXT,
  unit_version TEXT,
  volume_unit TEXT,
  amount_unit TEXT,
  unit_repair_note TEXT,
  PRIMARY KEY (code, trade_time)
);

CREATE TABLE IF NOT EXISTS bars_daily (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL,
  amount REAL,
  unit_version TEXT,
  volume_unit TEXT,
  amount_unit TEXT,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

-- Bronze layer.  Provider rows are kept separately so BigQuant/Tushare can be
-- audited without allowing a partial fetch to overwrite the published layer.
CREATE TABLE IF NOT EXISTS raw_daily_bars (
  provider TEXT NOT NULL,
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  pre_close REAL,
  pct_chg REAL,
  volume REAL,
  amount REAL,
  adj_factor REAL,
  unit_version TEXT,
  volume_unit TEXT,
  amount_unit TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, code, trade_date)
);

CREATE TABLE IF NOT EXISTS raw_daily_basic (
  provider TEXT NOT NULL,
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close REAL,
  turnover_rate REAL,
  turnover_rate_f REAL,
  volume_ratio REAL,
  float_share REAL,
  free_share REAL,
  total_mv REAL,
  circ_mv REAL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, code, trade_date)
);

-- Silver layer used by the factor engine.  Tushare is preferred because it
-- supplies the richer daily_basic fields; BigQuant remains a same-day fallback.
CREATE TABLE IF NOT EXISTS daily_basic (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close REAL,
  turnover_rate REAL,
  turnover_rate_f REAL,
  volume_ratio REAL,
  float_share REAL,
  free_share REAL,
  total_mv REAL,
  circ_mv REAL,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

-- Durable fallback for the Redis-backed multi-period ranking payload. Redis is
-- the hot path; this row keeps the last published trading-day result available
-- when Redis is absent or temporarily unreachable.
CREATE TABLE IF NOT EXISTS sector_stock_rank_cache (
  cache_key TEXT PRIMARY KEY,
  calc_trade_date TEXT NOT NULL,
  update_time TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chip_axes_snapshot (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  shape_sharpness REAL NOT NULL,
  shape_compactness REAL NOT NULL,
  shape_symmetry REAL NOT NULL,
  shape_single_peak REAL NOT NULL,
  shape_profit_quality REAL NOT NULL,
  internal_features_json TEXT,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS chip_model_rank_daily (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  formal_score REAL,
  formal_rank INTEGER,
  formal_rank_pct REAL,
  formal_model_version TEXT,
  candidate_score REAL,
  candidate_rank INTEGER,
  candidate_rank_pct REAL,
  candidate_model_version TEXT,
  multi_period_score REAL,
  multi_period_rank INTEGER,
  multi_period_rank_pct REAL,
  multi_period_model_version TEXT,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS realtime_quotes (
  code TEXT PRIMARY KEY,
  name TEXT,
  price REAL,
  open_price REAL,
  prev_close REAL,
  pct_chg REAL,
  volume REAL,
  amount REAL,
  turnover_rate REAL,
  unit_version TEXT,
  turnover_source TEXT,
  unit_audit_json TEXT,
  quote_time TEXT,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_profiles (
  template_id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  display_name TEXT NOT NULL,
  confidence REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  vector_json TEXT NOT NULL,
  image_path TEXT,
  version TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS template_matches (
  code TEXT NOT NULL,
  trade_time TEXT NOT NULL,
  template_id TEXT NOT NULL,
  similarity REAL NOT NULL,
  rule_score REAL,
  adjusted_score REAL,
  hit INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  PRIMARY KEY (code, trade_time, template_id)
);

-- Durable K-line similarity workbench.  The current scan reads only the
-- canonical formal daily and AKShare intraday tables; migrated legacy files
-- are indexed separately as immutable audit assets.
CREATE TABLE IF NOT EXISTS kline_similarity_scans (
  scan_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  trade_date TEXT,
  signal_time TEXT,
  modules_json TEXT NOT NULL,
  thresholds_json TEXT NOT NULL,
  scope_limit INTEGER NOT NULL,
  refresh_intraday INTEGER NOT NULL DEFAULT 0,
  source_policy_json TEXT NOT NULL DEFAULT '{}',
  coverage_json TEXT NOT NULL DEFAULT '{}',
  funnel_json TEXT NOT NULL DEFAULT '{}',
  result_count INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS kline_similarity_results (
  scan_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  industry TEXT,
  rank INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0,
  best_score REAL,
  combined_score REAL,
  module_hits_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  PRIMARY KEY (scan_id, code),
  FOREIGN KEY (scan_id) REFERENCES kline_similarity_scans(scan_id) ON DELETE CASCADE,
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE INDEX IF NOT EXISTS idx_kline_similarity_results_scan_rank
ON kline_similarity_results(scan_id, matched DESC, rank);

CREATE TABLE IF NOT EXISTS kline_similarity_assets (
  asset_id TEXT PRIMARY KEY,
  source_package TEXT NOT NULL,
  source_relative_path TEXT NOT NULL,
  local_relative_path TEXT NOT NULL,
  module TEXT,
  snapshot_date TEXT,
  source_kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  row_count INTEGER,
  sha256 TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  UNIQUE(source_package, source_relative_path)
);

CREATE INDEX IF NOT EXISTS idx_kline_similarity_assets_module_date
ON kline_similarity_assets(module, snapshot_date);

CREATE TABLE IF NOT EXISTS news_evidence (
  evidence_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  source TEXT,
  url TEXT,
  published_at TEXT,
  related_codes TEXT,
  industry TEXT,
  sentiment REAL,
  relevance REAL,
  raw_json TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_sessions (
  session_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  target TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES ai_sessions(session_id)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT,
  rows_changed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_definitions (
  schedule_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  session_type TEXT NOT NULL,
  cron_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_age_seconds INTEGER NOT NULL,
  retry_limit INTEGER NOT NULL DEFAULT 3,
  quality_gate TEXT NOT NULL,
  last_started_at TEXT,
  last_success_at TEXT,
  next_run_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset_key TEXT NOT NULL,
  version_id TEXT NOT NULL,
  trade_date TEXT,
  row_count INTEGER NOT NULL,
  checksum TEXT,
  status TEXT NOT NULL CHECK (status IN ('staging','published','rejected','superseded')),
  source TEXT,
  quality_score REAL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (dataset_key, version_id)
);

-- One provider acquisition may feed several website modules.  This ledger is
-- the canonical "fetch once, publish many" record and intentionally stores
-- metadata only; large market payloads remain in DuckDB/Parquet.
CREATE TABLE IF NOT EXISTS data_acquisition_batches (
  batch_id TEXT PRIMARY KEY,
  dataset_key TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  session_type TEXT NOT NULL,
  trade_date TEXT,
  as_of TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  status TEXT NOT NULL,
  storage_layer TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS dataset_dependencies (
  child_dataset_key TEXT NOT NULL,
  child_version_id TEXT NOT NULL,
  parent_dataset_key TEXT NOT NULL,
  parent_version_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'derived_from',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (child_dataset_key, child_version_id, parent_dataset_key, parent_version_id)
);

CREATE TABLE IF NOT EXISTS maintenance_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  event_date TEXT,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS data_quality_checks (
  check_id TEXT PRIMARY KEY,
  dataset_key TEXT NOT NULL,
  version_id TEXT,
  check_name TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  observed_value TEXT,
  expected_value TEXT,
  message TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchdog_heartbeats (
  service_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  pid INTEGER,
  last_heartbeat_at TEXT NOT NULL,
  last_error TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS client_error_events (
  event_id TEXT PRIMARY KEY,
  module_key TEXT NOT NULL,
  route TEXT,
  phase TEXT,
  message TEXT NOT NULL,
  source TEXT,
  stack TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_client_error_events_module_created
ON client_error_events(module_key, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_registry (
  backup_id TEXT PRIMARY KEY,
  database_path TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  size_bytes INTEGER,
  checksum TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

-- Forward-only paper verification.  These four accounts are intentionally
-- separate from recommendations and never backfill historical fills.
CREATE TABLE IF NOT EXISTS forward_test_settings (
  settings_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  entry_time TEXT NOT NULL DEFAULT '09:45',
  initial_capital REAL NOT NULL,
  daily_allocation_ratio REAL NOT NULL,
  fee_rate REAL NOT NULL,
  stamp_tax_rate REAL NOT NULL,
  lot_size INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forward_signal_snapshots (
  signal_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  signal_clock TEXT NOT NULL,
  signal_bucket TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready','empty','missed','error')),
  recommendation_batch_id TEXT,
  source_as_of TEXT,
  generated_at TEXT NOT NULL,
  checksum TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(account_key, trade_date, signal_clock),
  FOREIGN KEY (account_key) REFERENCES forward_accounts(account_key),
  FOREIGN KEY (recommendation_batch_id) REFERENCES recommendation_batches(batch_id)
);

CREATE TABLE IF NOT EXISTS forward_execution_quotes (
  trade_date TEXT NOT NULL,
  execution_time TEXT NOT NULL,
  code TEXT NOT NULL,
  price REAL NOT NULL,
  prev_close REAL,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (trade_date, execution_time, code),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS forward_accounts (
  account_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  initial_capital REAL NOT NULL,
  cash REAL NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  total_fees REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forward_cohorts (
  cohort_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  entry_trade_date TEXT NOT NULL,
  target_exit_rule TEXT NOT NULL,
  entry_batch_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','partial','closed','skipped')),
  allocated_cash REAL NOT NULL DEFAULT 0,
  entry_value REAL NOT NULL DEFAULT 0,
  exit_value REAL NOT NULL DEFAULT 0,
  pnl REAL,
  return_pct REAL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  skip_reason TEXT,
  UNIQUE(account_key, entry_trade_date),
  FOREIGN KEY (account_key) REFERENCES forward_accounts(account_key)
);

CREATE TABLE IF NOT EXISTS forward_trades (
  trade_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  trade_date TEXT NOT NULL,
  trade_time TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  gross_amount REAL NOT NULL,
  commission REAL NOT NULL,
  stamp_tax REAL NOT NULL DEFAULT 0,
  net_cash_flow REAL NOT NULL,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  recommendation_model TEXT,
  recommendation_batch_id TEXT,
  recommendation_rank INTEGER,
  recommendation_score REAL,
  consensus_count INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_key) REFERENCES forward_accounts(account_key),
  FOREIGN KEY (cohort_id) REFERENCES forward_cohorts(cohort_id),
  FOREIGN KEY (code) REFERENCES securities(code)
);

CREATE TABLE IF NOT EXISTS forward_trade_voids (
  trade_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  replacement_trade_ids_json TEXT NOT NULL DEFAULT '[]',
  voided_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (trade_id) REFERENCES forward_trades(trade_id)
);

CREATE TABLE IF NOT EXISTS forward_equity_daily (
  account_key TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  cash REAL NOT NULL,
  market_value REAL NOT NULL,
  total_equity REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  unrealized_pnl REAL NOT NULL,
  return_pct REAL NOT NULL,
  source TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (account_key, trade_date),
  FOREIGN KEY (account_key) REFERENCES forward_accounts(account_key)
);

CREATE TABLE IF NOT EXISTS forward_audit_events (
  event_id TEXT PRIMARY KEY,
  sequence_no INTEGER NOT NULL UNIQUE,
  account_key TEXT,
  event_type TEXT NOT NULL,
  event_time TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE
);

-- Independent materialization of the original 8002 five-platform rankings.
-- Raw platform rows and the weighted aggregate are kept separately so the UI
-- can show source failures without confusing them with a valid stock rank.
CREATE TABLE IF NOT EXISTS five_platform_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  success_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  weights_json TEXT NOT NULL,
  refresh_failed INTEGER NOT NULL DEFAULT 0,
  source_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS five_platform_sources (
  snapshot_id TEXT NOT NULL,
  platform_key TEXT NOT NULL,
  platform_name TEXT NOT NULL,
  ok INTEGER NOT NULL,
  source_date TEXT,
  stale_date TEXT,
  stale_used INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, platform_key),
  FOREIGN KEY (snapshot_id) REFERENCES five_platform_snapshots(snapshot_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS five_platform_items (
  snapshot_id TEXT NOT NULL,
  platform_key TEXT NOT NULL,
  rank INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  heat TEXT,
  change_value TEXT,
  PRIMARY KEY (snapshot_id, platform_key, rank),
  FOREIGN KEY (snapshot_id, platform_key) REFERENCES five_platform_sources(snapshot_id, platform_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS five_platform_combined (
  snapshot_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  score REAL NOT NULL,
  platform_count INTEGER NOT NULL,
  contributions_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, rank),
  FOREIGN KEY (snapshot_id) REFERENCES five_platform_snapshots(snapshot_id) ON DELETE CASCADE
);

-- Standardized local-only Taoguba input requested by the pre-open panel.
-- Rows are materialized from the already-copied 8002 SQLite databases; this
-- table is never populated by a network crawler in the pre-open task.
CREATE TABLE IF NOT EXISTS taoguba_posts (
  post_id TEXT PRIMARY KEY,
  post_title TEXT,
  post_content TEXT,
  post_author TEXT,
  post_publish_time TEXT NOT NULL,
  post_origin_url TEXT NOT NULL,
  post_hot_score REAL NOT NULL DEFAULT 0,
  source_table TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Structured enrichment stays in the independent database so the pre-open
-- panel does not need to read the legacy crawler databases after ingestion.
CREATE TABLE IF NOT EXISTS taoguba_post_enrichment (
  post_id TEXT PRIMARY KEY,
  author_id TEXT,
  author_verified INTEGER NOT NULL DEFAULT 0,
  author_badge TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  stock_mentions_json TEXT NOT NULL DEFAULT '[]',
  industry_mentions_json TEXT NOT NULL DEFAULT '[]',
  raw_quality_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES taoguba_posts(post_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS preopen_daily_summaries (
  summary_date TEXT PRIMARY KEY,
  generate_datetime TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  news_source_count INTEGER NOT NULL DEFAULT 0,
  taoguba_source_count INTEGER NOT NULL DEFAULT 0,
  llm_model TEXT NOT NULL DEFAULT 'deepseek-chat',
  error_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS community_hot_topic_summaries (
  summary_date TEXT PRIMARY KEY,
  generate_datetime TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  taoguba_source_count INTEGER NOT NULL DEFAULT 0,
  kaipanla_source_count INTEGER NOT NULL DEFAULT 0,
  xueqiu_source_count INTEGER NOT NULL DEFAULT 0,
  llm_model TEXT NOT NULL DEFAULT 'deepseek-chat',
  error_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_factor_snapshot_trade_date ON factor_snapshot(trade_date);
CREATE INDEX IF NOT EXISTS idx_market_factor_snapshot_date ON market_factor_snapshot(trade_date,code);
CREATE INDEX IF NOT EXISTS idx_market_factor_snapshot_industry ON market_factor_snapshot(trade_date,industry);
CREATE INDEX IF NOT EXISTS idx_factor_snapshot_industry_date ON factor_snapshot(industry, trade_date);
CREATE INDEX IF NOT EXISTS idx_factor_snapshot_formal_rank ON factor_snapshot(trade_date, formal_model_rank);
CREATE INDEX IF NOT EXISTS idx_factor_snapshot_candidate_rank ON factor_snapshot(trade_date, candidate_model_rank);
CREATE INDEX IF NOT EXISTS idx_intraday_factor_score_date ON intraday_factor_score_snapshot(trade_date, score_time);
CREATE INDEX IF NOT EXISTS idx_recommendations_model_date ON recommendations(model_key, trade_date, rank);
CREATE INDEX IF NOT EXISTS idx_batches_model_finished ON recommendation_batches(model_key, finished_at);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_evidence(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_industry ON news_evidence(industry, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_bars_code_time ON bars_30m(code, trade_time DESC);
CREATE INDEX IF NOT EXISTS idx_bars_daily_code_date ON bars_daily(code, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_raw_daily_bars_date_provider ON raw_daily_bars(trade_date, provider, code);
CREATE INDEX IF NOT EXISTS idx_raw_daily_basic_date_provider ON raw_daily_basic(trade_date, provider, code);
CREATE INDEX IF NOT EXISTS idx_daily_basic_code_date ON daily_basic(code, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_chip_axes_date ON chip_axes_snapshot(trade_date, code);
CREATE INDEX IF NOT EXISTS idx_chip_rank_date ON chip_model_rank_daily(trade_date, formal_rank, candidate_rank);
CREATE INDEX IF NOT EXISTS idx_realtime_quotes_time ON realtime_quotes(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_chip_samples_scope ON chip_samples(scope, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_weight_history_model ON model_weight_config_history(model_key, revision DESC);
CREATE INDEX IF NOT EXISTS idx_chip_distribution_sample ON chip_distribution_points(code, trade_date, point_index);
CREATE INDEX IF NOT EXISTS idx_quality_dataset_time ON data_quality_checks(dataset_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_version_time ON data_quality_checks(version_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_dataset_versions_status ON dataset_versions(dataset_key, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status_time ON alerts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_started ON sync_jobs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_dataset_date ON data_acquisition_batches(dataset_key, trade_date DESC, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dependencies_parent ON dataset_dependencies(parent_dataset_key, parent_version_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_events_type_date ON maintenance_events(event_type, event_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forward_cohort_status ON forward_cohorts(status, entry_trade_date);
CREATE INDEX IF NOT EXISTS idx_forward_trades_account_time ON forward_trades(account_key, trade_date DESC, trade_time DESC);
CREATE INDEX IF NOT EXISTS idx_forward_trades_cohort ON forward_trades(cohort_id, side);
CREATE INDEX IF NOT EXISTS idx_forward_audit_sequence ON forward_audit_events(sequence_no);
CREATE INDEX IF NOT EXISTS idx_five_platform_snapshot_date ON five_platform_snapshots(trade_date DESC, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_five_platform_items_code ON five_platform_items(code, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_taoguba_posts_time_hot ON taoguba_posts(post_publish_time, post_hot_score DESC);
CREATE INDEX IF NOT EXISTS idx_taoguba_enrichment_verified ON taoguba_post_enrichment(author_verified, view_count DESC, like_count DESC, reply_count DESC);

-- Simulation evidence and trade actions are append-only.  These triggers are
-- deliberately declared after every referenced table so a fresh database can
-- apply this schema atomically.
CREATE TRIGGER IF NOT EXISTS forward_signal_snapshots_no_update
BEFORE UPDATE ON forward_signal_snapshots
BEGIN
  SELECT RAISE(ABORT, 'forward signal snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_signal_snapshots_no_delete
BEFORE DELETE ON forward_signal_snapshots
BEGIN
  SELECT RAISE(ABORT, 'forward signal snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_execution_quotes_no_update
BEFORE UPDATE ON forward_execution_quotes
BEGIN
  SELECT RAISE(ABORT, 'forward execution quotes are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_execution_quotes_no_delete
BEFORE DELETE ON forward_execution_quotes
BEGIN
  SELECT RAISE(ABORT, 'forward execution quotes are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_trades_no_update
BEFORE UPDATE ON forward_trades
BEGIN
  SELECT RAISE(ABORT, 'forward trade actions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_trades_no_delete
BEFORE DELETE ON forward_trades
BEGIN
  SELECT RAISE(ABORT, 'forward trade actions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_abcd_buy_requires_locked_0945_signal
BEFORE INSERT ON forward_trades
WHEN NEW.account_key='abcd' AND NEW.side='BUY' AND (
  NEW.trade_time<>'09:50' OR NOT EXISTS (
    SELECT 1 FROM forward_signal_snapshots s
    WHERE s.account_key='abcd'
      AND s.trade_date=NEW.trade_date
      AND s.signal_clock='09:45'
      AND s.status='ready'
      AND s.recommendation_batch_id=NEW.recommendation_batch_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ABCD BUY requires locked 09:45 signal and 09:50 execution');
END;

CREATE TRIGGER IF NOT EXISTS forward_trade_voids_no_update
BEFORE UPDATE ON forward_trade_voids
BEGIN
  SELECT RAISE(ABORT, 'forward trade corrections are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_trade_voids_no_delete
BEFORE DELETE ON forward_trade_voids
BEGIN
  SELECT RAISE(ABORT, 'forward trade corrections are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_audit_events_no_update
BEFORE UPDATE ON forward_audit_events
BEGIN
  SELECT RAISE(ABORT, 'forward audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS forward_audit_events_no_delete
BEFORE DELETE ON forward_audit_events
BEGIN
  SELECT RAISE(ABORT, 'forward audit events are append-only');
END;
