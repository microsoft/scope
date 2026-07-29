// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Generic node in a dependency DAG.
 * Both CriteriaConfig and PromptFeatureConfig satisfy this interface.
 */
export interface DependencyNode {
  id: string;
  dependsOn?: string[];
}

/**
 * Result that can be filtered for root failures.
 * Both CriterionResult and PromptFeatureResult satisfy this interface.
 */
export interface DependencyResult {
  /** The node ID this result refers to */
  criterionId?: string;
  featureId?: string;
  passed?: boolean;
  detected?: boolean;
}

/**
 * Dependency DAG (Directed Acyclic Graph) implementation.
 *
 * A generic graph that manages dependency relationships between nodes.
 * Used by both the criteria system (codebase evaluation) and the
 * prompt features system (task prompt analysis).
 *
 * Provides:
 * - Cycle detection (fail fast on construction)
 * - Topological sort (evaluation order)
 * - Ancestor/descendant computation (transitive closure)
 * - Root failure filtering (failures without failing ancestors)
 */
export class DependencyGraph<T extends DependencyNode = DependencyNode> {
  private registry: Map<string, T>;
  private adjacencyList: Map<string, Set<string>>;      // parent -> children
  private reverseAdjacency: Map<string, Set<string>>;   // child -> parents

  constructor(nodes: T[]) {
    this.registry = new Map();
    this.adjacencyList = new Map();
    this.reverseAdjacency = new Map();

    // Add all nodes to registry
    for (const node of nodes) {
      if (this.registry.has(node.id)) {
        throw new Error(`Duplicate node id '${node.id}'`);
      }
      this.registry.set(node.id, node);
      this.adjacencyList.set(node.id, new Set());
      this.reverseAdjacency.set(node.id, new Set());
    }

    // Build edges (parent -> child)
    for (const node of nodes) {
      if (node.dependsOn && node.dependsOn.length > 0) {
        for (const parentId of node.dependsOn) {
          if (!this.registry.has(parentId)) {
            throw new Error(
              `Node '${node.id}' depends on unknown node '${parentId}'`
            );
          }
          // Add edge: parent -> child
          this.adjacencyList.get(parentId)!.add(node.id);
          this.reverseAdjacency.get(node.id)!.add(parentId);
        }
      }
    }

    // Validate no cycles
    this.validateNoCycles();
  }

  /**
   * Validate no cycles using DFS with visited/visiting sets
   */
  private validateNoCycles(): void {
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const dfs = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) {
        // Found a cycle
        return true;
      }
      if (visited.has(nodeId)) {
        // Already processed
        return false;
      }

      visiting.add(nodeId);

      const children = this.adjacencyList.get(nodeId) || new Set();
      for (const childId of children) {
        if (dfs(childId)) {
          return true;  // Cycle detected
        }
      }

      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };

    // Check all nodes (handles disconnected components)
    for (const nodeId of this.registry.keys()) {
      if (!visited.has(nodeId)) {
        if (dfs(nodeId)) {
          throw new Error('Cycle detected in dependencies');
        }
      }
    }
  }

  /**
   * Get all ancestor IDs (transitive) using BFS
   */
  getAncestors(nodeId: string): Set<string> {
    if (!this.registry.has(nodeId)) {
      return new Set();
    }

    const ancestors = new Set<string>();
    const queue: string[] = [];

    // Start with immediate parents
    const parents = this.reverseAdjacency.get(nodeId) || new Set();
    for (const parentId of parents) {
      queue.push(parentId);
      ancestors.add(parentId);
    }

    // BFS to get all transitive ancestors
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentParents = this.reverseAdjacency.get(current) || new Set();
      for (const parentId of currentParents) {
        if (!ancestors.has(parentId)) {
          ancestors.add(parentId);
          queue.push(parentId);
        }
      }
    }

    return ancestors;
  }

  /**
   * Get all descendant IDs (transitive) using BFS
   */
  getDescendants(nodeId: string): Set<string> {
    if (!this.registry.has(nodeId)) {
      return new Set();
    }

    const descendants = new Set<string>();
    const queue: string[] = [];

    // Start with immediate children
    const children = this.adjacencyList.get(nodeId) || new Set();
    for (const childId of children) {
      queue.push(childId);
      descendants.add(childId);
    }

    // BFS to get all transitive descendants
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentChildren = this.adjacencyList.get(current) || new Set();
      for (const childId of currentChildren) {
        if (!descendants.has(childId)) {
          descendants.add(childId);
          queue.push(childId);
        }
      }
    }

    return descendants;
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns node IDs in evaluation order (parents before children).
   */
  topologicalSort(): string[] {
    const result: string[] = [];
    const inDegree = new Map<string, number>();

    // Calculate in-degree for each node
    for (const nodeId of this.registry.keys()) {
      inDegree.set(nodeId, this.reverseAdjacency.get(nodeId)!.size);
    }

    // Queue for nodes with no incoming edges
    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    // Process nodes
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      // Reduce in-degree of children
      const children = this.adjacencyList.get(current) || new Set();
      for (const childId of children) {
        const newDegree = inDegree.get(childId)! - 1;
        inDegree.set(childId, newDegree);
        if (newDegree === 0) {
          queue.push(childId);
        }
      }
    }

    // If result doesn't include all nodes, there's a cycle (shouldn't happen after validation)
    if (result.length !== this.registry.size) {
      throw new Error('Topological sort failed - cycle detected');
    }

    return result;
  }

  /**
   * Filter to root-cause failures (failures with no failing ancestors).
   *
   * Works with both CriterionResult (criterionId/passed) and
   * PromptFeatureResult (featureId/detected) formats.
   *
   * A result is considered "failed" if passed===false or detected===false.
   * The node ID is read from criterionId or featureId.
   */
  getRootFailures<R extends DependencyResult>(results: R[]): R[] {
    const getNodeId = (r: R): string => (r.criterionId ?? r.featureId ?? '');
    const isFailed = (r: R): boolean => {
      if (r.passed !== undefined) return !r.passed;
      if (r.detected !== undefined) return !r.detected;
      return false;
    };

    const failedIds = new Set<string>();
    for (const result of results) {
      if (isFailed(result)) {
        failedIds.add(getNodeId(result));
      }
    }

    const rootFailures: R[] = [];
    for (const result of results) {
      if (isFailed(result)) {
        const ancestors = this.getAncestors(getNodeId(result));
        const hasFailedAncestor = Array.from(ancestors).some(ancestorId =>
          failedIds.has(ancestorId)
        );
        if (!hasFailedAncestor) {
          rootFailures.push(result);
        }
      }
    }

    return rootFailures;
  }

  /**
   * Get all nodes in the graph
   */
  getAllNodes(): T[] {
    return Array.from(this.registry.values());
  }

  /**
   * Get a single node by ID
   */
  getNode(id: string): T | undefined {
    return this.registry.get(id);
  }

  /** @deprecated Use getAllNodes() instead */
  getAllCriteria(): T[] {
    return this.getAllNodes();
  }

  /** @deprecated Use getNode() instead */
  getCriterion(id: string): T | undefined {
    return this.getNode(id);
  }
}
