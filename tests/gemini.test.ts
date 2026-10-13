import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgLlmRequest } from "ag-studio";
import { config, selectedAiProvider, validateConfig } from "../server/config";
import { callModel, interpret } from "../server/agent";
import { geminiContents } from "../server/gemini";
import { ContextMesh } from "../server/service";
import { Store, seed } from "../server/store";
import { translateRequest } from "../src/studio-adapter";
import { modelMessageSchema } from "../shared/model";
const original = { ...config };
const plan = {
  allocations: [
    { targetId: "maya", basisPoints: 6000 },
    { targetId: "arjun", basisPoints: 2500 },
    { targetId: "taxes", basisPoints: 1000 },
    { targetId: "expenses", basisPoints: 500 },
  ],
  explanation: "Wait for confirmed funding and human approval.",
};
const reply = (text: string) => ({
  candidates: [
    { finishReason: "STOP", content: { role: "model", parts: [{ text }] } },
  ],
});
beforeEach(() =>
  Object.assign(config, original, {
    aiProvider: "auto",
    aiKey: "",
    geminiKey: "private-gemini-test-key",
    geminiModel: "gemini-test",
    hydraUrl: "",
    renderTask: "",
    mode: "demo",
  }),
);
afterEach(() => {
  Object.assign(config, original);
  vi.unstubAllGlobals();
});
describe("Gemini provider and financial safeguards", () => {
  it("reports transport failures without leaking key-bearing request details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("request failed with private key");
      }),
    );
    await expect(
      callModel("Analyze", [{ role: "user", content: "Hello" }]),
    ).rejects.toThrow("Could not reach Gemini");
  });
  it("distinguishes provider outages from invalid credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    await expect(
      callModel("Analyze", [{ role: "user", content: "Hello" }]),
    ).rejects.toThrow("temporarily unavailable");
  });
  it("keeps the existing Claude transport working when explicitly selected", async () => {
    config.aiProvider = "anthropic";
    config.aiKey = "claude-test-key";
    const transport = vi.fn(async (_url: string) =>
      Response.json({ content: [{ type: "text", text: "Claude response" }] }),
    );
    vi.stubGlobal("fetch", transport);
    expect(
      await callModel("Analyze", [{ role: "user", content: "Hello" }]),
    ).toEqual({ content: [{ type: "text", text: "Claude response" }] });
    expect(transport.mock.calls[0][0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });
  it("selects Gemini first in auto mode, preserves explicit Claude selection, and defaults to simulation without keys", () => {
    config.aiKey = "claude-key";
    expect(selectedAiProvider()).toBe("gemini");
    config.aiProvider = "anthropic";
    expect(selectedAiProvider()).toBe("anthropic");
    config.aiProvider = "auto";
    config.geminiKey = "";
    expect(selectedAiProvider()).toBe("anthropic");
    config.aiKey = "";
    expect(selectedAiProvider()).toBe("simulation");
  });
  it("rejects explicit provider selection without its key", () => {
    config.aiProvider = "gemini";
    config.geminiKey = "";
    expect(validateConfig).toThrow("GEMINI_API_KEY");
    config.aiProvider = "invalid";
    expect(validateConfig).toThrow("AI_PROVIDER");
  });
  it("uses native structured generation with server-only key and preserves provider attribution", async () => {
    const transport = vi.fn(async () =>
      Response.json(reply(JSON.stringify(plan))),
    );
    vi.stubGlobal("fetch", transport);
    const result = await interpret("Use the agreed split", seed(), {
      source: "HydraDB",
    });
    expect(result.provider).toBe("gemini");
    expect(result.intent.allocations).toEqual(plan.allocations);
    const [url, options] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).not.toContain(config.geminiKey);
    expect(options.headers).toMatchObject({
      "x-goog-api-key": config.geminiKey,
    });
    const body = JSON.parse(options.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(
      body.generationConfig.responseJsonSchema.properties.allocations,
    ).toBeTruthy();
    expect(options.body).not.toContain(config.geminiKey);
  });
  it("creates a Gemini plan that still cannot execute without payment and human approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(reply(JSON.stringify(plan)))),
    );
    const store = new Store(":memory:");
    try {
      const mesh = new ContextMesh(store);
      const result = await mesh.createPlan("greencart", "Use the agreed split");
      expect(result.provider).toBe("gemini");
      expect(result.status).toBe("awaiting_payment");
      expect(mesh.snapshot().integrations.ai).toBe("Gemini configured");
      await expect(mesh.execute(result.id)).rejects.toThrow("approved");
      await mesh.simulatePayment("greencart");
      await expect(mesh.execute(result.id)).rejects.toThrow("approved");
    } finally {
      store.close();
    }
  });
  it("rejects bad model totals rather than silently replacing them with a simulation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          reply(
            JSON.stringify({
              ...plan,
              allocations: [{ targetId: "maya", basisPoints: 6000 }],
            }),
          ),
        ),
      ),
    );
    const store = new Store(":memory:");
    try {
      await expect(
        new ContextMesh(store).createPlan(
          "greencart",
          "Give Maya an invalid split",
        ),
      ).rejects.toThrow("100%");
      expect(store.read().plans).toHaveLength(0);
    } finally {
      store.close();
    }
  });
  it("rejects invented recipients and malformed model JSON", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          reply(
            JSON.stringify({
              ...plan,
              allocations: [{ targetId: "stranger", basisPoints: 10000 }],
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(Response.json(reply("not json")));
    vi.stubGlobal("fetch", transport);
    await expect(interpret("Pay someone", seed(), {})).rejects.toThrow(
      "structured validation",
    );
    await expect(interpret("Pay someone", seed(), {})).rejects.toThrow(
      "invalid plan",
    );
  });
  it("surfaces quota errors without leaking provider response content or the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: config.geminiKey } },
          { status: 429 },
        ),
      ),
    );
    await expect(
      callModel("system", [{ role: "user", content: "hello" }]),
    ).rejects.toThrow("quota/rate limit");
  });
  it("rejects blocked and truncated responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
        )
        .mockResolvedValueOnce(
          Response.json({
            candidates: [
              {
                finishReason: "MAX_TOKENS",
                content: { role: "model", parts: [{ text: "{}" }] },
              },
            ],
          }),
        ),
    );
    await expect(
      callModel("system", [{ role: "user", content: "hello" }]),
    ).rejects.toThrow("blocked");
    await expect(
      callModel("system", [{ role: "user", content: "hello" }]),
    ).rejects.toThrow("incomplete");
  });
});
describe("Gemini Studio tool-call continuation", () => {
  it("round-trips parallel calls, IDs, results and exact thought signatures through the existing AG Studio adapter", async () => {
    const native = {
      role: "model",
      parts: [
        {
          text: "Internal reasoning",
          thought: true,
          thoughtSignature: "text-signature",
        },
        { text: "I will query the projects." },
        {
          functionCall: {
            id: "native-1",
            name: "studio_tool_0",
            args: { query: "projects" },
          },
          thoughtSignature: "opaque-signature",
        },
        {
          functionCall: {
            id: "native-2",
            name: "studio_tool_0",
            args: { query: "events" },
          },
        },
      ],
    };
    const transport = vi.fn(async () =>
      Response.json({
        candidates: [{ finishReason: "STOP", content: native }],
      }),
    );
    vi.stubGlobal("fetch", transport);
    const tools = [
      {
        name: "studio_tool_0",
        description: "Query data",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ];
    const response = await callModel(
      "Analyze",
      [{ role: "user", content: "Show revenue" }],
      tools,
    );
    expect(
      response.content.some(
        (block) => block.type === "text" && block.text === "Internal reasoning",
      ),
    ).toBe(false);
    const calls = response.content.filter((block) => block.type === "tool_use");
    expect(calls).toHaveLength(2);
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Show revenue" }],
      },
      ...calls.map((call) => ({
        type: "function_call",
        name: "dashboard/query",
        callId: call.id,
        arguments: JSON.stringify(call.input),
      })),
      ...calls.map((call) => ({
        type: "function_call_output",
        callId: call.id,
        output: '{"rows":[{"revenue":2000}]}',
      })),
    ];
    const translated = translateRequest({
      input,
      tools: [
        {
          name: "dashboard/query",
          kind: "function",
          description: "Query data",
          parameters: tools[0].input_schema,
        },
      ],
      responseFormat: { type: "text" },
    } as unknown as AgLlmRequest);
    const contents = geminiContents(
      translated.messages.map((message) => modelMessageSchema.parse(message)),
    );
    expect(contents[1]).toEqual(native);
    expect(contents[2].parts).toHaveLength(2);
    expect(contents[2].parts[0]).toEqual({
      functionResponse: {
        id: "native-1",
        name: "studio_tool_0",
        response: { rows: [{ revenue: 2000 }] },
      },
    });
  });
  it("rejects unknown provider tools and corrupted conversation capsules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [{ functionCall: { name: "executePayment", args: {} } }],
              },
            },
          ],
        }),
      ),
    );
    await expect(
      callModel("Analyze", [{ role: "user", content: "hello" }], []),
    ).rejects.toThrow("unknown dashboard tool");
    expect(() =>
      geminiContents([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "gemini_invalid",
              name: "query",
              input: {},
            },
          ],
        },
      ]),
    ).toThrow("invalid");
  });
});
