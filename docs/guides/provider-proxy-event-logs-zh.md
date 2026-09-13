# 供应商代理详细请求日志

CC Switch 在 `~/.cc-switch/cc-switch.db` 的 `proxy_request_events` 表保存本地代理请求的详细报文。表结构沿用旧代理的原始请求、转发请求、上游响应、客户端响应四个方向，并增加供应商、脚本执行和重试归属。旧代理库的历史记录不自动导入。

## 记录范围

本地代理收到的 API 请求都会经过日志采样，包括没有启用供应商脚本的请求，以及 Claude Desktop 的本地网关请求。`/health`、`/status` 不记录。供应商测速、余额查询和客户端直接访问远程供应商的请求不经过本地代理，因此不在这张表内。

原始请求在进入供应商映射和脚本之前采样；转发请求在原生 HTTP 传输之前采样；上游响应在协议转换和脚本改写之前采样；客户端响应在全部处理完成之后采样。`script_*` 报文字段额外保存宿主准备好、即将交给脚本的请求，便于区分模型映射与脚本修改。

脚本的 `next()` 每调用一次都有独立记录。全局 `fetch()` 使用 Node 自己的网络连接，不经过宿主传输，无法采样该调用的上游报文；此时仍记录入口请求、脚本执行标记和最终响应。建议代理转发统一使用 `next()`。

SSE 按读取进度采样，不为了日志提前读完或缓存完整响应。整次请求结束或中断后批量入库，进行中的请求尚不会显示新行。请求或响应被取消、响应流报错、脚本抛异常也会记录已经捕获的内容。

## 关联与标记

| 字段                                         | 含义                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `request_id`                                 | 本次客户端 HTTP 请求的追踪 ID，同一请求的所有记录相同；与用量表的上游响应 ID 独立                 |
| `app_type`、`provider_id`、`target`          | 应用、实际尝试的供应商 ID、当时的供应商名称                                                       |
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

`orig_headers/orig_body`、`fwd_headers/fwd_body`、`resp_headers/resp_body`、`client_headers/client_body` 与旧代理对应。`script_headers/script_body` 是新增的脚本输入快照。`mods` 保存可完整解析时的顶层字段增加、移除和修改信息。

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
- `encoding` 支持 `json`、`text`、`base64`、`empty`、`omitted`、`forwarded`。
- 完整读取后，只有正文长度及完整内容摘要一致，客户端正文才用 `forwarded` 表示复用对应的 `resp_body`。
- `Authorization`、API Key、Cookie 等认证头及 URL 中常见凭证参数脱敏；会话正文按配置保存。压缩或二进制报文可能使用 `base64`。

## 大小和保留期限

默认启用，每个方向最多保存 **65536 字节（64 KiB）**，保留 **7 天**。应用启动及运行期间每天清理一次过期详细日志，自动备份关闭时仍会清理。清理只影响 `proxy_request_events`，不删除用量统计和供应商配置。这里的保留期限指当前数据库，已有的数据库备份仍遵循备份保留设置。

在 **设置 → 路由 → 本地路由 → 详细请求日志** 中修改，点击 **保存** 后持久化；代理运行或停止时均可设置：

| 配置项       | 默认值 | 可选范围                            |
| ------------ | ------ | ----------------------------------- |
| 正文保存上限 | 64 KiB | 0–1024 KiB 的整数；0 表示不保存正文 |
| 保留天数     | 7 天   | 1–365 天的整数                      |

正文上限对后续请求生效，不改变进行中的请求。保留天数由下次启动或每日清理任务读取，保存设置不会立即删除已有日志，无需重启代理。

配置复用 `settings` 表的 `proxy_event_log_config` 键，界面将 KiB 转换为字节后保存，值为 JSON：

```json
{ "enabled": true, "logBodyLimit": 65536, "purgeDays": 7 }
```

缺省字段使用默认值。`logBodyLimit=0` 只记录元数据、大小和状态；上限为 1 MiB。`purgeDays` 限制为 1–365 天。前后端均校验范围，保存失败时保留原配置。关闭现有代理日志总开关也会关闭详细采样。

详细日志不参与 WebDAV/S3 配置同步；同步配置时保留本机已有详细日志。普通数据库备份仍包含日志。

## 查询示例

```sql
-- 最近的调用及脚本执行情况
SELECT started_at, request_id, attempt, forward_seq,
       app_type, target, script_used, request_changed, route_changed,
       request_model, model, status, client_status, duration_ms, finish_reason
FROM proxy_request_events
ORDER BY id DESC LIMIT 50;

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
