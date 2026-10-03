// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Token Manager HTTP client.
//!
//! Acquires GitHub OAuth scopeless tokens from the Token Manager service
//! via its `POST /api/v1/keys/acquire` endpoint.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Response from the Token Manager `POST /api/v1/keys/acquire` endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireKeyResponse {
    pub value: String,
    pub key_id: String,
    pub key_type: String,
    pub capability: String,
}

/// Request body for the Token Manager `POST /api/v1/keys/acquire` endpoint.
#[derive(Debug, Serialize)]
pub struct AcquireKeyRequest {
    pub capability: String,
}

/// Acquires a GitHub OAuth scopeless token from the Token Manager.
pub async fn acquire_github_token(
    http_client: &reqwest::Client,
    token_manager_url: &str,
    capability: &str,
) -> Result<String> {
    let url = format!(
        "{}/api/v1/keys/acquire",
        token_manager_url.trim_end_matches('/')
    );

    let resp = http_client
        .post(&url)
        .json(&AcquireKeyRequest {
            capability: capability.to_string(),
        })
        .send()
        .await
        .context("Failed to reach Token Manager")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!(
            "Token Manager returned {} for capability '{}': {}",
            status,
            capability,
            body
        );
    }

    let key_resp: AcquireKeyResponse = resp
        .json()
        .await
        .context("Failed to parse Token Manager response")?;

    debug!(
        "Acquired {} token (key_id={}) for capability '{}'",
        key_resp.key_type, key_resp.key_id, key_resp.capability
    );

    Ok(key_resp.value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn acquire_success_returns_token_value() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/v1/keys/acquire"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "value": "gh-oauth-token-abc",
                "keyId": "key-42",
                "keyType": "generic-keytype",
                "capability": "generic-cap"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let result = acquire_github_token(&client, &server.uri(), "generic-cap").await;

        assert_eq!(result.unwrap(), "gh-oauth-token-abc");
    }

    #[tokio::test]
    async fn acquire_non_success_status_returns_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/v1/keys/acquire"))
            .respond_with(ResponseTemplate::new(503).set_body_string("Service Unavailable"))
            .expect(1)
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let result = acquire_github_token(&client, &server.uri(), "generic-cap").await;

        let err = result.unwrap_err();
        assert!(err.to_string().contains("503"));
        assert!(err.to_string().contains("Service Unavailable"));
    }

    #[tokio::test]
    async fn acquire_invalid_json_returns_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/v1/keys/acquire"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{invalid json}"))
            .expect(1)
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let result = acquire_github_token(&client, &server.uri(), "generic-cap").await;

        let err = result.unwrap_err();
        assert!(err.to_string().contains("parse"));
    }

    #[tokio::test]
    async fn acquire_unreachable_server_returns_error() {
        let client = reqwest::Client::new();
        let result = acquire_github_token(&client, "http://127.0.0.1:1", "generic-cap").await;

        let err = result.unwrap_err();
        assert!(err.to_string().contains("Failed to reach"));
    }

    #[tokio::test]
    async fn acquire_trims_trailing_slash_from_url() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/v1/keys/acquire"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "value": "token-xyz",
                "keyId": "k1",
                "keyType": "generic-keytype",
                "capability": "test"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        // Pass URL with trailing slash
        let url_with_slash = format!("{}/", server.uri());
        let result = acquire_github_token(&client, &url_with_slash, "test").await;

        assert_eq!(result.unwrap(), "token-xyz");
    }
}
