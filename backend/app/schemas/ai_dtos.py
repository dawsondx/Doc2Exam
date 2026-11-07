"""AI 原始输出 DTO(规格 9.4、10.5)。

AI DTO 与领域模型、数据库模型、公开 API DTO 分离(规格 0.6)。
AI 只返回业务字段;type、source、validation_state、review_state、slot_number、
答案字母一律不返回。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class KnowledgePointCandidate(BaseModel):
    source_block_id: str = Field(min_length=1)
    content: str = Field(min_length=1, max_length=500)
    bloom_level: str
    category: str
    eligible_types: list[str]


class ExtractionResponse(BaseModel):
    points: list[KnowledgePointCandidate]


class SingleChoiceDraft(BaseModel):
    stem: str
    options: list[str]
    answer_content: str
    explanation: str


class TrueFalseDraft(BaseModel):
    stem: str
    answer: str
    explanation: str


class FillBlankDraft(BaseModel):
    stem: str
    answer: str
    acceptable_answers: list[str] = Field(default_factory=list)
    explanation: str


SUPPORTED_QUESTION_TYPES = ("single_choice", "true_false", "fill_blank")
SUPPORTED_BLOOM_LEVELS = ("remember", "understand", "apply", "analyze")
