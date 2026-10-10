// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// scanner.mjs — Git history secret scanner.
//
// Streams `git log -p` across the whole history once and matches every added
// line against a catalog of secret-detection rules. Designed to be reused by
// both a standalone CLI run and the secret-scan-viewer canvas extension.
//
// It never persists raw secrets: every finding stores a *masked* preview only.
// Reachability from the publish branch (`main`) is tagged per finding so the
// UI can highlight what would actually ship when the repo is open sourced.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------
// severity: "critical" | "high" | "medium" | "low"
// Each rule's `regex` MUST be global (`g`) so we can capture every hit on a line.

/** @typedef {{ id: string, name: string, severity: string, regex: RegExp, valueGroup?: number, description: string }} Rule */

/** @type {Rule[]} */
export const RULES = [
    // --- Private keys ------------------------------------------------------
    {
        id: "private-key",
        name: "Private key block",
        severity: "critical",
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        description: "PEM/OpenSSH/PGP private key header.",
    },
    // --- Cloud providers ---------------------------------------------------
    {
        id: "aws-access-key-id",
        name: "AWS access key ID",
        severity: "high",
        regex: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
        description: "AWS access key identifier.",
    },
    {
        id: "aws-secret-access-key",
        name: "AWS secret access key",
        severity: "high",
        regex: /(?:aws.{0,20})?(?:secret|access).{0,20}?['"=:\s]([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
        valueGroup: 1,
        description: "Possible AWS secret access key (40-char base64).",
    },
    {
        id: "gcp-api-key",
        name: "Google API key",
        severity: "high",
        regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
        description: "Google Cloud / Firebase API key.",
    },
    {
        id: "gcp-oauth-secret",
        name: "Google OAuth client secret",
        severity: "high",
        regex: /\bGOCSPX-[A-Za-z0-9_\-]{28}\b/g,
        description: "Google OAuth 2.0 client secret.",
    },
    {
        id: "gcp-service-account",
        name: "GCP service account key",
        severity: "critical",
        regex: /"type"\s*:\s*"service_account"/g,
        description: "Google Cloud service-account JSON key file.",
    },
    // --- Azure -------------------------------------------------------------
    {
        id: "azure-storage-key",
        name: "Azure Storage account key",
        severity: "high",
        regex: /AccountKey=([A-Za-z0-9+/]{86,88}={0,2})/g,
        valueGroup: 1,
        description: "Azure Storage shared account key in a connection string.",
    },
    {
        id: "azure-sas-token",
        name: "Azure SAS token",
        severity: "medium",
        regex: /[?&]sig=([A-Za-z0-9%]{20,})/g,
        valueGroup: 1,
        description: "Azure Shared Access Signature token.",
    },
    {
        id: "azure-connstring-secret",
        name: "Azure connection string secret",
        severity: "high",
        regex: /(?:SharedAccessKey|AccountKey|PrimaryKey|SecondaryKey)=([A-Za-z0-9+/]{30,}={0,2})/g,
        valueGroup: 1,
        description: "Azure Service Bus / Event Hub / Cosmos shared key.",
    },
    // --- GitHub ------------------------------------------------------------
    {
        id: "github-token",
        name: "GitHub token",
        severity: "high",
        regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
        description: "GitHub personal access / OAuth / app token.",
    },
    {
        id: "github-fine-grained-pat",
        name: "GitHub fine-grained PAT",
        severity: "high",
        regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
        description: "GitHub fine-grained personal access token.",
    },
    {
        id: "gitlab-pat",
        name: "GitLab PAT",
        severity: "high",
        regex: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g,
        description: "GitLab personal access token.",
    },
    // --- AI providers (highly relevant to this repo) -----------------------
    {
        id: "anthropic-key",
        name: "Anthropic API key",
        severity: "high",
        regex: /\bsk-ant-[A-Za-z0-9]{2,}-[A-Za-z0-9_\-]{20,}\b/g,
        description: "Anthropic (Claude) API key.",
    },
    {
        id: "openai-key",
        name: "OpenAI API key",
        severity: "high",
        regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{32,}\b/g,
        description: "OpenAI API key.",
    },
    {
        id: "huggingface-token",
        name: "Hugging Face token",
        severity: "high",
        regex: /\bhf_[A-Za-z0-9]{34,}\b/g,
        description: "Hugging Face access token.",
    },
    // --- SaaS tokens -------------------------------------------------------
    {
        id: "slack-token",
        name: "Slack token",
        severity: "high",
        regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
        description: "Slack API token.",
    },
    {
        id: "slack-webhook",
        name: "Slack webhook URL",
        severity: "medium",
        regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g,
        description: "Slack incoming webhook URL.",
    },
    {
        id: "discord-webhook",
        name: "Discord webhook URL",
        severity: "medium",
        regex: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_\-]+/g,
        description: "Discord webhook URL.",
    },
    {
        id: "stripe-secret",
        name: "Stripe secret key",
        severity: "high",
        regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
        description: "Stripe live secret/restricted key.",
    },
    {
        id: "stripe-test",
        name: "Stripe test key",
        severity: "low",
        regex: /\b(?:sk|rk)_test_[A-Za-z0-9]{20,}\b/g,
        description: "Stripe test key (non-production).",
    },
    {
        id: "sendgrid-key",
        name: "SendGrid API key",
        severity: "high",
        regex: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g,
        description: "SendGrid API key.",
    },
    {
        id: "twilio-key",
        name: "Twilio API key",
        severity: "high",
        regex: /\bSK[0-9a-fA-F]{32}\b/g,
        description: "Twilio API key SID.",
    },
    {
        id: "mailgun-key",
        name: "Mailgun API key",
        severity: "high",
        regex: /\bkey-[0-9a-f]{32}\b/g,
        description: "Mailgun API key.",
    },
    {
        id: "npm-token",
        name: "npm token",
        severity: "high",
        regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
        description: "npm automation/publish token.",
    },
    {
        id: "pypi-token",
        name: "PyPI token",
        severity: "high",
        regex: /\bpypi-AgEIcHlwaS[A-Za-z0-9_\-]{50,}\b/g,
        description: "PyPI upload token.",
    },
    {
        id: "telegram-bot-token",
        name: "Telegram bot token",
        severity: "medium",
        regex: /\b[0-9]{8,10}:AA[A-Za-z0-9_\-]{33}\b/g,
        description: "Telegram bot API token.",
    },
    {
        id: "square-token",
        name: "Square access token",
        severity: "high",
        regex: /\b(?:sq0atp|sq0csp|EAAA)[A-Za-z0-9_\-]{22,}\b/g,
        description: "Square OAuth/access token.",
    },
    {
        id: "shopify-token",
        name: "Shopify token",
        severity: "high",
        regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
        description: "Shopify access token.",
    },
    {
        id: "databricks-token",
        name: "Databricks token",
        severity: "high",
        regex: /\bdapi[0-9a-f]{32}\b/g,
        description: "Databricks personal access token.",
    },
    // --- Generic structures ------------------------------------------------
    {
        id: "npm-authtoken",
        name: "npm/yarn auth token",
        severity: "high",
        regex: /(?:_authToken|_auth|_password)\s*=\s*([^\s"']{8,})/gi,
        valueGroup: 1,
        description: "Registry auth token/password in an .npmrc/.yarnrc (unquoted).",
    },
    {
        id: "jwt",
        name: "JSON Web Token",
        severity: "medium",
        regex: /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
        description: "JWT (may be an example or an expired/live token).",
    },
    {
        id: "url-basic-auth",
        name: "Credentials in URL",
        severity: "high",
        regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|rediss|amqps?|https?|ftp):\/\/[^\s:@/]+:([^\s:@/]+)@/g,
        valueGroup: 1,
        description: "Username:password embedded in a connection URL.",
    },
    {
        id: "generic-assignment",
        name: "Hardcoded secret assignment",
        severity: "medium",
        regex: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|private[_-]?key|encryption[_-]?key|bearer)["']?\s*[:=]\s*["']([^"']{8,120})["']/gi,
        valueGroup: 1,
        description: "A secret-looking name assigned a hardcoded literal value.",
    },
];

// ---------------------------------------------------------------------------
// Allowlisting / false-positive reduction
// ---------------------------------------------------------------------------

// Well-known PUBLIC constants that look like secrets but are safe to publish.
const KNOWN_SAFE_LITERALS = [
    // Azurite / Azure Storage Emulator well-known development key (public).
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    "devstoreaccount1",
];

// Substrings that mark a value as an obvious placeholder / non-secret.
const PLACEHOLDER_MARKERS = [
    "example", "placeholder", "changeme", "change-me", "your-", "your_", "yourkey",
    "xxxx", "dummy", "sample", "redacted", "insert", "todo", "fixme", "fake",
    "notreal", "foobar", "test-token", "<", ">", "...", "****", "n/a", "none",
    "process.env", "os.environ", "getenv", "secretref", "vault:", "{{", "}}",
];

// File suffixes / paths that are meant to hold example/placeholder values.
const SAFE_FILE_HINTS = [
    ".example", ".sample", ".template", ".dist", ".tpl",
];
const TEST_FIXTURE_HINTS = [
    "/test", "/tests/", "__tests__", ".test.", ".spec.", "/fixtures/",
    "/fixture/", "/mocks/", "/mock/", "/__mocks__/", "/testdata/", "/e2e/",
    "/stories/", ".stories.",
];
// Third-party / generated code that ships example data we don't own.
const VENDOR_HINTS = [
    "/vendor/", "/node_modules/", "/third_party/", "/third-party/", "/.yarn/",
];
// Rules that detect a *structural marker* (not a token value). Value-shape
// heuristics (whitespace, env-var-name, …) must NOT downgrade these.
const MARKER_RULES = new Set(["private-key", "gcp-service-account"]);

function hasPlaceholderMarker(text) {
    const lower = text.toLowerCase();
    return PLACEHOLDER_MARKERS.some((m) => lower.includes(m));
}

function isKnownSafeLiteral(text) {
    return KNOWN_SAFE_LITERALS.some((s) => text.includes(s));
}

function fileIsExampleTemplate(file) {
    const lower = file.toLowerCase();
    return SAFE_FILE_HINTS.some((s) => lower.endsWith(s) || lower.includes(s + "."));
}

function fileIsTestFixture(file) {
    const lower = "/" + file.toLowerCase();
    return TEST_FIXTURE_HINTS.some((s) => lower.includes(s));
}

function fileIsVendor(file) {
    const lower = "/" + file.toLowerCase();
    return VENDOR_HINTS.some((s) => lower.includes(s));
}

/** Shannon entropy (bits/char) — used to gate noisy generic matches. */
export function shannonEntropy(str) {
    if (!str) return 0;
    const freq = new Map();
    for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
    let entropy = 0;
    const len = str.length;
    for (const count of freq.values()) {
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

/** Mask a secret: keep a little head/tail, hide the middle. */
export function maskSecret(value) {
    if (value == null) return "";
    const s = String(value);
    if (s.length <= 8) return "*".repeat(s.length);
    const head = s.slice(0, 4);
    const tail = s.slice(-4);
    return `${head}${"*".repeat(Math.min(12, s.length - 8))}${tail}`;
}

/** Mask every rule hit inside a full line so the stored preview leaks nothing. */
function maskLine(line, hits) {
    let out = line;
    for (const h of hits) {
        if (h.value && h.value.length >= 6) {
            out = out.split(h.value).join(maskSecret(h.value));
        }
    }
    // Hard cap so the UI never renders a huge minified blob.
    if (out.length > 240) out = out.slice(0, 240) + " …";
    return out;
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * Match a single (added) line against all rules.
 * @returns {{ ruleId: string, name: string, severity: string, value: string, description: string, likelySafe: boolean, safeReason?: string }[]}
 */
export function scanLine(line, file) {
    if (!line) return [];
    // Skip absurdly long lines but still run bounded provider regexes on a slice.
    const scanText = line.length > 4000 ? line.slice(0, 4000) : line;
    const exampleFile = fileIsExampleTemplate(file);
    const fixtureFile = fileIsTestFixture(file);
    const vendorFile = fileIsVendor(file);
    /** @type {any[]} */
    const results = [];

    for (const rule of RULES) {
        rule.regex.lastIndex = 0;
        const isMarker = MARKER_RULES.has(rule.id);
        let m;
        while ((m = rule.regex.exec(scanText)) !== null) {
            const value = rule.valueGroup != null ? m[rule.valueGroup] : m[0];
            if (!value) {
                if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
                continue;
            }

            let likelySafe = false;
            let safeReason;

            // --- Path / literal based downgrades (apply to every rule) --------
            if (isKnownSafeLiteral(value) || isKnownSafeLiteral(m[0])) {
                likelySafe = true;
                safeReason = "known public/dev constant";
            } else if (exampleFile) {
                likelySafe = true;
                safeReason = "example/template file";
            } else if (vendorFile) {
                likelySafe = true;
                safeReason = "vendored/third-party code";
            } else if (fixtureFile && !isMarker) {
                likelySafe = true;
                safeReason = "test fixture / mock";
            }

            // --- Value-shape heuristics (skip structural marker rules) --------
            if (!likelySafe && !isMarker) {
                if (hasPlaceholderMarker(value)) {
                    likelySafe = true;
                    safeReason = "placeholder value";
                } else if (/\s/.test(value)) {
                    likelySafe = true;
                    safeReason = "contains whitespace (descriptive text)";
                } else if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) {
                    likelySafe = true;
                    safeReason = "environment variable name";
                } else if (value.includes("${") || value.includes("{{") || /^\\?[$%]\{?[A-Za-z_]/.test(value)) {
                    likelySafe = true;
                    safeReason = "variable reference";
                }
            }

            // --- Rule-specific gates for the noisy generic detectors ---------
            if (!likelySafe && (rule.id === "generic-assignment" || rule.id === "url-basic-auth")) {
                if (value.length < 6) {
                    likelySafe = true;
                    safeReason = "too short / low signal";
                }
            }
            if (!likelySafe && (rule.id === "generic-assignment" || rule.id === "aws-secret-access-key")) {
                const ent = shannonEntropy(value);
                const looksStructured = /^[A-Za-z0-9+/_=\-]{16,}$/.test(value);
                if (ent < 3.2 && !looksStructured) {
                    likelySafe = true;
                    safeReason = "low entropy / not key-like";
                }
            }

            results.push({
                ruleId: rule.id,
                name: rule.name,
                severity: rule.severity,
                value,
                description: rule.description,
                likelySafe,
                safeReason,
            });

            if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Git history streaming scan
// ---------------------------------------------------------------------------

// Git emits these control bytes via the %x1e / %x1f format placeholders. We use
// them as record/field separators because they never occur in a diff's added
// lines (which always start with '+'), so header detection stays unambiguous.
// (spawn() rejects literal NUL bytes in argv, so we cannot use %x00 here.)
const RS = "\x1e"; // record separator — marks a commit header line
const US = "\x1f"; // unit/field separator

function gitArgs(allRefs) {
    return [
        "-c", "core.quotePath=false",
        "log",
        allRefs ? "--all" : "HEAD",
        "-p",
        "-U0",
        "--no-color",
        "--no-textconv",
        `--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s`,
    ];
}

function runGit(args, cwd) {
    return spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** Collect the set of commit SHAs reachable from a ref (for `onMain` tagging). */
async function reachableSet(cwd, ref) {
    return new Promise((resolve) => {
        const child = runGit(["rev-list", ref], cwd);
        const set = new Set();
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (l) => { if (l) set.add(l.trim()); });
        child.on("error", () => resolve(set));
        child.on("close", () => resolve(set));
    });
}

async function firstExistingRef(cwd, refs) {
    for (const ref of refs) {
        const ok = await new Promise((resolve) => {
            const child = runGit(["rev-parse", "--verify", "--quiet", ref], cwd);
            child.on("error", () => resolve(false));
            child.on("close", (code) => resolve(code === 0));
        });
        if (ok) return ref;
    }
    return null;
}

/**
 * Scan the repository's git history for secrets.
 *
 * @param {object} opts
 * @param {string} opts.cwd                 Repo working directory.
 * @param {boolean} [opts.allRefs=true]     Scan all refs (true) or just HEAD.
 * @param {string} [opts.publishRef]        Ref treated as "will be published" (default: main/origin/main/HEAD).
 * @param {(p: {commits: number}) => void} [opts.onProgress]
 * @returns {Promise<ScanReport>}
 */
export async function scanRepo(opts = {}) {
    const { cwd = process.cwd(), allRefs = true, onProgress } = opts;
    const startedAt = Date.now();

    const publishRef =
        opts.publishRef ||
        (await firstExistingRef(cwd, ["main", "origin/main", "master", "origin/master", "HEAD"])) ||
        "HEAD";
    const publishReachable = await reachableSet(cwd, publishRef);

    /** @type {Map<string, CommitRecord>} */
    const commits = new Map();
    /** @type {Finding[]} */
    const findings = [];

    let cur = null; // current commit record
    let curFile = null; // current +++ file
    let newLineNo = 0; // running new-file line number within a hunk
    let commitCount = 0;
    let findingId = 0;

    const binaryPaths = new Set(); // paths git reported as "Binary files … differ"

    /** Register a finding produced outside the diff pass (messages / files). */
    function registerFinding(f) {
        f.id = `f${++findingId}`;
        findings.push(f);
        let rec = commits.get(f.commit);
        if (!rec) {
            rec = {
                hash: f.commit, author: f.author, email: f.email, date: f.date,
                subject: f.subject, isMerge: false, onPublishBranch: f.onPublishBranch,
                findingCount: 0, severities: {},
            };
            commits.set(f.commit, rec);
        }
        rec.findingCount++;
        rec.severities[f.severity] = (rec.severities[f.severity] || 0) + 1;
    }

    const child = runGit(gitArgs(allRefs), cwd);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
        // Commit header (starts with the RS control byte git emitted via %x1e).
        if (line.startsWith(RS)) {
            const parts = line.slice(RS.length).split(US);
            const [hash, an, ae, aI, parents, subject] = parts;
            cur = {
                hash,
                author: an,
                email: ae,
                date: aI,
                subject: subject || "",
                isMerge: (parents || "").trim().split(/\s+/).filter(Boolean).length > 1,
                onPublishBranch: publishReachable.has(hash),
                findingCount: 0,
                severities: {},
            };
            curFile = null;
            newLineNo = 0;
            commitCount++;
            if (onProgress && commitCount % 100 === 0) onProgress({ commits: commitCount });
            return;
        }
        if (!cur) return;

        // Track current file target.
        if (line.startsWith("+++ ")) {
            let f = line.slice(4);
            if (f.startsWith("b/")) f = f.slice(2);
            curFile = f === "/dev/null" ? null : f;
            return;
        }
        // Binary blobs are never diffed as text — record the path so the
        // sensitive-file pass can treat matching key/cred files as un-scanned.
        if (line.startsWith("Binary files ")) {
            const m = / and b\/(.*) differ$/.exec(line);
            if (m && m[1]) binaryPaths.add(m[1]);
            return;
        }
        if (line.startsWith("--- ") || line.startsWith("diff --git") || line.startsWith("index ") ||
            line.startsWith("old mode") || line.startsWith("new mode") ||
            line.startsWith("similarity ") || line.startsWith("rename ") ||
            line.startsWith("copy ") || line.startsWith("deleted file") || line.startsWith("new file")) {
            return;
        }
        // Hunk header: @@ -a,b +c,d @@  → new-file start line = c.
        if (line.startsWith("@@")) {
            const m = /\+(\d+)/.exec(line);
            newLineNo = m ? parseInt(m[1], 10) : 0;
            return;
        }
        // Added content line (but not the +++ header, handled above).
        if (line.startsWith("+")) {
            const content = line.slice(1);
            const thisLineNo = newLineNo;
            newLineNo++;
            if (!curFile || !content) return;
            const hits = scanLine(content, curFile);
            if (hits.length === 0) return;

            const preview = maskLine(content, hits);
            for (const h of hits) {
                findings.push({
                    id: `f${++findingId}`,
                    commit: cur.hash,
                    author: cur.author,
                    email: cur.email,
                    date: cur.date,
                    subject: cur.subject,
                    onPublishBranch: cur.onPublishBranch,
                    file: curFile,
                    line: thisLineNo,
                    ruleId: h.ruleId,
                    ruleName: h.name,
                    severity: h.severity,
                    description: h.description,
                    maskedValue: maskSecret(h.value),
                    preview,
                    source: "diff",
                    likelySafe: h.likelySafe,
                    safeReason: h.safeReason,
                });
                cur.findingCount++;
                cur.severities[h.severity] = (cur.severities[h.severity] || 0) + 1;
                if (!commits.has(cur.hash)) commits.set(cur.hash, cur);
            }
        }
    });

    await new Promise((resolve, reject) => {
        child.on("error", reject);
        rl.on("close", () => {
            if (child.exitCode && child.exitCode !== 0 && findings.length === 0 && commitCount === 0) {
                reject(new Error(`git log failed (${child.exitCode}): ${stderr.slice(0, 500)}`));
            } else {
                resolve();
            }
        });
    });

    // Pass 2: commit messages (subjects + bodies).
    for (const f of await scanCommitMessages(cwd, allRefs, publishReachable, onProgress)) {
        registerFinding(f);
    }
    // Pass 3: sensitive key/credential files by path (catches binary blobs
    // whose contents the diff pass can never see).
    for (const f of await scanSensitiveFiles(cwd, allRefs, publishReachable, publishRef, binaryPaths)) {
        registerFinding(f);
    }

    return buildReport({ findings, commits, commitCount, publishRef, allRefs, startedAt, cwd });
}

// ---------------------------------------------------------------------------
// Pass 2 — commit messages
// ---------------------------------------------------------------------------

const MESSAGE_PSEUDO_FILE = "«commit message»";

/** Scan every commit's message (subject + body) for secrets. */
async function scanCommitMessages(cwd, allRefs, publishReachable, onProgress) {
    const args = [
        "-c", "core.quotePath=false", "log", allRefs ? "--all" : "HEAD",
        "--no-color", `--format=${RS}%H${US}%an${US}%ae${US}%aI${US}%P${US}%s${US}%b`,
    ];
    const child = runGit(args, cwd);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const out = [];
    let cur = null;
    let msgLineNo = 0;
    let seen = 0;

    const scanMsgLine = (text) => {
        if (!cur || !text) return;
        const hits = scanLine(text, MESSAGE_PSEUDO_FILE);
        if (!hits.length) return;
        const preview = maskLine(text, hits);
        for (const h of hits) {
            out.push({
                commit: cur.hash, author: cur.author, email: cur.email, date: cur.date,
                subject: cur.subject, onPublishBranch: cur.onPublishBranch,
                file: MESSAGE_PSEUDO_FILE, line: msgLineNo,
                ruleId: h.ruleId, ruleName: h.name, severity: h.severity,
                description: h.description, maskedValue: maskSecret(h.value),
                preview, source: "message", likelySafe: h.likelySafe, safeReason: h.safeReason,
            });
        }
    };

    rl.on("line", (line) => {
        if (line.startsWith(RS)) {
            const parts = line.slice(RS.length).split(US);
            const [hash, an, ae, aI, , subject] = parts;
            cur = {
                hash, author: an, email: ae, date: aI,
                subject: subject || "", onPublishBranch: publishReachable.has(hash),
            };
            seen++;
            if (onProgress && seen % 500 === 0) onProgress({ commits: seen, phase: "messages" });
            // Field 7+ (after %s) is the first line of %b, inlined on this line.
            const firstBody = parts.slice(6).join(US);
            msgLineNo = 1; scanMsgLine(cur.subject);
            if (firstBody) { msgLineNo = 2; scanMsgLine(firstBody); }
            return;
        }
        if (!cur) return;
        msgLineNo++;
        scanMsgLine(line);
    });

    await new Promise((resolve, reject) => {
        child.on("error", reject);
        rl.on("close", () => {
            if (child.exitCode && child.exitCode !== 0 && out.length === 0 && seen === 0) {
                reject(new Error(`git log (messages) failed (${child.exitCode}): ${stderr.slice(0, 300)}`));
            } else resolve();
        });
    });
    return out;
}

// ---------------------------------------------------------------------------
// Pass 3 — sensitive key / credential files (path-based, catches binaries)
// ---------------------------------------------------------------------------

/** Classify a file path as key/credential material. Returns null if not. */
function classifySensitiveFile(path) {
    const p = path.toLowerCase();
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return { severity: "critical", description: "SSH private key file." };
    if (/\.(ppk|p8|pkcs8|pkcs12)$/.test(base)) return { severity: "critical", description: "Private key file." };
    if (base === "secring.gpg" || /\.kdbx$/.test(base)) return { severity: "critical", description: "Secret keyring / password vault." };
    if (/\.(pfx|p12|jks|keystore|bcfks)$/.test(base)) return { severity: "high", description: "Keystore / PKCS#12 bundle." };
    if (/\.(pem|key)$/.test(base)) return { severity: "high", description: "PEM/key file — may hold a private key." };
    if (base === "credentials" && p.includes("/.aws/")) return { severity: "high", description: "AWS credentials file." };
    if (/\.der$/.test(base)) return { severity: "medium", description: "DER-encoded key/cert — verify not private." };
    if (/\.(gpg|pgp|asc)$/.test(base)) return { severity: "medium", description: "PGP/GPG data — verify not a secret key." };
    if (base === ".netrc" || base === "_netrc" || base === ".pgpass" || base === ".htpasswd") return { severity: "medium", description: "Credential file." };
    if (base === ".npmrc" || base === ".yarnrc" || base === ".yarnrc.yml") return { severity: "medium", description: "Package registry config — may contain an auth token.", lowRiskConfig: true };
    return null;
}

/** True if `<ref>:<path>` resolves to a blob in that tree. */
function fileExistsInTree(cwd, ref, path) {
    return new Promise((resolve) => {
        const child = runGit(["cat-file", "-e", `${ref}:${path}`], cwd);
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
    });
}

/** Detect committed key/credential files across history (incl. binary blobs). */
async function scanSensitiveFiles(cwd, allRefs, publishReachable, publishRef, binaryPaths) {
    const args = [
        "-c", "core.quotePath=false", "log", allRefs ? "--all" : "HEAD",
        "--no-color", "--diff-filter=AM", "--name-only",
        `--format=${RS}%H${US}%an${US}%ae${US}%aI${US}%P${US}%s`,
    ];
    const child = runGit(args, cwd);
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    /** @type {Map<string, any>} */
    const seen = new Map();
    let cur = null;

    rl.on("line", (line) => {
        if (line.startsWith(RS)) {
            const parts = line.slice(RS.length).split(US);
            const [hash, an, ae, aI, , subject] = parts;
            cur = { hash, author: an, email: ae, date: aI, subject: subject || "" };
            return;
        }
        if (!cur) return;
        const path = line.trim();
        if (!path) return;
        const cls = classifySensitiveFile(path);
        if (!cls) return;
        // Reverse-chron stream: overwrite so the final record = introducing commit.
        seen.set(path, { path, cls, commit: cur });
    });

    await new Promise((resolve, reject) => {
        child.on("error", reject);
        rl.on("close", resolve);
    });

    const out = [];
    for (const { path, cls, commit } of seen.values()) {
        const isBinary = binaryPaths.has(path);
        const existsOnPublish = await fileExistsInTree(cwd, publishRef, path);
        // Key/credential files stay REAL regardless of binary-vs-text (git's
        // binary heuristic is unreliable, and content scanning doesn't
        // understand every credential format). Only path context (example /
        // fixture / vendor) or a low-risk config type downgrades them.
        let likelySafe = false;
        let safeReason;
        if (fileIsExampleTemplate(path)) { likelySafe = true; safeReason = "example/template file"; }
        else if (fileIsVendor(path)) { likelySafe = true; safeReason = "vendored/third-party code"; }
        else if (fileIsTestFixture(path)) { likelySafe = true; safeReason = "test fixture / mock"; }
        else if (cls.lowRiskConfig) { likelySafe = true; safeReason = "registry/config file — token scanning applied"; }
        out.push({
            commit: commit.hash, author: commit.author, email: commit.email, date: commit.date,
            subject: commit.subject,
            onPublishBranch: existsOnPublish || publishReachable.has(commit.hash),
            file: path, line: 0,
            ruleId: "sensitive-file", ruleName: "Sensitive key/credential file",
            severity: cls.severity,
            description: cls.description + (isBinary ? " Binary — contents not diff-scanned." : "") +
                (existsOnPublish ? " Present in published tree." : " Removed (in history only)."),
            maskedValue: "",
            preview: (isBinary ? "binary blob: " : "file: ") + path,
            source: "file", likelySafe, safeReason,
        });
    }
    return out;
}

function buildReport({ findings, commits, commitCount, publishRef, allRefs, startedAt, cwd }) {
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    const byRule = {};
    let realCount = 0;
    let publishCount = 0;
    for (const f of findings) {
        if (!f.likelySafe) {
            bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
            byRule[f.ruleId] = (byRule[f.ruleId] || 0) + 1;
            realCount++;
            if (f.onPublishBranch) publishCount++;
        }
    }
    // Sort: severity desc, publish-branch first, then date desc.
    findings.sort((a, b) => {
        if (a.likelySafe !== b.likelySafe) return a.likelySafe ? 1 : -1;
        const s = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
        if (s !== 0) return s;
        if (a.onPublishBranch !== b.onPublishBranch) return a.onPublishBranch ? -1 : 1;
        return (b.date || "").localeCompare(a.date || "");
    });

    return {
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        repo: cwd,
        publishRef,
        allRefs,
        stats: {
            commitsScanned: commitCount,
            totalFindings: findings.length,
            realFindings: realCount,
            likelySafeFindings: findings.length - realCount,
            onPublishBranch: publishCount,
            commitsWithFindings: commits.size,
            bySeverity,
            byRule,
        },
        findings,
        commits: Array.from(commits.values()),
    };
}

// ---------------------------------------------------------------------------
// Type sketches (for editors / documentation)
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} Finding
 * @property {string} id
 * @property {string} commit
 * @property {string} author
 * @property {string} email
 * @property {string} date
 * @property {string} subject
 * @property {boolean} onPublishBranch
 * @property {string} file
 * @property {number} line
 * @property {string} ruleId
 * @property {string} ruleName
 * @property {string} severity
 * @property {string} description
 * @property {string} maskedValue
 * @property {string} preview
 * @property {boolean} likelySafe
 * @property {string} [safeReason]
 *
 * @typedef {Object} CommitRecord
 * @property {string} hash
 * @property {string} author
 * @property {string} email
 * @property {string} date
 * @property {string} subject
 * @property {boolean} isMerge
 * @property {boolean} onPublishBranch
 * @property {number} findingCount
 * @property {Record<string, number>} severities
 *
 * @typedef {Object} ScanReport
 * @property {string} generatedAt
 * @property {number} durationMs
 * @property {string} repo
 * @property {string} publishRef
 * @property {boolean} allRefs
 * @property {Object} stats
 * @property {Finding[]} findings
 * @property {CommitRecord[]} commits
 */
