# Template-driven document methods — reproducible spike

**Status:** isolated research experiment. **Not** an integrated Human Harness capability, Codex run, MCP server, general PDF/DOCX parser or professional report checker.

## What it tests

Two explicitly **synthetic** but real-format documents:

- `fixtures/lab-report.pdf`: a text-layer Chinese/English PDF containing a laboratory-style table.
- `fixtures/field-log.docx`: a DOCX with field sampling records.

The fixture generator creates both files. It embeds intentional problems:
1. Sample `S-002`: PDF point `P-09`, DOCX point `P-02`.
2. Sample `S-003`: PDF unit is blank.

`methods.json` describes the required document kinds, table fields, mandatory values and a cross-document check. `probe.py` reads files, extracts rows **with source anchors**, runs deterministic checks, and proposes targeted **Human Todo items**. The result is not accepted evidence; a human must resolve discrepancies using originals.

## Run locally

Python >=3.11.

```bash
cd experiments/document-methods
python -m pip install -r requirements.txt
python generate_fixtures.py
python probe.py --method methods.json --out result.json --verify
```

You should see `PASS` and exactly two proposed Human Todos. They include a PDF page/bounding rectangle for each affected cell and a DOCX table/row/column reference (but no invented DOCX page number).

The fixtures are generated during the experiment and **not tracked as reference evidence**. Every PDF/DOCX source states it is synthetic. You may view the generated files; they are not usable for real land investigations.

## What this intentionally cannot do

- Recognize arbitrary PDF/DOCX layouts, scanned PDF, merged cells or handwriting.
- OCR images or interpret non-tabular values automatically.
- Verify laboratory accreditation, the authenticity of signatures or professional regulatory compliance.
- Call Codex, install Skills/MCP, mutate a Human Harness project or create a real persisted WorkItem.
- Guarantee stable word/page location after DOCX rendering.
- Prove accuracy on real-world reports (only two controlled fixtures).

The extraction backend is deliberately replaceable. The business requirements are declared in `methods.json`, while the adapter uses `pdfplumber` and `python-docx`. The future production system should use a richer normalized document representation and test multiple backends.

## Files

`methods.json` — experimental, non-importable processing instructions; `probe.py` — extraction/validation runner; `generate_fixtures.py` — recreates original-format fixtures; `requirements.txt` — isolated experiment dependencies.

See [experiment findings](../../docs/document-methods-experiment.md) and [proposed template methods](../../docs/template-material-processing.md).
