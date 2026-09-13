import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runProxyScript } from "./helpers/proxy-script-runner.mjs";
import {
  fixtureTitle as title,
  nativeResponse as deepseekResponse,
  nativeStream,
} from "./helpers/codex-title-fixture.mjs";

const source = readFileSync(
  "docs/examples/codex-title-deepseek-middleware.ts",
  "utf8",
);
const primaryUrl = "https://primary.invalid/v1/responses";
const deepseekUrl = "https://deepseek.invalid/responses";
const schema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 36 },
    description: { type: "string", minLength: 1 },
  },
  required: ["title", "description"],
  additionalProperties: false,
};

// 来源：本机 Codex 0.154.0-alpha.6.2 的隔离 app-server 抓包。
// 只保留协议特征，任务、凭证和标识均为测试数据。
function titleRequest(overrides = {}) {
  return {
    url: primaryUrl,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer primary-test-key",
      "x-api-key": "primary-test-key",
      "chatgpt-account-id": "private-account-id",
      "x-codex-turn-metadata": JSON.stringify({
        thread_source: "thread_title",
        turn_trigger: "thread_title",
      }),
      "x-openai-internal-codex-responses-lite": "true",
      "content-length": "123456",
      host: "primary.invalid",
    },
    body: {
      model: "gpt-5.6-luna",
      input: [
        { type: "additional_tools", tools: [] },
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "UNRELATED_AGENT_INSTRUCTIONS" },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "为任务“修复保存按钮”生成简短标题和描述。",
            },
          ],
        },
      ],
      reasoning: { effort: "low" },
      stream: false,
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
    },
    ...overrides,
  };
}

function configuredSource(config = {}) {
  const values = {
    upstream: "https://deepseek.invalid/",
    apiKey: "deepseek-test-key",
    ...config,
  };
  return source.replace(
    "// ===== 处理逻辑 =====",
    () =>
      `Object.assign(CONFIG, ${JSON.stringify(values)});\n// ===== 处理逻辑 =====`,
  );
}

const normalReply = {
  status: 201,
  headers: { "content-type": "text/event-stream" },
  body: "data: original response\n\n",
};
async function run(request = titleRequest(), options = {}) {
  return runProxyScript(
    configuredSource(options.config),
    request,
    options.respond ??
      ((sent) =>
        sent.url === deepseekUrl
          ? JSON.parse(sent.body).stream
            ? {
                headers: { "content-type": "text/event-stream" },
                body: nativeStream(),
              }
            : { body: JSON.stringify(deepseekResponse()) }
          : {
              status: 404,
              body: JSON.stringify({
                error: "当前 API 不支持所选模型 gpt-5.6-luna",
                type: "error",
              }),
            }),
  );
}

describe("Codex title requests routed to DeepSeek", () => {
  it("routes the captured title request through native Responses and preserves its schema", async () => {
    const result = await run();
    expect(result.status).toBe(200);
    expect(result.forwarded).toHaveLength(1);
    const sent = result.forwarded[0];
    expect(sent.url).toBe(deepseekUrl);
    expect(sent.headers.authorization).toBe("Bearer deepseek-test-key");
    for (const header of [
      "x-api-key",
      "chatgpt-account-id",
      "x-codex-turn-metadata",
      "x-openai-internal-codex-responses-lite",
      "host",
      "content-length",
    ]) {
      expect(sent.headers[header]).toBeUndefined();
    }
    const body = JSON.parse(sent.body);
    expect(body.model).toBe("deepseek-flash");
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.text).toEqual(titleRequest().body.text);
    expect(body.max_output_tokens).toBe(512);
    expect(body.stream).toBe(false);
    expect(body.input).toContain("修复保存按钮");
    for (const field of [
      "messages",
      "response_format",
      "max_tokens",
      "thinking",
    ])
      expect(body[field]).toBeUndefined();
    expect(sent.body).not.toContain("UNRELATED_AGENT_INSTRUCTIONS");
    expect(body.tools).toBeUndefined();
    const response = JSON.parse(result.body);
    expect(result.body).toBe(JSON.stringify(deepseekResponse()));
    expect(response.object).toBe("response");
    expect(response.status).toBe("completed");
    expect(JSON.parse(response.output[0].content[0].text)).toEqual(title);
    expect(response.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 15 },
    });
  });

  it("passes native Responses SSE through byte for byte", async () => {
    const request = titleRequest();
    request.body.stream = true;
    const result = await run(request);
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/event-stream");
    expect(result.body).toBe(nativeStream());
    expect(JSON.parse(result.forwarded[0].body).stream).toBe(true);
    const events = result.body
      .split("\n\n")
      .filter(Boolean)
      .map((frame) =>
        JSON.parse(
          frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            .slice(6),
        ),
      );
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(
      JSON.parse(
        events.find((event) => event.type === "response.output_text.delta")
          .delta,
      ),
    ).toEqual(title);
    const item = events.find(
      (event) => event.type === "response.output_item.done",
    ).item;
    expect(item).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
    });
    expect(JSON.parse(item.content[0].text)).toEqual(title);
    expect(events.at(-1).response.output).toEqual([item]);
  });

  it("forwards the first SSE chunk while the upstream is still open", async () => {
    const request = titleRequest();
    request.body.stream = true;
    const firstChunk =
      'event: response.created\ndata: {"type":"response.created"}\n\n';
    const result = await runProxyScript(
      configuredSource(),
      request,
      () => ({
        headers: { "content-type": "text/event-stream" },
        body: [firstChunk],
        keepOpen: true,
      }),
      { stopAfterFirstChunk: true },
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe(firstChunk);
  });

  it("forwards ordinary requests unchanged even when they use the title model", async () => {
    const request = titleRequest();
    request.headers["x-codex-turn-metadata"] = JSON.stringify({
      thread_source: "cli",
      turn_trigger: "turn_input",
    });
    const result = await run(request, { respond: () => normalReply });
    expect(result.status).toBe(201);
    expect(result.body).toBe(normalReply.body);
    expect(result.forwarded).toEqual([
      {
        url: primaryUrl,
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
      },
    ]);
  });

  it.each([
    ["missing metadata", null],
    ["malformed metadata", "not-json"],
    [
      "summary task",
      JSON.stringify({
        thread_source: "thread_summary",
        turn_trigger: "thread_summary",
      }),
    ],
    [
      "title source with a different current trigger",
      JSON.stringify({
        thread_source: "thread_title",
        turn_trigger: "turn_input",
      }),
    ],
  ])("passes through %s", async (_name, metadata) => {
    const request = titleRequest();
    if (metadata === null) delete request.headers["x-codex-turn-metadata"];
    else request.headers["x-codex-turn-metadata"] = metadata;
    const result = await run(request, { respond: () => normalReply });
    expect(result.body).toBe(normalReply.body);
    expect(result.forwarded[0].body).toBe(JSON.stringify(request.body));
    expect(result.forwarded[0].url).toBe(primaryUrl);
  });

  it("accepts thread_source when the client omits turn_trigger", async () => {
    const request = titleRequest();
    request.headers["x-codex-turn-metadata"] = JSON.stringify({
      thread_source: "thread_title",
    });
    expect((await run(request)).status).toBe(200);
  });

  it("routes the description generation that follows setting a thread title", async () => {
    const request = titleRequest();
    request.headers["x-codex-turn-metadata"] = JSON.stringify({
      thread_source: "thread_description",
      turn_trigger: "thread_description",
    });
    request.body.text.format.schema = {
      type: "object",
      properties: { description: { type: "string", minLength: 1 } },
      required: ["description"],
      additionalProperties: false,
    };
    const result = await run(request);
    expect(result.status).toBe(200);
    expect(result.forwarded[0].url).toBe(deepseekUrl);
    expect(JSON.parse(result.forwarded[0].body).text).toEqual(
      request.body.text,
    );
  });

  it("does not intercept compaction requests", async () => {
    const request = titleRequest({ url: primaryUrl + "/compact" });
    const result = await run(request, { respond: () => normalReply });
    expect(result.body).toBe(normalReply.body);
    expect(result.forwarded[0].url).toBe(request.url);
  });

  it("preserves the original flow when the script is disabled", async () => {
    const result = await run(titleRequest(), {
      config: { enabled: false },
      respond: () => normalReply,
    });
    expect(result.body).toBe(normalReply.body);
    expect(result.forwarded[0].url).toBe(primaryUrl);
  });

  it("reports missing configuration only for a matched title request", async () => {
    const result = await run(titleRequest(), { config: { apiKey: "" } });
    expect(result.status).toBe(503);
    expect(result.forwarded).toHaveLength(0);
    const ordinary = titleRequest();
    delete ordinary.headers["x-codex-turn-metadata"];
    expect(
      (
        await run(ordinary, {
          config: { apiKey: "" },
          respond: () => normalReply,
        })
      ).status,
    ).toBe(201);
  });

  it("preserves the exact client schema for DeepSeek to enforce", async () => {
    const request = titleRequest();
    request.body.text.format.schema = {
      ...schema,
      properties: { title: { type: "string" }, body: { type: "string" } },
    };
    const result = await run(request);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.forwarded[0].body).text).toEqual(
      request.body.text,
    );
  });

  it("uses only the last user text and honors the configured input limit", async () => {
    const request = titleRequest();
    request.body.input.unshift({
      role: "user",
      content: "UNRELATED_OLD_CONTEXT",
    });
    const result = await run(request, { config: { maxInputChars: 10 } });
    const input = JSON.parse(result.forwarded[0].body).input;
    expect(input).toHaveLength(10);
    expect(input).not.toContain("UNRELATED_OLD_CONTEXT");
  });

  it("rejects a title request without user text", async () => {
    const request = titleRequest();
    request.body.input = [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,test" },
        ],
      },
    ];
    const result = await run(request);
    expect(result.status).toBe(400);
    expect(result.forwarded).toHaveLength(0);
  });

  it.each(["failed", "incomplete"])(
    "preserves native %s responses without rewriting them as successful titles",
    async (status) => {
      const response = deepseekResponse(title, {
        status,
        error:
          status === "failed"
            ? { code: "test_error", message: "upstream failed" }
            : null,
      });
      const result = await run(titleRequest(), {
        respond: () => ({ body: JSON.stringify(response) }),
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe(JSON.stringify(response));
    },
  );

  it("returns DeepSeek HTTP errors for the existing failure handling", async () => {
    const reply = {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
      body: JSON.stringify({ error: { message: "rate limited" } }),
    };
    const result = await run(titleRequest(), { respond: () => reply });
    expect(result.status).toBe(429);
    expect(result.headers["retry-after"]).toBe("3");
    expect(result.body).toBe(reply.body);
  });

  it("cancels a timed-out DeepSeek request", async () => {
    const result = await run(titleRequest(), {
      config: { timeoutMs: 30 },
      respond: () => null,
    });
    expect(result.status).toBe(504);
    expect(result.canceled).toHaveLength(1);
  });

  it("preserves the native stream failure event", async () => {
    const request = titleRequest();
    request.body.stream = true;
    const body =
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"upstream failed"}}}\n\n';
    const result = await run(request, {
      respond: () => ({
        headers: { "content-type": "text/event-stream" },
        body,
      }),
    });
    expect(result.body).toBe(body);
  });

  it("honors the configured output budget and upstream API prefix", async () => {
    const result = await run(titleRequest(), {
      config: { upstream: "https://deepseek.invalid/v1/", maxTokens: 256 },
      respond: () => ({ body: JSON.stringify(deepseekResponse()) }),
    });
    expect(result.forwarded[0].url).toBe(
      "https://deepseek.invalid/v1/responses",
    );
    expect(JSON.parse(result.forwarded[0].body).max_output_tokens).toBe(256);
  });
});
