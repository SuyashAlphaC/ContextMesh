import "dotenv/config";
import { resolve } from "node:path";
export const config = {
  port: Number(process.env.PORT || 4310),
  mode: (process.env.CONTEXTMESH_MODE || "demo") as "demo" | "sandbox",
  dataDir: resolve(process.env.DATA_DIR || "./data"),
  publicUrl: process.env.PUBLIC_URL || "http://localhost:5173",
  accessToken: process.env.APP_ACCESS_TOKEN || "",
  callbackToken: process.env.WORKFLOW_CALLBACK_TOKEN || "",
  paypalId: process.env.PAYPAL_CLIENT_ID || "",
  paypalSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
  aiKey: process.env.ANTHROPIC_API_KEY || "",
  aiProvider: process.env.AI_PROVIDER || "auto",
  geminiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  aiModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
  hydraUrl: process.env.HYDRADB_URL || "",
  hydraToken: process.env.HYDRADB_TOKEN || "",
  hydraNamespace: process.env.HYDRADB_NAMESPACE || "default",
  hydraGraph: process.env.HYDRADB_GRAPH || "default",
  hydraCell: process.env.HYDRADB_CELL || "cell-0",
  renderKey: process.env.RENDER_API_KEY || "",
  renderTask: process.env.RENDER_TASK_SLUG || "",
  callbackUrl: process.env.WORKFLOW_CALLBACK_URL || "",
};
export function selectedAiProvider(): "gemini" | "anthropic" | "simulation" {
  if (config.aiProvider === "gemini") return "gemini";
  if (config.aiProvider === "anthropic") return "anthropic";
  return config.geminiKey
    ? "gemini"
    : config.aiKey
      ? "anthropic"
      : "simulation";
}
export function validateConfig() {
  if (!["auto", "gemini", "anthropic"].includes(config.aiProvider))
    throw new Error("AI_PROVIDER must be auto, gemini, or anthropic");
  if (config.aiProvider === "gemini" && !config.geminiKey)
    throw new Error("AI_PROVIDER=gemini requires GEMINI_API_KEY");
  if (config.aiProvider === "anthropic" && !config.aiKey)
    throw new Error("AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
  if (!["demo", "sandbox"].includes(config.mode))
    throw new Error("CONTEXTMESH_MODE must be demo or sandbox");
  if (config.mode === "sandbox" && (!config.paypalId || !config.paypalSecret))
    throw new Error(
      "Sandbox requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET",
    );
  if (Boolean(config.hydraUrl) !== Boolean(config.hydraToken))
    throw new Error("Supply both HYDRADB_URL and HYDRADB_TOKEN");
  if (Boolean(config.renderKey) !== Boolean(config.renderTask))
    throw new Error("Supply both RENDER_API_KEY and RENDER_TASK_SLUG");
  if (config.renderTask && (!config.callbackToken || !config.callbackUrl))
    throw new Error(
      "Render requires WORKFLOW_CALLBACK_URL and WORKFLOW_CALLBACK_TOKEN",
    );
  if (process.env.NODE_ENV === "production" && config.accessToken.length < 24)
    throw new Error(
      "Production requires an APP_ACCESS_TOKEN of at least 24 characters",
    );
}
