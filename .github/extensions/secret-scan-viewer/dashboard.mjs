// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// dashboard.mjs — the single-page UI served by the secret-scan-viewer canvas.
//
// Pure static HTML/CSS/JS (no build step). All data arrives at runtime from the
// canvas's local API:
//   GET  /api/status  -> { state, commits, generation, error }
//   GET  /api/report  -> full ScanReport JSON (masked values only)
//   POST /api/rescan  -> { allRefs } triggers a fresh scan
// The page polls /api/status and re-fetches the report whenever `generation`
// changes, so agent-triggered rescans update the view live.

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Secret Scan — Git History</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #1c2230; --border: #30363d;
    --fg: #e6edf3; --muted: #8b949e; --faint: #6e7681;
    --crit: #ff5c5c; --high: #ff9f43; --med: #f5c451; --low: #6ab7ff;
    --main: #3fb950; --safe: #a371f7; --accent: #58a6ff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column; height: 100vh;
  }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header {
    padding: 14px 18px; border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, var(--bg2), var(--bg));
  }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  .repo { color: var(--muted); font-size: 11.5px; }
  .spacer { flex: 1; }
  .meta { color: var(--faint); font-size: 11px; }
  button {
    background: var(--bg3); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 11px; cursor: pointer; font-size: 12px;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: #1f6feb; border-color: #1f6feb; }
  button.primary:hover { background: #388bfd; }
  button:disabled { opacity: .5; cursor: default; }

  .cards { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .card {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 13px; min-width: 108px;
  }
  .card .n { font-size: 20px; font-weight: 700; }
  .card .l { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; }
  .card.alert .n { color: var(--high); }
  .card.ok .n { color: var(--main); }

  .sev-legend { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px;
    border-radius: 999px; border: 1px solid var(--border); background: var(--bg2);
    cursor: pointer; font-size: 11.5px; user-select: none;
  }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; }
  .chip.off { opacity: .38; }
  .chip .cnt { color: var(--muted); font-variant-numeric: tabular-nums; }
  .dot.critical { background: var(--crit); } .dot.high { background: var(--high); }
  .dot.medium { background: var(--med); } .dot.low { background: var(--low); }

  .controls { display: flex; gap: 10px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  input[type=search], select {
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 9px; font-size: 12px;
  }
  input[type=search] { min-width: 240px; flex: 1; }
  label.tog { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; user-select: none; }

  main { flex: 1; overflow: auto; padding: 8px 18px 24px; }
  .group-hdr {
    position: sticky; top: 0; background: var(--bg); padding: 12px 2px 6px;
    display: flex; gap: 8px; align-items: center; z-index: 1;
  }
  .group-hdr .h { font-family: ui-monospace, monospace; color: var(--accent); }
  .group-hdr .s { color: var(--muted); font-size: 11.5px; }

  .finding {
    display: grid; grid-template-columns: 78px 1fr; gap: 12px;
    padding: 11px 12px; border: 1px solid var(--border); border-radius: 8px;
    margin: 7px 0; background: var(--bg2);
  }
  .finding.safe { opacity: .68; background: var(--bg); }
  .sev-pill {
    align-self: start; text-align: center; padding: 3px 0; border-radius: 6px;
    font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
    border: 1px solid;
  }
  .sev-pill.critical { color: var(--crit); border-color: var(--crit); }
  .sev-pill.high { color: var(--high); border-color: var(--high); }
  .sev-pill.medium { color: var(--med); border-color: var(--med); }
  .sev-pill.low { color: var(--low); border-color: var(--low); }
  .f-main { min-width: 0; }
  .f-top { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .rule { font-weight: 640; }
  .badge {
    font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border);
    color: var(--muted); text-transform: uppercase; letter-spacing: .3px;
  }
  .badge.main { color: var(--main); border-color: rgba(63,185,80,.5); background: rgba(63,185,80,.08); }
  .badge.branch { color: var(--faint); }
  .badge.safe { color: var(--safe); border-color: rgba(163,113,247,.5); background: rgba(163,113,247,.08); }
  .badge.src { color: var(--fg); border-color: rgba(88,166,255,.5); background: rgba(88,166,255,.08); }
  .loc { color: var(--muted); font-size: 12px; }
  .loc .file { color: var(--fg); }
  .preview {
    margin-top: 7px; padding: 7px 9px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; white-space: pre-wrap; word-break: break-all; font-size: 12px; color: #c9d1d9;
  }
  .f-sub { margin-top: 6px; color: var(--faint); font-size: 11px; display: flex; gap: 12px; flex-wrap: wrap; }
  .desc { color: var(--muted); }

  .state { text-align: center; padding: 60px 20px; color: var(--muted); }
  .spinner {
    width: 26px; height: 26px; border: 3px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .8s linear infinite; margin: 0 auto 14px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .big-ok { font-size: 34px; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<header>
  <div class="title-row">
    <h1>🔑 Secret Scan — Git History</h1>
    <span class="repo" id="repo"></span>
    <span class="spacer"></span>
    <label class="tog"><input type="checkbox" id="allRefs" checked /> all branches</label>
    <button id="rescan" class="primary">Rescan</button>
  </div>
  <div class="cards" id="cards"></div>
  <div class="sev-legend" id="legend"></div>
  <div class="controls">
    <input type="search" id="q" placeholder="Filter by file, rule, author, commit, preview…" />
    <select id="ruleSel"><option value="">All rules</option></select>
    <label class="tog"><input type="checkbox" id="mainOnly" /> on publish branch only</label>
    <label class="tog"><input type="checkbox" id="showSafe" /> show likely-safe</label>
    <label class="tog"><input type="checkbox" id="groupBy" /> group by commit</label>
  </div>
  <div class="meta" id="meta" style="margin-top:8px"></div>
</header>
<main id="main"><div class="state"><div class="spinner"></div>Starting scan…</div></main>

<script>
const state = { report: null, generation: -1, status: null };
const el = (id) => document.getElementById(id);
const filters = { sev: new Set(["critical","high","medium","low"]), q: "", rule: "", mainOnly: false, showSafe: false, groupBy: false };

async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok && r.status !== 202) throw new Error(url+" "+r.status); return r.status === 202 ? null : r.json(); }

async function poll() {
  try {
    const s = await j("/api/status");
    state.status = s;
    if (s.state === "scanning") renderScanning(s);
    else if (s.state === "error") renderError(s.error);
    else if (s.state === "done" && s.generation !== state.generation) {
      const rep = await j("/api/report");
      if (rep) { state.report = rep; state.generation = s.generation; buildRuleOptions(); render(); }
    }
  } catch (e) { /* transient */ }
  setTimeout(poll, 1200);
}

function renderScanning(s) {
  el("main").innerHTML = '<div class="state"><div class="spinner"></div>Scanning git history… <b>'+(s.commits||0)+'</b> commits</div>';
}
function renderError(msg) {
  el("main").innerHTML = '<div class="state">⚠️ Scan failed<br><br><code>'+escapeHtml(msg||"unknown error")+'</code></div>';
}

function buildRuleOptions() {
  const sel = el("ruleSel"); const cur = sel.value;
  const rules = [...new Set(state.report.findings.map(f => f.ruleName))].sort();
  sel.innerHTML = '<option value="">All rules</option>' + rules.map(r => '<option>'+escapeHtml(r)+'</option>').join("");
  sel.value = cur;
}

function escapeHtml(s) { return String(s??"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shortHash(h) { return (h||"").slice(0,8); }

function render() {
  const r = state.report; if (!r) return;
  el("repo").textContent = r.repo + "  ·  " + (r.allRefs ? "all refs" : r.publishRef);
  el("allRefs").checked = !!r.allRefs;
  el("meta").innerHTML = "publish ref: <code>"+escapeHtml(r.publishRef)+"</code> · scanned in "+(r.durationMs/1000).toFixed(1)+"s · generated "+new Date(r.generatedAt).toLocaleString();

  const st = r.stats;
  el("cards").innerHTML = [
    card(st.commitsScanned, "commits scanned"),
    card(st.realFindings, "real findings", st.realFindings ? "alert" : "ok"),
    card(st.onPublishBranch, "on publish branch", st.onPublishBranch ? "alert" : "ok"),
    card(st.likelySafeFindings, "likely safe"),
  ].join("");

  el("legend").innerHTML = ["critical","high","medium","low"].map(sev => {
    const pool = r.findings.filter(f => filters.showSafe || !f.likelySafe);
    const n = pool.filter(f => f.severity === sev).length;
    return '<span class="chip '+(filters.sev.has(sev)?"":"off")+'" data-sev="'+sev+'"><span class="dot '+sev+'"></span>'+sev+' <span class="cnt">'+n+'</span></span>';
  }).join("");
  el("legend").querySelectorAll(".chip").forEach(c => c.onclick = () => {
    const s = c.dataset.sev; filters.sev.has(s) ? filters.sev.delete(s) : filters.sev.add(s); render();
  });

  const list = r.findings.filter(matches);
  const main = el("main");
  if (list.length === 0) {
    const anyReal = st.realFindings > 0;
    main.innerHTML = '<div class="state"><div class="big-ok">'+(anyReal?"🔍":"✅")+'</div>'+
      (anyReal ? "No findings match the current filters." : "No secrets detected in git history.<br><small>"+st.likelySafeFindings+" low-signal matches were classified as likely-safe. Toggle <b>show likely-safe</b> to review them.</small>")+'</div>';
    return;
  }
  main.innerHTML = filters.groupBy ? renderGrouped(list) : list.map(renderFinding).join("");
}

function card(n, l, cls) { return '<div class="card '+(cls||"")+'"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }

function matches(f) {
  if (!filters.showSafe && f.likelySafe) return false;
  if (!filters.sev.has(f.severity)) return false;
  if (filters.mainOnly && !f.onPublishBranch) return false;
  if (filters.rule && f.ruleName !== filters.rule) return false;
  if (filters.q) {
    const q = filters.q.toLowerCase();
    const hay = (f.file+" "+f.ruleName+" "+f.author+" "+f.commit+" "+f.subject+" "+f.preview+" "+(f.source||"")).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderFinding(f) {
  const srcLabel = f.source === "message" ? "commit msg" : f.source === "file" ? "file" : "diff";
  const badges =
    (f.source && f.source !== "diff" ? '<span class="badge src">'+srcLabel+'</span>' : '') +
    (f.onPublishBranch ? '<span class="badge main">publish branch</span>' : '<span class="badge branch">branch only</span>') +
    (f.likelySafe ? '<span class="badge safe">likely safe'+(f.safeReason?': '+escapeHtml(f.safeReason):'')+'</span>' : '');
  return '<div class="finding '+(f.likelySafe?"safe":"")+'">'+
    '<div class="sev-pill '+f.severity+'">'+f.severity+'</div>'+
    '<div class="f-main">'+
      '<div class="f-top"><span class="rule">'+escapeHtml(f.ruleName)+'</span>'+badges+'</div>'+
      '<div class="loc mono"><span class="file">'+escapeHtml(f.file)+'</span>'+(f.line?':'+f.line:'')+'</div>'+
      '<div class="preview mono">'+escapeHtml(f.preview)+'</div>'+
      '<div class="f-sub"><span class="desc">'+escapeHtml(f.description)+'</span>'+
        '<span>commit <code>'+shortHash(f.commit)+'</code></span>'+
        '<span>'+escapeHtml((f.date||"").slice(0,10))+'</span>'+
        '<span>'+escapeHtml(f.author||"")+'</span></div>'+
    '</div></div>';
}

function renderGrouped(list) {
  const groups = new Map();
  for (const f of list) { if (!groups.has(f.commit)) groups.set(f.commit, []); groups.get(f.commit).push(f); }
  let html = "";
  for (const [hash, items] of groups) {
    const f0 = items[0];
    html += '<div class="group-hdr"><span class="h">'+shortHash(hash)+'</span>'+
      '<span class="s">'+escapeHtml(f0.subject||"")+' · '+escapeHtml(f0.author||"")+' · '+escapeHtml((f0.date||"").slice(0,10))+' · '+items.length+' finding(s)</span></div>';
    html += items.map(renderFinding).join("");
  }
  return html;
}

// wire controls
el("q").oninput = (e) => { filters.q = e.target.value; render(); };
el("ruleSel").onchange = (e) => { filters.rule = e.target.value; render(); };
el("mainOnly").onchange = (e) => { filters.mainOnly = e.target.checked; render(); };
el("showSafe").onchange = (e) => { filters.showSafe = e.target.checked; render(); };
el("groupBy").onchange = (e) => { filters.groupBy = e.target.checked; render(); };
el("rescan").onclick = async () => {
  el("rescan").disabled = true;
  try { await fetch("/api/rescan", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ allRefs: el("allRefs").checked }) }); }
  finally { setTimeout(() => el("rescan").disabled = false, 1500); }
};

poll();
</script>
</body>
</html>`;
