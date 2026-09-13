// DeepSeek 原生 Responses 协议的模拟报文，用于脚本测试及本机 Codex 回放。
export const fixtureTitle = {
  title: "修复保存按钮",
  description: "修复点击保存按钮后配置无法保存的问题",
};

export function nativeResponse(content = fixtureTitle, overrides = {}) {
  return {
    id: "deepseek-response-fixture",
    object: "response",
    created_at: 1789283090,
    status: "completed",
    model: "deepseek-flash",
    output: [
      {
        id: "deepseek-message-fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(content),
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 15 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    store: false,
    error: null,
    incomplete_details: null,
    ...overrides,
  };
}

export function nativeStream(response = nativeResponse()) {
  const item = response.output[0];
  const part = item.content[0];
  const progress = {
    ...response,
    status: "in_progress",
    output: [],
    usage: null,
  };
  const location = { item_id: item.id, output_index: 0, content_index: 0 };
  return [
    { type: "response.created", response: progress },
    { type: "response.in_progress", response: progress },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...location,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...location, delta: part.text },
    { type: "response.output_text.done", ...location, text: part.text },
    { type: "response.content_part.done", ...location, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
    .map(
      (event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
    )
    .join("");
}
