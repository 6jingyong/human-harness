# Human Harness

**Project-first human–AI collaboration, driven by real task state instead of conversation history.**

Human Harness uses **manually authored project templates** to coordinate work between people, an AI worker, registered scripts and external organizations. There is no template search, marketplace or recommendation system.

The canonical format is **Human Harness Protocol 1.0**: `hh.package/1`, `hh.task/1`, `hh.result/1`. Earlier trial `schemaVersion 2/3` formats are deliberately **not accepted**. Mastra remains a replaceable model/Agent executor; Human Harness owns the authoritative project state.

## What works now

- A local form for hand-authoring a basic package, plus import/edit of strict Protocol 1.0 JSON.
- Persistent project instances with a frozen package version/digest, typed events and task lifecycle.
- One shared task graph projected into **Human TodoList** and **Agent work queue**.
- Human decisions and external milestone confirmations as explicit steps.
- Material requirements with separate dormant, expected, requested, received, accepted, rejected and not-applicable states.
- Real Mastra single-task execution adapter (or clearly labeled no-key demo mode).
- Agent outputs require human approval before dependent tasks run.
- Approved Markdown/JSON output contracts can be downloaded; no fake DOCX/PDF export.
- Built-in **土地污染调查** branch example with no premature QC upload request.
- Schema and state-machine automated tests and GitHub Actions CI.

## Local setup

Requires **Node.js 22.19+** and npm, on a computer with persistent local storage.

```bash
git clone https://github.com/6jingyong/human-harness.git
cd human-harness
npm install
cp .env.example .env.local
npm run dev
```

On Windows, copy `.env.example` to `.env.local` manually if `cp` is unavailable. Open http://localhost:3000.

The default `HH_EXECUTOR=demo` does not call any model and every demo result is labeled as simulated.

To use a real model, edit `.env.local`:

```dotenv
HH_EXECUTOR=mastra
HH_MODEL=openai/gpt-6.1-sol
OPENAI_API_KEY=your-key
```

Restart the app. Model access, quota and provider availability are subject to the selected API provider. The app has no browsing/GIS or arbitrary filesystem tools installed on its Mastra agent.

## Test the project flow

Choose **土地污染调查 · 项目运行示例** and create a project.

1. Supply the project identity, a **boundary file** and land-use explanation.
2. Explicitly accept each material. Received data is **not automatically verified**.
3. Run the evidence-inventory Agent task; approve or reject its candidate output.
4. Select the professional **stage-one exit** or **sampling** decision.
5. In the sampling branch, review the candidate plan, record professional approval and commissioning.
6. Confirm actual institution completion **only after the institution has done the work**. Field logs, test results and QC materials become actionable then, never at project creation.
7. Upload/approve those materials and run the internal review drafts.

This is a **software acceptance demo**. It does not perform real GIS, sampling, quality assurance calculations or regulatory report signing. Do not treat demo labels or accepted uploads as professional evidence validation.

## Architecture

- `src/protocol/v1.ts` — strict canonical JSON schema for project packages and Agent packets/results.
- `src/protocol/manual.ts` — generate a canonical template from manual input fields.
- `src/core/runtime.ts` — deterministic activation, branch decisions, evidence receipt and review.
- `src/core/store.ts` — SQLite package registry and project state/event transaction layer.
- `src/executors/mastra.ts` — replaceable Mastra structured-output worker.
- `src/app/runtime-workspace.tsx` — Human/Agent workboards and template authoring UI.
- `src/app/api/v1` — Protocol 1.0 runtime API.
- `examples/land-investigation.hh.json` — built-in canonical scenario template.
- `docs/protocol/human-harness-1.0.md` — protocol architecture and design boundaries.
- `tests/runtime-v1.test.ts` / `tests/protocol-v1.test.ts` — runtime and schema tests.

Run `npm run typecheck`, `npm test` and `npm run build`.

## Data compatibility

Protocol 1.0 stores local runtime state under `.human-harness/protocol-v1.sqlite` and file uploads under `.human-harness/uploads/`. Earlier prototypes used `projects.sqlite`; it is **not migrated** and is not read by this runtime. Back up the complete directory before deleting any old prototype data. Existing v0.x format templates must be rewritten as `hh.package/1`; no compatibility shim is provided.

## Security and current limitations

**For local development only.** There is no authentication, workspace/tenant isolation, robust file parsing sandbox, persistent job queue, worker lease recovery or public-server security hardening. Do not expose this app on the public Internet or upload materials you cannot safely store locally.

Binary CAD/PDF/images are stored but their contents are **not parsed**. A person can mark an uploaded artifact accepted; this is a human workflow receipt, **not** proof that its contents have undergone technical verification. Existing sampling/GIS and DOCX-report skills have not yet been migrated. Registered scripts and binary bundled assets are described by Protocol 1.0 but are not installed by this runtime.

## Guiding principle

**A template defines the plan; the project state records reality; people provide and approve evidence; mature Agent frameworks execute only scoped, replaceable work units.**
