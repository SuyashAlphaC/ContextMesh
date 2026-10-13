import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgLlmRequest } from "ag-studio";
import { studioAdapter, translateRequest } from "../src/studio-adapter";
function request(input: unknown[]): AgLlmRequest {
  return {
    input,
    instructions: "Analyze revenue",
    tools: [
      {
        name: "dashboard/query",
        kind: "function",
        description: "Query data",
        parameters: { type: "object", properties: {} },
      },
    ],
    responseFormat: { type: "text" },
  } as unknown as AgLlmRequest;
}
afterEach(() => vi.unstubAllGlobals());
describe("AG Studio Anthropic adapter", () => {
  it("translates tool names and merges a tool result into conversation history", () => {
    const translated = translateRequest(
      request([
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "Show revenue" }],
        },
        {
          type: "function_call",
          name: "dashboard/query",
          callId: "call-1",
          arguments: "{}",
          result: '{"revenue":2000}',
        },
      ]),
    );
    expect(translated.tools?.[0].name).toBe("studio_tool_0");
    expect(translated.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(translated.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: '{"revenue":2000}',
    });
    expect(translated.system).toContain("cannot approve or execute");
  });
  it("maps provider tool calls back to AG names and emits usable events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "studio_tool_0",
              input: { query: "projects" },
            },
          ],
        }),
      ),
    );
    const turn = studioAdapter.executeTurn(
      request([
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "Show revenue" }],
        },
      ]),
    );
    const response = await turn.complete;
    expect(response.output[0]).toMatchObject({
      type: "function_call",
      name: "dashboard/query",
      callId: "call-1",
    });
    const events = [];
    for await (const event of turn.stream) events.push(event.type);
    expect(events).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
    ]);
  });
  it("does not disguise provider failure as a successful dashboard response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Provider unavailable" }, { status: 502 }),
      ),
    );
    const turn = studioAdapter.executeTurn(request([]));
    await expect(turn.complete).rejects.toThrow("Provider unavailable");
  });
});
