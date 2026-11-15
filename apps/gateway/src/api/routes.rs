// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! REST API route handlers for session CRUD, health checks, and CA certificate retrieval.
//!
//! All session mutations go through `SessionManager`, which handles plugin
//! lifecycle notifications. Session IDs are client-provided UUIDs.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use azure_storage_blobs::prelude::ContainerClient;
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::ca::CertificateAuthority;
use crate::session::SessionManager;

/// Shared state for API routes.
pub struct ApiState {
    pub session_manager: Arc<SessionManager>,
    pub ca: Arc<CertificateAuthority>,
    pub blob_container_client: Option<ContainerClient>,
}

/// GET /health/alive — liveness probe (always 200)
pub async fn get_health_alive() -> impl IntoResponse {
    Json(HealthResponse { status: "ok" })
}

/// GET /health/ready — readiness probe (checks blob storage reachability)
pub async fn get_health_ready(State(state): State<Arc<ApiState>>) -> impl IntoResponse {
    if let Some(client) = &state.blob_container_client {
        match tokio::time::timeout(std::time::Duration::from_secs(3), client.exists()).await {
            Ok(Ok(true)) => Json(HealthResponse { status: "ok" }).into_response(),
            Ok(Ok(false)) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "blob container not found",
                }),
            )
                .into_response(),
            Ok(Err(_)) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "blob storage unreachable",
                }),
            )
                .into_response(),
            Err(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "blob storage timeout",
                }),
            )
                .into_response(),
        }
    } else {
        // No blob backend configured — always ready
        Json(HealthResponse { status: "ok" }).into_response()
    }
}

/// GET /health — legacy endpoint (returns alive status)
pub async fn get_health() -> impl IntoResponse {
    Json(HealthResponse { status: "ok" })
}

/// Response payload for health check.
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

/// POST /api/v1/sessions — create a new session
pub async fn post_create_session(
    State(state): State<Arc<ApiState>>,
    Json(body): Json<SessionCreateRequest>,
) -> impl IntoResponse {
    let session_id = body.id;

    if uuid::Uuid::parse_str(&session_id).is_err() {
        return (StatusCode::BAD_REQUEST, "id must be a valid UUID").into_response();
    }

    let mut plugin_settings = body.plugins.unwrap_or_default();

    // Propagate the top-level maxSessionDurationSecs into plugin_settings
    // so session_ttl() and PluginRegistry can access it uniformly.
    if let Some(secs) = body.max_session_duration_secs {
        plugin_settings.insert(
            "_maxSessionDurationSecs".to_string(),
            serde_json::Value::Number(serde_json::Number::from(secs)),
        );
    }

    info!("Creating session {}", session_id);

    match state
        .session_manager
        .create_session(session_id.clone(), plugin_settings)
        .await
    {
        Ok(true) => (
            StatusCode::CREATED,
            Json(SessionCreatedResponse { id: session_id }),
        )
            .into_response(),
        Ok(false) => (
            StatusCode::OK,
            Json(SessionCreatedResponse { id: session_id }),
        )
            .into_response(),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response(),
    }
}

/// Request body for session creation.
#[derive(Deserialize)]
pub struct SessionCreateRequest {
    pub id: String,
    pub plugins: Option<HashMap<String, serde_json::Value>>,
    /// Maximum session duration in seconds. Used as the TTL for Redis keys.
    /// Falls back to `plugins.plugin.max_session_duration_secs` then 7200s.
    #[serde(rename = "maxSessionDurationSecs")]
    pub max_session_duration_secs: Option<u64>,
}

/// Response body after session creation.
#[derive(Serialize)]
pub struct SessionCreatedResponse {
    pub id: String,
}

/// GET /api/v1/sessions — list all sessions
pub async fn get_list_sessions(State(state): State<Arc<ApiState>>) -> impl IntoResponse {
    let sessions = state.session_manager.list_sessions();
    Json(sessions)
}

/// GET /api/v1/sessions/:id — session status
pub async fn get_session(
    Path(session_id): Path<String>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    match state.session_manager.get_session(&session_id) {
        Some(info) => Json(info).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// POST /api/v1/sessions/:id/stop — stop a session
pub async fn post_stop_session(
    Path(session_id): Path<String>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    info!("Stopping session {}", session_id);

    match state.session_manager.stop_session(&session_id).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(crate::session::SessionError::NotFound) => {
            (StatusCode::NOT_FOUND, "No session found").into_response()
        }
        Err(crate::session::SessionError::NotActive) => {
            (StatusCode::CONFLICT, "Session already stopped").into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// DELETE /api/v1/sessions/:id — delete a session and clean up
pub async fn delete_session(
    Path(session_id): Path<String>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    info!("Deleting session {}", session_id);

    match state.session_manager.delete_session(&session_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(crate::session::SessionError::NotFound) => {
            (StatusCode::NOT_FOUND, "No session found").into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// GET /api/v1/cacert — CA certificate in PEM format
pub async fn get_cacert(State(state): State<Arc<ApiState>>) -> impl IntoResponse {
    let pem = state.ca.ca_cert_pem();

    (
        [(axum::http::header::CONTENT_TYPE, "application/x-pem-file")],
        pem,
    )
}

/// Query parameters for `POST /api/v1/sessions/:id/rotate`.
#[derive(Deserialize)]
pub struct RotateQuery {
    /// Expected current iteration (CAS guard).
    pub expected: u32,
}

/// JSON response for rotate.
#[derive(Serialize)]
pub struct RotateResponse {
    pub iteration: u32,
}

/// POST /api/v1/sessions/:id/rotate?expected=N — rotate to a new iteration.
///
/// CAS semantics: if the session's current iteration == expected, bump to
/// expected+1 and return 200 with the new iteration number. If there's a
/// mismatch, return 409 with the actual value.
pub async fn post_rotate(
    Path(session_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<RotateQuery>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    use crate::iteration_store::CasResult;

    match state
        .session_manager
        .rotate(&session_id, query.expected)
        .await
    {
        Ok(CasResult::Ok(new_iteration)) => {
            info!(
                "Session {} rotated from iter {} to {}",
                session_id, query.expected, new_iteration
            );
            (
                StatusCode::OK,
                Json(RotateResponse {
                    iteration: new_iteration,
                }),
            )
                .into_response()
        }
        Ok(CasResult::Conflict(actual)) => (
            StatusCode::CONFLICT,
            Json(RotateResponse { iteration: actual }),
        )
            .into_response(),
        Err(crate::session::SessionError::NotFound) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{delete, get, post};
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use crate::ca::CertificateAuthority;
    use crate::iteration_store::LocalIterationStore;
    use crate::plugin::PluginRegistry;
    use crate::session::SessionManager;

    /// Build a minimal test router with the session and health routes.
    fn test_router(state: Arc<ApiState>) -> Router {
        let session_routes = Router::new()
            .route("/", get(get_session))
            .route("/stop", post(post_stop_session))
            .route("/rotate", post(post_rotate))
            .route("/", delete(delete_session))
            .with_state(state.clone());

        Router::new()
            .route("/health", get(get_health))
            .route("/health/alive", get(get_health_alive))
            .route("/health/ready", get(get_health_ready))
            .route(
                "/api/v1/sessions",
                post(post_create_session).get(get_list_sessions),
            )
            .route("/api/v1/cacert", get(get_cacert))
            .with_state(state.clone())
            .nest("/api/v1/sessions/{id}", session_routes)
    }

    fn test_state() -> Arc<ApiState> {
        let tmp = tempfile::TempDir::new().unwrap();
        let ca = Arc::new(CertificateAuthority::new(tmp.path(), 10).unwrap());
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let iteration_store =
            Arc::new(LocalIterationStore::new()) as Arc<dyn crate::iteration_store::IterationStore>;
        let mgr = Arc::new(SessionManager::new(
            registry,
            std::time::Duration::from_secs(300),
            100,
            iteration_store,
        ));
        // Leak the TempDir so the CA directory lives for the test duration.
        // This is fine for tests — the OS cleans up on process exit.
        std::mem::forget(tmp);
        Arc::new(ApiState {
            session_manager: mgr,
            ca,
            blob_container_client: None,
        })
    }

    async fn body_string(resp: axum::response::Response) -> String {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    // --- Health endpoints ---

    #[tokio::test]
    async fn health_returns_ok() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn health_alive_returns_ok() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(Request::get("/health/alive").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn health_ready_no_blob_returns_ok() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(Request::get("/health/ready").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    // --- Create session ---

    #[tokio::test]
    async fn create_session_valid_uuid_returns_201() {
        let app = test_router(test_state());
        let id = uuid::Uuid::new_v4().to_string();
        let resp = app
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"id":"{}"}}"#, id)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 201);
        let body = body_string(resp).await;
        assert!(body.contains(&id));
    }

    #[tokio::test]
    async fn create_session_invalid_uuid_returns_400() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"id":"not-a-uuid"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
        let body = body_string(resp).await;
        assert!(body.contains("UUID"));
    }

    #[tokio::test]
    async fn create_session_idempotent_returns_200() {
        let state = test_state();
        let id = uuid::Uuid::new_v4().to_string();

        // First create → 201
        let app = test_router(state.clone());
        let resp = app
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"id":"{}"}}"#, id)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 201);

        // Second create same ID → 200
        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"id":"{}"}}"#, id)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn create_session_max_reached_returns_503() {
        let tmp = tempfile::TempDir::new().unwrap();
        let ca = Arc::new(CertificateAuthority::new(tmp.path(), 10).unwrap());
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let iteration_store =
            Arc::new(LocalIterationStore::new()) as Arc<dyn crate::iteration_store::IterationStore>;
        let mgr = Arc::new(SessionManager::new(
            registry,
            std::time::Duration::from_secs(300),
            1, // max 1 session
            iteration_store,
        ));
        std::mem::forget(tmp);
        let state = Arc::new(ApiState {
            session_manager: mgr,
            ca,
            blob_container_client: None,
        });

        // Fill up the single slot
        let id1 = uuid::Uuid::new_v4().to_string();
        let app = test_router(state.clone());
        let resp = app
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"id":"{}"}}"#, id1)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 201);

        // Second different ID → 503
        let id2 = uuid::Uuid::new_v4().to_string();
        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"id":"{}"}}"#, id2)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 503);
    }

    // --- Get session ---

    #[tokio::test]
    async fn get_session_found_returns_200() {
        let state = test_state();
        let id = uuid::Uuid::new_v4().to_string();
        state
            .session_manager
            .create_session(id.clone(), HashMap::new())
            .await
            .unwrap();

        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::get(format!("/api/v1/sessions/{}", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body = body_string(resp).await;
        assert!(body.contains(&id));
    }

    #[tokio::test]
    async fn get_session_not_found_returns_404() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(
                Request::get(format!("/api/v1/sessions/{}", uuid::Uuid::new_v4()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    // --- List sessions ---

    #[tokio::test]
    async fn list_sessions_returns_all() {
        let state = test_state();
        let id1 = uuid::Uuid::new_v4().to_string();
        let id2 = uuid::Uuid::new_v4().to_string();
        state
            .session_manager
            .create_session(id1, HashMap::new())
            .await
            .unwrap();
        state
            .session_manager
            .create_session(id2, HashMap::new())
            .await
            .unwrap();

        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::get("/api/v1/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body = body_string(resp).await;
        let arr: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap();
        assert_eq!(arr.len(), 2);
    }

    // --- Stop session ---

    #[tokio::test]
    async fn stop_session_returns_200() {
        let state = test_state();
        let id = uuid::Uuid::new_v4().to_string();
        state
            .session_manager
            .create_session(id.clone(), HashMap::new())
            .await
            .unwrap();

        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/stop", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn stop_session_not_found_returns_404() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/stop", uuid::Uuid::new_v4()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn stop_session_already_stopped_returns_409() {
        let state = test_state();
        let id = uuid::Uuid::new_v4().to_string();
        state
            .session_manager
            .create_session(id.clone(), HashMap::new())
            .await
            .unwrap();
        state.session_manager.stop_session(&id).await.unwrap();

        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/stop", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 409);
    }

    // --- Rotate iteration ---

    #[tokio::test]
    async fn rotate_session_returns_200_with_next_iteration() {
        let state = test_state();
        let id = uuid::Uuid::new_v4().to_string();
        state
            .session_manager
            .create_session(id.clone(), HashMap::new())
            .await
            .unwrap();

        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/rotate?expected=1", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), 200);
        let body = body_string(resp).await;
        assert!(body.contains("\"iteration\":2"));
    }

    #[tokio::test]
    async fn rotate_session_conflict_returns_409_with_actual_iteration() {
        let state = test_state();
        let id = uuid::Uuid::new_v4().to_string();
        state
            .session_manager
            .create_session(id.clone(), HashMap::new())
            .await
            .unwrap();

        // First rotate succeeds to iteration 2.
        state.session_manager.rotate(&id, 1).await.unwrap();

        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/rotate?expected=1", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), 409);
        let body = body_string(resp).await;
        assert!(body.contains("\"iteration\":2"));
    }

    // --- Delete session ---

    #[tokio::test]
    async fn delete_session_returns_204() {
        let state = test_state();
        let id = uuid::Uuid::new_v4().to_string();
        state
            .session_manager
            .create_session(id.clone(), HashMap::new())
            .await
            .unwrap();

        let app = test_router(state);
        let resp = app
            .oneshot(
                Request::delete(format!("/api/v1/sessions/{}", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
    }

    #[tokio::test]
    async fn delete_session_not_found_returns_404() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(
                Request::delete(format!("/api/v1/sessions/{}", uuid::Uuid::new_v4()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    // --- CA cert ---

    #[tokio::test]
    async fn cacert_returns_pem() {
        let app = test_router(test_state());
        let resp = app
            .oneshot(Request::get("/api/v1/cacert").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap(),
            "application/x-pem-file"
        );
        let body = body_string(resp).await;
        assert!(body.starts_with("-----BEGIN CERTIFICATE-----"));
    }
}
