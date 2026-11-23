# EIA real-source replay: private pilot and acceptance boundary

The `eia-source-replay` example is a **generic Human Harness project template**, not a replacement for EIAWorkbench. Its workflow is inspired by one real, user-authorized corpus, but **no actual EIA documents, names, measurements, extracted business findings or private source hashes are stored in this repository**.

## Workflow

- **Enterprise Agent** reviews source text against a prior extracted-field candidate and clearly separates source statements from independent environmental findings.
- **QC Agent** reviews a scanned quality-control report, the frozen analysis snapshot and an existing Word draft. It must not treat a no-text-layer PDF as data absence. It cannot silently equate different source hashes, even when a PDF has been rebuilt from page images.
- **Human Todo** handles unresolved company/site identity and original-vs-rebuilt PDF provenance, with explicit acknowledgement of any remaining unknowns or a new accepted source version.
- **Review Agent** consumes both approved interim outputs and the Human handoff, creating only an internal evidence and follow-up report. No signed EIA conclusion can be issued by the template.

The template is selectable in the standard left Human / right Agent two-column UI. Field extraction/validation methods are pinned in the template, rather than hard-coded into Human Harness core.

## Local source replay audit

`scripts/eia-replay-audit.py` is a read-only, separately runnable audit that accepts:
- a ZIP containing the original enterprise source text;
- the existing extracted-field JSON;
- a rebuilt scanned QC PDF;
- the frozen analysis snapshot JSON;
- the previously generated Word draft.

It verifies exact archive member SHA, quoted source text locations, frozen-source SHA links, QC PDF text-layer availability (optional PyMuPDF dependency), embedded Word figure identity, and reuse of frozen paragraph text. It produces `eia_replay_audit.json` and `eia_replay_human_agent_todos.md`.

The script reads real files, but **does not call Codex, OCR, perform technical sampling/result judgments, or write to a Human Harness SQLite runtime**. Its audit status describes provenance and file-derived consistency, **not independent professional certification**.

Example local invocation:

```bash
python scripts/eia-replay-audit.py \
  --enterprise-zip "/private/enterprise-source.zip" \
  --analysis "/private/extracted-fields.json" \
  --qc-pdf "/private/qc-rebuilt.pdf" \
  --snapshot "/private/frozen-analysis.json" \
  --draft-docx "/private/draft.docx" \
  --out "/private/audit-results"
```

The private audit of actual user files is saved in the user's ChatGPT Library under **`/Human Harness/真实素材试验_20261109/`**. The actual source files remain in the EIA project Library, with a **separate private input bundle** prepared for manual entry into the template. The public GitHub fixture tests use synthetic data only.

## Acceptance levels (do not conflate)

1. **Real byte-level audit**: checks actual user files and reports passes/unknowns. It is a read-only standalone tool, not a model execution.
2. **Harness protocol test**: `tests/eia-source-replay.test.ts` exercises template validation, separate Agent scopes, parallel readiness, Human provenance requests, and Human approval exception paths using synthetic fixtures.
3. **Browser UI test**: `tests/browser/workbench.spec.ts` verifies all three Agent groups, material uploads and an unverified Demo task checklist in Chromium.
4. **Real model/Skill test**: still pending. The local runtime used for the file audit has no authenticated Codex CLI. A later controlled Codex/vision run must process the same approved files and return source citations and check receipts for actual human review.

A mismatch between a reconstructed file's SHA and a frozen snapshot SHA is **not** an automatic proof of forgery. It is a provenance question requiring mapping or acceptance of unresolved uncertainty. Text quoted from a company statement remains that statement's assertion, not an approved site finding.
