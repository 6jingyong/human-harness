# Human Harness Protocol 1.0 — Canonical Architecture Decision

Status: **Protocol 1.0 runtime implemented as a local development foundation.** The TypeScript validators, SQLite project state, event-driven task/material activation, human decisions, Mastra TaskPacket adapter, typed TaskResult, basic manual package creation, review UI and Markdown/JSON export are integrated and tested.
Decision: **no backward compatibility with experimental v0.x schemaVersion 2 or 3**. Their source routes and schema validators have been removed; the old `projects.sqlite` database is not migrated.
**Not yet implemented:** package ZIP import or bundled assets, executable script/skill installation under the new protocol, reliable automatic workers, full material provenance/content verification, dependency invalidation after revisions, GIS/CAD/PDF reading, professional quality control and real DOCX/PDF reports. These sections remain design targets, not claims about the current application.

## 0. Scope and principles

Human Harness is an **operator for real-world projects**, not a chat service and not a template search platform.

1. People manually create/import project packages and select a local package to create a project.
2. The template describes how work should proceed. An actual project records what has happened.
3. Requirements, actions and evidence are separate concepts.
4. The orchestrator—not the LLM—decides whether a task is activated, completed, invalidated or blocked.
5. LLMs produce typed proposed changes and artifacts. They do not have direct write access to authoritative project state.
6. Tool execution is a capability controlled by the runtime; a package can **reference** installed tools, not inject executable code.
7. One project can have external institutional milestones and parallel human/AI tasks. Timing is event-driven, not a giant initial checklist.
8. Everything relevant to a professional deliverable is versioned and traceable.
9. Human and Agent TodoLists are **projections of one WorkItem ledger**, not independently maintained state.

## 1. Two planes: definition and execution

### A. ProjectPackage (definition plane, immutable by version)

In the current runtime, a package is **one canonical JSON manifest**. The following directory/archive structure is a future package authoring target and **is not importable yet**. Authoring does NOT require search.

    land-pollution/
      manifest.json        # ID, semver, title, scope, declared required capabilities
      workflow.json        # stages, nodes, edges, decisions, activation conditions
      materials.json       # material types, producers, acceptance, stage timing
      outputs.json         # exact deliverable contracts and validators
      assets/              # fixed references, report masters and form templates
      skills.json          # installed capability IDs required by nodes
      scenarios/           # executable acceptance scenarios and fixtures

The runtime compiles the package into an internal validated template object. File separation is an **authoring format**, not different competing schema dialects.

Every package declares:
- Initial *actionable* human input tasks.
- Entire intended workflow, including decision gates and possible future requirements.
- Reference assets, master documents, registered skills and scripts.
- Final internal/external outputs, producer capabilities and acceptance checks.

A package may be incomplete or have unavailable capabilities. It can be saved as a **draft**, but must pass validation before being marked **runnable**. Never imply that merely declaring DOCX/GIS capabilities installs them.

### B. ProjectInstance (runtime plane, mutable only through commands/events)

    projectId, templateId, packageDigest, createdAt,
    ledger: WorkItem[], requirements: RequirementInstance[],
    materials: MaterialArtifact[], decisions: DecisionRecord[],
    outputs: ProducedArtifact[], events: ProjectEvent[]

The template version and checksum are pinned at creation. The event ledger is append-only; current state is a deterministic projection. Updates to template packages do not silently rewrite running projects.

## 2. Seven primary domain types

### 2.1 MaterialRequirement: *what must eventually exist*

Define:
- id and semantic kind (e.g. \`site_boundary\`, \`lab_detection_report\`, \`quality_control_evidence\`);
- source/producer policy (\`human\` / \`agent\` / \`external_institution\`);
- \`requiredWhen\` (under which approved branch/goal this evidence is mandatory);
- \`requestWhen\` (when requesting it becomes actionable);
- \`acceptance\` (file type, provenance, sample/location associations, original report details, professional checks);
- \`canSatisfyWith\` policy (one or multiple material versions, not necessarily one file);
- optional \`invalidates\` edges.

**A requirement is not an upload form, not a task, and not proof the evidence already exists.**

Lifecycle: \`dormant -> expected -> requested -> received -> under_review -> accepted\` or \`rejected\`. Branch cancellation yields \`not_applicable\`. A changed upstream artifact yields \`stale\`.

\`received\` is expressly weaker than \`accepted\`.

### 2.2 WorkItem: *who should do what now*

- \`id\`, \`kind\` (\`provide_material\` / \`agent_task\` / \`script_task\` / \`human_review\` / \`human_decision\` / \`external_milestone\`);
- \`assigneeRole\`, \`dependencyRefs\`, \`activationPolicy\`, \`acceptanceContract\`;
- \`state\` (\`dormant\`, \`ready\`, \`running\`, \`waiting\`, \`review\`, \`done\`, \`blocked\`, \`not_applicable\`, \`stale\`);
- \`source\`: template node or approved derived task proposal.

Human/Agent TodoLists display WorkItems filtered by role and current actionability. A future WorkItem can exist dormant without annoying the user.

### 2.3 MaterialArtifact: *what was actually obtained*

- immutable artifact ID and content digest, project ID, source and creator;
- MIME/formats, bytes, capture or issuance date, recorded receipt date;
- semantic material kind, original/raw versus extracted/derived;
- attachments and relationships to locations, samples, candidate enterprises;
- extraction quality and source pointers, e.g. page/cell/coordinate;
- professional acceptance state separate from parsing success.

**Bundled references and user/project evidence must not share the same role in claims.**

### 2.4 DecisionRecord: *why a workflow branch was chosen*

- the decision gate ID and exact option ID;
- approved actor, timestamp, input evidence references and reason;
- branch result, subsequent revision/invalidation chain.

Model recommendations are not decisions. First-stage exit vs sampling requires explicit professional human input.

### 2.5 RunRecord: *what the Agent or script executed*

- task ID, executor ID/version, model, tools allowed, input artifact revisions;
- outputs, tool calls, start/end/error, retry counters and trace IDs;
- task completion must be validated by the application, never set by free-form text.

### 2.6 DeliverableContract: *what is acceptable to ship*

- deliverable ID and intended audience (external or internal);
- production route (registered script/renderer) and expected format(s);
- required sections, evidence coverage, acceptance validators, human signoff;
- explicit exclusion policies for internal todos and unconfirmed claims.

The final DOCX may be compiled deterministically from reviewed structured content; producing a .docx-shaped filename is not evidence of a valid report.

### 2.7 ProjectEvent: *what really happened*

Examples: \`project.created\`, \`material.received\`, \`material.accepted\`, \`task.completed\`, \`decision.approved\`, \`plan.frozen\`, \`external_work.completed\`, \`deliverable.rejected\`, \`source.revised\`, \`dependency.invalidated\`.

Events are committed transactionally with state changes and carry an idempotency key. No arbitrary text-based trigger evaluation and no code execution from imported project JSON.

## 3. Agent-recognizable contract: TaskPacket and TaskResult

The Agent should **not** receive a large unstructured conversation or edit the ProjectInstance directly.

### TaskPacket (only the authorized, relevant scope)

    {
      "protocol": "hh.task/1",
      "runId": "run-...unique...",
      "projectId": "project-...unique...",
      "workItemId": "history-investigation",
      "objective": "建立历史资料清单并指出缺口",
      "readableInputs": [
        { "artifactId": "artifact-1", "revision": 2, "role": "case_evidence", "viewId": "text-1" }
      ],
      "templateResources": [
        { "resourceId": "history-method", "revision": 1, "role": "reference" }
      ],
      "toolsAllowed": ["file.read", "evidence.propose"],
      "outputContractId": "history-evidence-inventory",
      "reviewPolicy": "human_required"
    }

Important: \`readableInputs\` are **references** to scoped material access, not wholesale inlined evidence. The task executor fetches only what it is authorized to read, with token/context budget controls.

### TaskResult (a typed proposal, not an authoritative state mutation)

    {
      "protocol": "hh.result/1",
      "runId": "run-...unique...",
      "workItemId": "history-investigation",
      "outcome": "submitted_for_review",
      "producedArtifacts": [{ "artifactRef": "artifact-new", "contractId": "history-evidence-inventory" }],
      "proposedActions": [
        {
          "type": "request_material",
          "requirementKind": "historical_enterprise_record",
          "reason": "企业线索已审核，但缺少经营原始记录",
          "evidenceRefs": ["artifact-1"]
        }
      ],
      "limitations": ["历史影像未获取，不能确认土地变化"]
    }

Runtime validates:
1. Run and task identity, version and permission scopes.
2. Actual artifact existence, format and provenance.
3. Any proposed task/requirement against template policy and deduplication keys.
4. Human review gate before irreversible or professionally significant steps.
5. Relevant dependent task activations; never trust the model's claimed \`outcome\` alone.

Raw model output may be invalid JSON; parse failure is a recoverable run error, not an application state transition.

## 4. Workflow definitions: declarative conditions only

Conditions read structured, approved state:

    {
      "all": [
        { "decision": "stage1.route", "equals": "sampling" },
        { "state": "sampling_plan", "equals": "approved" }
      ]
    }

Rules are evaluated by a deterministic activation engine:
- material needed and requested only after its event/decision/phase conditions;
- human task generation deduplicated by semantic ID + project scope + source version;
- unrelated branches remain inactive, not "failed";
- unchosen branches become not_applicable;
- changes to boundary, sampling-plan version or lab report invalidate affected downstream work.

No executable JS/Python and no natural-language condition in the template manifest.

## 5. Land pollution investigation: acceptance story

At project creation the only required actionable human inputs are:
- project identity and investigation scope,
- original site boundary,
- land use/purpose basis,
- optional existing documents.

After reviewed first-stage evidence and professional decision:

**Branch A: first-stage conclusion.** Sampling-plan and QC requirements become not_applicable; the first-stage report can be drafted/reviewed without inventing samples.

**Branch B: sampling.** Generate candidate points with reasons → professional confirmation and version freeze → *then* activate institution commissioning task → record external work milestone(s) → only after corresponding field/lab/QC work does the system request actual sample records, detection results and QC evidence → validate with sample/point IDs → compose reviewed report sections → deterministic document generation and human signoff.

Here \`quality_control_evidence\` is present as a requirement in the template at creation, but is **not yet an actionable Human WorkItem**. QC activities begin during planning; the final corresponding report is produced as work proceeds.

## 6. What existing code can be kept vs rewritten

Retain as infrastructure: Next.js app shell, SQLite development persistence, Mastra executor adapter, permitted script registry, static output preview, GitHub CI.

Replace:
- all experimental \`schemaVersion: 2|3\` compatibility handling;
- task-only templates and resource-inlined "mega JSON" as the canonical authoring format;
- using task completion to infer professional evidence acceptance;
- Agent return as raw prose directly completing a task;
- one-off choice gate logic tied directly to task schema;
- file upload == accepted evidence;
- hidden material status transitions not recorded as typed events.

New modules should be explicitly grouped as:

    src/protocol/      # canonical types and Zod schemas for package/runtime/agent packets
    src/core/          # compiler, activation, events, invalidation, contract validation
    src/executors/     # Mastra adapter, deterministic scripts
    src/storage/       # SQLite or future database adapters
    src/app/           # HTTP endpoints and project/human/agent UI

Do not add compatibility shims. If the development DB has experimental data, reset it explicitly after making a backup; do not silently migrate and possibly corrupt it.

## 7. Required protocol-level acceptance tests

1. Reject a template with a nonexistent rule target, invalid dependency cycle, unknown capability or output without a producing step.
2. Import one package manually; create a project with a stable package digest.
3. Agent cannot mutate authoritative project state by returning JSON containing invented fields.
4. Missing or rejected material does not satisfy an evidence acceptance gate.
5. First-stage exit never requests a future QC report.
6. Sampling-plan approval triggers commissioning, not a premature QC upload.
7. External institution completion triggers the correct upload/verification tasks.
8. A changed site boundary invalidates downstream spatial and sampling outputs with an auditable event.
9. Rejected Agent proposals are preserved without creating duplicate Human TodoList items.
10. Deterministic report generation cannot include unreviewed evidence or internal Todos in an external deliverable.

## 8. Implementation order

1. Freeze this schema contract and testable example fixtures.
2. Implement new protocol types + strict validators and reject v0.x shapes.
3. Implement event projection, requirements and activation engine.
4. Introduce TaskPacket/TaskResult adapter around the existing Mastra Agent.
5. Migrate land investigation test example to the single package format.
6. Replace the prototype screens, then remove old schema and reset development DB.
7. Attach real GIS, SamplingPlan and DOCX skills only after their capability/permissions/provenance interfaces are verified.

Core objective: **real projects proceed correctly, including gaps and external handoffs, regardless of which LLM executes a task.**
