import { randomUUID } from "node:crypto";
import type { Plan, Project, State, Snapshot } from "../shared/types.js";
import { Store, audit } from "./store.js";
import { HydraGraph, buildGraph } from "./graph.js";
import { PayPal, verifiedCapture, type Order } from "./paypal.js";
import { allocate, validatePlan, DomainError } from "./policy.js";
import { interpret } from "./agent.js";
import { config, selectedAiProvider } from "./config.js";
import { Render } from "@renderinc/sdk";

export class ContextMesh {
  graph: HydraGraph;
  paypal = new PayPal();
  constructor(public store: Store) {
    this.graph = new HydraGraph(store);
  }
  snapshot(): Snapshot {
    const state = this.store.read();
    return {
      ...state,
      graph: buildGraph(state),
      mode: config.mode,
      integrations: {
        payments:
          config.mode === "sandbox" ? "PayPal Sandbox" : "Simulated payments",
        ai:
          selectedAiProvider() === "gemini"
            ? "Gemini configured"
            : selectedAiProvider() === "anthropic"
              ? "Anthropic connected"
              : "Deterministic simulation",
        graph: config.hydraUrl
          ? this.graph.lastError
            ? "HydraDB sync pending"
            : "HydraDB configured"
          : "Local graph · SQLite",
        workflows: config.renderTask
          ? "Render Workflows configured"
          : "Local workflow runner",
        studio: "AG Studio 3.0",
      },
    };
  }
  project(state: State, id: string): Project {
    const p = state.projects.find((p) => p.id === id);
    if (!p) throw new DomainError("Project not found.", 404);
    return p;
  }
  plan(state: State, id: string): Plan {
    const p = state.plans.find((p) => p.id === id);
    if (!p) throw new DomainError("Plan not found.", 404);
    return p;
  }
  async createPlan(projectId: string, instruction: string) {
    return this.store.exclusive(async () => {
      const state = this.store.read();
      const project = this.project(state, projectId);
      if (project.status === "refunded")
        throw new DomainError("This project payment was refunded.");
      if (
        state.plans.some(
          (p) =>
            p.projectId === projectId &&
            !["rejected", "blocked"].includes(p.status),
        )
      )
        throw new DomainError(
          "This project already has an active plan. Reject it before creating another.",
        );
      if (state.plans.some((p) => p.projectId === projectId && p.payoutBatchId))
        throw new DomainError(
          "This project already has a payout batch. Review it before planning another payment.",
        );
      const context = await this.graph.context(projectId, state);
      const { intent, provider } = await interpret(instruction, state, context);
      const plan: Plan = {
        id: randomUUID(),
        projectId,
        instruction,
        status:
          project.status === "paid" ? "awaiting_approval" : "awaiting_payment",
        allocations: allocate(project.amountCents, intent, state),
        evidence: [
          `Project: ${project.name}`,
          `Amount: ${(project.amountCents / 100).toFixed(2)} ${project.currency}`,
          `Context source: ${context.source}`,
          `Payment state: ${project.status}`,
          "Explicit approval required for every payout",
        ],
        explanation: intent.explanation,
        risks: [],
        createdAt: new Date().toISOString(),
        provider,
      };
      if (!plan.allocations.some((a) => a.kind === "payout"))
        throw new DomainError("Include at least one collaborator payout.");
      plan.risks = validatePlan(plan, state, false);
      state.plans.unshift(plan);
      audit(state, {
        kind: "plan",
        title: "Payment plan created",
        detail: `${project.name}: ${provider !== "simulation" ? `${provider} AI-generated` : "simulation"} plan using ${context.source}.`,
        projectId,
        planId: plan.id,
      });
      this.store.save(state);
      return plan;
    });
  }
  markPaid(state: State, project: Project, captureId: string) {
    if (project.status === "paid") return;
    if (project.status === "refunded")
      throw new DomainError("Cannot restore a refunded payment automatically.");
    project.status = "paid";
    project.captureId = captureId;
    project.paidAt = new Date().toISOString();
    for (const plan of state.plans.filter(
      (p) => p.projectId === project.id && p.status === "awaiting_payment",
    )) {
      plan.status = "awaiting_approval";
      plan.evidence.push(`Confirmed capture: ${captureId}`);
    }
    audit(state, {
      kind: "payment",
      title: "Client payment confirmed",
      detail: `${project.client} paid ${(project.amountCents / 100).toFixed(2)} USD. Payout plans are ready for review.`,
      projectId: project.id,
    });
  }
  async simulatePayment(id: string) {
    return this.store.exclusive(async () => {
      if (config.mode !== "demo")
        throw new DomainError("Simulation is disabled in Sandbox mode.");
      const state = this.store.read();
      this.markPaid(state, this.project(state, id), `SIM-CAPTURE-${id}`);
      this.store.save(state);
    });
  }
  async createOrder(id: string) {
    return this.store.exclusive(async () => {
      if (config.mode !== "sandbox")
        throw new DomainError(
          "Enable Sandbox mode to create a PayPal checkout.",
        );
      const state = this.store.read();
      const p = this.project(state, id);
      if (p.status !== "unpaid")
        throw new DomainError("Project is already paid or refunded.");
      const order = p.orderId
        ? await this.paypal.request<{
            id: string;
            links: { rel: string; href: string }[];
          }>(`/v2/checkout/orders/${p.orderId}`)
        : await this.paypal.createOrder(p);
      p.orderId = order.id;
      this.store.save(state);
      const approval = order.links.find((l) =>
        ["approve", "payer-action"].includes(l.rel),
      );
      if (!approval)
        throw new DomainError(
          "Order has no approval link. Use Confirm payment to reconcile a previously approved order.",
        );
      return { approvalUrl: approval.href, orderId: order.id };
    });
  }
  async capture(id: string) {
    return this.store.exclusive(async () => {
      if (config.mode !== "sandbox")
        throw new DomainError("Capture is only available in Sandbox mode.");
      const state = this.store.read();
      const p = this.project(state, id);
      if (p.status === "paid") return;
      if (!p.orderId) throw new DomainError("Create a PayPal checkout first.");
      let order = await this.paypal.order(p.orderId);
      if (order.status === "APPROVED")
        order = await this.paypal.captureOrder(p.orderId);
      this.markPaid(state, p, verifiedCapture(order, p));
      this.store.save(state);
    });
  }
  async approve(id: string) {
    return this.store.exclusive(async () => {
      const state = this.store.read();
      const plan = this.plan(state, id);
      if (plan.status !== "awaiting_approval")
        throw new DomainError("Plan is not awaiting approval.");
      plan.risks = validatePlan(plan, state);
      plan.status = "approved";
      plan.approvedAt = new Date().toISOString();
      audit(state, {
        kind: "approval",
        title: "You approved the plan",
        detail:
          "Approval binds to these amounts and recipient account versions.",
        projectId: plan.projectId,
        planId: id,
      });
      this.store.save(state);
    });
  }
  async reject(id: string) {
    return this.store.exclusive(async () => {
      const state = this.store.read();
      const plan = this.plan(state, id);
      if (
        !["awaiting_payment", "awaiting_approval", "approved"].includes(
          plan.status,
        )
      )
        throw new DomainError(
          "This plan cannot be rejected after execution begins.",
        );
      plan.status = "rejected";
      audit(state, {
        kind: "rejection",
        title: "Plan rejected",
        detail: "No payouts were submitted.",
        planId: id,
        projectId: plan.projectId,
      });
      this.store.save(state);
    });
  }
  async dispatch(id: string) {
    if (!config.renderTask) return this.execute(id);
    return this.store.exclusive(async () => {
      const state = this.store.read();
      const plan = this.plan(state, id);
      if (plan.status !== "approved")
        throw new DomainError("Approve the plan before execution.");
      if (plan.workflowRunId) return;
      validatePlan(plan, state);
      const run = await new Render({
        token: config.renderKey,
      }).workflows.startTask(config.renderTask, [id]);
      plan.workflowRunId = run.taskRunId;
      audit(state, {
        kind: "workflow",
        title: "Render workflow dispatched",
        detail: `Run ${run.taskRunId} will revalidate approval before executing.`,
        planId: id,
        projectId: plan.projectId,
      });
      this.store.save(state);
    });
  }
  async execute(id: string) {
    return this.store.exclusive(async () => {
      const state = this.store.read();
      const plan = this.plan(state, id);
      if (["submitted", "completed"].includes(plan.status)) return plan;
      if (!["approved", "executing"].includes(plan.status) || !plan.approvedAt)
        throw new DomainError("An approved plan is required before execution.");
      plan.risks = validatePlan(plan, state);
      const project = this.project(state, plan.projectId);
      if (config.mode === "sandbox")
        verifiedCapture(await this.paypal.order(project.orderId!), project);
      if (plan.status !== "executing") {
        plan.status = "executing";
        audit(state, {
          kind: "execution",
          title: "Payment execution started",
          detail: `Stable request ID ${plan.id} protects retries from duplicate payouts.`,
          planId: id,
          projectId: plan.projectId,
        });
        this.store.save(state);
      }
      try {
        if (config.mode === "demo") {
          plan.payoutBatchId = `SIM-BATCH-${id}`;
          plan.status = "completed";
        } else {
          const result = await this.paypal.payout(plan);
          plan.payoutBatchId = result.batch_header.payout_batch_id;
          plan.status = "submitted";
        }
        delete plan.error;
        audit(state, {
          kind: "payout",
          title:
            config.mode === "demo"
              ? "Simulated payouts completed"
              : "PayPal payout batch submitted",
          detail: `${plan.allocations.filter((a) => a.kind === "payout").length} collaborators. Reserves stay in your accounting ledger. ${plan.payoutBatchId}`,
          planId: id,
          projectId: plan.projectId,
        });
        this.store.save(state);
        return plan;
      } catch (e) {
        plan.error = e instanceof Error ? e.message : "Execution failed";
        audit(state, {
          kind: "error",
          title: "Execution needs attention",
          detail:
            "The outcome may be unknown. Retrying this same plan uses the original PayPal request ID.",
          planId: id,
          projectId: plan.projectId,
        });
        this.store.save(state);
        throw e;
      }
    });
  }
  async reconcile(id: string) {
    return this.store.exclusive(async () => {
      const state = this.store.read();
      const plan = this.plan(state, id);
      if (!plan.payoutBatchId || config.mode !== "sandbox")
        throw new DomainError("No Sandbox payout batch to reconcile.");
      const batch = await this.paypal.batch(plan.payoutBatchId);
      if (
        batch.items.length ===
          plan.allocations.filter((a) => a.kind === "payout").length &&
        batch.items.every((i) => i.transaction_status === "SUCCESS")
      ) {
        plan.status = "completed";
        audit(state, {
          kind: "payout",
          title: "Every payout confirmed",
          detail: `Verified all items in PayPal batch ${plan.payoutBatchId}.`,
          planId: id,
          projectId: plan.projectId,
        });
      } else {
        plan.error = `Batch ${batch.batch_header.batch_status}: ${batch.items.map((i) => i.transaction_status).join(", ")}. Funds remain committed; review in PayPal Sandbox.`;
      }
      this.store.save(state);
      return plan;
    });
  }
  async changeRecipient(id: string, email: string) {
    return this.store.exclusive(async () => {
      const state = this.store.read();
      const r = state.recipients.find((r) => r.id === id);
      if (!r) throw new DomainError("Recipient not found.", 404);
      if (
        state.plans.some(
          (p) =>
            ["executing", "submitted"].includes(p.status) &&
            p.allocations.some((a) => a.targetId === id),
        )
      )
        throw new DomainError(
          "Wait for active payouts to finish before changing this recipient.",
        );
      r.email = email;
      r.accountVersion++;
      r.trusted = false;
      audit(state, {
        kind: "risk",
        title: "Recipient account changed",
        detail: `${r.name} must be reviewed in a newly created payment plan.`,
      });
      this.store.save(state);
    });
  }
  async webhook(
    headers: Record<string, string | string[] | undefined>,
    event: {
      id: string;
      event_type: string;
      resource: {
        id?: string;
        supplementary_data?: {
          related_ids?: { order_id?: string; capture_id?: string };
        };
      };
    },
    rawEvent?: string,
  ) {
    if (config.mode !== "sandbox")
      throw new DomainError(
        "PayPal webhooks are only accepted in Sandbox mode.",
      );
    await this.paypal.verifyWebhook(headers, event, rawEvent);
    return this.store.exclusive(async () => {
      const state = this.store.read();
      if (state.webhookIds.includes(event.id)) return { duplicate: true };
      if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
        const orderId =
          event.resource.supplementary_data?.related_ids?.order_id;
        const project = state.projects.find((p) => p.orderId === orderId);
        if (project && orderId) {
          const order: Order = await this.paypal.order(orderId);
          this.markPaid(state, project, verifiedCapture(order, project));
        }
      }
      if (
        ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(
          event.event_type,
        )
      ) {
        const captureId =
          event.resource.supplementary_data?.related_ids?.capture_id ||
          event.resource.id;
        const project = state.projects.find((p) => p.captureId === captureId);
        if (project) {
          project.status = "refunded";
          for (const p of state.plans.filter(
            (p) =>
              p.projectId === project.id &&
              ["awaiting_payment", "awaiting_approval", "approved"].includes(
                p.status,
              ),
          ))
            p.status = "blocked";
          audit(state, {
            kind: "risk",
            title: "Payment reversed or refunded",
            detail:
              "Unexecuted payouts blocked. Review any already submitted payouts.",
            projectId: project.id,
          });
        }
      }
      state.webhookIds.push(event.id);
      this.store.save(state);
      return { duplicate: false };
    });
  }
}
