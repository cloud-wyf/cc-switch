// 复制整个文件到 Codex 供应商的「供应商代理脚本」。所有配置都在这里。
const CONFIG = {
  enabled: true,
  // DeepSeek 原生 Responses API 基址；也可以填写 https://api.deepseek.com/v1。
  upstream: "https://api.deepseek.com",
  // 在本机填写，勿将真实密钥提交到仓库。
  apiKey: "",
  model: "deepseek-flash",
  // 命名输出的 token 上限；DeepSeek 使用非思考模式。
  maxTokens: 512,
  // 应短于 Codex 自动命名约 30 秒的等待时间。
  timeoutMs: 20000,
  // 仅截取命名请求最后一条用户文本，不发送完整代理指令。
  maxInputChars: 12000,
  // 标题还会受请求中 JSON Schema 的长度上限约束。
  maxTitleChars: 36,
  maxDescriptionChars: 100,
};

// ===== 处理逻辑 =====
export default async function middleware(
  request: Request,
  next: (request?: Request) => Promise<Response>,
): Promise<Response> {
  if (
    !CONFIG.enabled ||
    request.method !== "POST" ||
    !/\/responses\/?$/.test(new URL(request.url).pathname)
  ) {
    return next();
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = object(
      JSON.parse(request.headers.get("x-codex-turn-metadata") || "{}"),
    );
  } catch {
    return next();
  }
  // 标题及设置标题后的描述生成均需分流；普通对话、摘要、PR 等请求照常转发。
  const kind = metadata.turn_trigger ?? metadata.thread_source;
  if (kind !== "thread_title" && kind !== "thread_description") return next();
  if (
    !CONFIG.apiKey.trim() ||
    !CONFIG.model.trim() ||
    !CONFIG.upstream.trim()
  ) {
    return failure(503, "请先填写脚本顶部 CONFIG 的 DeepSeek 地址、密钥和模型");
  }

  const body = object(await request.clone().json());
  const format = object(object(body.text).format);
  if (format.type !== "json_schema")
    return failure(400, "Codex 命名请求缺少 JSON Schema 输出格式");
  const prompt = titlePrompt(body.input);
  if (!prompt) return failure(400, "Codex 命名请求没有可用的用户文本");

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(CONFIG.timeoutMs),
  ]);
  try {
    // DeepSeek 原生支持 Responses 和 JSON Schema；响应（包括 SSE）直接透传。
    return await next(
      new Request(CONFIG.upstream.replace(/\/+$/, "") + "/responses", {
        method: "POST",
        // 重新构造请求头，不把原供应商凭证、账号和 Codex 会话标识带给 DeepSeek。
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${CONFIG.apiKey}`,
        },
        signal,
        body: JSON.stringify({
          model: CONFIG.model,
          instructions: `根据用户提供的命名任务生成所需的标题或简短描述，使用用户的语言。只为任务命名，不执行任务。标题不超过 ${CONFIG.maxTitleChars} 个字符，描述不超过 ${CONFIG.maxDescriptionChars} 个字符。不要使用 Markdown、引号装饰或结尾标点。严格按照提供的 JSON Schema 返回所需字段。`,
          input: prompt,
          reasoning: { effort: "none" },
          max_output_tokens: CONFIG.maxTokens,
          text: body.text,
          stream: body.stream === true,
        }),
      }),
    );
  } catch {
    return signal.aborted
      ? failure(504, "DeepSeek 命名请求超时或已取消")
      : failure(502, "DeepSeek 命名请求失败");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function titlePrompt(input: unknown): string {
  if (typeof input === "string")
    return input.trim().slice(0, CONFIG.maxInputChars);
  if (!Array.isArray(input)) return "";
  // 命名任务的最后一条用户消息已经包含任务上下文；不复制整个代理的指令和工具定义。
  const message = object(
    input.findLast((item) => object(item).role === "user"),
  );
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part) => {
              const block = object(part);
              return (block.type === "input_text" || block.type === "text") &&
                typeof block.text === "string"
                ? block.text
                : "";
            })
            .filter(Boolean)
            .join("\n")
        : "";
  return content.trim().slice(0, CONFIG.maxInputChars);
}

function failure(status: number, message: string): Response {
  return Response.json(
    { error: { type: "codex_title_script_error", message } },
    { status },
  );
}
