// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Configuration loading with a three-layer precedence chain:
//! compiled defaults → YAML file → CLI flags.
//!
//! Uses serde for YAML deserialization with `#[serde(default)]` to fill
//! missing fields from compiled defaults, so partial config files work.
//!
//! Two categories of plugin settings:
//! - `plugins.<name>` — gateway-level only; cannot be overridden per session
//! - `defaultSessionPluginSettings.<name>` — defaults that callers may override
//!   when creating a session via `POST /api/v1/sessions`

use std::collections::HashMap;
use std::path::PathBuf;

use clap::Parser;
use serde::{Deserialize, Serialize};

/// CLI arguments parsed by clap.
#[derive(Parser, Debug)]
#[command(
    name = "gateway",
    about = "TLS-intercepting HTTP proxy with plugin architecture"
)]
pub struct Cli {
    /// Path to YAML config file
    #[arg(long, short)]
    pub config: Option<PathBuf>,

    /// Proxy listen port
    #[arg(long)]
    pub port: Option<u16>,

    /// API listen port
    #[arg(long, name = "api-port")]
    pub api_port: Option<u16>,

    /// Certificate directory
    #[arg(long, name = "cert-dir")]
    pub cert_dir: Option<PathBuf>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, name = "log-level")]
    pub log_level: Option<String>,

    /// Paths to PEM files with additional CA certificates for upstream TLS (repeatable)
    #[arg(long = "additional-ca-certs")]
    pub additional_ca_certs: Vec<PathBuf>,
}

/// Gateway-level CAPI HMAC plugin settings (not overridable per session).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapiHmacPluginConfig {}

/// Gateway-level HAR plugin settings (not overridable per session).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarPluginConfig {
    /// Directory for local JSONL output (used when `harBlob` is absent).
    #[serde(default = "default_har_output_dir")]
    pub output_dir: PathBuf,

    /// Hard timeout (in seconds) for a single blob append attempt including all
    /// retries. If the timeout fires, the session is marked hard-failed and the
    /// next proxied request returns a 502. Default: 120 (2 minutes).
    #[serde(default = "default_har_append_timeout_secs")]
    pub append_timeout_secs: u64,
}

impl Default for HarPluginConfig {
    fn default() -> Self {
        Self {
            output_dir: default_har_output_dir(),
            append_timeout_secs: default_har_append_timeout_secs(),
        }
    }
}

/// Gateway-level plugin config (not overridable per session).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginsConfig {
    #[serde(default)]
    pub har: HarPluginConfig,
    #[serde(default)]
    pub capi_hmac: CapiHmacPluginConfig,
}

/// Azure Blob Storage config for HAR streaming (optional).
/// When present, HAR entries are streamed to an Azure append blob instead of
/// being written to the pod's local filesystem.
/// The storage account URL is taken from the `BLOB_STORAGE_URL` env var.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarBlobConfig {
    /// Name of the blob container that holds HAR files (must already exist).
    pub container_name: String,
}

/// Gateway configuration loaded from YAML, with defaults and CLI overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_urls_to_watch")]
    pub urls_to_watch: Vec<String>,

    #[serde(default = "default_port")]
    pub port: u16,

    #[serde(default = "default_api_port")]
    pub api_port: u16,

    #[serde(default = "default_cert_dir")]
    pub cert_dir: PathBuf,

    #[serde(default = "default_log_level")]
    pub log_level: String,

    /// Default per-session plugin settings; callers may override these when
    /// creating a session via `POST /api/v1/sessions`.
    #[serde(default)]
    pub default_session_plugin_settings: HashMap<String, serde_json::Value>,

    /// Gateway-level plugin config (cannot be overridden per session).
    #[serde(default)]
    pub plugins: PluginsConfig,

    /// Paths to PEM files with additional CA certificates trusted for upstream
    /// TLS connections. Each file may contain one or more PEM-encoded certs.
    /// Useful for local testing with self-signed certs and corporate environments
    /// with TLS inspection proxies.
    #[serde(default)]
    pub additional_ca_certs: Vec<PathBuf>,

    /// Optional Azure Blob Storage config for HAR streaming.
    /// When absent, HAR entries are written to local JSONL files (default).
    #[serde(default)]
    pub har_blob: Option<HarBlobConfig>,
}

fn default_urls_to_watch() -> Vec<String> {
    vec!["https://*/*".to_string()]
}

fn default_port() -> u16 {
    18000
}

fn default_api_port() -> u16 {
    18897
}

fn default_cert_dir() -> PathBuf {
    PathBuf::from("/tmp/scope-gateway/certs")
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_har_output_dir() -> PathBuf {
    PathBuf::from("/tmp/scope-gateway/har-output")
}

fn default_har_append_timeout_secs() -> u64 {
    120
}

impl Default for Config {
    fn default() -> Self {
        Self {
            urls_to_watch: default_urls_to_watch(),
            port: default_port(),
            api_port: default_api_port(),
            cert_dir: default_cert_dir(),
            log_level: default_log_level(),
            default_session_plugin_settings: HashMap::new(),
            plugins: PluginsConfig::default(),
            additional_ca_certs: Vec::new(),
            har_blob: None,
        }
    }
}

impl Config {
    /// Load config from YAML file, then apply CLI overrides.
    pub fn load(cli: &Cli) -> anyhow::Result<Self> {
        let mut config = if let Some(path) = &cli.config {
            let contents = std::fs::read_to_string(path)
                .map_err(|e| anyhow::anyhow!("Failed to read config file {:?}: {}", path, e))?;
            serde_yaml::from_str(&contents)
                .map_err(|e| anyhow::anyhow!("Failed to parse config file {:?}: {}", path, e))?
        } else {
            Config::default()
        };

        // CLI flags override file values
        if let Some(port) = cli.port {
            config.port = port;
        }
        if let Some(api_port) = cli.api_port {
            config.api_port = api_port;
        }
        if let Some(cert_dir) = &cli.cert_dir {
            config.cert_dir = cert_dir.clone();
        }
        if let Some(log_level) = &cli.log_level {
            config.log_level = log_level.clone();
        }
        if !cli.additional_ca_certs.is_empty() {
            config.additional_ca_certs = cli.additional_ca_certs.clone();
        }

        Ok(config)
    }

    /// Build a rustls `RootCertStore` containing Mozilla roots plus any
    /// additional CA certificates from `additionalCaCerts` PEM files.
    pub fn upstream_root_store(&self) -> anyhow::Result<rustls::RootCertStore> {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

        for path in &self.additional_ca_certs {
            let pem_data = std::fs::read(path).map_err(|e| {
                anyhow::anyhow!("Failed to read additional CA certs {:?}: {}", path, e)
            })?;
            let certs = rustls_pemfile::certs(&mut &pem_data[..])
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| anyhow::anyhow!("Failed to parse PEM from {:?}: {}", path, e))?;
            for cert in &certs {
                root_store.add(cert.clone())?;
            }
        }

        Ok(root_store)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_expected_values() {
        let config = Config::default();
        assert_eq!(config.port, 18000);
        assert_eq!(config.api_port, 18897);
        assert_eq!(config.log_level, "info");
        assert!(!config.urls_to_watch.is_empty());
    }

    #[test]
    fn parse_yaml_config() {
        let yaml = r#"
urlsToWatch:
  - "https://api.github.com/*"
  - "https://api.anthropic.com/*"
port: 9000
apiPort: 9001
certDir: /tmp/certs
logLevel: debug
plugins:
  har:
    outputDir: /tmp/har
defaultSessionPluginSettings:
  har:
    redactCredentials: false
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.port, 9000);
        assert_eq!(config.api_port, 9001);
        assert_eq!(config.urls_to_watch.len(), 2);
        assert_eq!(config.cert_dir, PathBuf::from("/tmp/certs"));
        assert_eq!(config.log_level, "debug");
        assert_eq!(config.plugins.har.output_dir, PathBuf::from("/tmp/har"));
        assert_eq!(config.plugins.har.append_timeout_secs, 120); // default
        assert_eq!(
            config.default_session_plugin_settings["har"]["redactCredentials"],
            false
        );
    }

    #[test]
    fn cli_overrides_file_values() {
        let cli = Cli {
            config: None,
            port: Some(7777),
            api_port: Some(7778),
            cert_dir: None,
            log_level: Some("debug".to_string()),
            additional_ca_certs: vec![],
        };
        let config = Config::load(&cli).unwrap();
        assert_eq!(config.port, 7777);
        assert_eq!(config.api_port, 7778);
        assert_eq!(config.cert_dir, default_cert_dir()); // not overridden
        assert_eq!(config.log_level, "debug");
    }

    #[test]
    fn missing_fields_use_defaults() {
        let yaml = "port: 5555\n";
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.port, 5555);
        assert_eq!(config.api_port, 18897); // default
        assert_eq!(config.log_level, "info"); // default
    }

    #[test]
    fn invalid_yaml_returns_error() {
        let cli = Cli {
            config: Some(PathBuf::from("/nonexistent/config.yaml")),
            port: None,
            api_port: None,
            cert_dir: None,
            log_level: None,
            additional_ca_certs: vec![],
        };
        assert!(Config::load(&cli).is_err());
    }
}
