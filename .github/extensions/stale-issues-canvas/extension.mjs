// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Extension: stale-issues-canvas
// Visualize stale / likely-irrelevant open issues and close them with an
// explanatory comment. Each open canvas instance boots a local HTTP server that
// serves an interactive UI (ui.html) plus a small JSON API:
//   GET  /              -> the UI
//   GET  /api/issues    -> { repo, issues[] } (with live closed state)
//   POST /api/close     -> closes one issue via `gh issue close`
// The agent can also close issues programmatically via the canvas actions below.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_HTML = readFileSync(join(__dirname, "ui.html"), "utf8");

// The issue dataset is runtime/generated data, not source. It is loaded from
// the session workspace's files/ dir after joinSession() resolves (see bottom
// of this file), so it lives alongside the triage source (stale_issues.csv,
// *_issues.json) instead of being committed to (or gitignored inside) the repo.
let ISSUES = [];
function loadIssues(file) {
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

// Live close-state for issues WE closed this session, keyed by issue number.
const closedState = new Set();

// Live remote state pulled from GitHub: number -> { state, closedBy: number[] }.
//   state    = OPEN | CLOSED (so issues closed outside this canvas show correctly)
//   closedBy = PRs formally linked via the "Development" section.
// GitHub has no public API to CREATE that formal link for an already-merged PR,
// so we only READ it here — the close comment references the solving PR with
// `#NN`, which creates a bidirectional cross-reference link instead.
const remote = new Map();
let remotePromise = null;

// "Set aside" — issues the user reviewed and decided should NOT be closed.
// This is a triage decision with no GitHub equivalent, so we persist it in the
// session workspace's files/ dir (resolved after joinSession, see bottom of this
// file) to survive extension reloads. The value below is only the fallback path
// used when infinite sessions are disabled and no workspace dir is available.
let ASIDE_FILE = join(__dirname, "aside-state.json");
const asideState = new Set();
function loadAside() {
    try {
        const raw = JSON.parse(readFileSync(ASIDE_FILE, "utf8"));
        return Array.isArray(raw) ? raw : Array.isArray(raw?.numbers) ? raw.numbers : [];
    } catch {
        return [];
    }
}
function saveAside() {
    try {
        writeFileSync(ASIDE_FILE, JSON.stringify([...asideState]), "utf8");
    } catch (e) {
        try { session.log(`aside save failed: ${e}`); } catch { /* ignore */ }
    }
}
function setAside(number, aside) {
    const n = parseInt(number, 10);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Invalid issue number" };
    if (aside === false) asideState.delete(n);
    else asideState.add(n);
    saveAside();
    return { ok: true, number: n, aside: asideState.has(n) };
}

// --- repo resolution -------------------------------------------------------
function detectRepoRoot() {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: __dirname, encoding: "utf8",
        }).trim();
    } catch {
        return process.cwd();
    }
}
function detectRepoSlug(cwd) {
    try {
        const url = execFileSync("git", ["remote", "get-url", "origin"], {
            cwd, encoding: "utf8",
        }).trim();
        const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
        if (m) return m[1];
    } catch { /* ignore */ }
    return "growth-ecosystems/scope-core";
}
const REPO_ROOT = detectRepoRoot();
const REPO_SLUG = detectRepoSlug(REPO_ROOT);

// --- gh close --------------------------------------------------------------
function closeIssue({ number, comment, reason }) {
    return new Promise((resolve) => {
        const n = parseInt(number, 10);
        if (!Number.isInteger(n) || n <= 0) {
            resolve({ ok: false, error: "Invalid issue number" });
            return;
        }
        const args = ["issue", "close", String(n), "--repo", REPO_SLUG];
        if (comment && String(comment).trim()) args.push("--comment", String(comment));
        const validReasons = ["completed", "not planned", "duplicate"];
        if (reason && validReasons.includes(reason)) args.push("--reason", reason);
        execFile("gh", args, { cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    resolve({ ok: false, error: (stderr || err.message || "gh failed").trim() });
                } else {
                    closedState.add(n);
                    resolve({ ok: true, output: (stdout || stderr || "Closed").trim() });
                }
            });
    });
}

function issuesPayload() {
    return {
        repo: REPO_SLUG,
        issues: ISSUES.map((i) => {
            const r = remote.get(i.number) || {};
            const closedBy = r.closedBy || [];
            return {
                ...i,
                closed: closedState.has(i.number) || r.state === "CLOSED",
                remoteClosed: r.state === "CLOSED",
                aside: asideState.has(i.number),
                linkedPrs: closedBy,
                linked: closedBy.length > 0,
            };
        }),
    };
}

// Read live state (OPEN/CLOSED) + formal link status for every issue in one
// aliased GraphQL call. Cached for the extension's lifetime; pass force to refetch.
function ghGraphql(query) {
    return new Promise((resolve) => {
        execFile("gh", ["api", "graphql", "-f", `query=${query}`],
            { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) { resolve({ error: (stderr || err.message).trim() }); return; }
                try { resolve(JSON.parse(stdout)); }
                catch (e) { resolve({ error: String(e) }); }
            });
    });
}
async function fetchRemote() {
    const [owner, name] = REPO_SLUG.split("/");
    let q = `query{repository(owner:"${owner}",name:"${name}"){`;
    for (const i of ISSUES) {
        q += ` i${i.number}:issue(number:${i.number}){number state closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number}}}`;
    }
    q += "}}";
    const res = await ghGraphql(q);
    if (res && res.data && res.data.repository) {
        const r = res.data.repository;
        for (const k of Object.keys(r)) {
            const i = r[k];
            if (!i) continue;
            remote.set(i.number, {
                state: i.state,
                closedBy: i.closedByPullRequestsReferences.nodes.map((x) => x.number),
            });
        }
        session.log(`Remote status loaded for ${ISSUES.length} issues`);
    } else {
        session.log(`Remote status fetch failed: ${res && res.error}`);
    }
}
function ensureRemote(force) {
    if (force) remotePromise = null;
    if (!remotePromise) {
        remotePromise = fetchRemote().catch((e) => session.log(`remote err ${e}`));
    }
    return remotePromise;
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on("end", () => resolve(data));
        req.on("error", () => resolve(""));
    });
}

// --- one HTTP server per canvas instance -----------------------------------
const servers = new Map();

async function startServer() {
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const json = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(obj));
        };
        try {
            if (req.method === "GET" && url.pathname === "/") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(UI_HTML);
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/issues") {
                await ensureRemote(url.searchParams.get("refresh") === "1");
                json(200, issuesPayload());
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/close") {
                const body = await readBody(req);
                let parsed;
                try { parsed = JSON.parse(body || "{}"); }
                catch { json(400, { ok: false, error: "Bad JSON" }); return; }
                session.log(`Closing issue #${parsed.number} (reason: ${parsed.reason})`);
                const result = await closeIssue(parsed);
                session.log(`Close #${parsed.number}: ${result.ok ? "ok" : "FAILED " + result.error}`);
                json(result.ok ? 200 : 500, result);
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/aside") {
                const body = await readBody(req);
                let parsed;
                try { parsed = JSON.parse(body || "{}"); }
                catch { json(400, { ok: false, error: "Bad JSON" }); return; }
                const result = setAside(parsed.number, parsed.aside !== false);
                session.log(`Set-aside #${parsed.number} = ${result.aside}`);
                json(result.ok ? 200 : 400, result);
                return;
            }
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
        } catch (e) {
            json(500, { ok: false, error: String(e) });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "stale-issues-canvas",
            displayName: "Stale Issue Triage",
            description:
                "Visualize likely-stale open issues (implemented / superseded / partial) " +
                "and close them with an explanatory comment.",
            actions: [
                {
                    name: "close_issue",
                    description:
                        "Close a single GitHub issue with an explanatory comment. " +
                        "If comment/reason are omitted, the suggested defaults for that issue are used.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            number: { type: "number", description: "Issue number to close" },
                            comment: { type: "string", description: "Closing comment (Markdown)" },
                            reason: {
                                type: "string",
                                enum: ["completed", "not planned", "duplicate"],
                                description: "Close reason",
                            },
                        },
                        required: ["number"],
                    },
                    handler: async (ctx) => {
                        const input = ctx.input || {};
                        const known = ISSUES.find((i) => i.number === Number(input.number));
                        const result = await closeIssue({
                            number: input.number,
                            comment: input.comment ?? known?.closeComment,
                            reason: input.reason ?? known?.closeReason,
                        });
                        session.log(`Action close_issue #${input.number}: ${result.ok ? "ok" : result.error}`);
                        return result;
                    },
                },
                {
                    name: "close_issues",
                    description:
                        "Close several issues at once. Provide an array of issue numbers; " +
                        "each uses its suggested comment/reason unless overrides are given.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            numbers: {
                                type: "array",
                                items: { type: "number" },
                                description: "Issue numbers to close",
                            },
                            reason: {
                                type: "string",
                                enum: ["completed", "not planned", "duplicate"],
                            },
                        },
                        required: ["numbers"],
                    },
                    handler: async (ctx) => {
                        const nums = (ctx.input && ctx.input.numbers) || [];
                        const results = [];
                        for (const number of nums) {
                            const known = ISSUES.find((i) => i.number === Number(number));
                            results.push({
                                number,
                                ...(await closeIssue({
                                    number,
                                    comment: known?.closeComment,
                                    reason: ctx.input.reason ?? known?.closeReason,
                                })),
                            });
                        }
                        const okc = results.filter((r) => r.ok).length;
                        session.log(`Action close_issues: ${okc}/${nums.length} closed`);
                        return { closed: okc, total: nums.length, results };
                    },
                },
                {
                    name: "set_aside_issue",
                    description:
                        "Set aside an issue that should NOT be closed, so it's moved out of the " +
                        "active triage list without touching GitHub. Pass aside:false to restore it " +
                        "to the active list. This decision is persisted locally across reloads.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            number: { type: "number", description: "Issue number to set aside (or restore)" },
                            aside: {
                                type: "boolean",
                                description: "true (default) to set aside; false to restore to the active list",
                            },
                        },
                        required: ["number"],
                    },
                    handler: async (ctx) => {
                        const input = ctx.input || {};
                        const result = setAside(input.number, input.aside !== false);
                        session.log(`Action set_aside_issue #${input.number} = ${result.aside}`);
                        return result;
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                    session.log(`Canvas opened at ${entry.url} (repo ${REPO_SLUG}, ${ISSUES.length} issues)`);
                }
                return { title: "Stale Issue Triage", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

// Now that the session exists, resolve where runtime data lives and load it.
// Prefer the session workspace's files/ dir (~/.copilot/session-state/<id>/files)
// so the dataset and set-aside state sit next to the triage source and never
// touch the repo. Fall back to the extension dir when infinite sessions are
// disabled (workspacePath is undefined then).
const DATA_DIR = session.workspacePath
    ? join(session.workspacePath, "files")
    : __dirname;
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
ASIDE_FILE = join(DATA_DIR, "aside-state.json");
ISSUES = loadIssues(join(DATA_DIR, "data.json"));
for (const n of loadAside()) asideState.add(n);
if (ISSUES.length === 0) {
    session.log(
        `No data.json in ${DATA_DIR}; the canvas will show no issues until the ` +
        `triage dataset is generated there.`,
    );
}
session.log(`Data dir ${DATA_DIR}: ${ISSUES.length} issues, ${asideState.size} set aside`);
