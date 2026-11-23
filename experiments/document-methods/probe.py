#!/usr/bin/env python3
"""Isolated read-only synthetic PDF/DOCX method experiment.

Not a production parser, Skill installer, MCP server or professional evidence validator.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pdfplumber
from docx import Document


def anchor(material: str, kind: str, row: int, column: str, *, page=None, table=None, bbox=None) -> dict:
    loc = {"material": material, "kind": kind, "table": table, "row": row, "column": column}
    if page is not None:
        loc["page"] = page
    if bbox is not None:
        loc["bbox"] = [round(float(x), 2) for x in bbox]
    return loc


def read_pdf(path: Path, spec: dict) -> dict:
    with pdfplumber.open(path) as doc:
        texts = [p.extract_text() or "" for p in doc.pages]
        if not any(spec["recognizeText"] in text for text in texts):
            raise ValueError(f'{spec["id"]}: expected document title not found')
        for page_number, page in enumerate(doc.pages, 1):
            for table_number, table in enumerate(page.find_tables(), 1):
                raw = table.extract()
                if not raw:
                    continue
                headers = [(v or "").strip() for v in raw[0]]
                if headers != spec["tableHeaders"]:
                    continue
                rows = []
                for row_number, row in enumerate(raw[1:], 2):
                    cells = {}
                    for index, name in enumerate(headers):
                        value = (row[index] or "").strip()
                        bounds = table.rows[row_number - 1].cells[index]
                        cells[name] = {
                            "value": value,
                            "source": anchor(
                                spec["id"], "pdf_table_cell", row_number, name,
                                page=page_number, table=table_number, bbox=bounds,
                            ),
                        }
                    rows.append(cells)
                return {
                    "kind": spec["id"], "recognition": "matched",
                    "rowCount": len(rows), "rows": rows, "pageCount": len(doc.pages),
                }
        raise ValueError(f'{spec["id"]}: expected table headers not found; cannot guess from flat text')


def read_docx(path: Path, spec: dict) -> dict:
    doc = Document(path)
    text = "\n".join(p.text for p in doc.paragraphs)
    if spec["recognizeText"] not in text:
        raise ValueError(f'{spec["id"]}: expected document title not found')
    for table_number, table in enumerate(doc.tables, 1):
        raw = [[cell.text for cell in row.cells] for row in table.rows]
        if not raw:
            continue
        headers = [x.strip() for x in raw[0]]
        if headers != spec["tableHeaders"]:
            continue
        rows = []
        for row_number, row in enumerate(raw[1:], 2):
            cells = {}
            for index, name in enumerate(headers):
                cells[name] = {
                    "value": row[index].strip(),
                    "source": anchor(
                        spec["id"], "docx_table_cell", row_number, name, table=table_number,
                    ),
                }
            rows.append(cells)
        return {
            "kind": spec["id"], "recognition": "matched",
            "rowCount": len(rows), "rows": rows, "paragraphCount": len(doc.paragraphs),
        }
    raise ValueError(f'{spec["id"]}: expected table headers not found')


def verify_signature(path: Path, spec: dict) -> None:
    magic = path.read_bytes()[:8]
    if spec["format"] == "pdf" and not magic.startswith(b"%PDF-"):
        raise ValueError(f"{path.name}: not a PDF file")
    if spec["format"] == "docx" and not magic.startswith(b"PK"):
        raise ValueError(f"{path.name}: not a ZIP-based OOXML file")
    if path.stat().st_size > 3_000_000:
        raise ValueError("Fixture too large for this proof-of-concept")


def issue(code: str, title: str, detail: str, sources: list[dict], action: str) -> dict:
    key = code + ":" + "|".join(
        str(s["material"]) + ":" + str(s["row"]) + ":" + str(s["column"]) for s in sources
    )
    return {
        "id": "human-" + hashlib.sha256(key.encode()).hexdigest()[:12],
        "code": code,
        "title": title,
        "detail": detail,
        "sources": sources,
        "requiredAction": action,
        "assignee": "human",
        "state": "proposed",
    }


def execute(spec: dict, base: Path) -> dict:
    if spec.get("schema") != "hh.method-experiment/0":
        raise ValueError("Unsupported experimental template schema")
    parsed = {}
    source_files = []
    for material in spec["materials"]:
        path = (base / material["file"]).resolve()
        if not path.is_relative_to(base.resolve()):
            raise ValueError("Unsafe file path traversal")
        verify_signature(path, material)
        data = read_pdf(path, material) if material["format"] == "pdf" else read_docx(path, material)
        data["sourceFile"] = material["file"]
        data["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        parsed[material["id"]] = data
        source_files.append({
            "material": material["id"], "file": material["file"], "sha256": data["sha256"],
        })

    todos = []
    for material in spec["materials"]:
        for row in parsed[material["id"]]["rows"]:
            for name in material["requiredFields"]:
                cell = row[name]
                if not cell["value"]:
                    sample = row.get("sample_id", {"value": "?"})["value"]
                    todos.append(issue(
                        "required_field_missing",
                        f'补充或核对 {material["id"]} / {name}',
                        f"样品 {sample} 的 {name} 无法从原件表格提取；请核对原件或补充资料。",
                        [cell["source"]],
                        "查看原件对应表格单元格，确认准确值及其来源，或提交更完整的正式文件",
                    ))

    for rule in spec["checks"]:
        if rule["type"] != "cross_material_equal":
            raise ValueError("Unsupported check type")
        left_rows = parsed[rule["leftMaterial"]]["rows"]
        right_rows = parsed[rule["rightMaterial"]]["rows"]
        join_key, compare_key = rule["joinKey"], rule["compareKey"]
        right_index = {}
        for row in right_rows:
            key = row[join_key]["value"]
            if key in right_index:
                raise ValueError("Duplicate join key in field log: " + key)
            right_index[key] = row

        for row in left_rows:
            sample_id = row[join_key]["value"]
            other = right_index.get(sample_id)
            if other is None:
                todos.append(issue(
                    "cross_material_missing",
                    "核对缺失的现场采样记录",
                    f"检测报告包含样品 {sample_id}，但现场记录没有对应编号。",
                    [row[join_key]["source"]],
                    "核对样品唯一编号及流转记录，补全缺失的实际资料",
                ))
            elif row[compare_key]["value"] != other[compare_key]["value"]:
                todos.append(issue(
                    "cross_material_mismatch",
                    "核对采样点位编号冲突",
                    f'样品 {sample_id} 在检测报告中为 {row[compare_key]["value"]}，'
                    f'在现场采样记录中为 {other[compare_key]["value"]}；不可自动选择其一。',
                    [row[compare_key]["source"], other[compare_key]["source"]],
                    "对照原件、采样流转单与机构说明，确认正确点位映射并记录依据",
                ))
    return {
        "schema": "hh.method-result-experiment/0",
        "mode": "synthetic_fixture",
        "sources": source_files,
        "materials": parsed,
        "checks": len(spec["checks"]),
        "issues": todos,
        "humanTodoProposals": len(todos),
        "status": "needs_human_input" if todos else "checks_passed",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", default="methods.json")
    parser.add_argument("--out", default="result.json")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    spec_path = Path(args.method).resolve()
    spec = json.loads(spec_path.read_text(encoding="utf8"))
    result = execute(spec, spec_path.parent)
    Path(args.out).write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8",
    )
    if args.verify:
        codes = [x["code"] for x in result["issues"]]
        assert sorted(codes) == ["cross_material_mismatch", "required_field_missing"], codes
        assert len(result["materials"]["lab-report"]["rows"]) == 3
        assert len(result["materials"]["field-log"]["rows"]) == 3
        mismatch = next(i for i in result["issues"] if i["code"] == "cross_material_mismatch")
        assert mismatch["sources"][0]["page"] == 1
        assert mismatch["sources"][0]["bbox"][0] > 0
        assert mismatch["sources"][1]["kind"] == "docx_table_cell"
        assert "page" not in mismatch["sources"][1]
        print("PASS: two original-format files parsed; two precise Human Todo proposals")
    else:
        print(json.dumps(
            {"status": result["status"], "issues": len(result["issues"])},
            ensure_ascii=False,
        ))


if __name__ == "__main__":
    main()
