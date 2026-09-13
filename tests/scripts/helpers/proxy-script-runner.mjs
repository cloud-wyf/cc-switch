import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// 用实际脚本运行器回放报文；上游由调用方模拟，不使用真实凭证或网络。
export async function runProxyScript(source, request, respond, options = {}) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-vm-modules",
      resolve("src-tauri/src/proxy/script_runner.mjs"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const result = { forwarded: [], chunks: [], canceled: [] };
  const replies = new Map();
  const send = (packet) => child.stdin.write(JSON.stringify(packet) + "\n");
  let timer;
  let finished = false;
  child.stderr.resume();
  try {
    return await new Promise((resolveResult, reject) => {
      const finish = () => {
        finished = true;
        result.body = Buffer.concat(result.chunks).toString("utf8");
        resolveResult(result);
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        reject(error);
      };
      timer = setTimeout(
        () => fail(new Error("Script runner timed out")),
        5000,
      );
      child.on("error", fail);
      child.on("exit", () => {
        if (!finished)
          fail(new Error("Script runner exited before responding"));
      });
      lines.on("line", async (line) => {
        try {
          const packet = JSON.parse(line);
          if (packet.type === "error") {
            fail(new Error(packet.message));
          } else if (packet.type === "fetch") {
            const forwarded = {
              url: packet.url,
              method: packet.method,
              headers: Object.fromEntries(packet.headers),
              body: Buffer.from(packet.body, "base64").toString("utf8"),
            };
            result.forwarded.push(forwarded);
            const reply = await respond(forwarded);
            if (reply === null) return;
            replies.set(packet.id, {
              keepOpen: reply.keepOpen,
              chunks: Array.isArray(reply.body)
                ? [...reply.body]
                : [reply.body ?? ""],
            });
            send({
              type: "fetch_head",
              id: packet.id,
              method: packet.method,
              status: reply.status ?? 200,
              headers: Object.entries(
                reply.headers ?? { "content-type": "application/json" },
              ),
            });
          } else if (packet.type === "fetch_pull") {
            const reply = replies.get(packet.id);
            if (reply?.chunks.length) {
              send({
                type: "fetch_chunk",
                id: packet.id,
                body: Buffer.from(reply.chunks.shift()).toString("base64"),
              });
            } else if (!reply?.keepOpen) {
              send({ type: "fetch_end", id: packet.id });
            }
          } else if (packet.type === "fetch_cancel") {
            result.canceled.push(packet.id);
          } else if (packet.type === "response_head") {
            result.status = packet.status;
            result.headers = Object.fromEntries(packet.headers);
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
      send({
        type: "init",
        source,
        context: { providerId: "fixture", appType: "codex" },
        request: {
          url: request.url,
          method: request.method ?? "POST",
          headers: Object.entries(request.headers ?? {}),
          body: Buffer.from(
            typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body ?? {}),
          ).toString("base64"),
        },
      });
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
