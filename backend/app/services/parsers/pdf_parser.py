"""PDF 解析:pypdfium2 逐页提取,保留 1-based 页码(规格 9.1、17.2)。

- 扫描件判定:≥80% 页面少于 20 个非空白可打印字符,且这些低文本页至少含一个图像对象。
- 纯空白 → DOCUMENT_NO_TEXT;加密 → DOCUMENT_ENCRYPTED。
- 硬限制:500 页、2,000,000 字符、单任务 120 秒。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pypdfium2 as pdfium

from app.api.errors import ApiError
from app.services.parsers.common import PARSER_VERSION, split_pdf_page

PRINTABLE_MIN = 20
SCANNED_RATIO = 0.8


@dataclass
class PageText:
    page_number: int
    text: str


def parse_pdf(path: str) -> tuple[list[dict[str, Any]], int]:
    """返回 (SourceBlock dict 列表, 页数)。解析失败抛 ApiError。"""
    try:
        doc = pdfium.PdfDocument(path)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "password" in msg.lower() or "encrypt" in msg.lower():
            raise ApiError(422, "DOCUMENT_ENCRYPTED", "文档已加密,无法解析。",
                           "解除密码后重试") from exc
        raise ApiError(422, "DOCUMENT_PARSE_FAILED", "文档无法解析,可能已损坏或格式特殊。",
                       "查看预览或更换文件") from exc

    page_count = len(doc)
    if page_count > 500:
        raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED", "文档超过 500 页限制。",
                       "拆分文档后重试")

    pages: list[PageText] = []
    low_text_pages = 0
    low_text_with_image = 0
    total_chars = 0

    try:
        for i in range(page_count):
            page = doc[i]
            textpage = page.get_textpage()
            text = textpage.get_text_range() or ""
            printable = sum(
                1 for ch in text if not ch.isspace() and ch.isprintable()
            )
            if printable < PRINTABLE_MIN:
                low_text_pages += 1
                if _page_has_image(page):
                    low_text_with_image += 1
            total_chars += len(text)
            if total_chars > 2_000_000:
                raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED",
                               "文档文本量超过 2,000,000 字符限制。", "拆分文档后重试")
            pages.append(PageText(page_number=i + 1, text=text))
    finally:
        doc.close()

    if page_count > 0 and low_text_pages / page_count >= SCANNED_RATIO:
        if low_text_with_image >= 1:
            raise ApiError(422, "SCANNED_PDF_UNSUPPORTED",
                           "检测到扫描件,当前版本不支持 OCR。", "先用受信任工具完成 OCR")
        if all(not p.text.strip() for p in pages):
            raise ApiError(422, "DOCUMENT_NO_TEXT", "文档没有可用于出题的文字。",
                           "更换文档或先完成 OCR")

    blocks: list[dict[str, Any]] = []
    for page in pages:
        page_blocks = split_pdf_page(page.text, f"第 {page.page_number} 页",
                                     page.page_number)
        if page_blocks:
            blocks.extend(page_blocks)
        elif not any(b["page_number"] == page.page_number for b in blocks):
            continue
    if not blocks:
        raise ApiError(422, "DOCUMENT_NO_TEXT", "文档没有可用于出题的文字。",
                       "更换文档或先完成 OCR")
    return blocks, page_count


def _page_has_image(page) -> bool:  # type: ignore[no-untyped-def]
    try:
        for obj in page.get_objects():
            if obj.type == pdfium.raw.FPDF_PAGEOBJ_IMAGE:
                return True
    except Exception:  # noqa: BLE001
        return False
    return False


__all__ = ["parse_pdf", "PARSER_VERSION"]
