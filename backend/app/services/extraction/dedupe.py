"""考点候选的程序校验与去重(规格 9.5)。

- 结构校验:ID 在允许列表、content 10–200 字符、category 2–20 字符、题型合法。
- 精确去重:相同 SourceBlock + 完全归一化相同。
- 近似去重:NFKC + 统一空白 + 去常见标点 → 中文字符 3-gram Jaccard ≥ 0.82 →
  并查集传递闭包 → 每簇保留固定排序第一项。
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from app.schemas.ai_dtos import (
    SUPPORTED_BLOOM_LEVELS,
    SUPPORTED_QUESTION_TYPES,
    KnowledgePointCandidate,
)

_PUNCT = re.compile(r"[,。、;:!?.,;:!?\"'“”‘’()\[\]{}<>《》—\-…·\s]+")


def semantic_normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    return _PUNCT.sub("", text).lower()


def dedupe_key_for(content: str) -> str:
    return hashlib.sha256(semantic_normalize(content).encode("utf-8")).hexdigest()


@dataclass
class CandidateVerdict:
    ok: bool
    errors: list[str]
    requires_source_review: bool = False


def validate_candidate(
    candidate: KnowledgePointCandidate,
    allowed_block_ids: set[str],
) -> CandidateVerdict:
    errors: list[str] = []
    if candidate.source_block_id not in allowed_block_ids:
        errors.append(f"source_block_id 不在允许列表:{candidate.source_block_id}")
    if not 10 <= len(candidate.content.strip()) <= 200:
        errors.append(f"content 长度越界:{len(candidate.content.strip())}")
    if not 2 <= len(candidate.category.strip()) <= 20:
        errors.append(f"category 长度越界:{len(candidate.category.strip())}")
    if not candidate.eligible_types or any(
        t not in SUPPORTED_QUESTION_TYPES for t in candidate.eligible_types
    ):
        errors.append("eligible_types 为空或包含不支持题型")
    if candidate.bloom_level not in SUPPORTED_BLOOM_LEVELS:
        errors.append(f"bloom_level 非法:{candidate.bloom_level}")
    return CandidateVerdict(ok=not errors, errors=errors)


def entails_source(content: str, block_normalized: str) -> bool:
    """程序可证明的弱语义蕴含:考点归一化后其 3-gram 大部分出现在原文中。

    无法证明时返回 False,考点保留并标记 requires_source_review(规格 9.5)。
    """
    normalized = semantic_normalize(content)
    if not normalized:
        return False
    grams = {normalized[i : i + 3] for i in range(len(normalized) - 2)}
    if not grams:
        return False
    hits = sum(1 for g in grams if g in block_normalized)
    return hits / len(grams) >= 0.6


def _sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
    """固定排序键(规格 9.5):题型数降序、content 长度升序、文档顺序升序、
    SourceBlock ordinal 升序、归一化 content 字典序升序、canonical payload SHA-256 升序。"""
    payload = json.dumps(
        {
            "content": item["content"],
            "category": item["category"],
            "bloom_level": item["bloom_level"],
            "eligible_types": sorted(item["eligible_types"]),
            "source_block_id": item["source_block_id"],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    payload_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return (
        -len(item["eligible_types"]),
        len(item["content"]),
        item["document_order"],
        item["block_ordinal"],
        semantic_normalize(item["content"]),
        payload_hash,
    )


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _char_ngrams(text: str, n: int = 3) -> set[str]:
    if len(text) < n:
        return {text} if text else set()
    return {text[i : i + n] for i in range(len(text) - n + 1)}


def jaccard_similarity(a: str, b: str) -> float:
    ga, gb = _char_ngrams(a), _char_ngrams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


NEAR_DUPLICATE_THRESHOLD = 0.82


def dedupe_candidates(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """精确去重 + 近似去重(传递闭包),同输入保留同一项(规格 9.5、21.2-32)。"""
    exact_seen: set[tuple[str, str]] = set()
    unique: list[dict[str, Any]] = []
    for item in items:
        key = (item["source_block_id"], dedupe_key_for(item["content"]))
        if key in exact_seen:
            continue
        exact_seen.add(key)
        unique.append(item)

    unique.sort(key=_sort_key)
    normalized = [semantic_normalize(i["content"]) for i in unique]
    uf = _UnionFind(len(unique))
    for i in range(len(unique)):
        for j in range(i + 1, len(unique)):
            if (
                jaccard_similarity(normalized[i], normalized[j])
                >= NEAR_DUPLICATE_THRESHOLD
            ):
                uf.union(i, j)

    # 每个重复簇只保留排序第一项(最小索引),相同输入结果确定。
    cluster_min: dict[int, int] = {}
    for i in range(len(unique)):
        root = uf.find(i)
        if root not in cluster_min or i < cluster_min[root]:
            cluster_min[root] = i
    keep_indices = set(cluster_min.values())
    return [unique[i] for i in range(len(unique)) if i in keep_indices]
