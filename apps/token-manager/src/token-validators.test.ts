// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach } from "vitest";
import { validateToken } from "./token-validators.js";

describe("validateToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("github-pat-classic", () => {
    it("returns valid for 200 response with scopes", async () => {
      const headers = new Headers({
        "x-oauth-scopes": "repo, read:org",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1700000000",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers,
      } as Response);

      const result = await validateToken("github-pat-classic", "ghp_test123");

      expect(result.status).toBe("valid");
      expect(result.scopes).toEqual(["repo", "read:org"]);
      expect(result.rateLimit).toBeDefined();
      expect(result.rateLimit!.limit).toBe(5000);
      expect(result.rateLimit!.remaining).toBe(4999);
      expect(result.capabilities).toBeDefined();
    });

    it("returns invalid for 401 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers(),
      } as Response);

      const result = await validateToken("github-pat-classic", "ghp_bad");

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/Authentication failed/);
    });

    it("returns error for non-401 error response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
      } as Response);

      const result = await validateToken("github-pat-classic", "ghp_test");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/500/);
    });

    it("returns error on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Network timeout")
      );

      const result = await validateToken("github-pat-classic", "ghp_test");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/Network timeout/);
    });
  });

  describe("github-pat-fine-grained", () => {
    it("returns valid for 200 response and probes Models API", async () => {
      const headers = new Headers({
        "x-oauth-scopes": "",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1700000000",
      });

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
        } as Response);

      const result = await validateToken("github-pat-fine-grained", "github_pat_test");

      expect(result.status).toBe("valid");
      expect(result.capabilities).toBeDefined();
      expect(result.capabilities).toContain("github-models");
    });
  });

  describe("anthropic-api-key", () => {
    it("returns valid for 200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const result = await validateToken("anthropic-api-key", "sk-ant-test");

      expect(result.status).toBe("valid");
    });

    it("returns invalid for 401 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      const result = await validateToken("anthropic-api-key", "sk-ant-bad");

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/Authentication failed/);
    });

    it("returns error on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Connection refused")
      );

      const result = await validateToken("anthropic-api-key", "sk-ant-test");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/Connection refused/);
    });
  });

  describe("anthropic-oauth", () => {
    it("returns valid without calling API (structural check)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await validateToken("anthropic-oauth", "oauth-token-test");

      expect(result.status).toBe("valid");
      expect(result.capabilities).toContain("claude-code-cli");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
  describe("azure-ai-foundry", () => {
    it("returns valid for successful foundry probe", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const result = await validateToken("azure-ai-foundry", JSON.stringify({
        endpoint: "https://example.services.ai.azure.com/models",
        apiKey: "foundry-key",
        model: "gpt-5.4-mini",
      }));

      expect(result.status).toBe("valid");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
        expect.anything()
      );
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(init.body as string)).toMatchObject({
        model: "gpt-5.4-mini",
        max_completion_tokens: 16,
      });
    });

    it("negotiates a compatible request shape from structured errors", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                code: "unsupported_parameter",
                param: "max_completion_tokens",
              },
            }),
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const result = await validateToken("azure-ai-foundry", JSON.stringify({
        endpoint: "https://example.services.ai.azure.com/models",
        apiKey: "foundry-key",
        model: "custom-production-deployment",
      }));

      expect(result.status).toBe("valid");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const firstInit = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(firstInit.body as string)).toEqual({
        messages: [{ role: "user", content: "ping" }],
        model: "custom-production-deployment",
        max_completion_tokens: 16,
        temperature: 0.3,
      });

      const secondInit = fetchSpy.mock.calls[1][1] as RequestInit;
      expect(JSON.parse(secondInit.body as string)).toEqual({
        messages: [{ role: "user", content: "ping" }],
        model: "custom-production-deployment",
        max_tokens: 16,
        temperature: 0.3,
      });
    });

    it("does not retry output-limit errors as compatibility failures", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message:
                "Could not finish the message because max_tokens or model output limit was reached.",
            },
          }),
          { status: 400 },
        ),
      );

      const result = await validateToken("azure-ai-foundry", JSON.stringify({
        endpoint: "https://example.services.ai.azure.com/models",
        apiKey: "foundry-key",
        model: "gpt-5.4-mini",
      }));

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/model output limit was reached/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(init.body as string)).toMatchObject({
        max_completion_tokens: 16,
      });
    });

    it("negotiates from Model Inference 422 compatibility errors", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: "parameter_not_supported",
              detail: { loc: ["body", "temperature"] },
            }),
            { status: 422 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const result = await validateToken("azure-ai-foundry", JSON.stringify({
        endpoint: "https://example.services.ai.azure.com/models",
        apiKey: "foundry-key",
        model: "custom-production-deployment",
      }));

      expect(result.status).toBe("valid");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const secondInit = fetchSpy.mock.calls[1][1] as RequestInit;
      expect(JSON.parse(secondInit.body as string)).not.toHaveProperty(
        "temperature",
      );
    });

    it("rejects non-azure endpoint without making a network call", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await validateToken("azure-ai-foundry", JSON.stringify({
        endpoint: "https://example.com/models",
        apiKey: "foundry-key",
      }));

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/services\.ai\.azure\.com/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects non-https endpoint without making a network call", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await validateToken("azure-ai-foundry", JSON.stringify({
        endpoint: "http://example.services.ai.azure.com/models",
        apiKey: "foundry-key",
      }));

      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/HTTPS/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("dispatcher", () => {
    it("calls correct validator for each type", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
      } as Response);

      await validateToken("github-pat-classic", "ghp_test");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.anything()
      );

      fetchSpy.mockClear();
      await validateToken("anthropic-api-key", "sk-ant-test");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/models",
        expect.anything()
      );

      fetchSpy.mockClear();
      // github-pat-fine-grained also hits /user first, then probes Models API
      await validateToken("github-pat-fine-grained", "github_pat_test");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.anything()
      );
    });

    it("returns error for unknown type", async () => {
      const result = await validateToken("unknown-type" as any, "value");

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/Unknown token type/);
    });
  });
});
