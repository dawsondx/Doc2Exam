import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as api from "./api/endpoints";
import { isDemoMode, isPublicMode } from "./demo/mode";
import type {
  AIProfileDto,
  DocumentDto,
  JobDto,
  KnowledgePointDto,
  QuestionDto,
  QuizRecordDto,
} from "./types/api";

export const STEPS = [
  { key: "upload", label: "上传文档" },
  { key: "profile", label: "AI 配置" },
  { key: "config", label: "配置题目" },
  { key: "extract", label: "抽取考点" },
  { key: "points", label: "选择考点" },
  { key: "generate", label: "生成题目" },
  { key: "review", label: "人工复核" },
  { key: "export", label: "导出与历史" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

export interface QuestionConfig {
  single_choice: number;
  true_false: number;
  fill_blank: number;
}

interface WorkflowState {
  step: number;
  goto: (index: number) => void;
  maxUnlocked: number;
  documents: DocumentDto[];
  refreshDocuments: () => Promise<void>;
  selectedDocumentIds: string[];
  toggleDocument: (id: string) => void;
  profiles: AIProfileDto[];
  refreshProfiles: () => Promise<void>;
  activeProfileId: string | null;
  setActiveProfileId: (id: string | null) => void;
  consentId: string | null;
  setConsentId: (id: string | null) => void;
  questionConfig: QuestionConfig;
  setQuestionConfig: (config: QuestionConfig) => void;
  extractionJobId: string | null;
  setExtractionJobId: (id: string | null) => void;
  generationJobId: string | null;
  setGenerationJobId: (id: string | null) => void;
  points: KnowledgePointDto[];
  refreshPoints: (jobId: string) => Promise<void>;
  quizRecordId: string | null;
  setQuizRecordId: (id: string | null) => void;
  showReview: (id: string) => void;
  quiz: QuizRecordDto | null;
  refreshQuiz: (id: string) => Promise<void>;
  activeJobs: JobDto[];
  refreshJobs: () => Promise<void>;
}

const WorkflowContext = createContext<WorkflowState | null>(null);

export function useWorkflow(): WorkflowState {
  const context = useContext(WorkflowContext);
  if (!context) {
    throw new Error("useWorkflow 必须在 WorkflowProvider 内使用");
  }
  return context;
}

export function WorkflowProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState(0);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<AIProfileDto[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [consentId, setConsentId] = useState<string | null>(null);
  const [questionConfig, setQuestionConfig] = useState<QuestionConfig>({
    single_choice: isDemoMode ? 4 : isPublicMode ? 6 : 10,
    true_false: isDemoMode ? 3 : isPublicMode ? 3 : 6,
    fill_blank: isDemoMode ? 3 : isPublicMode ? 3 : 4,
  });
  const [extractionJobId, setExtractionJobId] = useState<string | null>(null);
  const [generationJobId, setGenerationJobId] = useState<string | null>(null);
  const [points, setPoints] = useState<KnowledgePointDto[]>([]);
  const [quizRecordId, setQuizRecordId] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<QuizRecordDto | null>(null);
  const [activeJobs, setActiveJobs] = useState<JobDto[]>([]);

  const refreshDocuments = useCallback(async () => {
    const data = await api.listDocuments();
    setDocuments(data.items);
    setSelectedDocumentIds((prev: string[]): string[] => {
      const ready = new Set(
        data.items
          .filter((d: DocumentDto) => d.parse_status === "ready")
          .map((d: DocumentDto) => d.id),
      );
      const next = prev.filter((id: string) => ready.has(id));
      return next.length ? next : Array.from(ready).slice(0, 1);
    });
  }, []);

  const refreshProfiles = useCallback(async () => {
    const data = await api.listProfiles();
    setProfiles(data.items);
    setActiveProfileId((prev: string | null): string | null =>
      prev && data.items.some((p: AIProfileDto) => p.id === prev)
        ? prev
        : (data.items[0]?.id ?? null),
    );
  }, []);

  const refreshPoints = useCallback(async (jobId: string) => {
    const data = await api.listPoints(jobId);
    setPoints(data.items);
  }, []);

  const refreshQuiz = useCallback(async (id: string) => {
    const data = await api.getQuizRecord(id);
    setQuiz(data);
    const questions: QuestionDto[] = data.questions ?? [];
    if (questions.length) {
      setQuestionConfig({
        single_choice: data.question_config.single_choice ?? 0,
        true_false: data.question_config.true_false ?? 0,
        fill_blank: data.question_config.fill_blank ?? 0,
      });
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    const data = await api.listJobs();
    setActiveJobs(
      data.items.filter(
        (j: JobDto) =>
          j.status === "interrupted" || j.status === "queued" || j.status === "running",
      ),
    );
  }, []);

  // 页面恢复(规格 4.2):刷新/重开后从后端重新发现任务、授权与最近工作位置
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [documentData, profileData, jobData, quizData] = await Promise.all([
          api.listDocuments(),
          api.listProfiles(),
          api.listJobs(),
          api.listQuizRecords(),
        ]);
        if (!alive) return;

        setDocuments(documentData.items);
        setProfiles(profileData.items);
        setActiveJobs(
          jobData.items.filter((job) =>
            job.status === "interrupted" || job.status === "queued" || job.status === "running"),
        );

        const latestQuiz = quizData.items[0] ?? null;
        const quizDetail = latestQuiz ? await api.getQuizRecord(latestQuiz.id) : null;
        if (!alive) return;
        if (quizDetail) {
          setQuizRecordId(quizDetail.id);
          setQuiz(quizDetail);
          setQuestionConfig({
            single_choice: quizDetail.question_config.single_choice ?? 0,
            true_false: quizDetail.question_config.true_false ?? 0,
            fill_blank: quizDetail.question_config.fill_blank ?? 0,
          });
        }

        const readyDocuments = documentData.items.filter((document) => document.parse_status === "ready");
        const quizDocumentNames = new Set(quizDetail?.documents ?? []);
        const matchingDocuments = readyDocuments
          .filter((document) => quizDocumentNames.has(document.original_name))
          .map((document) => document.id);
        setSelectedDocumentIds(
          isDemoMode && readyDocuments.length
            ? readyDocuments.map((document) => document.id)
            : matchingDocuments.length
              ? matchingDocuments
              : readyDocuments.slice(0, 1).map((d) => d.id),
        );

        const profile = profileData.items.find((item) => item.id === jobData.items.find(
          (job) => job.quiz_record_id === latestQuiz?.id && job.ai_profile_id,
        )?.ai_profile_id) ?? profileData.items[0] ?? null;
        setActiveProfileId(profile?.id ?? null);
        if (profile) {
          try {
            const status = await api.consentStatus(profile.id);
            if (alive) setConsentId(status.consent?.id ?? null);
          } catch {
            if (alive) setConsentId(null);
          }
        }

        const extractionJobs = jobData.items.filter((job) => job.job_type === "extraction");
        for (const extractionJob of extractionJobs) {
          try {
            const pointData = await api.listPoints(extractionJob.id);
            if (pointData.items.length) {
              if (alive) {
                setExtractionJobId(extractionJob.id);
                setPoints(pointData.items);
              }
              break;
            }
          } catch {
            // 旧任务可能已随文档清理,继续尝试下一项
          }
        }

        const latestGeneration = jobData.items.find(
          (job) => job.job_type === "generation" && job.quiz_record_id === latestQuiz?.id,
        );
        if (latestGeneration && ["queued", "running", "interrupted"].includes(latestGeneration.status)) {
          setGenerationJobId(latestGeneration.id);
          setStep(5);
        } else if (quizDetail) {
          setStep(quizDetail.status === "draft" ? 6 : 7);
        }
      } catch {
        // 健康检查失败时保留空态,页面会展示连接错误
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggleDocument = useCallback((id: string) => {
    setSelectedDocumentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const showReview = useCallback((id: string) => {
    // 仅供已由后端确认存在的试卷使用,避免异步详情更新与导航守卫竞态。
    setQuizRecordId(id);
    setStep(6);
  }, []);

  const maxUnlocked = useMemo(() => {
    // 步骤解锁条件:前置步骤的硬性条件满足后才可进入(规格 14.1)
    // 已存在试卷时允许直接回看复核和历史,不再要求本次会话重走授权与抽取。
    if (quizRecordId && quiz) return 7;
    // 创建生成任务时试卷 ID 会先于详情返回,此时也必须允许任务完成后进入复核。
    if (quizRecordId) return 6;
    let unlocked = 0;
    if (documents.some((d) => d.parse_status === "ready")) unlocked = 1;
    const profile = profiles.find((p) => p.id === activeProfileId);
    if (unlocked >= 1 && profile?.compatible && consentId) unlocked = 2;
    if (unlocked >= 2) unlocked = 3; // 配置题目总是可达
    if (unlocked >= 3 && extractionJobId) unlocked = 4;
    const selectedPoints = points.filter((p) => p.selected);
    const total = questionConfig.single_choice + questionConfig.true_false + questionConfig.fill_blank;
    if (unlocked >= 4 && selectedPoints.length >= total) unlocked = 5;
    return unlocked;
  }, [documents, profiles, activeProfileId, consentId, extractionJobId, points, questionConfig, quizRecordId, quiz]);

  const goto = useCallback(
    (index: number) => {
      if (index <= maxUnlocked) {
        setStep(index);
      }
    },
    [maxUnlocked],
  );

  const value: WorkflowState = {
    step,
    goto,
    maxUnlocked,
    documents,
    refreshDocuments,
    selectedDocumentIds,
    toggleDocument,
    profiles,
    refreshProfiles,
    activeProfileId,
    setActiveProfileId,
    consentId,
    setConsentId,
    questionConfig,
    setQuestionConfig,
    extractionJobId,
    setExtractionJobId,
    generationJobId,
    setGenerationJobId,
    points,
    refreshPoints,
    quizRecordId,
    setQuizRecordId,
    showReview,
    quiz,
    refreshQuiz,
    activeJobs,
    refreshJobs,
  };

  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}
