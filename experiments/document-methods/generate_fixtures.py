"""Generate two fully synthetic PDF/DOCX fixtures for the isolated method experiment."""
from pathlib import Path
from docx import Document
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

BASE = Path(__file__).parent / "fixtures"
BASE.mkdir(parents=True, exist_ok=True)

doc = Document()
doc.add_heading("现场采样记录 / Field Sampling Log", 0)
doc.add_paragraph("合成测试文件 / SYNTHETIC FIXTURE. 非真实检测或现场采样资料。")
doc.add_paragraph("记录编号: FIELD-2026-001")
doc.add_paragraph("采样日期: 2026-10-30")
table = doc.add_table(rows=1, cols=3)
table.style = "Table Grid"
for cell, x in zip(table.rows[0].cells, ["sample_id", "point_id", "sample_date"]):
    cell.text = x
for row in [
    ("S-001", "P-01", "2026-10-30"),
    ("S-002", "P-02", "2026-10-30"),
    ("S-003", "P-03", "2026-10-30"),
]:
    cells = table.add_row().cells
    for cell, value in zip(cells, row):
        cell.text = value
doc.add_paragraph("注：本文件用于验证表格提取与跨报告核对，不得用于实际项目。")
doc.save(BASE / "field-log.docx")

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
c = canvas.Canvas(str(BASE / "lab-report.pdf"), pagesize=A4)
width, height = A4
c.setFont("STSong-Light", 17)
c.drawString(48, height - 68, "检测报告 / Laboratory Results")
c.setFont("STSong-Light", 10)
c.drawString(48, height - 96, "合成测试文件 / SYNTHETIC FIXTURE. 非真实检测报告。")
c.setFont("Helvetica", 10)
c.drawString(48, height - 127, "Report ID: LAB-2026-001")
c.drawString(48, height - 145, "Issuer: Demo Testing Laboratory")
c.drawString(48, height - 163, "Issue Date: 2026-11-01")

data = [
    ["sample_id", "point_id", "analyte", "result", "unit"],
    ["S-001", "P-01", "As", "8.2", "mg/kg"],
    ["S-002", "P-09", "As", "12.5", "mg/kg"],  # Deliberate point mismatch.
    ["S-003", "P-03", "As", "4.1", ""],       # Deliberate missing unit.
]
t = Table(data, colWidths=[90, 92, 85, 80, 90], rowHeights=[28, 28, 28, 28])
t.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.7, HexColor("#777777")),
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#eeeeee")),
    ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 10),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
]))
t.wrapOn(c, width, height)
t.drawOn(c, 48, height - 320)
c.setFont("Helvetica", 8)
c.drawString(48, 54, "SYNTHETIC QA FIXTURE - NOT A VALID LAB REPORT")
c.save()
print("Created synthetic source files:", *(p.name for p in BASE.iterdir()))
