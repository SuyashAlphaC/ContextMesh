import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Check,
  CircleCheck,
  Clock3,
  Command,
  GitBranch,
  LayoutDashboard,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Network,
  PanelTop,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  X,
  AlertTriangle,
  ExternalLink,
  Activity,
  ChevronRight,
} from "lucide-react";
import { api } from "./api";
import {
  DEFAULT_INSTRUCTION,
  formatMoney,
  type Snapshot,
  type Plan,
  type GraphNode,
} from "../shared/types";
const Studio = lazy(() => import("./Studio"));
const tabs = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Payment plans", icon: Layers3 },
  { name: "Context graph", icon: Network },
  { name: "Analytics studio", icon: PanelTop },
  { name: "Collaborators", icon: Users },
  { name: "Activity", icon: Activity },
  { name: "Integrations", icon: Settings2 },
];
const titles: Record<string, [string, string]> = {
  Overview: [
    "Money, with context.",
    "Your projects, people, and payments. Connected.",
  ],
  "Payment plans": [
    "Every payment has a plan.",
    "Review the reasoning. Approve the action. Follow the outcome.",
  ],
  "Context graph": [
    "See the whole relationship.",
    "The connected context behind every financial decision.",
  ],
  "Analytics studio": [
    "Ask more of your numbers.",
    "Build a financial workspace that answers your questions.",
  ],
  Collaborators: [
    "The people behind the work.",
    "Trusted relationships make better payment decisions.",
  ],
  Activity: [
    "Nothing happens without a trace.",
    "A transparent record of instructions, approvals, and payments.",
  ],
  Integrations: [
    "Connected by purpose.",
    "Every integration has a specific job in your workflow.",
  ],
};
function Status({ value }: { value: string }) {
  return (
    <span
      className={`status ${["completed", "paid", "approved"].includes(value) ? "success" : ["blocked", "refunded", "rejected"].includes(value) ? "danger" : ""}`}
    >
      <i />
      {value.replaceAll("_", " ")}
    </span>
  );
}
export function App() {
  const [state, setState] = useState<Snapshot>();
  const [tab, setTab] = useState("Overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<"loading" | "login" | "ready">("loading");
  const [token, setToken] = useState("");
  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION);
  const [projectId, setProjectId] = useState("greencart");
  const [showComposer, setShowComposer] = useState(false);
  useEffect(() => {
    if (!showComposer) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setShowComposer(false);
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, textarea, [tabindex="0"]',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [showComposer, busy]);
  const refresh = useCallback(async () => {
    setState(await api<Snapshot>("/state"));
  }, []);
  useEffect(() => {
    api<{ required: boolean; authenticated: boolean }>("/auth")
      .then((a) => setAuth(a.required && !a.authenticated ? "login" : "ready"))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (auth !== "ready") return;
    void refresh().catch((e) => setError(e.message));
    const interval = setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [auth, refresh]);
  async function action(fn: () => Promise<unknown>, message = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (auth === "ready") await refresh();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!state || auth !== "ready") return;
    const query = new URLSearchParams(location.search);
    if (query.get("checkout") === "approved" && query.get("project")) {
      const id = query.get("project")!;
      history.replaceState({}, "", "/");
      void action(
        () => api(`/projects/${id}/capture`, {}),
        "PayPal Sandbox payment confirmed.",
      );
    }
  }, [Boolean(state), auth]);
  if (auth === "login")
    return (
      <main className="login">
        <div className="logo-icon">
          <Network />
        </div>
        <h1>Welcome to ContextMesh</h1>
        <p>Enter your workspace access token.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api("/login", { token });
              setAuth("ready");
            });
          }}
        >
          <label htmlFor="token">Access token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button disabled={busy}>
            Open workspace <ArrowRight size={16} />
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  if (!state)
    return (
      <main className="loading">
        <Network size={36} />
        <h1>ContextMesh</h1>
        <p>{error || "Connecting your financial context…"}</p>
      </main>
    );
  const activePlans = state.plans.filter(
    (p) => !["rejected", "blocked", "completed"].includes(p.status),
  );
  const paid = state.projects
    .filter((p) => p.status === "paid")
    .reduce((s, p) => s + p.amountCents, 0);
  const committed = state.plans
    .filter((p) => ["submitted", "completed"].includes(p.status))
    .flatMap((p) => p.allocations);
  const payouts = committed
    .filter((a) => a.kind === "payout")
    .reduce((s, a) => s + a.amountCents, 0);
  const reserved = committed
    .filter((a) => a.kind === "reserve")
    .reduce((s, a) => s + a.amountCents, 0);
  const planAction = (plan: Plan, operation: string) =>
    action(
      () => api(`/plans/${plan.id}/${operation}`, {}),
      operation === "approve"
        ? "Plan approved. You can now execute the payouts."
        : operation === "execute"
          ? "Execution requested. Follow the outcome in your timeline."
          : "Plan updated.",
    );
  const createPlan = () =>
    action(async () => {
      await api("/plans", { projectId, instruction });
      setShowComposer(false);
      setTab("Payment plans");
    }, "Your payment plan is ready.");
  return (
    <div className="app-shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="ContextMesh home">
          <span className="logo-icon">
            <Network size={24} />
          </span>
          Context<span>Mesh</span>
        </a>
        <div className="workspace">
          <span className="avatar">S</span>
          <div>
            <strong>Studio workspace</strong>
            <small>Freelancers & small teams</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {tabs.map((t) => (
            <button
              key={t.name}
              className={tab === t.name ? "nav-item active" : "nav-item"}
              onClick={() => setTab(t.name)}
              aria-current={tab === t.name ? "page" : undefined}
            >
              <t.icon size={18} />
              {t.name}
              {t.name === "Payment plans" && activePlans.length > 0 && (
                <span className="nav-count">{activePlans.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="trust-note">
            <ShieldCheck size={19} />
            <strong>Your approval. Always.</strong>
            <p>Every payout is bound to the plan you review.</p>
          </div>
          <div className="profile">
            <span className="avatar dark">S</span>
            <div>
              <strong>Studio owner</strong>
              <small>Single workspace</small>
            </div>
            <span className="online-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>{tab}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <i />
              {state.mode === "demo"
                ? "Simulation workspace"
                : "PayPal Sandbox"}
            </span>
            <button
              className="icon-button"
              onClick={() => setTab("Integrations")}
              aria-label="Integration settings"
            >
              <Settings2 size={18} />
            </button>
            <span className="avatar">S</span>
          </div>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">YOUR FINANCIAL OPERATING SYSTEM</p>
              <h1>{titles[tab][0]}</h1>
              <p>{titles[tab][1]}</p>
            </div>
            <button
              className="primary"
              onClick={() => setShowComposer(true)}
              disabled={busy}
            >
              <Plus size={17} />
              New payment plan
            </button>
          </div>
          {state.mode === "demo" && (
            <div className="mode-note">
              <span>
                <Sparkles size={14} />
                Interactive simulation
              </span>
              <p>
                No money moves. Connect your Sandbox and AI credentials in
                Integrations for the live workflow.
              </p>
            </div>
          )}
          <div aria-live="polite" className="feedback">
            {error && (
              <div className="error">
                <AlertTriangle size={17} />
                {error}
                <button aria-label="Dismiss error" onClick={() => setError("")}>
                  <X size={15} />
                </button>
              </div>
            )}
            {notice && (
              <div className="notice">
                <Check size={17} />
                {notice}
                <button
                  aria-label="Dismiss notice"
                  onClick={() => setNotice("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </div>
          {tab === "Overview" && (
            <>
              <section className="metrics" aria-label="Financial overview">
                {[
                  {
                    label: "Payments received",
                    value: formatMoney(paid),
                    hint: `${state.projects.filter((p) => p.status === "paid").length} confirmed projects`,
                    icon: ArrowDownLeft,
                  },
                  {
                    label: "Collaborator payouts",
                    value: formatMoney(payouts),
                    hint: "Submitted + completed payouts",
                    icon: ArrowUpRight,
                  },
                  {
                    label: "Reserved in ledger",
                    value: formatMoney(reserved),
                    hint: "Taxes + operating expenses",
                    icon: Wallet,
                  },
                  {
                    label: "Plans in progress",
                    value: String(activePlans.length).padStart(2, "0"),
                    hint: "Waiting, reviewing, or executing",
                    icon: GitBranch,
                  },
                ].map((m) => (
                  <article className="metric" key={m.label}>
                    <div>
                      <span>{m.label}</span>
                      <m.icon size={18} />
                    </div>
                    <strong>{m.value}</strong>
                    <small>{m.hint}</small>
                  </article>
                ))}
              </section>
              <div className="overview-grid">
                <section className="command-card">
                  <div className="card-kicker">
                    <Sparkles size={16} />
                    CONTEXTMESH ASSISTANT<span>{state.integrations.ai}</span>
                  </div>
                  <h2>
                    Give your money
                    <br />a direction.
                  </h2>
                  <p>
                    Tell us who to pay and when. Your context becomes an
                    explainable plan.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void createPlan();
                    }}
                  >
                    <label htmlFor="overview-project">Project</label>
                    <select
                      id="overview-project"
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                    >
                      {state.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {formatMoney(p.amountCents)}
                        </option>
                      ))}
                    </select>
                    <label htmlFor="overview-instruction" className="sr-only">
                      Payment instruction
                    </label>
                    <textarea
                      id="overview-instruction"
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      rows={3}
                    />
                    <div className="command-footer">
                      <span>
                        <LockKeyhole size={13} />
                        Approval required before payouts
                      </span>
                      <button disabled={busy}>
                        {busy ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Send size={17} />
                        )}
                        Create plan
                      </button>
                    </div>
                  </form>
                  <div className="suggestions">
                    <span>Try a split:</span>
                    <button
                      onClick={() =>
                        setInstruction(
                          "Pay Maya 50%, Arjun 35%, reserve 10% for taxes and 5% for expenses.",
                        )
                      }
                    >
                      50 / 35 / 10 / 5 <ArrowRight size={12} />
                    </button>
                  </div>
                </section>
                <section className="panel graph-preview">
                  <div className="section-title">
                    <div>
                      <p className="eyebrow">CONNECTED CONTEXT</p>
                      <h2>People. Projects. Payments.</h2>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setTab("Context graph")}
                    >
                      Explore <ArrowUpRight size={15} />
                    </button>
                  </div>
                  <Graph state={state} compact />
                  <div className="graph-caption">
                    <span>
                      <i className="online-dot" /> {state.graph.nodes.length}{" "}
                      connected entities
                    </span>
                    <small>Every action starts with a relationship.</small>
                  </div>
                </section>
              </div>
              <section className="panel">
                <div className="section-title">
                  <div>
                    <p className="eyebrow">MONEY IN MOTION</p>
                    <h2>Your projects</h2>
                  </div>
                  <span className="subtle">
                    {state.projects.length} active relationships
                  </span>
                </div>
                <Projects state={state} busy={busy} action={action} />
              </section>
              <div className="bottom-grid">
                <section className="panel">
                  <div className="section-title">
                    <h2>Next decisions</h2>
                    <button
                      className="text-button"
                      onClick={() => setTab("Payment plans")}
                    >
                      View all <ArrowRight size={14} />
                    </button>
                  </div>
                  {activePlans.length ? (
                    activePlans.slice(0, 3).map((p) => (
                      <button
                        key={p.id}
                        className="decision"
                        onClick={() => setTab("Payment plans")}
                      >
                        <span className="decision-icon">
                          <ShieldCheck size={20} />
                        </span>
                        <div>
                          <strong>
                            {
                              state.projects.find((x) => x.id === p.projectId)
                                ?.name
                            }
                          </strong>
                          <small>{p.status.replaceAll("_", " ")}</small>
                        </div>
                        <ArrowRight size={16} />
                      </button>
                    ))
                  ) : (
                    <Empty
                      icon={ShieldCheck}
                      title="You're all caught up"
                      text="Create a payment plan to see your next decision here."
                    />
                  )}
                </section>
                <section className="panel">
                  <div className="section-title">
                    <h2>Recent activity</h2>
                    <button
                      className="text-button"
                      onClick={() => setTab("Activity")}
                    >
                      Timeline <ArrowRight size={14} />
                    </button>
                  </div>
                  <Timeline state={state} limit={3} />
                </section>
              </div>
            </>
          )}
          {tab === "Payment plans" && (
            <>
              {state.plans.length === 0 ? (
                <section className="panel">
                  <Empty
                    icon={Layers3}
                    title="Your first plan starts with an instruction"
                    text="Choose a project, describe the split, and review the plan before any money moves."
                  />
                  <button
                    className="primary centered"
                    onClick={() => setShowComposer(true)}
                  >
                    Create a payment plan <ArrowRight size={16} />
                  </button>
                </section>
              ) : (
                state.plans.map((plan) => (
                  <section className="panel plan-card" key={plan.id}>
                    <div className="section-title">
                      <div>
                        <p className="eyebrow">
                          {plan.provider !== "simulation"
                            ? "AI GENERATED PLAN"
                            : "SIMULATION PLAN"}
                        </p>
                        <h2>
                          {
                            state.projects.find((p) => p.id === plan.projectId)
                              ?.name
                          }
                        </h2>
                      </div>
                      <Status value={plan.status} />
                    </div>
                    <blockquote>“{plan.instruction}”</blockquote>
                    <div className="plan-layout">
                      <div>
                        <h3>Allocation</h3>
                        <div className="allocation-bar">
                          {plan.allocations.map((a, i) => (
                            <span
                              key={a.targetId}
                              style={{
                                width: `${a.basisPoints / 100}%`,
                                background: [
                                  "#173e31",
                                  "#76a991",
                                  "#c7d9a9",
                                  "#e8d8ac",
                                ][i],
                              }}
                            />
                          ))}
                        </div>
                        {plan.allocations.map((a) => (
                          <div className="allocation" key={a.targetId}>
                            <div>
                              <strong>{a.label}</strong>
                              <small>
                                {a.kind === "reserve"
                                  ? "Ledger reserve · no transfer"
                                  : "PayPal collaborator payout"}
                              </small>
                            </div>
                            <span>{a.basisPoints / 100}%</span>
                            <strong>{formatMoney(a.amountCents)}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="reasoning">
                        <h3>
                          <ShieldCheck size={16} />
                          Why this plan
                        </h3>
                        <p>{plan.explanation}</p>
                        <ul>
                          {plan.evidence.map((e, i) => (
                            <li key={i}>
                              <Check size={13} />
                              {e}
                            </li>
                          ))}
                        </ul>
                        {plan.risks.map((r) => (
                          <div className="risk" key={r}>
                            <AlertTriangle size={15} />
                            {r}
                          </div>
                        ))}
                        {plan.error && <div className="risk">{plan.error}</div>}
                      </div>
                    </div>
                    <div className="plan-actions">
                      <small>
                        Created {new Date(plan.createdAt).toLocaleString()} ·{" "}
                        {plan.id.slice(0, 8)}
                      </small>
                      <div>
                        {[
                          "awaiting_payment",
                          "awaiting_approval",
                          "approved",
                        ].includes(plan.status) && (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => void planAction(plan, "reject")}
                          >
                            Reject plan
                          </button>
                        )}
                        {plan.status === "awaiting_payment" && (
                          <span className="subtle">
                            <Clock3 size={14} />
                            Waiting for payment confirmation
                          </span>
                        )}
                        {plan.status === "awaiting_approval" && (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => void planAction(plan, "approve")}
                          >
                            <ShieldCheck size={16} />
                            Approve plan
                          </button>
                        )}
                        {["approved", "executing"].includes(plan.status) && (
                          <button
                            className="primary"
                            disabled={
                              busy || Boolean(plan.workflowRunId && !plan.error)
                            }
                            onClick={() => void planAction(plan, "execute")}
                          >
                            <ArrowUpRight size={16} />
                            {plan.status === "executing"
                              ? "Retry same request"
                              : plan.workflowRunId
                                ? "Workflow dispatched"
                                : "Execute payouts"}
                          </button>
                        )}
                        {plan.status === "submitted" && (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => void planAction(plan, "reconcile")}
                          >
                            Check PayPal status
                          </button>
                        )}
                        {plan.status === "completed" && (
                          <span className="completed">
                            <CircleCheck size={17} />
                            {state.mode === "demo"
                              ? "Simulation completed"
                              : "All payouts confirmed"}
                          </span>
                        )}
                      </div>
                    </div>
                  </section>
                ))
              )}
              <section className="panel">
                <div className="section-title">
                  <h2>Payment sources</h2>
                </div>
                <Projects state={state} busy={busy} action={action} />
              </section>
            </>
          )}
          {tab === "Context graph" && (
            <section className="panel">
              <div className="section-title">
                <h2>Financial relationship graph</h2>
                <span className="subtle">{state.integrations.graph}</span>
              </div>
              <Graph state={state} />
              <div className="graph-legend">
                {[
                  "Organization",
                  "Project",
                  "Invoice",
                  "Recipient",
                  "Plan",
                  "Reserve",
                ].map((t) => (
                  <span key={t}>
                    <i />
                    {t}
                  </span>
                ))}
              </div>
            </section>
          )}
          {tab === "Analytics studio" && (
            <section className="panel studio-panel">
              <Suspense
                fallback={
                  <div className="loading">
                    <LoaderCircle className="spin" />
                    Loading AG Studio…
                  </div>
                }
              >
                <Studio state={state} />
              </Suspense>
            </section>
          )}
          {tab === "Collaborators" && (
            <div className="collaborator-grid">
              {state.recipients.map((r) => (
                <section className="panel collaborator" key={r.id}>
                  <span className="avatar large">
                    {r.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")}
                  </span>
                  <h2>{r.name}</h2>
                  <p>{r.role}</p>
                  <Status value={r.trusted ? "approved" : "review required"} />
                  <p className="subtle">Account version {r.accountVersion}</p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const email = new FormData(e.currentTarget).get("email");
                      void action(
                        () => api(`/recipients/${r.id}`, { email }, "PATCH"),
                        "Account updated. Existing plans must be recreated before approval.",
                      );
                    }}
                  >
                    <label htmlFor={`email-${r.id}`}>
                      PayPal recipient email
                    </label>
                    <input
                      id={`email-${r.id}`}
                      key={r.email}
                      name="email"
                      type="email"
                      defaultValue={r.email}
                      required
                    />
                    <button className="secondary" disabled={busy}>
                      Update account
                    </button>
                  </form>
                  <small>
                    Changing this account invalidates any plan using the
                    previous version.
                  </small>
                </section>
              ))}
            </div>
          )}
          {tab === "Activity" && (
            <section className="panel">
              <Timeline state={state} />
            </section>
          )}
          {tab === "Integrations" && (
            <>
              <div className="integrations">
                {[
                  {
                    name: "PayPal",
                    status: state.integrations.payments,
                    desc: "Checkout Orders v2, capture verification, Payouts v1, and signature-verified webhooks.",
                    vars: "CONTEXTMESH_MODE=sandbox · PAYPAL_CLIENT_ID · PAYPAL_CLIENT_SECRET · PAYPAL_WEBHOOK_ID",
                    url: "https://developer.paypal.com/dashboard/",
                  },
                  {
                    name: "HydraDB",
                    status: state.integrations.graph,
                    desc: "Persistent financial relationships queried before planning. SQLite preserves the decision ledger and pending graph revisions.",
                    vars: "HYDRADB_URL · HYDRADB_TOKEN · HYDRADB_NAMESPACE · HYDRADB_GRAPH · HYDRADB_CELL",
                    url: "https://github.com/hydra-db/hydradb",
                  },
                  {
                    name: "AG Studio",
                    status: state.integrations.studio,
                    desc: "Live financial data, custom approval widgets, editable dashboards, and a provider-connected Studio Agent Framework.",
                    vars: "VITE_AG_STUDIO_LICENSE_KEY · ANTHROPIC_API_KEY",
                    url: "https://www.ag-grid.com/studio/",
                  },
                  {
                    name: "Render Workflows",
                    status: state.integrations.workflows,
                    desc: "Chained validation, payment execution, and graph synchronization tasks. Human approval is persisted before dispatch.",
                    vars: "RENDER_API_KEY · RENDER_TASK_SLUG · WORKFLOW_CALLBACK_URL · WORKFLOW_CALLBACK_TOKEN",
                    url: "https://render.com/docs/workflows",
                  },
                  {
                    name: "AI planner",
                    status: state.integrations.ai,
                    desc: "Structured instruction interpretation and dashboard tool calls. All financial amounts and permissions are validated by the server.",
                    vars: "ANTHROPIC_API_KEY · ANTHROPIC_MODEL",
                    url: "https://platform.claude.com/docs/",
                  },
                ].map((i) => (
                  <section className="panel integration" key={i.name}>
                    <div className="section-title">
                      <h2>{i.name}</h2>
                      <a
                        href={i.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${i.name} documentation`}
                      >
                        <ExternalLink size={17} />
                      </a>
                    </div>
                    <span className="integration-state">{i.status}</span>
                    <p>{i.desc}</p>
                    <code>{i.vars}</code>
                  </section>
                ))}
              </div>
              <div className="panel integration-help">
                <h2>Connect your accounts</h2>
                <p>
                  Add credentials to the repository’s <code>.env</code> file
                  using <code>.env.example</code>, then restart the app. Secret
                  keys stay on the server. AG Studio’s license key is public by
                  design.
                </p>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(
                      () => api("/graph/sync", {}),
                      "Graph synchronization checked.",
                    )
                  }
                >
                  Synchronize graph
                </button>
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              <Network size={13} />
              ContextMesh
            </span>
            <span>Context → Plan → Approval → Payment → Explanation</span>
          </footer>
        </main>
      </div>
      {showComposer && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setShowComposer(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composer-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Close payment plan"
              onClick={() => setShowComposer(false)}
              disabled={busy}
            >
              <X size={20} />
            </button>
            <span className="logo-icon">
              <Sparkles size={22} />
            </span>
            <h2 id="composer-title">A plan starts with context.</h2>
            <p>Choose a project and tell us how to allocate its payment.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createPlan();
              }}
            >
              <label htmlFor="project">Project</label>
              <select
                id="project"
                autoFocus
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {formatMoney(p.amountCents)}
                  </option>
                ))}
              </select>
              <label htmlFor="instruction">Your instruction</label>
              <textarea
                id="instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={5}
                required
                minLength={10}
              />
              <p className="subtle">
                Use Maya, Arjun, taxes, and expenses. Percentages must total
                100%.
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Sparkles size={16} />
                )}
                Generate payment plan
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof ShieldCheck;
  title: string;
  text: string;
}) {
  return (
    <div className="empty">
      <span>
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Projects({
  state,
  busy,
  action,
}: {
  state: Snapshot;
  busy: boolean;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Project / client</th>
            <th>Amount</th>
            <th>Payment status</th>
            <th>Next action</th>
          </tr>
        </thead>
        <tbody>
          {state.projects.map((p) => (
            <tr key={p.id}>
              <td>
                <div className="project-cell">
                  <span className={`project-icon ${p.id}`}>{p.client[0]}</span>
                  <div>
                    <strong>{p.name}</strong>
                    <small>{p.client}</small>
                  </div>
                </div>
              </td>
              <td className="money">
                {formatMoney(p.amountCents)}
                <small>USD</small>
              </td>
              <td>
                <Status value={p.status} />
              </td>
              <td>
                {p.status === "unpaid" ? (
                  state.mode === "demo" ? (
                    <button
                      className="table-action"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () => api(`/projects/${p.id}/simulate-payment`, {}),
                          "Simulated payment confirmed. Your plans are ready for review.",
                        )
                      }
                    >
                      Simulate payment <ArrowRight size={14} />
                    </button>
                  ) : (
                    <div className="inline-actions">
                      <button
                        className="table-action"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const order = await api<{ approvalUrl: string }>(
                              `/projects/${p.id}/order`,
                              {},
                            );
                            window.location.assign(order.approvalUrl);
                          })
                        }
                      >
                        Pay in Sandbox <ArrowRight size={14} />
                      </button>
                      {p.orderId && (
                        <button
                          className="table-action"
                          disabled={busy}
                          onClick={() =>
                            void action(
                              () => api(`/projects/${p.id}/capture`, {}),
                              "Payment confirmed.",
                            )
                          }
                        >
                          Confirm payment
                        </button>
                      )}
                    </div>
                  )
                ) : (
                  <span className="subtle">
                    <CircleCheck size={14} />{" "}
                    {p.status === "paid" ? "Confirmed" : "Review required"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Timeline({ state, limit }: { state: Snapshot; limit?: number }) {
  return (
    <ol className="timeline">
      {state.events.slice(0, limit).map((e) => (
        <li key={e.id}>
          <span className={`event-icon ${e.kind}`}>
            <span />
          </span>
          <div>
            <strong>{e.title}</strong>
            <p>{e.detail}</p>
            <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
function Graph({
  state,
  compact = false,
}: {
  state: Snapshot;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<GraphNode>();
  const nodes = compact
    ? state.graph.nodes.filter((n) =>
        [
          "workspace",
          "greencart",
          "invoice:greencart",
          "maya",
          "arjun",
          "taxes",
        ].includes(n.id),
      )
    : state.graph.nodes;
  const w = 800,
    h = compact ? 420 : 600;
  const positions = new Map(
    nodes.map((n, i) => [
      n.id,
      n.id === "workspace"
        ? { x: w / 2, y: h / 2 }
        : {
            x:
              w / 2 +
              Math.cos(
                ((i - 1) * Math.PI * 2) / (nodes.length - 1) - Math.PI / 2,
              ) *
                (compact ? 245 : 280),
            y:
              h / 2 +
              Math.sin(
                ((i - 1) * Math.PI * 2) / (nodes.length - 1) - Math.PI / 2,
              ) *
                (compact ? 135 : 210),
          },
    ]),
  );
  const links = state.graph.edges.filter(
    (e) => positions.has(e.source) && positions.has(e.target),
  );
  return (
    <div className={`graph ${compact ? "compact" : ""}`}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="Financial relationships. Select an entity to inspect its context."
      >
        <defs>
          <pattern
            id={compact ? "dots-small" : "dots"}
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="1" fill="#c8d4cc" />
          </pattern>
        </defs>
        <rect
          width={w}
          height={h}
          fill={`url(#${compact ? "dots-small" : "dots"})`}
        />
        {links.map((e) => {
          const a = positions.get(e.source)!,
            b = positions.get(e.target)!;
          return (
            <g key={e.id}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#a8beb0"
                strokeWidth="1.5"
                strokeDasharray="5 5"
              />
              {!compact && (
                <text
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 5}
                  textAnchor="middle"
                  className="edge-label"
                >
                  {e.type.toLowerCase().replaceAll("_", " ")}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = positions.get(n.id)!;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${n.type}: ${n.label}`}
              onClick={() => setSelected(n)}
              onKeyDown={(e) => {
                if (["Enter", " "].includes(e.key)) {
                  e.preventDefault();
                  setSelected(n);
                }
              }}
              className={`graph-node ${n.type === "Organization" ? "core" : ""}`}
            >
              <rect x="-62" y="-26" width="124" height="52" rx="12" />
              <text textAnchor="middle" y="-3" className="node-kind">
                {n.type.toUpperCase()}
              </text>
              <text textAnchor="middle" y="13">
                {n.label.length > 19 ? n.label.slice(0, 17) + "…" : n.label}
              </text>
            </g>
          );
        })}
      </svg>
      {selected && (
        <div className="graph-detail">
          <button
            className="icon-button"
            aria-label="Close entity details"
            onClick={() => setSelected(undefined)}
          >
            <X size={15} />
          </button>
          <strong>{selected.label}</strong>
          <small>{selected.type}</small>
          {Object.entries(selected.properties).map(([key, value]) => (
            <p key={key}>
              <span>{key}</span>
              {String(value)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
