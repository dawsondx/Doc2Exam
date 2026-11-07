"""SourceBlock → AI chunk 组装与考点额度分配(规格 9.2、9.3)。"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app import config

PROMPT_TOKEN_BUDGET = 800


@dataclass
class ChunkBlock:
    block_id: str
    ordinal: int
    text: str
    estimated_tokens: int


@dataclass
class Chunk:
    index: int
    blocks: list[ChunkBlock]
    tokens: int


def chunk_budget(context_window: int, max_output_tokens: int) -> int:
    """单 chunk 预算:目标区间内,并为 Prompt 与输出保留 30% 余量。"""
    reserve = int((context_window - max_output_tokens) * 0.7) - PROMPT_TOKEN_BUDGET
    return max(200, min(config.CHUNK_TARGET_TOKENS_MAX, reserve))


def assemble_chunks(
    blocks: list[ChunkBlock],
    *,
    context_window: int,
    max_output_tokens: int,
) -> list[Chunk]:
    """在 SourceBlock 边界组装,相邻 chunk 最多重复一个边界块(规格 9.2)。"""
    budget = chunk_budget(context_window, max_output_tokens)
    chunks: list[Chunk] = []
    current: list[ChunkBlock] = []
    current_tokens = 0

    for block in blocks:
        if current and current_tokens + block.estimated_tokens > budget:
            chunks.append(Chunk(len(chunks) + 1, current, current_tokens))
            # 边界重复:上一 chunk 的最后一块作为下一 chunk 的开头。
            tail = current[-1]
            current = [tail]
            current_tokens = tail.estimated_tokens
            if current_tokens + block.estimated_tokens > budget and tail.estimated_tokens > 0:
                # 极小预算:不重复,直接新开。
                current = []
                current_tokens = 0
        current.append(block)
        current_tokens += block.estimated_tokens

    if current:
        chunks.append(Chunk(len(chunks) + 1, current, current_tokens))
    return chunks


@dataclass
class DocumentQuota:
    document_id: str
    order: int
    quota: int
    tokens: int


def target_point_count(total_questions: int) -> int:
    """clamp(ceil(N × 2.5), 20, 200)(规格 9.3)。"""
    return max(20, min(200, math.ceil(total_questions * 2.5)))


def distribute_quota(
    doc_tokens: list[tuple[str, int]],
    total_questions: int,
) -> list[DocumentQuota]:
    """按各文档有效 token 占比与位置分配抽取额度。"""
    target = target_point_count(total_questions)
    if not doc_tokens:
        return []
    total_tokens = sum(tokens for _, tokens in doc_tokens) or 1
    quotas: list[DocumentQuota] = []
    assigned = 0
    for order, (document_id, tokens) in enumerate(doc_tokens, start=1):
        share = target * tokens / total_tokens
        quota = max(1, round(share))
        quotas.append(DocumentQuota(document_id, order, quota, tokens))
        assigned += quota
    # 位置靠前的文档吸收取整误差,保证总额度不小于目标。
    diff = target - assigned
    if quotas and diff != 0:
        index = 0 if diff > 0 else len(quotas) - 1
        quotas[index].quota = max(1, quotas[index].quota + diff)
    return quotas
