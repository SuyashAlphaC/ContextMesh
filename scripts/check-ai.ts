import { interpret, callModel } from "../server/agent.js";
import { selectedAiProvider } from "../server/config.js";
import { seed } from "../server/store.js";
import { allocate, DomainError } from "../server/policy.js";
import type { ModelMessage, ModelTool } from "../shared/model.js";

// Explicit opt-in smoke test. Uses generation quota but never creates payment state.
if (selectedAiProvider() === "simulation")
  throw new Error("Configure an AI key before running this check.");
console.log(
  "Synthetic AI smoke test: up to three generation calls, no orders, payouts or ledger writes.",
);
try {
  const result = await interpret(
    "For this fictional test project, allocate 60% to Maya, 25% to Arjun, 10% to taxes and 5% to expenses. Wait for payment and explicit human approval.",
    seed(),
    {
      source: "synthetic test fixture",
      project: {
        name: "Fictional demo",
        amountCents: 200000,
        status: "unpaid",
      },
    },
  );
  const allocations = allocate(200000, result.intent, seed());
  console.log(
    `Plan: ${result.provider}, ${allocations.length} allocations, ${allocations.reduce((sum, a) => sum + a.amountCents, 0)} cents conserved.`,
  );
  const tools: ModelTool[] = [
    {
      name: "studio_tool_0",
      description:
        "Read the fictional project revenue total. Call this tool before answering the revenue question.",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  const messages: ModelMessage[] = [
    {
      role: "user",
      content:
        "Use studio_tool_0 to fetch the fictional demo project revenue, then summarize it.",
    },
  ];
  const first = await callModel(
    "You are a read-only dashboard analyst. Use the supplied tool to obtain revenue. Do not invent a value or perform any payment action.",
    messages,
    tools,
  );
  const calls = first.content.filter((block) => block.type === "tool_use");
  if (!calls.length)
    throw new DomainError(
      "The provider did not request the synthetic dashboard tool.",
      502,
    );
  messages.push(
    { role: "assistant", content: first.content },
    {
      role: "user",
      content: calls.map((call) => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify({ amountUSD: 2000, currency: "USD" }),
      })),
    },
  );
  const second = await callModel(
    "You are a read-only dashboard analyst. Summarize the supplied revenue in one sentence. No payment actions.",
    messages,
    tools,
  );
  if (!second.content.some((block) => block.type === "text" && block.text))
    throw new DomainError(
      "No usable text after the synthetic tool result.",
      502,
    );
  console.log(
    `Studio: ${calls.length} tool call(s), continuation returned text. No payment operations performed.`,
  );
} catch (error) {
  console.error(
    error instanceof DomainError
      ? error.message
      : `AI smoke test failed (${error instanceof Error ? error.name : "unknown error"}); no secret values displayed.`,
  );
  process.exitCode = 1;
}
