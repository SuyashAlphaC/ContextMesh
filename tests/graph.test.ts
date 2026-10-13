import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HydraGraph, vertexId } from "../server/graph";
import { Store } from "../server/store";
import { config } from "../server/config";
let store: Store;
const original = { ...config };
beforeEach(() => {
  store = new Store(":memory:");
  Object.assign(config, original, {
    hydraUrl: "http://hydra.test",
    hydraToken: "test-token",
  });
});
afterEach(() => {
  store.close();
  Object.assign(config, original);
  vi.unstubAllGlobals();
});
describe("HydraDB protocol", () => {
  it("uses stable safe integer vertex IDs", () => {
    expect(vertexId("maya")).toBe(vertexId("maya"));
    expect(Number.isSafeInteger(vertexId("maya"))).toBe(true);
    expect(vertexId("arjun")).not.toBe(vertexId("maya"));
  });
  it("writes replayable supported upserts and scopes revision checkpoints", async () => {
    const requests: { query: string; parameters: Record<string, unknown> }[] =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return Response.json({ columns: [], rows: [] });
      }),
    );
    const graph = new HydraGraph(store);
    await graph.sync(store.read());
    expect(graph.lastError).toBe("");
    expect(requests[0].query).toContain("UNWIND $rows");
    expect(requests[1].query).toContain("MERGE (a {id: $source})");
    const count = requests.length;
    await graph.sync(store.read());
    expect(requests).toHaveLength(count);
    config.hydraGraph = "another-graph";
    await graph.sync(store.read());
    expect(requests.length).toBeGreaterThan(count);
  });
  it("fails closed when the configured graph is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const graph = new HydraGraph(store);
    await expect(graph.context("greencart", store.read())).rejects.toThrow(
      "503",
    );
  });
  it("retrieves project, incoming funding and workspace relationships", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        queries.push(body.query);
        return Response.json({
          columns: [],
          rows: [[{ type: "string", value: "context" }]],
        });
      }),
    );
    const graph = new HydraGraph(store);
    const context = await graph.context("greencart", store.read());
    expect(context.source).toBe("HydraDB");
    expect(context).toHaveProperty("funding");
    expect(context).toHaveProperty("collaborators");
    expect(queries.at(-2)).toContain("->(p:ContextEntity");
  });
});
