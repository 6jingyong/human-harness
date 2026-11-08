# Human Harness — Runtime-first reconstruction (v0.2)

**Status:** implemented local prototype, not production-grade project automation.

## Product decisions

**Keep:** Mastra, Next.js, SQLite, task DAGs, human reviews, trusted script registry.

**Do not build:** project template search, discovery, recommendations, marketplace or search-engine integration. A user **manually authors, edits, copies, imports and versions** project templates.

**Main loop:**
1. Pick a locally available template or manually author one.
2. Create a project, freezing the template and its bundled assets.
3. Show only tasks that are currently actionable to the human.
4. Allow Agent tasks to run when predecessor tasks complete; execution is manual in this prototype (one task per click).
5. Human approves/rejects Agent outputs, with feedback preserved.
6. Human records an explicit professional decision at a choice gate.
7. System deterministically activates the chosen branch and marks the other branch not applicable.
8. Materials become actionable only when their producer is expected to have created them.
9. Candidate deliverables pass structural checks before being submitted for human review.

## Domain model

- **ProjectTemplate** (v3): workflow stages, resources, materials, tasks/decision options, conditional branches, deliverable contracts.
- **Project**: immutable template snapshot, persisted task status, recorded decisions, received artifacts and append-only events.
- **Task**: human/agent owner, dependencies, review state, optional branch activation.
- **DecisionGate**: human task with inputKind=choice, explicit allowed choices, recorded in project_decisions.
- **MaterialRequirement**: a separate requirement definition associated with an input task; computed state is inactive/needed/received/not_applicable. Received does **not** imply professionally verified.
- **Artifact**: received text/file or Agent output, with immutable entries. Actual binary content is stored, but PDF/CAD is not parsed.
- **Executor**: existing Mastra agent, replaceable with another model executor; trusted scripts referenced by registry ID.

## Runtime activation semantics (v3)

A conditional task may declare:

    activateWhen: { gateTaskId: "stage1-decision", equals: "sampling" }

It **must** also declare the gate as an upstream dependency.

Before the gate: conditional task has status inactive, and dependent human tasks are blocked.

On the human decision:
- store the selected option as authoritative structured project data;
- activate the matching branch (pending);
- mark the nonselected branch not_applicable;
- propagate not_applicable through descendants with impossible required dependencies;
- append transition events for audit.

The same project cannot silently switch a completed decision: revisions require a future explicit change-management workflow. This avoids silently reusing stale evidence.

The current engine does **not** support arbitrary dynamic conditions, recursive template scripts, untrusted code execution or model-written decision values.

## Land contamination example

The built-in template **land-investigation-runtime** is a deliberately simplified executable demo of the first-stage decision and later external handoff.

User submits identity, boundary and intended land use → Mastra prepares an **evidence inventory draft** → professional human choice:

- **First-stage exit:** render an internal review draft. Sampling/QC branch becomes not applicable.
- **Sample:** Agent proposes a *non-georeferenced* candidate sampling approach → human approves/finalizes the real plan → human commissions an external institution → human confirms completion of relevant field/lab work → **only now** do submission tasks for sampling records, detection report and QC materials appear → Agent generates a limitations-aware review proposal → human approves → internal report draft.

QC measures begin when planning the sampling program. A final QC report is **not** expected to exist at initialization, and the system does not claim it can collect one.

### Current limitations of the demo

- No real GIS, historic imagery, enterprise searching, sampling execution, professional lab work, CAD/PDF analysis or definitive QC calculation.
- The result is an internal Markdown draft, **not** a formal DOCX land investigation report.
- Human confirmation of external work is a workflow event, not technical proof that field/lab work really occurred.
- Each MaterialRequirement is linked to one designated human task in v3; advanced evidence matching/verification will come later.
- Skipping optional material does not create a substitute for required evidence.
- No resumable background queue, no lease recovery, no authentication or production security.

## Manual template authoring

In the sidebar, use **新建模板** to open the manual editor. Fill in a name, ID, initial human inputs (prefix lines with 文件: to require a file), and the Agent task objective. Click **根据以上内容生成模板草稿**, review the JSON, and **校验并保存模板**.

For existing templates, **复制 / 编辑所选模板** produces a versioned editable manifest; built-in templates are copied to a new ID. Advanced JSON can define choice gates, resources, later materials and output rules.

The example is available as `examples/template.land-investigation-runtime.json`; it is also built into the selectable templates.

## Validation tests

- Choice gate rejects unknown choices.
- First-stage exit hides and marks sampling/QC documents as not applicable.
- Sampling path requires plan review and commissioning, then institution completion before QC requirements become needed.
- Materials are marked received, **not verified**, after upload.
- Conditional dependencies and resource IDs are validated at template import.
- The manual authoring form generates an importable schema v3 project package.
- Existing v1/v2 template and output tests remain intact.

Tests and build run via GitHub Actions on PR updates.

## Remaining architectural priorities

1. **Material evidence acceptance**: separate submitted/reviewed/accepted, named evidence-to-sample/point mappings, provenance checks.
2. **Material version & invalidation**: boundary or sampling-point changes must invalidate dependent decisions and reports, with human control and audit.
3. **Durable Agent worker**: automatic scheduling, backpressure, idempotency, resume and crash recovery.
4. **Additional dynamic task rules**: approved Agent proposals, external milestones, conditional branch revisions.
5. **Registered external skills**: GIS, historical enterprise, SamplingPlan and deterministic DOCX report generator with explicit capability readiness.
6. **Production security**: authentication, permissions, upload parsing sandbox, access audit.

Do not add template search or a marketplace without a new product requirement.
