import "dotenv/config";
import { task } from "@renderinc/sdk/workflows";
import { config } from "./config.js";
export async function callback(
  planId: string,
  stage: "validate" | "execute" | "sync",
) {
  if (!config.callbackUrl || !config.callbackToken)
    throw new Error(
      "WORKFLOW_CALLBACK_URL and WORKFLOW_CALLBACK_TOKEN are required.",
    );
  const response = await fetch(
    `${config.callbackUrl.replace(/\/$/, "")}/api/internal/workflow/${encodeURIComponent(planId)}/${stage}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!response.ok)
    throw new Error(`ContextMesh ${stage} stage failed (${response.status}).`);
  return response.json();
}
const retry = { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 };
export const validatePaymentPlan = task(
  { name: "validatePaymentPlan", retry, timeoutSeconds: 120 },
  async (_ctx, planId: string) => callback(planId, "validate"),
);
export const executePayPalPayout = task(
  { name: "executePayPalPayout", retry, timeoutSeconds: 120 },
  async (_ctx, planId: string) => callback(planId, "execute"),
);
export const synchronizeFinancialGraph = task(
  { name: "synchronizeFinancialGraph", retry, timeoutSeconds: 300 },
  async (_ctx, planId: string) => callback(planId, "sync"),
);
export const settleProject = task(
  { name: "settleProject", timeoutSeconds: 600 },
  async (ctx, planId: string) => {
    await ctx.run(validatePaymentPlan, planId);
    const result = await ctx.run(executePayPalPayout, planId);
    await ctx.run(synchronizeFinancialGraph, planId);
    return result;
  },
);
