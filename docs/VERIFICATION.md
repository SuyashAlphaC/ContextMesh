# Local verification record

## Gemini integration — 2026-10-13

- Added native Gemini generateContent support for structured payment-plan intent and the existing authenticated AG Studio model route. Claude remains selectable; auto mode prefers a configured Gemini key. No new SDK dependency or provider credential was added to browser code.
- Gemini native model turns, parallel calls, function responses and thought signatures survive Studio's conversation round-trip through opaque call IDs. Unknown tools, corrupted state, invalid allocations, incomplete/blocked responses and provider/network failures fail closed. Funding and explicit approval checks are unchanged.
- 56 backend/integration tests across 7 files and 4 browser tests passed. TypeScript, the production build, formatting and npm audit passed (0 known vulnerabilities). The new browser test activates the Gemini Studio harness using mocked integration status, not live AI generation.
- After the user added a Gemini key locally, an authenticated lookup of the configured model succeeded. The first synthetic generation attempt returned HTTP 503; the second synthetic smoke check also failed. Live generation and tool continuation are therefore **not yet verified**, despite the passing protocol tests and valid model lookup.
- `npm run check:ai` is an explicit opt-in synthetic plan/tool/continuation probe with up to three generation requests. It may consume quota/paid usage, but never creates orders, captures, payouts or ledger entries. No secrets are printed and `.env` content was preserved.

## Follow-up verification — 2026-10-12

- Fixed signed webhook verification to preserve the exact original JSON, including unknown fields, whitespace and numeric formatting. Missing signature headers now reject before a provider call. Verification is never bypassed.
- 42 backend/integration tests across 6 files passed, including HTTP payload-preservation, invalid-signature, unsigned-request and duplicate-delivery regressions. The production build and 3 browser tests passed; npm audit reported 0 known vulnerabilities.
- Credentialed read-only checks passed: PayPal Sandbox OAuth; retrieval of the registered webhook using the configured app; HTTPS/path and capture-event subscription checks; authenticated HydraDB query; registered tunnel health (HTTP 200); authenticated running workspace (Sandbox mode); persisted recipient emails matching environment configuration.
- `.env` content was preserved and its permissions restricted to owner read/write (600). No secret values were logged. AI, AG Studio license and Render credentials remain absent.
- No orders, captures, payouts or cloud deployments were initiated by these checks. A real signed Sandbox delivery still needs a user-completed checkout to establish end-to-end webhook verification.
- Browser regressions use isolated ports 5273/4410 and a temporary demo database, leaving the active Sandbox app and tunnel alone.

## Initial verification — 2026-10-09

Verified on 2026-10-09 using Node.js 24.5.0 and installed Google Chrome.

An additional production-mode browser smoke test passed login and analytics rendering with no unexpected browser errors. The expected AG Studio evaluation license banner remains until a valid trial/license is supplied.

| Check                                    | Result                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TypeScript and production frontend build | Passed                                                                                                            |
| Backend/integration unit tests           | 36 passed across 5 files                                                                                          |
| Desktop/mobile/keyboard browser tests    | 3 passed                                                                                                          |
| npm dependency audit                     | 0 known vulnerabilities at verification time                                                                      |
| Real local HydraDB v0.1.1                | Authenticated node/relationship writes and project/funding/collaborator context queries passed                    |
| Render task chain                        | Registered task bodies passed against real local authenticated HTTP callbacks; no cloud execution claimed         |
| AG Studio                                | Custom widgets render in browser; dashboard save and model-adapter protocol tests passed                          |
| PayPal                                   | API payload, capture, signature, duplicate and reconciliation behavior tested with mocks; live Sandbox unverified |
| Anthropic                                | Adapter/structured-validation paths implemented; live model calls unverified                                      |

No provider credentials were supplied and no payments or external cloud deployments were performed. The local HydraDB container uses a persistent Docker volume; the app uses a separate SQLite ledger. Browser tests use isolated temporary ledgers.

Non-failing warnings remain: Node 24 labels `node:sqlite` experimental, and the lazy-loaded AG Studio vendor bundle exceeds Vite's size warning threshold. These are not test failures, but are relevant before a production release. The large Studio bundle is loaded only when opening Analytics studio.

This is evidence for the tested local MVP, not a guarantee that software has no defects. Follow README setup and perform credentialed Sandbox/cloud acceptance testing before submission.
