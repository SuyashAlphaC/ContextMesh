import { config, selectedAiProvider } from "./config.js";
import { callGemini } from "./gemini.js";
import {
  modelMessageSchema,
  modelToolSchema,
  type ModelResponse,
} from "../shared/model.js";
import { z } from "zod";
import { DomainError, intentSchema } from "./policy.js";
import type { Intent, State } from "../shared/types.js";

export function parseDemoInstruction(instruction: string): Intent {
  const allocations: Intent["allocations"] = [];
  for (const targetId of ["maya", "arjun", "taxes", "expenses"] as const) {
    const term = targetId === "taxes" ? "tax(?:es)?" : targetId;
    const after = instruction.match(
      new RegExp(
        `\\b${term}\\b\\s*(?:gets?\\s+|receives?\\s+|:)?\\s*(\\d+(?:\\.\\d{1,2})?)\\s*%`,
        "i",
      ),
    );
    const before = instruction.match(
      new RegExp(
        `(\\d+(?:\\.\\d{1,2})?)\\s*%\\s*(?:for|to|towards)?\\s*\\b${term}\\b`,
        "i",
      ),
    );
    const value = after?.[1] || before?.[1];
    if (value)
      allocations.push({
        targetId,
        basisPoints: Math.round(Number(value) * 100),
      });
  }
  if (!allocations.length)
    throw new DomainError(
      "Simulation understands named percentage splits. Try: Maya 60%, Arjun 25%, taxes 10%, expenses 5%. Connect an AI key for broader instructions.",
    );
  if (
    /auto(?:matically)?\s*(?:approve|execute)|without\s*approval/i.test(
      instruction,
    )
  )
    throw new DomainError(
      "This version requires explicit approval for payouts.",
    );
  return intentSchema.parse({
    allocations,
    explanation:
      "Resolve collaborators from the financial context, wait for a confirmed payment, allocate funds by the requested percentages, and request your approval before execution. Reserves remain accounting allocations; no tax account transfer is performed.",
  });
}
export async function callModel(
  system: string,
  messages: unknown[],
  tools?: unknown[],
  jsonSchema?: Record<string, unknown>,
) {
  const provider = selectedAiProvider();
  if (
    provider === "simulation" ||
    (provider === "gemini" ? !config.geminiKey : !config.aiKey)
  )
    throw new DomainError(
      "Connect GEMINI_API_KEY or ANTHROPIC_API_KEY to use the AI assistant.",
      503,
    );
  const parsedMessages = z.array(modelMessageSchema).parse(messages);
  const parsedTools =
    tools === undefined ? undefined : z.array(modelToolSchema).parse(tools);
  if (provider === "gemini")
    return callGemini(system, parsedMessages, parsedTools, jsonSchema);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.aiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.aiModel,
      max_tokens: 4096,
      system,
      messages: parsedMessages,
      ...(parsedTools?.length ? { tools: parsedTools } : {}),
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new DomainError(
      `AI provider request failed (${response.status}). Check your API key and model.`,
      502,
    );
  return (await response.json()) as ModelResponse;
}
export async function interpret(
  instruction: string,
  state: State,
  context: unknown,
): Promise<{
  intent: Intent;
  provider: "simulation" | "anthropic" | "gemini";
}> {
  const provider = selectedAiProvider();
  if (provider === "simulation")
    return {
      intent: parseDemoInstruction(instruction),
      provider: "simulation",
    };
  const response = await callModel(
    'You are ContextMesh, a financial planning assistant. Return a JSON object only, with allocations:[{targetId,basisPoints}] and explanation. targetId must be maya, arjun, taxes, or expenses. 10000 basisPoints = 100%. Resolve the instruction using supplied context. Never invent recipients, payment confirmations, or approvals. Reserves are accounting allocations, not transfers. If the instruction cannot be fulfilled, return {"error":"reason"}.',
    [
      {
        role: "user",
        content: JSON.stringify({
          instruction,
          recipients: state.recipients.map((r) => ({
            id: r.id,
            name: r.name,
            trusted: r.trusted,
          })),
          context,
        }),
      },
    ],
    undefined,
    {
      type: "object",
      properties: {
        allocations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              targetId: {
                type: "string",
                enum: ["maya", "arjun", "taxes", "expenses"],
              },
              basisPoints: { type: "integer", minimum: 1, maximum: 10000 },
            },
            required: ["targetId", "basisPoints"],
          },
          minItems: 1,
          maxItems: 4,
        },
        explanation: { type: "string" },
        error: { type: "string" },
      },
      additionalProperties: false,
    },
  );
  const text = response.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
    );
  } catch {
    throw new DomainError(
      "The AI returned an invalid plan. No payment was attempted.",
      502,
    );
  }
  if (parsed && typeof parsed === "object" && "error" in parsed)
    throw new DomainError(String(parsed.error));
  const result = intentSchema.safeParse(parsed);
  if (!result.success)
    throw new DomainError(
      "AI plan did not pass the structured validation checks.",
      502,
    );
  return { intent: result.data, provider };
}
