import { apiDelete, apiGet, apiPatch, apiPost, apiUpload } from "./client";
import type {
  AIProfileDto,
  ConsentDto,
  ConsentStatusDto,
  DocumentDto,
  EstimateDto,
  JobDto,
  KnowledgePointDto,
  ListEnvelope,
  QuizRecordDto,
  QuestionDto,
} from "../types/api";

export const getHealth = () => apiGet<{ status: string; app: string; version: string }>("/api/health");

export const listDocuments = () => apiGet<ListEnvelope<DocumentDto>>("/api/documents");
export const getDocument = (id: string) => apiGet<DocumentDto>(`/api/documents/${id}`);
export const uploadDocuments = (files: File[]) =>
  apiUpload<{ items: { document: DocumentDto; job_id: string }[] }>("/api/documents", files);
export const documentDeletionImpact = (id: string) =>
  apiGet<{
    can_delete: boolean;
    blocking_quiz_record_ids: string[];
    counts: Record<string, number>;
    deletion_token?: string;
    message: string;
  }>(`/api/documents/${id}/deletion-impact`);
export const deleteDocument = (id: string, token: string) => apiDelete<void>(`/api/documents/${id}`, token);

export const listJobs = (params?: string) =>
  apiGet<ListEnvelope<JobDto>>(`/api/jobs${params ? "?" + params : ""}`);
export const getJob = (id: string) => apiGet<JobDto>(`/api/jobs/${id}`);
export const cancelJob = (id: string) => apiPost<{ status: string }>(`/api/jobs/${id}/cancel`);
export const resumeJob = (id: string, consentId?: string) =>
  apiPost<{ job_id: string; status: string }>(`/api/jobs/${id}/resume`, consentId ? { consent_id: consentId } : undefined);

export const listProfiles = () => apiGet<ListEnvelope<AIProfileDto>>("/api/ai-profiles");
export const createProfile = (body: Record<string, unknown>) =>
  apiPost<AIProfileDto>("/api/ai-profiles", body);
export const patchProfile = (id: string, body: Record<string, unknown>) =>
  apiPatch<AIProfileDto>(`/api/ai-profiles/${id}`, body);
export const probeProfile = (id: string) => apiPost<AIProfileDto>(`/api/ai-profiles/${id}/probe`);
export const profileDeletionImpact = (id: string) =>
  apiGet<{ counts: Record<string, number>; deletion_token: string; message: string }>(
    `/api/ai-profiles/${id}/deletion-impact`);
export const deleteProfile = (id: string, token: string) => apiDelete<void>(`/api/ai-profiles/${id}`, token);

export const consentStatus = (profileId: string) =>
  apiGet<ConsentStatusDto>(`/api/data-sharing-consents?ai_profile_id=${profileId}`);
export const createConsent = (profileId: string) =>
  apiPost<ConsentDto>("/api/data-sharing-consents", {
    ai_profile_id: profileId,
    accepted: true,
    disclosure_version: "1.0",
  });
export const revokeConsent = (id: string) => apiPost<{ id: string }>(`/api/data-sharing-consents/${id}/revoke`);

export const estimate = (body: Record<string, unknown>) => apiPost<EstimateDto>("/api/estimates", body);

export const createExtractionJob = (body: Record<string, unknown>) =>
  apiPost<{ job_id: string }>("/api/extraction-jobs", body, true);
export const getExtractionJob = (id: string) => apiGet<JobDto>(`/api/extraction-jobs/${id}`);
export const listPoints = (jobId: string) =>
  apiGet<ListEnvelope<KnowledgePointDto>>(`/api/extraction-jobs/${jobId}/points`);
export const setPointSelected = (id: string, selected: boolean) =>
  apiPatch<KnowledgePointDto>(`/api/knowledge-points/${id}`, { selected });
export const bulkSelectPoints = (ids: string[], selected: boolean) =>
  apiPost<{ updated: number }>("/api/knowledge-points/bulk-selection", {
    point_ids: ids,
    selected,
  });

export const createGenerationJob = (body: Record<string, unknown>) =>
  apiPost<{ job_id: string; quiz_record_id: string }>("/api/generation-jobs", body, true);
export const getQuizRecord = (id: string) => apiGet<QuizRecordDto>(`/api/quiz-records/${id}`);
export const listQuizRecords = () => apiGet<ListEnvelope<QuizRecordDto>>("/api/quiz-records");
export const patchQuestion = (id: string, body: Record<string, unknown>) =>
  apiPatch<QuestionDto>(`/api/questions/${id}`, body);
export const reviewQuestion = (id: string, decision: "approve" | "reject") =>
  apiPost<QuestionDto>(`/api/questions/${id}/review`, { decision });
export const deleteQuestion = (id: string) => apiDelete<void>(`/api/questions/${id}`, "");
export const regenerateQuestion = (id: string, consentId: string) =>
  apiPost<{ job_id: string }>(`/api/questions/${id}/regenerate`, { consent_id: consentId }, true);
export const bulkReview = (quizId: string, ids: string[]) =>
  apiPost<{ approved: number }>(`/api/quiz-records/${quizId}/reviews/bulk`, { question_ids: ids });
export const fillMissing = (quizId: string, consentId: string) =>
  apiPost<{ job_id: string }>(`/api/quiz-records/${quizId}/fill-missing`, { consent_id: consentId }, true);

export interface ExportFileDto {
  id: string;
  kind: "student" | "answer";
  filename: string;
  download_url: string;
  is_current: boolean;
  created_at: string | null;
}

export const listExports = (quizId: string) =>
  apiGet<{ items: { batch_id: string; files: ExportFileDto[]; is_current: boolean }[] }>(
    `/api/quiz-records/${quizId}/exports`);
export const createExports = (quizId: string) =>
  apiPost<{ student: ExportFileDto; answer: ExportFileDto }>(
    `/api/quiz-records/${quizId}/exports`, undefined, true);
export const quizDeletionImpact = (id: string) =>
  apiGet<{ counts: Record<string, number>; deletion_token: string; message: string }>(
    `/api/quiz-records/${id}/deletion-impact`);
export const deleteQuizRecord = (id: string, token: string) => apiDelete<void>(`/api/quiz-records/${id}`, token);
