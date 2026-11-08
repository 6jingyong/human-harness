# Codex-first design reference for Human Harness

> **Status:** architecture study and product decision, not an implemented Codex adapter.  
> **Reviewed:** 2026-11-08  
> **Canonical upstream:** https://github.com/openai/codex

## Decision

**Use the open-source Codex harness as the primary technical reference for agent execution.** Stop broad agent-framework comparison as the default research strategy. Learn Codex's public interfaces and design before adding custom machinery to Human Harness.

Human Harness is a **project operator**. It owns the project package, project state, material requirements, human task board, evidence acceptance and deliverable approval. Codex is a candidate **task executor** and is a reference for tool/skill/permission integration.

Current implementation uses **Mastra**. This decision does not claim Codex is already installed, integrated, feature-equivalent in every platform, or the best model for every non-coding task.

### Critical separation

```text
Human Harness (business/project layer)                Codex (agent execution layer)
───────────────────────────────────                ─────────────────────────
ProjectPackage and version                           Context & session/turn lifecycle
MaterialRequirement activation                      Model loop / context maintenance
Human TodoList / external institution handoffs       Tool dispatch / shell / app-server events
Professional decision / evidence acceptance          Sandbox / tool-level approvals
Deliverable review and project event ledger          Skills / MCP tools / execution trace
                 │
                 └── TaskPacket / execution adapter ──► Codex SDK or app-server
                        ◄──── Candidate artifact + event stream
```

Codex's **thread/turn** state does **not** replace Human Harness's durable **project/work-item/material** state. One project may launch many Codex task runs; Codex's output must still be checked and accepted by the project.

## What to study first: official Codex architecture, not a collection of competitor features

| Codex mechanism | Public source/interface | Human Harness lesson |
| --- | --- | --- |
| Headless run | `codex exec` | Useful for one-shot scoped tasks and fixtures; minimal lifecycle control |
| App integration | Official Codex SDK | Try a small bounded job before replacing any existing executor |
| Persistent interactive integration | `codex app-server` | Event streaming, task progress, resume/interruption, approval handling |
| Shared protocol | `codex-rs/protocol`, `app-server-protocol` | Keep schemas small and type-safe; do not put business logic in protocol types |
| Agent loop | `codex-rs/core` | **Reuse** model/context/tool loop rather than reimplementing an agent framework |
| Tool dispatch and sandbox | Codex tool routing, sandbox/approval settings | Human Harness declares allowed capabilities; executor enforces local execution permissions |
| Project instructions | `AGENTS.md` | Short, repo-wide invariants; only task-relevant guidance |
| Agent Skills | `SKILL.md` plus references/scripts/assets | Skill = reusable *how-to*; not evidence or an approved project decision |
| MCP client/tool integration | Codex MCP connections | Tools own real actions and structured results; project runtime owns authorization and evidence acceptance |

**Official primary references:**

- Codex platform/harness overview: https://developers.openai.com/blog/codex-as-a-platform
- Codex source: https://github.com/openai/codex
- Codex app-server protocol: https://github.com/openai/codex/tree/main/codex-rs/app-server
- Codex protocol crate: https://github.com/openai/codex/tree/main/codex-rs/protocol
- Codex configuration and sandbox: https://developers.openai.com/zh-Hans/docs/config-file/config-basic
- Skills and model context guidance: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra
- Skill + MCP division: https://developers.openai.com/plugins/concepts/skills

**Important compatibility note:** OpenAI's earlier article states that the **Codex-as-MCP-server feature was removed on 2026-09-05**. Do not design the core integration around obsolete `codex mcp-server` guidance. Codex consuming third-party MCP tools is a separate capability. Use current SDK/app-server/`codex exec` documentation for agent execution; use an independent MCP server to export our own document/GIS tools.

Reference: https://developers.openai.com/blog/openai-for-developers-2025

## Recommended architecture: Codex as executor, not as project database

We should experiment with an adapter shaped like:

```typescript
interface AgentExecutor {
  start(input: TaskPacket, policy: ExecutionPolicy): AsyncIterable<ExecutionEvent>;
  approve(runId: string, decision: ToolApproval): Promise<void>;
  interrupt(runId: string): Promise<void>;
  inspect(runId: string): Promise<RunStatus>;
}
```

This **illustrates** the desired boundary and is **not implemented**. Actual available methods and event types must be mapped from the SDK/app-server version used in a tested prototype.

The adapter must not let the agent directly mark a human material `accepted`, make a professional decision, or bypass final-report review. Tool-level approval in Codex **does not replace** professional project review in Human Harness.

### Why app-server is particularly relevant

Human Harness has a persistent GUI and long-running tasks. The official Codex app-server supports thread/turn events, interruption and approval requests; that is closer to our eventual product needs than merely wrapping a command-line prompt. The SDK is likely the easiest initial smoke test; app-server is the reference for lifecycle and UI integration.

**Do not replace Mastra on paper.** Compare one test scenario with current Mastra and an actual Codex integration (configuration, authenticated execution, events, interrupted run, approval path, scoped inputs, result validation). Only then decide whether Codex should be the primary executor.

## PDF/DOCX: follow the Codex extension philosophy

Codex is not itself a guarantee that arbitrary PDFs and DOCX files will be parsed safely and faithfully in every host.

Recommended design:

```text
document.read (one headless capability)
    ├── canonical input/output and provenance schema
    ├── tested PDF/DOCX backends
    ├── Human Harness capability adapter
    ├── MCP tool adapter for compatible agents
    └── Agent Skill (SKILL.md + references + optional scripts)
```

- **MCP:** callable document read, table extraction, real file access and authorization.
- **Skill:** when/how to use those tools, source citation rules, handling incomplete extraction.
- **Human Harness:** decides when a project needs the evidence and whether the resulting artifact is accepted.
- **Host adapters:** configuration, credentials, sandbox permissions and supported file transport for Codex, ChatGPT, Claude, Gemini CLI, Cursor, etc.

Start by evaluating a read-only PDF/DOCX capability (e.g. Docling as a **candidate**, not selected). Keep the original binary, page/structural anchors, table coordinates, extractor version, warnings and parse-status. **No** assumption that Markdown conversion constitutes professional verification.

## Principles borrowed from Codex worth keeping in our small repo

1. **Layered responsibilities:** core runtime, protocol, executor, tools and UI remain separate.
2. **Progressive disclosure:** short `AGENTS.md` and Skill metadata; load details only when relevant to a task.
3. **Explicit boundaries:** project facts and untrusted document contents never become executor instructions.
4. **Streaming events and approvals:** user sees actual progress; tool permissions and business approval are different gates.
5. **Recoverability:** persist run identity, traces and outcomes without treating text such as “done” as authoritative state.
6. **Verification:** acceptance is a tested state transition, not an LLM confidence claim.
7. **Minimal duplication:** do not rebuild shell, sandbox, tool loop, context compaction, or document parsers before checking existing Codex components.

## Scope control: what not to build yet

- No general multi-agent scheduler just because Codex supports delegation.
- No template discovery/marketplace.
- No rewrite of Codex's Rust internals into TypeScript.
- No automatic assumption that a ChatGPT plugin works in other hosts unchanged.
- No installed PDF/DOCX plugin until a small read-only, traced, reproducible benchmark passes.
- No unconditional migration from Mastra until a real Codex SDK/app-server smoke test proves the chosen integration.

## Narrow next learning sequence

**A. Read the Codex public surfaces.** Map `codex exec`, SDK and app-server; choose an API lifecycle that can emit progress, tool calls, human approval and completion events. Record docs/versions.

**B. One no-write test job.** Send a small scoped TaskPacket to Codex via the SDK. Record structured candidate output, events and any permissions needed; explicitly disallow arbitrary project mutation.

**C. One approval/interrupt test.** Trigger an operation requiring consent in a disposable sandbox, then approve/deny and verify no project state corruption.

**D. Only then document.read.** Evaluate PDF/DOCX extraction against source-traceable fixtures; distribute the same headless capability through MCP + Skill with host-specific testing.

This document is **research**, not a claim that these adapters exist today.
