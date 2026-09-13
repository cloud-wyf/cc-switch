import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve("docs/examples/proxy2-middleware.ts"),
  "utf8",
);
const runner = resolve("src-tauri/src/proxy/script_runner.mjs");
const fallback = {
  enabled: true,
  upstream: "https://fallback.invalid/anthropic/",
  apiKey: "fallback-test-key",
  authStyle: "x-api-key",
  model: "fallback-model",
};
const message = {
  model: "primary-model",
  max_tokens: 200,
  messages: [{ role: "user", content: "生成标题" }],
};
const primaryUrl = "https://primary.invalid/custom/v1/messages?beta=true";

// 使用真实 Node 运行器，避免前端测试的 cross-fetch 替身改变流式语义。
// 只覆盖顶部配置，next() 全部由内存报文模拟，不读取密钥或访问网络。
function fixtureSource(options) {
  const config = {
    fallback: "fallback" in options ? options.fallback : fallback,
    forwardProbe: options.forwardProbe ?? false,
    ...options.config,
  };
  const marker = "// ===== 处理逻辑 =====";
  return source.replace(
    marker,
    () => "Object.assign(CONFIG, " + JSON.stringify(config) + ");\n" + marker,
  );
}

async function run(options = {}) {
  const child = spawn(process.execPath, ["--experimental-vm-modules", runner], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const result = { fetches: [], chunks: [] };
  const body = options.body ?? message;
  const chunks = options.chunks ?? [JSON.stringify({ ok: true })];
  const method = options.method ?? "POST";
  const send = (packet) => child.stdin.write(JSON.stringify(packet) + "\n");
  let finished = false;
  let timer;

  try {
    return await new Promise((resolve, reject) => {
      const fail = (error) => {
        if (finished) return;
        finished = true;
        reject(error);
      };
      const finish = () => {
        finished = true;
        result.body = Buffer.concat(result.chunks).toString("utf8");
        resolve(result);
      };
      timer = setTimeout(() => fail(new Error("Node runner timed out")), 4000);
      child.on("error", fail);
      child.on("exit", () => {
        if (!finished) fail(new Error("Node runner exited unexpectedly"));
      });
      child.stderr.resume();
      let chunkIndex = 0;
      lines.on("line", (line) => {
        try {
          const packet = JSON.parse(line);
          if (packet.type === "error") throw new Error(packet.message);
          if (packet.type === "valid") {
            result.valid = true;
            finish();
          } else if (packet.type === "fetch") {
            result.fetches.push(packet);
            send({
              type: "fetch_head",
              id: packet.id,
              method: packet.method,
              status: options.status ?? 200,
              headers: [
                ["content-type", options.contentType ?? "application/json"],
              ],
            });
          } else if (packet.type === "fetch_pull") {
            if (chunkIndex < chunks.length) {
              send({
                type: "fetch_chunk",
                id: packet.id,
                body: Buffer.from(chunks[chunkIndex++]).toString("base64"),
              });
            } else if (!options.keepUpstreamOpen) {
              send({ type: "fetch_end", id: packet.id });
            }
          } else if (packet.type === "response_head") {
            result.status = packet.status;
            send({ type: "response_pull" });
          } else if (packet.type === "response_chunk") {
            result.chunks.push(Buffer.from(packet.body, "base64"));
            if (options.stopAfterFirstChunk) finish();
            else send({ type: "response_pull" });
          } else if (packet.type === "response_end") {
            finish();
          }
        } catch (error) {
          fail(error);
        }
      });
      send(
        options.validate
          ? { type: "validate", source }
          : {
              type: "init",
              source: fixtureSource(options),
              context: { providerId: "fixture", appType: "claude" },
              request: {
                url: options.url ?? primaryUrl,
                method,
                headers: Object.entries({
                  "content-type": "application/json",
                  authorization: "Bearer primary-test-key",
                  "x-api-key": "primary-test-key",
                  "anthropic-version": "2023-06-01",
                  ...options.headers,
                }),
                body: Buffer.from(
                  typeof body === "string" ? body : JSON.stringify(body),
                ).toString("base64"),
              },
            },
      );
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

function forwarded(result) {
  expect(result.fetches).toHaveLength(1);
  const packet = result.fetches[0];
  return {
    url: packet.url,
    headers: new Map(packet.headers),
    text: Buffer.from(packet.body, "base64").toString("utf8"),
  };
}

describe("proxy2 copyable middleware in its Node runner", () => {
  it("validates the exact copyable TypeScript source", async () => {
    expect((await run({ validate: true })).valid).toBe(true);
  });

  it("replaces the fallback URL, credentials and model", async () => {
    const result = await run({
      headers: { host: "primary.invalid", "content-length": "999" },
    });
    const sent = forwarded(result);
    expect(sent.url).toBe(
      "https://fallback.invalid/anthropic/v1/messages?beta=true",
    );
    expect(sent.headers.has("authorization")).toBe(false);
    expect(sent.headers.get("x-api-key")).toBe(fallback.apiKey);
    expect(sent.headers.has("host")).toBe(false);
    expect(sent.headers.has("content-length")).toBe(false);
    expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(sent.text)).toEqual({
      ...message,
      model: fallback.model,
      thinking: { type: "disabled" },
    });
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it("supports bearer authentication and optional model preservation", async () => {
    const sent = forwarded(
      await run({ fallback: { ...fallback, authStyle: "bearer", model: "" } }),
    );
    expect(sent.headers.get("authorization")).toBe("Bearer " + fallback.apiKey);
    expect(sent.headers.has("x-api-key")).toBe(false);
    expect(JSON.parse(sent.text).model).toBe(message.model);
  });

  it.each([
    ["tools", { ...message, tools: [{ name: "web_search" }] }],
    ["large token budget", { ...message, max_tokens: 32001 }],
    ["missing token budget", { ...message, max_tokens: undefined }],
    ["large UTF-8 body", { ...message, system: "中".repeat(3000) }],
  ])("keeps %s requests on the primary provider", async (_name, body) => {
    const sent = forwarded(await run({ body }));
    expect(sent.url).toBe(primaryUrl);
    expect(sent.text).toBe(JSON.stringify(body));
  });

  it("uses original bytes at the exact 8192-byte routing boundary", async () => {
    const body = JSON.stringify({ ...message, max_tokens: 32000, tools: [] });
    const padded = body + " ".repeat(8192 - Buffer.byteLength(body));
    expect(forwarded(await run({ body: padded })).url).toContain(
      "fallback.invalid",
    );
    const primary = forwarded(await run({ body: padded + " " }));
    expect(primary.url).toBe(primaryUrl);
    expect(primary.text).toBe(padded + " ");
  });

  it.each([
    { ...fallback, enabled: false },
    { ...fallback, apiKey: "" },
    { ...fallback, upstream: "" },
  ])(
    "keeps the primary provider when fallback is disabled or incomplete",
    async (configured) => {
      const sent = forwarded(await run({ fallback: configured }));
      expect(sent.url).toBe(primaryUrl);
      expect(sent.headers.get("authorization")).toBe("Bearer primary-test-key");
      expect(JSON.parse(sent.text)).toEqual(message);
    },
  );

  it.each([
    ["token limit", { routeMaxTokens: 199 }],
    ["body limit", { routeMaxBodyBytes: 16 }],
  ])("applies the configured routing %s", async (_name, config) => {
    const sent = forwarded(await run({ config }));
    expect(sent.url).toBe(primaryUrl);
    expect(JSON.parse(sent.text)).toEqual(message);
  });

  it("applies the configured Thinking budget, threshold and beta rules", async () => {
    const config = {
      thinkingMinMaxTokens: 2200,
      thinkingBudgetTokens: 2048,
      thinkingBetas: ["compat-thinking"],
      dropBetas: ["compat-reject"],
      betaRequiresFields: {
        "compat-thinking": "thinking",
        "compat-missing": "context",
      },
    };
    const headers = {
      "anthropic-beta": "compat-thinking,compat-reject,compat-missing",
    };
    const body = {
      ...message,
      max_tokens: 2300,
      tools: [{ name: "read_file" }],
    };
    const sent = forwarded(await run({ body, headers, config }));
    expect(JSON.parse(sent.text).thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
    expect(sent.headers.get("anthropic-beta")).toBe("compat-thinking");

    const limited = forwarded(
      await run({ body: { ...body, max_tokens: 2100 }, headers, config }),
    );
    expect(JSON.parse(limited.text).thinking).toBeUndefined();
    expect(limited.headers.has("anthropic-beta")).toBe(false);
  });

  it("short-circuits probes without sending an upstream request", async () => {
    const result = await run({
      body: { ...message, max_tokens: 1 },
    });
    expect(result.fetches).toHaveLength(0);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).stop_reason).toBe("max_tokens");
  });

  it("supports forwarding probes through the original routing rules", async () => {
    const sent = forwarded(
      await run({ body: { ...message, max_tokens: 1 }, forwardProbe: true }),
    );
    expect(sent.url).toContain("fallback.invalid");
  });

  it.each([
    ["effort", { output_config: { effort: "high" } }, { type: "adaptive" }],
    ["budget", {}, { type: "enabled", budget_tokens: 1024 }],
    [
      "explicit disabled",
      { thinking: { type: "disabled" } },
      { type: "disabled" },
    ],
  ])("preserves Thinking rules for %s", async (_name, extra, thinking) => {
    const sent = forwarded(
      await run({
        body: {
          ...message,
          max_tokens: 2000,
          tools: [{ name: "read_file" }],
          ...extra,
        },
        headers: {
          "anthropic-beta":
            "context-1m-2025-08-07,structured-outputs-2025-12-15,context-management-2025-06-27",
        },
      }),
    );
    const body = JSON.parse(sent.text);
    expect(body.thinking).toEqual(thinking);
    expect(body.output_config).toEqual(extra.output_config);
    expect(sent.headers.get("anthropic-beta")).toBe("context-1m-2025-08-07");
  });

  it("cleans beta before disabling Thinking for fallback", async () => {
    const sent = forwarded(
      await run({
        body: { ...message, output_config: { effort: "high" } },
        headers: {
          "anthropic-beta":
            "context-1m-2025-08-07,effort-2025-11-24,structured-outputs-2025-12-15",
        },
      }),
    );
    expect(sent.headers.get("anthropic-beta")).toBe(
      "context-1m-2025-08-07,effort-2025-11-24",
    );
    expect(JSON.parse(sent.text).thinking).toEqual({ type: "disabled" });
  });

  it("drops Thinking-dependent beta when the token budget is insufficient", async () => {
    const sent = forwarded(
      await run({
        body: { ...message, tools: [{ name: "read_file" }] },
        headers: { "anthropic-beta": "context-1m-2025-08-07" },
      }),
    );
    expect(sent.headers.has("anthropic-beta")).toBe(false);
    expect(JSON.parse(sent.text).thinking).toBeUndefined();
  });

  it.each(["/v1/responses", "/v1/messages/count_tokens", "/v1/models"])(
    "passes unrelated route %s through",
    async (path) => {
      const result = await run({
        url: "https://primary.invalid" + path,
        method: path === "/v1/models" ? "GET" : "POST",
        status: 204,
      });
      expect(result.status).toBe(204);
      expect(forwarded(result).url).toBe("https://primary.invalid" + path);
    },
  );

  it.each(["not-json", "null", "[]"])(
    "passes invalid Messages body %s through",
    async (body) => {
      const sent = forwarded(await run({ body }));
      expect(sent.url).toBe(primaryUrl);
      expect(sent.text).toBe(body);
    },
  );

  it.each([200, 204])(
    "rewrites an empty %s response to 502",
    async (status) => {
      const result = await run({ status, chunks: [] });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.body).error.type).toBe("api_error");
    },
  );

  it("preserves an upstream error response", async () => {
    const body = JSON.stringify({ error: "rate limit" });
    const result = await run({ status: 429, chunks: [body] });
    expect(result.status).toBe(429);
    expect(result.body).toBe(body);
  });

  it("returns the first nonempty SSE chunk without waiting for stream completion", async () => {
    const result = await run({
      contentType: "text/event-stream",
      chunks: ["", "data: first\n\n"],
      keepUpstreamOpen: true,
      stopAfterFirstChunk: true,
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe("data: first\n\n");
  });
});
