# 供应商 TypeScript 代理中间件

在供应商编辑页展开「供应商代理脚本」，粘贴单文件 TypeScript，打开标题右侧的「启用代理脚本」开关，保存后选择该供应商。选择已启用且代码非空的脚本供应商、或为当前供应商保存并启用脚本时，会启动 CC Switch 的本地代理并接管当前应用。

关闭开关并保存即可暂停该供应商的脚本，代码会保留，仍可编辑；再次开启并保存即可恢复，无需重新粘贴。每个供应商独立保存开关状态，旧配置中未设置开关的脚本默认启用。关闭脚本不会停止整个本地代理，协议转换等其他路由功能仍可继续使用；代码为空时也不会执行脚本。

需要本机安装 Node.js 24 或更新版本，且 `node` 在应用的 PATH 中。无需安装 npm 包，也不需要自行监听端口。支持现有本地代理应用：Claude、Codex、Gemini、Grok Build 和 Claude Desktop；Claude Desktop 先选择本地路由模式。官方供应商仍遵循应用已有的接管支持范围。

## 接口

```ts
export default async function middleware(
  request: Request,
  next: (request?: Request) => Promise<Response>,
  context: Readonly<{
    providerId: string;
    providerName: string;
    appType: string;
  }>,
): Promise<Response> {
  return next();
}
```

使用标准 Web `Request`、`Response`、`Headers` 和 `ReadableStream`。请求已经完成供应商模型映射、协议转换、静态请求覆盖和认证注入，因此脚本看到的是实际的上游协议。脚本返回的响应继续进入 CC Switch 的错误处理、协议转换和用量统计。

- `next()`：转发收到的请求。使用 CC Switch 原有的 HTTP/SOCKS 网络代理、连接池和超时配置。
- `next(new Request(...))`：更改地址、方法、Header 或 Body 后转发。可以调用多次，实现重试或备用地址；更换站点时自行配置匹配的认证 Header。
- 直接返回 `new Response(...)` 或 `Response.json(...)`：在本地处理请求，不访问上游。
- `await response.json()` / `text()`：读取完整响应后改写。SSE 应直接返回 `response` 或使用 `ReadableStream` / `TransformStream`，避免等整段输出结束后才显示。
- `console.log/info/warn/error`：写到 CC Switch 的 debug 日志。`stdout` 用于内部通信，不要直接写入。

`next()` 返回的 gzip、deflate、br 响应自动解压，供 JSON/文本处理使用。直接调用全局 `fetch()` 也可以访问网络，但它使用 Node 自己的网络设置；需要沿用 CC Switch 的网络代理时使用 `next()`。

## 示例

```ts
export default async function (
  request: Request,
  next: (request?: Request) => Promise<Response>,
) {
  const body = await request.json();
  body.thinking = { type: "adaptive" };

  const headers = new Headers(request.headers);
  headers.set("anthropic-beta", "context-1m-2025-08-07");

  return next(
    new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
    }),
  );
}
```

只将此示例用于接受 Anthropic 请求的供应商。原 `tools/proxy/src/proxy.ts` 中的 beta 清洗、Thinking 注入、探测短路及空响应处理已整理成一个可粘贴的[兼容中间件示例](../examples/anthropic-compatibility-middleware.ts)。原脚本的 `http.createServer`、`listen`、上游选择和启动脚本不需要复制。SQLite 日志等功能可使用 `node:sqlite` / `node:fs` 自行添加。

## 执行范围与生命周期

脚本作用于本地代理转发的 API 请求；供应商测速、余额查询、独立的模型列表拉取不经过此中间件。它不会自动增加本地代理尚未支持的 HTTP 路由。

每个请求使用独立 Node 进程，至多并行 16 个；模块变量不会跨请求保留。脚本代码或开关更新并保存后，下一次请求使用新设置，进行中的请求继续使用其原脚本。请求取消、响应结束或进程失去响应时释放进程和上游连接。单个脚本最大 1 MiB，Node 堆上限 512 MiB；持续阻塞事件循环 15 秒会被终止。读取响应仍受本地代理已有的超时和大小限制约束。

语法校验不执行用户代码；保存启用的脚本时同样进行校验。关闭状态下可以保存未完成的代码，不会校验脚本或要求 Node；仍可主动点击「校验语法」。运行时抛异常、返回非 `Response` 或 Node 不可用会明确报错，已启用的脚本不会被静默跳过。`next()` 的网络故障和脚本返回的上游错误状态仍交给现有故障转移策略处理。

这不是沙箱：脚本以当前用户权限运行，支持 `node:` 内置模块，可以访问本机文件和网络。只使用你理解并信任的脚本。静态相对模块/npm 包导入不受支持，依赖逻辑应合并为单文件。
