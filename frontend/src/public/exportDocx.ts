import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
  UnderlineType,
} from "docx";
import type { QuestionDto, QuizRecordDto } from "../types/api";

const BLANK = "____";
const UNDERLINE_SPACES = " ".repeat(10);
const LETTERS = "ABCD";

const SECTION_TITLES: { type: QuestionDto["question_type"]; title: string }[] = [
  { type: "single_choice", title: "一、单选题" },
  { type: "true_false", title: "二、判断题" },
  { type: "fill_blank", title: "三、填空题" },
];

function stemRuns(question: QuestionDto, size = 21): TextRun[] {
  const stem = question.stem ?? "";
  if (question.question_type !== "fill_blank" || !stem.includes(BLANK)) {
    return [new TextRun({ text: stem, size })];
  }
  const parts = stem.split(BLANK);
  const runs: TextRun[] = [];
  parts.forEach((part, index) => {
    if (part) runs.push(new TextRun({ text: part, size }));
    if (index < parts.length - 1) {
      runs.push(
        new TextRun({
          text: UNDERLINE_SPACES,
          size,
          underline: { type: UnderlineType.SINGLE },
          font: { eastAsia: "微软雅黑" },
        }),
      );
    }
  });
  return runs;
}

function answerLine(question: QuestionDto): string {
  if (question.question_type === "single_choice") {
    const index = LETTERS.indexOf((question.answer ?? "").toUpperCase());
    const content = index >= 0 ? question.options?.[index] ?? "" : "";
    return `${question.answer ?? ""}. ${content}`;
  }
  if (question.question_type === "fill_blank" && question.acceptable_answers?.length) {
    return `${question.answer ?? ""}（可接受：${question.acceptable_answers.join("、")}）`;
  }
  return question.answer ?? "";
}

export async function buildExportBlob(
  quiz: QuizRecordDto,
  kind: "student" | "answer",
): Promise<Blob> {
  const answer = kind === "answer";
  const questions = [...(quiz.questions ?? [])].sort((a, b) => a.slot_number - b.slot_number);
  const date = new Date();
  const dateText = `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月${String(
    date.getDate(),
  ).padStart(2, "0")}日`;

  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({ text: answer ? "AI出题精灵 · 试题（答案版）" : "AI出题精灵 · 试题", bold: true, size: 44 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: `来源：${(quiz.documents ?? []).join("、") || "上传文档"} · ${dateText}`,
          size: 20,
          color: "666666",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 },
      children: [new TextRun({ text: "姓名：____________　　部门：____________　　得分：________", size: 21 })],
    }),
  ];

  let number = 0;
  for (const section of SECTION_TITLES) {
    const items = questions.filter((question) => question.question_type === section.type && question.stem);
    if (!items.length) continue;
    children.push(
      new Paragraph({
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: section.title, bold: true, size: 28 })],
      }),
    );
    for (const question of items) {
      number += 1;
      children.push(
        new Paragraph({
          spacing: { before: 80, after: 40 },
          children: [new TextRun({ text: `${number}. `, bold: true, size: 21 }), ...stemRuns(question)],
        }),
      );
      if (question.question_type === "single_choice") {
        for (const [index, option] of (question.options ?? []).entries()) {
          children.push(
            new Paragraph({
              indent: { left: 480 },
              spacing: { after: 20 },
              children: [new TextRun({ text: `${LETTERS[index]}. ${option}`, size: 21 })],
            }),
          );
        }
      }
      if (answer) {
        children.push(
          new Paragraph({
            indent: { left: 240 },
            spacing: { before: 40, after: 20 },
            children: [
              new TextRun({ text: "答案：", bold: true, size: 21 }),
              new TextRun({ text: answerLine(question), size: 21 }),
            ],
          }),
        );
        children.push(
          new Paragraph({
            indent: { left: 240 },
            spacing: { after: 20 },
            children: [
              new TextRun({ text: "解析：", bold: true, size: 21 }),
              new TextRun({ text: question.explanation ?? "", size: 21 }),
            ],
          }),
        );
        children.push(
          new Paragraph({
            indent: { left: 240 },
            spacing: { after: 20 },
            children: [
              new TextRun({ text: "出处：", bold: true, size: 21 }),
              new TextRun({ text: question.source?.locator_label ?? "", size: 21 }),
            ],
          }),
        );
        children.push(
          new Paragraph({
            indent: { left: 240 },
            spacing: { after: 80 },
            children: [
              new TextRun({ text: "原文：", bold: true, size: 21 }),
              new TextRun({ text: question.source?.block_text ?? "", size: 20, color: "555555" }),
            ],
          }),
        );
      }
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: "Times New Roman", eastAsia: "宋体" },
            size: 21,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}
