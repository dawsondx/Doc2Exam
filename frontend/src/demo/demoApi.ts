import type { ExportFileDto } from "../api/endpoints";
import type {
  AIProfileDto,
  ConsentDto,
  ConsentStatusDto,
  DocumentDto,
  JobDto,
  KnowledgePointDto,
  QuestionDto,
  QuizRecordDto,
} from "../types/api";
import {
  buildQuestions,
  buildQuiz,
  demoDocuments,
  demoExportFileNames,
  demoPointBase,
  demoProfiles,
  DEMO_PROFILE_ID,
} from "./fixtures";

interface ExportBatch {
  batch_id: string;
  files: ExportFileDto[];
  is_current: boolean;
}

interface StoredJob extends JobDto {
  startedAt: number;
  duration: number;
  finalized: boolean;
  onComplete?: () => void;
}

const state = {
  documents: [...demoDocuments] as DocumentDto[],
  profiles: [...demoProfiles] as AIProfileDto[],
  consents: {} as Record<string, ConsentDto>,
  jobs: [] as StoredJob[],
  points: [] as KnowledgePointDto[],
  quiz: null as QuizRecordDto | null,
  historical: [] as QuizRecordDto[],
  exports: {} as Record<string, ExportBatch[]>,
};

let jobSequence = 0;
let documentSequence = 0;
let batchSequence = 0;

const nowIso = () => new Date().toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-AI-Quiz-Mock": "1" },
  });
}

function fail(status: number, message: string, code = "DEMO_ERROR", action = "请重试") {
  return json({ error: { code, message, action, request_id: "demo" } }, status);
}

function jobDto(job: StoredJob): JobDto {
  const { startedAt: _startedAt, duration: _duration, finalized: _finalized, onComplete: _onComplete, ...dto } = job;
  return clone(dto);
}

function stageFor(job: StoredJob, progress: number): string {
  if (job.status === "completed") return "已完成";
  if (job.status === "cancelled") return "已取消";
  if (job.job_type === "extraction") {
    if (progress < 0.18) return "切分文本块";
    if (progress < 0.52) return "提取原子考点";
    if (progress < 0.86) return "校验考点与出处";
    return "汇总候选考点";
  }
  if (job.job_type === "generation") {
    if (progress < 0.12) return "建立题目槽位";
    if (progress < 0.88) return `生成第 ${job.current} / ${job.total} 题`;
    return "校验题目与答案";
  }
  return job.stage;
}

function tick() {
  const now = Date.now();
  for (const job of state.jobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    if (now < job.startedAt) continue;
    job.status = "running";
    const progress = Math.min(1, (now - job.startedAt) / job.duration);
    job.current = Math.max(0, Math.min(job.total, Math.floor(progress * job.total)));
    job.stage = stageFor(job, progress);
    job.updated_at = nowIso();
    if (progress >= 1 && !job.finalized) {
      job.finalized = true;
      job.status = "completed";
      job.current = job.total;
      job.stage = "已完成";
      job.finished_at = nowIso();
      job.onComplete?.();
      job.onComplete = undefined;
    }
  }
}

function createJob(input: {
  type: JobDto["job_type"];
  total: number;
  duration: number;
  stage: string;
  documentId?: string | null;
  quizRecordId?: string | null;
  profileId?: string | null;
  onComplete?: () => void;
}): StoredJob {
  jobSequence += 1;
  const job: StoredJob = {
    id: `demo-job-${input.type}-${jobSequence}`,
    job_type: input.type,
    status: "queued",
    document_id: input.documentId ?? null,
    quiz_record_id: input.quizRecordId ?? null,
    ai_profile_id: input.profileId ?? DEMO_PROFILE_ID,
    stage: input.stage,
    current: 0,
    total: input.total,
    error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    finished_at: null,
    startedAt: Date.now() + 250,
    duration: input.duration,
    finalized: false,
    onComplete: input.onComplete,
  };
  state.jobs.unshift(job);
  state.jobs = state.jobs.slice(0, 30);
  return job;
}

function refreshQuizProgress() {
  const quiz = state.quiz;
  if (!quiz) return;
  const questions = quiz.questions ?? [];
  const target = Object.values(quiz.question_config ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const approved = questions.filter((q) => q.review_state === "approved").length;
  const rejected = questions.filter((q) => q.review_state === "rejected").length;
  const missing = questions.filter((q) => !q.stem).length;
  const unreviewed = questions.filter((q) => q.review_state === "unreviewed" && q.stem).length;
  quiz.progress = {
    target,
    approved,
    unreviewed,
    rejected,
    missing,
    export_ready: target > 0 && approved >= target && missing === 0,
  };
  if (quiz.status !== "exported") {
    quiz.status = quiz.progress.export_ready ? "ready" : "draft";
  }
  quiz.updated_at = nowIso();
}

function buildPointSet(jobId: string, target: number): KnowledgePointDto[] {
  const count = Math.max(demoPointBase.length, target * 2);
  return Array.from({ length: count }, (_, index) => {
    const base = demoPointBase[index % demoPointBase.length];
    return {
      ...clone(base),
      id: `point-${jobId}-${index + 1}`,
      extraction_job_id: jobId,
      selected: index < target,
      created_at: nowIso(),
    };
  });
}

function startExtraction(body: Record<string, unknown>) {
  const config = (body.question_config ?? {}) as Record<string, number>;
  const total = Number(body.target_question_count ?? 10) ||
    Number(config.single_choice ?? 0) + Number(config.true_false ?? 0) + Number(config.fill_blank ?? 0);
  const job = createJob({
    type: "extraction",
    total: Math.max(4, Math.min(12, Math.round(total / 2))),
    duration: 5600,
    stage: "准备抽取",
    profileId: String(body.ai_profile_id ?? DEMO_PROFILE_ID),
    onComplete: () => {
      state.points = buildPointSet(job.id, total);
    },
  });
  return job;
}

function nextQuestionSeed(type: QuestionDto["question_type"], offset: number): QuestionDto {
  const templates = buildQuestions([], { single_choice: 100, true_false: 100, fill_blank: 100 }).filter(
    (q) => q.question_type === type,
  );
  const source = templates[offset % templates.length];
  return clone(source);
}

function startGeneration(input: {
  config: Record<string, number>;
  selectedPointIds: string[];
  quizId?: string;
  singleSlot?: QuestionDto;
}) {
  const config = input.config;
  const total = Object.values(config).reduce((sum, value) => sum + Number(value || 0), 0);
  let quiz = state.quiz;
  if (input.quizId) {
    quiz = quiz && quiz.id === input.quizId ? quiz : state.historical.find((item) => item.id === input.quizId) ?? null;
  }
  if (!quiz) {
    quiz = buildQuiz([], config);
    quiz.questions = [];
    state.quiz = quiz;
  }
  quiz.question_config = quiz.question_config ?? config;
  for (const key of ["single_choice", "true_false", "fill_blank"]) {
    quiz.question_config[key] = Number(config[key] ?? quiz.question_config[key] ?? 0);
  }
  const job = createJob({
    type: "generation",
    total: Math.max(1, total),
    duration: total <= 1 ? 2600 : 7600,
    stage: "准备生成",
    quizRecordId: quiz.id,
    onComplete: () => {
      const questions = input.singleSlot
        ? (quiz?.questions ?? []).map((question) =>
            question.id === input.singleSlot?.id ? { ...clone(input.singleSlot), attempt_count: question.attempt_count + 1 } : question,
          )
        : buildQuestions(input.selectedPointIds, config);
      if (quiz) {
        quiz.questions = questions;
        quiz.status = "draft";
        refreshQuizProgress();
      }
    },
  });
  return { job, quiz };
}

function ensureHistorical() {
  if (state.historical.length) return;
  const config = { single_choice: 4, true_false: 3, fill_blank: 3 };
  const questions = buildQuestions(
    demoPointBase.slice(0, 10).map((point) => point.id),
    config,
  ).map((question) => ({
    ...question,
    quiz_record_id: "quiz-archive-01",
    review_state: "approved" as const,
  }));
  const archive = buildQuiz(questions, config);
  archive.id = "quiz-archive-01";
  archive.status = "exported";
  archive.created_at = "2026-09-28T14:20:00Z";
  archive.updated_at = "2026-09-28T15:02:00Z";
  archive.ai_profile_name = "培训专用 · 内部大模型";
  archive.model_name = "qwen3-72b-instruct";
  refreshProgressFor(archive);
  state.historical.push(archive);
  state.exports[archive.id] = [makeExportBatch(archive.id, true)];
}

function refreshProgressFor(quiz: QuizRecordDto) {
  const questions = quiz.questions ?? [];
  const target = Object.values(quiz.question_config ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const approved = questions.filter((q) => q.review_state === "approved").length;
  quiz.progress = {
    target,
    approved,
    unreviewed: questions.filter((q) => q.review_state === "unreviewed" && q.stem).length,
    rejected: questions.filter((q) => q.review_state === "rejected").length,
    missing: questions.filter((q) => !q.stem).length,
    export_ready: target > 0 && approved >= target,
  };
}

function makeExportBatch(quizId: string, current: boolean): ExportBatch {
  batchSequence += 1;
  const files: ExportFileDto[] = [
    {
      id: `${quizId}-student-${batchSequence}`,
      kind: "student",
      filename: demoExportFileNames.student,
      download_url: "/demo/题目版_示例.docx",
      is_current: current,
      created_at: nowIso(),
    },
    {
      id: `${quizId}-answer-${batchSequence}`,
      kind: "answer",
      filename: demoExportFileNames.answer,
      download_url: "/demo/答案版_示例.docx",
      is_current: current,
      created_at: nowIso(),
    },
  ];
  return { batch_id: `batch-${batchSequence}`, files, is_current: current };
}

function findQuestion(id: string): QuestionDto | null {
  return state.quiz?.questions?.find((question) => question.id === id) ?? null;
}

function quizList(): QuizRecordDto[] {
  const list: QuizRecordDto[] = [];
  if (state.quiz) list.push(state.quiz);
  list.push(...state.historical);
  return list.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

function handleUpload(init: RequestInit) {
  const form = init.body as FormData;
  const files = form.getAll("files").filter((item): item is File => item instanceof File);
  if (!files.length) return fail(400, "没有收到文件", "NO_FILES", "请选择 PDF 或 DOCX 文件");
  const created = files.map((file) => {
    documentSequence += 1;
    const isPdf = file.name.toLowerCase().endsWith(".pdf");
    const doc: DocumentDto = {
      id: `doc-upload-${documentSequence}`,
      original_name: file.name,
      media_type: isPdf ? "pdf" : "docx",
      size_bytes: file.size || 1024 * 1024,
      page_count: null,
      block_count: 0,
      parse_status: "running",
      parse_error: null,
      created_at: nowIso(),
      preview: undefined,
    };
    state.documents.unshift(doc);
    window.setTimeout(() => {
      doc.parse_status = "ready";
      doc.page_count = isPdf ? 18 : null;
      doc.block_count = 42;
      doc.preview =
        "演示解析结果：本文件为交互演示生成，不包含真实文档内容。系统会把文档切分为可追溯的文本块，并为每个考点保留页码或标题路径。";
    }, 1500);
    return { document: doc, job_id: "demo-job-parse" };
  });
  return json({ items: created });
}

function handleRoute(url: URL, method: string, init: RequestInit): Response | Promise<Response> {
  tick();
  const path = url.pathname;
  const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;

  if (path === "/api/health") {
    return json({ status: "ok", app: "AI 出题精灵（演示）", version: "1.1.0-demo" });
  }

  if (path === "/api/documents") {
    if (method === "GET") return json({ items: clone(state.documents), total: state.documents.length, page: 1, page_size: 50 });
    if (method === "POST") return handleUpload(init);
  }

  const docImpact = path.match(/^\/api\/documents\/([^/]+)\/deletion-impact$/);
  if (docImpact && method === "GET") {
    return json({
      can_delete: true,
      blocking_quiz_record_ids: [],
      counts: { source_blocks: 42, parse_jobs: 1, extraction_jobs: 1, unfrozen_knowledge_points: 0 },
      deletion_token: "demo-delete-doc",
      message: "删除后，该文档的解析结果与未冻结考点将一并移除。",
    });
  }
  const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch) {
    const doc = state.documents.find((item) => item.id === docMatch[1]);
    if (!doc) return fail(404, "文档不存在", "NOT_FOUND", "刷新页面后重试");
    if (method === "GET") return json(clone(doc));
    if (method === "DELETE") {
      state.documents = state.documents.filter((item) => item.id !== doc.id);
      return new Response(null, { status: 204 });
    }
  }

  if (path === "/api/jobs" && method === "GET") {
    return json({ items: state.jobs.map(jobDto), total: state.jobs.length, page: 1, page_size: 50 });
  }
  const jobAction = path.match(/^\/api\/jobs\/([^/]+)\/(cancel|resume)$/);
  if (jobAction) {
    const job = state.jobs.find((item) => item.id === jobAction[1]);
    if (!job) return fail(404, "任务不存在", "NOT_FOUND", "刷新页面后重试");
    if (jobAction[2] === "cancel") {
      job.status = "cancelled";
      job.stage = "已取消";
      job.finished_at = nowIso();
      job.onComplete = undefined;
      return json({ status: job.status });
    }
    job.status = "running";
    job.startedAt = Date.now() - job.duration * 0.25;
    job.finalized = false;
    return json({ job_id: job.id, status: job.status });
  }
  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && method === "GET") {
    const job = state.jobs.find((item) => item.id === jobMatch[1]);
    if (!job) return fail(404, "任务不存在", "NOT_FOUND", "刷新页面后重试");
    return json(jobDto(job));
  }

  if (path === "/api/ai-profiles") {
    if (method === "GET") return json({ items: clone(state.profiles), total: state.profiles.length, page: 1, page_size: 50 });
    if (method === "POST" && body) {
      const profile: AIProfileDto = {
        id: `profile-demo-${state.profiles.length + 1}`,
        name: String(body.name ?? "新配置"),
        base_url: String(body.base_url ?? ""),
        model: String(body.model ?? ""),
        api_mode: (body.api_mode as AIProfileDto["api_mode"]) ?? "chat_completions",
        context_window: Number(body.context_window ?? 32768),
        max_output_tokens: Number(body.max_output_tokens ?? 4096),
        max_concurrency: Number(body.max_concurrency ?? 4),
        input_price_per_million: body.input_price_per_million === null ? null : Number(body.input_price_per_million),
        output_price_per_million: body.output_price_per_million === null ? null : Number(body.output_price_per_million),
        price_currency: String(body.price_currency ?? "USD"),
        has_api_key: Boolean(body.api_key),
        last_probe_at: null,
        compatible: false,
        credential_storage: "system",
        profile_fingerprint: `fp_demo_${Date.now()}`,
      };
      state.profiles.push(profile);
      return json(clone(profile));
    }
  }
  const profileProbe = path.match(/^\/api\/ai-profiles\/([^/]+)\/probe$/);
  if (profileProbe && method === "POST") {
    const profile = state.profiles.find((item) => item.id === profileProbe[1]);
    if (!profile) return fail(404, "配置不存在", "NOT_FOUND", "刷新页面后重试");
    profile.compatible = true;
    profile.last_probe_at = nowIso();
    profile.probe_verdict = "4/4 探测通过";
    profile.capabilities = {
      text_generation: "supported",
      json_schema: "supported",
      json_object: "supported",
      plain_json: "supported",
      models_list: "supported",
      usage: "supported",
      tokenizer_known: true,
      preferred_output_mode: "json_schema",
    };
    return json(clone(profile));
  }
  const profileImpact = path.match(/^\/api\/ai-profiles\/([^/]+)\/deletion-impact$/);
  if (profileImpact && method === "GET") {
    return json({
      counts: { extraction_jobs: 1, generation_jobs: 1, quiz_records: 0 },
      deletion_token: "demo-delete-profile",
      message: "历史试卷将保留，配置关联信息会解除。",
    });
  }
  const profileMatch = path.match(/^\/api\/ai-profiles\/([^/]+)$/);
  if (profileMatch) {
    const index = state.profiles.findIndex((item) => item.id === profileMatch[1]);
    if (index < 0) return fail(404, "配置不存在", "NOT_FOUND", "刷新页面后重试");
    if (method === "PATCH" && body) {
      const profile = state.profiles[index];
      state.profiles[index] = {
        ...profile,
        name: String(body.name ?? profile.name),
        base_url: String(body.base_url ?? profile.base_url),
        model: String(body.model ?? profile.model),
        api_mode: (body.api_mode as AIProfileDto["api_mode"]) ?? profile.api_mode,
        context_window: Number(body.context_window ?? profile.context_window),
        max_output_tokens: Number(body.max_output_tokens ?? profile.max_output_tokens),
        max_concurrency: Number(body.max_concurrency ?? profile.max_concurrency),
        input_price_per_million:
          body.input_price_per_million === null ? null : Number(body.input_price_per_million ?? profile.input_price_per_million),
        output_price_per_million:
          body.output_price_per_million === null ? null : Number(body.output_price_per_million ?? profile.output_price_per_million),
        price_currency: String(body.price_currency ?? profile.price_currency),
        compatible: false,
        last_probe_at: null,
      };
      return json(clone(state.profiles[index]));
    }
    if (method === "DELETE") {
      state.profiles.splice(index, 1);
      return new Response(null, { status: 204 });
    }
  }

  if (path === "/api/data-sharing-consents") {
    const profileId = url.searchParams.get("ai_profile_id") ?? "";
    if (method === "GET") {
      const profile = state.profiles.find((item) => item.id === profileId);
      const payload: ConsentStatusDto = {
        ai_profile_id: profileId,
        profile_fingerprint: profile?.profile_fingerprint ?? "",
        consent: state.consents[profileId] ?? null,
      };
      return json(payload);
    }
    if (method === "POST" && body) {
      const id = String(body.ai_profile_id ?? "");
      const consent: ConsentDto = {
        id: `consent-demo-${id}`,
        profile_fingerprint: state.profiles.find((profile) => profile.id === id)?.profile_fingerprint ?? "",
        consented_at: nowIso(),
        revoked_at: null,
      };
      state.consents[id] = consent;
      return json(clone(consent));
    }
  }
  const revoke = path.match(/^\/api\/data-sharing-consents\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") {
    for (const key of Object.keys(state.consents)) {
      if (state.consents[key].id === revoke[1]) delete state.consents[key];
    }
    return json({ id: revoke[1] });
  }

  if (path === "/api/estimates" && method === "POST" && body) {
    const config = (body.question_config ?? {}) as Record<string, number>;
    const total = Object.values(config).reduce((sum, value) => sum + Number(value || 0), 0);
    const documents = Array.isArray(body.document_ids) ? body.document_ids.length : 1;
    const input = documents * 1200 + total * 4200;
    const output = total * 380;
    return json({
      estimated_input_tokens: input,
      estimated_output_tokens: output,
      estimated_cost: {
        value: Number(((input / 1_000_000) * 4 + (output / 1_000_000) * 12).toFixed(2)),
        currency: "CNY",
        available: true,
        reason: null,
      },
    });
  }

  if (path === "/api/extraction-jobs" && method === "POST" && body) {
    const job = startExtraction(body);
    return json({ job_id: job.id });
  }
  const extractPoints = path.match(/^\/api\/extraction-jobs\/([^/]+)\/points$/);
  if (extractPoints && method === "GET") {
    const points = state.points.filter((point) => point.extraction_job_id === extractPoints[1]);
    return json({ items: clone(points), total: points.length, page: 1, page_size: 100 });
  }
  const extractionJob = path.match(/^\/api\/extraction-jobs\/([^/]+)$/);
  if (extractionJob && method === "GET") {
    const job = state.jobs.find((item) => item.id === extractionJob[1]);
    if (!job) return fail(404, "任务不存在", "NOT_FOUND", "刷新页面后重试");
    return json(jobDto(job));
  }

  const pointMatch = path.match(/^\/api\/knowledge-points\/([^/]+)$/);
  if (pointMatch && method === "PATCH" && body) {
    const point = state.points.find((item) => item.id === pointMatch[1]);
    if (!point) return fail(404, "考点不存在", "NOT_FOUND", "刷新页面后重试");
    point.selected = Boolean(body.selected);
    return json(clone(point));
  }
  if (path === "/api/knowledge-points/bulk-selection" && method === "POST" && body) {
    const ids = new Set(Array.isArray(body.point_ids) ? body.point_ids.map(String) : []);
    let updated = 0;
    for (const point of state.points) {
      if (ids.has(point.id)) {
        point.selected = Boolean(body.selected);
        updated += 1;
      }
    }
    return json({ updated });
  }

  if (path === "/api/generation-jobs" && method === "POST" && body) {
    const config = (body.question_config ?? {}) as Record<string, number>;
    const selected = Array.isArray(body.selected_point_ids) ? body.selected_point_ids.map(String) : [];
    const result = startGeneration({ config, selectedPointIds: selected });
    return json({ job_id: result.job.id, quiz_record_id: result.quiz?.id ?? "quiz-demo" });
  }

  if (path === "/api/quiz-records" && method === "GET") {
    const list = quizList();
    return json({ items: clone(list), total: list.length, page: 1, page_size: 50 });
  }
  const quizExports = path.match(/^\/api\/quiz-records\/([^/]+)\/exports$/);
  if (quizExports) {
    const quizId = quizExports[1];
    if (method === "GET") {
      return json({ items: clone(state.exports[quizId] ?? []) });
    }
    if (method === "POST") {
      ensureHistorical();
      const previous = state.exports[quizId] ?? [];
      previous.forEach((batch) => batch.files.forEach((file) => (file.is_current = false)));
      const batch = makeExportBatch(quizId, true);
      state.exports[quizId] = [batch, ...previous];
      const quiz = state.quiz?.id === quizId ? state.quiz : state.historical.find((item) => item.id === quizId);
      if (quiz) {
        quiz.status = "exported";
        quiz.updated_at = nowIso();
      }
      return json({ student: batch.files[0], answer: batch.files[1] });
    }
  }
  const bulkReview = path.match(/^\/api\/quiz-records\/([^/]+)\/reviews\/bulk$/);
  if (bulkReview && method === "POST" && body) {
    const ids = new Set(Array.isArray(body.question_ids) ? body.question_ids.map(String) : []);
    let approved = 0;
    for (const question of state.quiz?.questions ?? []) {
      if (ids.has(question.id) && question.validation_state === "passed" && question.stem) {
        question.review_state = "approved";
        approved += 1;
      }
    }
    refreshQuizProgress();
    return json({ approved });
  }
  const fillMissing = path.match(/^\/api\/quiz-records\/([^/]+)\/fill-missing$/);
  if (fillMissing && method === "POST") {
    const quiz = state.quiz;
    const missing = (quiz?.questions ?? []).filter((question) => !question.stem);
    const job = createJob({
      type: "generation",
      total: Math.max(1, missing.length),
      duration: 3000,
      stage: "补位生成",
      quizRecordId: quiz?.id,
      onComplete: () => {
        if (!quiz) return;
        let offset = 0;
        for (const question of quiz.questions ?? []) {
          if (question.stem) continue;
          const seed = nextQuestionSeed(question.question_type, offset);
          offset += 1;
          Object.assign(question, {
            stem: seed.stem,
            options: seed.options,
            answer: seed.answer,
            acceptable_answers: seed.acceptable_answers,
            explanation: seed.explanation,
            source: seed.source,
            validation_state: "passed",
            validation_issues: [],
            review_state: "unreviewed",
            attempt_count: 1,
          });
        }
        refreshQuizProgress();
      },
    });
    return json({ job_id: job.id });
  }
  const quizImpact = path.match(/^\/api\/quiz-records\/([^/]+)\/deletion-impact$/);
  if (quizImpact && method === "GET") {
    return json({
      counts: { questions: 10, answers: 10, exports: 2 },
      deletion_token: "demo-delete-quiz",
      message: "删除后该试卷、题目和导出记录将不可恢复。",
    });
  }
  const quizMatch = path.match(/^\/api\/quiz-records\/([^/]+)$/);
  if (quizMatch) {
    const quiz = state.quiz?.id === quizMatch[1] ? state.quiz : state.historical.find((item) => item.id === quizMatch[1]);
    if (!quiz) return fail(404, "试卷不存在", "NOT_FOUND", "刷新页面后重试");
    if (method === "GET") return json(clone(quiz));
    if (method === "DELETE") {
      if (state.quiz?.id === quiz.id) state.quiz = null;
      state.historical = state.historical.filter((item) => item.id !== quiz.id);
      return new Response(null, { status: 204 });
    }
  }

  const questionReview = path.match(/^\/api\/questions\/([^/]+)\/review$/);
  if (questionReview && method === "POST" && body) {
    const question = findQuestion(questionReview[1]);
    if (!question) return fail(404, "题目不存在", "NOT_FOUND", "刷新页面后重试");
    question.review_state = body.decision === "approve" ? "approved" : "rejected";
    refreshQuizProgress();
    return json(clone(question));
  }
  const regenerate = path.match(/^\/api\/questions\/([^/]+)\/regenerate$/);
  if (regenerate && method === "POST") {
    const question = findQuestion(regenerate[1]);
    if (!question) return fail(404, "题目不存在", "NOT_FOUND", "刷新页面后重试");
    const replacement = nextQuestionSeed(question.question_type, question.slot_number + 3);
    replacement.id = question.id;
    replacement.slot_number = question.slot_number;
    replacement.knowledge_point_id = question.knowledge_point_id;
    const job = createJob({
      type: "generation",
      total: 1,
      duration: 2600,
      stage: "重新生成",
      quizRecordId: state.quiz?.id,
      onComplete: () => {
        const target = findQuestion(question.id);
        if (!target) return;
        Object.assign(target, {
          ...replacement,
          attempt_count: target.attempt_count + 1,
          review_state: "unreviewed",
        });
        refreshQuizProgress();
      },
    });
    return json({ job_id: job.id });
  }
  const questionMatch = path.match(/^\/api\/questions\/([^/]+)$/);
  if (questionMatch) {
    const question = findQuestion(questionMatch[1]);
    if (!question) return fail(404, "题目不存在", "NOT_FOUND", "刷新页面后重试");
    if (method === "PATCH" && body) {
      question.stem = typeof body.stem === "string" ? body.stem : question.stem;
      question.explanation = typeof body.explanation === "string" ? body.explanation : question.explanation;
      if (question.question_type === "single_choice") {
        if (Array.isArray(body.options)) question.options = body.options.map(String);
        const content = String(body.answer_content ?? "");
        const index = (question.options ?? []).findIndex((option) => option === content);
        question.answer = index >= 0 ? "ABCD"[index] : question.answer;
        if (index < 0) {
          question.validation_state = "failed";
          question.validation_issues = [
            { code: "ANSWER_NOT_FOUND", message: "正确答案内容必须与某个选项完全一致", severity: "blocking" },
          ];
        } else {
          question.validation_state = "passed";
          question.validation_issues = [];
        }
      } else if (question.question_type === "true_false") {
        question.answer = String(body.answer ?? question.answer);
        question.validation_state = "passed";
        question.validation_issues = [];
      } else {
        question.answer = String(body.answer ?? question.answer);
        question.acceptable_answers = Array.isArray(body.acceptable_answers)
          ? body.acceptable_answers.map(String)
          : question.acceptable_answers;
        question.validation_state = "passed";
        question.validation_issues = [];
      }
      question.review_state = "unreviewed";
      refreshQuizProgress();
      return json(clone(question));
    }
    if (method === "DELETE") {
      question.stem = null;
      question.options = null;
      question.answer = null;
      question.acceptable_answers = null;
      question.explanation = null;
      question.validation_state = "pending";
      question.validation_issues = [];
      question.review_state = "unreviewed";
      question.knowledge_point_id = null;
      refreshQuizProgress();
      return new Response(null, { status: 204 });
    }
  }

  const generationJob = path.match(/^\/api\/generation-jobs\/([^/]+)$/);
  if (generationJob && method === "GET") {
    const job = state.jobs.find((item) => item.id === generationJob[1]);
    if (!job) return fail(404, "任务不存在", "NOT_FOUND", "刷新页面后重试");
    return json(jobDto(job));
  }

  return fail(404, `演示环境未实现接口：${method} ${path}`, "DEMO_ROUTE_MISSING", "这是演示版限制");
}

export function installDemoApi() {
  if (typeof window === "undefined") return;
  state.points = [];
  state.quiz = null;
  state.jobs = [];
  state.historical = [];
  state.exports = {};
  state.consents = {};
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (url.pathname.startsWith("/api/")) {
      const method = (init.method ?? "GET").toUpperCase();
      const response = await handleRoute(url, method, init);
      return response;
    }
    return originalFetch(input, init);
  };
}
