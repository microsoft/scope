// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HAR plugin implementation: records HTTP exchanges via a pluggable `HarWriter`
//! backend (local JSONL or Azure append blob), then serves HAR 1.2 JSON on
//! demand via the API.
//!
//! The writer backend is selected at startup based on gateway config:
//! - `har.blob` present → `BlobWriter` (streams to Azure append blob)
//! - `har.blob` absent  → `LocalWriter` (JSONL on pod-local disk)

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use parking_lot::RwLock;
use serde::Deserialize;
use tracing::debug;

use crate::plugin::{HttpExchange, ProxyPlugin, SessionId};

use super::storage::{BlobWriter, HarWriter, LocalWriter};
use super::writer;

/// Per-session metadata kept in the plugin (writer holds all data).
///
/// Only recording sessions have an entry. A session that opted out with
/// `{"har": {"enabled": false}}` is never tracked, so every hook skips it and
/// `GET .../har` returns 404.
struct HarSession {
    redact: bool,
    finalized: bool,
    /// Set to true when the writer reports a hard failure (blob unreachable).
    failed: bool,
}

/// Shared interior state cloned cheaply into Axum route handlers.
struct HarInner {
    sessions: RwLock<HashMap<SessionId, HarSession>>,
    writer: Arc<dyn HarWriter>,
}

impl HarInner {
    async fn build_har_for_session(
        &self,
        session_id: &SessionId,
        iteration: u32,
    ) -> Option<super::types::Har> {
        {
            let sessions = self.sessions.read();
            sessions.get(session_id)?;
        }
        let mut entries = self.writer.read_entries_async(session_id, iteration).await;
        // Sort by startedDateTime so concurrent appends appear chronologically.
        entries.sort_by(|a, b| a.started_date_time.cmp(&b.started_date_time));
        Some(writer::build_har(entries))
    }
}

/// HAR plugin — records HTTP exchanges via `HarWriter`, serves HAR via GET .../har.
pub struct HarPlugin {
    inner: Arc<HarInner>,
}

impl HarPlugin {
    /// Create using a `LocalWriter` (local dev / tests).
    pub fn new(har_dir: std::path::PathBuf) -> Self {
        let writer = Arc::new(LocalWriter::new(har_dir));
        Self {
            inner: Arc::new(HarInner {
                sessions: RwLock::new(HashMap::new()),
                writer,
            }),
        }
    }

    /// Create using a `BlobWriter` (production).
    pub fn new_with_blob(
        container_client: azure_storage_blobs::prelude::ContainerClient,
        append_timeout: std::time::Duration,
    ) -> Self {
        let writer = Arc::new(BlobWriter::new(container_client, append_timeout));
        Self {
            inner: Arc::new(HarInner {
                sessions: RwLock::new(HashMap::new()),
                writer,
            }),
        }
    }
}

#[async_trait]
impl ProxyPlugin for HarPlugin {
    fn name(&self) -> &str {
        "har"
    }

    async fn on_session_start(&self, session_id: &SessionId, settings: &serde_json::Value) {
        let recording = settings
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !recording {
            // Drop any entry left by an earlier start with the same id.
            self.inner.sessions.write().remove(session_id);
            debug!("HAR plugin: recording disabled for session {}", session_id);
            return;
        }

        let redact = settings
            .get("redactCredentials")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        self.inner.writer.init_session(session_id).await;

        let mut sessions = self.inner.sessions.write();
        sessions.insert(
            session_id.clone(),
            HarSession {
                redact,
                finalized: false,
                failed: self.inner.writer.is_failed(session_id),
            },
        );
        debug!("HAR plugin: session started for {}", session_id);
    }

    async fn on_iteration_rotate(
        &self,
        session_id: &SessionId,
        next_iteration: u32,
    ) -> anyhow::Result<()> {
        // Sessions that opted out of recording have no entry.
        if !self.inner.sessions.read().contains_key(session_id) {
            return Ok(());
        }

        self.inner
            .writer
            .init_iteration(session_id, next_iteration)
            .await;

        let failed = self.inner.writer.is_failed(session_id);
        {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.get_mut(session_id) {
                s.failed = failed;
            }
        }

        if failed {
            anyhow::bail!(
                "HAR storage failure while preparing iteration {} for session {}",
                next_iteration,
                session_id
            );
        }
        Ok(())
    }

    async fn on_exchange(&self, session_id: &SessionId, exchange: &HttpExchange, iteration: u32) {
        let redact = {
            let sessions = self.inner.sessions.read();
            match sessions.get(session_id) {
                Some(s) if !s.finalized => s.redact,
                _ => return,
            }
        };

        let entry = super::writer::exchange_to_har_entry(exchange, redact);
        self.inner
            .writer
            .append(session_id, iteration, &entry)
            .await;

        // After the append, propagate a hard failure into the session so the
        // next on_request call can reject the run.
        if self.inner.writer.is_failed(session_id) {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.get_mut(session_id) {
                s.failed = true;
            }
        }
    }

    async fn on_request(
        &self,
        session_id: &SessionId,
        _uri: &http::Uri,
        _headers: &mut http::HeaderMap,
    ) -> anyhow::Result<()> {
        let failed = {
            let sessions = self.inner.sessions.read();
            sessions.get(session_id).map(|s| s.failed).unwrap_or(false)
        };
        if failed {
            anyhow::bail!(
                "HAR storage failure: blob append timed out for session {}; run aborted",
                session_id
            );
        }
        Ok(())
    }

    async fn on_session_stop(&self, session_id: &SessionId) {
        let mut sessions = self.inner.sessions.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.finalized = true;
            debug!("HAR plugin: session finalised for {}", session_id);
        }
    }

    async fn on_session_clear(&self, session_id: &SessionId) {
        {
            let mut sessions = self.inner.sessions.write();
            sessions.remove(session_id);
        }
        self.inner.writer.close_session(session_id);

        debug!("HAR plugin: session cleared for {}", session_id);
    }

    fn api_routes(&self) -> Option<axum::Router> {
        let inner = self.inner.clone();
        Some(
            axum::Router::new()
                .route("/har", get(get_har))
                .with_state(inner),
        )
    }
}

/// Query parameters for `GET /har`.
#[derive(Deserialize)]
struct HarQuery {
    /// Which iteration to return (required).
    iteration: u32,
}

/// GET /api/v1/sessions/:id/har?iteration=N — build and return HAR for an iteration.
async fn get_har(
    AxumPath(session_id): AxumPath<String>,
    Query(query): Query<HarQuery>,
    State(inner): State<Arc<HarInner>>,
) -> impl IntoResponse {
    match inner
        .build_har_for_session(&session_id, query.iteration)
        .await
    {
        Some(har) => {
            let failed = inner.writer.is_failed(&session_id);
            let count = har.log.entries.len();
            debug!(
                "HAR plugin: returning {} entries for session {} iter {} (failed={})",
                count, session_id, query.iteration, failed
            );
            let body = serde_json::to_vec(&har).unwrap_or_default();
            let mut resp = axum::response::Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap();
            if failed {
                resp.headers_mut()
                    .insert("x-har-incomplete", HeaderValue::from_static("true"));
            }
            resp.into_response()
        }
        None => {
            debug!("HAR plugin: no data for session {}", session_id);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{ExchangeRequest, ExchangeResponse};
    use bytes::Bytes;
    use http::{HeaderMap, Method, Uri};
    use tempfile::TempDir;

    fn make_exchange() -> HttpExchange {
        HttpExchange {
            request: ExchangeRequest {
                method: Method::GET,
                uri: Uri::from_static("https://api.github.com/test"),
                headers: HeaderMap::new(),
                body: Bytes::new(),
            },
            response: ExchangeResponse {
                status: http::StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"ok"),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 5,
            elapsed_ms: 10,
        }
    }

    #[tokio::test]
    async fn session_lifecycle() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();

        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        plugin.on_exchange(&sid, &make_exchange(), 1).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har.log.entries.len(), 1);

        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har.log.entries.len(), 1);

        plugin.on_session_clear(&sid).await;
        assert!(plugin.inner.build_har_for_session(&sid, 1).await.is_none());
    }

    #[tokio::test]
    async fn redacts_headers_by_default() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();
        plugin.on_session_start(&sid, &serde_json::json!({})).await;

        let mut req_headers = HeaderMap::new();
        req_headers.insert("authorization", "Bearer secret".parse().unwrap());

        let exchange = HttpExchange {
            request: ExchangeRequest {
                method: Method::GET,
                uri: Uri::from_static("https://api.github.com/test"),
                headers: req_headers,
                body: Bytes::new(),
            },
            response: ExchangeResponse {
                status: http::StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"ok"),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 5,
            elapsed_ms: 10,
        };
        plugin.on_exchange(&sid, &exchange, 1).await;
        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        let auth = har.log.entries[0]
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth.value, "[REDACTED]");
    }

    #[tokio::test]
    async fn preserves_headers_when_configured() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();
        plugin
            .on_session_start(&sid, &serde_json::json!({"redactCredentials": false}))
            .await;

        let mut req_headers = HeaderMap::new();
        req_headers.insert("authorization", "Bearer secret".parse().unwrap());

        let exchange = HttpExchange {
            request: ExchangeRequest {
                method: Method::GET,
                uri: Uri::from_static("https://api.github.com/test"),
                headers: req_headers,
                body: Bytes::new(),
            },
            response: ExchangeResponse {
                status: http::StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"ok"),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 5,
            elapsed_ms: 10,
        };
        plugin.on_exchange(&sid, &exchange, 1).await;
        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        let auth = har.log.entries[0]
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth.value, "Bearer secret");
    }

    #[tokio::test]
    async fn restart_clears_previous_session() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();

        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        plugin.on_exchange(&sid, &make_exchange(), 1).await;
        plugin.on_session_stop(&sid).await;

        // Restart — writer.init_session clears previous JSONL.
        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har.log.entries.len(), 0);
    }

    #[tokio::test]
    async fn not_failed_for_local_writer() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();
        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        assert!(!plugin.inner.writer.is_failed(&sid));
    }

    #[tokio::test]
    async fn on_exchange_uses_iteration_parameter() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();

        plugin.on_session_start(&sid, &serde_json::json!({})).await;

        // Exchange lands in iter-1.
        plugin.on_exchange(&sid, &make_exchange(), 1).await;
        let har1 = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har1.log.entries.len(), 1);

        // Init iteration 2 on the writer and send exchange with iteration=2.
        plugin.inner.writer.init_iteration(&sid, 2).await;
        plugin.on_exchange(&sid, &make_exchange(), 2).await;

        let har2 = plugin.inner.build_har_for_session(&sid, 2).await.unwrap();
        assert_eq!(har2.log.entries.len(), 1);
        // iter-1 still has 1.
        let har1_after = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har1_after.log.entries.len(), 1);
    }

    #[tokio::test]
    async fn disabled_session_records_nothing() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "scanner-session".to_string();

        plugin
            .on_session_start(&sid, &serde_json::json!({ "enabled": false }))
            .await;
        let mut headers = HeaderMap::new();
        let uri = Uri::from_static("https://api.githubcopilot.com/models");
        assert!(plugin.on_request(&sid, &uri, &mut headers).await.is_ok());
        plugin.on_exchange(&sid, &make_exchange(), 1).await;
        assert!(plugin.on_iteration_rotate(&sid, 2).await.is_ok());
        plugin.on_session_stop(&sid).await;

        assert!(plugin.inner.build_har_for_session(&sid, 1).await.is_none());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);

        plugin.on_session_clear(&sid).await;
        assert!(plugin.inner.sessions.read().get(&sid).is_none());
    }

    #[tokio::test]
    async fn explicit_enabled_true_records() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();

        plugin
            .on_session_start(&sid, &serde_json::json!({ "enabled": true }))
            .await;
        plugin.on_exchange(&sid, &make_exchange(), 1).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har.log.entries.len(), 1);
    }
}
