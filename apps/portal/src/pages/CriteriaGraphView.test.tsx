// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { layoutGraph, edgePath, separateIndependentCriteria } from "./CriteriaGraphView";
import type { CriteriaGraphData } from "@/types";

function node(id: string) {
  return { id, prompt: id, dependsOn: [] as string[], gates: undefined };
}

function graphOf(ids: string[], edges: Array<[string, string]>): CriteriaGraphData {
  return {
    nodes: ids.map(node),
    edges: edges.map(([source, target]) => ({ source, target })),
  } as unknown as CriteriaGraphData;
}

describe("separateIndependentCriteria", () => {
  it("keeps only connected criteria in the graph and lists isolated criteria", () => {
    const graph = graphOf(["root", "child", "standalone"], [["root", "child"]]);
    const { linkedGraph, independentNodes } = separateIndependentCriteria(graph);

    expect(linkedGraph.nodes.map((node) => node.id)).toEqual(["root", "child"]);
    expect(linkedGraph.edges).toEqual(graph.edges);
    expect(independentNodes.map((node) => node.id)).toEqual(["standalone"]);
  });

  it("supports a selection with only independent criteria", () => {
    const { linkedGraph, independentNodes } = separateIndependentCriteria(graphOf(["a", "b"], []));
    expect(linkedGraph.nodes).toEqual([]);
    expect(independentNodes.map((node) => node.id)).toEqual(["a", "b"]);
  });
});

describe("layoutGraph", () => {
  it("lays out an acyclic graph with all nodes positioned", () => {
    const graph = graphOf(["a", "b", "c"], [
      ["a", "b"],
      ["a", "c"],
    ]);

    const { positions } = layoutGraph(graph);
    expect(positions.size).toBe(3);
    expect([...positions.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  // Regression: a cyclic subgraph (e.g. the Test gate where the data contains a
  // back-edge) used to leave Kahn's algorithm with no in-degree-0 root, yielding
  // empty positions and a blank canvas. Every node must still be placed.
  it("still positions every node when the graph contains a cycle", () => {
    const graph = graphOf(["tests_pass", "has_70p", "has_90p"], [
      ["tests_pass", "has_70p"],
      ["tests_pass", "has_90p"],
      ["has_70p", "has_90p"],
      ["has_90p", "tests_pass"], // back-edge → cycle
    ]);

    const { positions, totalW, totalH } = layoutGraph(graph);
    expect(positions.size).toBe(3);
    expect([...positions.keys()].sort()).toEqual(["has_70p", "has_90p", "tests_pass"]);
    expect(Number.isFinite(totalW)).toBe(true);
    expect(Number.isFinite(totalH)).toBe(true);
  });

  it("surfaces cycle info through the layout result", () => {
    const graph = graphOf(["x", "y"], [
      ["x", "y"],
      ["y", "x"],
    ]);
    const { cycleEdges, cycleNodes, cycleGroups } = layoutGraph(graph);
    expect(cycleEdges.size).toBe(2);
    expect(cycleNodes.size).toBe(2);
    expect(cycleGroups.length).toBe(1);
  });
});

describe("edgePath", () => {
  const NODE_H = 60;
  const W = 180;

  it("draws a forward non-overlapping edge as a straight line", () => {
    const spec = edgePath(
      { x: 0, y: 0 },
      { x: 0, y: 140 },
      { needsCurve: false, isSelf: false, side: 1, nodeH: NODE_H, sourceWidth: W },
    );
    expect(spec.straight).toBe(true);
    expect(spec.line).toEqual({ x1: 0, y1: NODE_H, x2: 0, y2: 140 });
    expect(spec.d).toBeUndefined();
  });

  it("bows a bidirectional pair to opposite sides when they share a side value", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 0, y: 140 };
    const opts = { needsCurve: true, isSelf: false, side: 1, nodeH: NODE_H, sourceWidth: W };
    // Both directed edges of a pair use the SAME side; the perpendicular flips
    // with direction, so the two arcs bow to physically opposite sides.
    const ab = edgePath(from, to, opts);
    const ba = edgePath(to, from, opts);
    expect(ab.straight).toBe(false);
    expect(ba.straight).toBe(false);
    const cxAb = Number(ab.d!.split("Q")[1].trim().split(/\s+/)[0]);
    const cxBa = Number(ba.d!.split("Q")[1].trim().split(/\s+/)[0]);
    expect(Math.sign(cxAb)).not.toBe(Math.sign(cxBa));
  });

  it("anchors a back-edge on the top of the source", () => {
    // source is laid out BELOW the target (larger y) → back-edge.
    const spec = edgePath(
      { x: 10, y: 200 },
      { x: 10, y: 0 },
      { needsCurve: true, isSelf: false, side: 1, nodeH: NODE_H, sourceWidth: W },
    );
    expect(spec.straight).toBe(false);
    // Path starts at the source's top (y === from.y), not its bottom.
    expect(spec.d!.startsWith("M 10 200")).toBe(true);
  });

  it("renders a self-edge as a closed-ish loop path", () => {
    const spec = edgePath(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { needsCurve: true, isSelf: true, side: 1, nodeH: NODE_H, sourceWidth: W },
    );
    expect(spec.straight).toBe(false);
    expect(spec.d).toMatch(/^M .* C /);
    expect(spec.line).toBeUndefined();
  });
});
