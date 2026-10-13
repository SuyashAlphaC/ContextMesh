import { createContext, useContext, useMemo, useRef, useState } from "react";
import {
  AgStudio,
  AgStudioProvider,
  createWidgets,
  type AgWidgetDefinition,
  type AgRegistry,
} from "ag-studio-react";
import {
  AgStudioAiModule,
  AgStudioLicenseManager,
  createAiHarness,
  studioTheme,
  type AgDefaultWidgetDefinition,
  type AgDefaultRegistry,
  type AgWidgetData,
  type AgWidgetDataFormat,
  type AgReportState,
  type AgWidgetsConfig,
} from "ag-studio";
import { ShieldCheck, Wallet } from "lucide-react";
import { formatMoney, type Snapshot } from "../shared/types";
import { studioAdapter } from "./studio-adapter";
if (import.meta.env.VITE_AG_STUDIO_LICENSE_KEY)
  AgStudioLicenseManager.setLicenseKey(
    import.meta.env.VITE_AG_STUDIO_LICENSE_KEY,
  );
interface CustomState extends AgWidgetData<
  Record<string, never>,
  AgWidgetDataFormat<unknown>
> {
  type: "approval-queue" | "reserve-ledger";
}
type CustomDef = AgWidgetDefinition<
  "approval-queue" | "reserve-ledger",
  CustomState
>;
interface Registry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | CustomDef)[];
  formats: AgDefaultRegistry["formats"];
  buckets: AgDefaultRegistry["buckets"];
}
const SnapshotContext = createContext<Snapshot | undefined>(undefined);
function ApprovalWidget() {
  const state = useContext(SnapshotContext)!;
  const pending = state.plans.filter((p) => p.status === "awaiting_approval");
  return (
    <div className="custom-widget">
      <h3>
        <ShieldCheck size={15} /> Approval queue
      </h3>
      {pending.length ? (
        pending.map((p) => (
          <div className="decision" key={p.id}>
            <div>
              <b>
                {
                  state.projects.find((project) => project.id === p.projectId)
                    ?.name
                }
              </b>
              <p>
                {p.risks.length
                  ? p.risks.join(" ")
                  : "Confirmed payment. Ready for your review."}
              </p>
              <small>
                {p.allocations.filter((a) => a.kind === "payout").length}{" "}
                payouts · Review in Payment plans
              </small>
            </div>
          </div>
        ))
      ) : (
        <p>
          No plans are waiting for approval. Every payout stays under your
          control.
        </p>
      )}
    </div>
  );
}
function ReserveWidget() {
  const state = useContext(SnapshotContext)!;
  const allocations = state.plans
    .filter((p) => ["submitted", "completed"].includes(p.status))
    .flatMap((p) => p.allocations)
    .filter((a) => a.kind === "reserve");
  return (
    <div className="custom-widget">
      <h3>
        <Wallet size={15} /> Reserve ledger
      </h3>
      <strong>
        {formatMoney(allocations.reduce((s, a) => s + a.amountCents, 0))}
      </strong>
      <p>
        Allocated to taxes and operating expenses. These amounts are retained
        funds, not separate PayPal transfers.
      </p>
      {allocations.map((a, i) => (
        <p key={i}>
          {a.label}: {formatMoney(a.amountCents)}
        </p>
      ))}
    </div>
  );
}
const defaultReport: AgReportState<Registry> = {
  selectedPageId: "operations",
  panels: {
    filters: { collapsed: true },
    data: { collapsed: true },
    edit: { collapsed: true },
    ai: { collapsed: true },
  },
  pages: [
    {
      id: "operations",
      layout: {
        columns: 24,
        rowHeight: 26,
        minWidth: 600,
        backgroundColor: "#f7f9f2",
        widgetBackgroundColor: "#fffefb",
        widgetBorderColor: "#dee7d5",
        widgetBorderRadius: 10,
      },
      widgets: {
        approval: { type: "approval-queue", dataMapping: {} },
        reserves: { type: "reserve-ledger", dataMapping: {} },
        projects: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "projects.project" },
              { id: "projects.client" },
              { id: "projects.amount" },
              { id: "projects.status" },
            ],
          },
          format: { title: { text: "Project payment sources", enabled: true } },
        },
      },
      widgetLayout: {
        approval: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 8 },
        reserves: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 8 },
        projects: { xTrack: 0, yTrack: 8, xSpan: 24, ySpan: 12 },
      },
    },
  ],
};
export default function Studio({ state }: { state: Snapshot }) {
  const ref = useRef<AgStudio<Registry>>(null);
  const [saved, setSaved] = useState("");
  const [initialState] = useState(() => {
    try {
      const saved = localStorage.getItem("contextmesh-studio-report");
      return saved
        ? (JSON.parse(saved) as AgReportState<Registry>)
        : defaultReport;
    } catch {
      return defaultReport;
    }
  });
  const data = useMemo(
    () => ({
      sources: [
        {
          id: "projects",
          data: state.projects.map((p) => ({
            project: p.name,
            client: p.client,
            amount: p.amountCents / 100,
            status: p.status,
            currency: p.currency,
          })),
        },
        {
          id: "allocations",
          data: state.plans.flatMap((p) =>
            p.allocations.map((a) => ({
              planId: p.id,
              project:
                state.projects.find((x) => x.id === p.projectId)?.name ||
                p.projectId,
              recipient: a.label,
              amount: a.amountCents / 100,
              percentage: a.basisPoints / 100,
              kind: a.kind,
              status: p.status,
            })),
          ),
        },
        {
          id: "events",
          data: state.events.map((e) => ({
            at: e.at,
            kind: e.kind,
            title: e.title,
            detail: e.detail,
          })),
        },
      ],
    }),
    [state],
  );
  const widgets = useMemo(
    () => (defaults: AgWidgetsConfig<AgDefaultRegistry>) =>
      createWidgets<Registry>({
        additionalTypes: [
          {
            id: "approval-queue",
            label: "ContextMesh approval queue",
            comp: ApprovalWidget,
            form: (p) => p.createDefaults({ dataMappingItems: [] }),
            formatShape: defaults.widgets.find((w) => w.id === "grid")
              ?.formatShape,
            defaultSize: { width: 400, height: 220 },
            minSize: { width: 220, height: 120 },
            ai: {
              description:
                "Displays live payment plans waiting for human approval, with risks and collaborator counts.",
              usage:
                "Use when users ask about pending approvals. This is a read-only view; approvals are performed in Payment plans.",
            },
          },
          {
            id: "reserve-ledger",
            label: "ContextMesh reserve ledger",
            comp: ReserveWidget,
            form: (p) => p.createDefaults({ dataMappingItems: [] }),
            formatShape: defaults.widgets.find((w) => w.id === "grid")
              ?.formatShape,
            defaultSize: { width: 400, height: 220 },
            minSize: { width: 220, height: 120 },
            ai: {
              description:
                "Displays retained tax and operating expense ledger allocations from submitted and completed plans.",
            },
          },
        ],
        menu: [
          {
            label: "ContextMesh",
            widgetIds: ["approval-queue", "reserve-ledger"],
          },
          ...defaults.menu,
        ],
      }),
    [],
  );
  const ai = useMemo(
    () =>
      ["Anthropic connected", "Gemini configured"].includes(
        state.integrations.ai,
      )
        ? ({
            api,
          }: Parameters<
            Exclude<
              import("ag-studio").AgAiHarnessSetup,
              import("ag-studio").AgAiHarness
            >
          >[0]) =>
            createAiHarness(api, {
              adapter: studioAdapter,
              promptStarters: [
                {
                  label: "Show payment risk",
                  prompt:
                    "Add an approval queue widget and explain which payment plans need attention.",
                },
                {
                  label: "Chart project revenue",
                  prompt:
                    "Create a bar chart showing amount by project from projects.",
                },
                {
                  label: "Where are my reserves?",
                  prompt:
                    "Add a reserve ledger widget and explain what retained funds mean.",
                },
              ],
            })
        : undefined,
    [state.integrations.ai],
  );
  const theme = useMemo(
    () =>
      studioTheme.withParams({
        accentColor: "#315d3b",
        backgroundColor: "#fffefb",
        foregroundColor: "#28472b",
        borderColor: "#dfe7d7",
        fontFamily: "DM Sans, sans-serif",
        fontSize: 12,
        borderRadius: 7,
      }),
    [],
  );
  return (
    <>
      <div className="studio-header">
        <div>
          <h2>Financial operations studio</h2>
          <p>
            Live project data, custom approval widgets, and editable analytics.
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => {
            const report = ref.current?.api.getState();
            if (report) {
              localStorage.setItem(
                "contextmesh-studio-report",
                JSON.stringify(report),
              );
              setSaved("Dashboard saved on this device.");
            }
          }}
        >
          Save dashboard
        </button>
      </div>
      <p className="studio-hint">
        {import.meta.env.VITE_AG_STUDIO_LICENSE_KEY
          ? "AG Studio license configured."
          : "AG Studio evaluation: add a valid trial license to remove its evaluation watermark."}{" "}
        {ai
          ? "Open the chat panel to build widgets using natural language."
          : "Connect GEMINI_API_KEY or ANTHROPIC_API_KEY to enable Studio’s AI agents. Manual dashboard editing is available now."}{" "}
        {saved}
      </p>
      <SnapshotContext.Provider value={state}>
        <AgStudioProvider modules={[AgStudioAiModule]}>
          <div className="studio-surface">
            <AgStudio<Registry>
              ref={ref}
              data={data}
              mode="edit"
              initialState={initialState}
              widgets={widgets}
              theme={theme}
              ai={ai}
            />
          </div>
        </AgStudioProvider>
      </SnapshotContext.Provider>
    </>
  );
}
