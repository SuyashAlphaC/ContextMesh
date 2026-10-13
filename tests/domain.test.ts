import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Store, seed } from "../server/store";
import { allocate, validatePlan } from "../server/policy";
import { ContextMesh } from "../server/service";
import { parseDemoInstruction } from "../server/agent";
import { DEFAULT_INSTRUCTION } from "../shared/types";
import { config } from "../server/config";
import { PayPal, verifiedCapture, type Order } from "../server/paypal";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const original = { ...config };
let store: Store;
let mesh: ContextMesh;
beforeEach(() => {
  Object.assign(config, original, {
    mode: "demo",
    aiKey: "",
    geminiKey: "",
    aiProvider: "auto",
    hydraUrl: "",
    renderTask: "",
    renderKey: "",
  });
  store = new Store(":memory:");
  mesh = new ContextMesh(store);
});
afterEach(() => {
  store.close();
  Object.assign(config, original);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Financial planning invariants", () => {
  it("preserves every cent at the safe-integer boundary", () => {
    const allocations = allocate(
      Number.MAX_SAFE_INTEGER,
      parseDemoInstruction(DEFAULT_INSTRUCTION),
      seed(),
    );
    expect(
      allocations.reduce(
        (sum, allocation) => sum + BigInt(allocation.amountCents),
        0n,
      ),
    ).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(
      allocations.every((allocation) =>
        Number.isSafeInteger(allocation.amountCents),
      ),
    ).toBe(true);
  });
  it("parses the discussed instruction correctly", () => {
    const intent = parseDemoInstruction(DEFAULT_INSTRUCTION);
    expect(intent.allocations).toEqual([
      { targetId: "maya", basisPoints: 6000 },
      { targetId: "arjun", basisPoints: 2500 },
      { targetId: "taxes", basisPoints: 1000 },
      { targetId: "expenses", basisPoints: 500 },
    ]);
  });
  it("supports percentages before names and rejects empty instructions", () => {
    expect(
      parseDemoInstruction(
        "Pay 60% to Maya, 25% to Arjun, 10% for taxes and 5% for expenses",
      ).allocations[0].basisPoints,
    ).toBe(6000);
    expect(() => parseDemoInstruction("Pay somebody something")).toThrow();
  });
  it("rejects unapproved autonomy in the simulation parser", () =>
    expect(() => parseDemoInstruction("Maya 100% without approval")).toThrow());
  it("distributes rounding cents without losing money", () => {
    const allocation = allocate(
      101,
      {
        allocations: [
          { targetId: "maya", basisPoints: 3333 },
          { targetId: "arjun", basisPoints: 3333 },
          { targetId: "taxes", basisPoints: 3334 },
        ],
        explanation: "",
      },
      seed(),
    );
    expect(allocation.map((a) => a.amountCents)).toEqual([34, 33, 34]);
    expect(allocation.reduce((s, a) => s + a.amountCents, 0)).toBe(101);
  });
  it("rejects invalid totals and duplicate recipients", () => {
    expect(() =>
      allocate(
        200000,
        {
          allocations: [{ targetId: "maya", basisPoints: 5000 }],
          explanation: "",
        },
        seed(),
      ),
    ).toThrow("100%");
    expect(() =>
      allocate(
        200000,
        {
          allocations: [
            { targetId: "maya", basisPoints: 5000 },
            { targetId: "maya", basisPoints: 5000 },
          ],
          explanation: "",
        },
        seed(),
      ),
    ).toThrow("once");
  });
  it("rejects zero-cent payouts", () =>
    expect(() =>
      allocate(
        1,
        {
          allocations: [
            { targetId: "maya", basisPoints: 9999 },
            { targetId: "arjun", basisPoints: 1 },
          ],
          explanation: "",
        },
        seed(),
      ),
    ).toThrow("cent"));
  it("blocks approval and execution before payment", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    expect(p.status).toBe("awaiting_payment");
    await expect(mesh.approve(p.id)).rejects.toThrow();
    await expect(mesh.execute(p.id)).rejects.toThrow();
  });
  it("completes the full workflow with an audit trail", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    await mesh.simulatePayment("greencart");
    expect(store.read().plans[0].status).toBe("awaiting_approval");
    await mesh.approve(p.id);
    await mesh.execute(p.id);
    const state = mesh.snapshot();
    expect(state.plans[0].status).toBe("completed");
    expect(state.plans[0].allocations.map((a) => a.amountCents)).toEqual([
      120000, 50000, 20000, 10000,
    ]);
    expect(state.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        "plan",
        "payment",
        "approval",
        "execution",
        "payout",
      ]),
    );
    expect(state.graph.edges.some((e) => e.type === "PAYS")).toBe(true);
  });
  it("allows planning after payment", async () => {
    await mesh.simulatePayment("greencart");
    expect(
      (await mesh.createPlan("greencart", DEFAULT_INSTRUCTION)).status,
    ).toBe("awaiting_approval");
  });
  it("prevents a second active plan", async () => {
    await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    await expect(
      mesh.createPlan("greencart", DEFAULT_INSTRUCTION),
    ).rejects.toThrow("active");
  });
  it("is idempotent across simultaneous execution requests", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    await mesh.simulatePayment("greencart");
    await mesh.approve(p.id);
    await Promise.all([
      mesh.execute(p.id),
      mesh.execute(p.id),
      mesh.execute(p.id),
    ]);
    expect(store.read().events.filter((e) => e.kind === "payout")).toHaveLength(
      1,
    );
  });
  it("prevents re-paying a completed project", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    await mesh.simulatePayment("greencart");
    await mesh.approve(p.id);
    await mesh.execute(p.id);
    await expect(
      mesh.createPlan("greencart", DEFAULT_INSTRUCTION),
    ).rejects.toThrow();
    await expect(mesh.reject(p.id)).rejects.toThrow();
  });
  it("invalidates a plan when the recipient account changes", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    await mesh.simulatePayment("greencart");
    await mesh.changeRecipient("maya", "new@example.com");
    await expect(mesh.approve(p.id)).rejects.toThrow("changed");
    await mesh.reject(p.id);
    const next = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    expect(next.risks.join()).toContain("not a verified");
  });
  it("rechecks recipient accounts after approval", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    await mesh.simulatePayment("greencart");
    await mesh.approve(p.id);
    await mesh.changeRecipient("arjun", "changed@example.com");
    await expect(mesh.execute(p.id)).rejects.toThrow("changed");
  });
  it("persists plans and events after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "contextmesh-test-"));
    const persistent = new Store(join(directory, "state.sqlite"));
    const service = new ContextMesh(persistent);
    const plan = await service.createPlan("greencart", DEFAULT_INSTRUCTION);
    persistent.close();
    const reopened = new Store(join(directory, "state.sqlite"));
    expect(reopened.read().plans[0].id).toBe(plan.id);
    reopened.close();
  });
  it("does not trust a refunded funding source", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    const state = store.read();
    state.projects[0].status = "refunded";
    store.save(state);
    expect(() => validatePlan(p, state)).toThrow("confirmed payment");
  });
});
describe("PayPal adapter contract", () => {
  const order = (): Order => ({
    id: "ORDER-123",
    status: "COMPLETED",
    purchase_units: [
      {
        reference_id: "greencart",
        custom_id: "greencart",
        payments: {
          captures: [
            {
              id: "CAPTURE-123",
              status: "COMPLETED",
              amount: { value: "2000.00", currency_code: "USD" },
            },
          ],
        },
      },
    ],
  });
  it("checks order, project, currency, amount, and capture state", () => {
    const p = { ...seed().projects[0], orderId: "ORDER-123" };
    expect(verifiedCapture(order(), p)).toBe("CAPTURE-123");
    const wrong = order();
    wrong.purchase_units[0].payments!.captures![0].amount.value = "1.00";
    expect(() => verifiedCapture(wrong, p)).toThrow("amount");
    const currency = order();
    currency.purchase_units[0].payments!.captures![0].amount.currency_code =
      "EUR";
    expect(() => verifiedCapture(currency, p)).toThrow("currency");
    expect(() => verifiedCapture(order(), { ...p, orderId: "OTHER" })).toThrow(
      "completed",
    );
  });
  it("never submits reserves as PayPal payout items and uses stable identifiers", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    p.allocations
      .filter((a) => a.kind === "payout")
      .forEach((a) => (a.email = `${a.targetId}@sandbox.test`));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          batch_header: { payout_batch_id: "BATCH", batch_status: "PENDING" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await new PayPal().payout(p);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/payments/payouts");
    const body = JSON.parse(init.body);
    expect(body.items).toHaveLength(2);
    expect(body.sender_batch_header.sender_batch_id).toBe(p.id);
    expect(init.headers["PayPal-Request-Id"]).toBe(p.id);
  });
  it("rejects invalid webhook signatures", async () => {
    config.webhookId = "WEBHOOK";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ access_token: "token", expires_in: 3600 }),
        )
        .mockResolvedValueOnce(
          Response.json({ verification_status: "FAILURE" }),
        ),
    );
    await expect(
      new PayPal().verifyWebhook(
        {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
          "paypal-transmission-id": "id",
          "paypal-transmission-sig": "sig",
          "paypal-transmission-time": "time",
        },
        {},
      ),
    ).rejects.toThrow("signature");
  });
  it("sends the original signed JSON unchanged over the PayPal HTTP transport", async () => {
    config.webhookId = "WEBHOOK";
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(Response.json({ verification_status: "SUCCESS" }));
    vi.stubGlobal("fetch", transport);
    const raw =
      '{ "id":"event", "event_type":"OTHER", "resource":{"value":1.00}, "untouched":true }';
    await new PayPal().verifyWebhook(
      {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
        "paypal-transmission-id": "id",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": "time",
      },
      JSON.parse(raw),
      raw,
    );
    expect(transport.mock.calls[1][1].body).toContain(`"webhook_event":${raw}`);
    expect(JSON.parse(transport.mock.calls[1][1].body).webhook_id).toBe(
      "WEBHOOK",
    );
  });
  it("deduplicates verified webhook events", async () => {
    config.mode = "sandbox";
    vi.spyOn(mesh.paypal, "verifyWebhook").mockResolvedValue();
    const event = { id: "EV-1", event_type: "OTHER", resource: {} };
    expect(await mesh.webhook({}, event)).toEqual({ duplicate: false });
    expect(await mesh.webhook({}, event)).toEqual({ duplicate: true });
    expect(store.read().webhookIds).toHaveLength(1);
  });
  it("keeps a submitted batch pending until every item succeeds", async () => {
    const p = await mesh.createPlan("greencart", DEFAULT_INSTRUCTION);
    const state = store.read();
    state.plans[0].status = "submitted";
    state.plans[0].payoutBatchId = "BATCH";
    store.save(state);
    config.mode = "sandbox";
    vi.spyOn(mesh.paypal, "batch").mockResolvedValue({
      batch_header: { batch_status: "SUCCESS" },
      items: [
        { transaction_status: "SUCCESS" },
        { transaction_status: "FAILED" },
      ],
    });
    await mesh.reconcile(p.id);
    expect(store.read().plans[0].status).toBe("submitted");
    expect(store.read().plans[0].error).toContain("FAILED");
  });
});
