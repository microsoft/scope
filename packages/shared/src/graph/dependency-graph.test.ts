// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { DependencyGraph, type DependencyNode } from "./dependency-graph.js";

/**
 * Diamond DAG used across tests:
 *
 *        root
 *       /    \
 *     left  right
 *       \    /
 *        leaf      island (no edges)
 */
const diamond: DependencyNode[] = [
  { id: "leaf", dependsOn: ["left", "right"] },
  { id: "left", dependsOn: ["root"] },
  { id: "right", dependsOn: ["root"] },
  { id: "root" },
  { id: "island", dependsOn: [] },
];

describe("DependencyGraph construction", () => {
  it("accepts an empty graph", () => {
    const graph = new DependencyGraph([]);
    expect(graph.getAllNodes()).toEqual([]);
    expect(graph.topologicalSort()).toEqual([]);
  });

  it("rejects duplicate node ids", () => {
    expect(() => new DependencyGraph([{ id: "a" }, { id: "a" }])).toThrow("Duplicate node id 'a'");
  });

  it("rejects a dependency on an unknown node", () => {
    expect(() => new DependencyGraph([{ id: "a", dependsOn: ["missing"] }])).toThrow(
      "Node 'a' depends on unknown node 'missing'",
    );
  });

  it("rejects a self-dependency", () => {
    expect(() => new DependencyGraph([{ id: "a", dependsOn: ["a"] }])).toThrow("Cycle detected");
  });

  it("rejects a multi-node cycle", () => {
    const nodes = [
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];
    expect(() => new DependencyGraph(nodes)).toThrow("Cycle detected");
  });

  it("detects a cycle in a component disconnected from the first node", () => {
    const nodes = [{ id: "ok" }, { id: "x", dependsOn: ["y"] }, { id: "y", dependsOn: ["x"] }];
    expect(() => new DependencyGraph(nodes)).toThrow("Cycle detected");
  });
});

describe("DependencyGraph traversal", () => {
  const graph = new DependencyGraph(diamond);

  it("returns transitive ancestors without duplicates", () => {
    expect(graph.getAncestors("leaf")).toEqual(new Set(["left", "right", "root"]));
    expect(graph.getAncestors("left")).toEqual(new Set(["root"]));
    expect(graph.getAncestors("root")).toEqual(new Set());
  });

  it("returns transitive descendants without duplicates", () => {
    expect(graph.getDescendants("root")).toEqual(new Set(["left", "right", "leaf"]));
    expect(graph.getDescendants("leaf")).toEqual(new Set());
  });

  it("returns empty sets for unknown nodes", () => {
    expect(graph.getAncestors("nope")).toEqual(new Set());
    expect(graph.getDescendants("nope")).toEqual(new Set());
  });

  it("orders every parent before its children", () => {
    const order = graph.topologicalSort();

    expect(order).toHaveLength(diamond.length);
    for (const node of diamond) {
      for (const parent of node.dependsOn ?? []) {
        expect(order.indexOf(parent)).toBeLessThan(order.indexOf(node.id));
      }
    }
  });

  it("looks up nodes by id, including through the deprecated aliases", () => {
    expect(graph.getNode("left")).toEqual(diamond[1]);
    expect(graph.getNode("nope")).toBeUndefined();
    expect(graph.getCriterion("left")).toBe(graph.getNode("left"));
    expect(graph.getAllCriteria()).toEqual(graph.getAllNodes());
    expect(graph.getAllNodes().map((n) => n.id).sort()).toEqual(["island", "leaf", "left", "right", "root"]);
  });
});

describe("DependencyGraph.getRootFailures", () => {
  const graph = new DependencyGraph(diamond);

  it("keeps only failures without a failing ancestor (criteria results)", () => {
    const results = [
      { criterionId: "root", passed: true },
      { criterionId: "left", passed: false },
      { criterionId: "right", passed: true },
      { criterionId: "leaf", passed: false },
      { criterionId: "island", passed: false },
    ];

    expect(graph.getRootFailures(results).map((r) => r.criterionId)).toEqual(["left", "island"]);
  });

  it("supports prompt-feature results keyed by featureId/detected", () => {
    const results = [
      { featureId: "root", detected: false },
      { featureId: "left", detected: false },
      { featureId: "island", detected: true },
    ];

    expect(graph.getRootFailures(results).map((r) => r.featureId)).toEqual(["root"]);
  });

  it("treats results with neither passed nor detected as non-failures", () => {
    expect(graph.getRootFailures([{ criterionId: "root" }])).toEqual([]);
  });

  it("does not suppress a failure whose failing ancestor has no result", () => {
    // `root` is not in the result set, so `left` is still a root failure.
    expect(graph.getRootFailures([{ criterionId: "left", passed: false }])).toHaveLength(1);
  });
});
