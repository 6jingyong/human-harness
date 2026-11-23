#!/usr/bin/env python3
"""Read-only EIA source/derived-artifact replay audit for Human Harness.

The audit checks provenance and source equivalence only. It does not OCR scans,
endorse regulatory conclusions, decide site relationships, or sign a report.
Original materials remain local; the generated JSON/MD must be treated private.
"""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def add(checks, check_id, status, detail, refs=None):
    checks.append({"check_id": check_id, "status": status, "detail": detail, "source_refs": refs or []})


def audit(enterprise_zip: Path, analysis_path: Path, qc_pdf: Path,
          snapshot_path: Path, draft_docx: Path):
    checks, todos = [], []
    analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))

    enterprise_sha = analysis["source_sha256"]
    with ZipFile(enterprise_zip) as z:
        matches = [(name, z.read(name)) for name in z.namelist()
                   if not name.endswith("/") and sha256(z.read(name)) == enterprise_sha]
    if len(matches) == 1:
        _, source_bytes = matches[0]
        add(checks, "enterprise_exact_source", "passed",
            "Field-analysis source SHA matches exactly one archived enterprise source member.",
            ["analysis.source_sha256", "archive.member.sha256"])
        source_text = source_bytes.decode("utf-8-sig")
        verified_quotes = [item for item in analysis.get("items", [])
                           if item.get("source_quote") and item["source_quote"] in source_text]
        total_quotes = [item for item in analysis.get("items", []) if item.get("source_quote")]
        add(checks, "enterprise_quote_positions",
            "passed" if len(total_quotes) == len(verified_quotes) and total_quotes else "unverified",
            f"Exact original-text quotes located: {len(verified_quotes)}/{len(total_quotes)}.",
            ["analysis.items[*].source_quote", "archive.enterprise_text"])
    else:
        add(checks, "enterprise_exact_source", "failed",
            f"Expected one archived source by SHA, found {len(matches)}.")
        source_text = ""
    required = [f for f in analysis.get("template_coverage", {}).get("fields", [])
                if f.get("required") and f.get("status") == "not_in_source"]
    for field in required:
        todos.append({"owner": "human", "kind": "missing_independent_source",
                      "target_id": field["field_id"], "reason": field.get("review_note") or "Required field not supported by source."})
    add(checks, "enterprise_missing_business_fields", "unverified" if required else "passed",
        f"Mandatory fields without a source in the existing analysis: {len(required)}.",
        ["analysis.template_coverage.fields"])
    if analysis.get("conclusion_level") == "source_says_only_not_endorsed":
        add(checks, "source_vs_finding_boundary", "passed",
            "Existing field analysis explicitly limits its claims to source transcription.",
            ["analysis.conclusion_level"])
    else:
        add(checks, "source_vs_finding_boundary", "unverified",
            "Source conclusion boundary not explicitly marked.")

    source_manifest = {x["material_id"]: x["source_sha256"] for x in snapshot.get("source_manifest", [])}
    add(checks, "snapshot_enterprise_provenance",
        "passed" if source_manifest.get("SRC-ENTERPRISE") == enterprise_sha else "failed",
        "Frozen snapshot references the enterprise source SHA used by the field record.",
        ["snapshot.source_manifest", "analysis.source_sha256"])

    pdf_sha = sha256(qc_pdf.read_bytes())
    expected_pdf_sha = source_manifest.get("SRC-QC-PDF")
    if expected_pdf_sha == pdf_sha:
        add(checks, "qc_pdf_identity", "passed",
            "Provided PDF bytes exactly match the snapshot's cited QC source.",
            ["snapshot.source_manifest", "qc_pdf.sha256"])
    else:
        add(checks, "qc_pdf_identity", "unverified",
            "Provided PDF SHA differs from the frozen snapshot's QC source. A rebuilt PDF may be visually equivalent, but byte identity is not established.",
            ["snapshot.source_manifest.SRC-QC-PDF", "qc_pdf.sha256"])
        todos.append({"owner": "human", "kind": "source_equivalence_review",
                      "target_id": "SRC-QC-PDF",
                      "reason": "Verify reconstructed QC PDF page mapping against the source version cited by the snapshot; record mapping and original evidence."})

    try:
        import fitz
        pdf = fitz.open(qc_pdf)
        sizes = [len(page.get_text("text").strip()) for page in pdf]
        pages = len(sizes)
        add(checks, "qc_pdf_text_layer", "unverified" if not any(sizes) else "passed",
            f"Examined {pages} pages, {sum(n > 0 for n in sizes)} with extractable text. Zero-text scans require visual review, not a claim of absent fields.",
            ["qc_pdf.pages"])
        if not any(sizes):
            todos.append({"owner": "agent", "kind": "visual_page_extraction",
                          "target_id": "SRC-QC-PDF",
                          "reason": "Read page images with an authorized PDF/vision Skill; inspect page 2 table, samples, units and control limits. Do not assert measured values solely from absent text layer."})
    except ImportError:
        pages = None
        add(checks, "qc_pdf_text_layer", "unverified", "PyMuPDF unavailable; text-layer status not assessed.")

    processed = snapshot.get("processed_assets", [])
    expected_image = next((x["sha256"] for x in processed if x.get("asset_id") == "FIG-QC-P2"), None)
    with ZipFile(draft_docx) as z:
        images = [(name, sha256(z.read(name))) for name in z.namelist() if name.startswith("word/media/")]
        xml = ET.fromstring(z.read("word/document.xml"))
        texts = [el.text or "" for el in xml.iter() if el.tag.endswith("}t")]
        draft_text = "".join(texts)
    if expected_image and any(h == expected_image for _, h in images):
        add(checks, "word_embedded_asset_sha", "passed",
            "The Word candidate embeds a byte-identical copy of the figure in the frozen analysis snapshot.",
            ["snapshot.processed_assets.sha256", "docx.word/media"])
    else:
        add(checks, "word_embedded_asset_sha", "failed",
            "No Word embedded image matched the frozen asset hash.")
    paragraphs = [str(x.get("value", "")) for x in snapshot.get("facts", [])
                  if x.get("kind") == "paragraph"]
    matched = sum(value in draft_text for value in paragraphs)
    add(checks, "word_frozen_text_reuse", "passed" if paragraphs and matched == len(paragraphs) else "unverified",
        f"Frozen approved-for-expression paragraphs exactly present in Word candidate: {matched}/{len(paragraphs)}.",
        ["snapshot.facts", "docx.word/document.xml"])
    # AI-simulated source review and professional review are different gates.
    if any("模拟" in str(x.get("reviewed_by", "")) for x in processed) or \
       any("模拟" in str(y.get("reviewer", "")) for y in analysis.get("items", [])):
        todos.append({"owner": "human", "kind": "professional_review",
                      "target_id": "REVIEW-SIGNOFF",
                      "reason": "Historical source text/image approvals were labeled AI-simulated. Require authorized professional review before an external report can rely on them."})
    add(checks, "external_release_gate", "unverified",
        "Image/text source checks and Word reproduction do not authorize external professional conclusions.",
        ["snapshot.review_status", "analysis.review_status"])

    return {
        "schema": "hh.eia-private-replay.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "input_roles": ["enterprise_archive", "enterprise_field_record", "scan_qc_pdf", "frozen_analysis_snapshot", "word_candidate"],
        "observed": {
            "enterprise_source_sha256": enterprise_sha,
            "qc_pdf_actual_sha256": pdf_sha,
            "qc_pdf_snapshot_sha256": expected_pdf_sha,
            "qc_pdf_pages": pages,
            "word_embedded_images": len(images),
            "frozen_figure_sha256": expected_image,
        },
        "checks": checks,
        "human_todos": [t for t in todos if t["owner"] == "human"],
        "agent_todos": [t for t in todos if t["owner"] == "agent"],
        "limitations": [
            "Read-only replay using actual user-provided files. No live Codex/LLM was executed.",
            "SHA equality proves byte identity only, not source authenticity or specialized regulatory correctness.",
            "A rebuilt PDF has a different SHA from the frozen cited source; equivalence is awaiting Human verification.",
            "Commercial report text is not produced or signed by this script."
        ]
    }


def markdown(r):
    label = {"passed": "PASS", "unverified": "REVIEW", "failed": "FAIL"}
    lines = ["# EIA 真实素材回放：内部核验记录", "",
             "> 仅用于 Human Harness 开发验收。不是环境调查正式报告，也不是项目事实的专业审批。", "",
             "## 核验结果", "", "| 检查项 | 状态 | 结果 |", "|---|---|---|"]
    for c in r["checks"]:
        lines.append(f"| `{c['check_id']}` | {label[c['status']]} | {c['detail'].replace('|', '/')} |")
    lines += ["", "## Human Todo（尚未完成）", ""]
    for t in r["human_todos"]:
        lines.append(f"- **{t['kind']} / {t['target_id']}**：{t['reason']}")
    lines += ["", "## Agent Todo（尚未执行）", ""]
    for t in r["agent_todos"]:
        lines.append(f"- **{t['kind']} / {t['target_id']}**：{t['reason']}")
    lines += ["", "## 执行边界", ""]
    lines += ["- " + text for text in r["limitations"]]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for flag in ["enterprise-zip", "analysis", "qc-pdf", "snapshot", "draft-docx", "out"]:
        ap.add_argument("--" + flag, type=Path, required=True)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    r = audit(a.enterprise_zip, a.analysis, a.qc_pdf, a.snapshot, a.draft_docx)
    (a.out / "eia_replay_audit.json").write_text(json.dumps(r, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (a.out / "eia_replay_human_agent_todos.md").write_text(markdown(r), encoding="utf-8")
    print(json.dumps({"checks": len(r["checks"]),
                      "passed": sum(x["status"] == "passed" for x in r["checks"]),
                      "unverified": sum(x["status"] == "unverified" for x in r["checks"]),
                      "failed": sum(x["status"] == "failed" for x in r["checks"]),
                      "human_todos": len(r["human_todos"]),
                      "agent_todos": len(r["agent_todos"])}, indent=2))

if __name__ == "__main__":
    main()