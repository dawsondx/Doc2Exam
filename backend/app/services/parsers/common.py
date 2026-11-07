"""SourceBlock 确定性切分(规格 9.2)。

同一 parser_version 对同一夹具必须产生相同边界:
- 预切分:超过 800 字符的正文项在句末符号处切分;无句末则在第 800 个字符硬切。
- PDF 不跨页:按空行分段→预切分→贪心合并(≤800);页尾块 <200 字符并入前块(上限 1000)。
- DOCX:每个非空正文项独立成块,不跨项合并。
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from typing import Any

PARSER_VERSION = "1.1.0"

SOFT_LIMIT = 800
TAIL_MERGE_THRESHOLD = 200
ABSOLUTE_MAX = 1000

_SENTENCE_END = "。!?;.!?"
_BLANK_LINE = re.compile(r"\n[ \t]*\n")


def normalize_text(value: str) -> str:
    """空白规范化:仅写入 normalized_text,text 保留原字符。"""
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r"\s+", "", value)
    return value.strip()


def estimate_tokens(text: str) -> int:
    """保守估算:CJK 字符数 + ceil(其他字符数 / 4)(规格 9.2)。"""
    cjk = sum(1 for ch in text if unicodedata.east_asian_width(ch) in ("W", "F"))
    others = len(text) - cjk
    return cjk + math.ceil(others / 4)


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _presplit(text: str) -> list[str]:
    """预切分:单一正文项超过 800 字符时按句末切分,否则原样返回。"""
    if len(text) <= SOFT_LIMIT:
        return [text]
    pieces: list[str] = []
    rest = text
    while len(rest) > SOFT_LIMIT:
        window = rest[:SOFT_LIMIT]
        cut = -1
        for i in range(len(window) - 1, -1, -1):
            if window[i] in _SENTENCE_END:
                cut = i + 1
                break
        if cut <= 0:
            cut = SOFT_LIMIT
        pieces.append(rest[:cut])
        rest = rest[cut:]
    if rest:
        pieces.append(rest)
    return pieces


def split_pdf_page(page_text: str, base_label: str,
                   page_number: int) -> list[dict[str, Any]]:
    """PDF 单页切分:空行分段 → 预切分 → 贪心合并 → 页尾短块并入前块。"""
    paragraphs = [p.strip("\n") for p in _BLANK_LINE.split(page_text)]
    paragraphs = [re.sub(r"\s*\n\s*", " ", p).strip() for p in paragraphs]
    paragraphs = [p for p in paragraphs if p]
    if not paragraphs:
        return []

    fragments: list[tuple[str, int]] = []  # (text, 片段序号;0 表示未编号)
    for para in paragraphs:
        pieces = _presplit(para)
        for idx, piece in enumerate(pieces, start=1):
            fragments.append((piece, idx if len(pieces) > 1 else 0))

    merged: list[tuple[str, int]] = []
    for text, frag in fragments:
        if merged and len(merged[-1][0]) + len(text) <= SOFT_LIMIT:
            merged[-1] = (merged[-1][0] + " " + text, merged[-1][1])
        else:
            merged.append((text, frag))

    if len(merged) >= 2 and 0 < len(merged[-1][0]) < TAIL_MERGE_THRESHOLD:
        last = merged.pop()
        merged[-1] = (merged[-1][0] + " " + last[0], merged[-1][1])

    blocks: list[dict[str, Any]] = []
    for text, frag in merged:
        label = base_label if frag == 0 else f"{base_label} 片段 {frag}"
        blocks.append(_block(text, "pdf_page", label, page_number))
    return blocks


def split_docx_item(text: str, locator_kind: str, base_label: str,
                    heading_path: list[str] | None,
                    paragraph_index: int | None) -> list[dict[str, Any]]:
    """DOCX 单正文项切分:预切分后各自成块,不跨项合并。"""
    pieces = _presplit(text)
    blocks: list[dict[str, Any]] = []
    for idx, piece in enumerate(pieces, start=1):
        label = base_label if len(pieces) == 1 else f"{base_label} 片段 {idx}"
        blocks.append(
            _block(piece, locator_kind, label, None, heading_path, paragraph_index)
        )
    return blocks


def _block(
    text: str,
    locator_kind: str,
    label: str,
    page_number: int | None,
    heading_path: list[str] | None = None,
    paragraph_index: int | None = None,
) -> dict[str, Any]:
    return {
        "locator_kind": locator_kind,
        "locator_label": label,
        "page_number": page_number,
        "heading_path": heading_path,
        "paragraph_index": paragraph_index,
        "text": text,
        "normalized_text": normalize_text(text),
        "estimated_tokens": estimate_tokens(text),
        "text_sha256": text_sha256(text),
    }
