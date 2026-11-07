import { useEffect, useState } from "react";
import { isDemoMode, isPublicMode } from "../demo/mode";
import type { JobEventPayload } from "../types/api";

export interface UseJobEventsResult {
  connected: boolean;
  events: JobEventPayload[];
  lastEvent: JobEventPayload | null;
}

/**
 * 订阅任务 SSE:原生 EventSource(仅 GET),断线自动重连并用
 * Last-Event-ID 续传(由浏览器与后端共同保证)。
 */
export function useJobEvents(jobId: string | null): UseJobEventsResult {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<JobEventPayload[]>([]);

  useEffect(() => {
    if (!jobId) {
      setConnected(false);
      return;
    }
    setEvents([]);

    if (isDemoMode || isPublicMode) {
      // 纯浏览器引擎没有 SSE 端点，任务进度由页面轮询 /api/jobs 获取。
      setConnected(true);
      return;
    }

    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    const names = [
      "job_started",
      "progress",
      "document_ready",
      "point_created",
      "question_ready",
      "question_failed",
      "job_partial",
      "job_completed",
      "job_failed",
      "job_cancelled",
    ];
    const handlers = names.map((name) => {
      const handler = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as JobEventPayload;
          setEvents((prev) => [...prev, payload]);
          setConnected(true);
        } catch {
          setConnected(false);
        }
      };
      source.addEventListener(name, handler);
      return { name, handler };
    });

    return () => {
      for (const { name, handler } of handlers) {
        source.removeEventListener(name, handler as EventListener);
      }
      source.close();
      setConnected(false);
    };
  }, [jobId]);

  return { connected, events, lastEvent: events[events.length - 1] ?? null };
}
