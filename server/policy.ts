import { z } from "zod";
import type { Intent, Plan, State, Allocation } from "../shared/types.js";
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const intentSchema = z.object({
  allocations: z
    .array(
      z.object({
        targetId: z.enum(["maya", "arjun", "taxes", "expenses"]),
        basisPoints: z.number().int().min(1).max(10000),
      }),
    )
    .min(1)
    .max(4),
  explanation: z.string().max(2000),
});
export function allocate(
  amountCents: number,
  intent: Intent,
  state: State,
): Allocation[] {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
    throw new DomainError(
      "Project amount must be a positive integer number of cents.",
    );
  if (intent.allocations.reduce((s, a) => s + a.basisPoints, 0) !== 10000)
    throw new DomainError("Allocations must total exactly 100%.");
  if (
    new Set(intent.allocations.map((a) => a.targetId)).size !==
    intent.allocations.length
  )
    throw new DomainError("A recipient or reserve may only appear once.");
  const numerators = intent.allocations.map(
    (a) => BigInt(amountCents) * BigInt(a.basisPoints),
  );
  const amounts = numerators.map((value) => Number(value / 10000n));
  const ranked = intent.allocations
    .map((_a, i) => ({ i, fraction: Number(numerators[i] % 10000n) }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  const remainder = amountCents - amounts.reduce((s, a) => s + a, 0);
  for (let i = 0; i < remainder; i++) amounts[ranked[i].i]++;
  return intent.allocations.map((a, i) => {
    const recipient = state.recipients.find((r) => r.id === a.targetId);
    if (!recipient && !["taxes", "expenses"].includes(a.targetId))
      throw new DomainError("Unknown recipient.");
    if (amounts[i] === 0)
      throw new DomainError("Every allocation must receive at least one cent.");
    return {
      ...a,
      amountCents: amounts[i],
      label:
        recipient?.name ||
        (a.targetId === "taxes" ? "Tax reserve" : "Operating expenses"),
      kind: recipient ? "payout" : "reserve",
      ...(recipient
        ? { email: recipient.email, accountVersion: recipient.accountVersion }
        : {}),
    };
  });
}
export function validatePlan(
  plan: Plan,
  state: State,
  requirePaid = true,
): string[] {
  const project = state.projects.find((p) => p.id === plan.projectId);
  if (!project) throw new DomainError("Project not found.", 404);
  if (requirePaid && project.status !== "paid")
    throw new DomainError("A confirmed payment is required before payouts.");
  if (
    state.plans.some(
      (p) =>
        p.id !== plan.id &&
        p.projectId === plan.projectId &&
        ["executing", "submitted", "completed"].includes(p.status),
    )
  )
    throw new DomainError("This project already has a payout commitment.");
  if (
    plan.allocations.reduce((s, a) => s + a.amountCents, 0) !==
    project.amountCents
  )
    throw new DomainError("Plan amounts no longer match the project payment.");
  const risks: string[] = [];
  for (const a of plan.allocations.filter((a) => a.kind === "payout")) {
    const r = state.recipients.find((r) => r.id === a.targetId);
    if (!r || r.email !== a.email || r.accountVersion !== a.accountVersion)
      throw new DomainError(
        "A recipient account changed after planning. Create a new plan to review the new account.",
      );
    if (!r.trusted) risks.push(`${r.name} is not a verified collaborator.`);
    if (a.amountCents > 150000)
      risks.push(`${a.label} exceeds the $1,500 review threshold.`);
  }
  return risks;
}
