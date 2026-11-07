import type {
  AIProfileDto,
  DocumentDto,
  KnowledgePointDto,
  QuestionDto,
  QuizRecordDto,
} from "../types/api";

export const DEMO_PROFILE_ID = "profile-internal";
export const DEMO_EXTRACTION_DOC_ID = "doc-apron";

export const demoDocuments: DocumentDto[] = [
  {
    id: "doc-apron",
    original_name: "机场机坪运行管理规程（2025 修订）.pdf",
    media_type: "pdf",
    size_bytes: 4_823_040,
    page_count: 42,
    block_count: 126,
    parse_status: "ready",
    parse_error: null,
    created_at: "2026-10-20T09:12:00Z",
    preview:
      "第一章 总则\n第一条 为规范机场机坪运行秩序，保障航空器、车辆和人员安全，依据有关规章制定本规程。\n第二条 进入机坪的车辆和人员应当服从现场指挥，按照标志线行驶和停放。机坪内车辆最高时速一般不得超过 25 公里，靠近航空器、加油区域时应当进一步减速。",
  },
  {
    id: "doc-fod",
    original_name: "FOD 防范与外来物管理规范.docx",
    media_type: "docx",
    size_bytes: 1_264_320,
    page_count: null,
    block_count: 48,
    parse_status: "ready",
    parse_error: null,
    created_at: "2026-10-20T09:14:00Z",
    preview:
      "外来物（Foreign Object Debris，FOD）是指可能损伤航空器或系统的某种外来的物质、碎屑或物体。任何人发现 FOD 均应当随手清除；无法立即清除时，应当设置警示并及时报告现场指挥中心。",
  },
  {
    id: "doc-deice",
    original_name: "冬季除冰防冰作业指导书.pdf",
    media_type: "pdf",
    size_bytes: 2_886_900,
    page_count: 24,
    block_count: 76,
    parse_status: "ready",
    parse_error: null,
    created_at: "2026-10-20T09:16:00Z",
    preview:
      "除冰作业应当在指定除冰位进行，并按要求设置安全区域。除冰后使用防冰液延缓航空器表面再次结冰，除冰/防冰保持时间（HOLDOVER TIME，HOT）受天气、降水类型和液体浓度影响。",
  },
];

const capabilities = {
  text_generation: "supported",
  json_schema: "supported",
  json_object: "supported",
  plain_json: "supported",
  models_list: "supported",
  usage: "supported",
  tokenizer_known: true,
  preferred_output_mode: "json_schema",
};

export const demoProfiles: AIProfileDto[] = [
  {
    id: DEMO_PROFILE_ID,
    name: "培训专用 · 内部大模型",
    base_url: "https://ai.internal.example/v1",
    model: "qwen3-72b-instruct",
    api_mode: "chat_completions",
    context_window: 131072,
    max_output_tokens: 8192,
    max_concurrency: 4,
    input_price_per_million: 4,
    output_price_per_million: 12,
    price_currency: "CNY",
    has_api_key: true,
    last_probe_at: "2026-10-20T09:20:00Z",
    compatible: true,
    credential_storage: "system",
    profile_fingerprint: "fp_demo_internal_2026",
    capabilities,
    probe_verdict: "4/4 探测通过",
  },
  {
    id: "profile-backup",
    name: "备用 · 通用 OpenAI 兼容",
    base_url: "https://api.example.com/v1",
    model: "gpt-4.1-mini",
    api_mode: "chat_completions",
    context_window: 32768,
    max_output_tokens: 4096,
    max_concurrency: 2,
    input_price_per_million: null,
    output_price_per_million: null,
    price_currency: "USD",
    has_api_key: true,
    last_probe_at: null,
    compatible: false,
    credential_storage: "system",
    profile_fingerprint: "fp_demo_backup_2026",
  },
];

interface PointSeed {
  content: string;
  bloom: string;
  category: string;
  types: string[];
  review?: boolean;
  source: string;
}

const pointSeeds: PointSeed[] = [
  {
    content: "机坪内车辆应当按照规定路线和速度行驶，未经许可不得穿越航空器活动区。",
    bloom: "understand",
    category: "机坪运行",
    types: ["single_choice", "true_false"],
    source:
      "第二章 车辆管理\n第八条 进入机坪的车辆应当服从现场指挥，按照划定的行车路线行驶。未经许可，任何车辆不得穿越航空器活动区，不得在滑行道上行驶或停放。",
  },
  {
    content: "机坪内车辆最高时速一般不得超过 25 公里，靠近航空器或加油区域时应进一步减速。",
    bloom: "remember",
    category: "机坪运行",
    types: ["single_choice", "fill_blank"],
    source:
      "第八条 机坪内车辆最高时速一般不得超过 25 公里。在靠近航空器、加油区域、行人密集区域时，应当将车速降至确保安全的程度。",
  },
  {
    content: "车辆在机坪内停放时应停放在指定区域，并采取制动等防溜措施。",
    bloom: "apply",
    category: "机坪运行",
    types: ["single_choice", "true_false"],
    source:
      "第九条 车辆停放应当位于指定区域，不得占用行车道、消防通道和航空器保障作业位。驾驶员离车时应当熄火并采取制动措施。",
  },
  {
    content: "进入机坪作业的人员应当接受相应培训，并佩戴有效证件。",
    bloom: "remember",
    category: "安全管理",
    types: ["single_choice", "true_false"],
    source:
      "第三章 人员管理\n第十二条 进入机坪作业的人员应当完成机场管理机构组织的培训并考核合格，作业期间佩戴有效通行证件，接受现场检查。",
  },
  {
    content: "发现 FOD 应立即清除；无法立即清除时，应设置警示并及时报告。",
    bloom: "apply",
    category: "安全管理",
    types: ["single_choice", "true_false", "fill_blank"],
    review: true,
    source:
      "外来物（Foreign Object Debris，FOD）是指可能损伤航空器或系统的某种外来的物质、碎屑或物体。任何人发现 FOD 均应当随手清除；无法立即清除时，应当设置警示并及时报告现场指挥中心。",
  },
  {
    content: "FOD 可能造成航空器轮胎扎伤、发动机吸入损伤等安全后果。",
    bloom: "understand",
    category: "安全管理",
    types: ["single_choice", "true_false"],
    source:
      "FOD 是威胁航空器地面运行安全的重要因素，可能造成轮胎扎伤、机体划伤、发动机吸入损伤等后果。各单位应当落实区域责任，定期开展步行检查。",
  },
  {
    content: "机坪作业人员应当熟悉紧急撤离路线和集合点位置。",
    bloom: "understand",
    category: "应急响应",
    types: ["true_false", "single_choice"],
    source:
      "第四章 应急管理\n第十八条 机坪作业人员应当熟悉本区域的紧急撤离路线、集合点位置和应急联络方式，参加机场组织的应急演练。",
  },
  {
    content: "发生航空器地面事故时，应首先保护现场并按规定报告。",
    bloom: "apply",
    category: "应急响应",
    types: ["single_choice"],
    source:
      "第十九条 发生航空器地面事故或事件时，现场人员应当立即报告，在确保自身安全的前提下保护现场，不得擅自移动有关证据和车辆。",
  },
  {
    content: "除冰作业应在指定除冰位进行，并按要求设置安全区域。",
    bloom: "apply",
    category: "除冰防冰",
    types: ["true_false", "single_choice"],
    source:
      "除冰作业应当在指定的除冰位进行。作业前应当设置安全区域，确认航空器状态和现场风向，防止除冰液喷溅影响其他人员和设备。",
  },
  {
    content: "防冰液用于在除冰后延缓航空器表面再次结冰。",
    bloom: "understand",
    category: "除冰防冰",
    types: ["fill_blank", "single_choice"],
    source:
      "除冰作业去除航空器表面的冰、雪、霜后，使用防冰液在关键表面形成保护层，以延缓再次结冰。防冰液的类型和浓度应当根据天气条件选择。",
  },
  {
    content: "除冰/防冰保持时间受天气、降水类型和液体浓度影响。",
    bloom: "understand",
    category: "除冰防冰",
    types: ["single_choice", "true_false"],
    source:
      "除冰/防冰保持时间（HOLDOVER TIME，HOT）是指从完成防冰液喷洒到航空器表面防护失效的时间，受外界温度、降水类型、风速和液体浓度等因素影响。",
  },
  {
    content: "除冰作业完成后，应按照保持时间要求控制起飞时机。",
    bloom: "apply",
    category: "除冰防冰",
    types: ["true_false"],
    review: true,
    source:
      "机组和地面保障单位应当共同确认除冰/防冰保持时间。超过保持时间仍未起飞的航空器，应当重新进行检查或除冰防冰作业。",
  },
  {
    content: "机坪内禁止吸烟和随意丢弃杂物。",
    bloom: "remember",
    category: "安全管理",
    types: ["true_false", "single_choice"],
    source:
      "机坪属于重点防火区域，禁止吸烟、明火和随意丢弃杂物。作业人员应当将产生的包装物、抹布等废弃物放入指定容器。",
  },
  {
    content: "航空器加油期间，车辆和人员应在规定的安全距离外通行。",
    bloom: "understand",
    category: "安全管理",
    types: ["single_choice", "true_false"],
    source:
      "航空器加油作业期间，加油区域周边应当设置警戒。无关车辆和人员不得进入加油作业区域，确需通行的应当按照现场指挥绕行。",
  },
  {
    content: "机坪标志线用于划分停放位、行车道和作业区域。",
    bloom: "remember",
    category: "机坪运行",
    types: ["fill_blank", "single_choice"],
    source:
      "机坪标志线用于划分航空器停放位、车辆行车道、人行通道和作业区域。车辆和人员应当按照标志线指引通行，不得跨越限制区域。",
  },
  {
    content: "恶劣天气下作业前，应评估风向、能见度和地面状况。",
    bloom: "analyze",
    category: "应急响应",
    types: ["single_choice"],
    source:
      "遇有大风、低能见度、冰雪等恶劣天气时，现场负责人应当在作业前评估风向、能见度和地面状况，必要时暂停作业并调整保障方案。",
  },
  {
    content: "任何人发现安全隐患都有责任及时报告。",
    bloom: "understand",
    category: "安全管理",
    types: ["true_false", "fill_blank"],
    source:
      "安全生产人人有责。任何人员发现设备缺陷、违章作业或其他安全隐患，均应当及时向现场负责人或安全管理部门报告。",
  },
  {
    content: "交接班时应说明设备状态、遗留问题和待办事项。",
    bloom: "apply",
    category: "机坪运行",
    types: ["fill_blank", "single_choice"],
    source:
      "交接班应当做到情况清楚、责任明确。交班人员应当说明设备运行状态、现场遗留问题、未完成事项和安全注意事项。",
  },
];

export const demoPointBase: KnowledgePointDto[] = pointSeeds.map((seed, index) => ({
  id: `point-${index + 1}`,
  extraction_job_id: "job-extraction-demo",
  document_id: index % 3 === 0 ? "doc-apron" : index % 3 === 1 ? "doc-fod" : "doc-deice",
  source_block_id: `block-${index + 1}`,
  content: seed.content,
  bloom_level: seed.bloom,
  category: seed.category,
  eligible_types: seed.types,
  selected: index < 10,
  selectable: true,
  requires_source_review: Boolean(seed.review),
  source_text: seed.source,
  created_at: "2026-10-20T09:31:00Z",
}));

interface QuestionSeed {
  type: QuestionDto["question_type"];
  pointId: string;
  stem: string;
  options?: string[];
  answer: string;
  acceptable?: string[];
  explanation: string;
  locator: string;
  block: string;
}

const questionSeeds: QuestionSeed[] = [
  {
    type: "single_choice",
    pointId: "point-1",
    stem: "在机坪内驾驶车辆时，除执行紧急任务外，最高时速一般不得超过多少？",
    options: ["15 公里/小时", "20 公里/小时", "25 公里/小时", "30 公里/小时"],
    answer: "C",
    explanation:
      "规程规定机坪内车辆最高时速一般不得超过 25 公里；靠近航空器、加油区域或行人密集区域时还应进一步减速。",
    locator: "《机场机坪运行管理规程》第 2 章 · 第 8 条 · 第 12 页",
    block:
      "第八条 机坪内车辆最高时速一般不得超过 25 公里。在靠近航空器、加油区域、行人密集区域时，应当将车速降至确保安全的程度。",
  },
  {
    type: "single_choice",
    pointId: "point-3",
    stem: "在机坪内发现油污，正确的首要处置是？",
    options: ["立即清除并设置警示", "等下一班次集中处理", "用清水冲入排水沟", "通知旅客绕行即可"],
    answer: "A",
    explanation:
      "油污会影响地面摩擦并可能污染航空器，发现后应立即清除；短时间无法清除的，应设置警示并报告。",
    locator: "《机场机坪运行管理规程》第 2 章 · 第 9 条 · 第 13 页",
    block:
      "第九条 车辆停放应当位于指定区域，不得占用行车道、消防通道和航空器保障作业位。作业过程中产生的油污应当立即清除。",
  },
  {
    type: "single_choice",
    pointId: "point-9",
    stem: "除冰作业中，用于防止航空器表面再次结冰的液体是？",
    options: ["除冰液", "防冰液", "清洗液", "润滑液"],
    answer: "B",
    explanation:
      "除冰液用于去除冰、雪、霜；防冰液在除冰后形成保护层，用于延缓航空器表面再次结冰。",
    locator: "《冬季除冰防冰作业指导书》第 3 章 · 第 9 页",
    block:
      "除冰作业去除航空器表面的冰、雪、霜后，使用防冰液在关键表面形成保护层，以延缓再次结冰。",
  },
  {
    type: "single_choice",
    pointId: "point-4",
    stem: "进入机坪作业前，人员首先应确认的是？",
    options: ["已完成培训并佩戴有效证件", "天气是否晴朗", "是否携带手机", "是否有同行人员"],
    answer: "A",
    explanation:
      "进入机坪作业的人员须完成培训并考核合格，作业期间佩戴有效通行证件，接受现场检查。",
    locator: "《机场机坪运行管理规程》第 3 章 · 第 12 条 · 第 17 页",
    block:
      "第十二条 进入机坪作业的人员应当完成机场管理机构组织的培训并考核合格，作业期间佩戴有效通行证件，接受现场检查。",
  },
  {
    type: "true_false",
    pointId: "point-2",
    stem: "发现无法立即清除的 FOD 时，应先设置警示并及时报告。",
    answer: "正确",
    explanation:
      "无法立即清除的 FOD 需要设置警示，防止航空器或车辆误入，同时报告现场指挥中心组织处理。",
    locator: "《FOD 防范与外来物管理规范》第 2 章 · 第 6 页",
    block:
      "任何人发现 FOD 均应当随手清除；无法立即清除时，应当设置警示并及时报告现场指挥中心。",
  },
  {
    type: "true_false",
    pointId: "point-6",
    stem: "只要完成除冰，就无需关注防冰保持时间。",
    answer: "错误",
    explanation:
      "除冰后仍可能再次结冰，必须结合天气条件确认防冰保持时间，超时后应重新检查或作业。",
    locator: "《冬季除冰防冰作业指导书》第 4 章 · 第 12 页",
    block:
      "机组和地面保障单位应当共同确认除冰/防冰保持时间。超过保持时间仍未起飞的航空器，应当重新进行检查或除冰防冰作业。",
  },
  {
    type: "true_false",
    pointId: "point-7",
    stem: "机坪内可以随意穿越行车道，只要注意观察即可。",
    answer: "错误",
    explanation:
      "机坪内人员应当按照标志线和指定通道通行，不得随意穿越行车道或航空器活动区。",
    locator: "《机场机坪运行管理规程》第 2 章 · 第 10 条 · 第 14 页",
    block:
      "机坪内人员应当沿指定人行通道通行，穿越行车道时应当确认安全并服从现场指挥，不得随意横穿。",
  },
  {
    type: "fill_blank",
    pointId: "point-5",
    stem: "外来物（FOD）的中文含义是______。",
    answer: "外来物",
    acceptable: ["外来物", "外来物体"],
    explanation:
      "FOD 指可能损伤航空器或系统的外来物质、碎屑或物体，是机坪安全管理的重要对象。",
    locator: "《FOD 防范与外来物管理规范》第 1 章 · 第 2 页",
    block:
      "外来物（Foreign Object Debris，FOD）是指可能损伤航空器或系统的某种外来的物质、碎屑或物体。",
  },
  {
    type: "fill_blank",
    pointId: "point-8",
    stem: "机坪发生紧急情况时，现场人员应第一时间向______报告。",
    answer: "现场指挥中心",
    acceptable: ["现场指挥中心", "指挥中心", "运行指挥中心"],
    explanation:
      "发生紧急情况后应立即报告现场指挥中心，并在确保安全的前提下保护现场、配合处置。",
    locator: "《机场机坪运行管理规程》第 4 章 · 第 19 条 · 第 26 页",
    block:
      "第十九条 发生航空器地面事故或事件时，现场人员应当立即报告，在确保自身安全的前提下保护现场。",
  },
  {
    type: "fill_blank",
    pointId: "point-10",
    stem: "除冰/防冰保持时间通常用英文缩写______表示。",
    answer: "HOT",
    acceptable: ["HOT", "Holdover Time", "holdover time"],
    explanation:
      "HOT 即 Holdover Time，指从完成防冰液喷洒到航空器表面防护失效的时间。",
    locator: "《冬季除冰防冰作业指导书》第 4 章 · 第 10 页",
    block:
      "除冰/防冰保持时间（HOLDOVER TIME，HOT）是指从完成防冰液喷洒到航空器表面防护失效的时间。",
  },
];

export function buildQuestions(selectedPointIds: string[], config: Record<string, number>): QuestionDto[] {
  const groups: Record<string, QuestionSeed[]> = {
    single_choice: questionSeeds.filter((q) => q.type === "single_choice"),
    true_false: questionSeeds.filter((q) => q.type === "true_false"),
    fill_blank: questionSeeds.filter((q) => q.type === "fill_blank"),
  };
  const order: QuestionDto["question_type"][] = ["single_choice", "true_false", "fill_blank"];
  const result: QuestionDto[] = [];
  let slot = 1;
  for (const type of order) {
    const count = Math.max(0, Number(config[type] ?? 0));
    const pool = groups[type];
    for (let i = 0; i < count; i += 1) {
      const seed = pool[i % pool.length];
      const pointIndex = (slot - 1) % Math.max(selectedPointIds.length, 1);
      result.push({
        id: `question-${slot}`,
        quiz_record_id: "quiz-demo",
        slot_number: slot,
        question_type: seed.type,
        knowledge_point_id: selectedPointIds[pointIndex] ?? seed.pointId,
        stem: seed.stem,
        options: seed.options ? [...seed.options] : null,
        answer: seed.answer,
        acceptable_answers: seed.acceptable ? [...seed.acceptable] : null,
        explanation: seed.explanation,
        validation_state: "passed",
        validation_issues: [],
        review_state: "unreviewed",
        attempt_count: 1,
        source: {
          point_content: null,
          locator_label: seed.locator,
          block_text: seed.block,
          page_number: null,
        },
      });
      slot += 1;
    }
  }
  return result;
}

export const demoFrozenPoints = demoPointBase.map((point) => ({
  id: point.id,
  content: point.content,
  category: point.category,
  bloom_level: point.bloom_level,
  eligible_types: point.eligible_types,
  used: point.selected,
}));

export function buildQuiz(questions: QuestionDto[], config: Record<string, number>): QuizRecordDto {
  const target = questions.length;
  return {
    id: "quiz-demo",
    status: "draft",
    question_config: config,
    ai_profile_name: "培训专用 · 内部大模型",
    model_name: "qwen3-72b-instruct",
    seed: 20261020,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    documents: ["机场机坪运行管理规程（2025 修订）.pdf", "FOD 防范与外来物管理规范.docx"],
    questions,
    progress: {
      target,
      approved: 0,
      unreviewed: questions.filter((q) => q.review_state === "unreviewed").length,
      rejected: 0,
      missing: questions.filter((q) => !q.stem).length,
      export_ready: false,
    },
    frozen_points: demoFrozenPoints,
  };
}

export const demoExportFileNames = {
  student: "机坪运行规程_题目版.docx",
  answer: "机坪运行规程_答案版.docx",
};
