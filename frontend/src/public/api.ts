import { isPublicMockAi } from "../demo/mode";
import * as engine from "./engine";
import { EngineError } from "./model";

function json(body: unknown, status = 200) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isPublicMockAi) headers["X-AI-Quiz-Mock"] = "1";
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(error: unknown): Response {
  if (error instanceof EngineError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          action: error.action,
          request_id: crypto.randomUUID(),
        },
      },
      error.status,
    );
  }
  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "本地引擎处理失败。",
        action: "刷新页面后重试",
        request_id: crypto.randomUUID(),
      },
    },
    500,
  );
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== "string") return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(url: URL, method: string, init: RequestInit): Promise<Response> {
  await engine.ensureState();
  const path = url.pathname;
  const body = bodyOf(init);

  if (path === "/api/health") {
    return json({ status: "ok", app: "AI 出题精灵（自带 Key）", version: "1.3.0-byok" });
  }

  if (path === "/api/documents") {
    if (method === "GET") return json(await engine.listDocuments());
    if (method === "POST") {
      const form = init.body as FormData;
      const files = form.getAll("files").filter((item): item is File => item instanceof File);
      return json(await engine.uploadDocuments(files));
    }
  }

  const docImpact = path.match(/^\/api\/documents\/([^/]+)\/deletion-impact$/);
  if (docImpact && method === "GET") return json(engine.documentDeletionImpact(docImpact[1]));

  const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch) {
    if (method === "GET") return json(engine.getDocument(docMatch[1]));
    if (method === "DELETE") {
      const token = new Headers(init.headers).get("X-Deletion-Token") ?? "";
      engine.deleteDocument(docMatch[1], token);
      return new Response(null, { status: 204 });
    }
  }

  if (path === "/api/jobs" && method === "GET") return json(engine.listJobs());
  const jobAction = path.match(/^\/api\/jobs\/([^/]+)\/(cancel|resume)$/);
  if (jobAction) {
    return json(
      jobAction[2] === "cancel" ? engine.cancelJob(jobAction[1]) : engine.resumeJob(jobAction[1]),
    );
  }
  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && method === "GET") return json(engine.getJob(jobMatch[1]));

  if (path === "/api/ai-profiles") {
    if (method === "GET") {
      const profiles = await engine.listProfiles();
      return json(profiles);
    }
    engine.rejectProfileMutation();
  }
  const profileProbe = path.match(/^\/api\/ai-profiles\/([^/]+)\/probe$/);
  if (profileProbe && method === "POST") return json(await engine.probeProfile(profileProbe[1]));
  const profileImpact = path.match(/^\/api\/ai-profiles\/([^/]+)\/deletion-impact$/);
  if (profileImpact && method === "GET") {
    return json({ counts: {}, deletion_token: "public", message: "自带 Key 配置只保存在浏览器，可直接在 AI 配置页清除。" });
  }
  const profileMatch = path.match(/^\/api\/ai-profiles\/([^/]+)$/);
  if (profileMatch) engine.rejectProfileMutation();

  if (path === "/api/data-sharing-consents") {
    if (method === "GET") {
      return json(engine.consentStatus(url.searchParams.get("ai_profile_id") ?? ""));
    }
    if (method === "POST") return json(engine.createConsent(String(body.ai_profile_id ?? "")));
  }
  const revoke = path.match(/^\/api\/data-sharing-consents\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") return json(engine.revokeConsent(revoke[1]));

  if (path === "/api/estimates" && method === "POST") return json(engine.estimate(body));

  if (path === "/api/extraction-jobs" && method === "POST") {
    return json(engine.createExtractionJob(body));
  }
  const extractionPoints = path.match(/^\/api\/extraction-jobs\/([^/]+)\/points$/);
  if (extractionPoints && method === "GET") return json(engine.listPoints(extractionPoints[1]));
  const extractionJob = path.match(/^\/api\/extraction-jobs\/([^/]+)$/);
  if (extractionJob && method === "GET") return json(engine.getJob(extractionJob[1]));

  const pointMatch = path.match(/^\/api\/knowledge-points\/([^/]+)$/);
  if (pointMatch && method === "PATCH") return json(engine.patchPoint(pointMatch[1], body));
  if (path === "/api/knowledge-points/bulk-selection" && method === "POST") {
    const ids = Array.isArray(body.point_ids) ? body.point_ids.map(String) : [];
    return json(engine.bulkSelectPoints(ids, Boolean(body.selected)));
  }

  if (path === "/api/generation-jobs" && method === "POST") {
    return json(engine.createGenerationJob(body));
  }
  const generationJob = path.match(/^\/api\/generation-jobs\/([^/]+)$/);
  if (generationJob && method === "GET") return json(engine.getJob(generationJob[1]));

  if (path === "/api/quiz-records" && method === "GET") return json(engine.listQuizRecords());

  const quizExports = path.match(/^\/api\/quiz-records\/([^/]+)\/exports$/);
  if (quizExports) {
    if (method === "GET") return json(await engine.listExports(quizExports[1]));
    if (method === "POST") return json(await engine.createExports(quizExports[1]));
  }
  const bulkReview = path.match(/^\/api\/quiz-records\/([^/]+)\/reviews\/bulk$/);
  if (bulkReview && method === "POST") {
    const ids = Array.isArray(body.question_ids) ? body.question_ids.map(String) : [];
    return json(engine.bulkReview(bulkReview[1], ids));
  }
  const fillMissing = path.match(/^\/api\/quiz-records\/([^/]+)\/fill-missing$/);
  if (fillMissing && method === "POST") {
    return json(engine.fillMissing(fillMissing[1], String(body.consent_id ?? "")));
  }
  const quizImpact = path.match(/^\/api\/quiz-records\/([^/]+)\/deletion-impact$/);
  if (quizImpact && method === "GET") return json(engine.quizDeletionImpact(quizImpact[1]));
  const quizMatch = path.match(/^\/api\/quiz-records\/([^/]+)$/);
  if (quizMatch) {
    if (method === "GET") return json(engine.getQuizRecord(quizMatch[1]));
    if (method === "DELETE") {
      const token = new Headers(init.headers).get("X-Deletion-Token") ?? "";
      engine.deleteQuizRecord(quizMatch[1], token);
      return new Response(null, { status: 204 });
    }
  }

  const questionReview = path.match(/^\/api\/questions\/([^/]+)\/review$/);
  if (questionReview && method === "POST") {
    return json(engine.reviewQuestion(questionReview[1], body.decision === "approve" ? "approve" : "reject"));
  }
  const regenerate = path.match(/^\/api\/questions\/([^/]+)\/regenerate$/);
  if (regenerate && method === "POST") {
    return json(engine.regenerateQuestion(regenerate[1], String(body.consent_id ?? "")));
  }
  const questionMatch = path.match(/^\/api\/questions\/([^/]+)$/);
  if (questionMatch) {
    if (method === "PATCH") return json(engine.patchQuestion(questionMatch[1], body));
    if (method === "DELETE") {
      engine.deleteQuestion(questionMatch[1]);
      return new Response(null, { status: 204 });
    }
  }

  throw new EngineError(
    404,
    "ROUTE_NOT_FOUND",
    `公共版未实现接口：${method} ${path}`,
    "返回上一步",
  );
}

export function installPublicApi() {
  if (typeof window === "undefined") return;
  void engine.ensureState();
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handle(url, (init.method ?? "GET").toUpperCase(), init);
      } catch (error) {
        return failure(error);
      }
    }
    return originalFetch(input, init);
  };
}
