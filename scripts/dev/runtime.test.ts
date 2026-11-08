import { describe, expect, it } from "vitest";
import { browserSettings, resolveRuntimeEnv } from "./config.js";
import { runtimes, runtimeByName } from "./inventory.js";
import {
  buildDiskSpaceWarning,
  codespacesForwardingTip,
  consumerEnvironment,
  launchCommand,
  startupState,
} from "./control.js";
import { renderNativeWorkers } from "./workers.js";
import { spawn } from "node:child_process";

describe("native container worker routing", () => {
  it("preserves worker sidecars and removes duplicate backing services", () => {
    const model = { services: {
      "coder-acp-copilot": { depends_on: { api: {}, redis: {}, gateway: {}, "mcp-gateway-copilot": {} }, environment: { PROXY_BACKEND: "gateway" }, profiles: ["copilot"] },
      gateway: { depends_on: { redis: {} } },
      "mcp-gateway-copilot": {},
      api: {}, redis: {},
    } };
    const rendered = renderNativeWorkers(model, ["coder-acp-copilot"], {}, "scope-dev-test");
    expect(Object.keys(rendered.services).sort()).toEqual(["coder-acp-copilot", "gateway", "mcp-gateway-copilot"]);
    expect(rendered.services["coder-acp-copilot"].environment).toMatchObject({ PROXY_BACKEND: "gateway", API_ENDPOINT: "http://host.docker.internal:3100", JUDGE_SERVICE_URL: "http://host.docker.internal:3101", REDIS_HOST: "redis" });
    expect(rendered.services["coder-acp-copilot"].ports).toEqual(["127.0.0.1:9240:9229"]);
    expect(rendered.networks).toEqual({ default: { external: true, name: "scope-dev-test_default" } });
    expect(() => renderNativeWorkers(model, ["api"], {}, "test")).toThrow(/not a worker/);
  });
});

describe("lifecycle transitions", () => {
  it("switches modes only after shutdown and discards old process ownership", () => {
    const previous = { mode: "native" as const, active: true, restore: false, services: ["api"], processes: { api: { pid: 123, identity: "456" } } };
    expect(() => startupState(previous, "kind", undefined, false)).toThrow(/dev:down/);
    expect(startupState({ ...previous, active: false }, "kind", undefined, true)).toMatchObject({ mode: "kind", phase: "starting", restore: true, processes: {} });
  });
  it("restores the selected services and rejects unknown services before bootstrap", () => {
    const previous = startupState(undefined, "native", ["api"], true);
    expect(startupState(previous, "native", undefined, true).services).toEqual(["api"]);
    expect(startupState(previous, "native", ["portal"], false).services).toEqual(["portal"]);
    expect(() => startupState(previous, "native", ["not-a-service"], false)).toThrow(/Unknown runtime/);
  });
});

describe("startup guidance", () => {
  it("warns before builds only when available disk space is below 10 GiB", () => {
    expect(buildDiskSpaceWarning(10 * 2 ** 30)).toBeUndefined();
    expect(buildDiskSpaceWarning(10 * 2 ** 30 - 1)).toMatch(/10 GiB/);
  });

  it("shows the port-forwarding tip only in Codespaces", () => {
    expect(codespacesForwardingTip({ CODESPACES: "true" }, 8080))
      .toContain("forward port 8080");
    expect(codespacesForwardingTip({}, 8080)).toBeUndefined();
  });
});

describe("shared runtime configuration", () => {
  it("uses worktree < local < process precedence without modifying inputs", () => {
    const generated = { PUBLIC_ORIGIN: "https://generated.example.org", MONGODB_PORT: "27001" };
    const local = { PUBLIC_ORIGIN: "https://local.example.org" };
    const process = { PUBLIC_ORIGIN: "https://process.example.org" };
    const values = resolveRuntimeEnv({ generated, local, process }, "native");
    expect(values.PUBLIC_ORIGIN).toBe(process.PUBLIC_ORIGIN);
    expect(values.MONGO_CONNECTION_STRING).toContain("127.0.0.1:27001");
    expect(values.MONGO_CONNECTION_STRING).toContain("directConnection=true");
    expect(local).toEqual({ PUBLIC_ORIGIN: "https://local.example.org" });
  });
  it.each(["compose", "kind"] as const)("keeps %s private DNS separate from the public issuer", (target) => {
    const values = resolveRuntimeEnv({ process: { PUBLIC_ORIGIN: "https://dev.example.org" } }, target);
    expect(values.MONGO_CONNECTION_STRING).toBe("mongodb://mongodb:27017/?replicaSet=rs0");
    expect(values.AUTH_JWKS_URI).toContain("https://entra-local:8443/");
    expect(values.AUTH_ISSUER_TEMPLATE).toBe("https://dev.example.org/{tenantid}/v2.0");
    expect(values.STORAGE_CONNECTION_STRING).toContain("http://azurite:10002/");
  });
  it("never forwards arbitrary Vite settings or credentials to the browser", () => {
    const settings = browserSettings({ ...resolveRuntimeEnv({}, "native"), GITHUB_TOKEN: "secret", VITE_PROVIDER_KEY: "secret", NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    expect(JSON.stringify(settings)).not.toContain("secret");
    expect(settings.VITE_AUTH_ENABLED_LOCAL).toBe("true");
    expect(settings).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
  });
});

describe("runtime inventory", () => {
  it("pauses a real short-lived CLI process before allowing it to finish", async () => {
    const entry = runtimeByName("cli");
    const [executable, ...args] = launchCommand(entry, true).map((argument) => argument.replace("--inspect-brk=127.0.0.1:9260", "--inspect-brk=127.0.0.1:0"));
    const child = spawn(executable, args, { env: { ...consumerEnvironment(entry, { process: process.env }, resolveRuntimeEnv({}, "native")), CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    let socket: WebSocket | undefined;
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exited = new Promise<number | null>((resolvePromise, reject) => { child.once("exit", resolvePromise); child.once("error", reject); });
    try {
      const inspector = await new Promise<string>((resolvePromise, reject) => {
        let errorOutput = "";
        child.stderr.on("data", (chunk: Buffer) => {
          errorOutput += chunk.toString();
          const match = errorOutput.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f\d-]+/);
          if (match) resolvePromise(match[0]);
        });
        child.once("exit", () => reject(new Error("CLI exited before opening its inspector")));
        child.once("error", reject);
      });
      socket = new WebSocket(inspector);
      await new Promise<void>((resolvePromise, reject) => { socket!.addEventListener("open", () => resolvePromise(), { once: true }); socket!.addEventListener("error", () => reject(new Error("Inspector connection failed")), { once: true }); });
      const paused = new Promise<string>((resolvePromise) => {
        socket!.addEventListener("message", (event) => {
          const message: { method?: string; params?: { reason?: string } } = JSON.parse(String(event.data));
          if (message.method === "Debugger.paused") resolvePromise(message.params?.reason || "");
        });
      });
      socket.send(JSON.stringify({ id: 1, method: "Debugger.enable" }));
      socket.send(JSON.stringify({ id: 2, method: "Runtime.runIfWaitingForDebugger" }));
      expect(await paused).toBe("Break on start");
      socket.send(JSON.stringify({ id: 3, method: "Debugger.resume" }));
      socket.close();
      expect(await exited).toBe(0);
      expect(output).toContain("Usage:");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
    }
  }, 20_000);
  it("isolates consumer secrets and enables per-process break-on-start", () => {
    const inputs = { process: { PATH: "/bin", GITHUB_TOKEN: "copilot-secret", ANTHROPIC_API_KEY: "anthropic-secret", NODE_OPTIONS: "--inspect=0.0.0.0:9229" } };
    const values = resolveRuntimeEnv({}, "native");
    const portal = consumerEnvironment(runtimeByName("portal"), inputs, values);
    expect(portal).not.toHaveProperty("GITHUB_TOKEN");
    expect(portal).not.toHaveProperty("STORAGE_CONNECTION_STRING");
    expect(portal).not.toHaveProperty("NODE_OPTIONS");
    expect(consumerEnvironment(runtimeByName("coder-acp-copilot"), inputs, values).GITHUB_TOKEN).toBe("copilot-secret");
    expect(launchCommand(runtimeByName("cli"), true, ["--help"])).toContain("--inspect-brk=127.0.0.1:9260");
  });
  it("breaks before short-lived tool entrypoints without global inspector flags", () => {
    expect(launchCommand(runtimeByName("tests"), true)).toContain("--inspect-brk=127.0.0.1:9262");
    expect(launchCommand(runtimeByName("db-migrations"), true).at(-1)).toBe("up");
    expect(launchCommand(runtimeByName("cli"), true).at(-1)).toBe("--help");
    expect(launchCommand(runtimeByName("db-migrations"), true, ["status"]).at(-1)).toBe("status");
  });
  it("allocates unique runtime identities and inspector ports", () => {
    expect(new Set(runtimes.map((runtime) => runtime.name)).size).toBe(runtimes.length);
    const ports = runtimes.flatMap((runtime) => runtime.inspector ? [runtime.inspector] : []);
    expect(new Set(ports).size).toBe(ports.length);
    expect(runtimeByName("post-processor").kind).toBe("worker");
    expect(() => runtimeByName("nonexistent")).toThrow(/Unknown runtime/);
  });
});