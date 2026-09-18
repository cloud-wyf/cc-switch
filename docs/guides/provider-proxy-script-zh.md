# 供应商 TypeScript 代理中间件

在供应商编辑页展开「供应商代理脚本」，粘贴单文件 TypeScript，打开标题右侧的「启用代理脚本」开关，保存后选择该供应商。选择已启用且代码非空的脚本供应商、或为当前供应商保存并启用脚本时，会启动 CC Switch 的本地代理并接管当前应用。

关闭开关并保存即可暂停该供应商的脚本，代码会保留，仍可编辑；再次开启并保存即可恢复，无需重新粘贴。有脚本的供应商卡片右侧也有同一个开关，不用打开编辑页就能切换，效果与保存表单相同。每个供应商独立保存开关状态，旧配置中未设置开关的脚本默认启用。关闭脚本不会停止整个本地代理，协议转换等其他路由功能仍可继续使用；代码为空时也不会执行脚本。反过来，脚本只在请求经过本地代理时执行：手动关闭该应用的本地路由时会先确认，关闭后当前供应商卡片会显示「脚本未生效」。

需要本机安装 Node.js 24 或更新版本，且 `node` 在应用的 PATH 中。无需安装 npm 包，也不需要自行监听端口。支持现有本地代理应用：Claude、Codex、Gemini、Grok Build 和 Claude Desktop；Claude Desktop 需先在「模型配置 → 接入方式」选择「模型映射」，以启用本地路由。官方供应商仍遵循应用已有的接管支持范围。

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

只将此示例用于接受 Anthropic 请求的供应商。原 `tools/proxy/src/proxy.ts` 中的 beta 清洗、Thinking 注入、探测短路及空响应处理已整理成一个可粘贴的[兼容中间件示例](../examples/anthropic-compatibility-middleware.ts)。原脚本的 `http.createServer`、`listen`、上游选择和启动脚本不需要复制。详细 SQLite 报文日志由宿主统一记录，见[供应商代理详细请求日志](provider-proxy-event-logs-zh.md)。

需要原 `proxy2.js` 的小请求分流时，复制[proxy2 中间件](../examples/proxy2-middleware.ts)。主请求使用当前供应商；默认无工具、`max_tokens <= 32000`、改写前请求体不超过 8192 字节的 Messages 请求使用备用上游，同时替换凭证、按配置替换模型并关闭 Thinking。默认探测请求仍在本地返回 200；顶部的 `CONFIG.forwardProbe` 可改为 `true`，让探测也按正常规则转发。

脚本是独立单文件，不读取外部 `config.json`。所有可调参数都在顶部 `CONFIG` 中：备用上游开关、地址、密钥、认证方式和模型，分流的 token/字节上限，探测开关，以及 Thinking 和 beta 兼容规则。仓库示例的 `fallback.apiKey` 留空，使用时填写备用密钥；关闭 `fallback.enabled` 或留空备用地址/密钥时不分流。转发、网络代理、超时和 SQLite 详细报文日志由 CC Switch 统一管理；脚本无需自行建表和清理日志。

Codex Desktop 自动命名可以使用 [DeepSeek 命名中间件](../examples/codex-title-deepseek-middleware.ts)。将它粘贴到使用 **Responses 协议**的 Codex 供应商中，填写顶部 `CONFIG.apiKey` 并启用。它根据 `x-codex-turn-metadata` 中的 `turn_trigger`（缺省时使用 `thread_source`）精确匹配 `thread_title` 和 `thread_description`，将标题及描述生成请求直接转到 DeepSeek 原生的 `/responses` 接口，保留 Codex 的 JSON Schema 和流式设置，原样透传 JSON 或 SSE。其他对话、摘要、压缩和 PR 请求照常转发；匹配不依赖模型名或请求大小。

命名脚本的地址、密钥、模型、token 上限、超时和文本长度限制均在顶部 `CONFIG`。默认使用接口接受的模型 ID `deepseek-flash`，通过 `reasoning.effort: "none"` 关闭思考，最多输出 512 token、等待 20 秒；只发送命名任务最后一条用户文本。模型 ID 应使用 API 实际接受的名称，不能根据模型展示版本拼接成 `deepseek-v4.1-flash`。上游 HTTP 状态、响应内容和流式失败事件均保留原样，输出结构由 DeepSeek 的原生 JSON Schema 支持保证。该脚本复用 `next()` 的网络转发，无需更新应用或新增接口。它作用于后续触发的自动命名；保存后新建任务即可验证效果。协议能力参见 [DeepSeek Responses API 文档](https://api-docs.deepseek.com/guides/responses_api/)。

## 执行范围与生命周期

脚本作用于本地代理转发的 API 请求；供应商测速、余额查询、独立的模型列表拉取不经过此中间件。它不会自动增加本地代理尚未支持的 HTTP 路由。

每个请求使用独立 Node 进程，至多并行 16 个；模块变量不会跨请求保留。脚本代码或开关更新并保存后，下一次请求使用新设置，进行中的请求继续使用其原脚本。请求取消、响应结束或进程失去响应时释放进程和上游连接。单个脚本最大 1 MiB，Node 堆上限 512 MiB；持续阻塞事件循环 15 秒会被终止。读取响应仍受本地代理已有的超时和大小限制约束。

语法校验不执行用户代码；保存启用的脚本时同样进行校验，切换到启用脚本的供应商时也会校验。同一份源码在本次运行中只校验一次，之后的切换不再启动 Node。关闭状态下可以保存未完成的代码，不会校验脚本或要求 Node；仍可主动点击「校验语法」。运行时抛异常、返回非 `Response` 或 Node 不可用会明确报错，已启用的脚本不会被静默跳过。`next()` 的网络故障和脚本返回的上游错误状态仍交给现有故障转移策略处理。

这不是沙箱：脚本以当前用户权限运行，支持 `node:` 内置模块，可以访问本机文件和网络。只使用你理解并信任的脚本。静态相对模块/npm 包导入不受支持，依赖逻辑应合并为单文件。
