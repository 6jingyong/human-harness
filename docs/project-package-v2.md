# Executable project package (v2)

A project template is a versioned **executable project package**, not just a task list.

## The four required concerns

| Concern | Manifest field | Meaning |
| --- | --- | --- |
| Initial Human TodoList | tasks: owner=human, inputKind, optional | Inputs and decisions visible at project start |
| Full project process | workflow.stages and tasks.dependsOn, reviewRequired | Workflow stages, execution and review gates |
| Built-in assets and automation | resources: reference, document-template, automation | Reference materials, master documents and trusted scripts |
| Final deliverable requirements | deliverables: taskId, fileName, format, checks | What must be produced and how validation works |

Both panes are projections of **one authoritative task graph**, not independent lists.

## Keep three classes of material separate

1. **Template-bundled material** — generic references, format examples, reusable document masters, and trusted script IDs. Not evidence about the current project.
2. **Project inputs** — project-specific facts, files, measurements, maps, approvals, and user-provided evidence.
3. **Derived artifacts** — analysis, parsed data, proposed locations, drafts and compiled deliverables, each linked to its producing task.

A report must not present template background material as case-specific evidence. Internal missing-evidence TodoLists must remain separate from public commercial deliverables.

## Execution rules

- Human-owned tasks collect inputs and review decisions.
- LLM tasks call the replaceable Agent executor with task-scoped resources.
- Script tasks call an application-registered, allowlisted capability by script ID. Imported JSON **cannot contain executable code**.
- A script task must explicitly reference an automation resource in its resourceRefs.
- Output contracts are validated before entering human review; approval releases downstream tasks.
- A project snapshots the *complete* template manifest at creation; newer template versions do not silently change old projects.

## Current v2 support

- Import one strict JSON manifest with inline text resources and registered script references.
- Three resource kinds: reference, document-template, automation.
- Workflow stage definitions and task-stage relationships.
- Deterministic registered Markdown assembler (assemble-markdown-v1).
- Text/Markdown/JSON output contracts with minimum length and optional exact required headings.
- Immutable per-project template snapshots; earlier imported task-only templates remain supported.

See examples/template.document-review.json for a complete example. A declared deliverable named .docx or .pdf does not create that file: those formats require additional compilers and validators.

## Future ZIP package design

A future package may contain manifest.json, resources/, templates/ and scripts/ with versioned metadata and checksums. ZIP import, binary document masters, arbitrary script loading and package signing are **not implemented**. Executable scripts should require a separately trusted install step, never code execution on template import.

## Major remaining gaps

- Dynamic user Todo suggestions and conditional branches.
- Versioned project materials, provenance and upstream invalidation on change.
- Multi-file outputs, real DOCX/PDF generators, domain-specific content validators.
- Long-running queue/lease recovery and fine-grained tool permissions.
- Authentication and multi-tenant security controls.
