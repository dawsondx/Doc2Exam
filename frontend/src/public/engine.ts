import type { ExportFileDto } from "../api/endpoints";
import type {
  AIProfileDto,
  ConsentStatusDto,
  DocumentDto,
  EstimateDto,
  JobDto,
  KnowledgePointDto,
  QuestionDto,
  QuizRecordDto,
  ValidationIssue,
} from "../types/api";
import {
  callAi,
  byokFingerprint,
  getByokSummary,
  type AiBlock,
  type AiTask,
} from "./aiClient";
import { buildExportBlob } from "./exportDocx";
import {
  EngineError,
  PUBLIC_LIMITS,
  PUBLIC_PROFILE_ID,
  clampConfig,
  clone,
  newId,
  nowIso,
  publicProfile,
  totalQuestions,
  type ExportFileRecord,
  type JobPayload,
  type PublicJobType,
  type PublicState,
  type QuestionConfig,
  type SourceBlock,
  type StoredDocument,
  type StoredJob,
} from "./model";
import { mediaTypeOf, parseDocumentFile } from "./parse";
import { loadState, saveState } from "./store";
import {
  assembleChunks,
  bipartiteMatch,
  buildSlots,
  dedupeCandidates,
  distributeQuota,
  entailsSource,
  normalizeText,
  semanticNormalize,
  type CandidatePoint,
  type SlotPlan,
} from "./text";
import { issuesOf, validateQuestion } from "./validate";

const QUESTION_TYPE_LABELS = {
  single_choice: "单选题",
  true_false: "判断题",
  fill_blank: "填空题",
} as const;

const BLOOM_LEVELS = new Set(["remember", "understand", "apply", "analyze"]);
const SUPPORTED_TYPES = new Set(["single_choice", "true_false", "fill_blank"]);

let state: PublicState | null = null;
let initPromise: Promise<PublicState> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const blobUrls = new Map<string, string>();
const blobCache = new Map<string, Blob>();

function current(): PublicState {
  if (!state) throw new EngineError(503, "NOT_READY", "本地数据尚未初始化。", "刷新页面重试");
  return state;
}

export function ensureState(): Promise<PublicState> {
  if (state) return Promise.resolve(state);
  if (!initPromise) {
    initPromise = (async () => {
      const loaded = await loadState();
      state = loaded;
      let changed = false;
      for (const job of loaded.jobs) {
        if (job.status === "queued" || job.status === "running") {
          job.status = "interrupted";
          job.stage = "程序上次退出时中断";
          job.updated_at = nowIso();
          changed = true;
        }
      }
      for (const document of loaded.documents) {
        if (document.dto.parse_status === "running" || document.dto.parse_status === "pending") {
          document.dto.parse_status = "failed";
          document.dto.parse_error = "上次退出时解析中断，请重新上传";
          changed = true;
        }
      }
      for (const files of Object.values(loaded.exports)) {
        for (const file of files) {
          if (file.download_url) {
            file.download_url = "";
            changed = true;
          }
        }
      }
      if (changed) await saveState(loaded);
      return loaded;
    })();
  }
  return initPromise;
}

function persist(immediate = false) {
  if (!state) return;
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = undefined;
    void saveState(state);
    return;
  }
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (state) void saveState(state);
  }, 350);
}

function jobDto(job: StoredJob): JobDto {
  const { payload: _payload, ...dto } = job;
  return clone(dto);
}

function findJob(id: string): StoredJob | undefined {
  return current().jobs.find((job) => job.id === id);
}

function findQuiz(id: string): QuizRecordDto | undefined {
  return current().quizzes.find((quiz) => quiz.id === id);
}

function findQuestion(id: string): { quiz: QuizRecordDto; question: QuestionDto } | null {
  for (const quiz of current().quizzes) {
    const question = quiz.questions?.find((item) => item.id === id);
    if (question) return { quiz, question };
  }
  return null;
}

function findPoint(id: string): KnowledgePointDto | undefined {
  return current().points.find((point) => point.id === id);
}

function findBlock(id: string): SourceBlock | undefined {
  for (const document of current().documents) {
    const block = document.blocks.find((item) => item.id === id);
    if (block) return block;
  }
  return undefined;
}

function documentOrder(documentId: string): number {
  return current().documents.findIndex((document) => document.dto.id === documentId);
}

function documentName(documentId: string): string {
  return current().documents.find((document) => document.dto.id === documentId)?.dto.original_name ?? "";
}

function selectedDocuments(ids: string[]): StoredDocument[] {
  return ids
    .map((id) => current().documents.find((document) => document.dto.id === id))
    .filter((document): document is StoredDocument => Boolean(document));
}

function questionTotal(config: Record<string, number> | QuestionConfig): number {
  return (
    Number(config.single_choice || 0) +
    Number(config.true_false || 0) +
    Number(config.fill_blank || 0)
  );
}

function questionBySlot(quiz: QuizRecordDto, slot: number): QuestionDto | undefined {
  return quiz.questions?.find((question) => question.slot_number === slot);
}

function blankQuestion(quizId: string, plan: SlotPlan): QuestionDto {
  return {
    id: newId("q"),
    quiz_record_id: quizId,
    slot_number: plan.slot_number,
    question_type: plan.question_type,
    knowledge_point_id: null,
    stem: null,
    options: null,
    answer: null,
    acceptable_answers: null,
    explanation: null,
    validation_state: "pending",
    validation_issues: [],
    review_state: "unreviewed",
    attempt_count: 0,
  };
}

function refreshQuiz(quiz: QuizRecordDto) {
  const questions = (quiz.questions ?? []).filter(Boolean);
  const target = questionTotal(quiz.question_config);
  const approved = questions.filter((q) => q.review_state === "approved" && q.stem).length;
  const missing = questions.filter((q) => !q.stem).length;
  const allValid = questions.every((q) => q.stem && q.validation_state === "passed");
  quiz.progress = {
    target,
    approved,
    unreviewed: questions.filter((q) => q.review_state === "unreviewed" && q.stem).length,
    rejected: questions.filter((q) => q.review_state === "rejected").length,
    missing,
    export_ready: target > 0 && approved >= target && missing === 0 && allValid,
  };
  if (quiz.status !== "exported") {
    quiz.status = quiz.progress.export_ready ? "ready" : "draft";
  }
  quiz.updated_at = nowIso();
}

function createJob(input: {
  type: PublicJobType;
  stage: string;
  total: number;
  payload: JobPayload;
  documentId?: string | null;
  quizRecordId?: string | null;
}): StoredJob {
  const job: StoredJob = {
    id: newId("job"),
    job_type: input.type,
    status: "queued",
    document_id: input.documentId ?? input.payload.document_ids?.[0] ?? null,
    quiz_record_id: input.quizRecordId ?? input.payload.quiz_record_id ?? null,
    ai_profile_id: PUBLIC_PROFILE_ID,
    stage: input.stage,
    current: 0,
    total: input.total,
    error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    finished_at: null,
    payload: input.payload,
  };
  current().jobs.unshift(job);
  current().jobs = current().jobs.slice(0, 40);
  persist();
  return job;
}

function updateJob(job: StoredJob, patch: Partial<JobDto>) {
  Object.assign(job, patch, { updated_at: nowIso() });
  persist();
}

function isCancelled(jobId: string): boolean {
  return findJob(jobId)?.status === "cancelled";
}

function failJob(job: StoredJob, error: unknown) {
  if (isCancelled(job.id)) return;
  const engineError =
    error instanceof EngineError
      ? error
      : new EngineError(500, "ENGINE_FAILED", "处理过程中出现未知错误。", "稍后重试");
  const quiz = job.quiz_record_id ? findQuiz(job.quiz_record_id) : null;
  const generated = quiz?.questions?.some((question) => question.stem) ?? false;
  job.status = job.job_type === "generation" && generated ? "partial" : "failed";
  job.stage = "已中断";
  job.error = { code: engineError.code, message: engineError.message };
  job.finished_at = nowIso();
  job.updated_at = nowIso();
  persist(true);
}

export async function runJob(jobId: string): Promise<void> {
  const job = findJob(jobId);
  if (!job) return;
  if (job.status === "cancelled") return;
  job.status = "running";
  job.stage = job.job_type === "extraction" ? "准备抽取" : "准备生成";
  job.error = null;
  job.finished_at = null;
  job.updated_at = nowIso();
  persist();

  try {
    if (job.job_type === "extraction") await runExtraction(job);
    else if (job.job_type === "generation") await runGeneration(job);
  } catch (error) {
    failJob(job, error);
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === "string") {
    const text = value
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      value = JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseCandidates(
  raw: unknown,
  allowed: Map<string, SourceBlock>,
): { candidates: CandidatePoint[]; errors: string[] } {
  const object = parseJsonObject(raw);
  const list = Array.isArray(object?.points) ? (object.points as unknown[]) : [];
  const candidates: CandidatePoint[] = [];
  const errors: string[] = [];
  if (!list.length) errors.push("返回的 points 为空或不是数组");

  for (const item of list) {
    const record = item as Record<string, unknown>;
    const blockId = asString(record.source_block_id);
    const content = asString(record.content);
    const category = asString(record.category);
    const bloom = asString(record.bloom_level) || "understand";
    const types = Array.isArray(record.eligible_types)
      ? record.eligible_types.map(asString).filter(Boolean)
      : [];
    const block = allowed.get(blockId);
    if (!block) {
      errors.push(`source_block_id 不在本轮文本块内：${blockId || "(空)"}`);
      continue;
    }
    if (content.length < 10 || content.length > 200) {
      errors.push(`考点长度 ${content.length} 越界（需 10–200 字）`);
      continue;
    }
    if (category.length < 2 || category.length > 20) {
      errors.push(`分类长度 ${category.length} 越界（需 2–20 字）`);
      continue;
    }
    if (!BLOOM_LEVELS.has(bloom)) {
      errors.push(`bloom_level 非法：${bloom}`);
      continue;
    }
    if (!types.length || types.some((type) => !SUPPORTED_TYPES.has(type))) {
      errors.push("eligible_types 为空或包含不支持的题型");
      continue;
    }
    candidates.push({
      source_block_id: blockId,
      content,
      bloom_level: bloom,
      category,
      eligible_types: types,
      document_order: documentOrder(block.document_id),
      block_ordinal: block.ordinal,
      requires_source_review: !entailsSource(content, block.normalized_text),
    });
  }
  return { candidates, errors };
}

async function extractChunk(blocks: SourceBlock[], quota: number): Promise<CandidatePoint[]> {
  const allowed = new Map(blocks.map((block) => [block.id, block]));
  const payload: AiBlock[] = blocks.map((block) => ({ id: block.id, text: block.text }));
  let repair: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let raw: unknown;
    try {
      raw = await callAi({ kind: "extraction", blocks: payload, quota, repair_errors: repair });
    } catch (error) {
      if (error instanceof EngineError && error.code === "AI_INVALID_RESPONSE" && attempt < 2) {
        repair = "上一次返回的内容无法解析。只返回 JSON 对象 {points:[...]}，不要输出解释或 Markdown。";
        await new Promise((resolve) => setTimeout(resolve, 600));
        continue;
      }
      throw error;
    }
    const parsed = parseCandidates(raw, allowed);
    if (parsed.candidates.length) return parsed.candidates;
    repair = parsed.errors.slice(0, 8).join("\n") || "必须返回 JSON 对象 {points:[...]}";
  }
  return [];
}

function toPointDto(
  candidate: CandidatePoint,
  jobId: string,
  selected: boolean,
): KnowledgePointDto {
  const block = findBlock(candidate.source_block_id);
  return {
    id: newId("point"),
    extraction_job_id: jobId,
    document_id: block?.document_id ?? "",
    source_block_id: candidate.source_block_id,
    content: candidate.content,
    bloom_level: candidate.bloom_level,
    category: candidate.category,
    eligible_types: candidate.eligible_types,
    selected,
    selectable: true,
    requires_source_review: candidate.requires_source_review ?? false,
    source_text: block?.text,
    created_at: nowIso(),
  };
}

function candidateOf(point: KnowledgePointDto): CandidatePoint {
  const block = findBlock(point.source_block_id);
  return {
    source_block_id: point.source_block_id,
    content: point.content,
    bloom_level: point.bloom_level,
    category: point.category,
    eligible_types: point.eligible_types,
    document_order: block ? documentOrder(block.document_id) : 0,
    block_ordinal: block?.ordinal ?? 0,
    requires_source_review: point.requires_source_review,
  };
}

function supplementCandidates(
  blocks: SourceBlock[],
  seen: Set<string>,
  target: number,
): CandidatePoint[] {
  const additions: CandidatePoint[] = [];
  for (const block of blocks) {
    if (seen.size + additions.length >= target) break;
    const sentences = block.text
      .split(/[。！？；\n]+/)
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter((sentence) => sentence.length >= 12 && sentence.length <= 200);
    for (const sentence of sentences) {
      const key = semanticNormalize(sentence);
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push({
        source_block_id: block.id,
        content: sentence.slice(0, 180),
        bloom_level: "understand",
        category: "程序摘录",
        eligible_types: ["single_choice", "true_false", "fill_blank"],
        document_order: documentOrder(block.document_id),
        block_ordinal: block.ordinal,
        requires_source_review: true,
      });
      if (seen.size + additions.length >= target) break;
    }
  }
  return additions;
}

async function runExtraction(job: StoredJob) {
  const documents = selectedDocuments(job.payload.document_ids ?? []);
  const blocks: SourceBlock[] = [];
  let chars = 0;
  for (const document of documents) {
    if (chars >= PUBLIC_LIMITS.maxExtractionChars) break;
    for (const block of document.blocks) {
      if (chars >= PUBLIC_LIMITS.maxExtractionChars) break;
      const remaining = PUBLIC_LIMITS.maxExtractionChars - chars;
      const text = block.text.slice(0, remaining);
      blocks.push(text === block.text ? block : { ...block, text });
      chars += text.length;
    }
  }
  if (!blocks.length) {
    throw new EngineError(422, "DOCUMENT_NO_TEXT", "选中的文档没有可用于出题的文字。", "更换文档");
  }

  const chunks = assembleChunks(blocks, PUBLIC_LIMITS.chunkTokens);
  const totalQ = job.payload.target_question_count ?? 12;
  const quotas = distributeQuota(chunks, totalQ);
  job.total = chunks.length;
  job.current = Math.min(job.current, chunks.length);
  updateJob(job, { total: chunks.length, stage: `切分为 ${chunks.length} 组文本块` });

  for (let index = job.current; index < chunks.length; index += 1) {
    if (isCancelled(job.id)) return;
    const chunk = chunks[index];
    job.stage = `提取原子考点 ${index + 1} / ${chunks.length}`;
    job.updated_at = nowIso();
    persist();
    const candidates = await extractChunk(chunk.blocks, quotas[index]);
    for (const candidate of candidates) {
      if (current().points.some((point) => point.extraction_job_id === job.id && semanticNormalize(point.content) === semanticNormalize(candidate.content) && point.source_block_id === candidate.source_block_id)) {
        continue;
      }
      current().points.push(toPointDto(candidate, job.id, false));
    }
    job.current = index + 1;
    updateJob(job, { current: job.current });
  }
  if (isCancelled(job.id)) return;

  job.stage = "校验与去重";
  updateJob(job, { stage: "校验与去重" });

  const existing = current().points.filter((point) => point.extraction_job_id === job.id);
  let candidates = dedupeCandidates(existing.map(candidateOf));
  const seen = new Set(candidates.map((candidate) => semanticNormalize(candidate.content)));
  const targetCount = Math.max(totalQ, Math.min(60, Math.ceil(totalQ * 2.5)));
  if (candidates.length < targetCount) {
    candidates = dedupeCandidates([
      ...candidates,
      ...supplementCandidates(blocks, seen, targetCount - candidates.length + seen.size),
    ]).slice(0, Math.max(targetCount, totalQ));
  }
  if (!candidates.length) {
    throw new EngineError(422, "EXTRACTION_EMPTY", "没有提取到可用考点，请更换文档或稍后重试。", "更换文档");
  }

  const slack = Math.max(3, Math.ceil(totalQ * 0.25));
  const selectCount = Math.min(candidates.length, totalQ + slack);
  const points = candidates.map((candidate, index) =>
    toPointDto(candidate, job.id, index < selectCount),
  );
  current().points = [
    ...current().points.filter((point) => point.extraction_job_id !== job.id),
    ...points,
  ];

  job.status = "completed";
  job.current = job.total;
  job.stage = "已完成";
  job.finished_at = nowIso();
  job.updated_at = nowIso();
  persist(true);
}

interface ParsedQuestion {
  stem: string;
  options: string[];
  answer: string;
  answerContent: string;
  acceptable: string[];
  explanation: string;
}

function parseQuestion(raw: unknown, type: QuestionDto["question_type"]): ParsedQuestion | null {
  const object = parseJsonObject(raw);
  if (!object) return null;
  const stem = asString(object.stem);
  const explanation = asString(object.explanation);
  if (type === "single_choice") {
    const options = Array.isArray(object.options) ? object.options.map(asString) : [];
    return {
      stem,
      options,
      answer: "",
      answerContent: asString(object.answer_content),
      acceptable: [],
      explanation,
    };
  }
  if (type === "true_false") {
    return {
      stem,
      options: [],
      answer: asString(object.answer),
      answerContent: "",
      acceptable: [],
      explanation,
    };
  }
  return {
    stem,
    options: [],
    answer: asString(object.answer),
    answerContent: "",
    acceptable: Array.isArray(object.acceptable_answers)
      ? object.acceptable_answers.map(asString)
      : [],
    explanation,
  };
}

function pointPool(quiz: QuizRecordDto, payload: JobPayload): KnowledgePointDto[] {
  const ids = payload.point_ids ?? quiz.frozen_points?.map((point) => point.id) ?? [];
  const pool = ids
    .map((id) => findPoint(id))
    .filter((point): point is KnowledgePointDto => Boolean(point));
  if (pool.length) return pool;
  return current().points.filter((point) => point.selected);
}

function greedyMatch(
  slots: SlotPlan[],
  candidates: Record<number, string[]>,
): Record<number, string> {
  const result: Record<number, string> = {};
  const used = new Map<string, number>();
  for (const slot of slots) {
    const options = candidates[slot.slot_number] ?? [];
    const fresh = options.find((id) => !used.has(id)) ?? options[0];
    if (fresh) {
      result[slot.slot_number] = fresh;
      used.set(fresh, (used.get(fresh) ?? 0) + 1);
    }
  }
  return result;
}

async function generateSlot(input: {
  jobId: string;
  quiz: QuizRecordDto;
  question: QuestionDto;
  plan: SlotPlan;
  pool: KnowledgePointDto[];
  candidates: string[];
  preferred?: string;
}): Promise<boolean> {
  const { jobId, question, plan, pool, candidates } = input;
  if (question.question_type === "single_choice" && plan.answer_letter) {
    // 单选题的答案位置由 slot plan 决定，但模型给的是选项内容，最终以内容匹配为准。
  }
  const ordered = [
    ...(input.preferred ? [input.preferred] : []),
    ...candidates.filter((id) => id !== input.preferred),
  ];
  let repair: string | undefined;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (isCancelled(jobId)) return false;
    const pointId = ordered[Math.min(ordered.length - 1, Math.floor(attempt / 2))];
    const point = pool.find((item) => item.id === pointId);
    if (!point) continue;
    const block = findBlock(point.source_block_id);
    const blockText = block?.text ?? point.content;
    const task: AiTask = {
      kind: "question",
      question_type: plan.question_type,
      point_content: point.content,
      block_text: blockText,
      target_answer_hint: plan.answer_letter,
      target_answer: plan.target_answer,
      repair_errors: repair,
    };
    let raw: unknown;
    try {
      raw = await callAi(task);
    } catch (error) {
      if (
        error instanceof EngineError &&
        (error.status === 401 ||
          error.status === 402 ||
          error.status === 429 ||
          error.status === 503 ||
          error.code === "AI_NETWORK" ||
          error.code === "AI_TIMEOUT")
      ) {
        throw error;
      }
      repair = error instanceof EngineError ? error.message : "AI 请求失败";
      continue;
    }
    const parsed = parseQuestion(raw, plan.question_type);
    if (!parsed) {
      repair = "必须返回指定字段的 JSON 对象，不要输出其他文本。";
      continue;
    }

    const options = parsed.options.map((option) => option.trim());
    let letter = "";
    if (plan.question_type === "single_choice") {
      const index = options.findIndex(
        (option) => normalizeText(option) === normalizeText(parsed.answerContent),
      );
      letter = index >= 0 ? "ABCD"[index] : "";
    }
    const answer = plan.question_type === "single_choice" ? letter : parsed.answer;

    const report = validateQuestion({
      question_type: plan.question_type,
      stem: parsed.stem,
      options: plan.question_type === "single_choice" ? options : null,
      answer,
      answer_content: parsed.answerContent,
      acceptable_answers: plan.question_type === "fill_blank" ? parsed.acceptable : null,
      explanation: parsed.explanation,
      target_answer: plan.target_answer,
      point_content: point.content,
      block_text: blockText,
    });

    question.stem = parsed.stem;
    question.options = plan.question_type === "single_choice" ? options : null;
    question.answer = answer || null;
    question.acceptable_answers = plan.question_type === "fill_blank" ? parsed.acceptable : null;
    question.explanation = parsed.explanation;
    question.knowledge_point_id = point.id;
    question.source = {
      point_content: point.content,
      locator_label: block?.locator_label ?? null,
      block_text: blockText,
      page_number: block?.page_number ?? null,
    };
    question.validation_state = report.passed ? "passed" : "failed";
    question.validation_issues = issuesOf(report) as ValidationIssue[];
    question.attempt_count += 1;

    if (report.passed) {
      const frozen = input.quiz.frozen_points?.find((item) => item.id === point.id);
      if (frozen) frozen.used = true;
      return true;
    }
    repair = report.issues.map((issue) => issue.message).join("；");
  }
  return false;
}

async function runGeneration(job: StoredJob) {
  const quiz = job.payload.quiz_record_id ? findQuiz(job.payload.quiz_record_id) : undefined;
  if (!quiz) throw new EngineError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表");

  const config = clampConfig(job.payload.question_config ?? quiz.question_config);
  quiz.question_config = { ...config };
  quiz.questions = quiz.questions ?? [];
  const plans = buildSlots(config, quiz.seed);
  for (const plan of plans) {
    if (!questionBySlot(quiz, plan.slot_number)) {
      quiz.questions.push(blankQuestion(quiz.id, plan));
    }
  }
  quiz.questions.sort((a, b) => a.slot_number - b.slot_number);

  let targets: SlotPlan[];
  if (job.payload.mode === "regenerate" && job.payload.question_id) {
    const target = quiz.questions.find((question) => question.id === job.payload.question_id);
    const plan = plans.find((item) => item.slot_number === target?.slot_number);
    targets = plan ? [plan] : [];
  } else {
    targets = plans.filter((plan) => !questionBySlot(quiz, plan.slot_number)?.stem);
  }
  job.total = targets.length;
  job.current = 0;
  updateJob(job, { total: targets.length, stage: "建立题目槽位" });

  if (!targets.length) {
    finishGeneration(job, quiz);
    return;
  }

  const pool = pointPool(quiz, job.payload);
  if (!pool.length) {
    throw new EngineError(409, "NO_POINTS", "没有可用考点，请返回上一步重新选择。", "返回选择考点");
  }
  const candidates: Record<number, string[]> = {};
  for (const plan of plans) {
    const eligible = pool
      .filter((point) => point.eligible_types.includes(plan.question_type))
      .map((point) => point.id);
    candidates[plan.slot_number] = eligible.length ? eligible : pool.map((point) => point.id);
  }
  const assignment =
    bipartiteMatch(targets.map((plan) => plan.slot_number), candidates, quiz.seed) ??
    greedyMatch(targets, candidates);

  for (const [index, plan] of targets.entries()) {
    if (isCancelled(job.id)) return;
    const question = questionBySlot(quiz, plan.slot_number);
    if (!question) continue;
    job.stage = `生成第 ${index + 1} / ${targets.length} 题 · ${QUESTION_TYPE_LABELS[plan.question_type]}`;
    job.updated_at = nowIso();
    persist();
    await generateSlot({
      jobId: job.id,
      quiz,
      question,
      plan,
      pool,
      candidates: candidates[plan.slot_number] ?? [],
      preferred: assignment[plan.slot_number],
    });
    job.current = index + 1;
    refreshQuiz(quiz);
    updateJob(job, { current: job.current });
  }

  if (isCancelled(job.id)) return;
  finishGeneration(job, quiz);
}

function finishGeneration(job: StoredJob, quiz: QuizRecordDto) {
  const used = new Set(
    (quiz.questions ?? []).filter((question) => question.stem).map((question) => question.knowledge_point_id),
  );
  for (const point of quiz.frozen_points ?? []) {
    point.used = used.has(point.id);
  }
  refreshQuiz(quiz);
  const missing = quiz.progress?.missing ?? 0;
  job.status = missing > 0 ? "partial" : "completed";
  job.stage = missing > 0 ? `部分完成，还缺 ${missing} 题` : "已完成";
  job.current = job.total;
  job.finished_at = nowIso();
  job.updated_at = nowIso();
  persist(true);
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

export async function listDocuments() {
  return { items: current().documents.map((document) => clone(document.dto)), total: current().documents.length, page: 1, page_size: 50 };
}

export function getDocument(id: string): DocumentDto {
  const document = current().documents.find((item) => item.dto.id === id);
  if (!document) throw new EngineError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "刷新页面重试");
  return {
    ...clone(document.dto),
    blocks: document.blocks.map((block) => ({
      id: block.id,
      ordinal: block.ordinal,
      locator_kind: block.locator_kind,
      locator_label: block.locator_label,
      page_number: block.page_number,
      estimated_tokens: block.estimated_tokens,
    })),
    block_total: document.blocks.length,
  };
}

async function parseStoredDocument(document: StoredDocument, file: File) {
  try {
    const result = await parseDocumentFile(document.dto.id, file);
    document.blocks = result.blocks;
    document.dto.page_count = result.pageCount;
    document.dto.block_count = result.blocks.length;
    document.dto.parse_status = "ready";
    document.dto.preview =
      result.preview +
      (result.truncated ? "（文档较长，仅保留公共体验范围内的文本）" : "");
  } catch (error) {
    document.dto.parse_status = "failed";
    document.dto.parse_error =
      error instanceof EngineError ? error.message : "文档解析失败，请更换文件。";
  }
  persist(true);
}

export async function uploadDocuments(files: File[]) {
  if (!files.length) throw new EngineError(400, "NO_FILES", "没有收到文件。", "请选择 PDF 或 DOCX");
  if (files.length > PUBLIC_LIMITS.maxFiles) {
    throw new EngineError(422, "TOO_MANY_FILES", `一次最多上传 ${PUBLIC_LIMITS.maxFiles} 个文件。`, "分批上传");
  }
  if (current().documents.length + files.length > PUBLIC_LIMITS.maxStoredDocuments) {
    throw new EngineError(
      422,
      "DOCUMENT_LIMIT_EXCEEDED",
      `最多保留 ${PUBLIC_LIMITS.maxStoredDocuments} 个文档，请先删除旧文档。`,
      "清理文档库",
    );
  }
  const created: { document: DocumentDto; job_id: string }[] = [];
  for (const file of files) {
    if (file.size > PUBLIC_LIMITS.maxFileBytes) {
      throw new EngineError(422, "DOCUMENT_LIMIT_EXCEEDED", `「${file.name}」超过 15 MB 限制。`, "压缩或拆分文档");
    }
    const document: StoredDocument = {
      dto: {
        id: newId("doc"),
        original_name: file.name,
        media_type: mediaTypeOf(file),
        size_bytes: file.size,
        page_count: null,
        block_count: 0,
        parse_status: "running",
        parse_error: null,
        created_at: nowIso(),
      },
      blocks: [],
    };
    current().documents.unshift(document);
    persist();
    void parseStoredDocument(document, file);
    created.push({ document: clone(document.dto), job_id: `parse-${document.dto.id}` });
  }
  persist(true);
  return { items: created };
}

export function documentDeletionImpact(id: string) {
  const document = current().documents.find((item) => item.dto.id === id);
  if (!document) throw new EngineError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "刷新页面重试");
  const blocking = current().quizzes.filter((quiz) => quiz.documents?.includes(document.dto.original_name));
  const pointCount = current().points.filter((point) => point.document_id === id).length;
  return {
    can_delete: blocking.length === 0,
    blocking_quiz_record_ids: blocking.map((quiz) => quiz.id),
    counts: {
      source_blocks: document.blocks.length,
      parse_jobs: 1,
      extraction_jobs: new Set(current().points.filter((point) => point.document_id === id).map((point) => point.extraction_job_id)).size,
      unfrozen_knowledge_points: pointCount,
    },
    deletion_token: `doc-${id}`,
    message: blocking.length
      ? "该文档仍被历史试卷引用，需先删除对应试卷。"
      : "删除后，该文档的解析结果与未冻结考点将一并移除。",
  };
}

export function deleteDocument(id: string, token: string) {
  if (token !== `doc-${id}`) throw new EngineError(403, "INVALID_TOKEN", "删除凭证无效。", "重新打开删除确认");
  const impact = documentDeletionImpact(id);
  if (!impact.can_delete) throw new EngineError(409, "DOCUMENT_IN_USE", impact.message, "先删除引用试卷");
  const name = current().documents.find((item) => item.dto.id === id)?.dto.original_name;
  current().documents = current().documents.filter((item) => item.dto.id !== id);
  const frozen = new Set(current().quizzes.flatMap((quiz) => quiz.frozen_points?.map((point) => point.id) ?? []));
  current().points = current().points.filter(
    (point) => point.document_id !== id || frozen.has(point.id),
  );
  for (const quiz of current().quizzes) {
    if (quiz.documents) quiz.documents = quiz.documents.filter((item) => item !== name);
  }
  persist(true);
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export function listJobs() {
  return { items: current().jobs.map(jobDto), total: current().jobs.length, page: 1, page_size: 50 };
}

export function getJob(id: string): JobDto {
  const job = findJob(id);
  if (!job) throw new EngineError(404, "JOB_NOT_FOUND", "任务不存在。", "刷新页面重试");
  return jobDto(job);
}

export function cancelJob(id: string) {
  const job = findJob(id);
  if (!job) throw new EngineError(404, "JOB_NOT_FOUND", "任务不存在。", "刷新页面重试");
  if (!["queued", "running", "interrupted"].includes(job.status)) {
    return { status: job.status };
  }
  job.status = "cancelled";
  job.stage = "已取消";
  job.finished_at = nowIso();
  job.updated_at = nowIso();
  persist(true);
  return { status: job.status };
}

export function resumeJob(id: string) {
  const job = findJob(id);
  if (!job) throw new EngineError(404, "JOB_NOT_FOUND", "任务不存在。", "刷新页面重试");
  const resumable =
    job.status === "interrupted" ||
    (job.job_type === "extraction" && job.status === "failed");
  if (!resumable) {
    throw new EngineError(409, "JOB_NOT_RESUMABLE", "当前任务状态不能继续。", "查看任务状态");
  }
  job.status = "queued";
  job.error = null;
  job.finished_at = null;
  job.updated_at = nowIso();
  persist();
  void runJob(id);
  return { job_id: job.id, status: job.status };
}

// ---------------------------------------------------------------------------
// AI 配置 / 同意
// ---------------------------------------------------------------------------

export async function listProfiles() {
  const profile = publicProfile(getByokSummary());
  return { items: [profile], total: 1, page: 1, page_size: 50 };
}

export async function probeProfile(id: string): Promise<AIProfileDto> {
  if (id !== PUBLIC_PROFILE_ID) throw new EngineError(404, "PROFILE_NOT_FOUND", "配置不存在。", "刷新页面重试");
  await callAi({ kind: "probe" });
  return publicProfile(getByokSummary());
}

export function rejectProfileMutation() {
  throw new EngineError(
    403,
    "BROWSER_CONFIG",
    "公共体验的 AI Key 只保存在浏览器，请在页面上直接填写或清除。",
    "返回 AI 配置",
  );
}

export function consentStatus(profileId: string): ConsentStatusDto {
  const fingerprint = byokFingerprint();
  const stored = current().consents[profileId];
  const valid = stored && stored.fingerprint === fingerprint ? stored : null;
  return {
    ai_profile_id: profileId,
    profile_fingerprint: fingerprint,
    consent: valid
      ? {
          id: valid.id,
          profile_fingerprint: valid.fingerprint,
          consented_at: valid.consented_at,
          revoked_at: null,
        }
      : null,
  };
}

export function createConsent(profileId: string) {
  const fingerprint = byokFingerprint();
  const stored = {
    id: newId("consent"),
    consented_at: nowIso(),
    fingerprint,
  };
  current().consents[profileId] = stored;
  persist(true);
  return {
    id: stored.id,
    profile_fingerprint: stored.fingerprint,
    consented_at: stored.consented_at,
    revoked_at: null,
  };
}

export function revokeConsent(id: string) {
  for (const [profileId, consent] of Object.entries(current().consents)) {
    if (consent.id === id) delete current().consents[profileId];
  }
  persist(true);
  return { id };
}

// ---------------------------------------------------------------------------
// 估算 / 抽取
// ---------------------------------------------------------------------------

export function estimate(body: Record<string, unknown>): EstimateDto {
  const config = clampConfig(body.question_config);
  const total = totalQuestions(config);
  const docs = Array.isArray(body.document_ids) ? body.document_ids.map(String) : [];
  const input = selectedDocuments(docs).reduce(
    (sum, document) =>
      sum + document.blocks.reduce((blockSum, block) => blockSum + block.estimated_tokens, 0),
    0,
  );
  return {
    estimated_input_tokens: Math.round(input * 1.15) + total * 220,
    estimated_output_tokens: total * 420,
    estimated_cost: {
      value: null,
      currency: "USD",
      available: false,
      reason: "使用你自己的 Key，费用由所选服务商按实际 token 结算",
    },
  };
}

export function createExtractionJob(body: Record<string, unknown>) {
  const documentIds = Array.isArray(body.document_ids) ? body.document_ids.map(String) : [];
  if (!documentIds.length) throw new EngineError(400, "NO_DOCUMENTS", "请先选择文档。", "返回上传");
  if (!body.consent_id) throw new EngineError(403, "CONSENT_REQUIRED", "请先确认数据发送范围。", "返回 AI 配置");
  const target = Math.max(1, Math.min(60, Number(body.target_question_count) || 12));
  const job = createJob({
    type: "extraction",
    stage: "准备抽取",
    total: Math.ceil(target / 3),
    payload: {
      document_ids: documentIds,
      consent_id: String(body.consent_id),
      target_question_count: target,
    },
  });
  void runJob(job.id);
  return { job_id: job.id };
}

export function listPoints(jobId: string) {
  const points = current().points.filter((point) => point.extraction_job_id === jobId);
  return { items: clone(points), total: points.length, page: 1, page_size: 200 };
}

export function patchPoint(id: string, body: Record<string, unknown>) {
  const point = findPoint(id);
  if (!point) throw new EngineError(404, "POINT_NOT_FOUND", "考点不存在。", "刷新页面重试");
  point.selected = Boolean(body.selected);
  persist();
  return clone(point);
}

export function bulkSelectPoints(ids: string[], selected: boolean) {
  const set = new Set(ids);
  let updated = 0;
  for (const point of current().points) {
    if (set.has(point.id)) {
      point.selected = selected;
      updated += 1;
    }
  }
  persist();
  return { updated };
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export function createGenerationJob(body: Record<string, unknown>) {
  if (!body.consent_id) throw new EngineError(403, "CONSENT_REQUIRED", "请先确认数据发送范围。", "返回 AI 配置");
  const config = clampConfig(body.question_config);
  const total = totalQuestions(config);
  if (total < 1) throw new EngineError(400, "CONFIG_EMPTY", "题目数量不能为 0。", "返回配置题目");
  const pointIds = Array.isArray(body.selected_point_ids)
    ? body.selected_point_ids.map(String)
    : [];
  const points = current().points.filter((point) => pointIds.includes(point.id) && point.selected);
  if (points.length < total) {
    throw new EngineError(409, "NOT_ENOUGH_POINTS", `已选 ${points.length} 个考点，至少需要 ${total} 个。`, "返回选择考点");
  }
  const documentIds = Array.isArray(body.document_ids) ? body.document_ids.map(String) : [];
  const quiz: QuizRecordDto = {
    id: newId("quiz"),
    status: "draft",
    question_config: { ...config },
    ai_profile_name: `自带 Key · ${getByokSummary().provider_label}`,
    model_name: getByokSummary().model || "未配置模型",
    seed: crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000,
    created_at: nowIso(),
    updated_at: nowIso(),
    documents: documentIds.map(documentName).filter(Boolean),
    questions: [],
    frozen_points: points.map((point) => ({
      id: point.id,
      content: point.content,
      category: point.category,
      bloom_level: point.bloom_level,
      eligible_types: point.eligible_types,
      used: false,
    })),
  };
  refreshQuiz(quiz);
  current().quizzes.unshift(quiz);

  const job = createJob({
    type: "generation",
    stage: "准备生成",
    total,
    quizRecordId: quiz.id,
    payload: {
      document_ids: documentIds,
      quiz_record_id: quiz.id,
      point_ids: pointIds,
      question_config: config,
      consent_id: String(body.consent_id),
      mode: "full",
    },
  });
  void runJob(job.id);
  return { job_id: job.id, quiz_record_id: quiz.id };
}

export function listQuizRecords() {
  const items = [...current().quizzes].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
  return { items: clone(items), total: items.length, page: 1, page_size: 50 };
}

export function getQuizRecord(id: string): QuizRecordDto {
  const quiz = findQuiz(id);
  if (!quiz) throw new EngineError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表");
  return clone(quiz);
}

export function fillMissing(quizId: string, consentId: string) {
  const quiz = findQuiz(quizId);
  if (!quiz) throw new EngineError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表");
  const missing = (quiz.questions ?? []).filter((question) => !question.stem).length;
  if (!missing) throw new EngineError(409, "NOTHING_MISSING", "当前没有缺失的题目。", "返回复核");
  if (!consentId) throw new EngineError(403, "CONSENT_REQUIRED", "请先确认数据发送范围。", "返回 AI 配置");
  const job = createJob({
    type: "generation",
    stage: "准备补题",
    total: missing,
    quizRecordId: quiz.id,
    payload: {
      quiz_record_id: quiz.id,
      point_ids: quiz.frozen_points?.map((point) => point.id) ?? [],
      question_config: quiz.question_config as unknown as QuestionConfig,
      consent_id: consentId,
      mode: "fill",
    },
  });
  void runJob(job.id);
  return { job_id: job.id };
}

export function regenerateQuestion(questionId: string, consentId: string) {
  const found = findQuestion(questionId);
  if (!found) throw new EngineError(404, "QUESTION_NOT_FOUND", "题目不存在。", "刷新页面重试");
  if (!consentId) throw new EngineError(403, "CONSENT_REQUIRED", "请先确认数据发送范围。", "返回 AI 配置");
  const { quiz, question } = found;
  const job = createJob({
    type: "generation",
    stage: "重新生成",
    total: 1,
    quizRecordId: quiz.id,
    payload: {
      quiz_record_id: quiz.id,
      question_id: question.id,
      point_ids: quiz.frozen_points?.map((point) => point.id) ?? [],
      question_config: quiz.question_config as unknown as QuestionConfig,
      consent_id: consentId,
      mode: "regenerate",
    },
  });
  void runJob(job.id);
  return { job_id: job.id };
}

export function quizDeletionImpact(id: string) {
  const quiz = findQuiz(id);
  if (!quiz) throw new EngineError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表");
  return {
    counts: {
      questions: quiz.questions?.length ?? 0,
      exports: current().exports[id]?.length ?? 0,
    },
    deletion_token: `quiz-${id}`,
    message: "删除后该试卷、题目和导出记录将不可恢复。",
  };
}

export function deleteQuizRecord(id: string, token: string) {
  if (token !== `quiz-${id}`) throw new EngineError(403, "INVALID_TOKEN", "删除凭证无效。", "重新打开删除确认");
  current().quizzes = current().quizzes.filter((quiz) => quiz.id !== id);
  delete current().exports[id];
  persist(true);
}

// ---------------------------------------------------------------------------
// 复核
// ---------------------------------------------------------------------------

function revalidate(question: QuestionDto) {
  if (!question.stem) {
    question.validation_state = "pending";
    question.validation_issues = [];
    return;
  }
  const report = validateQuestion({
    question_type: question.question_type,
    stem: question.stem,
    options: question.options,
    answer: question.answer,
    acceptable_answers: question.acceptable_answers,
    explanation: question.explanation,
    point_content: question.source?.point_content ?? "",
    block_text: question.source?.block_text ?? "",
  });
  question.validation_state = report.passed ? "passed" : "failed";
  question.validation_issues = issuesOf(report) as ValidationIssue[];
}

export function patchQuestion(id: string, body: Record<string, unknown>) {
  const found = findQuestion(id);
  if (!found) throw new EngineError(404, "QUESTION_NOT_FOUND", "题目不存在。", "刷新页面重试");
  const { quiz, question } = found;
  if (typeof body.stem === "string") question.stem = body.stem;
  if (typeof body.explanation === "string") question.explanation = body.explanation;
  if (question.question_type === "single_choice") {
    if (Array.isArray(body.options)) {
      question.options = body.options.map((option) => String(option).trim());
    }
    if (typeof body.answer_content === "string") {
      const index = (question.options ?? []).findIndex(
        (option) => normalizeText(option) === normalizeText(String(body.answer_content)),
      );
      question.answer = index >= 0 ? "ABCD"[index] : null;
      if (index < 0) {
        question.validation_state = "failed";
        question.validation_issues = [
          {
            code: "ANSWER_NOT_FOUND",
            message: "正确答案内容必须与某个选项完全一致",
            severity: "blocking",
          },
        ];
      }
    }
  } else if (question.question_type === "true_false") {
    if (typeof body.answer === "string") question.answer = body.answer;
  } else {
    if (typeof body.answer === "string") question.answer = body.answer;
    if (Array.isArray(body.acceptable_answers)) {
      question.acceptable_answers = body.acceptable_answers.map((answer) => String(answer));
    }
  }
  revalidate(question);
  question.review_state = "unreviewed";
  refreshQuiz(quiz);
  persist(true);
  return clone(question);
}

export function reviewQuestion(id: string, decision: "approve" | "reject") {
  const found = findQuestion(id);
  if (!found) throw new EngineError(404, "QUESTION_NOT_FOUND", "题目不存在。", "刷新页面重试");
  const { quiz, question } = found;
  if (decision === "approve" && (!question.stem || question.validation_state !== "passed")) {
    throw new EngineError(409, "QUESTION_NOT_VALID", "未通过程序校验的题目不能直接通过。", "先修正题目");
  }
  question.review_state = decision === "approve" ? "approved" : "rejected";
  refreshQuiz(quiz);
  persist();
  return clone(question);
}

export function deleteQuestion(id: string) {
  const found = findQuestion(id);
  if (!found) throw new EngineError(404, "QUESTION_NOT_FOUND", "题目不存在。", "刷新页面重试");
  const { quiz, question } = found;
  question.stem = null;
  question.options = null;
  question.answer = null;
  question.acceptable_answers = null;
  question.explanation = null;
  question.knowledge_point_id = null;
  question.source = null;
  question.validation_state = "pending";
  question.validation_issues = [];
  question.review_state = "unreviewed";
  refreshQuiz(quiz);
  persist(true);
}

export function bulkReview(quizId: string, ids: string[]) {
  const quiz = findQuiz(quizId);
  if (!quiz) throw new EngineError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表");
  const set = new Set(ids);
  let approved = 0;
  for (const question of quiz.questions ?? []) {
    if (set.has(question.id) && question.stem && question.validation_state === "passed") {
      question.review_state = "approved";
      approved += 1;
    }
  }
  refreshQuiz(quiz);
  persist(true);
  return { approved };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

function checkExportGate(quiz: QuizRecordDto) {
  const questions = quiz.questions ?? [];
  const config = quiz.question_config as unknown as QuestionConfig;
  const expected = totalQuestions(config);
  if (questions.length !== expected) {
    throw new EngineError(409, "EXPORT_NOT_READY", `题目数量与配置不一致（${questions.length}/${expected}）。`, "返回复核");
  }
  for (const type of ["single_choice", "true_false", "fill_blank"] as const) {
    const count = questions.filter((question) => question.question_type === type).length;
    if (count !== Number(config[type] || 0)) {
      throw new EngineError(409, "EXPORT_NOT_READY", "题型数量与配置不一致。", "返回复核");
    }
  }
  const blocked = questions.filter(
    (question) => !question.stem || question.validation_state !== "passed" || question.review_state !== "approved",
  );
  if (blocked.length) {
    throw new EngineError(409, "EXPORT_NOT_READY", `还有 ${blocked.length} 道题未通过校验或人工复核。`, "返回复核");
  }
}

function exportFilename(kind: "student" | "answer"): string {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  return `AI出题精灵_${stamp}_${kind === "student" ? "题目版" : "答案版"}.docx`;
}

function bindBlob(file: ExportFileRecord, blob: Blob) {
  const previous = blobUrls.get(file.id);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(blob);
  blobUrls.set(file.id, url);
  blobCache.set(file.id, blob);
  file.download_url = url;
}

async function hydrateExports(quizId: string) {
  const quiz = findQuiz(quizId);
  const files = current().exports[quizId] ?? [];
  if (!quiz) return;
  for (const file of files) {
    if (file.download_url) continue;
    const blob = await buildExportBlob(quiz, file.kind);
    bindBlob(file, blob);
  }
}

export async function listExports(quizId: string) {
  await hydrateExports(quizId);
  const files = current().exports[quizId] ?? [];
  const batches = new Map<string, ExportFileRecord[]>();
  for (const file of files) {
    const list = batches.get(file.batch_id) ?? [];
    list.push(file);
    batches.set(file.batch_id, list);
  }
  const items = [...batches.entries()].map(([batchId, batchFiles]) => ({
    batch_id: batchId,
    files: clone(batchFiles),
    is_current: batchFiles.some((file) => file.is_current),
  }));
  return { items };
}

export async function createExports(quizId: string) {
  const quiz = findQuiz(quizId);
  if (!quiz) throw new EngineError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表");
  checkExportGate(quiz);
  const batchId = newId("batch");
  const records: ExportFileRecord[] = [];
  for (const kind of ["student", "answer"] as const) {
    const blob = await buildExportBlob(quiz, kind);
    const file: ExportFileRecord = {
      id: newId("export"),
      batch_id: batchId,
      kind,
      filename: exportFilename(kind),
      download_url: "",
      is_current: true,
      created_at: nowIso(),
    };
    bindBlob(file, blob);
    records.push(file);
  }
  for (const file of current().exports[quizId] ?? []) file.is_current = false;
  current().exports[quizId] = [...records, ...(current().exports[quizId] ?? [])];
  quiz.status = "exported";
  quiz.updated_at = nowIso();
  persist(true);
  const toDto = (file: ExportFileRecord): ExportFileDto => {
    const { batch_id: _batch, ...dto } = file;
    return clone(dto);
  };
  return { student: toDto(records[0]), answer: toDto(records[1]) };
}
