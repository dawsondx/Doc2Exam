"""Word 导出:docxtpl 真实模板 + 双版本生成与校验(规格 15)。

- 两个临时文件全部生成并校验成功后,才一起移动到最终路径并写入记录。
- 任一失败不产生半套新导出,不覆盖历史成功批次。
- 填空下划线:RichText 空白片段 + underline + eastAsia 微软雅黑。
"""

from __future__ import annotations

import hashlib
import logging
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app import config
from app.api.errors import ApiError
from app.db.engine import get_session_factory, utcnow
from app.models import (
    Document,
    Export,
    ExportKind,
    Question,
    QuizRecord,
    QuizRecordDocument,
    QuizStatus,
    SourceBlock,
)

logger = logging.getLogger("ai_quiz")

SECTION_TITLES = (
    ("single_choice", "一、单选题"),
    ("true_false", "二、判断题"),
    ("fill_blank", "三、填空题"),
)

BLANK = "____"

UNDERLINE_SPACES = " " * 10


@dataclass
class ExportResult:
    student: dict[str, Any]
    answer: dict[str, Any]


def check_export_gate(session, quiz: QuizRecord) -> None:  # type: ignore[no-untyped-def]
    """导出门槛(规格 4.3)。"""
    questions = (
        session.query(Question)
        .filter(Question.quiz_record_id == quiz.id)
        .order_by(Question.slot_number)
        .all()
    )
    config_counts = {k: quiz.question_config.get(k, 0) for k in
                     ("single_choice", "true_false", "fill_blank")}
    expected_total = sum(config_counts.values())
    if len(questions) != expected_total:
        missing = expected_total - sum(1 for q in questions if q.validation_state == "passed")
        raise ApiError(409, "EXPORT_NOT_READY",
                       f"题目数量与配置不一致,还缺 {max(missing, 1)} 题。",
                       "返回复核")
    actual: dict[str, int] = {"single_choice": 0, "true_false": 0, "fill_blank": 0}
    for q in questions:
        actual[q.question_type.value] += 1
    if actual != config_counts:
        raise ApiError(409, "EXPORT_NOT_READY", "题型数量与配置不一致。", "返回复核")
    for q in questions:
        if q.validation_state != "passed" or q.review_state != "approved":
            missing = sum(
                1 for x in questions
                if x.validation_state != "passed" or x.review_state != "approved"
            )
            raise ApiError(409, "EXPORT_NOT_READY",
                           f"还有题目未通过校验或人工复核,还缺 {missing} 题。",
                           "返回复核")


def _build_context(session: Session, quiz: QuizRecord, *,
                   show_answers: bool) -> dict[str, Any]:

    documents = (
        session.query(QuizRecordDocument)
        .filter(QuizRecordDocument.quiz_record_id == quiz.id)
        .order_by(QuizRecordDocument.ordinal)
        .all()
    )
    source_names = []
    for rel in documents:
        document = session.get(Document, rel.document_id)
        if document:
            source_names.append(document.original_name)

    questions = (
        session.query(Question)
        .filter(Question.quiz_record_id == quiz.id)
        .order_by(Question.slot_number)
        .all()
    )
    sections = []
    counter = 0
    for qtype, title in SECTION_TITLES:
        items = []
        for q in questions:
            if q.question_type.value != qtype:
                continue
            counter += 1
            stem_rt = _stem_richtext(q)
            options = []
            if qtype == "single_choice":
                for i, opt in enumerate(q.options or []):
                    options.append(f"{config_abcd(i)}. {opt}")
            item: dict[str, Any] = {
                "number": counter,
                "stem": stem_rt,
                "options": options,
            }
            if show_answers:
                block = session.get(SourceBlock, q.source_block_id)
                if qtype == "single_choice":
                    answer_line = q.answer or ""
                elif qtype == "true_false":
                    answer_line = q.answer or ""
                else:
                    answer_line = q.answer or ""
                    if q.acceptable_answers:
                        answer_line += "(可接受:" + "、".join(q.acceptable_answers) + ")"
                item.update({
                    "answer_line": answer_line,
                    "explanation": q.explanation or "",
                    "source_label": (
                        f"{_document_name(source_names, session, block)} · "
                        f"{block.locator_label}" if block else ""
                    ),
                    "source_text": block.text if block else "",
                })
            items.append(item)
        if items:
            sections.append({"title": title, "questions": items})

    return {
        "title": "AI出题精灵 - 试题" if not show_answers else "AI出题精灵 - 试题(答案版)",
        "date": utcnow().strftime("%Y年%m月%d日"),
        "sources": "、".join(source_names),
        "sections": sections,
        "show_answers": show_answers,
        "name_field": "姓名:____________",
        "dept_field": "部门:____________",
    }


def _document_name(names: list[str], session, block) -> str:  # type: ignore[no-untyped-def]
    if block is None:
        return ""
    document = session.get(Document, block.document_id)
    return document.original_name if document else ""


def config_abcd(i: int) -> str:
    return "ABCD"[i]


def _stem_richtext(question: Question):  # type: ignore[no-untyped-def]
    """题干 RichText:填空题把 ____ 替换为带下划线的 10 个空格(规格 15.4)。

    空白片段使用 docxtpl 区域字体语法 font="eastAsia:微软雅黑" 明确东亚字体,
    普通文本继承模板样式,不做全文字体覆盖。
    """
    from docxtpl import RichText

    rt = RichText()
    stem = question.stem or ""
    if question.question_type.value != "fill_blank" or BLANK not in stem:
        rt.add(stem)
        return rt
    parts = stem.split(BLANK)
    for i, part in enumerate(parts):
        if part:
            rt.add(part)
        if i < len(parts) - 1:
            rt.add(UNDERLINE_SPACES, underline=True, font="eastAsia:微软雅黑")
    return rt


def _safe_download_name(base: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "_", base).strip()
    return cleaned[:120] or "export"


def _docx_full_text(path: Path) -> str:
    """提取全部 w:t 文本并拼接(含 RichText 生成的 SDT 内容)。"""
    import re
    import zipfile

    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    return "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml))


def _verify_export(path: Path, quiz: QuizRecord, *, show_answers: bool,
                   context: dict[str, Any]) -> None:
    """用 python-docx 重新打开并校验(规格 15.5)。"""
    from docx import Document as DocxDocument

    doc = DocxDocument(str(path))
    full_text = _docx_full_text(path)
    _ = doc

    expected_total = sum(
        quiz.question_config.get(k, 0) for k in ("single_choice", "true_false", "fill_blank")
    )
    section_questions = [q for s in context["sections"] for q in s["questions"]]
    if len(section_questions) != expected_total:
        raise ApiError(500, "EXPORT_FAILED", "导出题目数量与试卷不一致。",
                       "查看错误并重试")

    has_chinese = bool(re.search(r"[\u4e00-\u9fff]", full_text))
    if not has_chinese:
        raise ApiError(500, "EXPORT_FAILED", "导出缺少中文内容。", "查看错误并重试")

    for q in section_questions:
        marker = f"{q['number']}."
        if marker not in full_text:
            raise ApiError(500, "EXPORT_FAILED",
                           f"题号 {q['number']} 缺失。", "查看错误并重试")

    if "SENTINEL-" in full_text:
        raise ApiError(500, "EXPORT_FAILED", "导出文件包含内部校验标记。",
                       "查看错误并重试")
    if not show_answers:
        for keyword in ("答案", "解析", "出处"):
            if keyword in full_text:
                raise ApiError(500, "EXPORT_FAILED",
                               f"题目版不应包含{keyword}。", "查看错误并重试")
    else:
        for label in ("答案:", "解析:", "出处:", "原文:"):
            if full_text.count(label) < expected_total:
                raise ApiError(500, "EXPORT_FAILED",
                               f"答案版缺少完整的{label[:-1]}字段。",
                               "查看错误并重试")
        answered = 0
        for q in section_questions:
            if q.get("answer_line") and q["answer_line"].split("(")[0] in full_text:
                answered += 1
        if answered < expected_total:
            raise ApiError(500, "EXPORT_FAILED", "答案版缺少答案内容。",
                           "查看错误并重试")


def generate_exports(quiz_record_id: str) -> ExportResult:
    """生成双版本 Word:先临时文件,全部校验通过后一起转正(规格 7.7、15.5)。"""
    session = get_session_factory()()
    batch_id = str(uuid.uuid4())
    temp_files: list[tuple[Path, Path]] = []
    try:
        quiz = session.get(QuizRecord, quiz_record_id)
        if quiz is None:
            raise ApiError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表")
        check_export_gate(session, quiz)

        from docxtpl import DocxTemplate

        template_path = config.BACKEND_DIR / "app" / "templates" / "quiz_template.docx"
        if not template_path.exists():
            raise ApiError(500, "EXPORT_FAILED", "Word 模板缺失。",
                           "重新运行 setup.ps1")

        date_str = utcnow().strftime("%Y%m%d")
        results: list[dict[str, Any]] = []
        for kind, show_answers in (
            (ExportKind.student, False),
            (ExportKind.answer, True),
        ):
            context = _build_context(session, quiz, show_answers=show_answers)
            tpl = DocxTemplate(str(template_path))
            tpl.render(context, autoescape=True)
            temp_path = config.TEMP_DIR / f"export-{batch_id}-{kind.value}.docx"
            tpl.save(str(temp_path))
            _verify_export(temp_path, quiz, show_answers=show_answers, context=context)
            final_name = f"{uuid.uuid4()}.docx"
            final_path = config.EXPORTS_DIR / final_name
            temp_files.append((temp_path, final_path))
            results.append({
                "kind": kind,
                "temp": temp_path,
                "final": final_path,
                "stored_name": final_name,
                "size": temp_path.stat().st_size,
                "download_name": _safe_download_name(
                    f"AI出题精灵_{date_str}_"
                    f"{'题目版' if kind == ExportKind.student else '答案版'}.docx"
                ),
            })

        # 全部校验通过:先写库拿 ID,再移动文件,保证不出现半套导出
        export_rows: dict[str, Export] = {}
        for r in results:
            row = Export(
                export_batch_id=batch_id,
                quiz_record_id=quiz.id,
                kind=r["kind"],
                stored_name=r["stored_name"],
                download_name=r["download_name"],
                sha256=hashlib.sha256(r["temp"].read_bytes()).hexdigest(),
                size_bytes=r["temp"].stat().st_size,
                is_current=True,
            )
            session.add(row)
            export_rows[r["kind"]] = row
        session.flush()
        session.query(Export).filter(
            Export.quiz_record_id == quiz.id,
            Export.export_batch_id != batch_id,
        ).update({"is_current": False}, synchronize_session=False)
        quiz.status = QuizStatus.exported
        session.commit()

        for temp_path, final_path in temp_files:
            shutil.move(str(temp_path), str(final_path))

        return ExportResult(
            student=_export_dto(export_rows[ExportKind.student]),
            answer=_export_dto(export_rows[ExportKind.answer]),
        )
    except ApiError:
        session.rollback()
        for temp_path, _ in temp_files:
            temp_path.unlink(missing_ok=True)
        raise
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        for temp_path, _ in temp_files:
            temp_path.unlink(missing_ok=True)
        logger.exception("导出失败:%s", type(exc).__name__)
        raise ApiError(500, "EXPORT_FAILED", "Word 生成失败,题目数据仍已保存。",
                       "查看错误并重试") from exc
    finally:
        session.close()


def _export_dto(row: Export) -> dict[str, Any]:
    return {
        "id": row.id,
        "filename": row.download_name,
        "download_url": f"/api/exports/{row.id}/download",
    }
