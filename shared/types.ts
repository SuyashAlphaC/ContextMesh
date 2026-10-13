export type PlanStatus =
  | "awaiting_payment"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "submitted"
  | "completed"
  | "rejected"
  | "blocked";
export interface Recipient {
  id: string;
  name: string;
  role: string;
  email: string;
  trusted: boolean;
  accountVersion: number;
}
export interface Project {
  id: string;
  name: string;
  client: string;
  amountCents: number;
  currency: "USD";
  status: "unpaid" | "paid" | "refunded";
  orderId?: string;
  captureId?: string;
  paidAt?: string;
}
export interface Allocation {
  targetId: string;
  label: string;
  kind: "payout" | "reserve";
  basisPoints: number;
  amountCents: number;
  email?: string;
  accountVersion?: number;
}
export interface Plan {
  id: string;
  projectId: string;
  instruction: string;
  status: PlanStatus;
  allocations: Allocation[];
  evidence: string[];
  explanation: string;
  risks: string[];
  createdAt: string;
  approvedAt?: string;
  payoutBatchId?: string;
  error?: string;
  provider: "simulation" | "anthropic" | "gemini";
  workflowRunId?: string;
}
export interface AuditEvent {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
  projectId?: string;
  planId?: string;
}
export interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, string | number | boolean>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}
export interface State {
  projects: Project[];
  recipients: Recipient[];
  plans: Plan[];
  events: AuditEvent[];
  webhookIds: string[];
  graphRevision: number;
}
export interface Snapshot extends State {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  integrations: {
    payments: string;
    ai: string;
    graph: string;
    workflows: string;
    studio: string;
  };
  mode: "demo" | "sandbox";
}
export interface Intent {
  allocations: { targetId: string; basisPoints: number }[];
  explanation: string;
}
export const DEFAULT_INSTRUCTION =
  "When GreenCart pays, pay Maya 60%, Arjun 25%, reserve 10% for taxes and keep 5% for expenses.";
export const formatMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
