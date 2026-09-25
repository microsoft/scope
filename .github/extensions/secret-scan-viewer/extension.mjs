// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Extension: secret-scan-viewer
// Visualize potentially problematic commits found while scanning git history
// for secrets, keys, and credentials before open sourcing a repository.
//
// Wiring only — detection lives in ./scanner.mjs and the UI in ./dashboard.mjs.
// Each open canvas instance boots a loopback HTTP server that runs the scan in
// the background and serves a live dashboard. Raw secrets are never sent to the
// browser or persisted: the scanner masks every value at the source.

import { createServer } from "node:http";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { scanRepo } from "./scanner.mjs";
import { DASHBOARD_HTML } from "./dashboard.mjs";

/** @type {Map<string, Instance>} */
const instances = new Map();

/**
 * @typedef {Object} Instance
 * @property {import("node:http").Server|null} server
 * @property {string} url
 * @property {string} cwd
 * @property {boolean} allRefs
 * @property {boolean} scanning
 * @property {{ state: "scanning"|"done"|"error", commits: number, generation: number, error?: string }} status
 * @property {any} report
 */

let sessionRef = null;

function log(msg, opts) {
    try { sessionRef?.log?.(msg, opts); } catch { /* ignore */ }
}

/** Kick off (or restart) a scan for an instance. Ignores concurrent requests. */
function startScan(inst) {
    if (inst.scanning) return;
    inst.scanning = true;
    inst.status = { ...inst.status, state: "scanning", commits: 0, error: undefined };
    log(`secret-scan: scanning ${inst.allRefs ? "all refs" : "HEAD"} in ${inst.cwd}`, { ephemeral: true });

    scanRepo({
        cwd: inst.cwd,
        allRefs: inst.allRefs,
        onProgress: (p) => { inst.status.commits = p.commits; },
    })
        .then((report) => {
            inst.report = report;
            inst.status = {
                state: "done",
                commits: report.stats.commitsScanned,
                generation: (inst.status.generation || 0) + 1,
            };
            const s = report.stats;
            log(
                `secret-scan: done — ${s.commitsScanned} commits, ${s.realFindings} real finding(s) ` +
                `(${s.onPublishBranch} on publish branch, ${s.likelySafeFindings} likely-safe)`,
                { level: s.onPublishBranch > 0 ? "warning" : "info" },
            );
        })
        .catch((err) => {
            inst.status = { ...inst.status, state: "error", error: String(err?.message || err) };
            log(`secret-scan: failed — ${inst.status.error}`, { level: "error" });
        })
        .finally(() => { inst.scanning = false; });
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
        req.on("error", () => resolve({}));
    });
}

function handleRequest(inst, req, res) {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json") => {
        res.statusCode = code;
        res.setHeader("Content-Type", type + "; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/") {
        return send(200, DASHBOARD_HTML, "text/html");
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
        return send(200, inst.status);
    }
    if (req.method === "GET" && url.pathname === "/api/report") {
        if (inst.report && inst.status.state === "done") return send(200, inst.report);
        return send(202, { pending: true });
    }
    if (req.method === "POST" && url.pathname === "/api/rescan") {
        return readBody(req).then((body) => {
            if (typeof body.allRefs === "boolean") inst.allRefs = body.allRefs;
            startScan(inst);
            return send(200, { ok: true, allRefs: inst.allRefs });
        });
    }
    return send(404, { error: "not found" });
}

async function ensureServer(inst) {
    if (inst.server) return inst;
    const server = createServer((req, res) => {
        Promise.resolve(handleRequest(inst, req, res)).catch(() => {
            try { res.statusCode = 500; res.end('{"error":"internal"}'); } catch { /* ignore */ }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    inst.server = server;
    inst.url = `http://127.0.0.1:${port}/`;
    return inst;
}

function summarize(inst) {
    if (!inst || !inst.report) {
        return { state: inst?.status?.state || "not_open", message: "No scan report yet. Open the canvas or run rescan." };
    }
    const r = inst.report;
    const real = r.findings.filter((f) => !f.likelySafe);
    return {
        repo: r.repo,
        scope: r.allRefs ? "all refs" : r.publishRef,
        publishRef: r.publishRef,
        commitsScanned: r.stats.commitsScanned,
        realFindings: r.stats.realFindings,
        onPublishBranch: r.stats.onPublishBranch,
        likelySafeFindings: r.stats.likelySafeFindings,
        bySeverity: r.stats.bySeverity,
        byRule: r.stats.byRule,
        topFindings: real.slice(0, 25).map((f) => ({
            severity: f.severity,
            rule: f.ruleName,
            file: f.file,
            line: f.line,
            commit: f.commit.slice(0, 10),
            date: (f.date || "").slice(0, 10),
            author: f.author,
            onPublishBranch: f.onPublishBranch,
            preview: f.preview,
        })),
    };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "secret-scan-viewer",
            displayName: "Secret Scan Viewer",
            description:
                "Interactive dashboard of potential secrets/keys/credentials found across the full git history, with severity, file/commit provenance, and publish-branch reachability.",
            inputSchema: {
                type: "object",
                properties: {
                    allRefs: {
                        type: "boolean",
                        description: "Scan every ref (all branches/tags). When false, scan only HEAD history. Default true.",
                    },
                },
            },
            actions: [
                {
                    name: "rescan",
                    description: "Re-run the git-history secret scan for this canvas instance.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            allRefs: { type: "boolean", description: "Scan all refs (true) or only HEAD (false)." },
                        },
                    },
                    handler: (ctx) => {
                        const inst = instances.get(ctx.instanceId);
                        if (!inst) return { ok: false, error: "canvas instance not open" };
                        if (typeof ctx.input?.allRefs === "boolean") inst.allRefs = ctx.input.allRefs;
                        startScan(inst);
                        return { ok: true, state: "scanning", allRefs: inst.allRefs };
                    },
                },
                {
                    name: "get_summary",
                    description: "Return the current scan summary and top real findings (masked) as structured data for the agent.",
                    handler: (ctx) => summarize(instances.get(ctx.instanceId)),
                },
            ],
            open: async (ctx) => {
                let inst = instances.get(ctx.instanceId);
                if (!inst) {
                    inst = {
                        server: null,
                        url: "",
                        cwd: ctx.session?.workingDirectory || process.cwd(),
                        allRefs: ctx.input?.allRefs !== false,
                        scanning: false,
                        status: { state: "scanning", commits: 0, generation: 0 },
                        report: null,
                    };
                    instances.set(ctx.instanceId, inst);
                    await ensureServer(inst);
                    startScan(inst);
                } else if (typeof ctx.input?.allRefs === "boolean" && ctx.input.allRefs !== inst.allRefs) {
                    inst.allRefs = ctx.input.allRefs;
                    startScan(inst);
                }
                return {
                    title: "Secret Scan",
                    url: inst.url,
                    status: inst.status.state === "done"
                        ? `${inst.report?.stats.realFindings ?? 0} findings`
                        : "scanning…",
                };
            },
            onClose: async (ctx) => {
                const inst = instances.get(ctx.instanceId);
                if (!inst) return;
                instances.delete(ctx.instanceId);
                if (inst.server) await new Promise((resolve) => inst.server.close(() => resolve()));
            },
        }),
    ],
});

sessionRef = session;
