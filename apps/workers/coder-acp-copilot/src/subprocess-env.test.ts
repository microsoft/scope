// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { buildSubprocessEnv, assertNoPublishChannelCollision } from "./index.js";

describe("assertNoPublishChannelCollision", () => {
  it("accepts keys published to exactly one channel", () => {
    expect(() =>
      assertNoPublishChannelCollision({ PUBLIC_URL: "http://visible" }, { SECRET_TOKEN: "ghp_x" }),
    ).not.toThrow();
  });

  it("accepts empty channels", () => {
    expect(() => assertNoPublishChannelCollision({}, {})).not.toThrow();
  });

  it("rejects a key published to both channels", () => {
    // Silently resolving this would discard the public value and withhold the key
    // from the agent entirely, while MCP interpolation quietly used the concealed
    // value — a security-sensitive ambiguity that must fail loudly.
    expect(() =>
      assertNoPublishChannelCollision(
        { API_URL: "http://public", OTHER: "x" },
        { API_URL: "http://concealed" },
      ),
    ).toThrow(/API_URL/);
  });

  it("reports every colliding key", () => {
    expect(() =>
      assertNoPublishChannelCollision(
        { B_KEY: "1", A_KEY: "2" },
        { B_KEY: "3", A_KEY: "4" },
      ),
    ).toThrow(/A_KEY, B_KEY/);
  });
});

describe("buildSubprocessEnv", () => {
  const token = "gho_test_token_1234567890";

  describe("when DevProxy is enabled", () => {
    it("sets NODE_OPTIONS with --use-env-proxy", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env.NODE_OPTIONS).toBe("--use-env-proxy");
    });

    it("appends --use-env-proxy to existing NODE_OPTIONS", () => {
      const env = buildSubprocessEnv(token, true, "--max-old-space-size=4096");
      expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096 --use-env-proxy");
    });

    it("disables TLS verification for MITM proxy", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
    });

    it("does not set proxy env vars without proxyUrl", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env).not.toHaveProperty("HTTP_PROXY");
      expect(env).not.toHaveProperty("HTTPS_PROXY");
      expect(env).not.toHaveProperty("http_proxy");
      expect(env).not.toHaveProperty("https_proxy");
    });

    it("sets proxy env vars when proxyUrl is provided", () => {
      const proxyUrl = "http://session-123@gateway:18000";
      const env = buildSubprocessEnv(token, true, undefined, undefined, proxyUrl);
      expect(env.HTTP_PROXY).toBe(proxyUrl);
      expect(env.HTTPS_PROXY).toBe(proxyUrl);
      expect(env.http_proxy).toBe(proxyUrl);
      expect(env.https_proxy).toBe(proxyUrl);
    });

    it("does not set NODE_EXTRA_CA_CERTS when no cert path is provided", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    });

    it("sets NODE_EXTRA_CA_CERTS when a CA bundle path is provided", () => {
      const env = buildSubprocessEnv(token, true, undefined, undefined, undefined, "/tmp/ca-bundle-combined.crt");
      expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/ca-bundle-combined.crt");
    });

    it("excludes GitHub auth endpoints from the proxy so auth goes direct", () => {
      const env = buildSubprocessEnv(token, true, undefined, undefined, "http://session-123@gateway:18000");
      const noProxy = env.NO_PROXY.split(",");
      expect(noProxy).toContain("github.com");
      expect(noProxy).toContain("api.github.com");
      expect(env.no_proxy).toBe(env.NO_PROXY);
    });
  });

  describe("concealed resource values", () => {
    const resourceEnv = { PUBLIC_URL: "http://visible", SECRET_URL: "http://hidden", SECRET_TOKEN: "ghp_x" };

    it("passes resource values through when nothing is concealed", () => {
      const env = buildSubprocessEnv(token, false, undefined, undefined, undefined, undefined, resourceEnv);
      expect(env.PUBLIC_URL).toBe("http://visible");
      expect(env.SECRET_URL).toBe("http://hidden");
    });

    it("omits concealed names from the agent's environment", () => {
      const env = buildSubprocessEnv(token, false, undefined, undefined, undefined, undefined, resourceEnv, [
        "SECRET_URL",
        "SECRET_TOKEN",
      ]);
      expect(env).not.toHaveProperty("SECRET_URL");
      expect(env).not.toHaveProperty("SECRET_TOKEN");
      expect(env.PUBLIC_URL).toBe("http://visible");
    });

    it("keeps the fixed keys intact while concealing", () => {
      const env = buildSubprocessEnv(token, false, undefined, undefined, undefined, undefined, resourceEnv, [
        "SECRET_URL",
      ]);
      expect(env.GITHUB_TOKEN).toBe(token);
      expect(env.COPILOT_AUTO_UPDATE).toBe("false");
    });
  });

  describe("when DevProxy is disabled", () => {
    it("clears all proxy env vars", () => {
      const env = buildSubprocessEnv(token, false);
      expect(env.HTTP_PROXY).toBe("");
      expect(env.HTTPS_PROXY).toBe("");
      expect(env.http_proxy).toBe("");
      expect(env.https_proxy).toBe("");
    });

    it("clears NODE_EXTRA_CA_CERTS to prevent stale cert warnings", () => {
      const env = buildSubprocessEnv(token, false);
      expect(env.NODE_EXTRA_CA_CERTS).toBe("");
    });

    it("does not set NODE_OPTIONS or NODE_TLS_REJECT_UNAUTHORIZED", () => {
      const env = buildSubprocessEnv(token, false);
      expect(env).not.toHaveProperty("NODE_OPTIONS");
      expect(env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
    });
  });

  it("always includes GITHUB_TOKEN", () => {
    expect(buildSubprocessEnv(token, true).GITHUB_TOKEN).toBe(token);
    expect(buildSubprocessEnv(token, false).GITHUB_TOKEN).toBe(token);
  });

  it("always disables the CLI auto-updater (issue #1179)", () => {
    expect(buildSubprocessEnv(token, true).COPILOT_AUTO_UPDATE).toBe("false");
    expect(buildSubprocessEnv(token, false).COPILOT_AUTO_UPDATE).toBe("false");
  });
});
