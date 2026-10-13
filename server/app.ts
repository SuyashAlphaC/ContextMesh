import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { ContextMesh } from "./service.js";
import { DomainError, validatePlan } from "./policy.js";
import { callModel } from "./agent.js";

function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function createApp(mesh: ContextMesh) {
  const app = express();
  const webhookBodies = new WeakMap<express.Request, string>();
  const sessionSecret = randomBytes(32);
  const session = () => {
    const timestamp = Date.now().toString();
    return `${timestamp}.${createHmac("sha256", sessionSecret).update(timestamp).digest("hex")}`;
  };
  const validSession = (value: string) => {
    const [timestamp, signature] = value.split(".");
    return (
      /^\d+$/.test(timestamp || "") &&
      Date.now() - Number(timestamp) >= 0 &&
      Date.now() - Number(timestamp) < 86400000 &&
      equal(
        signature || "",
        createHmac("sha256", sessionSecret).update(timestamp).digest("hex"),
      )
    );
  };
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "worker-src": ["'self'", "blob:"],
          "img-src": ["'self'", "data:", "blob:"],
          "font-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use(
    express.json({
      limit: "1mb",
      verify(req, _res, buffer) {
        if (req.url?.split("?")[0] === "/api/webhooks/paypal")
          webhookBodies.set(req as express.Request, buffer.toString("utf8"));
      },
    }),
  );
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, app: "contextmesh" }),
  );
  app.get("/api/auth", (req, res) => {
    const cookie =
      req.headers.cookie?.match(/(?:^|; )cm_session=([^;]+)/)?.[1] || "";
    res.json({
      required: Boolean(config.accessToken),
      authenticated: !config.accessToken || validSession(cookie),
    });
  });
  app.post(
    "/api/login",
    rateLimit({ windowMs: 60000, limit: 10 }),
    (req, res) => {
      const token = z.string().max(512).parse(req.body.token);
      if (!config.accessToken || !equal(token, config.accessToken))
        throw new DomainError("Access token is incorrect.", 401);
      res.cookie("cm_session", session(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 86400000,
      });
      res.json({ ok: true });
    },
  );
  app.post("/api/webhooks/paypal", async (req, res) => {
    z.object({
      id: z.string().max(200),
      event_type: z.string(),
      resource: z.object({
        id: z.string().optional(),
        supplementary_data: z
          .object({
            related_ids: z
              .object({
                order_id: z.string().optional(),
                capture_id: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    }).parse(req.body);
    // Validate shape without replacing the signed event with Zod's stripped projection.
    res.json(await mesh.webhook(req.headers, req.body, webhookBodies.get(req)));
  });
  app.post("/api/internal/workflow/:id/:stage", async (req, res) => {
    if (
      !config.callbackToken ||
      !equal(req.headers.authorization || "", `Bearer ${config.callbackToken}`)
    )
      throw new DomainError("Invalid workflow credentials.", 401);
    if (req.params.stage === "validate") {
      const state = mesh.snapshot();
      const plan = state.plans.find((p) => p.id === req.params.id);
      if (
        !plan ||
        !["approved", "executing", "submitted", "completed"].includes(
          plan.status,
        )
      )
        throw new DomainError("Plan is no longer approved.");
      if (["approved", "executing"].includes(plan.status))
        validatePlan(plan, state);
      res.json({ ok: true, planId: plan.id });
    } else if (req.params.stage === "execute")
      res.json(await mesh.execute(req.params.id));
    else if (req.params.stage === "sync") {
      await mesh.store.exclusive(async () =>
        mesh.graph.sync(mesh.store.read()),
      );
      if (mesh.graph.lastError)
        throw new DomainError(mesh.graph.lastError, 502);
      res.json({ ok: true });
    } else throw new DomainError("Unknown workflow stage.", 404);
  });
  app.use("/api", (req, _res, next) => {
    const cookie =
      req.headers.cookie?.match(/(?:^|; )cm_session=([^;]+)/)?.[1] || "";
    if (
      config.accessToken &&
      !validSession(cookie) &&
      !equal(req.headers.authorization || "", `Bearer ${config.accessToken}`)
    )
      return next(new DomainError("Sign in to your workspace.", 401));
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== new URL(config.publicUrl).origin
    )
      return next(new DomainError("Request origin is not allowed.", 403));
    next();
  });
  app.use("/api", rateLimit({ windowMs: 60000, limit: 180 }));
  app.get("/api/state", (_req, res) => res.json(mesh.snapshot()));
  app.post("/api/plans", async (req, res) => {
    const input = z
      .object({
        projectId: z.string().max(100),
        instruction: z.string().min(10).max(3000),
      })
      .parse(req.body);
    res
      .status(201)
      .json(await mesh.createPlan(input.projectId, input.instruction));
  });
  app.post("/api/projects/:id/simulate-payment", async (req, res) => {
    await mesh.simulatePayment(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/projects/:id/order", async (req, res) =>
    res.json(await mesh.createOrder(req.params.id)),
  );
  app.post("/api/projects/:id/capture", async (req, res) => {
    await mesh.capture(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/plans/:id/approve", async (req, res) => {
    await mesh.approve(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/plans/:id/reject", async (req, res) => {
    await mesh.reject(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/plans/:id/execute", async (req, res) => {
    await mesh.dispatch(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/plans/:id/reconcile", async (req, res) =>
    res.json(await mesh.reconcile(req.params.id)),
  );
  app.patch("/api/recipients/:id", async (req, res) => {
    const { email } = z.object({ email: z.email().max(254) }).parse(req.body);
    await mesh.changeRecipient(req.params.id, email);
    res.json({ ok: true });
  });
  app.post("/api/graph/sync", async (_req, res) => {
    await mesh.store.exclusive(async () => mesh.graph.sync(mesh.store.read()));
    if (mesh.graph.lastError) throw new DomainError(mesh.graph.lastError, 502);
    res.json({ ok: true, configured: Boolean(config.hydraUrl) });
  });
  app.post("/api/studio/model", async (req, res) => {
    const input = z
      .object({
        system: z.string().max(100000),
        messages: z.array(z.unknown()).max(100),
        tools: z.array(z.unknown()).max(100).optional(),
      })
      .parse(req.body);
    res.json(await callModel(input.system, input.messages, input.tools));
  });
  app.use("/api", (_req, _res, next) =>
    next(new DomainError("API route not found.", 404)),
  );
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        error instanceof DomainError
          ? error.status
          : error instanceof z.ZodError ||
              (error instanceof SyntaxError &&
                "status" in error &&
                error.status === 400)
            ? 400
            : 500;
      const message =
        error instanceof z.ZodError
          ? "Invalid request fields."
          : error instanceof Error && status < 500
            ? error.message
            : error instanceof DomainError
              ? error.message
              : "Something went wrong. No unapproved payment was attempted.";
      if (status === 500)
        console.error(
          "Application error:",
          error instanceof Error ? error.message : "Unknown error",
        );
      res.status(status).json({ error: message });
    },
  );
  return app;
}
