import {
  config,
  validateConfig,
  selectedAiProvider,
} from "../server/config.js";
import { Store } from "../server/store.js";
import { HydraGraph } from "../server/graph.js";
import { PayPal } from "../server/paypal.js";
validateConfig();
console.log(
  `Mode: ${config.mode}. No payments will be submitted by this check.`,
);
if (config.paypalId && config.paypalSecret) {
  const paypal = new PayPal();
  await paypal.accessToken();
  console.log("PayPal: OAuth succeeded against Sandbox.");
  if (config.webhookId) {
    const webhook = await paypal.request<{
      url: string;
      event_types: { name: string }[];
    }>(`/v1/notifications/webhooks/${encodeURIComponent(config.webhookId)}`);
    const url = new URL(webhook.url);
    if (url.protocol !== "https:" || url.pathname !== "/api/webhooks/paypal")
      throw new Error(
        "Registered webhook must use HTTPS and /api/webhooks/paypal.",
      );
    const events = webhook.event_types.map((event) => event.name);
    if (
      !events.includes("*") &&
      ![
        "PAYMENT.CAPTURE.COMPLETED",
        "PAYMENT.CAPTURE.REFUNDED",
        "PAYMENT.CAPTURE.REVERSED",
      ].every((event) => events.includes(event))
    )
      throw new Error(
        "Registered webhook subscriptions do not cover all required capture events.",
      );
    console.log(
      "PayPal webhook: registered to the configured app, HTTPS/path valid, capture events covered.",
    );
  } else
    console.log(
      "PayPal webhook: ID absent; signed webhook verification cannot run.",
    );
} else console.log("PayPal: credentials absent; simulation only.");
if (config.hydraUrl) {
  const store = new Store(":memory:");
  const graph = new HydraGraph(store);
  const result = await graph.query(
    "MATCH (n:ContextEntity) RETURN n.key AS key LIMIT 1",
  );
  console.log("HydraDB: authenticated query succeeded.");
  store.close();
} else console.log("HydraDB: endpoint absent; local graph only.");
const provider = selectedAiProvider();
if (provider === "gemini") {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}`,
    {
      headers: { "x-goog-api-key": config.geminiKey },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Gemini model access check failed (${response.status}). Check your key and model access. No secret values are displayed.`,
    );
  const model = (await response.json()) as {
    supportedGenerationMethods?: string[];
  };
  if (!model.supportedGenerationMethods?.includes("generateContent"))
    throw new Error("Selected Gemini model does not support generateContent.");
  console.log(
    "Gemini: authenticated model lookup succeeded. Generation/tool calls still need an application test; free-tier quota is account-specific.",
  );
} else
  console.log(
    `AI: ${provider === "anthropic" ? "Anthropic key configured; use the application to verify model access" : "keys absent; deterministic simulation only"}.`,
  );
console.log(
  `Render: ${config.renderTask ? "task configured; cloud execution requires deployment" : "not configured; local runner"}.`,
);
