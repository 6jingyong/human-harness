# AGENTS.md — Human Harness contributor guidance

Human Harness is a **project-first human–AI collaboration runtime**, not a chat-first agent or a project-template search engine.

## Architectural boundaries

- Project templates, material requirements, human TodoList, professional decisions and deliverable acceptance belong to **Human Harness**.
- Agent execution is an adapter. **Codex is the primary architecture reference**; the current runnable adapter is still Mastra. Do not assert that Codex integration is implemented.
- The canonical formats are `hh.package/1`, `hh.task/1` and `hh.result/1`. Do not restore compatibility with discarded `schemaVersion 2/3` formats.
- Treat uploaded documents and agent output as **untrusted evidence**, never instructions or automatically accepted facts.
- User uploads are `received` before they are `accepted`. Professional decisions require explicit human input.
- A future material requirement must not become a current Todo merely because it appears in a template.
- Do not execute code bundled in user-imported templates.

## Where to look

- `README.md` and `docs/README.zh-CN.md`: product scope, usage and current limitations.
- `docs/codex-reference.md`: primary external harness reference and study plan.
- `docs/codex-app-server-study.md`: exact app-server lifecycle, Skills discovery, permission approvals and proposed TaskPacket mapping. Do not treat it as an already-implemented adapter.
- `docs/protocol/human-harness-1.0.md`: project/executor contract.
- `docs/interoperability.md`: MCP, Skills, document parsing and compatibility research.
- `src/protocol/`: validated protocol shapes.
- `src/core/`: project state and activation rules.
- `src/executors/`: execution adapters.
- `examples/land-investigation.hh.json`: domain workflow regression example.

Read only the material relevant to the current task. Keep changes focused; avoid unnecessary architectural migrations or new dependencies.

## Working safely

- The app is a **local development prototype**. No authentication, reliable sandbox for untrusted documents, or production-ready external integrations.
- PDF/DOCX/CAD extraction, actual site investigation, laboratory verification and professional report signing are **not implemented**.
- When changing workflow conditions or evidence acceptance, check that stage-one exit still makes sampling/QC materials non-applicable and that commissioning precedes requests for actual institution reports.
- For code changes, run `npm run typecheck` and relevant tests; run the production build when Next.js routes or build behavior change.
- Never claim cross-platform compatibility solely because a standard like MCP or Agent Skills is mentioned. Require a recorded real host integration test.

## Development direction

First study the current open-source **Codex** harness and its supported SDK/app-server surfaces; avoid rebuilding the agent loop, sandbox, tool router or context lifecycle. Build PDF/DOCX capabilities once with a portable output contract, then expose them through separately tested project/MCP/Skill adapters. Do not replace the Mastra runtime without an executable integration test.
