//! 详细日志的 SSE 结果观察器。只保留有界事件缓冲和结束摘要，不改变传输行为。

use crate::proxy::sse::{strip_sse_field, SseBuffer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_EVENT_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct SseOutcomeTracker {
    buffer: SseBuffer,
    discarding: bool,
    outcome: Option<TerminalOutcome>,
}

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: Option<String>,
    response: Option<TerminalResponse>,
    error: Option<Value>,
}

#[derive(Default, Deserialize)]
struct TerminalResponse {
    status: Option<String>,
    error: Option<Value>,
    incomplete_details: Option<Value>,
}

#[derive(Serialize)]
struct TerminalOutcome {
    status: &'static str,
    event: String,
    error: Option<Value>,
    incomplete_details: Option<Value>,
}

impl SseOutcomeTracker {
    pub(super) fn push(&mut self, bytes: &[u8]) {
        // 限制单次追加，避免巨大或没有分隔符的事件让日志观察器无限缓存。
        for chunk in bytes.chunks(4096) {
            self.buffer.push_bytes(chunk);
            while let Some(block) = self.buffer.next_block() {
                if self.discarding {
                    // 被丢弃事件的剩余部分不能独立充当结束证据。
                    self.discarding = false;
                } else if block.len() <= MAX_EVENT_BYTES {
                    observe_block(&mut self.outcome, block);
                }
            }
            if self.buffer.pending().len() > MAX_EVENT_BYTES {
                // 保留可能跨 chunk 的分隔符前缀，确保超大事件的结束空行仍被识别。
                let pending = self.buffer.pending();
                let tail = if pending.ends_with("\r\n") {
                    "\r\n"
                } else if pending.ends_with('\n') {
                    "\n"
                } else if pending.ends_with('\r') {
                    "\r"
                } else {
                    ""
                };
                self.buffer.clear();
                self.buffer.push_str(tail);
                self.discarding = true;
            }
        }
    }

    pub(super) fn finish(&mut self) {
        // 只有正常 HTTP EOF 才能补处理省略空行分隔符的尾事件。
        let tail = self.buffer.take_tail();
        if !self.discarding && tail.len() <= MAX_EVENT_BYTES {
            observe_block(&mut self.outcome, &tail);
        }
    }

    pub(super) fn json(&self) -> Value {
        self.outcome
            .as_ref()
            .map_or_else(|| json!({"status":"unknown"}), |outcome| json!(outcome))
    }
}

fn observe_block(outcome: &mut Option<TerminalOutcome>, block: &str) {
    let event_name = block
        .lines()
        .find_map(|line| strip_sse_field(line, "event"));
    let is_terminal = |name: &str| {
        matches!(
            name,
            "response.completed" | "response.failed" | "response.incomplete" | "error"
        )
    };
    if event_name.is_some_and(|name| !is_terminal(name)) {
        return;
    }
    let data = block
        .lines()
        .filter_map(|line| strip_sse_field(line, "data"))
        .collect::<Vec<_>>()
        .join("\n");
    let Ok(event) = serde_json::from_str::<Event>(&data) else {
        return;
    };
    let Some(kind) = event.kind.as_deref().or(event_name) else {
        return;
    };
    if !is_terminal(kind) || event_name.is_some_and(|name| name != kind) {
        return;
    }
    let response = event.response.unwrap_or_default();
    let error = response.error.or(event.error);
    let status = if kind == "response.failed" || kind == "error" || error.is_some() {
        "failed"
    } else if kind == "response.incomplete"
        || response.status.as_deref() == Some("incomplete")
        || response.incomplete_details.is_some()
    {
        "incomplete"
    } else if kind == "response.completed" && response.status.as_deref() == Some("completed") {
        "completed"
    } else {
        return;
    };
    // 失败证据不能被后续 completed 覆盖；completed 之后出现错误则保留错误。
    if outcome
        .as_ref()
        .is_some_and(|previous| previous.status != "completed")
    {
        return;
    }
    let error = if kind == "error" && error.is_none() {
        serde_json::from_str(&data).ok()
    } else {
        error
    };
    *outcome = Some(TerminalOutcome {
        status,
        event: kind.into(),
        error,
        incomplete_details: response.incomplete_details,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPLETED: &str = "event: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"error\":null}}\r\n\r\n";

    #[test]
    fn completion_is_recognized_across_every_byte_boundary() {
        let mut tracker = SseOutcomeTracker::default();
        for byte in COMPLETED.as_bytes() {
            tracker.push(std::slice::from_ref(byte));
        }
        assert_eq!(tracker.json()["status"], "completed");
    }

    #[test]
    fn strings_headers_and_partial_events_are_not_completion_evidence() {
        for text in [
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"response.completed\"}\n\n",
            "event: response.completed\n\n",
            "event: response.completed\ndata: invalid\n\n",
            "event: response.created\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"in_progress\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
        ] {
            let mut tracker = SseOutcomeTracker::default();
            tracker.push(text.as_bytes());
            assert_eq!(tracker.json()["status"], "unknown", "{text}");
        }
    }

    #[test]
    fn eof_can_complete_a_valid_tail_but_not_invalid_json() {
        let mut tracker = SseOutcomeTracker::default();
        tracker.push(COMPLETED.trim_end().as_bytes());
        assert_eq!(tracker.json()["status"], "unknown");
        tracker.finish();
        assert_eq!(tracker.json()["status"], "completed");
        let mut tracker = SseOutcomeTracker::default();
        tracker.push(b"event: response.completed\ndata: {\"type\":\"response.completed\"");
        tracker.finish();
        assert_eq!(tracker.json()["status"], "unknown");
    }

    #[test]
    fn oversized_event_is_skipped_and_the_next_event_is_still_observed() {
        let oversized = format!(
            "event: response.completed\ndata: {}\n\n",
            json!({
                "type":"response.completed","response":{"status":"completed","output":"x".repeat(MAX_EVENT_BYTES + 1)}
            })
        );
        let mut tracker = SseOutcomeTracker::default();
        tracker.push(oversized.as_bytes());
        assert_eq!(tracker.json()["status"], "unknown");
        assert!(tracker.buffer.pending().len() <= MAX_EVENT_BYTES);
        tracker.push(COMPLETED.as_bytes());
        assert_eq!(tracker.json()["status"], "completed");
    }

    #[test]
    fn failure_and_incomplete_details_are_preserved_even_if_completed_follows() {
        for (kind, detail_key, detail, expected) in [
            (
                "response.failed",
                "error",
                json!({"code":"server_error"}),
                "failed",
            ),
            (
                "response.incomplete",
                "incomplete_details",
                json!({"reason":"max_output_tokens"}),
                "incomplete",
            ),
        ] {
            let mut response = json!({"status":expected});
            response[detail_key] = detail.clone();
            let event = format!("data: {}\n\n", json!({"type":kind,"response":response}));
            let mut tracker = SseOutcomeTracker::default();
            tracker.push(event.as_bytes());
            tracker.push(COMPLETED.as_bytes());
            assert_eq!(tracker.json()["status"], expected);
            assert_eq!(tracker.json()[detail_key], detail);
        }
    }

    #[test]
    fn error_after_completed_is_not_hidden() {
        let mut tracker = SseOutcomeTracker::default();
        tracker.push(COMPLETED.as_bytes());
        tracker
            .push(b"event: error\ndata: {\"type\":\"error\",\"message\":\"upstream failed\"}\n\n");
        assert_eq!(tracker.json()["status"], "failed");
        assert_eq!(tracker.json()["error"]["message"], "upstream failed");
    }

    #[test]
    fn multiline_data_and_event_without_type_are_supported() {
        let mut tracker = SseOutcomeTracker::default();
        tracker.push(
            b"event:response.completed\ndata:{\ndata:\"response\":{\"status\":\"completed\"}}\n\n",
        );
        assert_eq!(tracker.json()["status"], "completed");
    }

    #[test]
    fn non_null_error_on_completed_is_a_failure() {
        let mut tracker = SseOutcomeTracker::default();
        tracker.push(b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"error\":{\"code\":\"bad_response\"}}}\n\n");
        assert_eq!(tracker.json()["status"], "failed");
    }
}
