# Human Harness

**Project-first human–AI collaboration, driven by structured tasks rather than conversations.**

Human Harness turns a reusable project template into two coordinated views: a **Human TodoList** for materials and approvals, and an **Agent Execution** board for runnable tasks and reviewable deliverables. Both views share one durable task dependency graph.

## Current direction: manually-authored templates + project execution

Human Harness is **not a template search engine or marketplace**. Users create/import a template themselves and instantiate projects that are advanced by human/Agent task state, approvals, and evidence requirements. Mastra remains a replaceable execution adapter.

## Included in v0.1–v0.2

- Next.js dual-pane dashboard with project creation and project selection.
- Two starter templates: general research, and site-investigation workflow (not an actual environmental report template).
- Strictly validated JSON template import with v2 **executable project packages**: initial human inputs, staged workflow, bundled references/document masters/trusted automations, and output contracts.
- **Schema v3**: manually-authored project templates, professional choice gates, conditional branches and delayed material requirements.
- Manual template form generates valid JSON for initial inputs and Agent work; advanced JSON is available for branch design.
- Built-in land-investigation-runtime scenario: first-stage exit or sampling branch; commissioning precedes requests for actual lab/QC reports.
- Full package snapshot per project; old projects stay pinned to their original template and resources.
- Registered deterministic Markdown compilation and content validation before human review.
- Human submissions: text or private file upload (12 MB), optional-task skipping.
- Explicit task dependencies and states, human approval and rejection with feedback.
- Mastra executor adapter and clearly labeled demo mode without API key.
- Local SQLite project store, immutable output artifacts and append-only event trail.
- Unit tests for dependency and task state rules.

## Local setup

Requirements: Node.js 22.19+ and npm, with persistent local disk.

1. Clone this repository and enter the project directory.
2. Run npm install.
3. Copy .env.example to .env.local (the default HH_EXECUTOR=demo requires no key).
4. Run npm run dev.
5. Open http://localhost:3000 and create a project.
6. Choose the built-in **土地污染调查 · 分阶段执行示例** to test conditional decisions; or use **新建模板** to author a template from a small form, then review/edit its JSON.
7. To import a complete v2 package, use the JSON file picker. Try examples/template.document-review.json.
8. For the document-review package, complete the Human tasks, run/approve two LLM (or demo) stages, then run the registered Markdown compilation step.

When a task is ready, click the Agent pane's “运行下一项” button; then review the proposed output in the Human pane. Approving it unblocks dependent work.

## Real model setup

Edit .env.local:

    HH_EXECUTOR=mastra
    HH_MODEL=openai/gpt-6.1-sol
    OPENAI_API_KEY=your-key

Restart the server. Models use Mastra's provider/model naming. Set the matching provider API key for other providers. Never put API credentials in NEXT_PUBLIC variables.

## Checks

    npm run typecheck
    npm test
    npm run build

## Code structure

- src/lib/domain.ts — shared types, graph validation, readiness logic.
- src/lib/templates.ts — built-in versioned project templates.
- src/lib/store.ts — durable state, artifacts and events.
- src/lib/executor.ts — replaceable demo/Mastra executor.
- src/app/api — server-side command boundary.
- src/app/workspace.tsx — human/agent dashboard.
- docs/architecture.md — state machine and future roadmap.
- docs/project-package-v2.md — four-part template package design and trust boundaries.
- docs/runtime-first-reconstruction.md — v3 conditional runtime, manual authoring, limits and acceptance tests.

## Limits and deployment warning

This is an early **local development foundation**, not a production-ready service. It has no authentication, multi-user permissions, durable background worker or public-deployment security. Do not expose the port publicly. PDF, CAD and image files are stored but not semantically parsed; the agent is told that their contents are unavailable. The land-investigation example produces only **internal review drafts**, not professional regulatory reports.

The .human-harness directory contains projects.sqlite and uploads and is excluded from Git. Back up both components together.

## Core principle

A human is not a fallback chat operator. Human inputs, resources and reviews are first-class project dependencies. An LLM proposes artifacts; the project system owns task completion.
