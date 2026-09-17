// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Redis-backed session persistence for crash recovery.
//!
//! When a gateway pod dies and Kubernetes restarts it, the new pod has no
//! in-memory session state. `SessionStore` persists session records to Redis
//! so that sessions can be recovered.
//!
//! One Redis key is maintained per session:
//!   `gateway:session:{sessionId}` → full session record JSON
//!
//! The key is set with a TTL derived from the request body's
//! `maxSessionDurationSecs` field (default: 7200s).
//! The TTL is set once at session start and never refreshed.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use backon::{ExponentialBuilder, Retryable};
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// The data persisted to Redis for each active session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub session_id: String,
    pub plugin_settings: HashMap<String, serde_json::Value>,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

/// Trait for session persistence backends (Redis, mocks, etc.).
#[async_trait]
pub trait SessionPersistence: Send + Sync {
    /// Persist a session. Returns `true` if newly created, `false` if it
    /// already existed (idempotent retry).
    async fn save(&self, session: &PersistedSession, ttl: Duration) -> bool;

    /// Delete a session from the store.
    async fn delete(&self, session_id: &str);
}

/// Redis-backed store for session persistence across pod restarts.
///
/// `SessionStore` is cheaply cloneable — `Client` is `Arc`-backed internally.
#[derive(Clone)]
pub struct SessionStore {
    client: Client,
}

impl SessionStore {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl SessionPersistence for SessionStore {
    ///
    /// Returns `true` if the key was newly created, `false` if it already existed
    /// (idempotent retry from another replica). Retries with exponential backoff
    /// on transient failures.
    async fn save(&self, session: &PersistedSession, ttl: Duration) -> bool {
        let ttl_secs = ttl.as_secs() as i64;
        let session_key = format!("gateway:session:{}", session.session_id);

        let Ok(json) = serde_json::to_string(session) else {
            warn!(
                "SessionStore: failed to serialise session {}",
                session.session_id
            );
            return false;
        };

        let retry = ExponentialBuilder::default()
            .with_min_delay(Duration::from_millis(200))
            .with_max_delay(Duration::from_secs(5))
            .with_max_times(10);

        let client = self.client.clone();
        let sk = session_key.clone();
        let jv = json.clone();
        let result = (|| async {
            client
                .set::<Option<String>, _, _>(
                    &sk,
                    jv.as_str(),
                    Some(Expiration::EX(ttl_secs)),
                    Some(SetOptions::NX),
                    false,
                )
                .await
                .map_err(anyhow::Error::from)
        })
        .retry(retry)
        .await;

        match result {
            Ok(Some(_)) => {
                debug!(
                    "SessionStore: saved session {} (ttl={}s)",
                    session.session_id, ttl_secs
                );
                true
            }
            Ok(None) => {
                // SET NX returned nil — key already existed.
                debug!(
                    "SessionStore: session {} already exists in Redis (idempotent)",
                    session.session_id
                );
                false
            }
            Err(e) => {
                warn!(
                    "SessionStore: failed to save session {} after retries: {}",
                    session.session_id, e
                );
                false
            }
        }
    }

    /// Remove the Redis key for a session (called on stop/clear).
    async fn delete(&self, session_id: &str) {
        let session_key = format!("gateway:session:{}", session_id);

        if let Err(e) = self.client.del::<(), _>(&session_key).await {
            warn!(
                "SessionStore: failed to delete session key {}: {}",
                session_id, e
            );
        }
        debug!("SessionStore: deleted session {}", session_id);
    }
}

/// Extract session TTL from plugin settings.
///
/// Reads `_maxSessionDurationSecs` (injected from the request body's top-level
/// `maxSessionDurationSecs` field). Falls back to 7200s (2 hours).
pub fn session_ttl(plugin_settings: &HashMap<String, serde_json::Value>) -> Duration {
    plugin_settings
        .get("_maxSessionDurationSecs")
        .and_then(|v| v.as_u64())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(7200))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_ttl_default_when_no_settings() {
        let settings = HashMap::new();
        assert_eq!(session_ttl(&settings), Duration::from_secs(7200));
    }

    #[test]
    fn session_ttl_default_when_other_plugin_missing() {
        let mut settings = HashMap::new();
        settings.insert("other_plugin".to_string(), json!({"some": "value"}));
        assert_eq!(session_ttl(&settings), Duration::from_secs(7200));
    }

    #[test]
    fn session_ttl_default_when_field_missing_in_other_plugin() {
        let mut settings = HashMap::new();
        settings.insert("other_plugin".to_string(), json!({"other_field": 123}));
        assert_eq!(session_ttl(&settings), Duration::from_secs(7200));
    }

    #[test]
    fn session_ttl_reads_top_level_max_session_duration() {
        let mut settings = HashMap::new();
        settings.insert("_maxSessionDurationSecs".to_string(), json!(5400));
        assert_eq!(session_ttl(&settings), Duration::from_secs(5400));
    }

    #[test]
    fn session_ttl_ignores_non_u64_value() {
        let mut settings = HashMap::new();
        settings.insert("_maxSessionDurationSecs".to_string(), json!("not_a_number"));
        assert_eq!(session_ttl(&settings), Duration::from_secs(7200));
    }
}
