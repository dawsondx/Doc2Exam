import type { AiTask } from "./aiClient";

const QUESTION_TYPES = ["single_choice", "true_false", "fill_blank"];

function sentences(text: string): string[] {
  return text
    .split(/[。！？；\n]+/)
    .map((part) => part.replace(/\s+/g, "").trim())
    .filter((part) => part.length >= 8);
}

function pickBase(blockText: string, point: string): string {
  const list = sentences(blockText);
  if (!list.length) return blockText.replace(/\s+/g, "").slice(0, 120) || point;
  const needle = point.replace(/\s+/g, "").slice(0, 6);
  const hit = list.find((sentence) => needle && sentence.includes(needle));
  return (hit ?? list[0]).slice(0, 120);
}

function mockExtraction(task: Extract<AiTask, { kind: "extraction" }>) {
  const points: {
    source_block_id: string;
    content: string;
    bloom_level: string;
    category: string;
    eligible_types: string[];
  }[] = [];
  for (const block of task.blocks) {
    const list = sentences(block.text);
    const candidates = list.length
      ? list
      : [block.text.replace(/\s+/g, "").slice(0, 80)].filter((text) => text.length >= 10);
    for (const content of candidates.slice(0, Math.max(2, task.quota))) {
      points.push({
        source_block_id: block.id,
        content: content.slice(0, 120),
        bloom_level: "understand",
        category: "文档要点",
        eligible_types: [...QUESTION_TYPES],
      });
      if (points.length >= task.quota) break;
    }
    if (points.length >= task.quota) break;
  }
  return { points };
}

function mockSingleChoice(point: string, blockText: string) {
  const base = pickBase(blockText, point).slice(0, 40);
  const prefixes = ["原文表述:", "原文反义:", "原文改写:", "原文转述:"];
  const options = prefixes.map((prefix) => `${prefix}${base}`);
  return {
    stem: `关于“${point.slice(0, 36)}”，下列说法正确的是?`,
    options,
    answer_content: options[0],
    explanation: `原文写道：“${base}”。其余选项对原文作了改写或反向表述。`,
  };
}

function mockTrueFalse(point: string, blockText: string, target: boolean) {
  const base = pickBase(blockText, point).slice(0, 160);
  if (target) {
    return {
      stem: base.length >= 8 ? base : `原文指出：${base}`,
      answer: "正确",
      explanation: `原文写道：“${base}”，与该陈述一致。`,
    };
  }
  const falsified = base.includes("是")
    ? base.replace("是", "不是")
    : `有观点认为“${base}”，这一说法与原文相反。`;
  return {
    stem: falsified.length >= 8 ? falsified : `有观点认为“${falsified}”，这一说法与原文相反。`,
    answer: "错误",
    explanation: `原文实际写道：“${base}”。`,
  };
}

function uniqueGram(text: string, length: number, answer: string): boolean {
  const first = text.indexOf(answer);
  return first >= 0 && text.indexOf(answer, first + 1) === -1 && answer.length === length;
}

function mockFillBlank(point: string, blockText: string) {
  const base = pickBase(blockText, point);
  let answer = "";
  for (let length = 2; length <= 6 && !answer; length += 1) {
    for (let index = 0; index + length <= base.length; index += 1) {
      const candidate = base.slice(index, index + length);
      if (/^\d+$/.test(candidate)) continue;
      if (uniqueGram(base, length, candidate)) {
        answer = candidate;
        break;
      }
    }
  }
  if (!answer) answer = base.slice(0, 2);
  const at = base.indexOf(answer);
  const before = at >= 0 ? base.slice(0, at) : "";
  const after = at >= 0 ? base.slice(at + answer.length) : base;
  let stem = `根据原文，${before}____${after}`;
  if (stem.length < 8) stem = `请补全原文：${before}____${after}`;
  return {
    stem: stem.slice(0, 480),
    answer,
    acceptable_answers: [],
    explanation: `原文写道：“${base}”。`,
  };
}

function mockQuestion(task: Extract<AiTask, { kind: "question" }>) {
  if (task.question_type === "single_choice") {
    return mockSingleChoice(task.point_content, task.block_text);
  }
  if (task.question_type === "true_false") {
    return mockTrueFalse(task.point_content, task.block_text, task.target_answer ?? true);
  }
  return mockFillBlank(task.point_content, task.block_text);
}

export async function runMockAi(task: AiTask): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 140));
  if (task.kind === "probe") return { ok: true, model: "本地模拟模型" };
  if (task.kind === "extraction") return mockExtraction(task);
  return mockQuestion(task);
}
