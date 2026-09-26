//! 详细代理日志持久化。表位于附加库 events（proxy-events.db），主库备份和配置同步天然不包含它。

use crate::database::{lock_conn, to_json_string, Database};
use crate::error::AppError;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) const SCHEMA: &str = include_str!("../proxy_events.sql");
pub(crate) const CONFIG_KEY: &str = "proxy_event_log_config";
pub(crate) const EVENTS_FILE: &str = "proxy-events.db";
const MAX_BODY_LIMIT: usize = 1024 * 1024;
const MAX_PURGE_DAYS: u32 = 365;
/// 每种请求类型各自的行数上限：保留天数之外再防客户端重试风暴几分钟内写满磁盘，
/// 按类型分开算，count_tokens 之类的突发不会挤掉对话记录。
pub(crate) const MAX_ROWS: u32 = 2000;
const MAX_PAGE_SIZE: u32 = 200;
const DEFAULT_PAGE_SIZE: u32 = 50;
const COLUMNS: &str = "request_id,app_type,provider_id,session_id,attempt,forward_seq,script_enabled,script_used,request_changed,route_changed,target,upstream,run_at,seq,started_at,created_at,duration_ms,method,url,request_model,model,status,client_status,total_bytes,upstream_header_ms,upstream_duration_ms,stream_error,rewritten,error,finish_reason,mods,orig_headers,orig_body,script_url,script_headers,script_body,fwd_url,fwd_method,fwd_headers,fwd_body,resp_headers,resp_body,client_headers,client_body";
const SUMMARY_COLUMNS: &str = "id,request_id,app_type,provider_id,session_id,attempt,forward_seq,script_enabled,script_used,request_changed,route_changed,target,started_at,created_at,duration_ms,method,url,request_model,model,status,client_status,total_bytes,upstream_header_ms,upstream_duration_ms,finish_reason,error,fwd_url,kind";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxyEventLogConfig {
    pub enabled: bool,
    pub log_body_limit: usize,
    pub purge_days: u32,
}

impl Default for ProxyEventLogConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            log_body_limit: 64 * 1024,
            purge_days: 7,
        }
    }
}

/// 列表查询条件；缺省字段不过滤。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxyEventQuery {
    /// 隐藏这些应用；发起方未知的记录不受影响。
    pub exclude_app_types: Vec<String>,
    /// 隐藏这些请求类型。
    pub exclude_kinds: Vec<String>,
    pub provider_id: Option<String>,
    pub target: Option<String>,
    pub model: Option<String>,
    /// success | error | 4xx | 5xx | none
    pub status: Option<String>,
    pub script_used: Option<bool>,
    pub route_changed: Option<bool>,
    pub search: Option<String>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub sort_by: Option<String>,
    pub sort_dir: Option<String>,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEventPage {
    pub items: Vec<Value>,
    pub total: u64,
    pub failed: u64,
    pub script_used: u64,
    pub avg_duration_ms: Option<f64>,
    pub page: u32,
    pub page_size: u32,
}

fn like(pattern: &str) -> SqlValue {
    SqlValue::Text(format!("%{}%", pattern.trim()))
}

fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// 请求用途，只看原始请求的方法和路径，与代理路由表对应；认不出的归 other。
fn request_kind(method: &str, url: &str) -> &'static str {
    const BY_SUFFIX: [(&str, &str); 12] = [
        ("/messages", "chat"),
        ("/chat/completions", "chat"),
        ("/responses", "chat"),
        (":generateContent", "chat"),
        (":streamGenerateContent", "chat"),
        ("/messages/count_tokens", "count_tokens"),
        (":countTokens", "count_tokens"),
        ("/responses/compact", "compact"),
        ("/alpha/search", "search"),
        ("/images/generations", "image"),
        ("/images/edits", "image"),
        ("/api/hello", "probe"),
    ];
    let path = url.split('?').next().unwrap_or(url);
    if method == "GET" && path.contains("/models") {
        return "models";
    }
    BY_SUFFIX
        .iter()
        .find(|(suffix, _)| path.ends_with(suffix))
        .map_or("other", |(_, kind)| kind)
}

impl ProxyEventQuery {
    fn conditions(&self) -> (String, Vec<SqlValue>) {
        let mut clauses: Vec<String> = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        for (column, hidden) in [
            ("app_type", &self.exclude_app_types),
            ("kind", &self.exclude_kinds),
        ] {
            if hidden.is_empty() {
                continue;
            }
            let first = params.len() + 1;
            params.extend(hidden.iter().map(|value| SqlValue::Text(value.clone())));
            let slots: Vec<String> = (first..=params.len()).map(|i| format!("?{i}")).collect();
            clauses.push(format!(
                "COALESCE({column}, '') NOT IN ({})",
                slots.join(",")
            ));
        }
        if let Some(id) = present(&self.provider_id) {
            params.push(SqlValue::Text(id.into()));
            clauses.push(format!("provider_id = ?{}", params.len()));
        }
        if let Some(target) = present(&self.target) {
            params.push(like(target));
            clauses.push(format!("target LIKE ?{}", params.len()));
        }
        if let Some(model) = present(&self.model) {
            params.push(like(model));
            params.push(like(model));
            clauses.push(format!(
                "(request_model LIKE ?{} OR model LIKE ?{})",
                params.len() - 1,
                params.len()
            ));
        }
        match self.status.as_deref() {
            Some("success") => clauses.push("client_status < 400".into()),
            Some("error") => clauses.push("(client_status IS NULL OR client_status >= 400)".into()),
            Some("4xx") => clauses.push("status BETWEEN 400 AND 499".into()),
            Some("5xx") => clauses.push("status >= 500".into()),
            Some("none") => clauses.push("status IS NULL".into()),
            _ => {}
        }
        if let Some(used) = self.script_used {
            clauses.push(format!("script_used = {}", i32::from(used)));
        }
        if let Some(changed) = self.route_changed {
            clauses.push(format!("route_changed = {}", i32::from(changed)));
        }
        if let Some(search) = present(&self.search) {
            let first = params.len() + 1;
            params.extend(std::iter::repeat_n(like(search), 4));
            clauses.push(format!(
                "(request_id LIKE ?{first} OR url LIKE ?{} OR fwd_url LIKE ?{} OR error LIKE ?{})",
                first + 1,
                first + 2,
                first + 3
            ));
        }
        if let Some(since) = self.since {
            params.push(SqlValue::Integer(since));
            clauses.push(format!("created_at >= ?{}", params.len()));
        }
        if let Some(until) = self.until {
            params.push(SqlValue::Integer(until));
            clauses.push(format!("created_at <= ?{}", params.len()));
        }
        let sql = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        (sql, params)
    }

    fn order(&self) -> String {
        let column = match self.sort_by.as_deref() {
            Some("duration_ms") => "duration_ms",
            Some("upstream_duration_ms") => "upstream_duration_ms",
            Some("status") => "status",
            Some("client_status") => "client_status",
            Some("target") => "target",
            Some("model") => "model",
            Some("app_type") => "app_type",
            Some("kind") => "kind",
            _ => "id",
        };
        let direction = if self.sort_dir.as_deref() == Some("asc") {
            "ASC"
        } else {
            "DESC"
        };
        // id 是插入顺序，作为并列时的稳定次序。
        format!(" ORDER BY {column} {direction}, id {direction}")
    }
}

fn row_to_json(row: &rusqlite::Row<'_>, names: &[String]) -> rusqlite::Result<Value> {
    use rusqlite::types::ValueRef;
    let mut object = serde_json::Map::new();
    for (index, name) in names.iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(value) => json!(value),
            ValueRef::Real(value) => json!(value),
            ValueRef::Text(bytes) => {
                let text = String::from_utf8_lossy(bytes);
                if name.ends_with("_headers") || name.ends_with("_body") || name == "mods" {
                    serde_json::from_str(&text).unwrap_or_else(|_| json!(text))
                } else {
                    json!(text)
                }
            }
            ValueRef::Blob(bytes) => json!(String::from_utf8_lossy(bytes)),
        };
        object.insert(name.clone(), value);
    }
    Ok(Value::Object(object))
}

impl Database {
    /// 把详细日志库附加到当前连接并建表；文件不存在时自动创建。
    pub(crate) fn attach_proxy_events(conn: &Connection, path: &Path) -> Result<(), AppError> {
        conn.execute(
            "ATTACH DATABASE ?1 AS events",
            [path.to_string_lossy().as_ref()],
        )
        .map_err(|e| AppError::Database(format!("附加详细代理日志库失败: {e}")))?;
        // 只对空库生效；已有数据的库沿用原有模式。
        conn.execute_batch("PRAGMA events.auto_vacuum = INCREMENTAL;")
            .map_err(|e| AppError::Database(format!("设置详细代理日志库 auto_vacuum 失败: {e}")))?;
        Self::create_proxy_event_tables(conn)
    }

    pub(crate) fn create_proxy_event_tables(conn: &Connection) -> Result<(), AppError> {
        // 旧库的表没有 kind 列，先补上，SCHEMA 里的 kind 索引才建得起来。
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('proxy_request_events', 'events')")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect()
            })
            .map_err(|e| AppError::Database(format!("读取详细代理日志表结构失败: {e}")))?;
        if !columns.is_empty() && !columns.iter().any(|name| name == "kind") {
            conn.execute_batch("ALTER TABLE events.proxy_request_events ADD COLUMN kind TEXT;")
                .map_err(|e| AppError::Database(format!("为详细代理日志添加类型列失败: {e}")))?;
        }
        conn.execute_batch(SCHEMA)
            .map_err(|e| AppError::Database(format!("创建详细代理日志表失败: {e}")))
    }

    /// 给还没有类型的记录补上类型：加 kind 列之前写入的，以及刚从旧版主库搬来的。
    pub(crate) fn backfill_proxy_event_kinds(conn: &Connection) -> Result<usize, AppError> {
        let rows: Vec<(i64, String, String)> = conn
            .prepare("SELECT id, method, url FROM events.proxy_request_events WHERE kind IS NULL")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect()
            })
            .map_err(|e| AppError::Database(format!("读取待补类型的详细代理日志失败: {e}")))?;
        if rows.is_empty() {
            return Ok(0);
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        {
            let mut update = tx
                .prepare("UPDATE events.proxy_request_events SET kind = ?1 WHERE id = ?2")
                .map_err(|e| AppError::Database(e.to_string()))?;
            for (id, method, url) in &rows {
                update
                    .execute(params![request_kind(method, url), id])
                    .map_err(|e| AppError::Database(format!("补齐详细代理日志类型失败: {e}")))?;
            }
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        log::info!("已为 {} 条详细代理日志补齐请求类型", rows.len());
        Ok(rows.len())
    }

    /// 旧版本把事件表建在主库；启动时把行搬到附加库，然后删除主库表。
    /// 复制和删除在同一事务里，失败时主库表原样保留，由随后的 v20 迁移清理。
    pub(crate) fn migrate_legacy_proxy_events(conn: &Connection) -> Result<u64, AppError> {
        let legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.sqlite_master WHERE type = 'table' AND name = 'proxy_request_events'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if legacy == 0 {
            return Ok(0);
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let moved = tx
            .execute(
                &format!(
                    "INSERT OR IGNORE INTO events.proxy_request_events (id,{COLUMNS}) SELECT id,{COLUMNS} FROM main.proxy_request_events"
                ),
                [],
            )
            .map_err(|e| AppError::Database(format!("迁移旧版详细代理日志失败: {e}")))?;
        tx.execute_batch("DROP TABLE main.proxy_request_events;")
            .map_err(|e| AppError::Database(format!("删除主库旧版详细代理日志表失败: {e}")))?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        if moved > 0 {
            log::info!("已把 {moved} 条详细代理日志迁移到独立日志库");
        }
        Ok(moved as u64)
    }

    pub fn get_proxy_event_log_config(&self) -> Result<ProxyEventLogConfig, AppError> {
        let mut config: ProxyEventLogConfig = match self.get_setting(CONFIG_KEY)? {
            Some(value) => serde_json::from_str(&value)
                .map_err(|e| AppError::Config(format!("详细代理日志配置无效: {e}")))?,
            None => ProxyEventLogConfig::default(),
        };
        // 配置错误不能造成无限缓冲或误删当天的记录；0 字节仍允许只记元数据。
        config.log_body_limit = config.log_body_limit.min(MAX_BODY_LIMIT);
        config.purge_days = config.purge_days.clamp(1, MAX_PURGE_DAYS);
        Ok(config)
    }

    /// 保存前校验，避免界面显示的值与实际采样、清理策略不一致。
    pub fn set_proxy_event_log_config(&self, config: &ProxyEventLogConfig) -> Result<(), AppError> {
        if config.log_body_limit > MAX_BODY_LIMIT {
            return Err(AppError::InvalidInput(
                "详细日志正文上限必须在 0–1048576 字节（0–1024 KiB）之间".into(),
            ));
        }
        if !(1..=MAX_PURGE_DAYS).contains(&config.purge_days) {
            return Err(AppError::InvalidInput(
                "详细日志保留期限必须在 1–365 天之间".into(),
            ));
        }
        self.set_setting(CONFIG_KEY, &to_json_string(config)?)
    }

    /// 一批记录在一个事务内写入，流式转发期间不持有 SQLite 锁；写入后按类型各自裁掉超出上限的最旧记录。
    pub(crate) fn save_proxy_events(&self, events: &[Value]) -> Result<(), AppError> {
        if events.is_empty() {
            return Ok(());
        }
        let conn = lock_conn!(self.conn);
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        {
            // 列名固定；报文 JSON 作为绑定参数传入，不拼接到 SQL。
            let values = COLUMNS
                .split(',')
                .map(|name| format!("json_extract(?1, '$.{name}')"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "INSERT INTO events.proxy_request_events ({COLUMNS},kind) SELECT {values},?2"
            );
            let mut statement = tx
                .prepare_cached(&sql)
                .map_err(|e| AppError::Database(e.to_string()))?;
            let mut kinds = Vec::new();
            for event in events {
                let kind = request_kind(
                    event["method"].as_str().unwrap_or_default(),
                    event["url"].as_str().unwrap_or_default(),
                );
                statement
                    .execute(params![event.to_string(), kind])
                    .map_err(|e| AppError::Database(format!("写入详细代理日志失败: {e}")))?;
                kinds.push(kind);
            }
            kinds.sort_unstable();
            kinds.dedup();
            for kind in kinds {
                tx.execute(
                    "DELETE FROM events.proxy_request_events WHERE kind = ?1 AND id <= (SELECT id FROM events.proxy_request_events WHERE kind = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
                    params![kind, MAX_ROWS],
                )
                .map_err(|e| AppError::Database(format!("裁剪详细代理日志失败: {e}")))?;
            }
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))
    }

    pub(crate) fn cleanup_proxy_events(&self) -> Result<u64, AppError> {
        let config = self.get_proxy_event_log_config()?;
        let cutoff = chrono::Utc::now().timestamp() - i64::from(config.purge_days) * 86_400;
        self.cleanup_proxy_events_before(cutoff)
    }

    pub(crate) fn cleanup_proxy_events_before(&self, cutoff: i64) -> Result<u64, AppError> {
        let conn = lock_conn!(self.conn);
        let deleted = conn
            .execute(
                "DELETE FROM events.proxy_request_events WHERE created_at < ?1",
                [cutoff],
            )
            .map_err(|e| AppError::Database(format!("清理详细代理日志失败: {e}")))?;
        if deleted > 0 {
            log::info!("已清理 {deleted} 条过期详细代理日志");
            if let Err(e) = conn.execute_batch("PRAGMA events.incremental_vacuum;") {
                log::warn!("回收详细代理日志空间失败: {e}");
            }
        }
        Ok(deleted as u64)
    }

    /// 分页概览，只读取标量列；正文和报文头留给详情查询。
    pub fn list_proxy_events(&self, query: &ProxyEventQuery) -> Result<ProxyEventPage, AppError> {
        let page_size = match query.page_size {
            0 => DEFAULT_PAGE_SIZE,
            size => size.min(MAX_PAGE_SIZE),
        };
        let (filter, params) = query.conditions();
        let conn = lock_conn!(self.conn);
        let (total, failed, script_used, avg_duration_ms): (u64, u64, u64, Option<f64>) = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*), COALESCE(SUM(client_status IS NULL OR client_status >= 400), 0), COALESCE(SUM(script_used), 0), AVG(duration_ms) FROM events.proxy_request_events{filter}"
                ),
                params_from_iter(params.iter()),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|e| AppError::Database(format!("统计详细代理日志失败: {e}")))?;
        let mut statement = conn
            .prepare(&format!(
                "SELECT {SUMMARY_COLUMNS} FROM events.proxy_request_events{filter}{} LIMIT ?{} OFFSET ?{}",
                query.order(),
                params.len() + 1,
                params.len() + 2
            ))
            .map_err(|e| AppError::Database(format!("查询详细代理日志失败: {e}")))?;
        let names: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(str::to_string)
            .collect();
        let mut bound = params.clone();
        bound.push(SqlValue::Integer(i64::from(page_size)));
        bound.push(SqlValue::Integer(
            i64::from(query.page) * i64::from(page_size),
        ));
        let items = statement
            .query_map(params_from_iter(bound.iter()), |row| {
                row_to_json(row, &names)
            })
            .map_err(|e| AppError::Database(format!("读取详细代理日志失败: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Database(format!("读取详细代理日志失败: {e}")))?;
        Ok(ProxyEventPage {
            items,
            total,
            failed,
            script_used,
            avg_duration_ms,
            page: query.page,
            page_size,
        })
    }

    /// 单条完整记录；报文列解析为 JSON，便于前端直接渲染。
    pub fn get_proxy_event(&self, id: i64) -> Result<Option<Value>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare("SELECT * FROM events.proxy_request_events WHERE id = ?1")
            .map_err(|e| AppError::Database(format!("查询详细代理日志失败: {e}")))?;
        let names: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(str::to_string)
            .collect();
        let mut rows = statement
            .query_map([id], |row| row_to_json(row, &names))
            .map_err(|e| AppError::Database(format!("读取详细代理日志失败: {e}")))?;
        rows.next()
            .transpose()
            .map_err(|e| AppError::Database(format!("读取详细代理日志失败: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, created_at: i64, extra: Value) -> Value {
        let mut event = json!({"request_id":id,"target":"Provider","run_at":"t","seq":1,"started_at":"2026-09-18 10:00:00.000",
            "created_at":created_at,"duration_ms":100,"method":"POST","url":"/v1/responses","finish_reason":"completed",
            "attempt":1,"forward_seq":1,"script_enabled":false,"script_used":false,"request_changed":false,"route_changed":false,
            "app_type":"codex","provider_id":"p1","status":200,"client_status":200,"orig_body":{"encoding":"json","data":{"model":"m"}}});
        for (key, value) in extra.as_object().unwrap() {
            event[key] = value.clone();
        }
        event
    }

    #[test]
    fn config_defaults_and_valid_limits_round_trip() {
        let db = Database::memory().unwrap();
        assert_eq!(
            serde_json::to_value(db.get_proxy_event_log_config().unwrap()).unwrap(),
            json!({"enabled":true,"logBodyLimit":65536,"purgeDays":7})
        );
        db.set_setting(CONFIG_KEY, r#"{"purgeDays":14}"#).unwrap();
        let partial = db.get_proxy_event_log_config().unwrap();
        assert!(partial.enabled);
        assert_eq!(partial.log_body_limit, 65536);
        assert_eq!(partial.purge_days, 14);

        for (limit, days) in [(0, 1), (128 * 1024, 30), (MAX_BODY_LIMIT, MAX_PURGE_DAYS)] {
            let config = ProxyEventLogConfig {
                enabled: false,
                log_body_limit: limit,
                purge_days: days,
            };
            db.set_proxy_event_log_config(&config).unwrap();
            let expected = json!({"enabled":false,"logBodyLimit":limit,"purgeDays":days});
            assert_eq!(
                serde_json::to_value(db.get_proxy_event_log_config().unwrap()).unwrap(),
                expected
            );
            assert_eq!(
                serde_json::from_str::<Value>(&db.get_setting(CONFIG_KEY).unwrap().unwrap())
                    .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn invalid_config_cannot_replace_saved_policy() {
        let db = Database::memory().unwrap();
        let config = ProxyEventLogConfig::default();
        db.set_proxy_event_log_config(&config).unwrap();
        let before = db.get_setting(CONFIG_KEY).unwrap();
        for (limit, days) in [
            (MAX_BODY_LIMIT + 1, 7),
            (65536, 0),
            (65536, MAX_PURGE_DAYS + 1),
        ] {
            assert!(db
                .set_proxy_event_log_config(&ProxyEventLogConfig {
                    log_body_limit: limit,
                    purge_days: days,
                    ..config.clone()
                })
                .is_err());
            assert_eq!(db.get_setting(CONFIG_KEY).unwrap(), before);
        }

        // 手工写入的旧配置仍有读取保护，不能造成无限缓冲或误删当天日志。
        db.set_setting(CONFIG_KEY, r#"{"logBodyLimit":2097152,"purgeDays":0}"#)
            .unwrap();
        let bounded = db.get_proxy_event_log_config().unwrap();
        assert_eq!(bounded.log_body_limit, MAX_BODY_LIMIT);
        assert_eq!(bounded.purge_days, 1);
    }

    #[test]
    fn events_live_in_the_attached_database_and_stay_out_of_main() {
        let db = Database::memory().unwrap();
        db.save_proxy_events(&[event("a", 1, json!({}))]).unwrap();
        let conn = db.conn.lock().unwrap();
        let in_main: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.sqlite_master WHERE name = 'proxy_request_events'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(in_main, 0);
        let in_events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events.proxy_request_events",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(in_events, 1);
    }

    #[test]
    fn legacy_main_table_rows_move_into_the_attached_database() {
        let db = Database::memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(&SCHEMA.replace("events.", "main."))
                .unwrap();
            conn.execute(
                "INSERT INTO main.proxy_request_events (request_id,target,run_at,seq,started_at,created_at,duration_ms,method,url,finish_reason) VALUES ('legacy','t','r',1,'s',5,1,'POST','/x','completed')",
                [],
            )
            .unwrap();
            assert_eq!(Database::migrate_legacy_proxy_events(&conn).unwrap(), 1);
            assert_eq!(Database::migrate_legacy_proxy_events(&conn).unwrap(), 0);
            // 旧版主库没有 kind 列，搬过来的记录由启动时的回填补上类型。
            assert_eq!(Database::backfill_proxy_event_kinds(&conn).unwrap(), 1);
            let in_main: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM main.sqlite_master WHERE name = 'proxy_request_events'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(in_main, 0);
        }
        let page = db.list_proxy_events(&ProxyEventQuery::default()).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0]["request_id"], "legacy");
        assert_eq!(page.items[0]["kind"], "other");
    }

    #[test]
    fn old_tables_gain_the_kind_column_and_rows_are_backfilled() {
        let db = Database::memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "DROP INDEX events.idx_proxy_events_kind; ALTER TABLE events.proxy_request_events DROP COLUMN kind;",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events.proxy_request_events (request_id,target,run_at,seq,started_at,created_at,duration_ms,method,url,finish_reason) VALUES ('old','','r',1,'s',5,1,'HEAD','/claude-desktop/api/hello','completed')",
                [],
            )
            .unwrap();
            Database::create_proxy_event_tables(&conn).unwrap();
            Database::create_proxy_event_tables(&conn).unwrap();
            assert_eq!(Database::backfill_proxy_event_kinds(&conn).unwrap(), 1);
            assert_eq!(Database::backfill_proxy_event_kinds(&conn).unwrap(), 0);
        }
        let page = db.list_proxy_events(&ProxyEventQuery::default()).unwrap();
        assert_eq!(page.items[0]["kind"], "probe");
    }

    #[test]
    fn request_kind_follows_the_proxy_routes() {
        for (method, url, kind) in [
            ("POST", "/v1/messages?beta=true", "chat"),
            ("POST", "/claude/v1/messages", "chat"),
            ("POST", "/claude-desktop/v1/messages?beta=true", "chat"),
            ("POST", "/codex/v1/chat/completions", "chat"),
            ("POST", "/v1/v1/responses", "chat"),
            ("POST", "/grokbuild/v1/responses", "chat"),
            (
                "POST",
                "/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
                "chat",
            ),
            (
                "POST",
                "/claude-desktop/v1/messages/count_tokens?beta=true",
                "count_tokens",
            ),
            (
                "POST",
                "/v1beta/models/gemini-2.5-pro:countTokens",
                "count_tokens",
            ),
            ("GET", "/claude-desktop/v1/models", "models"),
            ("GET", "/v1/models", "models"),
            ("GET", "/v1beta/models/gemini-2.5-pro", "models"),
            ("POST", "/codex/v1/responses/compact", "compact"),
            ("POST", "/v1/alpha/search", "search"),
            ("POST", "/images/generations", "image"),
            ("POST", "/v1/images/edits", "image"),
            ("HEAD", "/claude-desktop/api/hello", "probe"),
            ("POST", "/v1/messages/batches", "other"),
            ("POST", "/api/event_logging/batch", "other"),
        ] {
            assert_eq!(request_kind(method, url), kind, "{method} {url}");
        }
    }

    #[test]
    fn row_cap_is_per_kind_so_bursts_cannot_evict_chat() {
        let db = Database::memory().unwrap();
        let chats: Vec<Value> = (0..MAX_ROWS)
            .map(|i| event(&format!("c{i}"), i64::from(i), json!({})))
            .collect();
        db.save_proxy_events(&chats).unwrap();
        let counts: Vec<Value> = (0..(MAX_ROWS + 3))
            .map(|i| {
                event(
                    &format!("t{i}"),
                    i64::from(i),
                    json!({"url": "/claude-desktop/v1/messages/count_tokens?beta=true"}),
                )
            })
            .collect();
        db.save_proxy_events(&counts).unwrap();
        for (hidden, oldest) in [("count_tokens", "c0"), ("chat", "t3")] {
            let page = db
                .list_proxy_events(&ProxyEventQuery {
                    exclude_kinds: vec![hidden.into()],
                    sort_dir: Some("asc".into()),
                    page_size: 1,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(page.total, u64::from(MAX_ROWS), "hidden {hidden}");
            assert_eq!(page.items[0]["request_id"], oldest);
        }
    }

    #[test]
    fn exclusions_hide_apps_and_kinds_but_keep_unknown_apps() {
        let db = Database::memory().unwrap();
        db.save_proxy_events(&[
            event("codex-chat", 1, json!({})),
            event(
                "desktop-count",
                2,
                json!({"app_type": "claude-desktop", "url": "/claude-desktop/v1/messages/count_tokens?beta=true"}),
            ),
            event(
                "unknown-probe",
                3,
                json!({"app_type": null, "method": "HEAD", "url": "/claude-desktop/api/hello"}),
            ),
        ])
        .unwrap();
        let ids = |query: ProxyEventQuery| -> Vec<String> {
            db.list_proxy_events(&ProxyEventQuery {
                sort_dir: Some("asc".into()),
                ..query
            })
            .unwrap()
            .items
            .iter()
            .map(|e| e["request_id"].as_str().unwrap().to_string())
            .collect()
        };
        assert_eq!(
            ids(ProxyEventQuery {
                exclude_app_types: vec!["codex".into()],
                ..Default::default()
            }),
            ["desktop-count", "unknown-probe"]
        );
        assert_eq!(
            ids(ProxyEventQuery {
                exclude_kinds: vec!["count_tokens".into(), "probe".into()],
                ..Default::default()
            }),
            ["codex-chat"]
        );
        assert_eq!(
            ids(ProxyEventQuery {
                exclude_app_types: vec!["claude-desktop".into()],
                exclude_kinds: vec!["chat".into()],
                ..Default::default()
            }),
            ["unknown-probe"]
        );
    }

    #[test]
    fn row_cap_keeps_only_the_newest_rows() {
        let db = Database::memory().unwrap();
        let batch: Vec<Value> = (0..(MAX_ROWS + 5))
            .map(|i| event(&format!("r{i}"), i64::from(i), json!({})))
            .collect();
        db.save_proxy_events(&batch).unwrap();
        let page = db
            .list_proxy_events(&ProxyEventQuery {
                sort_dir: Some("asc".into()),
                page_size: 1,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, u64::from(MAX_ROWS));
        assert_eq!(page.items[0]["request_id"], "r5");
    }

    #[test]
    fn list_filters_sorts_paginates_and_summarizes() {
        let db = Database::memory().unwrap();
        db.save_proxy_events(&[
            event(
                "ok",
                10,
                json!({"duration_ms": 100, "model": "gpt-6-astra"}),
            ),
            event(
                "slow-error",
                20,
                json!({"duration_ms": 900, "status": 500, "client_status": 500, "error": "上游错误 (状态码 500)", "script_used": true, "target": "any router"}),
            ),
            event(
                "claude-cancel",
                30,
                json!({"app_type": "claude", "status": null, "client_status": null, "finish_reason": "cancelled", "duration_ms": 50}),
            ),
        ])
        .unwrap();
        let all = db.list_proxy_events(&ProxyEventQuery::default()).unwrap();
        assert_eq!(all.total, 3);
        assert_eq!(all.failed, 2);
        assert_eq!(all.script_used, 1);
        assert_eq!(all.avg_duration_ms, Some(350.0));
        assert_eq!(all.items[0]["request_id"], "claude-cancel");
        assert!(all.items[0].get("orig_body").is_none());

        let errors = db
            .list_proxy_events(&ProxyEventQuery {
                status: Some("error".into()),
                sort_by: Some("duration_ms".into()),
                sort_dir: Some("desc".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            errors
                .items
                .iter()
                .map(|e| e["request_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["slow-error", "claude-cancel"]
        );
        let searched = db
            .list_proxy_events(&ProxyEventQuery {
                search: Some("状态码 500".into()),
                exclude_app_types: vec!["claude".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(searched.total, 1);
        assert_eq!(searched.items[0]["target"], "any router");
        assert_eq!(searched.items[0]["kind"], "chat");
        let by_model = db
            .list_proxy_events(&ProxyEventQuery {
                model: Some("astra".into()),
                script_used: Some(false),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_model.total, 1);
        let paged = db
            .list_proxy_events(&ProxyEventQuery {
                page: 1,
                page_size: 2,
                since: Some(10),
                until: Some(30),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(paged.total, 3);
        assert_eq!(paged.items.len(), 1);
        assert_eq!(paged.items[0]["request_id"], "ok");

        let id = all.items[1]["id"].as_i64().unwrap();
        let detail = db.get_proxy_event(id).unwrap().unwrap();
        assert_eq!(detail["request_id"], "slow-error");
        assert_eq!(detail["orig_body"]["data"]["model"], "m");
        assert!(db.get_proxy_event(999_999).unwrap().is_none());
    }
}
