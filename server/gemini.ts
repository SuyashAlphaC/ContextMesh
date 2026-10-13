import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { DomainError } from "./policy.js";
import type {
  ModelMessage,
  ModelTool,
  ModelResponse,
} from "../shared/model.js";

const partSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z
      .object({
        id: z.string().optional(),
        name: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const contentSchema = z
  .object({ role: z.literal("model"), parts: z.array(partSchema) })
  .passthrough();
const stateSchema = z.object({
  turn: z.string(),
  index: z.number().int().nonnegative(),
  content: contentSchema,
});
type Part =
  | z.infer<typeof partSchema>
  | {
      functionResponse: {
        name: string;
        id?: string;
        response: Record<string, unknown>;
      };
    };

function decodeCall(id: string) {
  if (!id.startsWith("gemini_"))
    throw new DomainError(
      "Restart the Studio chat after changing AI providers.",
    );
  try {
    return stateSchema.parse(
      JSON.parse(Buffer.from(id.slice(7), "base64url").toString("utf8")),
    );
  } catch {
    throw new DomainError(
      "Gemini conversation state is invalid. Start a new Studio chat.",
    );
  }
}
export function geminiContents(messages: ModelMessage[]) {
  const contents: { role: "user" | "model"; parts: Part[] }[] = [];
  for (const message of messages) {
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const calls = blocks.filter((block) => block.type === "tool_use");
    const parts: Part[] = [];
    const restored = new Set<string>();
    for (const block of blocks) {
      if (block.type === "text") {
        // A call capsule contains the exact full model turn, including text and signatures.
        if (!calls.length) parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        const state = decodeCall(block.id);
        const original = state.content.parts[state.index]?.functionCall;
        if (
          message.role !== "assistant" ||
          !original ||
          original.name !== block.name ||
          JSON.stringify(original.args || {}) !== JSON.stringify(block.input)
        )
          throw new DomainError(
            "Gemini tool history no longer matches the original model response.",
          );
        if (!restored.has(state.turn)) {
          parts.push(...state.content.parts);
          restored.add(state.turn);
        }
      } else {
        const state = decodeCall(block.tool_use_id);
        const call = state.content.parts[state.index]?.functionCall;
        if (message.role !== "user" || !call)
          throw new DomainError(
            "Gemini tool result does not match a model call.",
          );
        let output: unknown;
        try {
          output = JSON.parse(block.content);
        } catch {
          output = block.content;
        }
        const response =
          output !== null &&
          typeof output === "object" &&
          !Array.isArray(output)
            ? (output as Record<string, unknown>)
            : { result: output };
        parts.push({
          functionResponse: {
            name: call.name,
            ...(call.id ? { id: call.id } : {}),
            response,
          },
        });
      }
    }
    if (parts.length)
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts,
      });
  }
  return contents;
}

export async function callGemini(
  system: string,
  messages: ModelMessage[],
  tools?: ModelTool[],
  jsonSchema?: Record<string, unknown>,
): Promise<ModelResponse> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": config.geminiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: geminiContents(messages),
        generationConfig: {
          maxOutputTokens: 8192,
          ...(jsonSchema
            ? {
                responseMimeType: "application/json",
                responseJsonSchema: jsonSchema,
              }
            : {}),
        },
        ...(tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.input_schema,
                  })),
                },
              ],
            }
          : {}),
      }),
      signal: AbortSignal.timeout(60000),
    },
  ).catch(() => {
    throw new DomainError(
      "Could not reach Gemini. Check your connection and retry; no payment was attempted.",
      502,
    );
  });
  if (!response.ok)
    throw new DomainError(
      response.status === 429
        ? "Gemini quota/rate limit reached. Wait and retry, or check your AI Studio quota."
        : response.status === 503 ||
            response.status === 502 ||
            response.status === 504
          ? "Gemini is temporarily unavailable or overloaded. Wait and retry; no payment was attempted."
          : `Gemini request failed (${response.status}). Check GEMINI_API_KEY, GEMINI_MODEL, and model access.`,
      502,
    );
  const payload = (await response.json()) as {
    candidates?: { content?: unknown; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  const candidate = payload.candidates?.[0];
  if (
    payload.promptFeedback?.blockReason ||
    !candidate ||
    (candidate.finishReason && candidate.finishReason !== "STOP")
  )
    throw new DomainError(
      "Gemini returned a blocked, incomplete, or empty response. No payment was attempted.",
      502,
    );
  const result = contentSchema.safeParse(candidate.content);
  if (!result.success)
    throw new DomainError("Gemini returned an invalid response.", 502);
  const content: ModelResponse["content"] = [];
  const turn = randomUUID();
  result.data.parts.forEach((part, index) => {
    if (part.text && !part.thought)
      content.push({ type: "text", text: part.text });
    if (part.functionCall) {
      if (!tools?.some((tool) => tool.name === part.functionCall!.name))
        throw new DomainError(
          "Gemini returned an unknown dashboard tool.",
          502,
        );
      // Replay the exact native response through AG Studio's opaque callId, with no server cache.
      const id = `gemini_${Buffer.from(JSON.stringify({ turn, index, content: result.data })).toString("base64url")}`;
      content.push({
        type: "tool_use",
        id,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  });
  if (!content.length)
    throw new DomainError("Gemini returned no usable output.", 502);
  return { content };
}
