import { config } from "./config.js";
import type { Plan, Project } from "../shared/types.js";
import { DomainError } from "./policy.js";
const BASE = "https://api-m.sandbox.paypal.com";
export class PayPal {
  private token = "";
  private expires = 0;
  async accessToken() {
    if (this.token && this.expires > Date.now()) return this.token;
    const response = await fetch(`${BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.paypalId}:${config.paypalSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new DomainError(
        `PayPal authentication failed (${response.status}).`,
        502,
      );
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = data.access_token;
    this.expires = Date.now() + (data.expires_in - 60) * 1000;
    return this.token;
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    requestId?: string,
    rawJsonBody?: string,
  ): Promise<T> {
    const token = await this.accessToken();
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      ...(rawJsonBody !== undefined
        ? { body: rawJsonBody }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok)
      throw new DomainError(
        `PayPal ${method} request failed (${response.status}). Inspect Sandbox account permissions and credentials.`,
        502,
      );
    return (response.status === 204 ? {} : await response.json()) as T;
  }
  async createOrder(project: Project) {
    return this.request<{ id: string; links: { rel: string; href: string }[] }>(
      "/v2/checkout/orders",
      "POST",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: project.id,
            custom_id: project.id,
            description: project.name,
            amount: {
              currency_code: project.currency,
              value: (project.amountCents / 100).toFixed(2),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: `${config.publicUrl}/?checkout=approved&project=${project.id}`,
              cancel_url: `${config.publicUrl}/?checkout=cancelled`,
              user_action: "PAY_NOW",
            },
          },
        },
      },
      `order-${project.id}`,
    );
  }
  async captureOrder(orderId: string) {
    return this.request<Order>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      "POST",
      {},
      `capture-${orderId}`,
    );
  }
  async order(orderId: string) {
    return this.request<Order>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
  }
  async payout(plan: Plan) {
    const payouts = plan.allocations.filter((a) => a.kind === "payout");
    if (!payouts.length)
      throw new DomainError("A payment plan needs at least one payout.");
    if (payouts.some((a) => !a.email || a.email.endsWith("@example.com")))
      throw new DomainError(
        "Set real Sandbox recipient emails before executing.",
      );
    return this.request<{
      batch_header: { payout_batch_id: string; batch_status: string };
    }>(
      "/v1/payments/payouts",
      "POST",
      {
        sender_batch_header: {
          sender_batch_id: plan.id,
          email_subject: "Your ContextMesh project payout",
          email_message: "Payment approved in ContextMesh.",
        },
        items: payouts.map((a) => ({
          recipient_type: "EMAIL",
          receiver: a.email,
          amount: { value: (a.amountCents / 100).toFixed(2), currency: "USD" },
          sender_item_id: `${plan.id}-${a.targetId}`,
          note: `Project payout: ${a.label}`,
        })),
      },
      plan.id,
    );
  }
  async batch(id: string) {
    return this.request<{
      batch_header: { batch_status: string };
      items: { transaction_status: string }[];
    }>(`/v1/payments/payouts/${encodeURIComponent(id)}?page_size=1000`);
  }
  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    event: unknown,
    rawEvent?: string,
  ) {
    if (!config.webhookId)
      throw new DomainError("PAYPAL_WEBHOOK_ID must be configured.", 503);
    const required = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];
    if (
      required.some(
        (name) => typeof headers[name] !== "string" || !headers[name],
      )
    )
      throw new DomainError(
        "Required PayPal signature headers are missing.",
        401,
      );
    const metadata = {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: config.webhookId,
    };
    // Embed the untouched original JSON value, preserving whitespace, numbers and all fields.
    const rawJsonBody = `${JSON.stringify(metadata).slice(0, -1)},"webhook_event":${rawEvent ?? JSON.stringify(event)}}`;
    const result = await this.request<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      "POST",
      undefined,
      undefined,
      rawJsonBody,
    );
    if (result.verification_status !== "SUCCESS")
      throw new DomainError("Webhook signature verification failed.", 401);
  }
}
export interface Order {
  id: string;
  status: string;
  purchase_units: {
    reference_id?: string;
    custom_id?: string;
    payments?: {
      captures?: {
        id: string;
        status: string;
        amount: { currency_code: string; value: string };
      }[];
    };
  }[];
}
export function verifiedCapture(order: Order, project: Project) {
  const units = order.purchase_units;
  if (
    order.id !== project.orderId ||
    order.status !== "COMPLETED" ||
    units.length !== 1
  )
    throw new DomainError(
      "PayPal order is not a completed payment for this project.",
    );
  const unit = units[0];
  const captures = unit.payments?.captures;
  if (
    unit.reference_id !== project.id ||
    unit.custom_id !== project.id ||
    !captures ||
    captures.length !== 1
  )
    throw new DomainError("PayPal payment reference does not match.");
  const capture = captures[0];
  if (
    capture.status !== "COMPLETED" ||
    capture.amount.currency_code !== project.currency ||
    capture.amount.value !== (project.amountCents / 100).toFixed(2)
  )
    throw new DomainError(
      "Payment amount, currency, or capture state does not match.",
    );
  return capture.id;
}
