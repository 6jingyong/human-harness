# Human Harness — Template-first Product Architecture (Historical Design Proposal)

> **Superseded for discovery/search.** The product no longer plans to build template search, intent matching, discovery ranking or a marketplace. Current decisions are recorded in [runtime-first-reconstruction.md](../runtime-first-reconstruction.md). This file is retained as prior design exploration; its template registry/search sections are not implementation requirements.

> **Status:** design specification, not an implemented feature set.  
> **Working example:** 中国建设用地土壤污染状况调查（UI 简称「土地污染调查」）.  
> **Primary decision:** Home is a template finder and project launcher, **not** a chat input.

## 1. Product goal

The user comes with a project intention rather than a detailed prompt. Human Harness should find a trustworthy project package, explain what it covers and requires, instantiate a durable project, and drive collaboration through **current actionable tasks**. Human and AI are projections of one project state, not two independent lists.

The core journey is:

1. **Describe or select the project type.**
2. **Find and compare matching project templates.**
3. **Inspect suitability:** applicability, coverage, resources, automation, human obligations and expected deliverables.
4. **Run project preflight:** only ask for the few details necessary to determine applicability.
5. **Create a project by snapshotting the selected template.**
6. **Open the two-pane project workspace:** Human TodoList / Agent execution + outcomes.
7. **Advance by evidence and event gates; activate later obligations only when ready.**
8. **Verify, review and export deliverables** against a declared output contract.

Users can also start with the general-project template or request a proposed template when no suitable package exists. AI-generated template proposals are drafts, not approved production templates.

## 2. Three product surfaces

### A. Template Center (find / evaluate / install)
- Intent search: human wording, e.g., “调查一块准备改变用途的建设用地是否有污染”.
- Browse by project class and industry; filter by jurisdiction, output type and capability availability.
- Template detail page:
  - Scope, eligible / ineligible cases, regional and time-sensitive standards.
  - Four-part contents: initial inputs, workflow + decision branches, bundled assets + scripts, deliverable contracts.
  - “Need from you now” (short list) and “May be needed later” (future-stage requirements).
  - External institutions/professional decisions and where the software cannot substitute for them.
  - Executor/tool readiness: available / not installed / design only; each capability is checked, not inferred from a template claim.
  - Version, maintainers, provenance, rights/license, signed/verified execution permissions and change log.
  - Predicted flow/effort as a dependency map, not an invented completion date.
- Action: **Create project** -> preflight -> create; do not run untrusted scripts merely by importing a template.

### B. Project Workspace (operate)
- Header: project name, template version, current stage, current blockers, accepted deliverables.
- Primary left: **Human TodoList**: active inputs, approvals, external coordination; each task includes purpose, due stage, acceptable formats and the consequence of skipping.
- Primary right: **Agent execution and results**: ready/running/blocked tasks, evidence basis, output versions, approval or correction request.
- Supporting views: material inbox / provenance, workflow map, evidence & artifacts, event log, final deliverables.
- “Later” is informative and non-actionable. Do **not** show a request to upload a QC report on day one.
- Each user submission is matched to a **MaterialRequirement**; matching may be proposed by AI but validated against concrete constraints.
- A task only completes when its acceptance checks pass (or an authorized human explicitly approves with recorded rationale). A model's free-text “done” is not authoritative.

### C. Template Studio (author / test / publish)
- Edit initial human inputs and conditional future material needs separately.
- Build stages, decision gates, dependencies and parallel branches.
- Manage references, document masters, skills, scripts and capability trust.
- Declare outputs and content/layout validators (including professional review when necessary).
- Preview what users see at any checkpoint.
- Simulate trajectories before publishing (stage-one exit, normal sampling, missing report, rejected QC, changed coordinates).
- Version and release packages; existing projects keep original snapshots unless an explicit migration is reviewed.

## 3. Core domain objects — not just Tasks

**TemplatePackage** (versioned manifest + assets)  
→ **ProjectInstance** (immutable package snapshot + changing state)  
→ **MaterialRequirement** (a statement of what evidence is needed, when and from whom)  
→ **MaterialArtifact** (an actually received versioned item with source, hashes, provenance, review state)  
→ **Task / DecisionGate** (what action should be taken now and by whom)  
→ **Run / ProducedArtifact** (model/tool/script results with inputs and versions)  
→ **DeliverableContract** (file format, required contents, validators and sign-off).

A MaterialRequirement is not a Todo. A “future required” item is already known to the template, but an actionable task is **projected only when the activation rule fires**.

Suggested MaterialRequirement fields:
- `id`, `title`, `type`, `scope`, `required_when`, `request_when`
- `owner` (human / agent / external_institution / system)
- `source_policy` (template/reference, project-specific, primary/derived, available alternatives)
- `acceptance` (valid formats, linked IDs, dates, original source, coverage and QC criteria)
- `satisfied_by` (0..N accepted artifact IDs; not simply “one uploaded file”)
- `invalidates` / `depends_on` and `status`.

Suggested MaterialRequirement status:
`inactive` → `needed` → `awaiting_external` / `submitted` → `verifying` → `accepted` or `rejected`; `not_applicable` is a distinct terminal route, and `invalidated` reopens downstream work.

## 4. Project compiler vs workflow engine

**Template Registry:** index and version approved packages, record provenance and capability availability.  
**Template Matcher:** classify user goal and return ranked candidates + suitability reasoning (AI assists; hard scope rules decide eligibility).  
**Preflight:** ask only information needed to pick the branch and initialize; retain uncertainty without inventing facts.  
**Project Compiler:** freeze package version and initialize requirements, stages, task definitions, outputs and initial event ledger.  
**Activation Engine:** listen to structured events and evaluate rules; create/deduplicate user or agent tasks, pause, resume and invalidate downstream state.  
**Material Store:** keep incoming files separate from bundled reference assets; track hashes, metadata, versions and evidence roles.  
**Agent/Script Registry:** Mastra or another executor is a replaceable worker; bundled scripts need trust and permissions.  
**Deliverable Builder:** deterministic compilation of approved material into professional outputs; quality gates and human sign-off.

**Rule evaluation needs authoritative structured facts**, e.g. `sampling_plan.status=approved`, not free-text LLM assertions. LLMs may propose observations and additional tasks for approval.

## 5. Land-contamination investigation example

At project creation, show only:
- Project identity, investigation scope, and commissioned purpose;
- Site boundary with coordinate reference and original source;
- Intended land use and supporting basis;
- Optional upload of already possessed historical, geotechnical and prior test materials.

The template knows the complete stage sequence:
`intake → boundary → historical investigation/visits/interviews → professional stage-one decision → [optional sampling plan → approved locations/indicators → commission institution → field/lab work → detection and QC evidence → data assessment] → writing → deterministic DOCX assembly → sign-off`.

### Two legitimate project branches

**Stage-one exit:** professional decision that sampling is not warranted under the applicable conditions. Mark downstream sampling/detection/QC materials `not_applicable`. The final first-stage report can proceed without fictional analysis data.

**Sampling branch:** after the sample plan and its point IDs/locations/depths/indicators are approved and frozen, generate a human task to **commission** field sampling, laboratory analysis and QA/QC with the appropriate external institution. Subsequent record requests activate on **actual work-completion events**.

Example event-driven projection:

| Authoritative event | Human task that becomes actionable |
|---|---|
| project.created | Submit identity, boundary and use basis; optionally upload existing files |
| risk_enterprises.reviewed and gaps remain | Request named historic enterprise files from relevant sources |
| sampling_plan.approved + frozen | Commission field/lab work under approved plan version |
| field_work.completed | Submit borehole, sampling and chain-of-custody records |
| lab_work.completed | Submit detection results and formal test report |
| qc_work.completed | Submit QC records / report appropriate to the work |
| evidence.acceptance_failed | Ask the responsible institution to correct/clarify specific defects |
| final_report.compiled | Professional final review and release decision |

The system may display future QC requirements in a **plan overview**, but must not put them in **“your tasks now”** before an institution has created the corresponding records. Quality assurance duties *begin in planning*; report documents are produced as the work is performed and completed.

### Change propagation

- Boundary revision → downstream spatial/historical inference, risk areas and proposed sampling may be stale.
- Frozen sampling plan revision → commissioning scope and all sample mappings must be rechecked; historical reports cannot silently satisfy a revised plan.
- QC/report replacement → rerun consistency and assessment, invalidate conclusions and final report until reviewed.

## 6. Template quality criteria

A template is **usable**, not merely installable, only when:
- Scope and eligibility rules are defined.
- Initial human actions are minimal, specific and realistically obtainable.
- Every later required material has a producer and activation event.
- Every agent task has declared permitted inputs, tools and review criteria.
- Required external institutions and professional sign-offs are represented.
- Every output has a real producing capability (not a placeholder) and explicit validation.
- Domain standards and assets are versioned, attributable and licensable.
- Core branch simulations pass and errors do not silently mark the project complete.

## 7. UX acceptance tests

**T1 — Find:** user enters “给准备变更用途的地块做污染调查”; Template Center shows a suitable land contamination package with scope, assets and output, not a blank chat.  
**T2 — Start:** creating a project yields identity/boundary/use tasks but not a request for a future QC report.  
**T3 — Finish stage one:** approved first-stage exit makes sampling materials not applicable and allows the relevant final report.  
**T4 — Sample:** professional sign-off freezes locations before a commissioning task appears.  
**T5 — Institution:** QC and test-report tasks activate when work completion is recorded, not at project start.  
**T6 — Missing evidence:** rejected QC creates an actionable clarification task, while unrelated tasks continue.  
**T7 — Change:** revised boundary or points flags dependent artifacts for revalidation; snapshots and approvals are preserved.  
**T8 — Deliver:** a finished report and separate internal missing-evidence list are validated distinctly; no internal “please check original” Todos in the client report.

## 8. Evolution from current v0.1/v2 engine

Existing parts to retain: Mastra executor adapter, two-pane UI, project persistence, approval events, template validation, trusted registered scripts, artifact versions.

Change in order:
1. Add `MaterialRequirement`, provenance/versioned `MaterialArtifact` and conditional decisions into domain model.
2. Introduce activation engine and deterministic rule language, with event replay and idempotent task creation.
3. Add Template Registry suitability/capability checks, package inspection and preflight.
4. Update Project Compiler to snapshot full package and initial rule state.
5. Refactor primary navigation to Template Center → Project Workspace, plus Template Studio.
6. Add reliable agent jobs, tool permissions, material invalidation and true multi-file output builders.

### Non-goals for current v0.1

Do not claim GIS retrieval, sampling execution, legal certification, PDF/DOCX production or automatic QC interpretation merely because the package declares them. Do not run untrusted code imported through a template. Do not merge design-only schemas into a production import path before there are validators and acceptance tests.

Related domain draft: `docs/blueprints/land-contamination-investigation.md`, `docs/blueprints/land-contamination.design.json`.
