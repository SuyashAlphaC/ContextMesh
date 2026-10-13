import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../server/app";
import { ContextMesh } from "../server/service";
import { Store } from "../server/store";
import { PayPal } from "../server/paypal";
import { config } from "../server/config";
const original = { ...config };
let store: Store;
let server: Server;
let base: string;
const headers = {
  "Content-Type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "transmission",
  "paypal-transmission-sig": "signature",
  "paypal-transmission-time": "2026-10-12T00:00:00Z",
};
beforeEach(async () => {
  Object.assign(config, original, {
    mode: "sandbox",
    webhookId: "test-webhook",
    hydraUrl: "",
    accessToken: "workspace-token",
  });
  store = new Store(":memory:");
  server = createApp(new ContextMesh(store)).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  Object.assign(config, original);
  vi.restoreAllMocks();
});
describe("signed PayPal webhook HTTP route", () => {
  it("preserves every original field and byte in verification, independently of workspace login", async () => {
    const verify = vi
      .spyOn(PayPal.prototype, "request")
      .mockResolvedValue({ verification_status: "SUCCESS" });
    const raw =
      '{\n "id":"signed-event", "event_type":"OTHER", "event_version":"1.0", "resource":{"amount":{"value":1.00},"payee":{"merchant_id":"merchant"}}, "links":[]\n}';
    const response = await fetch(`${base}/api/webhooks/paypal`, {
      method: "POST",
      headers,
      body: raw,
    });
    expect(response.status).toBe(200);
    const forwarded = verify.mock.calls[0][4]!;
    expect(forwarded).toContain(`"webhook_event":${raw}`);
    expect(JSON.parse(forwarded).webhook_event).toEqual(JSON.parse(raw));
    expect(store.read().webhookIds).toEqual(["signed-event"]);
  });
  it("rejects provider-rejected signatures without recording the event", async () => {
    vi.spyOn(PayPal.prototype, "request").mockResolvedValue({
      verification_status: "FAILURE",
    });
    const response = await fetch(`${base}/api/webhooks/paypal`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "invalid",
        event_type: "OTHER",
        resource: {},
      }),
    });
    expect(response.status).toBe(401);
    expect(store.read().webhookIds).toHaveLength(0);
  });
  it("rejects unsigned requests before calling PayPal", async () => {
    const verify = vi.spyOn(PayPal.prototype, "request");
    const response = await fetch(`${base}/api/webhooks/paypal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "unsigned",
        event_type: "OTHER",
        resource: {},
      }),
    });
    expect(response.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects malformed payloads before provider verification", async () => {
    const verify = vi.spyOn(PayPal.prototype, "request");
    const response = await fetch(`${base}/api/webhooks/paypal`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });
  it("accepts retries without recording the verified event twice", async () => {
    vi.spyOn(PayPal.prototype, "request").mockResolvedValue({
      verification_status: "SUCCESS",
    });
    const body = JSON.stringify({
      id: "retry",
      event_type: "OTHER",
      resource: {},
    });
    await fetch(`${base}/api/webhooks/paypal`, {
      method: "POST",
      headers,
      body,
    });
    const response = await fetch(`${base}/api/webhooks/paypal`, {
      method: "POST",
      headers,
      body,
    });
    expect(await response.json()).toEqual({ duplicate: true });
    expect(store.read().webhookIds).toEqual(["retry"]);
  });
});
