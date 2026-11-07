import { useEffect, useRef, useState } from "react";
import * as api from "../api/endpoints";
import { ApiError } from "../api/client";
import { isPublicMode } from "../demo/mode";
import { useWorkflow } from "../store";
import { useToast } from "../components/ui/toast";
import { Badge, Card, Checkbox } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icons";
import { PageHeader, SectionHeading, Stat } from "../components/ui/layout";
import type { DocumentDto } from "../types/api";

function statusBadge(status: string) {
  if (status === "ready") return <Badge tone="success">✓ 解析成功</Badge>;
  if (status === "failed") return <Badge tone="danger">✕ 解析失败</Badge>;
  if (status === "running") return <Badge tone="accent">… 解析中</Badge>;
  return <Badge tone="neutral">… 等待解析</Badge>;
}

export function UploadPage() {
  const { documents, refreshDocuments, selectedDocumentIds, toggleDocument, goto } = useWorkflow();
  const { push } = useToast();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [details, setDetails] = useState<Record<string, DocumentDto>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const [impact, setImpact] = useState<{
    id: string;
    can_delete: boolean;
    blocking: string[];
    counts: Record<string, number>;
    token?: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (documents.some((d) => d.parse_status === "pending" || d.parse_status === "running")) {
      const timer = setInterval(() => {
        void refreshDocuments();
      }, 1200);
      return () => clearInterval(timer);
    }
  }, [documents, refreshDocuments]);

  useEffect(() => {
    const missing = documents.filter((doc) => doc.parse_status === "ready" && !details[doc.id]);
    if (!missing.length) return;
    let alive = true;
    void Promise.all(missing.map((doc) => api.getDocument(doc.id).catch(() => null))).then((items) => {
      if (!alive) return;
      setDetails((previous) => {
        const validItems = items.filter((item): item is DocumentDto => item !== null);
        if (!validItems.length) return previous;
        const next = { ...previous };
        for (const item of validItems) {
          next[item.id] = item;
        }
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [documents, details]);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      await api.uploadDocuments(list);
      await refreshDocuments();
      push({ tone: "success", message: `已开始解析 ${list.length} 个文件` });
    } catch (error) {
      const message = error instanceof ApiError ? `${error.message}(${error.action})` : "上传失败,请重试";
      push({ tone: "danger", message });
    } finally {
      setUploading(false);
    }
  }

  async function askDelete(id: string) {
    try {
      const data = await api.documentDeletionImpact(id);
      setImpact({
        id,
        can_delete: data.can_delete,
        blocking: data.blocking_quiz_record_ids,
        counts: data.counts,
        token: data.deletion_token,
        message: data.message,
      });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? error.message : "查询影响范围失败",
      });
    }
  }

  async function confirmDelete() {
    if (!impact || !impact.token) return;
    try {
      await api.deleteDocument(impact.id, impact.token);
      push({ tone: "success", message: "文档及解析数据已删除" });
      setImpact(null);
      await refreshDocuments();
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "删除失败",
      });
    }
  }

  const readyCount = documents.filter((d) => d.parse_status === "ready").length;
  const selectedCount = documents.filter(
    (d) => d.parse_status === "ready" && selectedDocumentIds.includes(d.id),
  ).length;

  return (
    <section className="space-y-8" aria-labelledby="upload-title">
      <PageHeader
        step={1}
        kicker="上传文档"
        title="上传制度文档"
        description={
          isPublicMode
            ? "支持文字版 PDF 和 DOCX。公共体验单文件最大 15 MB、一次最多 3 个、最多保留 9 份文档，单篇最多读取约 6 万字。文档只保存在你的浏览器中。"
            : "支持文字版 PDF 和 DOCX。单文件最大 50 MB，一次最多 10 个文件，总计不超过 200 MB。加密或损坏文件会在解析时给出提示。"
        }
        aside={
          <div className="ui-folio">
            <Stat
              label="已就绪"
              value={readyCount}
              unit="份"
              tone={readyCount > 0 ? "accent" : "neutral"}
            />
            <span className="h-8 w-px bg-[var(--color-rule)]" aria-hidden="true" />
            <Stat label="已上传" value={documents.length} unit="份" />
          </div>
        }
      />

      <div className="reveal" style={{ ["--i" as string]: 1 }}>
        <div
          role="button"
          tabIndex={0}
          aria-label="拖拽或选择文件上传"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void upload(event.dataTransfer.files);
          }}
          className={
            "dropzone group relative overflow-hidden rounded-[var(--radius-sm)] " +
            (dragging ? "is-dragging" : "")
          }
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-9 right-3 select-none font-[family-name:var(--font-display)] text-[11rem] leading-none text-[var(--color-ink)] opacity-[0.035] transition-transform duration-[var(--dur-med)] ease-[var(--ease-paper)] group-hover:-translate-y-1"
          >
            01
          </span>
          <div className="relative flex flex-col items-center gap-4 px-6 py-11 text-center">
            <span className="stamp size-14 text-[var(--color-accent)] transition-transform duration-[var(--dur-med)] ease-[var(--ease-paper)] group-hover:-translate-y-0.5">
              <Icon name="upload" size={22} />
            </span>
            <div>
              <p className="font-[family-name:var(--font-display)] text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                拖拽文件到此处，或点击选择文件
              </p>
              <p className="mt-1.5 text-[length:var(--text-xs)] tracking-[0.02em] text-[var(--color-muted)]">
                {isPublicMode ? "PDF / DOCX · 单文件 ≤ 15 MB · 一次最多 3 个" : "PDF / DOCX · 单文件 ≤ 50 MB · 一次最多 10 个"}
              </p>
            </div>
            <span className="inline-flex min-h-10 items-center gap-2 border border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)]/80 px-4 text-[length:var(--text-sm)] text-[var(--color-ink)] transition-colors group-hover:border-[var(--color-accent)] group-hover:text-[var(--color-accent)]">
              选择文件
              <Icon name="arrowRight" size={15} />
            </span>
          </div>
          <div className="relative flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 px-6 py-3 text-[11px] text-[var(--color-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="file" size={13} /> 文字版 PDF
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="files" size={13} /> DOCX
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="alert" size={13} /> 图片型 PDF 需先完成 OCR
            </span>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx"
          multiple
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) void upload(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {uploading && (
        <div className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-accent)]">
          <span className="live-dot" aria-hidden="true" />
          正在上传并解析…
        </div>
      )}

      {documents.length > 0 && (
        <div className="space-y-4">
          <SectionHeading
            index="ARCHIVE"
            title="已上传文档"
            description="勾选需要用于出题的文档，解析完成后即可进入下一步。"
            action={
              <span className="text-[length:var(--text-xs)] text-[var(--color-muted)]">
                已选 <span className="font-[family-name:var(--font-outlier)] text-[var(--color-accent)]">{selectedCount}</span> / {readyCount} 份
              </span>
            }
          />
          <ul className="space-y-3" aria-label="已上传文档">
            {documents.map((doc, index) => {
              const selected = selectedDocumentIds.includes(doc.id);
              return (
                <li key={doc.id} className="reveal" style={{ ["--i" as string]: Math.min(index + 2, 9) }}>
                  <Card
                    className={
                      "relative overflow-hidden p-0 " +
                      (selected ? "border-[var(--color-rule-strong)]" : "")
                    }
                  >
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-accent)]"
                      />
                    )}
                    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
                      <span className="flex size-11 shrink-0 items-center justify-center border border-[var(--color-rule)] bg-[var(--color-paper-hi)] text-[var(--color-accent)]">
                        <Icon name={doc.media_type === "pdf" ? "file" : "files"} size={19} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-[family-name:var(--font-display)] text-[15px] font-semibold text-[var(--color-ink)]">
                            {doc.original_name}
                          </p>
                          {statusBadge(doc.parse_status)}
                          {selected && <Badge tone="accent">已选</Badge>}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-muted)]">
                          <span className="font-[family-name:var(--font-outlier)] tracking-[0.04em]">
                            {doc.media_type.toUpperCase()}
                          </span>
                          <span className="size-1 rounded-full bg-[var(--color-rule-strong)]" aria-hidden="true" />
                          <span>{(doc.size_bytes / 1024 / 1024).toFixed(2)} MB</span>
                          <span className="size-1 rounded-full bg-[var(--color-rule-strong)]" aria-hidden="true" />
                          <span>
                            {doc.media_type === "pdf"
                              ? doc.page_count !== null
                                ? `${doc.page_count} 页`
                                : "页数解析中"
                              : `${doc.block_count} 个文本块`}
                          </span>
                        </div>
                        {doc.parse_error && (
                          <p className="mt-2 flex items-start gap-1.5 text-[length:var(--text-xs)] leading-5 text-[var(--color-danger)]">
                            <Icon name="alert" size={13} className="mt-1 shrink-0" />
                            {doc.parse_error} — 请更换文件或先完成 OCR
                          </p>
                        )}
                        {details[doc.id]?.preview && (
                          <div className="ui-inset mt-3 rounded-[var(--radius-md)] px-3.5 py-3">
                            <p className="flex items-center gap-1.5 text-[11px] tracking-[0.04em] text-[var(--color-muted)]">
                              <Icon name="scan" size={12} />
                              解析预览（前 300 字）
                            </p>
                            <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[length:var(--text-xs)] leading-5 text-[var(--color-neutral)]">
                              {details[doc.id].preview?.slice(0, 300)}
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--color-rule)] pt-3 sm:flex-col sm:items-end sm:border-0 sm:pt-0">
                        {doc.parse_status === "ready" ? (
                          <Checkbox
                            checked={selected}
                            onChange={() => toggleDocument(doc.id)}
                            label="用于出题"
                          />
                        ) : (
                          <span className="text-[11px] text-[var(--color-muted)]">等待解析</span>
                        )}
                        <Button variant="ghost" className="px-2.5" onClick={() => void askDelete(doc.id)}>
                          <Icon name="trash" size={14} />
                          删除
                        </Button>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {impact && (
        <Card
          role="dialog"
          aria-label="删除确认"
          className="border-[var(--color-danger)]/40"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center border border-[var(--color-danger)]/35 bg-[#f5e6e0] text-[var(--color-danger)]">
              <Icon name="alert" size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-[family-name:var(--font-display)] text-base font-semibold">删除前确认</h3>
              <p className="mt-2 text-[length:var(--text-sm)] leading-6 text-[var(--color-neutral)]">{impact.message}</p>
              {!impact.can_delete ? (
                <p className="mt-2 text-[length:var(--text-sm)] leading-6 text-[var(--color-danger)]">
                  该文档仍被 {impact.blocking.length} 份历史试卷引用，需先删除对应试卷后才能删除文档。
                </p>
              ) : (
                <p className="mt-2 text-[length:var(--text-xs)] leading-5 text-[var(--color-muted)]">
                  将删除：{impact.counts.source_blocks} 个文本块、{impact.counts.parse_jobs} 个解析任务、
                  {impact.counts.extraction_jobs} 个抽取任务及 {impact.counts.unfrozen_knowledge_points} 个未冻结考点。
                </p>
              )}
              <div className="mt-4 flex gap-2">
                {impact.can_delete && (
                  <Button variant="danger" onClick={() => void confirmDelete()}>
                    确认删除
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setImpact(null)}>
                  {impact.can_delete ? "取消" : "知道了"}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-3 border-t border-[var(--color-rule-strong)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-muted)]">
          <span
            aria-hidden="true"
            className={
              "size-[5px] " +
              (readyCount > 0 ? "bg-[var(--color-success)]" : "bg-[var(--color-muted)]")
            }
          />
          已就绪 {readyCount} 个文档
          {readyCount === 0 ? " — 上传并等待解析完成后进入下一步" : ""}
        </p>
        <Button disabled={readyCount === 0} onClick={() => goto(1)}>
          下一步:选择 AI 配置
          <Icon name="arrowRight" size={16} />
        </Button>
      </div>
    </section>
  );
}
