import type { ExportFileDto } from "../api/endpoints";
import type {
  AIProfileDto,
  DocumentDto,
  JobDto,
  KnowledgePointDto,
  QuizRecordDto,
} from "../types/api";

export const PUBLIC_PROFILE_ID = "public-byok";

export interface AiBlock {
  id: string;
  text: string;
}

export type AiTask =
  | { kind: "extraction"; blocks: AiBlock[]; quota: number; repair_errors?: string }
  | {
      kind: "question";
      question_type: "single_choice" | "true_false" | "fill_blank";
      point_content: string;
      block_text: string;
      target_answer_hint?: string | null;
      target_answer?: boolean | null;
      repair_errors?: string;
    }
  | { kind: "probe" };

export const PUBLIC_LIMITS = {
  maxFiles: 3,
  maxFileBytes: 15 * 1024 * 1024,
  maxDocumentChars: 60_000,
  maxPdfPages: 200,
  maxQuestions: 30,
  maxPerType: 15,
  chunkTokens: 4_000,
  maxExtractionChars: 24_000,
  maxStoredDocuments: 9,
} as const;

export const DEFAULT_CONFIG = { single_choice: 6, true_false: 3, fill_blank: 3 };

export interface SourceBlock {
  id: string;
  document_id: string;
  ordinal: number;
  locator_kind: string;
  locator_label: string;
  page_number: number | null;
  text: string;
  normalized_text: string;
  estimated_tokens: number;
}

export interface StoredDocument {
  dto: DocumentDto;
  blocks: SourceBlock[];
}

export type PublicJobType = JobDto["job_type"];

export interface QuestionConfig {
  single_choice: number;
  true_false: number;
  fill_blank: number;
}

export interface JobPayload {
  document_ids?: string[];
  quiz_record_id?: string;
  point_ids?: string[];
  question_config?: QuestionConfig;
  consent_id?: string;
  question_id?: string;
  target_question_count?: number;
  mode?: "full" | "fill" | "regenerate";
}

export interface StoredJob extends JobDto {
  payload: JobPayload;
}

export interface ExportFileRecord extends ExportFileDto {
  batch_id: string;
}

export interface PublicState {
  version: 1;
  documents: StoredDocument[];
  jobs: StoredJob[];
  points: KnowledgePointDto[];
  quizzes: QuizRecordDto[];
  exports: Record<string, ExportFileRecord[]>;
  consents: Record<string, { id: string; consented_at: string; fingerprint: string }>;
}

export function emptyState(): PublicState {
  return {
    version: 1,
    documents: [],
    jobs: [],
    points: [],
    quizzes: [],
    exports: {},
    consents: {},
  };
}

export class EngineError extends Error {
  status: number;
  code: string;
  action: string;

  constructor(status: number, code: string, message: string, action = "请重试") {
    super(message);
    this.status = status;
    this.code = code;
    this.action = action;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function totalQuestions(config: QuestionConfig): number {
  return (
    Number(config.single_choice || 0) +
    Number(config.true_false || 0) +
    Number(config.fill_blank || 0)
  );
}

export function clampConfig(raw: unknown): QuestionConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const pick = (key: string) =>
    Math.max(0, Math.min(PUBLIC_LIMITS.maxPerType, Math.floor(Number(source[key]) || 0)));
  const config = {
    single_choice: pick("single_choice"),
    true_false: pick("true_false"),
    fill_blank: pick("fill_blank"),
  };
  const total = totalQuestions(config);
  if (total <= PUBLIC_LIMITS.maxQuestions) return config;
  const scale = PUBLIC_LIMITS.maxQuestions / total;
  const scaled = {
    single_choice: Math.floor(config.single_choice * scale),
    true_false: Math.floor(config.true_false * scale),
    fill_blank: Math.floor(config.fill_blank * scale),
  };
  let rest = PUBLIC_LIMITS.maxQuestions - totalQuestions(scaled);
  const order: (keyof QuestionConfig)[] = ["single_choice", "true_false", "fill_blank"];
  for (const key of order) {
    while (rest > 0 && scaled[key] < config[key]) {
      scaled[key] += 1;
      rest -= 1;
    }
  }
  return scaled;
}

export interface PublicAiSummary {
  provider_label: string;
  base_url: string;
  model: string;
  ready: boolean;
  mock: boolean;
  fingerprint: string;
  probe_at: string | null;
  error?: string;
}

export function publicProfile(summary: PublicAiSummary): AIProfileDto {
  const { provider_label, base_url, model, ready, mock, fingerprint, probe_at, error } = summary;
  return {
    id: PUBLIC_PROFILE_ID,
    name: mock ? "本地模拟 AI" : `自带 Key · ${provider_label}`,
    base_url: mock ? "本地模拟模式 · 不访问网络" : base_url || "尚未配置服务地址",
    model: model || "尚未选择模型",
    api_mode: "chat_completions",
    context_window: 32768,
    max_output_tokens: 4096,
    max_concurrency: 1,
    input_price_per_million: null,
    output_price_per_million: null,
    price_currency: "USD",
    has_api_key: ready,
    last_probe_at: probe_at,
    compatible: ready,
    credential_storage: "browser",
    profile_fingerprint: fingerprint,
    capabilities: {
      text_generation: ready ? "supported" : "unknown",
      json_schema: "unknown",
      json_object: ready ? "supported" : "unknown",
      plain_json: "unknown",
      models_list: "unknown",
      usage: "supported",
      tokenizer_known: false,
      preferred_output_mode: "json_object",
      ...(error ? { _error: error } : {}),
    },
    probe_verdict: mock
      ? "本地模拟模型已就绪"
      : ready
        ? probe_at
          ? "连接测试已通过"
          : "Key 已保存在浏览器，建议先测试连接"
        : undefined,
    probe_error: error,
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
