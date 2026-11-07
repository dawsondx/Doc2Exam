export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    action: string;
    request_id: string;
  };
}

export interface ListEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface DocumentDto {
  id: string;
  original_name: string;
  media_type: "pdf" | "docx";
  size_bytes: number;
  page_count: number | null;
  block_count: number;
  parse_status: "pending" | "running" | "ready" | "failed";
  parse_error: string | null;
  created_at: string | null;
  preview?: string;
  blocks?: SourceBlockSummary[];
  block_total?: number;
}

export interface SourceBlockSummary {
  id: string;
  ordinal: number;
  locator_kind: string;
  locator_label: string;
  page_number: number | null;
  estimated_tokens: number;
}

export interface JobDto {
  id: string;
  job_type: "parse" | "extraction" | "generation";
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
  document_id: string | null;
  quiz_record_id: string | null;
  ai_profile_id: string | null;
  stage: string;
  current: number;
  total: number;
  error: { code: string; message: string } | null;
  created_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
}

export interface Capabilities {
  text_generation: string;
  json_schema: string;
  json_object: string;
  plain_json: string;
  models_list: string;
  usage: string;
  tokenizer_known: boolean;
  preferred_output_mode: string | null;
  _error?: string;
}

export interface AIProfileDto {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_mode: "chat_completions" | "responses";
  context_window: number;
  max_output_tokens: number;
  max_concurrency: number;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  price_currency: string;
  has_api_key: boolean;
  last_probe_at: string | null;
  compatible: boolean;
  credential_storage: "system" | "memory" | "browser";
  profile_fingerprint: string;
  capabilities?: Capabilities;
  probe_verdict?: string;
  probe_error?: string;
}

export interface ConsentDto {
  id: string;
  profile_fingerprint: string;
  consented_at: string;
  revoked_at: string | null;
}

export interface ConsentStatusDto {
  ai_profile_id: string;
  profile_fingerprint: string;
  consent: ConsentDto | null;
}

export interface KnowledgePointDto {
  id: string;
  extraction_job_id: string;
  document_id: string;
  source_block_id: string;
  content: string;
  bloom_level: string;
  category: string;
  eligible_types: string[];
  selected: boolean;
  selectable: boolean;
  requires_source_review: boolean;
  source_text?: string;
  created_at: string | null;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "blocking" | "warning";
}

export interface QuestionDto {
  id: string;
  quiz_record_id: string;
  slot_number: number;
  question_type: "single_choice" | "true_false" | "fill_blank";
  knowledge_point_id: string | null;
  stem: string | null;
  options: string[] | null;
  answer: string | null;
  acceptable_answers: string[] | null;
  explanation: string | null;
  validation_state: "pending" | "passed" | "failed";
  validation_issues: ValidationIssue[];
  review_state: "unreviewed" | "approved" | "rejected";
  attempt_count: number;
  source?: {
    point_content: string | null;
    locator_label: string | null;
    block_text: string | null;
    page_number: number | null;
  } | null;
}

export interface FrozenPointDto {
  id: string;
  content: string;
  category: string;
  bloom_level: string;
  eligible_types: string[];
  used: boolean;
}

export interface QuizRecordDto {
  id: string;
  status: "draft" | "ready" | "exported";
  question_config: Record<string, number>;
  ai_profile_name: string | null;
  model_name: string | null;
  seed: number;
  created_at: string | null;
  updated_at: string | null;
  documents?: string[];
  questions?: QuestionDto[];
  progress?: {
    target: number;
    approved: number;
    unreviewed: number;
    rejected: number;
    missing: number;
    export_ready: boolean;
  };
  frozen_points?: FrozenPointDto[];
}

export interface EstimateDto {
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost: {
    value: number | null;
    currency: string;
    available: boolean;
    reason: string | null;
  };
}

export interface JobEventPayload {
  job_id: string;
  sequence: number;
  stage: string | null;
  current: number | null;
  total: number | null;
  message: string | null;
  resource_id: string | null;
  error: { code: string; message: string } | null;
}
