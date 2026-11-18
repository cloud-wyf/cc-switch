import type {
  ProxyEventBody,
  ProxyEventDetail,
  ProxyEventSummary,
} from "@/types/proxy";

/** 只将已确认 SSE 完成后的正常释放作为说明；真实 I/O 错误仍显示为异常。 */
export function getProxyEventOutcome(event: ProxyEventSummary) {
  const upstreamError =
    event.stream_error &&
    event.stream_error !== "upstream body not fully consumed"
      ? event.stream_error
      : null;
  const expectedClose =
    event.finish_reason === "cancelled" &&
    event.client_sse_status === "completed" &&
    event.client_status !== null &&
    event.client_status >= 200 &&
    event.client_status < 300 &&
    (!event.error || event.error === "body not fully consumed") &&
    !upstreamError;
  const sseFailed =
    event.client_sse_status === "failed" ||
    event.client_sse_status === "incomplete";
  const error = expectedClose
    ? null
    : event.error === "body not fully consumed"
      ? upstreamError || (sseFailed ? null : event.error)
      : event.error || upstreamError;
  const key = expectedClose
    ? "completedBeforeClose"
    : event.finish_reason === "stream_error"
      ? "streamError"
      : sseFailed
        ? event.client_sse_status
        : event.finish_reason === "cancelled"
          ? "cancelled"
          : event.client_sse_status || "httpCompleted";
  return {
    key,
    error,
    expectedClose,
    isError:
      Boolean(error) ||
      sseFailed ||
      event.finish_reason === "stream_error" ||
      (event.finish_reason === "cancelled" && !expectedClose),
  };
}

export type ResolvedBody =
  | { kind: "json"; data: unknown; note?: string }
  | { kind: "text"; data: string; note?: string }
  | { kind: "base64"; data: string; note?: string }
  | { kind: "empty" | "omitted" | "unavailable"; note?: string };

type BodyColumn =
  | "orig_body"
  | "script_body"
  | "fwd_body"
  | "resp_body"
  | "client_body";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 差异编码只在原始正文完整且为 JSON 对象时才能还原成生效正文。 */
export function applyDelta(
  base: ProxyEventBody | null | undefined,
  delta: ProxyEventBody,
): Record<string, unknown> | undefined {
  if (
    !base ||
    base.encoding !== "json" ||
    base.truncated ||
    base.complete === false ||
    !isObject(base.data)
  ) {
    return undefined;
  }
  const data = isObject(delta.data) ? delta.data : {};
  const set = isObject(data.set) ? data.set : {};
  const unset = Array.isArray(data.unset) ? (data.unset as string[]) : [];
  const result: Record<string, unknown> = { ...base.data };
  for (const key of unset) delete result[key];
  return { ...result, ...set };
}

/**
 * 把一列正文解析成可展示的内容：跟随 same_as / forwarded 引用，
 * delta 合并到原始请求上；无法还原时返回 unavailable 并说明原因。
 */
export function resolveBody(
  event: ProxyEventDetail,
  column: BodyColumn,
  depth = 0,
): ResolvedBody {
  const body = event[column];
  if (!body || depth > 3) return { kind: "unavailable" };
  switch (body.encoding) {
    case "json":
      return { kind: "json", data: body.data };
    case "text":
      return { kind: "text", data: String(body.data ?? "") };
    case "base64":
      return { kind: "base64", data: String(body.data ?? "") };
    case "empty":
      return { kind: "empty" };
    case "omitted":
      return { kind: "omitted" };
    case "forwarded":
      return resolveBody(event, "resp_body", depth + 1);
    case "same_as":
      return resolveBody(
        event,
        body.ref === "orig_body" ? "orig_body" : "script_body",
        depth + 1,
      );
    case "delta": {
      const merged = applyDelta(event.orig_body, body);
      return merged
        ? { kind: "json", data: merged }
        : { kind: "unavailable", note: "delta" };
    }
    default:
      return { kind: "unavailable" };
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
