# 供应商代理详细请求日志

CC Switch 在 `~/.cc-switch/proxy-events.db` 的 `proxy_request_events` 表保存本地代理请求的详细报文。它是独立于主配置库的文件，主库以附加库 `events` 的方式打开它，因此数据库备份、备份恢复和 WebDAV/S3 配置同步都不包含详细日志。表结构沿用旧代理的原始请求、转发请求、上游响应、客户端响应四个方向，并增加供应商、脚本执行和重试归属。旧代理库的历史记录不自动导入；旧版本写在主库里的记录会在升级后第一次启动时搬到独立文件。

在 **设置 → 路由 → 本地路由 → 详细请求日志** 点击 **查看日志** 可以按应用、请求类型、供应商、模型、状态、脚本执行情况筛选和排序，点击一行查看该次调用的全部报文。应用和请求类型是多选，取消勾选即隐藏该项；全部筛选条件保存在本机，重新打开时恢复，有筛选生效时工具栏显示 **重置过滤** 一键清空。

## 记录范围

本地代理收到的 API 请求都会经过日志采样，包括没有启用供应商脚本的请求，以及 Claude Desktop 的本地网关请求。`/health`、`/status` 不记录。供应商测速、余额查询和客户端直接访问远程供应商的请求不经过本地代理，因此不在这张表内。

没有进入转发的请求（`attempt=0`），例如路由表里没有的路径直接返回 404，或 Claude Desktop 的模型目录由本地返回，也会记录一行：没有供应商，列表的供应商列显示“未转发”，应用按路径前缀和 User-Agent 推断。

## 请求类型

`kind` 按原始请求的方法和路径判断，与代理路由表对应：

| 类型       | `kind`         | 识别规则                                                                                                    |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| 对话       | `chat`         | `/messages`、`/chat/completions`、`/responses`，以及 Gemini 的 `:generateContent`、`:streamGenerateContent` |
| 计算 Token | `count_tokens` | `/messages/count_tokens`、Gemini 的 `:countTokens`                                                          |
| 查询模型   | `models`       | 路径含 `/models` 的 GET 请求                                                                                |
| 连通检查   | `probe`        | `/api/hello`，Claude Code 启动时的 HEAD 探测                                                                |
| 压缩       | `compact`      | `/responses/compact`                                                                                        |
| 搜索       | `search`       | `/alpha/search`                                                                                             |
| 图像       | `image`        | `/images/generations`、`/images/edits`                                                                      |
| 其他       | `other`        | 以上都不匹配                                                                                                |

类型只看路径，不解析正文：Claude Code 的标题生成、上下文压缩等附带调用同样走 `/messages`，也归为对话。Claude Code 做上下文用量分析时会一次并发约 25 个 `count_tokens`，Claude Desktop 网关没有这个路由，全部 404；它们不是重试，不会转发到上游。升级前写入的记录在应用启动时按同一规则补齐类型。

原始请求在进入供应商映射和脚本之前采样；转发请求在原生 HTTP 传输之前采样；上游响应在协议转换和脚本改写之前采样；客户端响应在全部处理完成之后采样。只有脚本真正执行时才记录 `script_*` 报文字段，即宿主准备好、即将交给脚本的请求，便于区分模型映射与脚本修改。

脚本的 `next()` 每调用一次都有独立记录。全局 `fetch()` 使用 Node 自己的网络连接，不经过宿主传输，无法采样该调用的上游报文；此时仍记录入口请求、脚本执行标记和最终响应。建议代理转发统一使用 `next()`。

SSE 按读取进度采样，不为了日志提前读完或缓存完整响应。整次请求结束或中断后批量入库，进行中的请求尚不会显示新行。请求或响应被取消、响应流报错、脚本抛异常也会记录已经捕获的内容。

## 关联与标记

| 字段                                         | 含义                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `request_id`                                 | 本次客户端 HTTP 请求的追踪 ID，同一请求的所有记录相同；与用量表的上游响应 ID 独立                 |
| `app_type`、`provider_id`、`target`          | 应用、实际尝试的供应商 ID、当时的供应商名称；未转发的请求后两项为空                               |
| `kind`                                       | 请求类型，见上一节                                                                                |
| `session_id`                                 | 与当前代理用量统计使用相同的会话标识                                                              |
| `attempt`                                    | 本次请求的供应商尝试序号；故障转移或整流后重试会递增                                              |
| `forward_seq`                                | 本次尝试的上游调用序号；`0` 表示未观察到宿主上游调用                                              |
| `script_enabled`                             | 当前供应商有已启用、非空的可执行脚本                                                              |
| `script_used`                                | 是否进入脚本执行路径；即使脚本随后报错仍为 `1`，错误保存在 `error`                                |
| `request_changed`                            | 脚本转发的 URL、方法、请求头或正文是否与脚本输入不同；忽略宿主管理的 Host 和传输长度等头          |
| `route_changed`                              | 脚本是否改变了上游 URL，包括主机、路径或查询参数                                                  |
| `request_model`、`model`                     | 客户端请求模型、实际转发模型                                                                      |
| `script_url`、`fwd_url`                      | 脚本输入中的上游地址、实际转发地址                                                                |
| `status`、`client_status`                    | 本次上游调用的 HTTP 状态、最终返回客户端的 HTTP 状态                                              |
| `duration_ms`                                | 整次客户端请求的持续时间，同组记录相同                                                            |
| `upstream_header_ms`、`upstream_duration_ms` | 此次上游调用等待响应头的时间、读取或取消时的总耗时；尚未结束时总耗时可能为空                      |
| `finish_reason`                              | 客户端响应传输的结束原因：`completed`、`cancelled` 或 `stream_error`；HTTP 是否成功仍以状态码判断 |

例如普通请求经过 `return next()` 后，`script_used=1`，但 `request_changed=0`、`route_changed=0`。Codex 标题被转到 DeepSeek 时，三项通常均为 `1`，`fwd_url` 和 `model` 显示实际目的地。供应商 A 失败后转到供应商 B，会记录两个 `attempt`，每个尝试独立标记该供应商是否使用脚本。

## 报文格式

`orig_headers/orig_body`、`fwd_headers/fwd_body`、`resp_headers/resp_body`、`client_headers/client_body` 与旧代理对应。`script_headers/script_body` 是脚本输入快照。`mods` 保存原始请求与转发请求之间顶层字段的增加、移除和修改；比较使用完整正文，不受保存上限影响，正文不是 JSON 对象时 `diff_unavailable` 为 `true`。

正文使用 JSON 包装：

```json
{
  "encoding": "json",
  "size": 1234,
  "truncated": false,
  "complete": true,
  "data": { "model": "deepseek-flash" }
}
```

- `size` 是实际观察到的原始字节数；中断时只能代表已经读取的部分。
- `truncated` 表示达到保存上限，`complete` 表示是否读到正常结尾，两者独立。
- `encoding` 支持 `json`、`text`、`base64`、`empty`、`omitted`、`forwarded`、`delta`、`same_as`。
- 完整读取后，只有正文长度及完整内容摘要一致，客户端正文才用 `forwarded` 表示复用对应的 `resp_body`。
- 脚本输入和转发请求的正文默认用 `delta` 保存：`data.set` 是相对原始请求新增或修改的顶层字段及完整值，`data.unset` 是被移除的字段名，`size` 仍是实际字节数。差异超过保存上限时退回保存前缀。原始请求本身完整时，查看器会把差异合并成生效正文显示。
- 脚本原样转发时转发正文与脚本输入逐字节相同，`fwd_body` 用 `same_as` 引用 `script_body`，不重复保存。
- `Authorization`、API Key、Cookie 等认证头及 URL 中常见凭证参数脱敏；会话正文按配置保存。压缩或二进制报文可能使用 `base64`。

## 大小和保留期限

默认启用，每个方向最多保存 **65536 字节（64 KiB）**，保留 **7 天**。应用启动及运行期间每天清理一次过期详细日志，自动备份关闭时仍会清理。此外每种请求类型各自只保留最新的 **2000** 条记录：客户端重试风暴不会在几分钟内写满磁盘，`count_tokens` 之类的突发也只挤掉同类型的旧记录，不会挤掉对话记录。清理只影响 `proxy_request_events`，不删除用量统计和供应商配置。

在 **设置 → 路由 → 本地路由 → 详细请求日志** 中修改，点击 **保存** 后持久化；代理运行或停止时均可设置：

| 配置项       | 默认值 | 可选范围                            |
| ------------ | ------ | ----------------------------------- |
| 正文保存上限 | 64 KiB | 0–1024 KiB 的整数；0 表示不保存正文 |
| 保留天数     | 7 天   | 1–365 天的整数                      |

正文上限对后续请求生效，不改变进行中的请求；保存后会推送给运行中的代理，请求路径不读数据库。保留天数由下次启动或每日清理任务读取，保存设置不会立即删除已有日志，无需重启代理。

配置复用 `settings` 表的 `proxy_event_log_config` 键，界面将 KiB 转换为字节后保存，值为 JSON：

```json
{ "enabled": true, "logBodyLimit": 65536, "purgeDays": 7 }
```

缺省字段使用默认值。`logBodyLimit=0` 只记录元数据、大小和状态；上限为 1 MiB。`purgeDays` 限制为 1–365 天。前后端均校验范围，保存失败时保留原配置。关闭现有代理日志总开关也会关闭详细采样。

详细日志不参与 WebDAV/S3 配置同步，也不进入数据库备份；恢复备份不影响已有详细日志。

## 查询示例

用 SQLite 客户端直接打开 `proxy-events.db` 即可查询：

```sql
-- 最近的调用及脚本执行情况
SELECT started_at, request_id, attempt, forward_seq,
       app_type, kind, target, script_used, request_changed, route_changed,
       request_model, model, status, client_status, duration_ms, finish_reason
FROM proxy_request_events
ORDER BY id DESC LIMIT 50;

-- 各应用、各类型的记录数和失败数
SELECT app_type, kind, COUNT(*) AS total,
       SUM(client_status IS NULL OR client_status >= 400) AS failed
FROM proxy_request_events
GROUP BY app_type, kind
ORDER BY total DESC;

-- 只看实际被脚本改到其他地址的请求
SELECT started_at, target, script_url, fwd_url, model
FROM proxy_request_events
WHERE script_used = 1 AND route_changed = 1
ORDER BY id DESC;

-- 比较原始请求、脚本输入与实际发送内容
SELECT json_extract(orig_body, '$.data') AS original,
       json_extract(script_body, '$.data') AS before_script,
       json_extract(fwd_body, '$.data') AS forwarded,
       json_extract(resp_body, '$.data') AS upstream_response,
       client_body
FROM proxy_request_events
WHERE request_id = '要查询的请求追踪 ID'
ORDER BY attempt, forward_seq;
```
