import { z } from "zod";

// The existing Studio wire format is provider-neutral at the application boundary.
export const modelBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(200000) }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string().max(500000),
    name: z.string().max(100),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().max(500000),
    content: z.string().max(200000),
  }),
]);
export const modelMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([
    z.string().max(200000),
    z.array(modelBlockSchema).max(100),
  ]),
});
export const modelToolSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
  description: z.string().max(20000),
  input_schema: z.record(z.string(), z.unknown()),
});
export type ModelBlock = z.infer<typeof modelBlockSchema>;
export type ModelMessage = z.infer<typeof modelMessageSchema>;
export type ModelTool = z.infer<typeof modelToolSchema>;
export type ModelResponse = {
  content: Exclude<ModelBlock, { type: "tool_result" }>[];
};
