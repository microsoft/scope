// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { List, Plus, X, AlertTriangle } from "lucide-react";
import type { CriteriaGraphData } from "@/types";
import { GATE_ORDER, GATE_METADATA, isCriterionCompatibleWithGate, type GateId } from "@/lib/gates";
import { useVisibleGates } from "@/hooks/useVisibleGates";
import { useRef, useState, useMemo } from "react";
import { findCycles } from "@/lib/graph-cycles";

// Simple DAG layout using topological sort + layering. Exported for testing.
export function layoutGraph(graph: CriteriaGraphData) {
  const { nodes, edges } = graph;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    children.set(n.id, []);
  }
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    children.get(e.source)?.push(e.target);
  }

  // Topological layering (Kahn's algorithm), made robust to cycles: if the
  // remaining subgraph has no in-degree-0 node (i.e. a cycle), force-place the
  // lowest in-degree node to break the deadlock so every node still gets laid
  // out instead of the whole canvas rendering blank.
  const layers: string[][] = [];
  const remaining = new Set(nodes.map((n) => n.id));

  while (remaining.size > 0) {
    let ready = [...remaining].filter((id) => (inDegree.get(id) ?? 0) <= 0);
    if (ready.length === 0) {
      let forced: string | null = null;
      let min = Infinity;
      for (const id of remaining) {
        const d = inDegree.get(id) ?? 0;
        if (d < min) {
          min = d;
          forced = id;
        }
      }
      ready = forced ? [forced] : [...remaining];
    }
    layers.push([...ready]);
    for (const id of ready) {
      remaining.delete(id);
      for (const child of children.get(id) ?? []) {
        inDegree.set(child, (inDegree.get(child) ?? 1) - 1);
      }
    }
  }

  // Identify genuine cycles via strongly-connected components (graphlib's
  // Tarjan, see lib/graph-cycles). Every node in an SCC of size > 1 (or with a
  // self-edge) is part of a cycle, and so is every edge whose endpoints share
  // that SCC. This is layout-independent — unlike a back-edge heuristic it
  // doesn't depend on which node the layering happened to place first — so the
  // user always sees the same, correct loop.
  const { cycleNodes, cycleEdges, cycleGroups } = findCycles(nodes, edges);

  // Assign positions with dynamic node widths
  const NODE_H = 60;
  const H_GAP = 40;
  const V_GAP = 80;
  const CHAR_WIDTH_PX = 7.5; // slightly wider for SVG text rendering
  const NODE_PADDING_PX = 40;
  const NODE_MIN_W = 180;

  const nodeWidths = new Map<string, number>();
  for (const n of nodes) {
    const w = Math.max(NODE_MIN_W, Math.ceil(n.id.length * CHAR_WIDTH_PX + NODE_PADDING_PX));
    nodeWidths.set(n.id, w);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (let layer = 0; layer < layers.length; layer++) {
    const row = layers[layer];
    const totalWidth = row.reduce((sum, id) => sum + (nodeWidths.get(id) ?? NODE_MIN_W), 0) + (row.length - 1) * H_GAP;
    let curX = -totalWidth / 2;
    for (let i = 0; i < row.length; i++) {
      const w = nodeWidths.get(row[i]) ?? NODE_MIN_W;
      positions.set(row[i], {
        x: curX + w / 2,
        y: layer * (NODE_H + V_GAP),
      });
      curX += w + H_GAP;
    }
  }

  const totalH = layers.length * (NODE_H + V_GAP) - V_GAP;
  const allX = [...positions.entries()].map(([id, p]) => {
    const w = nodeWidths.get(id) ?? NODE_MIN_W;
    return [p.x - w / 2, p.x + w / 2];
  }).flat();
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const totalW = maxX - minX;

  return { nodeMap, positions, nodeWidths, NODE_MIN_W, NODE_H, totalW, totalH, minX, edges, cycleEdges, cycleNodes, cycleGroups };
}

/** Keep criteria with no visible dependency edge out of the graph layout. */
export function separateIndependentCriteria(graph: CriteriaGraphData) {
  const connectedIds = new Set(graph.edges.flatMap((edge) => [edge.source, edge.target]));
  return {
    linkedGraph: {
      nodes: graph.nodes.filter((node) => connectedIds.has(node.id)),
      edges: graph.edges,
    },
    independentNodes: graph.nodes.filter((node) => !connectedIds.has(node.id)),
  };
}

export interface EdgeRenderSpec {
  /** Straight edges keep the exact `<line>` geometry used for acyclic DAGs. */
  straight: boolean;
  line?: { x1: number; y1: number; x2: number; y2: number };
  /** SVG path `d` for curved/self edges. */
  d?: string;
}

// Decide how to draw a single edge. Straight downward edges (the common DAG
// case) are emitted verbatim as a `<line>` so acyclic graphs look identical to
// before. Edges that would otherwise overlap or run "backwards" — bidirectional
// pairs, back-edges, and self-loops, all of which only occur inside cycles — are
// routed as curves so every arrow stays individually visible. Exported for test.
export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: {
    needsCurve: boolean;
    isSelf: boolean;
    side: number; // +1 | -1: which way the curve bows, so a→b and b→a separate
    nodeH: number;
    sourceWidth: number;
  },
): EdgeRenderSpec {
  const { needsCurve, isSelf, side, nodeH, sourceWidth } = opts;

  if (isSelf) {
    // Teardrop loop anchored on the node's right edge.
    const rx = from.x + sourceWidth / 2;
    const top = from.y + nodeH * 0.3;
    const bot = from.y + nodeH * 0.7;
    const r = 38;
    const d = `M ${rx} ${top} C ${rx + r} ${top - r}, ${rx + r} ${bot + r}, ${rx} ${bot}`;
    return { straight: false, d };
  }

  if (!needsCurve) {
    return {
      straight: true,
      line: { x1: from.x, y1: from.y + nodeH, x2: to.x, y2: to.y },
    };
  }

  // A back-edge points to a node on the same or an earlier row. Anchor it on the
  // top of the source / bottom of the target (instead of bottom→top) so it leaves
  // and enters on the sides facing each other, then bow it clear of the nodes in
  // between.
  const isBack = to.y <= from.y;
  const sx = from.x;
  const sy = isBack ? from.y : from.y + nodeH;
  const ex = to.x;
  const ey = isBack ? to.y + nodeH : to.y;

  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const mag = (40 + 0.25 * len) * side;
  const cx = (sx + ex) / 2 + px * mag;
  const cy = (sy + ey) / 2 + py * mag;
  const d = `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
  return { straight: false, d };
}

export function CriteriaGraphView() {
  const { data: graph, isLoading } = useQuery({
    queryKey: ["criteria-graph"],
    queryFn: api.getCriteriaGraph,
  });

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedGates, setSelectedGates] = useState<GateId[]>([]);
  const visibleGates = useVisibleGates();

  const toggleGate = (gate: GateId) =>
    setSelectedGates((prev) => (prev.includes(gate) ? prev.filter((g) => g !== gate) : [...prev, gate]));

  // Gate option counts come from the unfiltered graph so they stay stable.
  const gateCounts = useMemo(() => {
    const counts = new Map<GateId, number>();
    for (const gate of GATE_ORDER) {
      counts.set(gate, (graph?.nodes ?? []).filter((n) => isCriterionCompatibleWithGate(n.gates, gate)).length);
    }
    return counts;
  }, [graph]);

  // Filter to nodes compatible with any selected gate (OR); drop edges whose
  // endpoints were filtered out so the DAG layout stays consistent.
  const filteredGraph = useMemo<CriteriaGraphData | null>(() => {
    if (!graph) return null;
    if (selectedGates.length === 0) return graph;
    const nodes = graph.nodes.filter((n) => selectedGates.some((g) => isCriterionCompatibleWithGate(n.gates, g)));
    const kept = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
    return { nodes, edges };
  }, [graph, selectedGates]);

  // Split after gate filtering so a criterion with no visible edge is listed separately.
  const separated = useMemo(
    () => (filteredGraph ? separateIndependentCriteria(filteredGraph) : null),
    [filteredGraph],
  );
  const layout = useMemo(
    () => (separated?.linkedGraph.nodes.length ? layoutGraph(separated.linkedGraph) : null),
    [separated],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="text-center py-12 text-muted-foreground">No criteria data</div>
    );
  }

  const gateFilterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Gate:</span>
      {visibleGates.map((gate) => {
        const active = selectedGates.includes(gate);
        const count = gateCounts.get(gate) ?? 0;
        return (
          <button key={gate} type="button" onClick={() => toggleGate(gate)} className="focus:outline-none">
            <Badge variant={active ? "default" : "outline"} className="cursor-pointer gap-1">
              {GATE_METADATA[gate].label}
              <span className="opacity-60">{count}</span>
            </Badge>
          </button>
        );
      })}
      {selectedGates.length > 0 && (
        <button
          type="button"
          onClick={() => setSelectedGates([])}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      )}
    </div>
  );

  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Criteria Graph</h1>
        <p className="text-muted-foreground">
          Dependency DAG — {separated!.linkedGraph.nodes.length} connected criteria, {filteredGraph!.edges.length} edges
          {separated!.independentNodes.length > 0 && ` · ${separated!.independentNodes.length} independent`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link to="/criteria">
          <Button variant="outline" className="gap-1.5">
            <List className="h-4 w-4" /> List View
          </Button>
        </Link>
        <Link to="/criteria/new">
          <Button className="gap-1.5">
            <Plus className="h-4 w-4" /> New Criterion
          </Button>
        </Link>
      </div>
    </div>
  );

  const independentList = separated!.independentNodes.length > 0 && (
    <Card>
      <CardContent className="p-4">
        <h2 className="mb-3 text-sm font-semibold">
          Independent criteria ({separated!.independentNodes.length})
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {separated!.independentNodes.map((node) => (
            <Link key={node.id} to={`/criteria/${node.id}`} className="min-w-0 rounded-md border p-3 hover:bg-accent">
              <span className="block truncate font-mono text-sm font-medium">{node.id}</span>
              <span className="block truncate text-xs text-muted-foreground" title={node.prompt}>{node.prompt}</span>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );

  if (filteredGraph!.nodes.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        {gateFilterBar}
        <div className="text-center py-12 text-muted-foreground">
          No criteria are compatible with the selected gate{selectedGates.length > 1 ? "s" : ""}.
        </div>
      </div>
    );
  }

  if (!layout) {
    return <div className="space-y-6">{header}{gateFilterBar}{independentList}</div>;
  }

  const { nodeMap, positions, nodeWidths, NODE_MIN_W, NODE_H, totalW, totalH, minX, edges, cycleEdges, cycleNodes, cycleGroups } = layout;
  const PADDING = 60;
  const viewBox = `${minX - PADDING} ${-PADDING} ${totalW + PADDING * 2} ${totalH + PADDING * 2 + NODE_H}`;

  // Edges connected to hovered node
  const hoveredEdges = new Set<string>();
  const hoveredNodes = new Set<string>();
  if (hoveredNode) {
    hoveredNodes.add(hoveredNode);
    for (const e of edges) {
      if (e.source === hoveredNode || e.target === hoveredNode) {
        hoveredEdges.add(`${e.source}->${e.target}`);
        hoveredNodes.add(e.source);
        hoveredNodes.add(e.target);
      }
    }
  }

  const edgeKeySet = new Set(edges.map((e) => `${e.source}->${e.target}`));

  return (
    <div className="space-y-6">
      {header}
      {gateFilterBar}

      {cycleGroups.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            Circular {cycleGroups.length === 1 ? "dependency" : "dependencies"} detected
          </AlertTitle>
          <AlertDescription>
            <p className="mb-2">
              {cycleGroups.length === 1 ? "This set of criteria forms" : "These sets of criteria form"}{" "}
              a dependency loop — each criterion transitively depends on itself, so there is no valid
              evaluation order. Remove one of the dependencies in the loop (the dashed red edges) to
              break it.
            </p>
            <ul className="space-y-1">
              {cycleGroups.map((group) => (
                <li key={group.join("|")} className="font-mono text-xs">
                  {group.map((id, i) => (
                    <span key={id}>
                      {i > 0 && <span className="opacity-60"> ↔ </span>}
                      <Link to={`/criteria/${id}`} className="underline underline-offset-2">
                        {id}
                      </Link>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-2">
          <div ref={containerRef} className="overflow-auto max-h-[70vh] rounded">
            <svg
              ref={svgRef}
              viewBox={viewBox}
              className="w-full min-h-[400px]"
              style={{ minWidth: Math.max(600, totalW + PADDING * 2) }}
            >
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="10"
                  markerHeight="7"
                  refX="10"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" className="fill-muted-foreground/50" />
                </marker>
                <marker
                  id="arrowhead-active"
                  markerWidth="10"
                  markerHeight="7"
                  refX="10"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" className="fill-primary" />
                </marker>
                <marker
                  id="arrowhead-cycle"
                  markerWidth="10"
                  markerHeight="7"
                  refX="10"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" className="fill-destructive" />
                </marker>
              </defs>

              {/* Edges */}
              {edges.map((e) => {
                const from = positions.get(e.source);
                const to = positions.get(e.target);
                if (!from || !to) return null;
                const edgeKey = `${e.source}->${e.target}`;
                const isActive = hoveredEdges.has(edgeKey);
                const isCycle = cycleEdges.has(edgeKey);

                const isSelf = e.source === e.target;
                const reverseExists = edgeKeySet.has(`${e.target}->${e.source}`);
                const isBack = to.y <= from.y;
                const needsCurve = isSelf || reverseExists || isBack;
                // Side is stable per unordered pair so a↔b edges share it; the
                // perpendicular flips with edge direction, bowing them apart.
                const pairKey =
                  e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
                let h = 0;
                for (let i = 0; i < pairKey.length; i++) h = (h * 31 + pairKey.charCodeAt(i)) | 0;
                const side = h % 2 === 0 ? 1 : -1;
                const spec = edgePath(from, to, {
                  needsCurve,
                  isSelf,
                  side,
                  nodeH: NODE_H,
                  sourceWidth: nodeWidths.get(e.source) ?? NODE_MIN_W,
                });

                const strokeWidth = isCycle || isActive ? 2 : 1;
                const className = isCycle
                  ? "stroke-destructive"
                  : isActive
                    ? "stroke-primary"
                    : "stroke-muted-foreground/30";
                const markerEnd = isCycle
                  ? "url(#arrowhead-cycle)"
                  : isActive
                    ? "url(#arrowhead-active)"
                    : "url(#arrowhead)";
                const dash = isCycle ? "6 4" : undefined;

                if (spec.straight && spec.line) {
                  return (
                    <line
                      key={edgeKey}
                      x1={spec.line.x1}
                      y1={spec.line.y1}
                      x2={spec.line.x2}
                      y2={spec.line.y2}
                      strokeWidth={strokeWidth}
                      strokeDasharray={dash}
                      className={className}
                      markerEnd={markerEnd}
                    />
                  );
                }

                return (
                  <path
                    key={edgeKey}
                    d={spec.d}
                    fill="none"
                    strokeWidth={strokeWidth}
                    strokeDasharray={dash}
                    className={className}
                    markerEnd={markerEnd}
                  />
                );
              })}

              {/* Nodes */}
              {[...positions.entries()].map(([id, pos]) => {
                const node = nodeMap.get(id);
                if (!node) return null;
                const deps = node.dependsOn?.length ?? 0;
                const isActive = hoveredNode ? hoveredNodes.has(id) : true;
                const isCycleNode = cycleNodes.has(id);
                const nodeW = nodeWidths.get(id) ?? NODE_MIN_W;
                return (
                  <g
                    key={id}
                    transform={`translate(${pos.x - nodeW / 2}, ${pos.y})`}
                    onMouseEnter={() => setHoveredNode(id)}
                    onMouseLeave={() => setHoveredNode(null)}
                    className="cursor-pointer"
                  >
                    <Link to={`/criteria/${id}`}>
                      <rect
                        width={nodeW}
                        height={NODE_H}
                        rx={8}
                        className={
                          isCycleNode
                            ? "fill-background stroke-destructive stroke-2"
                            : isActive
                              ? "fill-background stroke-primary stroke-2"
                              : "fill-muted/50 stroke-muted-foreground/20 stroke-1"
                        }
                      />
                      <text
                        x={nodeW / 2}
                        y={NODE_H / 2 - 4}
                        textAnchor="middle"
                        className={`text-xs font-mono font-medium ${isActive ? "fill-foreground" : "fill-muted-foreground/50"}`}
                      >
                        {id}
                      </text>
                      <text
                        x={nodeW / 2}
                        y={NODE_H / 2 + 12}
                        textAnchor="middle"
                        className={`text-[10px] ${isActive ? "fill-muted-foreground" : "fill-muted-foreground/30"}`}
                      >
                        {deps > 0 ? `${deps} dep${deps > 1 ? "s" : ""}` : "root"}
                      </text>
                    </Link>
                  </g>
                );
              })}
            </svg>
          </div>
        </CardContent>
      </Card>

      {independentList}

      {/* Legend */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded border-2 border-primary bg-background" />
          Criterion node
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-0.5 bg-muted-foreground/30" />
          Dependency edge (parent → child)
        </div>
        {cycleEdges.size > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-6 border-t-2 border-dashed border-destructive" />
            <span className="text-destructive">Circular dependency</span>
          </div>
        )}
        <span>Hover a node to highlight its connections</span>
      </div>
    </div>
  );
}
