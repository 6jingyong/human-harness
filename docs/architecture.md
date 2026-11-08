# Architecture decision record — v0.1

## Product invariant

The authoritative unit is a project, not a chat session. An agent is a replaceable executor.

Project = versioned template snapshot + task DAG + immutable artifacts + append-only events.

## Boundaries

1. Human Harness core: task definitions, dependencies, statuses, approval decisions, evidence inventory.
2. Executor adapter: receives one ready agent task and bounded source context, returns a proposed artifact.
3. UI: two projections of the same state, not independent checklists.
4. SQLite database: local authoritative state. Uploaded bytes are outside the web static root.

## State machine

- Human: pending to completed, or skipped (optional only).
- Agent: pending/failed to running, then review/completed, or failed.
- Review: review to completed (approve) or pending (reject; feedback retained).
- A dependency is met only when completed or explicitly skipped.
- Agent results are immutable artifacts; rejection does not overwrite earlier output.

## Security and correctness

- A model never writes authoritative task status; only application commands do.
- File names and uploaded text are data, not trusted system instructions.
- Only allowlisted UTF-8 extensions are provided as readable context. Binary files are stored but marked unparsed.
- Demo mode is deterministic and labeled; it never claims live tool use.
- Mastra has no shell, filesystem or browsing tools in v0.1.
- Do not expose this unauthenticated local development server to the public Internet.
- SQLite assumes one app instance with durable disk; ephemeral/serverless hosting is not supported.
- A 12 MB file cap exists. Database and uploads require joint backup.

## Known missing capabilities

- No autonomous scheduling, durable job queue or abandoned-task lease recovery.
- No PDF/CAD/image semantic parsing; binary bytes are preserved only.
- No AI-generated dynamic tasks. Future proposals need user review and schema validation.
- No material revision and dependency invalidation yet.
- No multi-user authorization, rate limits or production security hardening.
- No commercial report compiler or document export pipeline.

## Next milestones

1. Durable queue with leases, timeout recovery and idempotency.
2. Material versions and dependency invalidation/re-execution.
3. Structured human task proposals with provenance, review and approval.
4. Executor registry with model/tool permissions and observability.
5. Evidence and claims as structured artifacts, separate from final report formatting.
6. Auth, multi-user isolation, secure file processing.
