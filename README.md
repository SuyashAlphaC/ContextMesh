# ContextMesh

**Turn a client's payment into a context-aware, explainable, human-approved payout plan.**

Example: “When GreenCart pays, give Maya 60%, Arjun 25%, reserve 10% for taxes and 5% for expenses.” ContextMesh connects the project, confirmed payment, collaborators, account versions, allocations and approval in a financial graph. It validates the plan, waits for payment, asks for approval, and only then submits collaborator payouts.

This repository contains a complete runnable hackathon application, not a production financial service. It never calls PayPal production endpoints. Tax and expense reserves are ledger allocations, **not bank transfers, escrow or tax advice**.

## Run locally

Requirements: Node.js 24+, npm, and optionally Docker Compose for real HydraDB.

```bash
npm ci
cp .env.example .env
docker compose up -d
```

For the supplied local HydraDB container, put these values in `.env`:

```dotenv
HYDRADB_URL=http://127.0.0.1:8443
HYDRADB_TOKEN=contextmesh-local-development-token-32-bytes
HYDRADB_NAMESPACE=default
HYDRADB_GRAPH=default
HYDRADB_CELL=cell-0
```

```bash
npm run check:integrations
npm run dev
```

Open http://localhost:5173. The backend listens on port 4310; Vite proxies `/api`. On this device, `.env` is already prepared with these local graph settings. Do not overwrite it after adding your credentials. Leaving HydraDB settings empty enables a SQLite-backed local graph instead. A configured but unavailable HydraDB fails plan creation closed; it does not silently pretend the remote graph worked.

`docker compose down` stops the graph without deleting its volume. The public development token is suitable **only for this localhost-bound development container**. For deployment, provision a private HTTPS HydraDB instance and rotate its token. The pinned HydraDB image uses an initialization service to set permissions on its own data volume.

## What is implemented

| Component          | Meaningful role                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| PayPal Sandbox     | Client checkout through Orders v2, capture verification, collaborator batch payouts, signed webhook verification, payout reconciliation |
| HydraDB            | Real open-source graph persistence and context retrieval for projects, incoming invoices, workspace collaborators and payout plans      |
| AG Studio 3        | Interactive analytics workspace with project data, live custom approval queue and reserve ledger, saved dashboard state and AI adapter  |
| Render Workflows   | Registered validation → payout execution → graph synchronization tasks, retries, authenticated callbacks and remote task dispatch       |
| Gemini / Anthropic | Optional natural-language interpretation and AG Studio dashboard agent through server-side credentials                                  |
| SQLite             | Durable authoritative payment state, approvals, recipient versions, audit trail and graph synchronization checkpoints                   |

The graph provides context; it does not replace the authoritative payment ledger. The model proposes allocations; it never approves or directly pays anyone. The analytics agent can query data and modify dashboard widgets, not execute payments.

## Payment journey

```text
Instruction → validated allocations → await verified payment
            → explicit human approval → revalidate accounts/funds
            → idempotent payout submission → reconcile every payout item
            → graph synchronization + audit trail
```

Allocations are integer cents and basis points. The server requires exactly 100%, disallows duplicate targets, and uses largest-remainder rounding so no cents disappear. A $2,000 GreenCart payment produces $1,200 to Maya, $500 to Arjun, $200 tax reserve and $100 expenses reserve.

Plans cannot execute before confirmed funding and approval. Approval is bound to the recipient account versions and exact amounts. Updating a collaborator email invalidates the old plan's account assumptions; update the account before creating a new plan. Account changes are blocked while payouts are executing or submitted. Additional active plans and payout batches for the same project are blocked.

Execution state is persisted before submitting the external request. Stable PayPal request IDs and sender batch IDs support retries after uncertain network outcomes. A submitted batch is not called completed until all returned payout items succeed. Refund/reversal webhooks block pending execution, but do not promise automatic recovery of payouts already submitted.

## Simulation versus connected services

The default `CONTEXTMESH_MODE=demo` moves **no money**. Its percentage parser is deterministic and explicitly labeled, not advertised as live AI. Supported local instructions name Maya, Arjun, taxes and expenses with percentages. A real Anthropic key enables broader phrasing while retaining the same validation rules.

Local verification covers the browser, backend, PayPal protocol mocks and real HydraDB. Without your credentials, live PayPal Sandbox capture/payout/webhook delivery, paid AI calls and cloud Render workflow runs are **not verified**. AG Studio runs with evaluation notices unless you supply an appropriate trial/license. A configured key does not by itself prove a service is healthy.

## Enable PayPal Sandbox

1. Create a Sandbox REST application in the PayPal Developer dashboard. Supply `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env` and set `CONTEXTMESH_MODE=sandbox`. Use `DATA_DIR=./data-sandbox` for a fresh Sandbox ledger instead of mixing persisted simulated payments with Sandbox projects.
2. Configure actual Sandbox recipient emails using `PAYPAL_MAYA_EMAIL` and `PAYPAL_ARJUN_EMAIL` **before the first database initialization**, or edit collaborator accounts through the UI before creating plans. Seed values do not overwrite existing persisted accounts. Placeholder `example.com` accounts are rejected by the payout integration.
3. Ensure the Sandbox business account has the appropriate Payouts access and test balance. Orders access alone does not prove Payouts access.
4. Register an HTTPS webhook URL ending in `/api/webhooks/paypal`, subscribe to capture completion/refund/reversal events, and set `PAYPAL_WEBHOOK_ID`. Local webhook delivery needs a separately configured HTTPS tunnel; this repository does not publish one automatically.
5. Set `PUBLIC_URL` to the actual browser origin, restart, create a plan, open PayPal checkout, approve with a Sandbox buyer, and confirm payment after returning. Approve the plan, submit the payouts, and reconcile their status.

PayPal's verification API authenticates webhook signatures. The application additionally checks the order, project identity, completed capture, currency and full expected amount before recording payment. A missing webhook ID causes webhook verification to reject the event; it does not disable signature checks. Do not use real customer credentials or production accounts.

## Enable real AI and AG Studio

For Gemini, create a key in [Google AI Studio](https://aistudio.google.com/) and add these settings to your existing `.env` without replacing your PayPal or HydraDB values:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your_private_key
GEMINI_MODEL=gemini-3.8-flash
```

Restart `npm run dev` after editing `.env`. The default model follows Google's current model documentation; use an available model ID from your account if its access or free-tier quota differs. `npm run check:integrations` checks authenticated model metadata without consuming generation tokens. It does not prove generation quota or successful tool calls.

For an explicit live test, run `npm run check:ai`. This makes up to three generation requests using fictional fixture data: validated plan output, a dashboard tool call, and its continuation. It consumes API quota (and may incur charges on paid accounts), but creates no orders, captures, payouts or ledger entries. HTTP 503 means provider unavailability; 429 means rate/quota limits. Retry manually after waiting rather than bypassing validation or silently switching models.

`AI_PROVIDER=auto` (the default) selects Gemini when its key exists, otherwise Anthropic, otherwise the explicitly labeled deterministic parser. To retain Claude, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`; `ANTHROPIC_MODEL` remains configurable. An explicitly selected provider requires its key. Provider errors never silently fall back to simulated AI.

Gemini uses the native `generateContent` API with server-side authentication, JSON-schema output for payment intent, and function declarations/results for Studio. Exact native model turns and thought signatures are preserved in opaque tool-call IDs for multi-turn continuation; start a new Studio chat after changing providers. No additional SDK dependency is required. Both providers use the same server validation, money math, verified funding and human approval gates. The AI cannot directly approve or execute a payout.

Use only fictional/Sandbox data with free-tier AI. Google's free-tier terms may permit content to be used for product improvement; review [pricing and data-use terms](https://ai.google.dev/gemini-api/docs/pricing). A free tier is not a guarantee of model access or quota.

Obtain an AG Studio trial/license covering the features you use and set `VITE_AG_STUDIO_LICENSE_KEY`. Rebuild/restart Vite after changing it. This is a public client license value; provider API keys must **never** be `VITE_` variables. Dashboard AI uses AG Studio's agent framework and the existing application adapter, now supporting both providers through the authenticated backend. Gemini API access does not grant an AG Studio AI license.

## Deploy on Render

`render.yaml` defines a Node web service with a persistent SQLite disk and a workflow service. Creating these resources may incur charges; nothing is automatically deployed by local startup.

1. Push this repository to a repository you control, then create a Render Blueprint from it.
2. Set the web service's `PUBLIC_URL` to its HTTPS URL. Keep the generated `APP_ACCESS_TOKEN` private; use it to sign in to this single-workspace application.
3. Configure an externally reachable private HydraDB HTTPS endpoint/token. A hosted Render service cannot use your laptop's `127.0.0.1:8443`.
4. Set `WORKFLOW_CALLBACK_URL` on both services to the web service's HTTPS URL. The workflow service inherits the web service's `WORKFLOW_CALLBACK_TOKEN` through the Blueprint.
5. Deploy the workflow service; locate the registered **settleProject** task slug. Set that slug and `RENDER_API_KEY` together on the web service. Keep them unset until the callback configuration and workflow registration are complete.
6. Supply the desired Sandbox/AI/license settings. Switch to Sandbox mode only when its required credentials are configured.
7. Run an actual approved Sandbox plan and inspect the Render task run and PayPal batch results before claiming the cloud integration works.

The workflow service does not maintain another SQLite copy. Its authenticated callbacks operate on the web service's authoritative ledger. Every execution callback rechecks approvals and funding. Without Render configuration, the same application service executes locally. Do not horizontally scale this SQLite deployment: it is a single-instance, single-workspace prototype.

## Verification

See [the local verification record](docs/VERIFICATION.md) for results and unverified provider paths.

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm audit
npm run check:integrations
```

Browser tests run against a fresh isolated database with connected services disabled. They cover the complete simulated payment/approval/execution flow, graph inspection, audit events, custom AG Studio widgets, dashboard save, mobile layout and invalid instructions. Playwright uses `/usr/bin/google-chrome` when present, or its downloaded Chromium; `CHROME_PATH` can override this.

Backend tests cover exact allocations, invalid totals, funding/approval gates, concurrent execution, duplicate prevention, account changes, persistence, refund blocks, signed-webhook handling, capture checks, payout reconciliation, API authentication and HydraDB protocol behavior. CI builds and runs both suites without credentials.

`npm run check:integrations` is a read-only connectivity check. It checks supplied PayPal OAuth credentials, retrieves the configured webhook to validate its HTTPS endpoint and capture subscriptions, and runs a HydraDB query without creating orders or payouts. Missing AI/Render keys are reported, not fabricated. Browser tests use isolated ports 5273/4410; set `E2E_WEB_PORT` and `E2E_API_PORT` if those ports are occupied.

## Repository map

```text
src/                  React app, visual design, AG Studio, model adapter
shared/types.ts       Payment/graph contracts
server/policy.ts      Money math and safety validation
server/service.ts     Authoritative financial state machine
server/paypal.ts      Sandbox API client and capture verification
server/graph.ts       Graph projection and HydraDB adapter
server/agent.ts       Deterministic parser and optional model calls
server/app.ts         HTTP API, authentication, webhook and callback routes
server/workflows.ts   Render SDK task definitions
tests/                Backend and browser regression tests
compose.yaml          Local pinned HydraDB + persistent volume
render.yaml           Explicit cloud deployment Blueprint
docs/DEMO.md          Short demo narrative
```

The local ledger is `data/contextmesh.sqlite`. `.env`, database files, test outputs and build artifacts are ignored by Git. Back up the database before changing seed/configuration; there is deliberately no unauthenticated reset endpoint.

## Scope and limitations

This MVP supports one workspace, three seeded USD projects and two collaborators. It does not implement arbitrary invoice ingestion, multi-tenant authorization, banking, escrow, KYC, tax calculation, disputes, payroll or production PayPal payments. Dashboard layouts are saved on the current browser/device, not shared across users. The audit trail is application history, not a cryptographically immutable compliance ledger.

Production use requires security/compliance review, identity and permission design, database migrations/backups, operational monitoring, rate/cost controls, payment lifecycle reconciliation, and verified provider access. The included shared access token is a demo deployment gate, not enterprise authentication. Keep the unauthenticated development server bound to localhost.

HydraDB v0.1.1 supports a limited Cypher subset. This adapter uses its verified `UNWIND` numeric-ID node upsert and relationship `MERGE` forms. It stores graph-safe, stable hashed IDs with collision checks and checkpoints per endpoint/graph scope. If you replace a remote graph while retaining the local ledger, its checkpoint must be invalidated before resynchronization. No graph deletion/pruning workflow is implemented.

## Official references

- [PayPal Orders v2](https://developer.paypal.com/docs/api/orders/v2/)
- [PayPal Payouts API](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/)
- [PayPal webhook signature verification](https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post)
- [HydraDB pinned source](https://github.com/hydra-db/hydradb/tree/v0.1.1)
- [AG Studio React quick start](https://www.ag-grid.com/studio/react/quick-start/)
- [AG Studio AI integration](https://www.ag-grid.com/studio/react/ai-quickstart/)
- [AG Studio custom widgets](https://www.ag-grid.com/studio/react/custom-widgets/)
- [Render Workflows](https://render.com/docs/workflows)
- [Render TypeScript workflow SDK](https://render.com/docs/workflows-sdk-typescript)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages)
- [Gemini generateContent API](https://ai.google.dev/api/generate-content)
- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Gemini models and availability](https://ai.google.dev/gemini-api/docs/models)

Application source is MIT licensed. Third-party packages retain their own licenses; an application license does not grant an AG Studio commercial license.
