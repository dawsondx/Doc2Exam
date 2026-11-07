"""生成任务 API(规格 13.5)。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Response
from pydantic import BaseModel, Field

from app.api.errors import ApiError
from app.api.jobs import job_to_dto
from app.db.engine import get_session_factory
from app.models import Job
from app.services import idempotency
from app.services.generation_job import create_generation_job
from app.services.generation_job import run as run_generation
from app.services.jobs import runner as job_runner

router = APIRouter(tags=["generation"])


class QuestionConfig(BaseModel):
    single_choice: int = Field(ge=0, le=100)
    true_false: int = Field(ge=0, le=100)
    fill_blank: int = Field(ge=0, le=100)


class GenerationCreate(BaseModel):
    document_ids: list[str] = Field(min_length=1)
    selected_point_ids: list[str] = Field(min_length=1)
    ai_profile_id: str
    consent_id: str
    question_config: QuestionConfig
    seed: int | None = None


@router.post("/api/generation-jobs", status_code=202, response_model=None)
def create_generation(
    body: GenerationCreate,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict[str, Any] | Response:
    replay = idempotency.check("POST", "/api/generation-jobs", idempotency_key,
                               body.model_dump())
    if replay is not None:
        return replay
    result = create_generation_job(
        document_ids=body.document_ids,
        selected_point_ids=body.selected_point_ids,
        ai_profile_id=body.ai_profile_id,
        consent_id=body.consent_id,
        question_config=body.question_config.model_dump(),
        seed=body.seed,
    )
    job_runner.submit(result["job_id"], lambda: run_generation(result["job_id"]))
    idempotency.save("POST", "/api/generation-jobs", idempotency_key or "",
                     body.model_dump(), 202, result)
    return result


@router.get("/api/generation-jobs/{job_id}")
def get_generation_job(job_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None or job.job_type.value != "generation":
            raise ApiError(404, "JOB_NOT_FOUND", "任务不存在。", "返回任务列表")
        return job_to_dto(job)
    finally:
        session.close()
