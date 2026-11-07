"""单元测试:解析器与 SourceBlock 确定性切分(规格 9.1、9.2、21.2-1/2/3)。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.api.errors import ApiError
from app.services.parsers.common import (
    PARSER_VERSION,
    estimate_tokens,
    split_docx_item,
    split_pdf_page,
)
from app.services.parsers.docx_parser import parse_docx
from app.services.parsers.pdf_parser import parse_pdf

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"

EXPECTED = json.loads((FIXTURES / "expected_source_blocks.json").read_text(encoding="utf-8"))


def test_policy_pdf_stable_blocks():
    blocks, pages = parse_pdf(str(FIXTURES / "policy_text.pdf"))
    expected = EXPECTED["policy_text.pdf"]
    assert pages == expected["page_count"] == 5
    assert len(blocks) == len(expected["blocks"])
    for got, want in zip(blocks, expected["blocks"], strict=True):
        assert got["locator_kind"] == want["locator_kind"]
        assert got["locator_label"] == want["locator_label"]
        assert got["page_number"] == want["page_number"]
        assert got["text_sha256"] == want["text_sha256"]
        assert got["estimated_tokens"] == want["estimated_tokens"]


def test_pdf_page_numbers_are_one_based():
    blocks, _ = parse_pdf(str(FIXTURES / "policy_text.pdf"))
    assert [b["page_number"] for b in blocks] == [1, 2, 3, 4, 5]


def test_docx_stable_blocks_and_no_page_number():
    blocks, _ = parse_docx(str(FIXTURES / "policy_text.docx"))
    expected = EXPECTED["policy_text.docx"]
    assert len(blocks) == len(expected["blocks"])
    for got, want in zip(blocks, expected["blocks"], strict=True):
        assert got["locator_kind"] == want["locator_kind"]
        assert got["locator_label"] == want["locator_label"]
        assert got["page_number"] is None


def test_docx_heading_path_tracked():
    blocks, _ = parse_docx(str(FIXTURES / "policy_text.docx"))
    table_rows = [b for b in blocks if b["locator_kind"] == "docx_table_row"]
    assert table_rows, "应有表格行块"
    assert "表格 1" in table_rows[0]["locator_label"]
    paragraph = next(b for b in blocks if b["text"].startswith("第五条"))
    assert paragraph["heading_path"] == ["第二章 组织机构与职责"]


def test_scanned_pdf_rejected():
    with pytest.raises(ApiError) as exc:
        parse_pdf(str(FIXTURES / "scanned.pdf"))
    assert exc.value.code == "SCANNED_PDF_UNSUPPORTED"


def test_encrypted_pdf_rejected():
    with pytest.raises(ApiError) as exc:
        parse_pdf(str(FIXTURES / "encrypted.pdf"))
    assert exc.value.code == "DOCUMENT_ENCRYPTED"


def test_corrupt_docx_rejected():
    with pytest.raises(ApiError) as exc:
        parse_docx(str(FIXTURES / "corrupt.docx"))
    assert exc.value.code == "DOCUMENT_PARSE_FAILED"


def test_prompt_injection_pdf_parses_as_data():
    blocks, _ = parse_pdf(str(FIXTURES / "prompt_injection.pdf"))
    assert blocks, "注入文本作为数据解析,不影响流程"


def test_presplit_over_800_chars():
    text = "第一句内容比较长包含很多字符。" * 60  # >800 字符
    assert len(text) > 800
    blocks = split_docx_item(text, "docx_paragraph", "测试段落", None, 1)
    assert len(blocks) > 1
    for block in blocks:
        assert len(block["text"]) <= 800
    labels = [b["locator_label"] for b in blocks]
    assert any("片段" in label for label in labels)


def test_pdf_merge_under_800_and_tail_merge():
    page = "短段落一。\n\n短段落二。\n\n短段落三。"
    blocks = split_pdf_page(page, "第 1 页", 1)
    assert len(blocks) == 1, "短段落应贪心合并"
    assert "短段落一" in blocks[0]["text"]


def test_normalized_text_only_in_normalized_field():
    blocks = split_docx_item("原文  含  空白", "docx_paragraph", "段落 1", None, 1)
    assert blocks[0]["text"] == "原文  含  空白"
    assert blocks[0]["normalized_text"] == "原文含空白"


def test_estimate_tokens_cjk_formula():
    assert estimate_tokens("中文") == 2
    assert estimate_tokens("abcd") == 1  # ceil(4/4)
    assert estimate_tokens("abc") == 1  # ceil(3/4)


def test_parser_version_constant():
    assert PARSER_VERSION == "1.1.0"
