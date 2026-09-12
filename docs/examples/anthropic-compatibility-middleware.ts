// 从 tools/proxy/src/proxy.ts 提取的请求/响应兼容逻辑。
// 适用于 Anthropic Messages 中转站；上游地址和凭证使用供应商本身的配置。
type Next = (request?: Request) => Promise<Response>;

const DROP_BETAS = new Set(["structured-outputs-2025-12-15"]);
const REQUIRES_FIELD: Record<string, string> = {
  "interleaved-thinking-2025-05-14": "thinking",
  "context-1m-2025-08-07": "thinking",
  "redact-thinking-2026-02-12": "thinking",
  "context-management-2025-06-27": "context_management",
  "effort-2025-11-24": "output_config",
};

export default async function middleware(
  request: Request,
  next: Next,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !path.endsWith("/messages")) return next();

  let body: Record<string, any>;
  try {
    body = await request.clone().json();
  } catch {
    return next();
  }

  // 探测请求在本地返回。需要验证真实上游连通性时删除这一分支。
  if (body.max_tokens === 1) {
    return Response.json({
      id: `msg_probe_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: body.model,
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
  const needsThinking = betas.some(
    (value) =>
      value === "context-1m-2025-08-07" ||
      value === "interleaved-thinking-2025-05-14",
  );
  if (needsThinking && !body.thinking && Array.isArray(body.messages)) {
    if (body.output_config?.effort) {
      body.thinking = { type: "adaptive" };
    } else if (typeof body.max_tokens === "number" && body.max_tokens >= 1100) {
      body.thinking = { type: "enabled", budget_tokens: 1024 };
    }
  }

  const kept = betas.filter(
    (beta) =>
      !DROP_BETAS.has(beta) &&
      (!REQUIRES_FIELD[beta] || Object.hasOwn(body, REQUIRES_FIELD[beta])),
  );
  if (kept.length) headers.set("anthropic-beta", kept.join(","));
  else headers.delete("anthropic-beta");

  const response = await next(
    new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) return response;

  // 只等首个非空数据块，不缓存完整 SSE。完全空的成功响应改为 502。
  const reader = response.body?.getReader();
  let first: ReadableStreamReadResult<Uint8Array> = {
    done: true,
    value: undefined,
  };
  if (reader) {
    do {
      first = await reader.read();
    } while (!first.done && first.value.byteLength === 0);
  }
  if (first.done) {
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

  const initial = first.value;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(initial);
      },
      async pull(controller) {
        const chunk = await reader!.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader!.cancel(reason);
      },
    }),
    { status: response.status, headers: response.headers },
  );
}
