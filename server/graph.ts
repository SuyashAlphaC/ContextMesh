import type { State, GraphNode, GraphEdge } from "../shared/types.js";
import { config } from "./config.js";
import type { Store } from "./store.js";
import { createHash } from "node:crypto";
export function vertexId(key: string) {
  return Number.parseInt(
    createHash("sha256")
      .update(`contextmesh:${key}`)
      .digest("hex")
      .slice(0, 12),
    16,
  );
}
export function buildGraph(state: State) {
  const nodes: GraphNode[] = [
    {
      id: "workspace",
      label: "Your agency",
      type: "Organization",
      properties: {},
    },
    { id: "taxes", label: "Tax reserve", type: "Reserve", properties: {} },
    {
      id: "expenses",
      label: "Operating expenses",
      type: "Reserve",
      properties: {},
    },
  ];
  const edges: GraphEdge[] = [];
  const link = (source: string, target: string, type: string) =>
    edges.push({ id: `${source}:${type}:${target}`, source, target, type });
  for (const r of state.recipients) {
    nodes.push({
      id: r.id,
      label: r.name,
      type: "Recipient",
      properties: {
        trusted: r.trusted,
        accountVersion: r.accountVersion,
        role: r.role,
      },
    });
    link("workspace", r.id, "COLLABORATES_WITH");
  }
  for (const p of state.projects) {
    nodes.push({
      id: p.id,
      label: p.name,
      type: "Project",
      properties: {
        client: p.client,
        amountCents: p.amountCents,
        status: p.status,
      },
    });
    nodes.push({
      id: `invoice:${p.id}`,
      label: p.status === "paid" ? "Confirmed payment" : "Awaiting payment",
      type: "Invoice",
      properties: {
        amountCents: p.amountCents,
        status: p.status,
        paypalId: p.captureId || "",
      },
    });
    link("workspace", p.id, "OWNS");
    link(`invoice:${p.id}`, p.id, "FUNDS");
  }
  for (const plan of state.plans) {
    nodes.push({
      id: plan.id,
      label: `Plan · ${plan.status.replaceAll("_", " ")}`,
      type: "Plan",
      properties: {
        status: plan.status,
        instruction: plan.instruction,
        createdAt: plan.createdAt,
        approvedAt: plan.approvedAt || "",
        payoutBatchId: plan.payoutBatchId || "",
        allocations: JSON.stringify(plan.allocations),
        explanation: plan.explanation,
        evidence: JSON.stringify(plan.evidence),
      },
    });
    link(plan.projectId, plan.id, "HAS_PLAN");
    for (const a of plan.allocations)
      link(plan.id, a.targetId, a.kind === "reserve" ? "RESERVES" : "PAYS");
  }
  return { nodes, edges };
}
export class HydraGraph {
  lastError = "";
  constructor(private store: Store) {}
  async query(query: string, parameters: Record<string, unknown> = {}) {
    if (!config.hydraUrl) throw new Error("HydraDB is not configured.");
    const response = await fetch(
      `${config.hydraUrl.replace(/\/$/, "")}/v1/graphs/${encodeURIComponent(config.hydraGraph)}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.hydraToken}`,
          "X-Graph-Namespace": config.hydraNamespace,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cell_id: config.hydraCell,
          query,
          parameters,
          consistency: "strong",
          timeout_ms: 10000,
          page_size: 256,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new Error(`HydraDB query failed (${response.status}).`);
    return (await response.json()) as {
      columns: string[];
      rows: { type: string; value?: unknown }[][];
    };
  }
  async sync(state: State) {
    const checkpoint = `graphRevision:${config.hydraUrl}:${config.hydraNamespace}:${config.hydraGraph}:${config.hydraCell}`;
    if (
      !config.hydraUrl ||
      this.store.meta(checkpoint) === String(state.graphRevision)
    )
      return;
    try {
      const graph = buildGraph(state);
      // Each batch is replayable; the local revision remains pending until all writes succeed.
      const rows = graph.nodes.map((node) => ({
        id: vertexId(node.id),
        key: node.id,
        label: node.label,
        kind: node.type,
        payload: JSON.stringify(node.properties),
      }));
      if (new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new Error("Graph vertex ID collision. Synchronization stopped.");
      await this.query(
        "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:ContextEntity, n.key = row.key, n.label = row.label, n.kind = row.kind, n.payload = row.payload",
        { rows },
      );
      for (const edge of graph.edges)
        await this.query(
          "MERGE (a {id: $source})-[r:CONTEXT_LINK {key: $key, kind: $kind}]->(b {id: $target})",
          {
            source: vertexId(edge.source),
            target: vertexId(edge.target),
            key: edge.id,
            kind: edge.type,
          },
        );
      this.store.setMeta(checkpoint, String(state.graphRevision));
      this.lastError = "";
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : "Graph sync failed";
    }
  }
  async context(projectId: string, state: State) {
    if (!config.hydraUrl)
      return { source: "local graph", graph: buildGraph(state) };
    await this.sync(state);
    if (this.lastError) throw new Error(this.lastError);
    const result = await this.query(
      "MATCH (p:ContextEntity {id: $id}) OPTIONAL MATCH (p)-[r:CONTEXT_LINK]->(n:ContextEntity) RETURN p.payload AS project, r.kind AS relationship, n.key AS relatedKey, n.payload AS context",
      { id: vertexId(projectId) },
    );
    if (!result.rows.length)
      throw new Error("HydraDB project context is missing.");
    const funding = await this.query(
      "MATCH (n:ContextEntity)-[r:CONTEXT_LINK]->(p:ContextEntity {id: $id}) RETURN n.key AS key, r.kind AS relationship, n.payload AS context",
      { id: vertexId(projectId) },
    );
    const collaborators = await this.query(
      "MATCH (w:ContextEntity {id: $id})-[r:CONTEXT_LINK]->(n:ContextEntity) RETURN n.key AS key, r.kind AS relationship, n.payload AS context",
      { id: vertexId("workspace") },
    );
    return { source: "HydraDB", result, funding, collaborators };
  }
}
