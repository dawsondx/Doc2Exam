import { useEffect, useState } from "react";
import * as api from "../api/endpoints";
import { ApiError } from "../api/client";
import { isPublicMode } from "../demo/mode";
import {
  PROVIDER_PRESETS,
  PROTOCOL_LABELS,
  baseHost,
  clearByokKey,
  getByokSettings,
  getByokStatus,
  saveByokConfig,
  type AiProtocol,
  type ByokSettings,
  type ByokStatus,
} from "../public/aiClient";
import { EngineError, PUBLIC_PROFILE_ID } from "../public/model";
import { useWorkflow } from "../store";
import { useToast } from "../components/ui/toast";
import { Badge, Card, Input, Label, Select } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icons";
import { EmptyState, PageHeader, Notice, SectionHeading } from "../components/ui/layout";
import type { AIProfileDto } from "../types/api";

const EMPTY_FORM = {
  name: "", base_url: "", model: "", api_key: "", api_mode: "chat_completions",
  context_window: "", max_output_tokens: "", max_concurrency: "4",
  input_price: "", output_price: "", price_currency: "USD",
};

function profileHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function CapabilityRow({ label, value }: { label: string; value: string | boolean }) {
  const tone =
    value === "supported" || value === true
      ? "success"
      : value === "unsupported" || value === false
        ? "danger"
        : "neutral";
  const text =
    typeof value === "boolean" ? (value ? "已知" : "未知") : ({
      supported: "支持", unsupported: "不支持", not_tested: "未测试", unknown: "未知",
    } as Record<string, string>)[value] ?? value;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--color-rule)] py-2.5 last:border-b-0">
      <span className="text-[length:var(--text-sm)] text-[var(--color-neutral)]">{label}</span>
      <Badge tone={tone as "success" | "danger" | "neutral"}>{text}</Badge>
    </div>
  );
}

export function ProfilePage() {
  return isPublicMode ? <PublicProfilePage /> : <PrivateProfilePage />;
}

interface ByokForm extends ByokSettings {
  api_key: string;
}

function formFrom(settings: ByokSettings): ByokForm {
  return {
    preset: settings.preset,
    protocol: settings.protocol,
    base_url: settings.base_url,
    model: settings.model,
    remember: settings.remember,
    api_key: "",
  };
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.action}）`;
  if (error instanceof EngineError) return `${error.message}（${error.action}）`;
  return "连接失败，请检查配置后重试";
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function PublicProfilePage() {
  const { refreshProfiles, consentId, setConsentId, goto } = useWorkflow();
  const { push } = useToast();
  const [status, setStatus] = useState<ByokStatus>(() => getByokStatus());
  const [form, setForm] = useState<ByokForm>(() => formFrom(getByokSettings()));
  const [editing, setEditing] = useState(() => !getByokStatus().ready);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function choosePreset(id: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setError(null);
    setForm((prev) => ({
      ...prev,
      preset: preset.id,
      protocol: preset.id === "custom" ? prev.protocol : preset.protocol,
      base_url: preset.id === "custom" ? prev.base_url : preset.base_url,
      model: preset.id === "custom" ? prev.model : preset.model,
      api_key: "",
    }));
  }

  async function saveAndTest() {
    setSaving(true);
    setError(null);
    let saved = false;
    try {
      const next = saveByokConfig(form);
      saved = true;
      setStatus(next);
      setForm(formFrom(next));
      await refreshProfiles();
      try {
        const consent = await api.consentStatus(PUBLIC_PROFILE_ID);
        setConsentId(consent.consent?.id ?? null);
      } catch {
        // Consent status is best-effort; the local page state stays usable.
      }
      await api.probeProfile(PUBLIC_PROFILE_ID);
      const after = getByokStatus();
      setStatus(after);
      setForm(formFrom(after));
      setEditing(false);
      await refreshProfiles();
      push({ tone: "success", message: `连接成功：${after.provider_label} · ${after.model}` });
    } catch (failure) {
      const message = errorText(failure);
      setError(message);
      if (saved) {
        const after = getByokStatus();
        setStatus(after);
        setForm((prev) => ({ ...prev, api_key: "" }));
        await refreshProfiles();
      }
      push({ tone: "danger", message });
    } finally {
      setSaving(false);
    }
  }

  async function forgetKey() {
    const next = clearByokKey();
    setStatus(next);
    setForm(formFrom(next));
    setEditing(true);
    setError(null);
    if (consentId) {
      try {
        await api.revokeConsent(consentId);
      } catch {
        // The local consent state is cleared regardless.
      }
    }
    setConsentId(null);
    await refreshProfiles();
    push({ tone: "success", message: "已从浏览器清除 API Key" });
  }

  function cancelEdit() {
    const current = getByokStatus();
    setForm(formFrom(current));
    setEditing(false);
    setError(null);
  }

  async function confirmConsent() {
    setBusy(true);
    try {
      const consent = await api.createConsent(PUBLIC_PROFILE_ID);
      setConsentId(consent.id);
      push({ tone: "success", message: "已确认数据发送范围，可以开始出题" });
    } catch (failure) {
      push({ tone: "danger", message: errorText(failure) });
    } finally {
      setBusy(false);
    }
  }

  async function revokeConsent() {
    if (!consentId) return;
    setBusy(true);
    try {
      await api.revokeConsent(consentId);
      setConsentId(null);
      push({ tone: "success", message: "已撤销数据发送授权" });
    } catch (failure) {
      push({ tone: "danger", message: errorText(failure) });
    } finally {
      setBusy(false);
    }
  }

  const preset = PROVIDER_PRESETS.find((item) => item.id === form.preset) ?? PROVIDER_PRESETS[0];
  const showForm = !status.mock && (!status.ready || editing);
  const ready = status.ready;
  const canContinue = ready && Boolean(consentId) && !editing;
  const testLabel = status.probe_error
    ? "上次测试失败"
    : status.probe_at
      ? `测试通过 ${shortTime(status.probe_at)}`
      : "尚未测试";

  return (
    <section className="space-y-8" aria-labelledby="profile-title">
      <PageHeader
        step={2}
        kicker="AI 服务 · 自带 Key"
        title="连接你自己的 AI 服务"
        description="本站不代管密钥，也不代理 AI 请求。选择一个服务商、填入你的 API Key，浏览器会直接调用该服务商；费用由你的账户按实际 token 结算。"
        aside={
          <Badge tone="accent" className="gap-1.5">
            <Icon name="shield" size={12} />
            Key 不出浏览器
          </Badge>
        }
      />

      {status.mock && (
        <Notice tone="info" title="本地模拟 AI 模式">
          当前构建使用本地模拟结果，不会访问网络，也不需要填写 Key。该模式仅用于界面与流程验证。
        </Notice>
      )}

      <Card className="reveal relative overflow-hidden">
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center border border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)] text-[var(--color-accent)]">
              <Icon name={ready ? "activity" : "sparkles"} size={19} />
            </span>
            <div className="min-w-0">
              <p className="font-[family-name:var(--font-display)] text-[15px] font-semibold text-[var(--color-ink)]">
                {status.mock ? "本地模拟 AI" : ready ? `已配置 · ${status.provider_label}` : "尚未配置 AI 服务"}
              </p>
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-muted)]">
                {status.mock
                  ? "模拟结果 · 不产生费用"
                  : ready
                    ? `${status.model} · ${baseHost(status.base_url)}`
                    : "填入你自己的 API Key 后即可开始真实出题"}
              </p>
              {!status.mock && (status.has_key || ready) && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{PROTOCOL_LABELS[status.protocol]}</Badge>
                  {status.has_key && <Badge tone="neutral">Key {status.key_hint}</Badge>}
                  <Badge tone={status.probe_error ? "warning" : status.probe_at ? "success" : "neutral"}>
                    {testLabel}
                  </Badge>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {ready && !editing && !status.mock && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Icon name="sliders" size={15} />
                修改配置
              </Button>
            )}
            {status.has_key && !status.mock && (
              <Button variant="ghost" onClick={() => void forgetKey()}>
                <Icon name="trash" size={14} />
                清除 Key
              </Button>
            )}
          </div>
        </div>

        {(error || status.probe_error) && (
          <Notice
            tone={error ? "danger" : "warning"}
            className="relative mt-4"
            title={error ? "连接未通过" : "上次连接测试失败"}
          >
            {error ?? status.probe_error}
          </Notice>
        )}
      </Card>

      {showForm && (
        <Card className="reveal" aria-label="连接 AI 服务">
          <SectionHeading
            index="CONNECT"
            title={status.ready ? "修改连接配置" : "填写服务商信息"}
            description="服务商预设已填入常用地址与模型，可按你的账户情况手动修改。"
          />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="byok-preset">服务商</Label>
              <Select
                id="byok-preset"
                value={form.preset}
                onChange={(event) => choosePreset(event.target.value)}
              >
                {PROVIDER_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="byok-model">模型 ID</Label>
              <Input
                id="byok-model"
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
                placeholder="例如 deepseek-chat"
                className="font-[family-name:var(--font-outlier)] text-[13px]"
              />
            </div>
            {form.preset === "custom" && (
              <div>
                <Label htmlFor="byok-protocol">接口协议</Label>
                <Select
                  id="byok-protocol"
                  value={form.protocol}
                  onChange={(event) => setForm({ ...form, protocol: event.target.value as AiProtocol })}
                >
                  {(Object.keys(PROTOCOL_LABELS) as AiProtocol[]).map((protocol) => (
                    <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>
                  ))}
                </Select>
              </div>
            )}
            <div className={form.preset === "custom" ? "" : "sm:col-span-2"}>
              <Label htmlFor="byok-base">API 地址 base_url</Label>
              <Input
                id="byok-base"
                value={form.base_url}
                onChange={(event) => setForm({ ...form, base_url: event.target.value })}
                placeholder="https://api.example.com/v1"
                className="font-[family-name:var(--font-outlier)] text-[13px]"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="byok-key">
                API Key{status.has_key ? "（已保存，可留空沿用）" : ""}
              </Label>
              <Input
                id="byok-key"
                type="password"
                autoComplete="off"
                value={form.api_key}
                onChange={(event) => setForm({ ...form, api_key: event.target.value })}
                placeholder={
                  status.has_key
                    ? `已保存 ${status.key_hint}，更换服务商或地址时需重新填写`
                    : "sk-..."
                }
              />
              <p className="mt-2 text-[11px] leading-5 text-[var(--color-muted)]">
                默认只保存在当前标签页；勾选“记住”后写入本机 localStorage。本站服务器不会收到或保存你的 Key。
              </p>
            </div>
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-2.5 border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 px-4 py-3">
            <input
              type="checkbox"
              checked={form.remember}
              onChange={(event) => setForm({ ...form, remember: event.target.checked })}
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-[length:var(--text-sm)] text-[var(--color-ink)]">在此浏览器记住 Key</span>
              <span className="mt-0.5 block text-[11px] leading-5 text-[var(--color-muted)]">
                不勾选时关闭标签页即清除；勾选后写入 localStorage，下次打开无需重填。公共设备上请勿勾选。
              </span>
            </span>
          </label>

          <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-5 text-[var(--color-muted)]">
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            {preset.hint}
          </p>

          <Notice tone="warning" className="mt-4" title="浏览器直连要求服务商允许跨域 (CORS)">
            若提示“浏览器无法连接”，请检查 base_url，并优先使用明确支持浏览器调用的服务（如 DeepSeek、OpenRouter、硅基流动等）或自建中转站。
          </Notice>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button loading={saving} onClick={() => void saveAndTest()}>
              <Icon name="activity" size={15} />
              保存并测试连接
            </Button>
            {editing && status.ready && (
              <Button variant="ghost" onClick={cancelEdit}>取消</Button>
            )}
            <span className="text-[11px] text-[var(--color-muted)]">
              测试只发送一次极小的固定请求，用于验证 Key、模型与跨域访问。
            </span>
          </div>
        </Card>
      )}

      {ready && !consentId && (
        <Card className="reveal relative overflow-hidden border-[var(--color-rule-strong)]">
          <div className="relative flex items-start gap-4">
            <span className="flex size-11 shrink-0 items-center justify-center border border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)] text-[var(--color-accent)]">
              <Icon name="shield" size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="eyebrow">DATA CONSENT</p>
              <h3 className="mt-1 font-[family-name:var(--font-display)] text-lg font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                数据发送确认
              </h3>
              <p className="mt-2 max-w-[62ch] text-[length:var(--text-sm)] leading-6 text-[var(--color-neutral)]">
                开始前请确认：当前任务所需的文本块、考点描述与题型约束，会由你的浏览器直接发送给{" "}
                {status.provider_label}（{status.model}）用于生成内容。API Key 与文档不会经过本站服务器；原始文件、题目与导出文件只保存在你的浏览器中。请勿上传含个人敏感信息或涉密内容的文档。
              </p>
              <div className="mt-4 grid gap-px border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-2">
                <div className="bg-[var(--color-paper-2)] px-3.5 py-3">
                  <p className="text-[9px] tracking-[0.16em] text-[var(--color-success)]">会发送</p>
                  <p className="mt-1 text-[length:var(--text-xs)] leading-5 text-[var(--color-neutral)]">
                    文本块、考点描述、题型与数量约束
                  </p>
                </div>
                <div className="bg-[var(--color-paper-2)] px-3.5 py-3">
                  <p className="text-[9px] tracking-[0.16em] text-[var(--color-muted)]">不会发送</p>
                  <p className="mt-1 text-[length:var(--text-xs)] leading-5 text-[var(--color-neutral)]">
                    API Key、原始文件、完整试卷与导出文件
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <Button loading={busy} onClick={() => void confirmConsent()}>
                  同意并继续
                  <Icon name="arrowRight" size={15} />
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}
      {consentId && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-[var(--color-success)] bg-[#edf0e6]/70 px-4 py-3">
          <p className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-success)]">
            <Icon name="circleCheck" size={16} />
            数据发送范围已确认。
          </p>
          <Button variant="ghost" loading={busy} onClick={() => void revokeConsent()}>撤销授权</Button>
        </div>
      )}

      <div className="grid gap-px border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-3">
        {[
          { icon: "lock" as const, title: "Key 只在浏览器", text: "默认仅当前标签页；勾选记住后写入 localStorage。可随时在本页清除，本站服务器无法读取。" },
          { icon: "activity" as const, title: "直连服务商", text: "AI 请求由浏览器直接发往你选择的服务商，本站不代理、不记录请求内容。" },
          { icon: "database" as const, title: "费用自理", text: "按服务商价格从你的账户扣费。本站不收取费用，也无法查看你的账单。" },
        ].map((item) => (
          <div key={item.title} className="bg-[var(--color-paper-2)]/60 p-4">
            <span className="flex size-8 items-center justify-center border border-[var(--color-rule)] bg-[var(--color-paper-hi)] text-[var(--color-accent)]">
              <Icon name={item.icon} size={15} />
            </span>
            <p className="mt-2.5 font-[family-name:var(--font-display)] text-[14px] font-semibold text-[var(--color-ink)]">{item.title}</p>
            <p className="mt-1 text-[11px] leading-5 text-[var(--color-muted)]">{item.text}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 border-t border-[var(--color-rule-strong)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="secondary" onClick={() => goto(0)}>上一步</Button>
        <div className="flex flex-wrap items-center gap-3">
          {!canContinue && (
            <span className="text-[length:var(--text-xs)] text-[var(--color-muted)]">
              {editing && ready ? "保存配置后可继续" : !ready ? "先连接 AI 服务" : "确认发送范围后可继续"}
            </span>
          )}
          <Button disabled={!canContinue} onClick={() => goto(2)}>
            下一步:配置题目
            <Icon name="arrowRight" size={16} />
          </Button>
        </div>
      </div>
    </section>
  );
}

function PrivateProfilePage() {
  const {
    profiles, refreshProfiles, activeProfileId, setActiveProfileId,
    consentId, setConsentId, goto,
  } = useWorkflow();
  const { push } = useToast();
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [probing, setProbing] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [consentInfo, setConsentInfo] = useState<{ fingerprint: string; host: string } | null>(null);

  const active = profiles.find((p) => p.id === activeProfileId) ?? null;

  useEffect(() => {
    setConsentId(null);
    setConsentInfo(null);
    if (!activeProfileId) return;
    api.consentStatus(activeProfileId).then((status) => {
      if (status.consent) {
        setConsentId(status.consent.id);
      } else {
        setConsentId(null);
      }
      setConsentInfo({
        fingerprint: status.profile_fingerprint,
        host: profileHost(active?.base_url ?? ""),
      });
    }).catch(() => undefined);
  }, [activeProfileId, active?.base_url, setConsentId]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setAdvanced(false);
    setFormMode("create");
  }

  function openEdit() {
    if (!active) return;
    setForm({
      name: active.name,
      base_url: active.base_url,
      model: active.model,
      api_key: "",
      api_mode: active.api_mode,
      context_window: active.context_window ? String(active.context_window) : "",
      max_output_tokens: active.max_output_tokens ? String(active.max_output_tokens) : "",
      max_concurrency: String(active.max_concurrency),
      input_price: active.input_price_per_million === null ? "" : String(active.input_price_per_million),
      output_price: active.output_price_per_million === null ? "" : String(active.output_price_per_million),
      price_currency: active.price_currency,
    });
    setAdvanced(true);
    setFormMode("edit");
  }

  function formBody() {
    const body: Record<string, unknown> = {
      name: form.name, base_url: form.base_url, model: form.model,
      api_mode: form.api_mode,
      context_window: form.context_window ? Number(form.context_window) : null,
      max_output_tokens: form.max_output_tokens ? Number(form.max_output_tokens) : null,
      max_concurrency: Number(form.max_concurrency) || 4,
      input_price_per_million: form.input_price ? Number(form.input_price) : null,
      output_price_per_million: form.output_price ? Number(form.output_price) : null,
      price_currency: form.price_currency,
    };
    if (form.api_key) body.api_key = form.api_key;
    return body;
  }

  async function save() {
    try {
      const saved = formMode === "edit" && active
        ? await api.patchProfile(active.id, formBody())
        : await api.createProfile({ ...formBody(), api_key: form.api_key });
      await refreshProfiles();
      setActiveProfileId(saved.id);
      setFormMode(null);
      push({ tone: "success", message: formMode === "edit" ? "配置已更新,请重新测试连接" : "配置已创建,请测试连接" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "保存失败",
      });
    }
  }

  async function probe() {
    if (!active) return;
    setProbing(true);
    try {
      await api.probeProfile(active.id);
      await refreshProfiles();
      push({ tone: "success", message: "测试完成,最多执行 4 次探测调用(仅发送固定测试字符串)" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "测试失败",
      });
    } finally {
      setProbing(false);
    }
  }

  async function confirmConsent() {
    if (!active) return;
    try {
      const consent = await api.createConsent(active.id);
      setConsentId(consent.id);
      push({ tone: "success", message: "已确认数据发送范围" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "确认失败",
      });
    }
  }

  async function revokeConsent() {
    if (!consentId) return;
    try {
      await api.revokeConsent(consentId);
      setConsentId(null);
      push({ tone: "success", message: "已撤销该配置的数据发送授权" });
    } catch (error) {
      push({ tone: "danger", message: error instanceof ApiError ? error.message : "撤销失败" });
    }
  }

  async function removeActive() {
    if (!active) return;
    try {
      const impact = await api.profileDeletionImpact(active.id);
      const detail = Object.entries(impact.counts).map(([key, value]) => `${value} ${key}`).join("、");
      if (!window.confirm(`将删除配置“${active.name}”,并处理 ${detail}。历史试卷保留,确认继续?`)) return;
      await api.deleteProfile(active.id, impact.deletion_token);
      setConsentId(null);
      setActiveProfileId(null);
      setFormMode(null);
      await refreshProfiles();
      push({ tone: "success", message: "AI 配置已删除,历史试卷仍保留" });
    } catch (error) {
      push({ tone: "danger", message: error instanceof ApiError ? `${error.message}(${error.action})` : "删除失败" });
    }
  }

  return (
    <section className="space-y-8" aria-labelledby="profile-title">
      <PageHeader
        step={2}
        kicker="AI 配置"
        title="选择 AI 服务"
        description="支持具备 Chat Completions 或 Responses 文本生成能力的 OpenAI 风格端点；结构化输出、模型列表、token usage 和价格能力因服务而异，系统会测试并显示兼容结果。"
        aside={
          <Button variant="secondary" onClick={openCreate}>
            <Icon name="plus" size={15} />
            新增 AI 配置
          </Button>
        }
      />

      {profiles.length === 0 && !formMode && (
        <EmptyState
          icon="shield"
          title="还没有 AI 配置"
          description="填写服务名称、base_url、API key 和模型创建第一个配置。API key 只保存在系统凭据管理器或本进程内存中。"
          action={
            <Button onClick={openCreate}>
              创建配置
              <Icon name="arrowRight" size={16} />
            </Button>
          }
        />
      )}

      {formMode && (
        <Card className="reveal" aria-label={formMode === "edit" ? "编辑 AI 配置" : "新建 AI 配置"}>
          <SectionHeading
            index={formMode === "edit" ? "EDIT" : "NEW"}
            title={formMode === "edit" ? `编辑配置：${active?.name ?? ""}` : "新增 AI 配置"}
            description="base_url 指向 OpenAI 风格的 API 根地址，系统会基于该端点探测能力。"
          />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pf-name">配置名称</Label>
              <Input id="pf-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如:内部大模型" />
            </div>
            <div>
              <Label htmlFor="pf-mode">API 模式</Label>
              <Select id="pf-mode" value={form.api_mode} onChange={(e) => setForm({ ...form, api_mode: e.target.value })}>
                <option value="chat_completions">Chat Completions</option>
                <option value="responses">Responses</option>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="pf-url">base_url(API 根地址)</Label>
              <Input id="pf-url" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://api.example.com/v1" className="font-[family-name:var(--font-outlier)] text-[13px]" />
            </div>
            <div>
              <Label htmlFor="pf-model">模型</Label>
              <Input id="pf-model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="pf-key">API key{formMode === "edit" ? "(留空则不更换)" : ""}(保存在系统凭据管理器)</Label>
              <Input id="pf-key" type="password" value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
            className="mt-4 inline-flex min-h-9 items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--color-accent)] underline-offset-4 hover:underline"
          >
            <Icon name={advanced ? "minus" : "plus"} size={14} />
            {advanced ? "收起高级设置" : "展开高级设置(上下文窗口 / 并发 / 价格)"}
          </button>
          {advanced && (
            <div className="mt-4 grid gap-4 border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 p-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="pf-ctx">上下文窗口</Label>
                <Input id="pf-ctx" value={form.context_window} onChange={(e) => setForm({ ...form, context_window: e.target.value })}
                  placeholder="32768" inputMode="numeric" />
              </div>
              <div>
                <Label htmlFor="pf-out">最大输出 token</Label>
                <Input id="pf-out" value={form.max_output_tokens} onChange={(e) => setForm({ ...form, max_output_tokens: e.target.value })}
                  placeholder="4096" inputMode="numeric" />
              </div>
              <div>
                <Label htmlFor="pf-conc">并发数(1–8)</Label>
                <Input id="pf-conc" value={form.max_concurrency} onChange={(e) => setForm({ ...form, max_concurrency: e.target.value })}
                  inputMode="numeric" />
              </div>
              <div>
                <Label htmlFor="pf-pin">输入单价 / 百万 token</Label>
                <Input id="pf-pin" value={form.input_price} onChange={(e) => setForm({ ...form, input_price: e.target.value })}
                  placeholder="可选" inputMode="decimal" />
              </div>
              <div>
                <Label htmlFor="pf-pout">输出单价 / 百万 token</Label>
                <Input id="pf-pout" value={form.output_price} onChange={(e) => setForm({ ...form, output_price: e.target.value })}
                  placeholder="可选" inputMode="decimal" />
              </div>
              <div>
                <Label htmlFor="pf-currency">币种(ISO 4217)</Label>
                <Input id="pf-currency" value={form.price_currency} onChange={(e) => setForm({ ...form, price_currency: e.target.value })}
                  placeholder="USD" maxLength={3} />
              </div>
            </div>
          )}

          <div className="mt-5 flex gap-2 border-t border-[var(--color-rule)] pt-4">
            <Button onClick={() => void save()} disabled={!form.name || !form.base_url || !form.model || (formMode === "create" && !form.api_key)}>
              {formMode === "edit" ? "保存修改" : "保存配置"}
            </Button>
            <Button variant="secondary" onClick={() => setFormMode(null)}>取消</Button>
          </div>
        </Card>
      )}

      {profiles.length > 0 && (
        <div className="space-y-4">
          <SectionHeading
            index="SERVICES"
            title="AI 服务配置"
            description="选中一个配置作为本次出题使用的端点，测试通过并确认发送范围后才能继续。"
            action={<Badge tone="neutral">共 {profiles.length} 个</Badge>}
          />
          <div className="grid gap-3 lg:grid-cols-2" role="radiogroup" aria-label="AI 配置列表">
            {profiles.map((profile: AIProfileDto, index) => {
              const selected = profile.id === activeProfileId;
              return (
                <label
                  key={profile.id}
                  className="reveal cursor-pointer"
                  style={{ ["--i" as string]: index + 1 }}
                >
                  <Card
                    className={
                      "relative h-full transition-[border-color,background-color,box-shadow] " +
                      (selected
                        ? "border-[var(--color-accent)]/45 bg-[var(--color-accent-soft)]/20"
                        : "")
                    }
                  >
                    <input
                      type="radio"
                      name="profile"
                      className="sr-only"
                      checked={selected}
                      onChange={() => setActiveProfileId(profile.id)}
                    />
                    <div className="flex items-start gap-3">
                      <span
                        className={
                          "flex size-10 shrink-0 items-center justify-center border " +
                          (selected
                            ? "border-[var(--color-accent)]/35 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                            : "border-[var(--color-rule)] bg-[var(--color-paper-hi)] text-[var(--color-muted)]")
                        }
                      >
                        <Icon name="sparkles" size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-[family-name:var(--font-display)] text-[15px] font-semibold text-[var(--color-ink)]">{profile.name}</p>
                            <p className="mt-1 truncate font-[family-name:var(--font-outlier)] text-[11px] text-[var(--color-muted)]">
                              {profile.base_url}
                            </p>
                          </div>
                          <span
                            aria-hidden="true"
                            className={
                              "mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border " +
                              (selected
                                ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                                : "border-[var(--color-rule-strong)]")
                            }
                          >
                            {selected && <span className="size-1.5 rounded-full bg-[var(--color-accent-ink)]" />}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Badge tone="neutral">{profile.model}</Badge>
                          <Badge tone="neutral">{profile.api_mode === "responses" ? "Responses" : "Chat Completions"}</Badge>
                          {selected && <Badge tone="accent">当前使用</Badge>}
                        </div>
                        <div className="mt-3">
                          {profile.compatible ? (
                            <Badge tone="success">✓ {profile.probe_verdict}</Badge>
                          ) : (
                            <Badge tone={profile.last_probe_at ? "danger" : "neutral"}>
                              {profile.last_probe_at ? "✕ 未通过测试" : "未测试"}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {active && (
        <Card className="reveal">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                测试连接:{active.name}
              </h3>
              <p className="mt-1.5 max-w-[58ch] text-[length:var(--text-xs)] leading-5 text-[var(--color-muted)]">
                连接测试只发送固定字符串“AI出题精灵连接测试”，不发送文档内容。
              </p>
            </div>
            <Button variant="secondary" loading={probing} onClick={() => void probe()}>
              <Icon name="activity" size={15} />
              测试连接(最多 4 次探测)
            </Button>
          </div>
          {active.capabilities && (
            <div className="mt-4 grid gap-x-8 border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 px-4 py-1 sm:grid-cols-2">
              <CapabilityRow label="文本生成" value={active.capabilities.text_generation} />
              <CapabilityRow label="JSON Schema" value={active.capabilities.json_schema} />
              <CapabilityRow label="JSON 对象" value={active.capabilities.json_object} />
              <CapabilityRow label="纯文本 JSON" value={active.capabilities.plain_json} />
              <CapabilityRow label="模型列表" value={active.capabilities.models_list} />
              <CapabilityRow label="token usage" value={active.capabilities.usage} />
            </div>
          )}
          {active.credential_storage === "memory" && (
            <Notice tone="warning" className="mt-4">
              ▲ 系统凭据存储不可用，API key 仅保存在本进程内存，关闭程序后需重新输入。
            </Notice>
          )}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--color-rule)] pt-4">
            <Button variant="secondary" onClick={openEdit}>
              <Icon name="pen" size={14} />
              编辑配置
            </Button>
            <Button variant="danger" onClick={() => void removeActive()}>
              <Icon name="trash" size={14} />
              删除配置
            </Button>
          </div>
        </Card>
      )}

      {active?.compatible && !consentId && (
        <Card className="reveal relative overflow-hidden border-[var(--color-rule-strong)]">
          <div className="relative flex items-start gap-4">
            <span className="flex size-11 shrink-0 items-center justify-center border border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)] text-[var(--color-accent)]">
              <Icon name="shield" size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="eyebrow">DATA CONSENT</p>
              <h3 className="mt-1 font-[family-name:var(--font-display)] text-lg font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                业务数据发送确认
              </h3>
              <p className="mt-2 max-w-[62ch] text-[length:var(--text-sm)] leading-6 text-[var(--color-neutral)]">
                首次向该配置发送业务数据前需要确认：服务「{active.name}」(
                <span className="font-[family-name:var(--font-outlier)] text-[length:var(--text-xs)]">
                  {consentInfo?.host || active.base_url}
                </span>
                ，模型 {active.model})将只接收当前任务所需的文本块、考点描述与题型约束；不发送原始文件。确认仅代表本机操作确认，不替代所在单位的数据合规授权。
              </p>
              <div className="mt-4 grid gap-px border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-2">
                <div className="bg-[var(--color-paper-2)] px-3.5 py-3">
                  <p className="text-[9px] tracking-[0.16em] text-[var(--color-success)]">会发送</p>
                  <p className="mt-1 text-[length:var(--text-xs)] leading-5 text-[var(--color-neutral)]">
                    文本块、考点描述、题型与数量约束
                  </p>
                </div>
                <div className="bg-[var(--color-paper-2)] px-3.5 py-3">
                  <p className="text-[9px] tracking-[0.16em] text-[var(--color-muted)]">不会发送</p>
                  <p className="mt-1 text-[length:var(--text-xs)] leading-5 text-[var(--color-neutral)]">
                    原始文件、API key、系统凭据
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <Button onClick={() => void confirmConsent()}>
                  查看并确认发送范围
                  <Icon name="arrowRight" size={15} />
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}
      {consentId && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-[var(--color-success)] bg-[#edf0e6]/70 px-4 py-3">
          <p className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-success)]">
            <Icon name="circleCheck" size={16} />
            ✓ 数据发送范围已确认。
          </p>
          <Button variant="ghost" onClick={() => void revokeConsent()}>撤销数据发送授权</Button>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-[var(--color-rule-strong)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="secondary" onClick={() => goto(0)}>上一步</Button>
        <div className="flex flex-wrap items-center gap-3">
          {!consentId && (
            <span className="text-[length:var(--text-xs)] text-[var(--color-muted)]">
              测试通过并确认发送范围后可继续
            </span>
          )}
          <Button disabled={!active?.compatible || !consentId} onClick={() => goto(2)}>
            下一步:配置题目
            <Icon name="arrowRight" size={16} />
          </Button>
        </div>
      </div>
    </section>
  );
}
