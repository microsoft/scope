import { isIP } from "node:net";

export const DEFAULT_TENANT = "11111111-1111-1111-1111-111111111111";
export const SPA_CLIENT_ID = "cccccccc-0000-0000-0000-000000000001";
export const API_CLIENT_ID = "cccccccc-0000-0000-0000-000000000005";
export type RuntimeTarget = "native" | "compose" | "kind";

export interface RuntimeInputs {
  generated?: NodeJS.ProcessEnv;
  local?: NodeJS.ProcessEnv;
  process?: NodeJS.ProcessEnv;
}

/** Use one precedence contract for every runtime, without mutating input files. */
export function resolveRuntimeEnv(inputs: RuntimeInputs, target: RuntimeTarget): Record<string, string> {
  const env = { ...inputs.generated, ...inputs.local, ...inputs.process };
  const config = resolveDevConfig(env);
  const host = (service: string): string => target === "native" ? "127.0.0.1" : service;
  const port = (key: string, fallback: string): string => String(parsePort(env[key] || fallback));
  const mongoPort = target === "native" ? port("MONGODB_PORT", "27000") : "27017";
  const entraPort = target === "native" ? port("SPIKE_ENTRA_PORT", "18443") : "8443";
  const blobPort = target === "native" ? port("AZURITE_BLOB_PORT", "10100") : "10000";
  const queuePort = target === "native" ? port("AZURITE_QUEUE_PORT", "10200") : "10001";
  const tablePort = target === "native" ? port("AZURITE_TABLE_PORT", "10300") : "10002";
  const storageKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
  const values: Record<string, string> = {
    ...config.auth,
    AUTH_PROVIDER: "entra",
    AUTH_TENANT_ID: config.tenant,
    AUTH_API_CLIENT_ID: API_CLIENT_ID,
    AUTH_PORTAL_CLIENT_ID: SPA_CLIENT_ID,
    AUTH_JWKS_URI: `https://${target === "native" ? "localhost" : "entra-local"}:${entraPort}/${config.tenant}/discovery/v2.0/keys`,
    VITE_AUTH_CLIENT_ID: SPA_CLIENT_ID,
    VITE_AUTH_SCOPES: `api://${API_CLIENT_ID}/access_as_user`,
    VITE_AUTH_ENABLED_LOCAL: "true",
    VITE_DEV_EDGE_ORIGIN: config.publicOrigin,
    API_ENDPOINT: `http://${host("api")}:${target === "native" ? port("API_PORT", "3100") : "80"}`,
    MONGO_CONNECTION_STRING: `mongodb://${host("mongodb")}:${mongoPort}/?replicaSet=rs0${target === "native" ? "&directConnection=true" : ""}`,
    MONGO_DATABASE: "scope-dev",
    REDIS_HOST: host("redis"),
    REDIS_PORT: target === "native" ? port("REDIS_PORT", "6300") : "6379",
    REDIS_PASSWORD: "",
    AZURE_STORAGE_ACCOUNT_NAME: "devstoreaccount1",
    STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${storageKey};BlobEndpoint=http://${host("azurite")}:${blobPort}/devstoreaccount1;QueueEndpoint=http://${host("azurite")}:${queuePort}/devstoreaccount1;TableEndpoint=http://${host("azurite")}:${tablePort}/devstoreaccount1;`,
    JUDGE_SERVICE_URL: `http://${host("judge")}:${target === "native" ? port("JUDGE_PORT", "3101") : "80"}`,
    TOKEN_MANAGER_URL: `http://${host("token-manager")}:${target === "native" ? port("TOKEN_MANAGER_PORT", "3102") : "80"}`,
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
    WORKER_CONCURRENCY: "1",
  };
  values.SCOPE_MT_API_URL = values.API_ENDPOINT;
  return values;
}

/** Public settings are selected explicitly, never serialized from the process environment. */
export function browserSettings(values: Record<string, string>): Record<string, string> {
  const keys = ["VITE_AUTH_CLIENT_ID", "VITE_AUTH_SCOPES", "VITE_AUTH_AUTHORITY", "VITE_AUTH_KNOWN_AUTHORITIES", "VITE_AUTH_REDIRECT_URI", "VITE_AUTH_POST_LOGOUT_REDIRECT_URI", "VITE_AUTH_PROTOCOL_MODE", "VITE_AUTH_ENABLED_LOCAL", "VITE_DEV_EDGE_ORIGIN"];
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}

export interface DevConfig {
  publicOrigin: string;
  tenant: string;
  edgePort: number;
  codespaces: boolean;
  auth: Record<string, string>;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error("Edge port must be an integer between 1024 and 65535");
  }
  return Number(value);
}

/** Resolve only explicit inputs, never request Host/forwarded headers. */
export function resolveDevConfig(env: NodeJS.ProcessEnv): DevConfig {
  const codespaces = env.CODESPACES === "true";
  const edgePort = parsePort((codespaces ? env.EDGE_PORT : env.EDGE_TLS_PORT) || (codespaces ? "8080" : "8443"));
  const tenant = env.AUTH_TENANT_ID || DEFAULT_TENANT;
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(tenant)) {
    throw new Error("AUTH_TENANT_ID must be a UUID");
  }

  let origin = env.PUBLIC_ORIGIN;
  if (!origin && codespaces) {
    const name = env.CODESPACE_NAME;
    const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
    if (!name || !/^[a-z0-9-]+$/.test(name) || !domain || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(domain)) {
      throw new Error("Codespaces origin requires CODESPACE_NAME and GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN");
    }
    origin = `https://${name}-${edgePort}.${domain}`;
  }

  const publicUrl = new URL(origin || `https://localhost:${edgePort}`);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || !/^[a-z\d]+(?:[.-][a-z\d]+)*$/i.test(publicUrl.hostname) || isIP(publicUrl.hostname)) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin with a DNS hostname, no credentials, path, query, or fragment");
  }
  if (!codespaces && publicUrl.hostname === "localhost" && Number(publicUrl.port || "443") !== edgePort) {
    throw new Error("Local forwarded port must equal EDGE_TLS_PORT; use an explicit port override for parallel containers");
  }

  const publicOrigin = publicUrl.origin;
  return {
    publicOrigin, tenant, edgePort, codespaces,
    auth: {
      PUBLIC_ORIGIN: publicOrigin,
      ISSUER: `${publicOrigin}/${tenant}/v2.0`,
      VITE_AUTH_AUTHORITY: `${publicOrigin}/${tenant}/v2.0`,
      VITE_AUTH_KNOWN_AUTHORITIES: publicUrl.host,
      VITE_AUTH_REDIRECT_URI: publicOrigin,
      VITE_AUTH_POST_LOGOUT_REDIRECT_URI: publicOrigin,
      VITE_AUTH_PROTOCOL_MODE: "OIDC",
      AUTH_AUTHORITY: `${publicOrigin}/${tenant}`,
      AUTH_ISSUER_TEMPLATE: `${publicOrigin}/{tenantid}/v2.0`,
      AUTH_JWKS_URI: `https://entra-local:8443/${tenant}/discovery/v2.0/keys`,
    },
  };
}

/** Render identical route semantics for native, Compose, and Kind upstreams. */
export function renderEdgeRoutes(config: DevConfig, upstreams: { api: string; portal: string; entra: string }): string {
  for (const upstream of Object.values(upstreams)) {
    if (!/^https?:\/\/[a-z\d.-]+:\d+$/i.test(upstream)) {
      throw new Error("Upstream must be an explicit HTTP(S) hostname and port");
    }
  }

  return `map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}
server {
  listen ${config.edgePort}${config.codespaces ? "" : " ssl"};
${config.codespaces ? "" : "  ssl_certificate /certs/edge.pem;\n  ssl_certificate_key /certs/edge-key.pem;\n"}
  server_name ${new URL(config.publicOrigin).hostname};
  client_max_body_size 100m;
  proxy_http_version 1.1;
  proxy_set_header Host ${new URL(config.publicOrigin).host};
  proxy_set_header X-Forwarded-Proto https;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_buffering off;
  proxy_ssl_verify on;
  proxy_ssl_trusted_certificate /ca/rootCA.pem;
  proxy_ssl_server_name on;
  location ~ ^/(?:api(?:/|$)|openapi\\.json$|api-docs(?:/|$)|health$|ready$|about$) {
    proxy_pass ${upstreams.api};
  }
  location ~ ^/(?:${config.tenant}|common|organizations|consumers)/(?:v2\\.0/\\.well-known/openid-configuration$|discovery/v2\\.0/keys$|oauth2/v2\\.0(?:/|$)) {
    proxy_pass ${upstreams.entra};
  }
  location = /graph/oidc/userinfo {
    proxy_pass ${upstreams.entra};
  }
  location ~ ^/(?:admin(?:/|$)|graph(?:/|$)|(?:${config.tenant}|common|organizations|consumers)(?:/|$)|[^/]+/(?:v2\\.0|discovery|oauth2|openid)(?:/|$)) {
    return 404;
  }
  location / {
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_pass ${upstreams.portal};
  }
}
`;
}