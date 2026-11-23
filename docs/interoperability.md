# Interoperability study: agents, plugins, PDF/DOCX and portable capabilities

**Status:** research and design roadmap, **not a compatibility claim**. Reviewed on 2026-11-08.  
**Scope:** How Human Harness can reuse mature agent infrastructure and later ship reusable document/GIS capabilities across mainstream hosts without rewriting the same feature for each one.

> **Updated direction (2026-11-08):** [Native Codex Plugin reuse](codex-native-plugins.md) is the current primary plan. The long-form document parser design below is retained for reference **only if existing plugin capabilities prove insufficient**. Do not expand the standalone PDF/DOCX engine or benchmark matrix as a default prerequisite. Human Harness remains a project-level consumer of plugins, not a competitor to the native Codex plugin system.

## Primary reference: Codex (decision 2026-11-08)

**Study the open-source Codex harness first.** [Codex-first design](codex-reference.md) maps its SDK, `codex exec`, app-server, tool/security boundaries, Skills and MCP client to Human Harness. This supersedes the idea of continuously comparing every mature Agent framework. We may test other hosts later **only to validate portability**, not to keep re-litigating the primary architecture.

**Mastra remains the executor in the currently runnable prototype; no Codex adapter has yet been implemented or tested.** Codex is a candidate future execution harness, and Human Harness remains the authority for project/material/decision state.

**Do not rely on obsolete Codex-as-MCP-server guidance**: OpenAI's 2025 developer retrospective was updated to state that its MCP-server mode was removed on 2026-09-05. Use current Codex SDK/app-server/`codex exec` APIs for execution. Codex's ability to *consume* MCP tools is a different feature.

Primary upstream: https://developers.openai.com/blog/codex-as-a-platform

## Executive decision

**Keep Mastra as the current executor until a tested Codex SDK/app-server adapter justifies replacement. Do not build an agent framework from scratch.**

Build one **host-neutral capability** (e.g. `document.read`), then expose it through tested adapters:

1. **Internal Human Harness capability adapter** — called only when a project task is authorized.
2. **MCP tool interface** — for hosts and agent frameworks that support the relevant MCP transport and features.
3. **Agent Skills folder** — for instructions, procedural guidance, reference material and optional scripts.
4. **Platform-specific distribution/permission glue** — only where actually needed.

An Agent Skill is **not** a universal executable service. An MCP server is **not** a full project workflow engine. A ChatGPT/Codex plugin package is **not** guaranteed to install unmodified in Claude Code, Gemini CLI, or Cursor.

We should promise **common capability semantics plus verified adapters**, not “100% compatible everywhere.”

## 1. Distinguish four independent standards/concerns

| Layer | Responsibility | Recommended reuse | What not to assume |
| --- | --- | --- | --- |
| Human Harness Protocol 1.0 | Project lifecycle, current requirements, approved decisions, TaskPacket/TaskResult | Our own runtime and schema | Other products automatically understand our project packages |
| MCP | Discover and call tools, expose resources/prompts through negotiated transports | Existing official SDKs / Mastra or LangChain adapter | Every host exposes the same filesystem, UI, auth, or protocol revision |
| Agent Skills | Package workflow instructions and optionally references/scripts/assets | Open `SKILL.md` format | A skill is a secure sandbox or can execute scripts on every host |
| Capability implementation | Actually read a PDF/DOCX, render a page, parse tables or compile a report | Reuse mature document libraries | A text extraction or OCR result is a verified domain fact |

We should keep **input/output formats stable** even when the runtime implementation changes.

## 2. Codex is the primary reference; other entries are portability targets

The sections below on Mastra, LangChain, Claude, Gemini CLI and Cursor are retained only as compatibility notes; **do not expand them into a parallel agent-framework roadmap**. Follow [the Codex-first plan](codex-reference.md) for the main architecture.

## 2.1. Lessons from established projects

### Mastra — current executor, MCP bridge

Mastra documents both `MCPClient` for consuming external MCP tools and `MCPServer` for exposing Mastra tools/workflows to clients. Transport, authentication and tool approval choices are part of the integration. Its MCP integration is **not installed or wired into Human Harness today**.

Study first: scoped toolsets by task, explicit approval, structured results, lifecycle cleanup, and provider-specific credentials. Keep the current Mastra adapter replaceable.

Official: https://mastra.ai/docs/connections/mcp

### LangChain / LangGraph — alternative integration benchmark

The official JavaScript MCP adapter can discover local/remote servers and expose their tools to LangChain agents or LangGraph workflows. This is useful as a **second client implementation to test our server**, not a reason to migrate our project's authoritative state.

Study first: tool result structure versus model-visible text, retry/interrupt behavior, user elicitation and per-server connection management.

Official: https://reference.langchain.com/javascript/langchain-mcp-adapters  
Official: https://docs.langchain.com/oss/javascript/langchain/mcp

### OpenAI / Codex and ChatGPT plugins

OpenAI documents Agent Skills as reusable instruction/resource folders; plugins can package skills and MCP configuration. Skills explain workflows; MCP performs controlled actions. Plugin packaging and supported runtime permissions are host-specific.

We should eventually provide **portable core Skill** and **MCP endpoint**, with optional OpenAI-specific packaging. Do not present native plugin installation as already tested.

Official: https://developers.openai.com/plugins/concepts/skills  
Official: https://developers.openai.com/api/docs/guides/agents-api/tools/plugins

### Claude Code and Claude environments

Claude supports MCP connectivity, including developer environments with their own configuration and permission policies. Where a host supports open Agent Skills, a standard `SKILL.md` folder may travel, but install paths, script execution, sandboxing and authorization still need host-specific verification.

Official MCP overview: https://docs.anthropic.com/en/docs/mcp  
Agent Skills open format: https://github.com/agentskills/agentskills

### Gemini CLI

Gemini CLI documents open Agent Skills support, including discovery, activation, explicit consent and references/scripts/assets. Its behavior demonstrates why **Skill distribution** is not equivalent to our own permission or execution model.

Official: https://geminicli.com/docs/cli/skills/

### Cursor and other IDE agents

Cursor documents MCP tools in its agent/CLI. Its local repository permissions and configuration conventions are different from an HTTP-hosted ChatGPT integration.

Official: https://docs.cursor.com/en/agent/tools  
Official CLI MCP: https://docs.cursor.com/en/cli/using

## 3. Compatibility is multidimensional

Two environments might both “support MCP” but still differ in:

- **Transport and protocol revision:** local stdio vs remote Streamable HTTP; new and legacy protocol revisions may not behave identically.
- **Authentication/authorization:** API keys, OAuth, session credentials, per-user delegation, tool approval.
- **Resource addressing:** local paths, uploaded file IDs, remote URLs, cloud objects, attachment access.
- **Execution environment:** Windows/Linux/macOS, Node/Python versions, native parser/ML dependencies, offline/online.
- **Model inputs and UI:** text-only results, images, structured content, interactive UI, long-running tool behavior.
- **Skill conventions:** folder discovery, activation, supported metadata, command/script execution.
- **Deployment:** a self-hosted MCP server, a local CLI, a cloud API, a hosted sandbox.

**Portability target:** the same business operation and result schema can be exercised in all supported clients, even if the configuration/authorization and UI differ.

References: https://modelcontextprotocol.io/specification/2026-07-28  
MCP transports: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/index.mdx

## Material-processing methods belong to the template

Host portability only answers **how to call a capability**. ProjectTemplate must separately define **what to extract from each material and how to validate it**, including dependencies on other records and escalation of unresolved issues into the single Human TodoList. See [template-driven material processing](template-material-processing.md). Do not create a separate professional approval queue as part of the interoperability layer.

## 4. First candidate: document.read (PDF / DOCX)

### Why this first?

Our land investigation pilot repeatedly needs to read official documents, inspection reports, quality-control records, tables, figures and source attachments. **Reliable evidence extraction is a prerequisite** to analytical claims.

Merely uploading a PDF or showing extracted text to the LLM is not sufficient.

### Backend candidates

**Docling** is a strong evaluation candidate because its documented input formats include PDF and DOCX, alongside other office formats, and its document model can export structured data/Markdown/JSON. Scanned PDFs can involve OCR/vision pipelines and heavier dependencies. Evaluate on *our own test fixtures* before selecting it.

Official formats: https://docling-project.github.io/docling/usage/supported_formats/  
Official quickstart: https://docling-project.github.io/docling/getting_started/quickstart/

Potential comparison backends (research candidates, **not adopted**):
- A lightweight PDF text-layer path for digitally generated PDFs.
- A DOCX OpenXML-focused extractor for headings, paragraphs, styles, tables, headers/footers and embedded references.
- An OCR/VLM fallback for scanned pages or complex table images.
- Dedicated layout/visual verification for cases where exact appearance matters.

Some backends can run in Python sidecars or a separate service; the MCP/UI/Agent host should not need to know which parser produced the result.

### Proposed normalized Document IR

Do not force every document into plain Markdown. We need a versioned, structured representation, e.g.:

```json
{
  "schema": "hh.document/1",
  "source": {
    "artifactId": "original-123",
    "sha256": "sha256:<original-file-hash>",
    "mimeType": "application/pdf",
    "parser": "docling",
    "parserVersion": "<actual-version>"
  },
  "status": "partial",
  "pages": [{"number": 1, "width": 595, "height": 842}],
  "blocks": [
    {
      "id": "b1",
      "type": "paragraph",
      "text": "Example extracted text",
      "source": {"page": 1, "bbox": [40, 60, 540, 110]},
      "confidence": null
    },
    {
      "id": "t1",
      "type": "table",
      "cells": [{"row": 0, "column": 0, "text": "Sample ID"}],
      "source": {"page": 2}
    }
  ],
  "warnings": ["Some pages or figures could not be parsed reliably"]
}
```

*This is an illustrative future contract, not an implemented API.* DOCX may not have fixed page locations unless rendered; for DOCX use stable structural anchors (section/paragraph/table/cell) rather than inventing page numbers.

Minimum metadata:
- original file hash, parser/version, MIME/size, extraction status and warnings;
- paragraphs/headings, tables with row/column identity, figures with attachments;
- source links to original page/region or DOCX structural anchor;
- explicitly absent/unknown confidence where not measured;
- distinction between text extraction, OCR, structured interpretation and professional evidence acceptance.

The parsed document is a **derived artifact**, not a replacement for the original binary.

### Proposed portable tool contract

```text
document.inspect(artifactRef)            -> MIME, pages/sections, parsing options
document.read(artifactRef, options)       -> hh.document/1 + source links + warnings
document.extract_tables(artifactRef, ...) -> table blocks and original locations
```

These operations should be tested first headlessly with fixed fixtures. MCP is then only one **adapter** around their input/output contract; a Skill supplies the instructions for using them properly. PDF generation, DOCX formatting/rendering and DOCX editing are separate capabilities, with separate acceptance tests.

### Safety requirements before enabling untrusted files

- Inspect actual file signatures and sizes; do not trust a filename extension or client-supplied MIME.
- Sandbox native libraries and optional OCR/ML processing; bound CPU, memory, disk, pages and duration.
- Prevent path traversal, unsafe archive expansion, remote fetches and executable macros by default.
- Treat all document content as **untrusted evidence**, not instructions to the Agent.
- Preserve privacy: opt-in remote OCR/services only, explicit host/tool permissions, no silent external upload.
- Store source/revision identifiers and diagnostics; no “success” when the output is incomplete or garbled.

## 5. Proposed plugin/skill distribution layout

```text
capabilities/document-read/            # FUTURE DESIGN, not in repository
  contract/                             # hh.document/1 schema + examples
  engine/                               # headless parser implementation
  tests/fixtures/                       # licensed sample files + expected results
  adapters/
    hh/                                 # Human Harness adapter
    mcp-stdio/                          # local MCP endpoint
    mcp-http/                           # remote MCP endpoint
  skills/
    document-read/
      SKILL.md
      references/
  platform/                             # optional host install/config notes
```

We should resist maintaining a dedicated PDF reader for each LLM/IDE. Maintain **one implementation** of the document capability and a small number of interoperable transport/installation adapters.

## 6. Proposed verification matrix (no entries are tested yet)

| Host/client | MCP client integration | Agent Skills packaging | Evidence/file access | Current status |
| --- | --- | --- | --- | --- |
| Human Harness + Mastra | Planned `@mastra/mcp` adapter | Optional instructions | Internal artifact IDs | **Not implemented** |
| LangChain/LangGraph | Documented MCP adapter | Host-dependent | Adapter-controlled | **Not tested** |
| ChatGPT / Codex | MCP/plugins and skills documented | Host-specific packaging | Host-specific attachments | **Not tested** |
| Claude Code | MCP documented | Skills-compatible workflow to test | Local/sandbox policy | **Not tested** |
| Gemini CLI | MCP + open Skills documented | `SKILL.md` with consent | CLI/user permissions | **Not tested** |
| Cursor | MCP documented | Verify before claiming | IDE workspace permissions | **Not tested** |
| Standalone CLI/HTTP | Direct internal capability | Not required | Explicit file or upload | **Not implemented** |

Do not label a host **supported** until a user-visible installation recipe and an automated/recorded smoke test both pass. A green `npm run build` is not evidence of host interoperability.

## 7. Suggested learning and integration order (small, evidence-led steps)

**Study A — Codex public integration surfaces and a safe read-only tool**  
First map Codex SDK vs app-server event/approval lifecycle, then execute a harmless read-only test in a disposable environment. Compare tool-schema portability against a second host only after Codex integration is understood. No real user documents yet.

**Study B — minimal document capability**  
Compare document parsers on a small set of public/legal test files:
- native PDF (text+tables),
- scanned PDF (OCR required),
- DOCX (headings, tables, images, section structure),
- deliberately malformed/unsupported file,
- Chinese text and mixed Chinese/English layout.

Measure actual extraction coverage, table cell correctness, source traceability, speed/memory, and failure modes. Do not optimize only for generated Markdown quality.

**Study C — portable distribution**  
Wrap the winning read-only parser in a headless CLI/API, expose through MCP stdio and Streamable HTTP, add a portable `SKILL.md`, and test in **Mastra + one other real client**.

**Study D — project integration**  
Have a Human Harness WorkItem request a document read through the capability registry; save the resulting structured artifact and source links. Use explicit human review before accepting critical domain evidence.

**Study E — broader host compatibility**  
Only after the core is stable, test ChatGPT/Codex, Claude Code, Gemini CLI, Cursor and more platforms on declared host/version/permission matrices.

## 8. Acceptance criteria before saying “cross-platform compatible”

1. Same input document yields the same **document contract** across adapters, modulo documented parser/backend differences.
2. All outputs include original-file attribution and partial/failure states.
3. Text, tables, images and source links are distinguishable; no fabricated page number for unrendered DOCX.
4. The tool cannot read arbitrary host files outside authorized material scope.
5. A corrupt/unsupported input fails safely without crashing the host or changing project state.
6. Skill instructions never silently override host security or runtime permission policies.
7. Each supported host has recorded installation, credential, permission and error-path tests.
8. The project accepts/rejects the **derived document artifact** separately from the original uploaded file.

## 9. Non-goals now

- No marketplace, discoverability ranking or external template search.
- No immediate switch from Mastra to LangGraph.
- No promise of identical host UI or rights to access each host's private attachments.
- No assumption that all SDKs support the latest MCP revision or all Agent Skills metadata.
- No automatic installation of third-party scripts with project templates.

### Reading list (official sources)

- Mastra MCP: https://mastra.ai/docs/connections/mcp
- LangChain JS MCP adapter: https://reference.langchain.com/javascript/langchain-mcp-adapters
- MCP specification: https://modelcontextprotocol.io/specification/2026-07-28
- Agent Skills format: https://github.com/agentskills/agentskills
- OpenAI plugins and skills: https://developers.openai.com/plugins/concepts/skills
- Gemini CLI Agent Skills: https://geminicli.com/docs/cli/skills/
- Cursor MCP: https://docs.cursor.com/en/agent/tools
- Docling formats: https://docling-project.github.io/docling/usage/supported_formats/
