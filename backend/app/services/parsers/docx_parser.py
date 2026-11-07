"""DOCX 解析:按文档顺序读取段落与表格行,跟踪 Heading 1–6(规格 9.1、17.2)。

- 不计算物理页码;表格按"表格编号 + 行号"定位。
- ZIP 安全:解压前强制条目数、单条/总量、压缩比与路径检查。
- 不读取宏、嵌入包或外部链接内容。
"""

from __future__ import annotations

import dataclasses
import zipfile
from typing import Any

from app.api.errors import ApiError
from app.services.parsers.common import PARSER_VERSION, split_docx_item

MAX_ENTRIES = 10_000
MAX_ENTRY_BYTES = 50 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100


def validate_docx_zip(path: str) -> None:
    """DOCX 解压前强制限制(规格 17.2)。"""
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ENTRIES:
                raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED",
                               "DOCX 条目数超过 10,000 限制。", "更换文档")
            total = 0
            for info in infos:
                name = info.filename
                if name.startswith("/") or ".." in name or ":" in name:
                    raise ApiError(422, "DOCUMENT_PARSE_FAILED",
                                   "DOCX 包含非法路径条目。", "更换文档")
                if info.file_size > MAX_ENTRY_BYTES:
                    raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED",
                                   "DOCX 单条目解压后超过 50 MiB。", "更换文档")
                if info.compress_size > 0 and (
                    info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
                ):
                    raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED",
                                   "DOCX 压缩比超过 100:1,疑似压缩炸弹。", "更换文档")
                total += info.file_size
                if total > MAX_TOTAL_BYTES:
                    raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED",
                                   "DOCX 总解压后超过 200 MiB。", "更换文档")
    except zipfile.BadZipFile as exc:
        raise ApiError(422, "DOCUMENT_PARSE_FAILED", "文档无法解析,可能已损坏或格式特殊。",
                       "查看预览或更换文件") from exc


@dataclasses.dataclass
class DocxItem:
    text: str
    locator_kind: str
    locator_label: str
    heading_path: list[str]
    paragraph_index: int | None


def _heading_level(style_name: str) -> int | None:
    """识别 Heading 1–6 / 标题 1–6,返回层级;否则 None。"""
    name = (style_name or "").strip().lower()
    for marker in ("heading ", "标题"):
        if name.startswith(marker):
            digits = name[len(marker):].strip()
            if digits.isdigit():
                level = int(digits)
                if 1 <= level <= 6:
                    return level
    return None


def iter_docx_items(path: str) -> list[DocxItem]:
    """按文档顺序产出段落与表格行(规格 9.1)。"""
    validate_docx_zip(path)

    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    try:
        document = Document(path)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(422, "DOCUMENT_PARSE_FAILED", "文档无法解析,可能已损坏或格式特殊。",
                       "查看预览或更换文件") from exc

    items: list[DocxItem] = []
    heading_path: list[str] = []
    paragraph_index = 0
    table_index = 0

    body = document.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            para = Paragraph(child, document)
            text = para.text.strip()
            if not text:
                continue
            paragraph_index += 1
            level = _heading_level(para.style.name if para.style else "")
            if level is not None:
                heading_path = heading_path[: level - 1]
                heading_path.append(text)
                label = " > ".join(heading_path)
                items.append(DocxItem(text, "docx_paragraph", label,
                                      list(heading_path), paragraph_index))
            else:
                label_path = " > ".join(heading_path + [f"段落 {paragraph_index}"])
                items.append(DocxItem(text, "docx_paragraph", label_path,
                                      list(heading_path), paragraph_index))
        elif tag == "tbl":
            table_index += 1
            table = Table(child, document)
            for row_idx, row in enumerate(table.rows, start=1):
                cells = [c.text.strip() for c in row.cells]
                text = " | ".join(c for c in cells if c)
                if not text:
                    continue
                label = f"表格 {table_index} > 第 {row_idx} 行"
                items.append(DocxItem(text, "docx_table_row", label,
                                      list(heading_path), None))
    return items


def parse_docx(path: str) -> tuple[list[dict[str, Any]], None]:
    """返回 (SourceBlock dict 列表, None)。DOCX page_count 恒为 null。"""
    items = iter_docx_items(path)
    if not items:
        raise ApiError(422, "DOCUMENT_NO_TEXT", "文档没有可用于出题的文字。",
                       "更换文档或先完成 OCR")
    blocks: list[dict[str, Any]] = []
    for item in items:
        blocks.extend(
            split_docx_item(
                item.text, item.locator_kind, item.locator_label,
                item.heading_path, item.paragraph_index,
            )
        )
    return blocks, None


__all__ = ["parse_docx", "iter_docx_items", "validate_docx_zip", "PARSER_VERSION"]
