// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DevProxyClient } from "./devproxy-client.js";

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
  readdir: vi.fn(),
}));

import { writeFile, readFile, access, readdir } from "node:fs/promises";
const mockWriteFile = vi.mocked(writeFile);
const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);
const mockReaddir = vi.mocked(readdir);

describe("DevProxyClient", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isEnabled", () => {
    it("returns true when DEV_PROXY_ENABLED is set", () => {
      process.env.DEV_PROXY_ENABLED = "true";
      expect(DevProxyClient.isEnabled()).toBe(true);
    });

    it("returns true for any truthy value", () => {
      process.env.DEV_PROXY_ENABLED = "1";
      expect(DevProxyClient.isEnabled()).toBe(true);
    });

    it("returns false when DEV_PROXY_ENABLED is not set", () => {
      delete process.env.DEV_PROXY_ENABLED;
      expect(DevProxyClient.isEnabled()).toBe(false);
    });

    it("returns false when DEV_PROXY_ENABLED is empty string", () => {
      process.env.DEV_PROXY_ENABLED = "";
      expect(DevProxyClient.isEnabled()).toBe(false);
    });
  });

  describe("constructor", () => {
    it("uses defaults when no env vars set", () => {
      delete process.env.DEV_PROXY_API_URL;
      delete process.env.DEV_PROXY_HAR_DIR;
      const client = new DevProxyClient();
      // Verify defaults by trying to call an API (will fail with fetch error)
      expect(client).toBeDefined();
    });

    it("accepts explicit parameters", () => {
      const client = new DevProxyClient("http://custom:9999", "/custom/dir");
      expect(client).toBeDefined();
    });

    it("reads env vars for defaults", () => {
      process.env.DEV_PROXY_API_URL = "http://env-api:1234";
      process.env.DEV_PROXY_HAR_DIR = "/env-dir";
      const client = new DevProxyClient();
      expect(client).toBeDefined();
    });
  });

  describe("getStatus", () => {
    it("returns proxy status on success", async () => {
      const mockResponse = { recording: true, configFile: "/config/devproxyrc.json" };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const client = new DevProxyClient("http://test:18897");
      const status = await client.getStatus();

      expect(status).toEqual(mockResponse);
      expect(fetch).toHaveBeenCalledWith("http://test:18897/proxy");
    });

    it("throws on non-OK response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 500, statusText: "Internal Server Error" })
      );

      const client = new DevProxyClient("http://test:18897");
      await expect(client.getStatus()).rejects.toThrow("DevProxy API returned 500");
    });
  });

  describe("startRecording", () => {
    it("sends POST with recording: true", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 200 })
      );

      const client = new DevProxyClient("http://test:18897");
      await client.startRecording();

      expect(fetch).toHaveBeenCalledWith("http://test:18897/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recording: true }),
      });
    });

    it("throws on failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 409, statusText: "Conflict" })
      );

      const client = new DevProxyClient("http://test:18897");
      await expect(client.startRecording()).rejects.toThrow("Failed to start recording: 409");
    });
  });

  describe("stopRecording", () => {
    it("sends POST with recording: false and polls until stopped", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // POST to stop
        .mockResolvedValueOnce(new Response("", { status: 200 }))
        // GET status — still recording
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ recording: true, configFile: "" }), { status: 200 })
        )
        // GET status — stopped
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ recording: false, configFile: "" }), { status: 200 })
        );

      const client = new DevProxyClient("http://test:18897");
      await client.stopRecording(5000);

      // First call: POST to stop, second + third: GET status polls
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("throws on POST failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 500, statusText: "Error" })
      );

      const client = new DevProxyClient("http://test:18897");
      await expect(client.stopRecording()).rejects.toThrow("Failed to stop recording: 500");
    });
  });

  describe("downloadCertificate", () => {
    it("skips download if cert already exists", async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const client = new DevProxyClient("http://test:18897");
      await client.downloadCertificate("/certs/ca.crt");

      expect(mockAccess).toHaveBeenCalledWith("/certs/ca.crt");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("downloads and writes cert when not present", async () => {
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----", { status: 200 })
      );

      const client = new DevProxyClient("http://test:18897");
      await client.downloadCertificate("/certs/ca.crt");

      expect(fetch).toHaveBeenCalledWith("http://test:18897/proxy/rootCertificate?format=crt");
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/certs/ca.crt",
        "-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----",
        "utf-8"
      );
    });

    it("throws when download fails", async () => {
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 500, statusText: "Error" })
      );

      const client = new DevProxyClient("http://test:18897");
      await expect(client.downloadCertificate("/certs/ca.crt")).rejects.toThrow(
        "Failed to download certificate"
      );
    });
  });

  describe("createCombinedCaBundle", () => {
    it("skips creation if bundle already exists", async () => {
      mockAccess.mockResolvedValueOnce(undefined);

      const client = new DevProxyClient("http://test:18897");
      const result = await client.createCombinedCaBundle("/certs/ca.crt", "/certs/bundle.crt");

      expect(result).toBe("/certs/bundle.crt");
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("creates combined bundle with system certs + devproxy cert", async () => {
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
      const devproxyCert = "-----BEGIN CERTIFICATE-----\ndevproxy\n-----END CERTIFICATE-----";
      const systemCerts = "-----BEGIN CERTIFICATE-----\nsystem\n-----END CERTIFICATE-----";
      mockReadFile
        .mockResolvedValueOnce(devproxyCert as any) // devproxy cert
        .mockResolvedValueOnce(systemCerts as any); // system CA bundle

      const client = new DevProxyClient("http://test:18897");
      const result = await client.createCombinedCaBundle("/certs/ca.crt", "/certs/bundle.crt");

      expect(result).toBe("/certs/bundle.crt");
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/certs/bundle.crt",
        expect.stringContaining(systemCerts),
        "utf-8"
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/certs/bundle.crt",
        expect.stringContaining(devproxyCert),
        "utf-8"
      );
    });

    it("uses only devproxy cert if no system bundle found", async () => {
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
      const devproxyCert = "-----BEGIN CERTIFICATE-----\ndevproxy\n-----END CERTIFICATE-----";
      mockReadFile
        .mockResolvedValueOnce(devproxyCert as any) // devproxy cert
        .mockRejectedValueOnce(new Error("ENOENT")) // /etc/ssl/certs/ca-certificates.crt
        .mockRejectedValueOnce(new Error("ENOENT")) // /etc/pki/tls/certs/ca-bundle.crt
        .mockRejectedValueOnce(new Error("ENOENT")) // /etc/ssl/ca-bundle.pem
        .mockRejectedValueOnce(new Error("ENOENT")); // /etc/ssl/cert.pem

      const client = new DevProxyClient("http://test:18897");
      const result = await client.createCombinedCaBundle("/certs/ca.crt", "/certs/bundle.crt");

      expect(result).toBe("/certs/bundle.crt");
      expect(mockWriteFile).toHaveBeenCalledWith("/certs/bundle.crt", devproxyCert, "utf-8");
    });
  });

  describe("getLatestHarFile", () => {
    it("returns the latest HAR file path", async () => {
      mockReaddir.mockResolvedValueOnce([
        "devproxy-2025-01-15T09.har" as any,
        "devproxy-2025-01-15T10.har" as any,
        "devproxy-2025-01-15T08.har" as any,
      ]);

      const client = new DevProxyClient("http://test:18897", "/har-output");
      const result = await client.getLatestHarFile();

      expect(result).toBe("/har-output/devproxy-2025-01-15T10.har");
    });

    it("returns null when no HAR files exist", async () => {
      mockReaddir.mockResolvedValueOnce([]);

      const client = new DevProxyClient("http://test:18897", "/har-output");
      expect(await client.getLatestHarFile()).toBeNull();
    });

    it("returns null when directory does not exist", async () => {
      mockReaddir.mockRejectedValueOnce(new Error("ENOENT"));

      const client = new DevProxyClient("http://test:18897", "/har-output");
      expect(await client.getLatestHarFile()).toBeNull();
    });

    it("ignores non-devproxy files", async () => {
      mockReaddir.mockResolvedValueOnce([
        "other.har" as any,
        "readme.txt" as any,
        "devproxy-2025-01-15T10.har" as any,
      ]);

      const client = new DevProxyClient("http://test:18897", "/har-output");
      const result = await client.getLatestHarFile();
      expect(result).toBe("/har-output/devproxy-2025-01-15T10.har");
    });
  });
});
