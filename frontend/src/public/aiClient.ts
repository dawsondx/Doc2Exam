import { isPublicMockAi } from "../demo/mode";
import {
  EngineError,
  nowIso,
  type AiTask,
  type PublicAiSummary,
} from "./model";
import { parseLooseJson, buildPrompt, type BuiltPrompt } from "./prompts";
import { runMockAi } from "./mockAi";

export type { AiBlock, AiTask } from "./model";

export type AiProtocol = "openai" | "anthropic" | "gemini";

export interface ProviderPreset {
  id: string;
  label: string;
  protocol: AiProtocol;
  base_url: string;
  model: string;
  hint: string;
}

export const PROTOCOL_LABELS: Record<AiProtocol, string> = {
  openai: "OpenAI 兼容 /chat/completions",
  anthropic: "Anthropic Messages",
  gemini: "Gemini generateContent",
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    hint: "国内可直连，支持浏览器跨域调用。",
  },
  {
    id: "moonshot",
    label: "Kimi / Moonshot",
    protocol: "openai",
    base_url: "https://api.moonshot.cn/v1",
    model: "kimi-latest",
    hint: "使用 Moonshot 开放平台的 API Key。",
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    protocol: "openai",
    base_url: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    hint: "可用其托管的 DeepSeek、Qwen 等模型。",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    base_url: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    hint: "一个 Key 聚合多家模型，支持浏览器直连。",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    hint: "若浏览器直连被拒，请改用中转站。",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    hint: "使用 Anthropic 原生 Messages 接口，已附加浏览器直连头。",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
    hint: "使用 Google AI Studio 的 API Key。",
  },
  {
    id: "custom",
    label: "自定义 / 中转站",
    protocol: "openai",
    base_url: "",
    model: "",
    hint: "按服务商文档填写地址与模型；多数中转站兼容 OpenAI 协议。",
  },
];

export interface ByokSettings {
  preset: string;
  protocol: AiProtocol;
  base_url: string;
  model: string;
  remember: boolean;
}

export interface ByokStatus extends ByokSettings {
  has_key: boolean;
  ready: boolean;
  mock: boolean;
  provider_label: string;
  key_hint: string;
  probe_at: string | null;
  probe_error?: string;
}

export interface ByokInput extends ByokSettings {
  api_key: string;
}

const SETTINGS_KEY = "ai-quiz-byok-settings";
const SECRET_KEY = "ai-quiz-byok-key";
const PROBE_KEY = "ai-quiz-byok-probe";
const DEFAULT_PRESET = PROVIDER_PRESETS[0];

let memorySettings: ByokSettings | null = null;
let memoryKey = "";

function storageOf(remember: boolean): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return remember ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function readStorage(remember: boolean, key: string): string | null {
  try {
    return storageOf(remember)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(remember: boolean, key: string, value: string | null) {
  try {
    const storage = storageOf(remember);
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private modes; the in-memory copy still works.
  }
}

function defaultSettings(): ByokSettings {
  return {
    preset: DEFAULT_PRESET.id,
    protocol: DEFAULT_PRESET.protocol,
    base_url: DEFAULT_PRESET.base_url,
    model: DEFAULT_PRESET.model,
    remember: false,
  };
}

function isProtocol(value: unknown): value is AiProtocol {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

export function getByokSettings(): ByokSettings {
  if (memorySettings) return { ...memorySettings };
  const raw = readStorage(true, SETTINGS_KEY);
  if (!raw) return defaultSettings();
  try {
    const parsed = JSON.parse(raw) as Partial<ByokSettings> | null;
    if (!parsed || typeof parsed !== "object") return defaultSettings();
    return {
      preset: typeof parsed.preset === "string" ? parsed.preset : DEFAULT_PRESET.id,
      protocol: isProtocol(parsed.protocol) ? parsed.protocol : "openai",
      base_url: typeof parsed.base_url === "string" ? parsed.base_url : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      remember: Boolean(parsed.remember),
    };
  } catch {
    return defaultSettings();
  }
}

function getKey(settings: ByokSettings): string {
  if (memoryKey) return memoryKey;
  return readStorage(settings.remember, SECRET_KEY) ?? "";
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "已保存";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function presetOf(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET;
}

export function providerLabel(settings: ByokSettings): string {
  if (settings.preset === "custom") return "自定义服务";
  return presetOf(settings.preset).label;
}

export function baseHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

interface ProbeRecord {
  fingerprint: string;
  at: string;
  error?: string;
}

function readProbeRecord(): ProbeRecord | null {
  const raw = readStorage(true, PROBE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProbeRecord> | null;
    if (!parsed?.fingerprint || typeof parsed.fingerprint !== "string" || !parsed.at) return null;
    return {
      fingerprint: parsed.fingerprint,
      at: String(parsed.at),
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  } catch {
    return null;
  }
}

function writeProbeRecord(record: ProbeRecord | null) {
  writeStorage(true, PROBE_KEY, record ? JSON.stringify(record) : null);
}

export function byokFingerprint(settings = getByokSettings()): string {
  const host = baseHost(settings.base_url).toLowerCase() || "unconfigured";
  return `byok:${settings.protocol}:${host}:${settings.model.trim() || "no-model"}`;
}

function probeFor(fingerprint: string): ProbeRecord | null {
  const record = readProbeRecord();
  return record && record.fingerprint === fingerprint ? record : null;
}

export function getByokStatus(): ByokStatus {
  const settings = getByokSettings();
  const key = getKey(settings);
  const fingerprint = byokFingerprint(settings);
  const probe = probeFor(fingerprint);
  const mock = isPublicMockAi;
  const configured = Boolean(key && settings.base_url.trim() && settings.model.trim());
  return {
    ...settings,
    has_key: Boolean(key),
    ready: mock || configured,
    mock,
    provider_label: providerLabel(settings),
    key_hint: maskKey(key),
    probe_at: probe?.at ?? null,
    probe_error: probe?.error,
  };
}

export function getByokSummary(): PublicAiSummary {
  const status = getByokStatus();
  return {
    provider_label: status.provider_label,
    base_url: status.base_url,
    model: status.model,
    ready: status.ready,
    mock: status.mock,
    fingerprint: byokFingerprint(),
    probe_at: status.probe_at,
    error: status.probe_error,
  };
}

function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new EngineError(400, "BASE_URL_REQUIRED", "请填写 API 地址。", "参考服务商文档填写 base_url");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EngineError(400, "INVALID_BASE_URL", "API 地址格式不正确。", "填写完整的 https:// 地址");
  }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password) {
    throw new EngineError(
      400,
      "INVALID_BASE_URL",
      "API 地址必须使用 https://，且不能包含账号密码。",
      "检查服务商文档中的 base_url",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export function saveByokConfig(input: ByokInput): ByokStatus {
  const protocol: AiProtocol = isProtocol(input.protocol) ? input.protocol : "openai";
  const base_url = normalizeBaseUrl(input.base_url);
  const model = input.model.trim();
  if (!model) {
    throw new EngineError(400, "MODEL_REQUIRED", "请填写模型名称。", "参考服务商文档填写模型 ID");
  }
  const previous = getByokSettings();
  const sameEndpoint =
    protocol === previous.protocol && baseHost(base_url) === baseHost(previous.base_url);
  const api_key = input.api_key.trim() || (sameEndpoint ? getKey(previous) : "");
  if (!api_key) {
    throw new EngineError(400, "API_KEY_REQUIRED", "请填写你的 API Key。", "Key 只保存在浏览器中");
  }
  const settings: ByokSettings = {
    preset: input.preset || "custom",
    protocol,
    base_url,
    model,
    remember: Boolean(input.remember),
  };
  memorySettings = settings;
  memoryKey = api_key;
  writeStorage(true, SETTINGS_KEY, JSON.stringify(settings));
  writeStorage(true, SECRET_KEY, settings.remember ? api_key : null);
  writeStorage(false, SECRET_KEY, settings.remember ? null : api_key);
  writeProbeRecord(null);
  return getByokStatus();
}

export function clearByokKey(): ByokStatus {
  memoryKey = "";
  writeStorage(true, SECRET_KEY, null);
  writeStorage(false, SECRET_KEY, null);
  writeProbeRecord(null);
  return getByokStatus();
}

export function resetByok(): ByokStatus {
  memorySettings = null;
  memoryKey = "";
  writeStorage(true, SETTINGS_KEY, null);
  writeStorage(true, SECRET_KEY, null);
  writeStorage(false, SECRET_KEY, null);
  writeProbeRecord(null);
  return getByokStatus();
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

interface ProviderResult {
  content: string;
  usage: { input: number; output: number };
}

interface RawResponse {
  ok: boolean;
  status: number;
  body: unknown;
  text: string;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<RawResponse> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (isTimeout(error)) {
      throw new EngineError(
        504,
        "AI_TIMEOUT",
        "AI 服务响应超时。",
        "稍后重试，或减少文档范围",
      );
    }
    throw new EngineError(
      502,
      "AI_NETWORK",
      "浏览器无法连接该 AI 服务。",
      "检查网络与 base_url；若服务不允许跨域(CORS)，请换用支持浏览器直连的服务或自建中转。",
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { ok: response.ok, status: response.status, body, text };
}

function providerMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const value = body as {
    error?: { message?: unknown } | string;
    message?: unknown;
  };
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error === "object") {
    const message = value.error.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return fallback;
}

function redact(value: string, key: string): string {
  const trimmed = value.trim().slice(0, 240);
  if (!key || key.length < 6) return trimmed;
  return trimmed.split(key).join("[已隐藏]");
}

function httpError(status: number, body: unknown, text: string, key: string): EngineError {
  const detail = redact(providerMessage(body, text.slice(0, 240)), key);
  if (status === 401 || status === 403) {
    return new EngineError(
      401,
      "AI_KEY_INVALID",
      "Key 无效、已过期，或该服务不允许浏览器直连。",
      "检查 Key、账户权限；若被跨域拦截，请改用支持浏览器直连的服务或中转站。",
    );
  }
  if (status === 404) {
    return new EngineError(
      404,
      "AI_ENDPOINT_NOT_FOUND",
      "接口地址或模型不存在。",
      "检查 base_url（通常以 /v1 结尾）与模型名称。",
    );
  }
  if (status === 429) {
    return new EngineError(
      429,
      "AI_UPSTREAM_BUSY",
      "服务商限流或账户余额不足。",
      "稍后重试，或检查服务商账户余额。",
    );
  }
  if (status >= 500) {
    return new EngineError(502, "AI_UPSTREAM_FAILED", "服务商暂时不可用。", "稍后重试");
  }
  return new EngineError(
    status === 400 ? 400 : 502,
    status === 400 ? "AI_BAD_REQUEST" : "AI_UPSTREAM_FAILED",
    detail ? `服务商拒绝了请求：${detail}` : "服务商拒绝了请求。",
    "检查模型名称、接口地址与账户额度。",
  );
}

function number(value: unknown): number {
  const parsed = Math.floor(Number(value) || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function chatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function messagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (/\/messages$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function geminiUrl(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (/:generateContent/i.test(base)) return base;
  const name = model.replace(/^models\//i, "");
  if (/\/v1(?:alpha|beta)?$/i.test(base)) return `${base}/models/${name}:generateContent`;
  return `${base}/v1beta/models/${name}:generateContent`;
}

async function callOpenAi(
  settings: ByokSettings,
  key: string,
  built: BuiltPrompt,
): Promise<ProviderResult> {
  const url = chatUrl(settings.base_url);
  let maxField: "max_tokens" | "max_completion_tokens" = "max_tokens";
  let jsonMode = built.kind !== "probe";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload: Record<string, unknown> = {
      model: settings.model,
      messages: [
        { role: "system", content: built.system },
        { role: "user", content: built.user },
      ],
      temperature: built.kind === "probe" ? 0 : 0.3,
      [maxField]: built.maxTokens,
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    const response = await request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
      },
      built.kind === "probe" ? 30_000 : 150_000,
    );
    if (response.ok) {
      const body = response.body as {
        choices?: { message?: { content?: unknown } }[];
        usage?: Record<string, unknown>;
      } | null;
      const content = contentText(body?.choices?.[0]?.message?.content);
      return {
        content,
        usage: {
          input: number(body?.usage?.prompt_tokens ?? body?.usage?.input_tokens),
          output: number(body?.usage?.completion_tokens ?? body?.usage?.output_tokens),
        },
      };
    }
    if (response.status === 400 || response.status === 422) {
      const detail = providerMessage(response.body, response.text);
      if (maxField === "max_tokens" && /max_completion_tokens/i.test(detail)) {
        maxField = "max_completion_tokens";
        continue;
      }
      if (
        jsonMode &&
        /response_format|json_object|json mode|json mode is not supported/i.test(detail)
      ) {
        jsonMode = false;
        continue;
      }
    }
    throw httpError(response.status, response.body, response.text, key);
  }
  throw new EngineError(502, "AI_UPSTREAM_FAILED", "服务商多次拒绝了请求参数。", "更换模型或改用中转站");
}

async function callAnthropic(
  settings: ByokSettings,
  key: string,
  built: BuiltPrompt,
): Promise<ProviderResult> {
  const response = await request(
    messagesUrl(settings.base_url),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: built.maxTokens,
        temperature: built.kind === "probe" ? 0 : 0.3,
        system: built.system,
        messages: [{ role: "user", content: built.user }],
      }),
    },
    built.kind === "probe" ? 30_000 : 150_000,
  );
  if (!response.ok) throw httpError(response.status, response.body, response.text, key);
  const body = response.body as {
    content?: { type?: string; text?: unknown }[];
    usage?: Record<string, unknown>;
  } | null;
  const content = (body?.content ?? [])
    .filter((part) => part?.type !== "thinking")
    .map((part) => contentText(part?.text))
    .join("");
  return {
    content,
    usage: {
      input: number(body?.usage?.input_tokens),
      output: number(body?.usage?.output_tokens),
    },
  };
}

async function callGemini(
  settings: ByokSettings,
  key: string,
  built: BuiltPrompt,
): Promise<ProviderResult> {
  const generationConfig: Record<string, unknown> = {
    temperature: built.kind === "probe" ? 0 : 0.3,
    maxOutputTokens: built.maxTokens,
  };
  if (built.kind !== "probe") generationConfig.responseMimeType = "application/json";
  const response = await request(
    geminiUrl(settings.base_url, settings.model),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: built.system }] },
        contents: [{ role: "user", parts: [{ text: built.user }] }],
        generationConfig,
      }),
    },
    built.kind === "probe" ? 30_000 : 150_000,
  );
  if (!response.ok) throw httpError(response.status, response.body, response.text, key);
  const body = response.body as {
    candidates?: { content?: { parts?: { text?: unknown; thought?: boolean }[] } }[];
    usageMetadata?: Record<string, unknown>;
  } | null;
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const content = parts
    .filter((part) => !part?.thought)
    .map((part) => contentText(part?.text))
    .join("");
  return {
    content,
    usage: {
      input: number(body?.usageMetadata?.promptTokenCount),
      output: number(body?.usageMetadata?.candidatesTokenCount),
    },
  };
}

function recordProbe(fingerprint: string, error?: string) {
  writeProbeRecord({
    fingerprint,
    at: nowIso(),
    error,
  });
}

const RETRYABLE_AI_CODES = new Set([
  "AI_UPSTREAM_BUSY",
  "AI_UPSTREAM_FAILED",
  "AI_NETWORK",
  "AI_TIMEOUT",
]);

async function requestProvider(
  settings: ByokSettings,
  key: string,
  built: BuiltPrompt,
): Promise<ProviderResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (settings.protocol === "anthropic") return await callAnthropic(settings, key, built);
      if (settings.protocol === "gemini") return await callGemini(settings, key, built);
      return await callOpenAi(settings, key, built);
    } catch (error) {
      const retryable = error instanceof EngineError && RETRYABLE_AI_CODES.has(error.code);
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1_000 : 2_500));
    }
  }
  throw new EngineError(502, "AI_UPSTREAM_FAILED", "AI 请求失败。", "稍后重试");
}

export async function callAi(task: AiTask): Promise<unknown> {
  if (isPublicMockAi) return runMockAi(task);

  const settings = getByokSettings();
  const key = getKey(settings);
  const fingerprint = byokFingerprint(settings);
  if (!settings.base_url.trim() || !settings.model.trim()) {
    throw new EngineError(
      503,
      "AI_NOT_CONFIGURED",
      "尚未配置 AI 服务。",
      "返回 AI 配置，选择服务商并填写 Key",
    );
  }
  if (!key) {
    throw new EngineError(
      503,
      "AI_KEY_MISSING",
      "尚未填写 API Key。",
      "返回 AI 配置填写 Key（只保存在浏览器）",
    );
  }

  const built = buildPrompt(task);
  let result: ProviderResult;
  try {
    result = await requestProvider(settings, key, built);
  } catch (error) {
    if (task.kind === "probe") {
      recordProbe(fingerprint, error instanceof EngineError ? error.message : "测试失败");
    }
    throw error;
  }

  if (task.kind === "probe") {
    recordProbe(fingerprint);
    return { ok: true, model: settings.model };
  }
  if (!result.content.trim()) {
    throw new EngineError(502, "AI_INVALID_RESPONSE", "AI 返回了空结果。", "重试该任务");
  }
  const parsed = parseLooseJson(result.content);
  if (!parsed) {
    throw new EngineError(
      502,
      "AI_INVALID_RESPONSE",
      "AI 返回的内容不是有效 JSON。",
      "重试该任务",
    );
  }
  return parsed;
}
