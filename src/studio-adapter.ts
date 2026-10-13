import type {
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgAiEvent,
} from "ag-studio";
type Block =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; content: string };
export function translateRequest(request: AgLlmRequest) {
  const names = new Map(
    (request.tools || []).map((t, i) => [t.name, `studio_tool_${i}`]),
  );
  const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
  let system = `${request.instructions || ""}\nYou are inside ContextMesh's financial analytics dashboard. All amounts in dashboard sources are USD decimal dollars. You may query data and modify dashboard widgets, but you cannot approve or execute payments. Never claim a payment happened unless present in data.`;
  const append = (role: "user" | "assistant", block: Block) => {
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of request.input) {
    if (item.type === "message") {
      const text = item.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (item.role === "system") system += `\n${text}`;
      else if (text) append(item.role, { type: "text", text });
    } else if (item.type === "function_call") {
      const name = names.get(item.name);
      if (!name) continue;
      append("assistant", {
        type: "tool_use",
        id: item.callId,
        name,
        input: JSON.parse(item.arguments),
      });
      // AG may persist the result on the call itself or as a separate function_call_output.
      if (
        item.result &&
        !request.input.some(
          (i) => i.type === "function_call_output" && i.callId === item.callId,
        )
      )
        append("user", {
          type: "tool_result",
          tool_use_id: item.callId,
          content: item.result,
        });
    } else if (item.type === "function_call_output")
      append("user", {
        type: "tool_result",
        tool_use_id: item.callId,
        content: item.output,
      });
  }
  if (request.responseFormat.type === "json")
    system += `\nReturn JSON conforming to this schema: ${JSON.stringify(request.responseFormat.schema)}`;
  const tools = request.tools
    ?.filter((t) => t.kind !== "provided")
    .map((t) => ({
      name: names.get(t.name)!,
      description: t.description,
      input_schema: t.parameters,
    }));
  return { system, messages, tools, names };
}
export const studioAdapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const translated = translateRequest(request);
    const complete: Promise<AgLlmResponse> = fetch("/api/studio/model", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: translated.system,
        messages: translated.messages,
        tools: translated.tools,
      }),
      signal: options?.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Studio AI request failed.");
      const reverse = new Map(
        [...translated.names].map(([original, safe]) => [safe, original]),
      );
      const output: AgLlmResponse["output"] = [];
      for (const block of data.content as Block[]) {
        if (block.type === "text")
          output.push({
            id: crypto.randomUUID(),
            kind: "output",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "text", text: block.text, annotations: [] }],
          });
        else if (block.type === "tool_use") {
          const name = reverse.get(block.name);
          if (!name)
            throw new Error("Provider returned an unknown dashboard tool.");
          output.push({
            id: block.id,
            kind: "output",
            type: "function_call",
            callId: block.id,
            name,
            arguments: JSON.stringify(block.input),
            status: "completed",
          });
        }
      }
      return {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        status: "completed",
        output,
      };
    });
    // Attach a rejection handler immediately; the framework consumes both completion and stream.
    void complete.catch(() => {});
    return {
      complete,
      stream: {
        async *[Symbol.asyncIterator](): AsyncGenerator<AgAiEvent> {
          const result = await complete;
          for (const item of result.output) {
            if (item.type === "message") {
              yield {
                type: "TEXT_MESSAGE_START",
                messageId: item.id,
                role: "assistant",
              };
              for (const content of item.content)
                if (content.type === "text")
                  yield {
                    type: "TEXT_MESSAGE_CONTENT",
                    messageId: item.id,
                    delta: content.text,
                  };
              yield { type: "TEXT_MESSAGE_END", messageId: item.id };
            } else if (item.type === "function_call") {
              yield {
                type: "TOOL_CALL_START",
                toolCallId: item.callId,
                toolCallName: item.name,
              };
              yield {
                type: "TOOL_CALL_ARGS",
                toolCallId: item.callId,
                delta: item.arguments,
              };
              yield { type: "TOOL_CALL_END", toolCallId: item.callId };
            }
          }
        },
      },
    };
  },
};
