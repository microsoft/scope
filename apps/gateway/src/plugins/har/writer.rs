// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HAR 1.2 JSON serializer.
//!
//! Converts internal `HttpExchange` captures into HAR-spec-compliant entries.
//! Handles security-sensitive header redaction, body encoding (plaintext for
//! small text responses, base64 for large or binary payloads), query string
//! parsing, and HAR timing breakdown.

use base64::Engine;
use http::HeaderMap;

use crate::plugin::HttpExchange;

use super::types::*;

/// Headers to redact when redactCredentials is true.
// SECURITY: These headers carry authentication tokens and session cookies.
// HAR files are often shared for debugging — leaked credentials here could
// compromise accounts. Redaction is on by default; callers must opt out.
const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "x-github-token",
    "x-api-key",
    "cookie",
    "set-cookie",
    "request-hmac",
    "copilot-session-token",
];

/// Convert an HttpExchange into a HarEntry, optionally redacting sensitive headers.
pub fn exchange_to_har_entry(exchange: &HttpExchange, redact: bool) -> HarEntry {
    let req = &exchange.request;
    let resp = &exchange.response;

    let request_headers = headers_to_har(&req.headers, redact);
    let response_headers = headers_to_har(&resp.headers, redact);

    // Detect WebSocket exchanges (101 Switching Protocols + Upgrade: websocket)
    let is_websocket = resp.status == http::StatusCode::SWITCHING_PROTOCOLS
        && resp
            .headers
            .get(http::header::UPGRADE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false);

    let (resp_text, resp_encoding, resource_type, websocket_messages) = if is_websocket {
        // For WebSocket, the response body contains the JSON-serialized messages array.
        // Parse it into HarWebSocketMessage entries.
        let ws_messages: Option<Vec<HarWebSocketMessage>> = if !resp.body.is_empty() {
            serde_json::from_slice(&resp.body).ok()
        } else {
            Some(vec![])
        };
        (None, None, Some("websocket".to_string()), ws_messages)
    } else {
        let content_type = resp
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let (text, encoding) = encode_body(&resp.body, &content_type);
        (text, encoding, None, None)
    };

    let content_type = resp
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(if is_websocket {
            "x-unknown"
        } else {
            "application/octet-stream"
        })
        .to_string();

    let post_data = if !req.body.is_empty() {
        let req_content_type = req
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream");
        Some(HarPostData {
            mime_type: req_content_type.to_string(),
            text: String::from_utf8_lossy(&req.body).to_string(),
        })
    } else {
        None
    };

    // HAR 1.2 timing breakdown: send + wait + receive = total time.
    let send_ms = 0.0_f64;
    let wait_ms = exchange.wait_ms as f64;
    let receive_ms = (exchange.elapsed_ms as f64 - wait_ms).max(0.0);

    HarEntry {
        started_date_time: exchange
            .started_at
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        time: send_ms + wait_ms + receive_ms,
        request: HarRequest {
            method: req.method.to_string(),
            url: req.uri.to_string(),
            http_version: "HTTP/1.1".into(),
            cookies: vec![],
            headers: request_headers,
            query_string: parse_query_string(&req.uri),
            headers_size: -1,
            body_size: req.body.len() as i64,
            post_data,
        },
        response: HarResponse {
            status: resp.status.as_u16(),
            status_text: resp.status.canonical_reason().unwrap_or("").to_string(),
            http_version: "HTTP/1.1".into(),
            cookies: vec![],
            headers: response_headers,
            content: HarContent {
                size: if is_websocket {
                    0
                } else {
                    resp.body.len() as i64
                },
                mime_type: content_type,
                text: resp_text,
                encoding: resp_encoding,
            },
            headers_size: -1,
            body_size: if is_websocket {
                0
            } else {
                resp.body.len() as i64
            },
            redirect_url: String::new(),
        },
        cache: HarCache::default(),
        timings: HarTimings {
            blocked: -1.0,
            dns: -1.0,
            connect: -1.0,
            send: send_ms,
            wait: wait_ms,
            receive: receive_ms,
            ssl: -1.0,
        },
        resource_type,
        websocket_messages,
    }
}

/// Build a full HAR 1.2 envelope from a list of entries.
pub fn build_har(entries: Vec<HarEntry>) -> Har {
    Har {
        log: HarLog {
            version: "1.2".into(),
            creator: HarCreator {
                name: "gateway".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            entries,
        },
    }
}

fn headers_to_har(headers: &HeaderMap, redact: bool) -> Vec<HarHeader> {
    headers
        .iter()
        .map(|(name, value)| {
            let name_str = name.as_str().to_lowercase();
            let value_str = if redact && SENSITIVE_HEADERS.contains(&name_str.as_str()) {
                "[REDACTED]".to_string()
            } else {
                value.to_str().unwrap_or("[non-utf8]").to_string()
            };
            HarHeader {
                name: name_str,
                value: value_str,
            }
        })
        .collect()
}

fn parse_query_string(uri: &http::Uri) -> Vec<HarQueryParam> {
    uri.query()
        .map(|q| {
            q.split('&')
                .filter_map(|pair| {
                    let mut parts = pair.splitn(2, '=');
                    let name = parts.next()?;
                    let value = parts.next().unwrap_or("");
                    Some(HarQueryParam {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Encode body for HAR: text for small responses, base64 for >1MB or binary.
// The 1MB threshold balances readability (text is human-inspectable in HAR viewers)
// vs JSON size (base64 adds ~33% overhead but prevents invalid UTF-8 in JSON).
fn encode_body(body: &[u8], content_type: &str) -> (Option<String>, Option<String>) {
    if body.is_empty() {
        return (None, None);
    }

    // If > 1MB or binary content type, use base64
    let is_text = content_type.contains("json")
        || content_type.contains("text")
        || content_type.contains("xml")
        || content_type.contains("javascript");

    if body.len() > 1_048_576 || !is_text {
        let encoded = base64::engine::general_purpose::STANDARD.encode(body);
        (Some(encoded), Some("base64".into()))
    } else {
        (Some(String::from_utf8_lossy(body).to_string()), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{ExchangeRequest, ExchangeResponse};
    use bytes::Bytes;
    use http::{Method, StatusCode, Uri};

    fn make_exchange() -> HttpExchange {
        let mut req_headers = HeaderMap::new();
        req_headers.insert("authorization", "Bearer secret123".parse().unwrap());
        req_headers.insert("content-type", "application/json".parse().unwrap());

        let mut resp_headers = HeaderMap::new();
        resp_headers.insert("content-type", "application/json".parse().unwrap());
        resp_headers.insert("set-cookie", "session=abc".parse().unwrap());

        HttpExchange {
            request: ExchangeRequest {
                method: Method::POST,
                uri: Uri::from_static("https://api.github.com/chat?model=gpt4"),
                headers: req_headers,
                body: Bytes::from(r#"{"messages":[]}"#),
            },
            response: ExchangeResponse {
                status: StatusCode::OK,
                headers: resp_headers,
                body: Bytes::from(r#"{"choices":[]}"#),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 50,
            elapsed_ms: 150,
        }
    }

    #[test]
    fn redacts_sensitive_headers() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, true);

        let auth_header = entry
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth_header.value, "[REDACTED]");

        let cookie_header = entry
            .response
            .headers
            .iter()
            .find(|h| h.name == "set-cookie")
            .unwrap();
        assert_eq!(cookie_header.value, "[REDACTED]");
    }

    #[test]
    fn preserves_headers_when_not_redacting() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);

        let auth_header = entry
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth_header.value, "Bearer secret123");
    }

    #[test]
    fn parses_query_string() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);
        assert_eq!(entry.request.query_string.len(), 1);
        assert_eq!(entry.request.query_string[0].name, "model");
        assert_eq!(entry.request.query_string[0].value, "gpt4");
    }

    #[test]
    fn large_body_uses_base64() {
        let large_body = vec![0u8; 2_000_000]; // 2MB
        let (text, encoding) = encode_body(&large_body, "application/octet-stream");
        assert_eq!(encoding, Some("base64".into()));
        assert!(text.is_some());
    }

    #[test]
    fn small_text_body_is_plaintext() {
        let body = b"hello world";
        let (text, encoding) = encode_body(body, "text/plain");
        assert_eq!(encoding, None);
        assert_eq!(text, Some("hello world".into()));
    }

    #[test]
    fn empty_body_is_none() {
        let (text, encoding) = encode_body(b"", "text/plain");
        assert!(text.is_none());
        assert!(encoding.is_none());
    }

    #[test]
    fn build_har_envelope() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);
        let har = build_har(vec![entry]);
        assert_eq!(har.log.version, "1.2");
        assert_eq!(har.log.creator.name, "gateway");
        assert_eq!(har.log.entries.len(), 1);
    }

    /// HAR 1.2 spec: "The time value for the request must be equal to the sum
    /// of the timings supplied in this section (excluding any -1 values)."
    #[test]
    fn timing_invariant_time_equals_sum_of_positive_timings() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);

        let t = &entry.timings;
        let sum: f64 = [
            t.blocked, t.dns, t.connect, t.send, t.wait, t.receive, t.ssl,
        ]
        .iter()
        .filter(|&&v| v >= 0.0)
        .sum();

        assert!(
            (entry.time - sum).abs() < 0.001,
            "entry.time ({}) must equal sum of non-negative timings ({})",
            entry.time,
            sum,
        );
    }

    #[test]
    fn timing_fields_valid_per_har_spec() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);

        let t = &entry.timings;
        // Required fields must be >= -1 per spec
        assert!(t.send >= -1.0, "send must be >= -1");
        assert!(t.wait >= -1.0, "wait must be >= -1");
        assert!(t.receive >= -1.0, "receive must be >= -1");
        // Optional fields: -1 means not available
        assert!(
            t.blocked == -1.0 || t.blocked >= 0.0,
            "blocked must be -1 or >= 0"
        );
        assert!(t.dns == -1.0 || t.dns >= 0.0, "dns must be -1 or >= 0");
        assert!(
            t.connect == -1.0 || t.connect >= 0.0,
            "connect must be -1 or >= 0"
        );
        assert!(t.ssl == -1.0 || t.ssl >= 0.0, "ssl must be -1 or >= 0");
        // wait should reflect actual TTFB
        assert!(t.wait >= 0.0, "wait (TTFB) should be non-negative");
        assert!(t.receive >= 0.0, "receive should be non-negative");
    }
}
