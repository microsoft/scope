// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Entry point for the gateway proxy binary.
//!
//! Parses CLI args, loads YAML config, initializes the CA, plugin registry,
//! session manager, and starts the unified TCP listener that handles both
//! proxy traffic (CONNECT tunneling, HTTP forwarding) and the REST API on a
//! single port. This ensures K8s sessionAffinity: ClientIP works correctly
//! since all traffic from a client uses the same port.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use clap::Parser;
use http_body_util::Full;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use tokio::net::TcpListener;
use tracing::{error, info, warn};

use azure_storage::{CloudLocation, StorageCredentials};
use azure_storage_blobs::prelude::{BlobServiceClient, ClientBuilder};
use gateway::api::routes::ApiState;
use gateway::api::server::build_api_router;
use gateway::ca::CertificateAuthority;
use gateway::config::{Cli, Config};
use gateway::filters::UrlFilter;
use gateway::iteration_store::{IterationStore, LocalIterationStore, RedisIterationStore};
use gateway::plugin::PluginRegistry;
use gateway::plugins::capi_hmac::plugin::CapiHmacPlugin;
use gateway::plugins::har::plugin::HarPlugin;
use gateway::proxy::handler::{handle_client, ProxyState};
use gateway::session::SessionManager;
use gateway::session_store::SessionStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Install the process-level CryptoProvider so that all rustls consumers
    // (our proxy TLS + reqwest in plugins) use the same aws-lc-rs backend.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install default CryptoProvider");

    let cli = Cli::parse();
    let config = Config::load(&cli)?;

    // Logging: RUST_LOG env var takes precedence, then config file's logLevel, then default
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| config.log_level.parse().unwrap_or_default()),
        )
        .init();

    info!("Starting gateway proxy");
    info!("Listening on port: {}", config.port);
    info!("Watching URLs: {:?}", config.urls_to_watch);

    // CA
    let ca = Arc::new(CertificateAuthority::new(&config.cert_dir, 1000)?);
    info!("CA loaded from {:?}", config.cert_dir);

    // URL filter
    let url_filter = Arc::new(UrlFilter::new(&config.urls_to_watch)?);

    // Redis client — shared between session store and HAR iteration store.
    let redis_client: Option<fred::prelude::Client> = {
        let redis_host = std::env::var("REDIS_HOST").ok();
        if let Some(host) = redis_host {
            let port: u16 = std::env::var("REDIS_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(6380);
            let password = std::env::var("REDIS_PASSWORD").ok();
            let use_cluster = std::env::var("REDIS_CLUSTER")
                .map(|v| v == "true")
                .unwrap_or(false);
            // Clustered Redis over TLS (e.g. Azure Managed Redis Enterprise with
            // OSSCluster policy) returns per-shard IP addresses in CLUSTER SLOTS.
            // The cluster certificate is bound to the cluster FQDN, not those IPs,
            // so SNI/cert validation against the IPs fails. `DefaultHost` tells
            // fred to substitute the originally-configured hostname when validating
            // each shard's TLS certificate. Centralized deployments don't need this.
            let tls = if std::env::var("REDIS_TLS")
                .map(|v| v == "true")
                .unwrap_or(false)
            {
                fred::types::config::TlsConnector::default_rustls()
                    .ok()
                    .map(|connector| fred::types::config::TlsConfig {
                        connector,
                        hostnames: if use_cluster {
                            fred::types::config::TlsHostMapping::DefaultHost
                        } else {
                            fred::types::config::TlsHostMapping::None
                        },
                    })
            } else {
                None
            };
            let server = if use_cluster {
                fred::types::config::ServerConfig::new_clustered(vec![(host.as_str(), port)])
            } else {
                fred::types::config::ServerConfig::new_centralized(host.as_str(), port)
            };
            let redis_config = fred::types::config::Config {
                server,
                password,
                tls,
                ..Default::default()
            };
            match fred::types::Builder::from_config(redis_config).build() {
                Ok(client) => {
                    use fred::interfaces::ClientLike;
                    match client.init().await {
                        Ok(_) => {
                            info!("Redis: connected to {}:{}", host, port);
                            Some(client)
                        }
                        Err(e) => {
                            warn!("Redis: connect failed, running without persistence: {}", e);
                            None
                        }
                    }
                }
                Err(e) => {
                    warn!("Redis: config error, running without persistence: {}", e);
                    None
                }
            }
        } else {
            info!("Redis: REDIS_HOST not set, running without persistence");
            None
        }
    };

    // Iteration store — backed by Redis when available, in-memory otherwise.
    let iteration_store: Arc<dyn IterationStore> = match redis_client.as_ref() {
        Some(c) => Arc::new(RedisIterationStore::new(c.clone())),
        None => Arc::new(LocalIterationStore::new()),
    };

    // Plugins — HAR writer backend selected from config
    let (har_plugin, blob_container_client): (
        Arc<dyn gateway::plugin::ProxyPlugin>,
        Option<azure_storage_blobs::prelude::ContainerClient>,
    ) = if let Some(blob_cfg) = &config.har_blob {
        let use_emulator = std::env::var("AZURE_STORAGE_USE_EMULATOR")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let container_client = if use_emulator {
            let emulator_host =
                std::env::var("AZURITE_BLOB_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
            let emulator_port: u16 = std::env::var("AZURITE_BLOB_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(10000);
            info!(
                "HAR plugin: using Azurite emulator backend ({}:{}, container={})",
                emulator_host, emulator_port, blob_cfg.container_name
            );
            ClientBuilder::with_location(
                CloudLocation::Emulator {
                    address: emulator_host,
                    port: emulator_port,
                },
                StorageCredentials::emulator(),
            )
            .blob_service_client()
            .container_client(&blob_cfg.container_name)
        } else {
            let conn_str = std::env::var("STORAGE_CONNECTION_STRING").map_err(|_| {
                anyhow::anyhow!(
                    "STORAGE_CONNECTION_STRING env var is required when harBlob is configured"
                )
            })?;
            let (account_name, storage_creds) =
                gateway::storage::parse_connection_string(&conn_str)?;
            info!(
                "HAR plugin: using Azure Blob Storage backend (account={}, container={})",
                account_name, blob_cfg.container_name
            );
            BlobServiceClient::new(&account_name, storage_creds)
                .container_client(&blob_cfg.container_name)
        };

        if redis_client.is_none() {
            anyhow::bail!(
                "Redis is required when harBlob is configured (blob + redis must both be present). \
                 Check earlier logs for the underlying Redis connection error."
            );
        }
        let plugin: Arc<dyn gateway::plugin::ProxyPlugin> = Arc::new(HarPlugin::new_with_blob(
            container_client.clone(),
            std::time::Duration::from_secs(config.plugins.har.append_timeout_secs),
        ));
        (plugin, Some(container_client))
    } else {
        let har_dir = config.plugins.har.output_dir.clone();
        info!("HAR plugin: using local filesystem backend ({:?})", har_dir);
        let plugin: Arc<dyn gateway::plugin::ProxyPlugin> = Arc::new(HarPlugin::new(har_dir));
        (plugin, None)
    };
    let capi_hmac_plugin: Arc<dyn gateway::plugin::ProxyPlugin> = Arc::new(CapiHmacPlugin::new());
    let registry = Arc::new(PluginRegistry::new(vec![
        har_plugin,
        capi_hmac_plugin,
    ]));

    // Session manager — wire Redis store when a client is available.
    let session_manager = match redis_client {
        Some(client) => {
            let store = SessionStore::new(client);
            Arc::new(SessionManager::new_with_store(
                registry.clone(),
                Duration::from_secs(300),
                100,
                store,
                iteration_store,
            ))
        }
        None => Arc::new(SessionManager::new(
            registry.clone(),
            Duration::from_secs(300),
            100,
            iteration_store,
        )),
    };

    // Shared HTTP/1.1 connection pool for plain (non-CONNECT) forwarding.
    // A single client avoids per-request connection setup and enables keepalive reuse.
    let http_client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .build_http();

    // Pre-built TLS config for upstream connections (MITM relay).
    // Contains Mozilla roots + any additional CA certs from config.
    let upstream_root_store = config.upstream_root_store()?;
    let upstream_tls_config = Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(upstream_root_store)
            .with_no_client_auth(),
    );
    if !config.additional_ca_certs.is_empty() {
        info!(
            "Loaded additional CA certs from {:?}",
            config.additional_ca_certs
        );
    }

    // API state & router (served on the same port as proxy traffic)
    let api_state = Arc::new(ApiState {
        session_manager: session_manager.clone(),
        ca: ca.clone(),
        blob_container_client: blob_container_client.clone(),
    });
    let plugin_routes: Vec<axum::Router> = registry
        .plugins()
        .iter()
        .filter_map(|p| p.api_routes())
        .collect();
    let api_router = build_api_router(api_state, plugin_routes);

    let proxy_state = Arc::new(ProxyState {
        session_manager: session_manager.clone(),
        registry: registry.clone(),
        ca: ca.clone(),
        url_filter,
        http_client,
        upstream_tls_config,
        api_router,
    });

    // Background task that periodically scans for sessions with no recent activity.
    // Orphaned sessions (e.g., client crashed without calling stop) are cleaned up here.
    let reaper_session_mgr = session_manager.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let reaped = reaper_session_mgr.reap_idle().await;
            if !reaped.is_empty() {
                info!("Reaped {} idle sessions", reaped.len());
            }
        }
    });

    // Start unified listener (proxy + API on the same port)
    let listen_addr = format!("0.0.0.0:{}", config.port);
    let listener = TcpListener::bind(&listen_addr).await?;
    info!("Proxy listening on {}", listen_addr);

    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let state = proxy_state.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_client(stream, peer_addr, state).await {
                        tracing::debug!("Client connection ended: {}", e);
                    }
                });
            }
            Err(e) => {
                error!("Accept error: {}", e);
                // Back off on transient errors (e.g. EMFILE) to avoid hot-looping
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}
