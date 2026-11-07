import type { ValidationIssue } from "../types/api";
import { normalizeText } from "./text";

const FORBIDDEN_OPTION_TEXT = ["以上都对", "以上都错", "以上均对", "以上均错", "以上都是", "以上都不是"];
const FORBIDDEN_STEM_HINTS = ["请选择", "以下哪项", "以下哪一项", "以下哪些"];
const TRUE_FALSE_ANSWERS = ["正确", "错误"];
const BLANK_MARKER = "____";

export interface ValidationInput {
  question_type: "single_choice" | "true_false" | "fill_blank";
  stem: string | null;
  options: string[] | null;
  answer: string | null;
  answer_content?: string | null;
  acceptable_answers: string[] | null;
  explanation: string | null;
  target_answer?: boolean | null;
  point_content: string;
  block_text: string;
}

export interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
}

function commonIssues(
  issues: ValidationIssue[],
  warnings: ValidationIssue[],
  input: ValidationInput,
) {
  const stem = input.stem ?? "";
  if (stem.trim().length < 8 || stem.trim().length > 500) {
    issues.push({ code: "STEM_INVALID", message: "题干必须为 8–500 个字符。", severity: "blocking" });
  }
  const explanation = input.explanation ?? "";
  if (explanation.trim().length < 5 || explanation.trim().length > 1000) {
    issues.push({ code: "EXPLANATION_INVALID", message: "解析必须为 5–1000 个字符。", severity: "blocking" });
  }
  const numbers = stem.match(/\d+(?:\.\d+)?/g) ?? [];
  const context = normalizeText(input.point_content + input.block_text);
  const foreign = numbers.filter((number) => !context.includes(number));
  if (foreign.length) {
    warnings.push({
      code: "POSSIBLE_UNSUPPORTED_FACT",
      message: `题干中的数字 ${foreign.slice(0, 5).join("、")} 未出现在考点或原文中，请人工确认。`,
      severity: "warning",
    });
  }
}

export function validateQuestion(input: ValidationInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  commonIssues(issues, warnings, input);

  if (input.question_type === "single_choice") {
    const options = (input.options ?? []).map((option) => option.trim());
    if (options.length !== 4 || options.some((option) => !option)) {
      issues.push({ code: "OPTIONS_INVALID", message: "必须恰好 4 个非空选项。", severity: "blocking" });
    } else {
      const normalized = options.map(normalizeText);
      if (new Set(normalized).size !== 4) {
        issues.push({ code: "OPTIONS_DUPLICATED", message: "选项归一化后不得重复。", severity: "blocking" });
      }
      if (options.some((option) => FORBIDDEN_OPTION_TEXT.some((text) => option.includes(text)))) {
        issues.push({ code: "OPTION_FORBIDDEN", message: "禁止“以上都对/以上都错”类选项。", severity: "blocking" });
      }
      const lengths = options.map((option) => option.length).sort((a, b) => a - b);
      if (lengths[0] > 0 && lengths[3] / lengths[0] > 1.8 && lengths[3] - lengths[0] > 4) {
        issues.push({
          code: "OPTIONS_LENGTH_IMBALANCE",
          message: "最长与最短选项字符数之比超过 1.8。",
          severity: "blocking",
        });
      }
      const letterIndex = "ABCD".indexOf((input.answer ?? "").toUpperCase());
      const content = input.answer_content ?? (letterIndex >= 0 ? options[letterIndex] : "");
      const matches = normalized.filter((option) => option === normalizeText(content));
      if (matches.length !== 1) {
        issues.push({
          code: "ANSWER_NOT_UNIQUE",
          message: "正确答案必须恰好匹配一个选项。",
          severity: "blocking",
        });
      }
    }
  } else if (input.question_type === "true_false") {
    if (!TRUE_FALSE_ANSWERS.includes(input.answer ?? "")) {
      issues.push({ code: "ANSWER_INVALID", message: "判断题答案只能为“正确”或“错误”。", severity: "blocking" });
    } else if (input.target_answer !== null && input.target_answer !== undefined) {
      const expected = input.target_answer ? "正确" : "错误";
      if (input.answer !== expected) {
        issues.push({
          code: "ANSWER_TARGET_MISMATCH",
          message: `答案必须与预分配目标一致(目标:${expected})。`,
          severity: "blocking",
        });
      }
    }
    const stem = (input.stem ?? "").trim();
    if (FORBIDDEN_STEM_HINTS.some((hint) => stem.includes(hint)) || stem.endsWith("?")) {
      issues.push({ code: "STEM_NOT_STATEMENT", message: "判断题题干必须是陈述句。", severity: "blocking" });
    }
  } else {
    const stem = input.stem ?? "";
    if (stem.split(BLANK_MARKER).length - 1 !== 1) {
      issues.push({ code: "BLANK_COUNT_INVALID", message: "填空题题干必须恰好包含一个 ____。", severity: "blocking" });
    }
    if (!input.answer || !input.answer.trim()) {
      issues.push({ code: "ANSWER_INVALID", message: "填空答案不能为空。", severity: "blocking" });
    } else {
      if (!normalizeText(input.block_text).includes(normalizeText(input.answer))) {
        issues.push({ code: "ANSWER_NOT_IN_SOURCE", message: "填空答案必须逐字出现在原文中。", severity: "blocking" });
      }
      const hollowed = normalizeText(stem.replace(BLANK_MARKER, ""));
      if (normalizeText(input.answer) && hollowed.includes(normalizeText(input.answer))) {
        issues.push({ code: "ANSWER_LEAKED_IN_STEM", message: "挖空后的题干不得残留答案原文。", severity: "blocking" });
      }
    }
    if ((input.acceptable_answers ?? []).some((answer) => !(answer ?? "").trim())) {
      issues.push({
        code: "ACCEPTABLE_ANSWERS_INVALID",
        message: "同义答案不得包含空字符串。",
        severity: "blocking",
      });
    }
  }

  return { passed: issues.length === 0, issues: [...issues, ...warnings], warnings };
}

export function issuesOf(report: ValidationResult): ValidationIssue[] {
  return [...report.issues.filter((issue) => issue.severity === "blocking"), ...report.warnings];
}
