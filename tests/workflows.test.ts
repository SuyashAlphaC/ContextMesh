import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { settleProject } from "../server/workflows";
import { createApp } from "../server/app";
import { ContextMesh } from "../server/service";
import { Store } from "../server/store";
import { config } from "../server/config";
let server: Server;
let store: Store;
let mesh: ContextMesh;
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
    callbackToken: "workflow-test-secret",
  });
  store = new Store(":memory:");
  mesh = new ContextMesh(store);
  server = createApp(mesh).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  config.callbackUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  Object.assign(config, original);
});
describe("registered Render task chain against real HTTP callbacks", () => {
  it("validates, executes and synchronizes in order", async () => {
    const plan = await mesh.createPlan(
      "greencart",
      "Maya 60%, Arjun 25%, taxes 10%, expenses 5%",
    );
    await mesh.simulatePayment("greencart");
    await mesh.approve(plan.id);
    const stages: string[] = [];
    const context: TaskContext = {
      metadata: {},
      async run(task, ...args) {
        stages.push(task.name);
        return task.func(context, ...args);
      },
    };
    await settleProject.func(context, plan.id);
    expect(stages).toEqual([
      "validatePaymentPlan",
      "executePayPalPayout",
      "synchronizeFinancialGraph",
    ]);
    expect(store.read().plans[0].status).toBe("completed");
    await settleProject.func(context, plan.id);
    expect(
      store
        .read()
        .events.filter((e) => e.title === "Simulated payouts completed"),
    ).toHaveLength(1);
  });
  it("stops before execution when approval is missing", async () => {
    const plan = await mesh.createPlan(
      "greencart",
      "Maya 60%, Arjun 25%, taxes 10%, expenses 5%",
    );
    const stages: string[] = [];
    const context: TaskContext = {
      metadata: {},
      async run(task, ...args) {
        stages.push(task.name);
        return task.func(context, ...args);
      },
    };
    await expect(settleProject.func(context, plan.id)).rejects.toThrow(
      "validate stage failed",
    );
    expect(stages).toEqual(["validatePaymentPlan"]);
    expect(store.read().plans[0].payoutBatchId).toBeUndefined();
  });
});
