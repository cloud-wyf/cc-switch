// proxy2.js 的 CC Switch 中间件版本，适用于 Anthropic Messages 供应商。
// 整个文件复制到“供应商代理脚本”即可，主请求沿用供应商的地址和凭证。
// 所有可调参数集中在 CONFIG 中，脚本不依赖外部配置文件。

// ===== 配置区域：通常只需要修改这里 =====
const CONFIG = {
  fallback: {
    enabled: true, // 是否启用小请求分流，关闭后仍保留兼容处理。
    upstream: "https://api.deepseek.com/anthropic", // API 基址，不含 /v1/messages。
    apiKey: "", // 备用上游密钥；地址或密钥留空时不分流。
    authStyle: "x-api-key" as "bearer" | "x-api-key",
    model: "deepseek-v4-flash", // 留空则保留请求原来的模型名。
  },
  forwardProbe: false, // false：探测本地返回 200；true：按正常规则转发。
  routeMaxTokens: 32_000, // 分流请求允许的最大 max_tokens。
  routeMaxBodyBytes: 8192, // 分流请求允许的最大原始请求体字节数（8 KiB）。

  // Thinking 兼容参数：有 effort 时使用 adaptive，以下预算用于没有 effort 时。
  thinkingMinMaxTokens: 1100,
  thinkingBudgetTokens: 1024,
  thinkingBetas: ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"],

  // beta 清理规则：删除黑名单，以及缺少配套字段的 beta。
  dropBetas: ["structured-outputs-2025-12-15"],
  betaRequiresFields: {
    "interleaved-thinking-2025-05-14": "thinking",
    "context-1m-2025-08-07": "thinking",
    "redact-thinking-2026-02-12": "thinking",
    "context-management-2025-06-27": "context_management",
    "effort-2025-11-24": "output_config",
  } as Record<string, string>,
};

// ===== 处理逻辑 =====
type Next = (request?: Request) => Promise<Response>;

const DROP_BETAS = new Set(CONFIG.dropBetas);
const THINKING_BETAS = new Set(CONFIG.thinkingBetas);

async function ensureNonEmptyResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;

  // 等首个非空数据块再返回，保留空成功响应改成 502 的机会。
  const reader = response.body?.getReader();
  let first: ReadableStreamReadResult<Uint8Array> = {
    done: true,
    value: undefined,
  };
  if (reader) {
    try {
      do {
        first = await reader.read();
      } while (!first.done && first.value.byteLength === 0);
    } catch (error) {
      reader.releaseLock();
      throw error;
    }
  }
  if (first.done) {
    reader?.releaseLock();
    return Response.json(
      {
        error: {
          type: "api_error",
          message: "Upstream returned an empty successful response",
        },
      },
      { status: 502 },
    );
  }

  // 逐块转发 SSE，不等待完整响应；取消时同步取消上游读取。
  const initial = first.value;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(initial);
        },
        async pull(controller) {
          try {
            const chunk = await reader!.read();
            if (chunk.done) {
              reader!.releaseLock();
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            reader!.releaseLock();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader!.cancel(reason);
          } finally {
            reader!.releaseLock();
          }
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

export default async function middleware(
  request: Request,
  next: Next,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.endsWith("/messages")) {
    return next();
  }

  // 用改写前的实际字节数判断分流，中文和空白也计入上限。
  const rawBody = await request.clone().arrayBuffer();
  let body: Record<string, any>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
    if (!body || typeof body !== "object" || Array.isArray(body)) return next();
  } catch {
    return next();
  }

  if (body.max_tokens === 1 && !CONFIG.forwardProbe) {
    return Response.json({
      id: "msg_probe_" + crypto.randomUUID(),
      type: "message",
      role: "assistant",
      model: body.model ?? "unknown",
      content: [],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 1 },
    });
  }

  const headers = new Headers(request.headers);
  const betas = (headers.get("anthropic-beta") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const needsThinking = betas.some((value) => THINKING_BETAS.has(value));
  let changed = false;
  if (needsThinking && !body.thinking && Array.isArray(body.messages)) {
    if (body.output_config?.effort) {
      body.thinking = { type: "adaptive" };
      changed = true;
    } else if (
      typeof body.max_tokens === "number" &&
      body.max_tokens >= CONFIG.thinkingMinMaxTokens
    ) {
      body.thinking = {
        type: "enabled",
        budget_tokens: CONFIG.thinkingBudgetTokens,
      };
      changed = true;
    }
  }

  // 与原版顺序一致：先补 Thinking、清理 beta，再处理分流。
  // 保留 output_config，不主动补 1m beta。
  const kept = betas.filter((beta) => {
    const field = CONFIG.betaRequiresFields[beta];
    return !DROP_BETAS.has(beta) && (!field || Object.hasOwn(body, field));
  });
  if (kept.length) headers.set("anthropic-beta", kept.join(","));
  else headers.delete("anthropic-beta");

  const noTools = !Array.isArray(body.tools) || body.tools.length === 0;
  const maxTokens =
    typeof body.max_tokens === "number" ? body.max_tokens : Infinity;
  const fallback = CONFIG.fallback;
  let targetUrl = request.url;
  if (
    noTools &&
    maxTokens <= CONFIG.routeMaxTokens &&
    rawBody.byteLength <= CONFIG.routeMaxBodyBytes &&
    fallback.enabled &&
    fallback.upstream &&
    fallback.apiKey
  ) {
    // fallback.upstream 沿用原代理的 API 基址，保留 /anthropic 等前缀。
    targetUrl =
      fallback.upstream.replace(/\/+$/, "") + "/v1/messages" + url.search;
    headers.delete("authorization");
    headers.delete("x-api-key");
    if (fallback.authStyle === "x-api-key") {
      headers.set("x-api-key", fallback.apiKey);
    } else {
      headers.set("authorization", "Bearer " + fallback.apiKey);
    }
    body.thinking = { type: "disabled" };
    if (fallback.model) body.model = fallback.model;
    changed = true;
    console.info(
      "[proxy2] 小请求分流 → " +
        new URL(targetUrl).host +
        "，model=" +
        body.model,
    );
  }

  // Host 和长度由 CC Switch 根据目标 URL、实际请求体重新生成。
  for (const name of [
    "host",
    "content-length",
    "content-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }

  const response = await next(
    new Request(targetUrl, {
      method: request.method,
      headers,
      body: changed ? JSON.stringify(body) : rawBody,
      signal: request.signal,
    }),
  );
  return ensureNonEmptyResponse(response);
}
