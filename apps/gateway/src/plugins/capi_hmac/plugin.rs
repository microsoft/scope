// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! CAPI HMAC request-signing plugin.
//!
//! Intercepts outbound requests to Copilot API (CAPI) hosts and attaches an
//! HMAC-SHA256 signature header. This proves request authenticity to CAPI
//! endpoints that enforce signature validation.
//!
//! The plugin only activates for sessions that provide `capi_hmac` settings
//! at session start time. Sessions without this config are completely unaffected.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use hmac::{Hmac, Mac};
use http::{HeaderMap, HeaderValue, Uri};
use parking_lot::RwLock;
use serde::Deserialize;
use sha2::Sha256;
use tracing::{debug, info, warn};

use crate::plugin::{HttpExchange, ProxyPlugin, SessionId};

type HmacSha256 = Hmac<Sha256>;

/// Per-session configuration provided at session start under the `"capi_hmac"` key.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionConfig {
    /// Base64-encoded HMAC signing key.
    signing_key: String,
    /// Machine identifier included in the signature payload.
    #[serde(default = "default_machine_id")]
    machine_id: String,
    /// Hostnames whose requests should be signed.
    #[serde(default = "default_target_hosts")]
    target_hosts: Vec<String>,
    /// Header name for the HMAC signature (default: `x-copilot-signature`).
    #[serde(default = "default_signature_header")]
    signature_header: String,
}

fn default_machine_id() -> String {
    std::env::var("CAPI_HMAC_MACHINE_ID").unwrap_or_else(|_| "scope-gateway".to_string())
}

fn default_target_hosts() -> Vec<String> {
    vec![
        "api.githubcopilot.com".to_string(),
        "api.enterprise.githubcopilot.com".to_string(),
        "copilot-proxy.githubusercontent.com".to_string(),
    ]
}

fn default_signature_header() -> String {
    "x-copilot-signature".to_string()
}

/// Per-session state: config + decoded key.
struct SessionState {
    config: SessionConfig,
    /// Pre-decoded signing key (avoids base64 decode on every request).
    key_bytes: Vec<u8>,
}

/// CAPI HMAC request-signing plugin.
pub struct CapiHmacPlugin {
    sessions: Arc<RwLock<HashMap<SessionId, SessionState>>>,
}

impl Default for CapiHmacPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl CapiHmacPlugin {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Check if a URI's host matches one of the configured target hosts.
    fn matches_target_host(uri: &Uri, target_hosts: &[String]) -> bool {
        let host = match uri.host() {
            Some(h) => h,
            None => return false,
        };
        target_hosts.iter().any(|t| host == t)
    }

    /// Build the canonical string and compute the HMAC-SHA256 signature.
    ///
    /// Format: `v1:{unix_timestamp}:{base64(hmac_sha256(method\npath\ntimestamp\nmachineId))}`
    fn compute_signature(
        key_bytes: &[u8],
        method: &str,
        path: &str,
        timestamp: u64,
        machine_id: &str,
    ) -> anyhow::Result<String> {
        let canonical = format!("{}\n{}\n{}\n{}", method, path, timestamp, machine_id);

        let mut mac = HmacSha256::new_from_slice(key_bytes)
            .map_err(|e| anyhow::anyhow!("invalid HMAC key: {}", e))?;
        mac.update(canonical.as_bytes());
        let result = mac.finalize().into_bytes();

        let encoded = base64::engine::general_purpose::STANDARD.encode(result);
        Ok(format!("v1:{}:{}", timestamp, encoded))
    }

    /// Return the current Unix timestamp in seconds.
    fn now_unix_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before UNIX epoch")
            .as_secs()
    }
}

#[async_trait]
impl ProxyPlugin for CapiHmacPlugin {
    fn name(&self) -> &str {
        "capi_hmac"
    }

    async fn on_session_start(&self, session_id: &SessionId, settings: &serde_json::Value) {
        // Only activate if settings are a non-empty object
        if settings.is_null() || settings.as_object().is_none_or(|m| m.is_empty()) {
            return;
        }

        let config: SessionConfig = match serde_json::from_value(settings.clone()) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "capi_hmac plugin: invalid settings for session {}: {}",
                    session_id, e
                );
                return;
            }
        };

        let key_bytes = match base64::engine::general_purpose::STANDARD.decode(&config.signing_key)
        {
            Ok(k) => k,
            Err(e) => {
                warn!(
                    "capi_hmac plugin: invalid base64 signingKey for session {}: {}",
                    session_id, e
                );
                return;
            }
        };

        info!(
            "capi_hmac plugin: activated for session {} (targets={:?}, header={}, machine_id={})",
            session_id, config.target_hosts, config.signature_header, config.machine_id
        );

        let mut sessions = self.sessions.write();
        sessions.insert(session_id.clone(), SessionState { config, key_bytes });
    }

    async fn on_request(
        &self,
        session_id: &SessionId,
        uri: &Uri,
        headers: &mut HeaderMap,
    ) -> anyhow::Result<()> {
        let (config, key_bytes) = {
            let sessions = self.sessions.read();
            let state = match sessions.get(session_id) {
                Some(s) => s,
                None => return Ok(()),
            };

            if !Self::matches_target_host(uri, &state.config.target_hosts) {
                return Ok(());
            }

            (state.config.clone(), state.key_bytes.clone())
        };

        // The gateway operates as a CONNECT proxy: the outer HTTP method is always
        // CONNECT regardless of the inner request method (GET, POST, etc.). The CAPI
        // verifier expects the signature to use the tunnel method, not the inner one.
        let method = "CONNECT";
        let path = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
        let timestamp = Self::now_unix_secs();

        let signature =
            Self::compute_signature(&key_bytes, method, path, timestamp, &config.machine_id)?;

        let header_name = http::header::HeaderName::from_bytes(config.signature_header.as_bytes())
            .map_err(|e| {
                anyhow::anyhow!(
                    "invalid signature header name '{}': {}",
                    config.signature_header,
                    e
                )
            })?;
        let header_value = HeaderValue::from_str(&signature)
            .map_err(|e| anyhow::anyhow!("failed to encode signature as header value: {}", e))?;

        headers.insert(header_name, header_value);
        debug!(
            "capi_hmac plugin: signed request to {} for session {}",
            uri, session_id
        );

        Ok(())
    }

    async fn on_exchange(
        &self,
        _session_id: &SessionId,
        _exchange: &HttpExchange,
        _iteration: u32,
    ) {
        // No-op: this plugin doesn't observe exchanges.
    }

    async fn on_session_stop(&self, session_id: &SessionId) {
        debug!("capi_hmac plugin: session stopped for {}", session_id);
    }

    async fn on_session_clear(&self, session_id: &SessionId) {
        let mut sessions = self.sessions.write();
        sessions.remove(session_id);
        debug!("capi_hmac plugin: session cleared for {}", session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_signing_key() -> String {
        base64::engine::general_purpose::STANDARD.encode(b"test-secret-key-32-bytes-long!!!")
    }

    fn make_settings() -> serde_json::Value {
        json!({
            "signingKey": make_signing_key(),
            "machineId": "test-machine-001",
            "targetHosts": ["api.githubcopilot.com"],
            "signatureHeader": "x-copilot-signature"
        })
    }

    #[tokio::test]
    async fn no_activation_when_settings_empty() {
        let plugin = CapiHmacPlugin::new();
        plugin.on_session_start(&"s1".to_string(), &json!({})).await;

        let sessions = plugin.sessions.read();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn no_activation_when_settings_null() {
        let plugin = CapiHmacPlugin::new();
        plugin
            .on_session_start(&"s1".to_string(), &serde_json::Value::Null)
            .await;

        let sessions = plugin.sessions.read();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn no_activation_when_signing_key_invalid_base64() {
        let plugin = CapiHmacPlugin::new();
        let settings = json!({
            "signingKey": "!!!not-valid-base64!!!",
            "machineId": "m1"
        });
        plugin.on_session_start(&"s1".to_string(), &settings).await;

        let sessions = plugin.sessions.read();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn activation_with_valid_settings() {
        let plugin = CapiHmacPlugin::new();
        let settings = make_settings();
        plugin.on_session_start(&"s1".to_string(), &settings).await;

        let sessions = plugin.sessions.read();
        assert!(sessions.contains_key("s1"));
    }

    #[tokio::test]
    async fn session_clear_removes_state() {
        let plugin = CapiHmacPlugin::new();
        plugin
            .on_session_start(&"s1".to_string(), &make_settings())
            .await;
        plugin.on_session_clear(&"s1".to_string()).await;

        let sessions = plugin.sessions.read();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn on_request_noop_for_unconfigured_session() {
        let plugin = CapiHmacPlugin::new();
        let uri: Uri = "https://api.githubcopilot.com/v1/chat".parse().unwrap();
        let mut headers = HeaderMap::new();

        let result = plugin
            .on_request(&"unknown".to_string(), &uri, &mut headers)
            .await;
        assert!(result.is_ok());
        assert!(headers.get("x-copilot-signature").is_none());
    }

    #[tokio::test]
    async fn on_request_noop_for_non_target_host() {
        let plugin = CapiHmacPlugin::new();
        plugin
            .on_session_start(&"s1".to_string(), &make_settings())
            .await;

        let uri: Uri = "https://example.com/api".parse().unwrap();
        let mut headers = HeaderMap::new();

        let result = plugin
            .on_request(&"s1".to_string(), &uri, &mut headers)
            .await;
        assert!(result.is_ok());
        assert!(headers.get("x-copilot-signature").is_none());
    }

    #[tokio::test]
    async fn on_request_attaches_signature_for_target_host() {
        let plugin = CapiHmacPlugin::new();
        plugin
            .on_session_start(&"s1".to_string(), &make_settings())
            .await;

        let uri: Uri = "https://api.githubcopilot.com/v1/chat/completions"
            .parse()
            .unwrap();
        let mut headers = HeaderMap::new();

        let result = plugin
            .on_request(&"s1".to_string(), &uri, &mut headers)
            .await;
        assert!(result.is_ok());

        let sig = headers
            .get("x-copilot-signature")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(sig.starts_with("v1:"), "signature should start with 'v1:'");
        // v1:{timestamp}:{base64}
        let parts: Vec<&str> = sig.splitn(3, ':').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "v1");
        // Timestamp should be a valid u64
        parts[1].parse::<u64>().expect("timestamp should be u64");
        // Base64 part should decode successfully
        base64::engine::general_purpose::STANDARD
            .decode(parts[2])
            .expect("signature should be valid base64");
    }

    #[tokio::test]
    async fn compute_signature_is_deterministic() {
        let key = b"test-key";
        let sig1 =
            CapiHmacPlugin::compute_signature(key, "CONNECT", "/v1/chat", 1000000, "machine-1")
                .unwrap();
        let sig2 =
            CapiHmacPlugin::compute_signature(key, "CONNECT", "/v1/chat", 1000000, "machine-1")
                .unwrap();
        assert_eq!(sig1, sig2);
    }

    #[tokio::test]
    async fn compute_signature_differs_for_different_inputs() {
        let key = b"test-key";
        let sig1 =
            CapiHmacPlugin::compute_signature(key, "CONNECT", "/v1/chat", 1000000, "machine-1")
                .unwrap();
        let sig2 = CapiHmacPlugin::compute_signature(
            key,
            "CONNECT",
            "/v1/completions",
            1000000,
            "machine-1",
        )
        .unwrap();
        assert_ne!(sig1, sig2, "different paths should produce different sigs");

        let sig3 =
            CapiHmacPlugin::compute_signature(key, "CONNECT", "/v1/chat", 1000001, "machine-1")
                .unwrap();
        assert_ne!(
            sig1, sig3,
            "different timestamps should produce different sigs"
        );

        let sig4 =
            CapiHmacPlugin::compute_signature(key, "CONNECT", "/v1/chat", 1000000, "machine-2")
                .unwrap();
        assert_ne!(
            sig1, sig4,
            "different machine IDs should produce different sigs"
        );
    }

    #[tokio::test]
    async fn compute_signature_known_vector() {
        // Verify the signature format and that it's a valid HMAC-SHA256
        let key = b"known-test-key";
        let sig = CapiHmacPlugin::compute_signature(key, "GET", "/test", 1720000000, "m1").unwrap();

        assert!(sig.starts_with("v1:1720000000:"));

        // Verify by recomputing manually
        let canonical = "GET\n/test\n1720000000\nm1";
        let mut mac = HmacSha256::new_from_slice(key).unwrap();
        mac.update(canonical.as_bytes());
        let expected =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        assert_eq!(sig, format!("v1:1720000000:{}", expected));
    }

    #[tokio::test]
    async fn custom_signature_header_is_used() {
        let plugin = CapiHmacPlugin::new();
        let settings = json!({
            "signingKey": make_signing_key(),
            "machineId": "m1",
            "targetHosts": ["api.githubcopilot.com"],
            "signatureHeader": "x-custom-sig"
        });
        plugin.on_session_start(&"s1".to_string(), &settings).await;

        let uri: Uri = "https://api.githubcopilot.com/v1/chat".parse().unwrap();
        let mut headers = HeaderMap::new();

        let result = plugin
            .on_request(&"s1".to_string(), &uri, &mut headers)
            .await;
        assert!(result.is_ok());
        assert!(headers.get("x-custom-sig").is_some());
        assert!(headers.get("x-copilot-signature").is_none());
    }

    #[tokio::test]
    async fn default_target_hosts_include_all_copilot_hosts() {
        let hosts = default_target_hosts();
        assert!(hosts.contains(&"api.githubcopilot.com".to_string()));
        assert!(hosts.contains(&"api.enterprise.githubcopilot.com".to_string()));
        assert!(hosts.contains(&"copilot-proxy.githubusercontent.com".to_string()));
    }

    #[test]
    fn matches_target_host_works() {
        let hosts = vec!["api.githubcopilot.com".to_string()];

        let uri: Uri = "https://api.githubcopilot.com/v1/chat".parse().unwrap();
        assert!(CapiHmacPlugin::matches_target_host(&uri, &hosts));

        let uri: Uri = "https://example.com/v1/chat".parse().unwrap();
        assert!(!CapiHmacPlugin::matches_target_host(&uri, &hosts));

        // URI without host
        let uri: Uri = "/just-a-path".parse().unwrap();
        assert!(!CapiHmacPlugin::matches_target_host(&uri, &hosts));
    }
}
