import type { QuestionConfig, SourceBlock } from "./model";
import { newId } from "./model";

const SOFT_LIMIT = 800;
const TAIL_MERGE_THRESHOLD = 200;
const ABSOLUTE_MAX = 1000;
const SENTENCE_END = "。！？；!?;.";

const CJK_RE = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/;

export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
  }
  const others = text.length - cjk;
  return cjk + Math.ceil(others / 4);
}

export function preSplit(text: string): string[] {
  if (text.length <= SOFT_LIMIT) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > SOFT_LIMIT) {
    const window = rest.slice(0, SOFT_LIMIT);
    let cut = -1;
    for (let i = window.length - 1; i >= 0; i -= 1) {
      if (SENTENCE_END.includes(window[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut <= 0) cut = SOFT_LIMIT;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

let blockSequence = 0;

function makeBlock(documentId: string, text: string, locatorKind: string, label: string, page: number | null): SourceBlock {
  blockSequence += 1;
  return {
    id: newId("blk"),
    document_id: documentId,
    ordinal: blockSequence,
    locator_kind: locatorKind,
    locator_label: label,
    page_number: page,
    text,
    normalized_text: normalizeText(text),
    estimated_tokens: estimateTokens(text),
  };
}

export function splitPdfPage(documentId: string, pageText: string, pageNumber: number): SourceBlock[] {
  const paragraphs = pageText
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  if (!paragraphs.length) return [];

  const fragments: { text: string; frag: number }[] = [];
  for (const para of paragraphs) {
    const pieces = preSplit(para);
    pieces.forEach((piece, index) => {
      fragments.push({ text: piece, frag: pieces.length > 1 ? index + 1 : 0 });
    });
  }

  const merged: { text: string; frag: number }[] = [];
  for (const fragment of fragments) {
    const last = merged[merged.length - 1];
    if (last && last.text.length + fragment.text.length <= SOFT_LIMIT) {
      last.text = `${last.text} ${fragment.text}`;
    } else {
      merged.push({ ...fragment });
    }
  }

  const tail = merged[merged.length - 1];
  if (merged.length >= 2 && tail && tail.text.length > 0 && tail.text.length < TAIL_MERGE_THRESHOLD) {
    merged.pop();
    const previous = merged[merged.length - 1];
    previous.text = `${previous.text} ${tail.text}`.slice(0, ABSOLUTE_MAX);
  }

  return merged.map((fragment) =>
    makeBlock(
      documentId,
      fragment.text,
      "pdf_page",
      fragment.frag === 0 ? `第 ${pageNumber} 页` : `第 ${pageNumber} 页 片段 ${fragment.frag}`,
      pageNumber,
    ),
  );
}

export function splitDocxItem(
  documentId: string,
  text: string,
  locatorKind: string,
  label: string,
): SourceBlock[] {
  const pieces = preSplit(text);
  return pieces.map((piece, index) =>
    makeBlock(
      documentId,
      piece,
      locatorKind,
      pieces.length === 1 ? label : `${label} 片段 ${index + 1}`,
      null,
    ),
  );
}

export interface Chunk {
  index: number;
  blocks: SourceBlock[];
  tokens: number;
}

export function assembleChunks(blocks: SourceBlock[], budget = 1500): Chunk[] {
  const chunks: Chunk[] = [];
  let current: SourceBlock[] = [];
  let tokens = 0;
  for (const block of blocks) {
    if (current.length && tokens + block.estimated_tokens > budget) {
      chunks.push({ index: chunks.length + 1, blocks: current, tokens });
      const tail = current[current.length - 1];
      current = [tail];
      tokens = tail.estimated_tokens;
      if (tokens + block.estimated_tokens > budget) {
        current = [];
        tokens = 0;
      }
    }
    current.push(block);
    tokens += block.estimated_tokens;
  }
  if (current.length) chunks.push({ index: chunks.length + 1, blocks: current, tokens });
  return chunks;
}

export function targetPointCount(total: number): number {
  return Math.max(12, Math.min(60, Math.ceil(total * 2.5)));
}

export function distributeQuota(chunks: Chunk[], total: number): number[] {
  const target = targetPointCount(total);
  const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0) || 1;
  const quotas = chunks.map((chunk) => Math.max(2, Math.round((target * chunk.tokens) / totalTokens)));
  const assigned = quotas.reduce((sum, value) => sum + value, 0);
  if (quotas.length) quotas[0] = Math.max(2, quotas[0] + target - assigned);
  return quotas;
}

export function semanticNormalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[，。、；：！？,.;:!?"'“”‘’()[\]{}<>《》—\-…·\s]+/g, "")
    .toLowerCase();
}

function charNgrams(text: string, n = 3): Set<string> {
  if (text.length < n) return new Set(text ? [text] : []);
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - n; i += 1) grams.add(text.slice(i, i + n));
  return grams;
}

export function jaccard(a: string, b: string): number {
  const ga = charNgrams(a);
  const gb = charNgrams(b);
  if (!ga.size || !gb.size) return 0;
  let intersection = 0;
  for (const gram of ga) if (gb.has(gram)) intersection += 1;
  return intersection / (ga.size + gb.size - intersection);
}

export interface CandidatePoint {
  source_block_id: string;
  content: string;
  bloom_level: string;
  category: string;
  eligible_types: string[];
  document_order: number;
  block_ordinal: number;
  requires_source_review?: boolean;
}

export function entailsSource(content: string, blockNormalized: string): boolean {
  const normalized = semanticNormalize(content);
  if (!normalized) return false;
  const grams = charNgrams(normalized);
  if (!grams.size) return false;
  let hits = 0;
  for (const gram of grams) if (blockNormalized.includes(gram)) hits += 1;
  return hits / grams.size >= 0.6;
}

export function dedupeCandidates(items: CandidatePoint[]): CandidatePoint[] {
  const seen = new Set<string>();
  const unique: CandidatePoint[] = [];
  for (const item of items) {
    const key = `${item.source_block_id}:${semanticNormalize(item.content)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  unique.sort((a, b) => {
    const typeDelta = b.eligible_types.length - a.eligible_types.length;
    if (typeDelta) return typeDelta;
    if (a.content.length !== b.content.length) return a.content.length - b.content.length;
    if (a.document_order !== b.document_order) return a.document_order - b.document_order;
    if (a.block_ordinal !== b.block_ordinal) return a.block_ordinal - b.block_ordinal;
    return semanticNormalize(a.content).localeCompare(semanticNormalize(b.content));
  });

  const normalized = unique.map((item) => semanticNormalize(item.content));
  const parent = unique.map((_, index) => index);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      if (jaccard(normalized[i], normalized[j]) >= 0.82) union(i, j);
    }
  }

  const clusterMin = new Map<number, number>();
  unique.forEach((_, index) => {
    const root = find(index);
    const current = clusterMin.get(root);
    if (current === undefined || index < current) clusterMin.set(root, index);
  });
  const keep = new Set(clusterMin.values());
  return unique.filter((_, index) => keep.has(index));
}

export interface SlotPlan {
  slot_number: number;
  question_type: "single_choice" | "true_false" | "fill_blank";
  answer_letter: string | null;
  target_answer: boolean | null;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function buildSlots(config: QuestionConfig, seed: number): SlotPlan[] {
  const letters = shuffle(
    Array.from({ length: config.single_choice }, (_, index) => "ABCD"[index % 4]),
    seed,
  );
  const trueTargets: boolean[] = [];
  if (config.true_false > 0) {
    let trueCount = Math.floor(config.true_false / 2);
    let falseCount = Math.floor(config.true_false / 2);
    if (config.true_false % 2 === 1) {
      if (mulberry32(seed)() < 0.5) trueCount += 1;
      else falseCount += 1;
    }
    trueTargets.push(...Array(trueCount).fill(true), ...Array(falseCount).fill(false));
  }
  const targets = shuffle(trueTargets, seed + 1);

  const slots: SlotPlan[] = [];
  let slotNumber = 0;
  for (let i = 0; i < config.single_choice; i += 1) {
    slotNumber += 1;
    slots.push({ slot_number: slotNumber, question_type: "single_choice", answer_letter: letters[i], target_answer: null });
  }
  for (let i = 0; i < config.true_false; i += 1) {
    slotNumber += 1;
    slots.push({ slot_number: slotNumber, question_type: "true_false", answer_letter: null, target_answer: targets[i] ?? true });
  }
  for (let i = 0; i < config.fill_blank; i += 1) {
    slotNumber += 1;
    slots.push({ slot_number: slotNumber, question_type: "fill_blank", answer_letter: null, target_answer: null });
  }
  return slots;
}

function slotOrderKey(seed: number, slot: number, pointId: string): string {
  return `${seed}:${slot}:${pointId}`;
}

export function bipartiteMatch(
  slots: number[],
  candidates: Record<number, string[]>,
  seed: number,
): Record<number, string> | null {
  const ordered = [...slots].sort((a, b) => {
    const delta = (candidates[a]?.length ?? 0) - (candidates[b]?.length ?? 0);
    return delta || a - b;
  });
  const sortedCandidates: Record<number, string[]> = {};
  for (const slot of slots) {
    sortedCandidates[slot] = [...(candidates[slot] ?? [])].sort((a, b) =>
      slotOrderKey(seed, slot, a).localeCompare(slotOrderKey(seed, slot, b)),
    );
  }
  const pointToSlot = new Map<string, number>();

  const tryAssign = (slot: number, visited: Set<string>): boolean => {
    for (const pointId of sortedCandidates[slot] ?? []) {
      if (visited.has(pointId)) continue;
      visited.add(pointId);
      const holder = pointToSlot.get(pointId);
      if (holder === undefined || tryAssign(holder, visited)) {
        pointToSlot.set(pointId, slot);
        return true;
      }
    }
    return false;
  };

  for (const slot of ordered) {
    if (!tryAssign(slot, new Set())) return null;
  }

  const result: Record<number, string> = {};
  pointToSlot.forEach((slot, pointId) => {
    result[slot] = pointId;
  });
  return result;
}
