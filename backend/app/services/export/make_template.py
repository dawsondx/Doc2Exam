"""生成 quiz_template.docx 真实模板(规格 15.1)。

以 python-docx 建立样式与 Jinja 标签段落,产物提交版本控制;
模板样式:标题、一级题型标题、题干、选项、答案、解析、出处,中文微软雅黑。
运行:uv run --project backend python -m app.services.export.make_template
"""

from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn
from docx.shared import Pt

TEMPLATE_PATH = (
    Path(__file__).resolve().parent.parent.parent / "templates" / "quiz_template.docx"
)

STYLE_SPECS = [
    ("QTitle", "AI出题精灵标题", 18, True),
    ("QMeta", "试题元信息", 10.5, False),
    ("QSectionHeading", "一级题型标题", 14, True),
    ("QStem", "题干", 11, False),
    ("QOption", "选项", 11, False),
    ("QAnswer", "答案", 11, True),
    ("QExplanation", "解析", 10.5, False),
    ("QSource", "出处", 10, False),
    ("QSourceText", "出处原文", 10, False),
]


def _set_style_font(style, size: float, bold: bool) -> None:  # type: ignore[no-untyped-def]
    style.font.name = "微软雅黑"
    style.font.size = Pt(size)
    style.font.bold = bold
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), "微软雅黑")
    rfonts.set(qn("w:ascii"), "微软雅黑")
    rfonts.set(qn("w:hAnsi"), "微软雅黑")


def build_template() -> Path:
    document = Document()

    for name, _label, size, bold in STYLE_SPECS:
        style = document.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        style.base_style = document.styles["Normal"]
        _set_style_font(style, size, bold)
        style.quick_style = True

    def add(text: str, style_name: str) -> None:
        document.add_paragraph(text, style=document.styles[style_name])

    def add_runs(runs: list[str], style_name: str) -> None:
        """多 run 段落:RichText 标签必须独占一个 run,避免整段被替换。"""
        paragraph = document.add_paragraph(style=document.styles[style_name])
        for text in runs:
            paragraph.add_run(text)

    add("{{ title }}", "QTitle")
    add("生成日期:{{ date }}", "QMeta")
    add("来源文件:{{ sources }}", "QMeta")
    add("{{ name_field }}\u3000\u3000{{ dept_field }}", "QMeta")

    add("{%p for section in sections %}", "QMeta")
    add("{{ section.title }}", "QSectionHeading")
    add("{%p for q in section.questions %}", "QMeta")
    add_runs(["{{ q.number }}. ", "{{ q.stem }}"], "QStem")
    add("{%p for opt in q.options %}", "QOption")
    add("{{ opt }}", "QOption")
    add("{%p endfor %}", "QOption")
    add("{%p if show_answers %}", "QAnswer")
    add("答案:{{ q.answer_line }}", "QAnswer")
    add("解析:{{ q.explanation }}", "QExplanation")
    add("出处:{{ q.source_label }}", "QSource")
    add("原文:{{ q.source_text }}", "QSourceText")
    add("{%p endif %}", "QAnswer")
    add("{%p endfor %}", "QStem")
    add("{%p endfor %}", "QSectionHeading")

    TEMPLATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(TEMPLATE_PATH))
    return TEMPLATE_PATH


if __name__ == "__main__":
    path = build_template()
    print(f"template written: {path}")
