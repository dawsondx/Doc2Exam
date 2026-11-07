"""费用估算 API(规格 13.4)。

价格未知时 available=false、value=null,仍返回 token 估算;
currency 来自 AIProfile,禁止把 CNY 单价按 USD 展示。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.errors import ApiError
from app.db.engine import get_session_factory
from app.models import AIProfile, Document, SourceBlock
from app.services.prompts import PROMPT_TOKEN_BUDGET

router = APIRouter(prefix="/api/estimates", tags=["estimates"])

# 每题输出 token 的保守估算(单选最长、判断最短)
OUTPUT_TOKENS_PER_QUESTION = {"single_choice": 220, "true_false": 130, "fill_blank": 160}


class QuestionConfig(BaseModel):
    single_choice: int = Field(ge=0, le=100)
    true_false: int = Field(ge=0, le=100)
    fill_blank: int = Field(ge=0, le=100)


class EstimateRequest(BaseModel):
    document_ids: list[str] = Field(min_length=1)
    ai_profile_id: str
    question_config: QuestionConfig


@router.post("")
def estimate(body: EstimateRequest) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, body.ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")

        total_input = PROMPT_TOKEN_BUDGET
        for document_id in body.document_ids:
            document = session.get(Document, document_id)
            if document is None:
                raise ApiError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "返回文档列表")
            blocks = (
                session.query(SourceBlock)
                .filter(SourceBlock.document_id == document_id)
                .all()
            )
            doc_tokens = sum(b.estimated_tokens for b in blocks) + PROMPT_TOKEN_BUDGET
            # 抽取阶段:每 chunk 最坏 3 个 logical call(输入按 1 次计,修复重试按上限展示)
            total_input += doc_tokens * 1
            total_input += doc_tokens  # 修复重试上限的另一半

        config = body.question_config
        total_questions = (
            config.single_choice + config.true_false + config.fill_blank
        )
        if total_questions < 1 or total_questions > 200:
            raise ApiError(422, "INVALID_QUESTION_CONFIG",
                           "总题数必须在 1–200 之间。", "调整题型数量")

        # 生成阶段:每题最坏 5 个 logical call,每次携带考点与原文
        avg_block_tokens = 400
        per_call = avg_block_tokens + PROMPT_TOKEN_BUDGET
        gen_input = total_questions * 5 * per_call
        total_input += gen_input

        total_output = sum(
            OUTPUT_TOKENS_PER_QUESTION[qtype] * count
            for qtype, count in (
                ("single_choice", config.single_choice),
                ("true_false", config.true_false),
                ("fill_blank", config.fill_blank),
            )
        ) * 3  # 修复重试上限

        input_price = profile.input_price_per_million
        output_price = profile.output_price_per_million
        if input_price is not None and output_price is not None:
            cost = (
                total_input * float(input_price) + total_output * float(output_price)
            ) / 1_000_000
            cost_info = {
                "value": round(cost, 4),
                "currency": profile.price_currency,
                "available": True,
                "reason": None,
            }
        else:
            cost_info = {
                "value": None,
                "currency": profile.price_currency,
                "available": False,
                "reason": "未填写单价,无法估算费用",
            }

        return {
            "estimated_input_tokens": total_input,
            "estimated_output_tokens": total_output,
            "estimated_cost": cost_info,
        }
    finally:
        session.close()
