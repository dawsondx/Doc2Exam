"""程序校验:只做可确定执行的结构和出处判断(规格 11)。

输出稳定错误码与 severity:blocking → validation_state=failed;
warning 展示但不阻断。语义正确性由人工复核,程序不伪装成结论。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

FORBIDDEN_OPTION_TEXT = ("以上都对", "以上都错", "以上均对", "以上均错", "以上都是", "以上都不是")
FORBIDDEN_STEM_HINTS = ("请选择", "以下哪项", "以下哪一项", "以下哪些")
TRUE_FALSE_ANSWERS = ("正确", "错误")
BLANK_MARKER = "____"


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    return re.sub(r"\s+", "", value)


@dataclass
class ValidationReport:
    blocking: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.blocking

    def issue(self, code: str, message: str, severity: str = "blocking") -> None:
        item = {"code": code, "message": message, "severity": severity}
        if severity == "blocking":
            self.blocking.append(item)
        else:
            self.warnings.append(item)

    def all_issues(self) -> list[dict[str, Any]]:
        return self.blocking + self.warnings


def _common_checks(
    report: ValidationReport,
    *,
    stem: str | None,
    explanation: str | None,
    point_content: str,
    block_text: str,
) -> None:
    if stem is None or not 8 <= len(stem.strip()) <= 500:
        report.issue("STEM_INVALID", "题干必须为 8–500 个字符。")
    if explanation is None or not 5 <= len(explanation.strip()) <= 1000:
        report.issue("EXPLANATION_INVALID", "解析必须为 5–1000 个字符。")

    # 关键数字/专名不在考点或原文中 → 质量警告(不阻断)
    numbers = set(re.findall(r"\d+(?:\.\d+)?", f"{stem or ''}"))
    context = normalize(point_content + block_text)
    foreign = [n for n in numbers if n not in context]
    if foreign:
        report.issue(
            "POSSIBLE_UNSUPPORTED_FACT",
            f"题干中的数字 {','.join(foreign[:5])} 未出现在考点或原文中,请人工确认。",
            severity="warning",
        )


def validate_single_choice(
    *,
    stem: str | None,
    options: list[str] | None,
    answer_content: str,
    explanation: str | None,
    point_content: str,
    block_text: str,
) -> ValidationReport:
    report = ValidationReport()
    _common_checks(report, stem=stem, explanation=explanation,
                   point_content=point_content, block_text=block_text)

    opts = [o.strip() for o in (options or [])]
    if len(opts) != 4 or any(not o for o in opts):
        report.issue("OPTIONS_INVALID", "必须恰好 4 个非空选项。")
        return report
    normalized = [normalize(o) for o in opts]
    if len(set(normalized)) != 4:
        report.issue("OPTIONS_DUPLICATED", "选项归一化后不得重复。")
    for opt in opts:
        if any(fb in opt for fb in FORBIDDEN_OPTION_TEXT):
            report.issue("OPTION_FORBIDDEN", "禁止“以上都对/以上都错”类选项。")
            break
    lengths = sorted(len(o) for o in opts)
    if lengths[-1] > max(1, int(lengths[0] * 1.8)) and lengths[-1] - lengths[0] > 4:
        if lengths[0] > 0 and lengths[-1] / lengths[0] > 1.8:
            report.issue("OPTIONS_LENGTH_IMBALANCE",
                         "最长与最短选项字符数之比超过 1.8。")
    matches = [i for i, o in enumerate(opts) if normalize(o) == normalize(answer_content)]
    if len(matches) != 1:
        report.issue("ANSWER_NOT_UNIQUE",
                     "answer_content 必须恰好匹配一个选项。")
    return report


def validate_true_false(
    *,
    stem: str | None,
    answer: str | None,
    target_answer: bool | None,
    explanation: str | None,
    point_content: str,
    block_text: str,
) -> ValidationReport:
    report = ValidationReport()
    _common_checks(report, stem=stem, explanation=explanation,
                   point_content=point_content, block_text=block_text)
    if answer not in TRUE_FALSE_ANSWERS:
        report.issue("ANSWER_INVALID", "判断题答案只能为“正确”或“错误”。")
        return report
    if target_answer is not None:
        expected = "正确" if target_answer else "错误"
        if answer != expected:
            report.issue("ANSWER_TARGET_MISMATCH",
                         f"答案必须与预分配目标一致(目标:{expected})。")
    if stem:
        if any(h in stem for h in FORBIDDEN_STEM_HINTS):
            report.issue("STEM_NOT_STATEMENT", "判断题题干必须是陈述句。")
        if stem.strip().endswith("?") or stem.strip().endswith("?"):
            report.issue("STEM_NOT_STATEMENT", "判断题题干必须是陈述句。")
    if answer == "错误" and explanation and len(explanation.strip()) < 5:
        report.issue("EXPLANATION_INVALID", "错误题解析必须给出正确表述。")
    return report


def validate_fill_blank(
    *,
    stem: str | None,
    answer: str | None,
    acceptable_answers: list[str] | None,
    explanation: str | None,
    point_content: str,
    block_text: str,
) -> ValidationReport:
    report = ValidationReport()
    _common_checks(report, stem=stem, explanation=explanation,
                   point_content=point_content, block_text=block_text)

    if stem is None or stem.count(BLANK_MARKER) != 1:
        report.issue("BLANK_COUNT_INVALID", "填空题题干必须恰好包含一个 ____。")
        return report
    if answer is None or not answer.strip():
        report.issue("ANSWER_INVALID", "填空答案不能为空。")
        return report

    normalized_block = normalize(block_text)
    if normalize(answer) not in normalized_block:
        report.issue("ANSWER_NOT_IN_SOURCE", "填空答案必须逐字出现在原文中。")

    hollowed = stem.replace(BLANK_MARKER, "")
    if normalize(answer) and normalize(answer) in normalize(hollowed):
        report.issue("ANSWER_LEAKED_IN_STEM", "挖空后的题干不得残留答案原文。")

    cleaned = []
    for alt in acceptable_answers or []:
        alt = (alt or "").strip()
        if alt and alt not in cleaned:
            cleaned.append(alt)
    if any((alt or "").strip() == "" for alt in (acceptable_answers or [])):
        report.issue("ACCEPTABLE_ANSWERS_INVALID", "同义答案不得包含空字符串。")
    return report


def normalize_options_dedupe(options: list[str]) -> list[str]:
    return [o.strip() for o in options if o and o.strip()]
