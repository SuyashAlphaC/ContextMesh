import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { createApp } from "../server/app";
import { ContextMesh } from "../server/service";
import { Store } from "../server/store";
import { config } from "../server/config";
import type { Server } from "node:http";
let server: Server;
let store: Store;
let base: string;
const original = { ...config };
beforeEach(async () => {
  Object.assign(config, original, {
    mode: "demo",
    aiKey: "",
    geminiKey: "",
    aiProvider: "auto",
    hydraUrl: "",
    renderTask: "",
    accessToken: "",
    publicUrl: "http://localhost:5173",
  });
  store = new Store(":memory:");
  server = createApp(new ContextMesh(store)).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((r, reject) =>
    server.close((e) => (e ? reject(e) : r())),
  );
  store.close();
  Object.assign(config, original);
});
const post = (
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
describe("Workspace API", () => {
  it("serves Gemini text through the same protected Studio API without exposing the key", async () => {
    config.geminiKey = "secret-test-key";
    config.aiProvider = "gemini";
    const actualFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (
          typeof input === "string" &&
          input.startsWith("https://generativelanguage.googleapis.com/")
        )
          return Response.json({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  role: "model",
                  parts: [{ text: "Revenue is shown in USD." }],
                },
              },
            ],
          });
        return actualFetch(input, init);
      }),
    );
    const response = await post("/api/studio/model", {
      system: "Analyze",
      messages: [{ role: "user", content: "Show revenue" }],
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Revenue is shown in USD.");
    expect(body).not.toContain(config.geminiKey);
  });
  it("exposes an honest simulation status", async () => {
    const response = await fetch(`${base}/api/state`);
    const data = await response.json();
    expect(data.mode).toBe("demo");
    expect(data.integrations.ai).toBe("Deterministic simulation");
  });
  it("rejects malformed requests and foreign origins", async () => {
    expect((await post("/api/plans", {})).status).toBe(400);
    expect(
      (
        await post(
          "/api/projects/greencart/simulate-payment",
          {},
          { Origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
  });
  it("requires authentication when configured", async () => {
    config.accessToken = "a-long-workspace-access-token";
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    const login = await post("/api/login", { token: config.accessToken });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(
      (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } }))
        .status,
    ).toBe(200);
  });
  it("rejects an unauthenticated workflow callback", async () =>
    expect((await post("/api/internal/workflow/id/execute")).status).toBe(401));
  it("requires approval across the actual HTTP workflow", async () => {
    const response = await post("/api/plans", {
      projectId: "greencart",
      instruction: "Maya 60%, Arjun 25%, taxes 10%, expenses 5%",
    });
    const plan = await response.json();
    expect(response.status).toBe(201);
    expect((await post(`/api/plans/${plan.id}/execute`)).status).toBe(400);
    await post("/api/projects/greencart/simulate-payment");
    await post(`/api/plans/${plan.id}/approve`);
    expect((await post(`/api/plans/${plan.id}/execute`)).status).toBe(200);
    const data = await (await fetch(`${base}/api/state`)).json();
    expect(data.plans[0].status).toBe("completed");
  });
});
