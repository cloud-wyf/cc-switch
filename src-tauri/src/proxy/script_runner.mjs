// One request per process. stdout is reserved for the host protocol; user logs use stderr.
import * as nodeModule from "node:module";
import { SourceTextModule } from "node:vm";
import { createInterface } from "node:readline";
import { Console } from "node:console";
import { Duplex } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

globalThis.console = new Console(process.stderr, process.stderr);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let sequence = 0;
let outputReader;
let outputReady = false;
let readingOutput = false;
let outputRemainder;
let initialized = false;

function fail(error) {
  const message = String(error?.stack || error).replace(
    /data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,
    "provider-middleware.ts",
  );
  send({
    type: "error",
    transport: error?.proxyTransportError === true,
    message: message.slice(0, 8000),
  });
}

function headersList(headers) {
  const result = [...headers].filter(([name]) => name !== "set-cookie");
  for (const cookie of headers.getSetCookie())
    result.push(["set-cookie", cookie]);
  return result;
}

function decodeResponseBody(body, headers) {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  const decompress = {
    gzip: createGunzip,
    "x-gzip": createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress,
  }[encoding];
  if (!body || !decompress) return body;
  headers.delete("content-encoding");
  headers.delete("content-length");
  return body.pipeThrough(Duplex.toWeb(decompress()));
}

async function forward(request) {
  if (!(request instanceof Request))
    throw new TypeError("next() expects a Request");
  const id = ++sequence;
  const copy = request.clone();
  const body = copy.body
    ? Buffer.from(await copy.arrayBuffer()).toString("base64")
    : "";
  return new Promise((resolve, reject) => {
    const state = {
      resolve,
      reject,
      controller: null,
      waiting: null,
      ended: false,
    };
    pending.set(id, state);
    const abort = () => {
      send({ type: "fetch_cancel", id });
      state.ended = true;
      const error = request.signal.reason || new Error("Request aborted");
      state.reject(error);
      state.controller?.error(error);
      state.waiting?.();
      pending.delete(id);
    };
    state.cleanup = () => request.signal.removeEventListener("abort", abort);
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
    send({
      type: "fetch",
      id,
      url: request.url,
      method: request.method,
      headers: headersList(request.headers),
      body,
    });
  });
}

function acceptFetch(message) {
  const state = pending.get(message.id);
  if (!state) return;
  if (message.type === "fetch_head") {
    const headers = new Headers(message.headers);
    const noBody =
      [204, 205, 304].includes(message.status) || message.method === "HEAD";
    const body = noBody
      ? null
      : new ReadableStream(
          {
            start(controller) {
              state.controller = controller;
            },
            pull() {
              if (state.ended) return;
              return new Promise((resolve) => {
                state.waiting = resolve;
                send({ type: "fetch_pull", id: message.id });
              });
            },
            cancel() {
              state.ended = true;
              state.cleanup();
              state.waiting?.();
              pending.delete(message.id);
              send({ type: "fetch_cancel", id: message.id });
            },
          },
          { highWaterMark: 0 },
        );
    state.resolve(
      new Response(decodeResponseBody(body, headers), {
        status: message.status,
        headers,
      }),
    );
    if (noBody) {
      state.cleanup();
      pending.delete(message.id);
      send({ type: "fetch_cancel", id: message.id });
    }
  } else if (message.type === "fetch_chunk") {
    state.controller.enqueue(
      new Uint8Array(Buffer.from(message.body, "base64")),
    );
    state.waiting?.();
    state.waiting = null;
  } else if (message.type === "fetch_end" || message.type === "fetch_error") {
    state.ended = true;
    state.cleanup();
    if (message.type === "fetch_error") {
      const error = new Error(message.message);
      error.proxyTransportError = message.transport !== false;
      state.reject(error);
      state.controller?.error(error);
    } else {
      state.controller?.close();
    }
    state.waiting?.();
    pending.delete(message.id);
  }
}

async function initialize(message) {
  if (initialized) throw new Error("Duplicate script initialization");
  initialized = true;
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("代理脚本需要 Node.js 24 或更新版本");
  }
  const source = nodeModule.stripTypeScriptTypes(message.source, {
    mode: "transform",
    sourceUrl: "provider-middleware.ts",
  });
  // Parsing alone never executes module initialization, imports, or user code.
  const parsed = new SourceTextModule(source);
  for (const dependency of parsed.dependencySpecifiers) {
    if (!dependency.startsWith("node:")) {
      throw new Error(
        `仅支持单文件脚本和 node: 内置模块，无法加载 ${dependency}`,
      );
    }
  }
  if (message.type === "validate") {
    send({ type: "valid" });
    return;
  }
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  if (typeof module.default !== "function") {
    throw new TypeError("脚本必须 export default 一个中间件函数");
  }
  const input = message.request;
  const request = new Request(input.url, {
    method: input.method,
    headers: input.headers,
    body: ["GET", "HEAD"].includes(input.method)
      ? undefined
      : Buffer.from(input.body, "base64"),
  });
  const next = (replacement = request) => forward(replacement);
  const response = await module.default(
    request,
    next,
    Object.freeze(message.context),
  );
  if (!(response instanceof Response)) {
    throw new TypeError("中间件必须返回 Response（可直接 return next()）");
  }
  // The script may have transformed the body, so transport-level lengths are no longer authoritative.
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "transfer-encoding", "connection"])
    headers.delete(name);
  outputReader = response.body?.getReader();
  outputReady = true;
  send({
    type: "response_head",
    status: response.status,
    headers: headersList(headers),
  });
}

async function readOutput() {
  if (!outputReady || readingOutput)
    throw new Error("Invalid response body demand");
  readingOutput = true;
  try {
    const result = outputRemainder
      ? { done: false, value: outputRemainder }
      : outputReader
        ? await outputReader.read()
        : { done: true };
    outputRemainder = undefined;
    if (result.done) {
      send({ type: "response_end" });
    } else {
      const bytes = result.value;
      if (bytes.byteLength > 64 * 1024)
        outputRemainder = bytes.subarray(64 * 1024);
      send({
        type: "response_chunk",
        body: Buffer.from(bytes.subarray(0, 64 * 1024)).toString("base64"),
      });
    }
  } finally {
    readingOutput = false;
  }
}

const heartbeat = setInterval(() => send({ type: "heartbeat" }), 1000);
heartbeat.unref();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === "init" || message.type === "validate") {
      initialize(message).catch(fail);
    } else if (message.type === "response_pull") {
      readOutput().catch(fail);
    } else {
      acceptFetch(message);
    }
  } catch (error) {
    fail(error);
  }
});
lines.on("close", () => process.exit(0));
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
