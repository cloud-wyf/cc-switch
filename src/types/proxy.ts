export interface ProxyConfig {
  listen_address: string;
  listen_port: number;
  max_retries: number;
  request_timeout: number;
  enable_logging: boolean;
  live_takeover_active?: boolean;
  // 超时配置
  streaming_first_byte_timeout: number;
  streaming_idle_timeout: number;
  non_streaming_timeout: number;
}

export interface ProxyStatus {
  running: boolean;
  address: string;
  port: number;
  active_connections: number;
  total_requests: number;
  success_requests: number;
  failed_requests: number;
  success_rate: number;
  uptime_seconds: number;
  current_provider: string | null;
  current_provider_id: string | null;
  last_request_at: string | null;
  last_error: string | null;
  failover_count: number;
  active_targets?: ActiveTarget[];
}

export interface ActiveTarget {
  app_type: string;
  provider_name: string;
  provider_id: string;
}

export interface ProxyServerInfo {
  address: string;
  port: number;
  started_at: string;
}

export interface ProxyTakeoverStatus {
  claude: boolean;
  "claude-desktop"?: boolean;
  codex: boolean;
  gemini: boolean;
  grokbuild: boolean;
  opencode: boolean;
  openclaw: boolean;
  hermes: boolean;
}

export interface ProviderHealth {
  provider_id: string;
  app_type: string;
  is_healthy: boolean;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  updated_at: string;
}

// 熔断器相关类型
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutSeconds: number;
  errorRateThreshold: number;
  minRequests: number;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  failedRequests: number;
}

// 供应商健康状态枚举
export enum ProviderHealthStatus {
  Healthy = "healthy",
  Degraded = "degraded",
  Failed = "failed",
  Unknown = "unknown",
}

// 扩展 ProviderHealth 以包含前端计算的状态
export interface ProviderHealthWithStatus extends ProviderHealth {
  status: ProviderHealthStatus;
  circuitState?: CircuitState;
}

export interface ProxyUsageRecord {
  provider_id: string;
  app_type: string;
  endpoint: string;
  request_tokens: number | null;
  response_tokens: number | null;
  status_code: number;
  latency_ms: number;
  error: string | null;
  timestamp: string;
}

// 故障转移队列条目
export interface FailoverQueueItem {
  providerId: string;
  providerName: string;
  providerNotes?: string;
  sortIndex?: number;
}

// 全局代理配置（统一字段，三行镜像）
export interface GlobalProxyConfig {
  proxyEnabled: boolean;
  listenAddress: string;
  listenPort: number;
  enableLogging: boolean;
}

// 详细请求日志配置（所有本地代理请求共用）
export interface ProxyEventLogConfig {
  enabled: boolean;
  // 每个方向的正文采样上限，单位为字节；0 表示不保存正文。
  logBodyLimit: number;
  purgeDays: number;
}

export type ProxyEventStatusFilter =
  | "success"
  | "error"
  | "4xx"
  | "5xx"
  | "none";
export type ProxyEventSortKey =
  | "id"
  | "duration_ms"
  | "upstream_duration_ms"
  | "status"
  | "client_status"
  | "target"
  | "model"
  | "app_type";

// 详细请求日志列表查询；未设置的字段不过滤。
export interface ProxyEventQuery {
  appType?: string;
  providerId?: string;
  target?: string;
  model?: string;
  status?: ProxyEventStatusFilter;
  scriptUsed?: boolean;
  routeChanged?: boolean;
  search?: string;
  since?: number;
  until?: number;
  sortBy?: ProxyEventSortKey;
  sortDir?: "asc" | "desc";
  page: number;
  pageSize: number;
}

// 列表行：只含标量列，正文和报文头在详情里。
export interface ProxyEventSummary {
  id: number;
  request_id: string;
  app_type: string | null;
  provider_id: string | null;
  session_id: string | null;
  attempt: number;
  forward_seq: number;
  script_enabled: number;
  script_used: number;
  request_changed: number;
  route_changed: number;
  target: string;
  started_at: string;
  created_at: number;
  duration_ms: number;
  method: string;
  url: string;
  request_model: string | null;
  model: string | null;
  status: number | null;
  client_status: number | null;
  total_bytes: number | null;
  upstream_header_ms: number | null;
  upstream_duration_ms: number | null;
  finish_reason: string;
  error: string | null;
  fwd_url: string | null;
}

export interface ProxyEventPage {
  items: ProxyEventSummary[];
  total: number;
  failed: number;
  scriptUsed: number;
  avgDurationMs: number | null;
  page: number;
  pageSize: number;
}

// 正文包装：json/text/base64 直接带内容；delta 相对 orig_body 的顶层差异；
// same_as 引用 script_body；forwarded 引用 resp_body。
export interface ProxyEventBody {
  encoding:
    | "json"
    | "text"
    | "base64"
    | "empty"
    | "omitted"
    | "forwarded"
    | "delta"
    | "same_as";
  size?: number;
  truncated?: boolean;
  complete?: boolean;
  data?: unknown;
  base?: string;
  ref?: string;
}

export interface ProxyEventDetail extends ProxyEventSummary {
  fwd_method?: string | null;
  stream_error?: string | null;
  rewritten?: string | null;
  mods?: Record<string, unknown> | null;
  orig_headers?: Record<string, unknown> | null;
  orig_body?: ProxyEventBody | null;
  script_url?: string | null;
  script_headers?: Record<string, unknown> | null;
  script_body?: ProxyEventBody | null;
  fwd_headers?: Record<string, unknown> | null;
  fwd_body?: ProxyEventBody | null;
  resp_headers?: Record<string, unknown> | null;
  resp_body?: ProxyEventBody | null;
  client_headers?: Record<string, unknown> | null;
  client_body?: ProxyEventBody | null;
}

// 应用级代理配置（每个 app 独立）
export interface AppProxyConfig {
  appType: string;
  enabled: boolean;
  autoFailoverEnabled: boolean;
  maxRetries: number;
  streamingFirstByteTimeout: number;
  streamingIdleTimeout: number;
  nonStreamingTimeout: number;
  circuitFailureThreshold: number;
  circuitSuccessThreshold: number;
  circuitTimeoutSeconds: number;
  circuitErrorRateThreshold: number;
  circuitMinRequests: number;
}
