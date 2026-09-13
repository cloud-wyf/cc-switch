//! 详细代理日志持久化。正文只保存采样前缀，清理独立于用量统计和自动备份开关。

use crate::database::{lock_conn, to_json_string, Database};
use crate::error::AppError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const SCHEMA: &str = include_str!("../proxy_events.sql");
pub(crate) const CONFIG_KEY: &str = "proxy_event_log_config";
const MAX_BODY_LIMIT: usize = 1024 * 1024;
const MAX_PURGE_DAYS: u32 = 365;

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

impl Database {
    pub(crate) fn create_proxy_event_tables(conn: &Connection) -> Result<(), AppError> {
        conn.execute_batch(SCHEMA)
            .map_err(|e| AppError::Database(format!("创建详细代理日志表失败: {e}")))
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

    /// 一批记录在一个事务内写入，流式转发期间不持有 SQLite 锁。
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
            const COLUMNS: &str = "request_id,app_type,provider_id,session_id,attempt,forward_seq,script_enabled,script_used,request_changed,route_changed,target,upstream,run_at,seq,started_at,created_at,duration_ms,method,url,request_model,model,status,client_status,total_bytes,upstream_header_ms,upstream_duration_ms,stream_error,rewritten,error,finish_reason,mods,orig_headers,orig_body,script_url,script_headers,script_body,fwd_url,fwd_method,fwd_headers,fwd_body,resp_headers,resp_body,client_headers,client_body";
            let values = COLUMNS
                .split(',')
                .map(|name| format!("json_extract(?1, '$.{name}')"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("INSERT INTO proxy_request_events ({COLUMNS}) SELECT {values}");
            let mut statement = tx
                .prepare_cached(&sql)
                .map_err(|e| AppError::Database(e.to_string()))?;
            for event in events {
                statement
                    .execute([event.to_string()])
                    .map_err(|e| AppError::Database(format!("写入详细代理日志失败: {e}")))?;
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
                "DELETE FROM proxy_request_events WHERE created_at < ?1",
                [cutoff],
            )
            .map_err(|e| AppError::Database(format!("清理详细代理日志失败: {e}")))?;
        if deleted > 0 {
            log::info!("已清理 {deleted} 条过期详细代理日志");
        }
        Ok(deleted as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
