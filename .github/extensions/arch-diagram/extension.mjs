// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Extension: arch-diagram
// Architecture diagram canvas with ELK.js auto-layout

import { createServer } from "node:http";
import { readFileSync, watch } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));
const diagramPath = resolve(__dirname, "../../../docs/architecture/diagram.json");

function loadDiagramData() {
  return JSON.parse(readFileSync(diagramPath, "utf-8"));
}

let diagramData = loadDiagramData();

const servers = new Map();
// SSE clients per instance for pushing updates
const sseClients = new Map(); // instanceId → Set<res>
// Selection state per instance
const selections = new Map(); // instanceId → { type: "node"|"edge", id, label, ...details }

// Watch diagram.json for changes and push updates to all clients
let debounceTimer = null;
watch(diagramPath, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try {
      diagramData = loadDiagramData();
      for (const instanceId of sseClients.keys()) {
        pushUpdate(instanceId);
      }
    } catch (e) { /* ignore parse errors during mid-write */ }
  }, 200);
});

function renderHtml() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Scope Architecture</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; overflow: hidden; background: #0d1117; }
.react-flow__node { font-family: -apple-system, system-ui, sans-serif; font-size: 13px; }
.react-flow__edge-textwrapper .react-flow__edge-text { font-size: 10px; fill: #8b949e; }
.react-flow__edge-text { fill: #8b949e !important; }
.react-flow__edge-textbg { fill: #0d1117 !important; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
import React from "https://esm.sh/react@18.3.1";
import ReactDOM from "https://esm.sh/react-dom@18.3.1/client?external=react&alias=react:https://esm.sh/react@18.3.1";
import { ReactFlow, Background, Controls, useNodesState, useEdgesState, Position, MarkerType } from "https://esm.sh/@xyflow/react@12.6.0?external=react,react-dom&alias=react:https://esm.sh/react@18.3.1,react-dom:https://esm.sh/react-dom@18.3.1";
import ELK from "https://esm.sh/elkjs@0.9.3/lib/elk.bundled.js";

const { createElement: h } = React;

// Inject React Flow styles
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "https://esm.sh/@xyflow/react@12.6.0/dist/style.css";
document.head.appendChild(link);

const nodeWidth = 160;
const nodeHeight = 50;

// Diagram data injected from server
const diagramData = ${JSON.stringify(diagramData)};

// Derive React Flow nodes and edges from semantic data
const groupStyle = { borderRadius: 12, padding: 10 };
const edgeColors = { sync: "#8b949e", async: "#d2a8ff", storage: "#8b949e" };

function colorToBg(color) {
  // Map border color to a dark background
  const map = { "#58a6ff": "#161b22", "#79c0ff": "#161b22", "#7ee787": "#0d2818", "#ffa657": "#2a1a00", "#ff7b72": "#2d1215", "#8b949e": "#161b22" };
  return map[color] || "#161b22";
}

const initialNodes = [
  ...diagramData.groups.map(g => ({
    id: g.id,
    data: { label: g.label },
    style: { ...groupStyle, background: g.color + "0d", border: "1px dashed " + g.color, color: g.color },
  })),
  ...diagramData.nodes.map(n => ({
    id: n.id,
    ...(n.group ? { parentId: n.group, extent: "parent" } : {}),
    data: { label: n.label },
    style: { background: colorToBg(n.color), border: "2px solid " + n.color, color: "#e6edf3", borderRadius: 8, width: nodeWidth },
  })),
];

const initialEdges = diagramData.edges.map(e => ({
  id: e.id,
  source: e.source,
  target: e.target,
  label: e.label,
  markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[e.type] },
  style: { stroke: edgeColors[e.type], ...(e.type === "storage" ? { strokeDasharray: "5 5" } : {}) },
}));

async function getLayoutedElements(nodes, edges, algorithm = "layered") {
  const elk = new ELK();

  // Build ELK compound graph with groups
  const groupIds = new Set(nodes.filter(n => n.parentId).map(n => n.parentId));
  const groups = nodes.filter((n) => groupIds.has(n.id));
  const leafNodes = nodes.filter((n) => !groupIds.has(n.id));

  const groupChildren = {};
  for (const g of groups) groupChildren[g.id] = [];
  for (const n of leafNodes) {
    if (n.parentId && groupChildren[n.parentId]) {
      groupChildren[n.parentId].push({ id: n.id, width: nodeWidth, height: nodeHeight });
    }
  }

  const topLevelChildren = [];
  for (const g of groups) {
    topLevelChildren.push({
      id: g.id,
      layoutOptions: {
        "elk.padding": "[top=40,left=20,bottom=20,right=20]",
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "20",
      },
      children: groupChildren[g.id],
    });
  }
  // Add ungrouped nodes
  for (const n of leafNodes) {
    if (!n.parentId) {
      topLevelChildren.push({ id: n.id, width: nodeWidth, height: nodeHeight });
    }
  }

  // Algorithm-specific layout options
  const algoOptions = {
    layered: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    stress: {
      "elk.algorithm": "stress",
      "elk.stress.desiredEdgeLength": "150",
      "elk.spacing.nodeNode": "60",
    },
    force: {
      "elk.algorithm": "force",
      "elk.force.iterations": "300",
      "elk.spacing.nodeNode": "60",
    },
    mrtree: {
      "elk.algorithm": "mrtree",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "40",
      "elk.mrtree.weighting": "CONSTRAINT",
    },
  };

  const graph = {
    id: "root",
    layoutOptions: algoOptions[algorithm] || algoOptions.layered,
    children: topLevelChildren,
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const layout = await elk.layout(graph);

  // Flatten positions from compound layout
  const positions = {};
  for (const child of layout.children) {
    if (child.children) {
      // This is a group — record group position and child positions relative to it
      positions[child.id] = { x: child.x, y: child.y, width: child.width, height: child.height };
      for (const inner of child.children) {
        positions[inner.id] = { x: inner.x, y: inner.y };
      }
    } else {
      positions[child.id] = { x: child.x, y: child.y };
    }
  }

  const layoutedNodes = nodes.map((node) => {
    const pos = positions[node.id];
    if (groupIds.has(node.id)) {
      return {
        ...node,
        position: { x: pos.x, y: pos.y },
        style: { ...node.style, width: pos.width, height: pos.height },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      };
    }
    return {
      ...node,
      position: { x: pos.x, y: pos.y },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });

  return { nodes: layoutedNodes, edges };
}

const { nodes: layoutedNodes, edges: layoutedEdges } = await getLayoutedElements(initialNodes, initialEdges, diagramData.layout || "layered");

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);
  const [refreshing, setRefreshing] = React.useState(false);
  const [algorithm, setAlgorithm] = React.useState(diagramData.layout || "layered");

  const relayout = async (algo) => {
    const layout = await getLayoutedElements(initialNodes, initialEdges, algo);
    setNodes(layout.nodes);
    setEdges(layout.edges);
  };

  const handleAlgoChange = async (e) => {
    const algo = e.target.value;
    setAlgorithm(algo);
    await relayout(algo);
  };

  React.useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = async (event) => {
      const newData = JSON.parse(event.data);
      // Re-derive nodes and edges from updated data
      const newNodes = [
        ...newData.groups.map(g => ({
          id: g.id,
          data: { label: g.label },
          style: { ...groupStyle, background: g.color + "0d", border: "1px dashed " + g.color, color: g.color },
        })),
        ...newData.nodes.map(n => ({
          id: n.id,
          ...(n.group ? { parentId: n.group, extent: "parent" } : {}),
          data: { label: n.label },
          style: { background: colorToBg(n.color), border: "2px solid " + n.color, color: "#e6edf3", borderRadius: 8, width: nodeWidth },
        })),
      ];
      const newEdges = newData.edges.map(e => ({
        id: e.id, source: e.source, target: e.target, label: e.label,
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[e.type] },
        style: { stroke: edgeColors[e.type], ...(e.type === "storage" ? { strokeDasharray: "5 5" } : {}) },
      }));
      const layout = await getLayoutedElements(newNodes, newEdges, algorithm);
      setNodes(layout.nodes);
      setEdges(layout.edges);
      setRefreshing(false);
    };
    return () => es.close();
  }, [algorithm]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetch("/refresh", { method: "POST" });
  };

  const [selection, setSelection] = React.useState(null);

  const handleNodeClick = (event, node) => {
    setSelection({ type: "node", label: node.data.label });
    fetch("/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "node", id: node.id, label: node.data.label }),
    });
  };

  const handleEdgeClick = (event, edge) => {
    setSelection({ type: "edge", label: edge.label || (edge.source + " → " + edge.target) });
    fetch("/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "edge", id: edge.id, source: edge.source, target: edge.target, label: edge.label }),
    });
  };

  const handlePaneClick = () => {
    setSelection(null);
    fetch("/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(null),
    });
  };

  const controlStyle = {
    position: "absolute", top: 12, zIndex: 10,
    background: "#161b22", color: "#e6edf3",
    border: "1px solid #3d444d", borderRadius: 6, padding: "6px 12px",
    fontSize: 12, cursor: "pointer",
  };

  return h("div", { style: { width: "100%", height: "100%", position: "relative" } },
    h(ReactFlow, {
      nodes,
      edges,
      onNodesChange,
      onEdgesChange,
      onNodeClick: handleNodeClick,
      onEdgeClick: handleEdgeClick,
      onPaneClick: handlePaneClick,
      fitView: true,
      colorMode: "dark",
      proOptions: { hideAttribution: true },
      minZoom: 0.3,
      maxZoom: 2,
    },
      h(Background, { color: "#30363d", gap: 20 }),
      h(Controls, { showInteractive: false })
    ),
    h("select", {
      value: algorithm,
      onChange: handleAlgoChange,
      style: { ...controlStyle, right: 200 },
    },
      h("option", { value: "layered" }, "Layered"),
      h("option", { value: "stress" }, "Stress"),
      h("option", { value: "force" }, "Force"),
      h("option", { value: "mrtree" }, "MR Tree")
    ),
    h("button", {
      onClick: handleRefresh,
      disabled: refreshing,
      style: {
        ...controlStyle, right: 12,
        background: refreshing ? "#30363d" : "#238636",
        display: "flex", alignItems: "center", gap: 6,
      },
    }, refreshing ? "⏳ Analyzing..." : "🔄 Refresh from codebase"),
    selection && h("div", {
      style: {
        position: "absolute", bottom: 12, left: 12, zIndex: 10,
        background: "#161b22", color: "#e6edf3",
        border: "1px solid #58a6ff", borderRadius: 6, padding: "8px 12px",
        fontSize: 12, display: "flex", alignItems: "center", gap: 8,
      },
    },
      "📌 ", h("strong", null, selection.label), " (", selection.type, ")",
      h("button", {
        onClick: () => fetch("/ask", { method: "POST" }),
        style: {
          background: "#1f6feb", color: "#fff", border: "none", borderRadius: 4,
          padding: "4px 10px", fontSize: 11, cursor: "pointer", marginLeft: 8,
        },
      }, "💬 Ask Copilot")
    )
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(h(App));
</script>
</body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");

        if (url.pathname === "/events" && req.method === "GET") {
            // SSE endpoint
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            if (!sseClients.has(instanceId)) sseClients.set(instanceId, new Set());
            sseClients.get(instanceId).add(res);
            req.on("close", () => {
                const clients = sseClients.get(instanceId);
                if (clients) clients.delete(res);
            });
            return;
        }

        if (url.pathname === "/selection" && req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => body += chunk);
            req.on("end", () => {
                const selection = JSON.parse(body);
                if (selection) {
                    selections.set(instanceId, selection);
                } else {
                    selections.delete(instanceId);
                }
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }

        if (url.pathname === "/ask" && req.method === "POST") {
            res.writeHead(202, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ status: "asking" }));
            triggerAsk(instanceId);
            return;
        }

        if (url.pathname === "/refresh" && req.method === "POST") {
            // Trigger agent to analyze codebase
            res.writeHead(202, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ status: "analyzing" }));
            triggerRefresh(instanceId);
            return;
        }

        if (req.method === "OPTIONS") {
            res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
            res.end();
            return;
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml());
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

let session;

async function triggerRefresh(instanceId) {
    // Send message to the agent to analyze the codebase
    const prompt = `Analyze the codebase structure and update docs/architecture/diagram.json to reflect the current architecture. Read the existing file first, then look at the actual project structure (apps/, packages/, workers) and update nodes, edges, and groups accordingly. Keep the same JSON schema. Only update what has changed.`;
    await session.sendAndWait(prompt);
    // Re-read the file after agent updates it
    diagramData = loadDiagramData();
    // Push update to all SSE clients for this instance
    pushUpdate(instanceId);
}

async function triggerAsk(instanceId) {
    const sel = selections.get(instanceId);
    if (!sel) return;
    let prompt;
    if (sel.type === "node") {
        const node = diagramData.nodes.find(n => n.id === sel.id);
        const group = node?.group ? diagramData.groups.find(g => g.id === node.group) : null;
        const inEdges = diagramData.edges.filter(e => e.target === sel.id || e.target === node?.group);
        const outEdges = diagramData.edges.filter(e => e.source === sel.id || e.source === node?.group);
        prompt = `The user selected the "${sel.label}" component in the architecture diagram.${group ? ` It belongs to the "${group.label}" group.` : ""} Incoming: ${inEdges.map(e => `${e.source} → ${sel.id} (${e.label})`).join(", ") || "none"}. Outgoing: ${outEdges.map(e => `${sel.id} → ${e.target} (${e.label})`).join(", ") || "none"}. Tell the user about this component: what it does, how it fits in the system, and key implementation details.`;
    } else if (sel.type === "edge") {
        const edge = diagramData.edges.find(e => e.id === sel.id);
        const sourceNode = diagramData.nodes.find(n => n.id === sel.source) || diagramData.groups.find(g => g.id === sel.source);
        const targetNode = diagramData.nodes.find(n => n.id === sel.target) || diagramData.groups.find(g => g.id === sel.target);
        prompt = `The user selected the edge "${sel.label || edge?.label}" connecting "${sourceNode?.label || sel.source}" → "${targetNode?.label || sel.target}" (type: ${edge?.type}). Tell the user about this connection: what data flows through it, how it's implemented, and any important details.`;
    } else {
        return;
    }
    session.send(prompt);
}

function pushUpdate(instanceId) {
    const clients = sseClients.get(instanceId);
    if (!clients) return;
    const payload = JSON.stringify(diagramData);
    for (const res of clients) {
        res.write(`data: ${payload}\n\n`);
    }
}

session = await joinSession({
    hooks: {
        onUserPromptSubmitted: async () => {
            // Find the most recently active selection across all instances
            let sel = null;
            for (const [, s] of selections) {
                sel = s;
            }
            if (!sel) return {};
            if (sel.type === "node") {
                const node = diagramData.nodes.find(n => n.id === sel.id);
                const group = node?.group ? diagramData.groups.find(g => g.id === node.group) : null;
                const inEdges = diagramData.edges.filter(e => e.target === sel.id || e.target === node?.group);
                const outEdges = diagramData.edges.filter(e => e.source === sel.id || e.source === node?.group);
                return {
                    additionalContext: `[Architecture Diagram Selection] The user has selected the "${sel.label}" node in the architecture diagram.${group ? ` It belongs to the "${group.label}" group.` : ""} Incoming connections: ${inEdges.map(e => `${e.source} → ${sel.id} (${e.label})`).join(", ") || "none"}. Outgoing connections: ${outEdges.map(e => `${sel.id} → ${e.target} (${e.label})`).join(", ") || "none"}.`,
                };
            }
            if (sel.type === "edge") {
                const edge = diagramData.edges.find(e => e.id === sel.id);
                const sourceNode = diagramData.nodes.find(n => n.id === sel.source) || diagramData.groups.find(g => g.id === sel.source);
                const targetNode = diagramData.nodes.find(n => n.id === sel.target) || diagramData.groups.find(g => g.id === sel.target);
                return {
                    additionalContext: `[Architecture Diagram Selection] The user has selected the edge "${sel.label || edge?.label}" connecting "${sourceNode?.label || sel.source}" → "${targetNode?.label || sel.target}" (type: ${edge?.type || "unknown"}).`,
                };
            }
            return {};
        },
    },
    canvases: [
        createCanvas({
            id: "arch-diagram",
            displayName: "Architecture Diagram",
            description: "Interactive architecture diagram with ELK.js auto-layout showing system components and their relationships.",
            actions: [
                {
                    name: "reload",
                    description: "Reload the diagram from docs/architecture/diagram.json and push the update to all open canvas instances.",
                    handler: async (ctx) => {
                        diagramData = loadDiagramData();
                        if (ctx.instanceId && sseClients.has(ctx.instanceId)) {
                            pushUpdate(ctx.instanceId);
                        } else {
                            for (const id of sseClients.keys()) {
                                pushUpdate(id);
                            }
                        }
                        return { status: "reloaded", title: diagramData.title, nodes: diagramData.nodes.length, edges: diagramData.edges.length };
                    },
                },
                {
                    name: "get_selection",
                    description: "Get the currently selected node or edge in the architecture diagram, including its connections and metadata.",
                    handler: async (ctx) => {
                        const sel = selections.get(ctx.instanceId) || [...selections.values()].pop();
                        if (!sel) return { selection: null, message: "Nothing selected. Click a node or edge in the diagram first." };
                        if (sel.type === "node") {
                            const node = diagramData.nodes.find(n => n.id === sel.id);
                            const group = node?.group ? diagramData.groups.find(g => g.id === node.group) : null;
                            const inEdges = diagramData.edges.filter(e => e.target === sel.id || e.target === node?.group);
                            const outEdges = diagramData.edges.filter(e => e.source === sel.id || e.source === node?.group);
                            return { selection: sel, group: group?.label || null, incomingEdges: inEdges, outgoingEdges: outEdges };
                        }
                        if (sel.type === "edge") {
                            const edge = diagramData.edges.find(e => e.id === sel.id);
                            const sourceNode = diagramData.nodes.find(n => n.id === sel.source) || diagramData.groups.find(g => g.id === sel.source);
                            const targetNode = diagramData.nodes.find(n => n.id === sel.target) || diagramData.groups.find(g => g.id === sel.target);
                            return { selection: sel, edge, sourceLabel: sourceNode?.label, targetLabel: targetNode?.label };
                        }
                        return { selection: sel };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Scope Architecture", url: entry.url };
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
