import { describe, expect, it } from "vitest";
import { DEFAULT_TENANT, renderEdgeRoutes, resolveDevConfig } from "./config.js";

describe("development origin contract", () => {
  it("resolves local TLS and preserves the external port in known authorities", () => {
    const config = resolveDevConfig({});
    expect(config.publicOrigin).toBe("https://localhost:8443");
    expect(config.auth.VITE_AUTH_KNOWN_AUTHORITIES).toBe("localhost:8443");
    expect(config.auth.AUTH_JWKS_URI).toBe(`https://entra-local:8443/${DEFAULT_TENANT}/discovery/v2.0/keys`);
    expect(config.auth.AUTH_ISSUER_TEMPLATE).toBe("https://localhost:8443/{tenantid}/v2.0");
  });

  it("computes the current Codespaces URL without a baked-in name", () => {
    const config = resolveDevConfig({ CODESPACES: "true", CODESPACE_NAME: "example-123", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev" });
    expect(config.publicOrigin).toBe("https://example-123-8080.app.github.dev");
    expect(config.edgePort).toBe(8080);
    expect(config.auth.ISSUER).toBe(`${config.publicOrigin}/${DEFAULT_TENANT}/v2.0`);
  });

  it("accepts an explicit remote origin and local parallel-container port", () => {
    expect(resolveDevConfig({ PUBLIC_ORIGIN: "https://dev.example.org" }).publicOrigin).toBe("https://dev.example.org");
    expect(resolveDevConfig({ EDGE_TLS_PORT: "9443" }).publicOrigin).toBe("https://localhost:9443");
  });

  it.each(["http://localhost:8443", "https://user:password@localhost:8443", "https://localhost:8443/path", "https://localhost:8443?query", "https://localhost:8443#fragment", "https://127.0.0.1:8443", "https://localhost:9443", "https://bad;name.example"]) ("rejects unsafe or mismatched origin %s", (origin) => {
    expect(() => resolveDevConfig({ PUBLIC_ORIGIN: origin })).toThrow();
  });

  it.each(["0", "443", "65536", "8080junk", "8e3"]) ("rejects invalid edge port %s", (port) => {
    expect(() => resolveDevConfig({ EDGE_TLS_PORT: port })).toThrow();
  });

  it("fails on missing Codespaces inputs and unsafe tenant interpolation", () => {
    expect(() => resolveDevConfig({ CODESPACES: "true" })).toThrow(/Codespaces/);
    expect(() => resolveDevConfig({ AUTH_TENANT_ID: "../admin" })).toThrow(/UUID/);
  });
});

describe("dev-edge routing", () => {
  const config = resolveDevConfig({});
  const routes = renderEdgeRoutes(config, { api: "http://api:3000", portal: "http://portal:5100", entra: "https://entra-local:8443" });
  const expressions = [...routes.matchAll(/location ~ (.+) \{/g)].map((match) => new RegExp(match[1]));
  function destination(path: string): string {
    if (path === "/graph/oidc/userinfo") return "auth";
    const index = expressions.findIndex((expression) => expression.test(path));
    return ["api", "auth", "denied"][index] || "portal";
  }

  it.each(["/api/v1/users/me", "/api", "/openapi.json", "/api-docs", "/api-docs/", "/health", "/ready", "/about"]) ("routes API path %s before the SPA", (path) => {
    expect(destination(path)).toBe("api");
  });

  it.each([`/${DEFAULT_TENANT}/v2.0/.well-known/openid-configuration`, `/${DEFAULT_TENANT}/discovery/v2.0/keys`, `/${DEFAULT_TENANT}/oauth2/v2.0/authorize`, `/${DEFAULT_TENANT}/oauth2/v2.0/token`, "/graph/oidc/userinfo", "/common/oauth2/v2.0/authorize"]) ("preserves tenant-root auth path %s", (path) => {
    expect(destination(path)).toBe("auth");
  });

  it.each(["/admin", "/admin/api/apps", "/graph/unknown", `/${DEFAULT_TENANT}/unknown`, "/common/unknown", "/wrong-tenant/oauth2/v2.0/token"]) ("denies private/unknown auth path %s", (path) => {
    expect(destination(path)).toBe("denied");
  });

  it.each(["/runs/example", "/apiary", "/healthier", "/about-us"]) ("preserves Portal route %s", (path) => {
    expect(destination(path)).toBe("portal");
  });

  it("enables streaming, upgrades and verified internal TLS", () => {
    expect(routes).toContain("listen 8443 ssl;");
    expect(routes).toContain("proxy_buffering off;");
    expect(routes).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(routes).toContain("proxy_ssl_verify on;");
    expect(routes).not.toContain("/auth/");
  });

  it("never redeclares proxy headers inside a location, so the public Host is always forwarded", () => {
    const locations = routes.split(/\n\s*location /).slice(1);
    expect(locations.length).toBeGreaterThan(0);
    for (const location of locations) expect(location).not.toContain("proxy_set_header");
    expect(routes).toContain("proxy_set_header Host localhost:8443;");
  });

  it("uses HTTP only behind Codespaces external HTTPS termination", () => {
    const remote = resolveDevConfig({ CODESPACES: "true", PUBLIC_ORIGIN: "https://example.app.github.dev" });
    const routes = renderEdgeRoutes(remote, { api: "http://api:3000", portal: "http://portal:5100", entra: "https://entra-local:8443" });
    expect(routes).toContain("listen 8080;");
    expect(routes).not.toContain("ssl_certificate ");
  });
});