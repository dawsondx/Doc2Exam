"""AI 配置 API:CRUD、探测、删除与数据发送确认(规格 13.1)。"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Header, Query
from pydantic import BaseModel, Field

from app import config
from app.api.errors import ApiError
from app.db.engine import get_session_factory, to_iso, utcnow
from app.models import DeletionConfirmation
from app.services import credentials, profiles
from app.services.ai_adapter.probe import probe_profile
from app.services.profiles import probe_verdict

router = APIRouter(tags=["ai-profiles"])


class ProfileCreate(BaseModel):
    name: str
    base_url: str
    model: str
    api_key: str
    api_mode: str = "chat_completions"
    context_window: int | None = None
    max_output_tokens: int | None = None
    max_concurrency: int = Field(default=4, ge=1, le=8)
    input_price_per_million: float | None = None
    output_price_per_million: float | None = None
    price_currency: str = "USD"


class ProfilePatch(BaseModel):
    name: str | None = None
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None
    api_mode: str | None = None
    context_window: int | None = None
    max_output_tokens: int | None = None
    max_concurrency: int | None = Field(default=None, ge=1, le=8)
    input_price_per_million: float | None = None
    output_price_per_million: float | None = None
    price_currency: str | None = None


def profile_dto(profile, include_caps: bool = True) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    from app.services.profiles import current_fingerprint

    dto: dict[str, Any] = {
        "id": profile.id,
        "name": profile.name,
        "base_url": profile.base_url,
        "model": profile.model,
        "api_mode": profile.api_mode.value,
        "context_window": profile.context_window,
        "max_output_tokens": profile.max_output_tokens,
        "max_concurrency": profile.max_concurrency,
        "input_price_per_million": (
            float(profile.input_price_per_million)
            if profile.input_price_per_million is not None
            else None
        ),
        "output_price_per_million": (
            float(profile.output_price_per_million)
            if profile.output_price_per_million is not None
            else None
        ),
        "price_currency": profile.price_currency,
        "has_api_key": profile.credential_key is not None,
        "last_probe_at": to_iso(profile.last_probe_at),
        "compatible": profiles.compatible(profile),
        "credential_storage": (
            "memory" if credentials.is_memory_fallback() else "system"
        ),
        "profile_fingerprint": current_fingerprint(profile),
    }
    if include_caps and profile.capabilities:
        dto["capabilities"] = profile.capabilities
        dto["probe_verdict"] = probe_verdict(profile.capabilities)
        dto["probe_error"] = profile.capabilities.get("_error")
    return dto


@router.get("/api/ai-profiles")
def list_profiles() -> dict[str, Any]:
    items = [profile_dto(p) for p in profiles.active_profiles()]
    return {"items": items, "total": len(items), "page": 1, "page_size": 100}


@router.post("/api/ai-profiles", status_code=201)
def create_profile(body: ProfileCreate) -> dict[str, Any]:
    from app.models import ApiMode

    try:
        api_mode = ApiMode(body.api_mode)
    except ValueError as exc:
        raise ApiError(422, "INVALID_API_MODE", "api_mode 不合法。", "选择正确模式") from exc
    profile = profiles.create_profile(
        name=body.name,
        base_url=body.base_url,
        model=body.model,
        api_mode=api_mode,
        api_key=body.api_key,
        context_window=body.context_window,
        max_output_tokens=body.max_output_tokens,
        max_concurrency=body.max_concurrency,
        input_price=body.input_price_per_million,
        output_price=body.output_price_per_million,
        price_currency=body.price_currency,
    )
    return profile_dto(profile)


@router.patch("/api/ai-profiles/{profile_id}")
def patch_profile(profile_id: str, body: ProfilePatch) -> dict[str, Any]:
    patch = body.model_dump(exclude_unset=True)
    profile = profiles.update_profile(profile_id, patch)
    return profile_dto(profile)


@router.post("/api/ai-profiles/{profile_id}/probe")
async def probe(profile_id: str) -> dict[str, Any]:
    profile = profiles.get_profile(profile_id)
    result = await probe_profile(profile)
    caps = result.verdict_caps()
    if result.error:
        caps["_error"] = result.error
    session = get_session_factory()()
    try:
        fresh = session.get(type(profile), profile_id)
        if fresh is not None:
            fresh.capabilities = caps
            fresh.last_probe_at = utcnow()
            session.commit()
            session.refresh(fresh)
        return profile_dto(fresh)
    finally:
        session.close()


def _profile_impact(profile_id: str) -> dict[str, Any]:
    from app.models import Job, JobStatus
    from app.services.profiles import current_fingerprint, get_profile

    profile = get_profile(profile_id)
    session = get_session_factory()()
    try:
        active_jobs = (
            session.query(Job)
            .filter(
                Job.ai_profile_id == profile_id,
                Job.status.in_(
                    [JobStatus.queued, JobStatus.running, JobStatus.interrupted]
                ),
            )
            .count()
        )
        from app.models import DataSharingConsent

        consents = (
            session.query(DataSharingConsent)
            .filter(
                DataSharingConsent.ai_profile_id == profile_id,
                DataSharingConsent.revoked_at.is_(None),
            )
            .count()
        )
        return {
            "can_delete": True,
            "counts": {
                "active_jobs_to_cancel": active_jobs,
                "consents_to_revoke": consents,
                "credential_to_delete": 1 if profile.credential_key else 0,
            },
            "profile_fingerprint": current_fingerprint(profile),
        }
    finally:
        session.close()


@router.get("/api/ai-profiles/{profile_id}/deletion-impact")
def deletion_impact(profile_id: str) -> dict[str, Any]:
    profiles.get_profile(profile_id)
    impact = _profile_impact(profile_id)
    impact_hash = hashlib.sha256(
        json.dumps(impact, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    token = secrets.token_urlsafe(32)
    session = get_session_factory()()
    try:
        session.add(
            DeletionConfirmation(
                token=token,
                resource_type="ai_profile",
                resource_id=profile_id,
                impact_hash=impact_hash,
                expires_at=utcnow() + timedelta(seconds=config.DELETION_TOKEN_TTL_SECONDS),
            )
        )
        session.commit()
    finally:
        session.close()
    impact["deletion_token"] = token
    impact["message"] = (
        "删除配置会移除系统凭据、撤销数据发送确认并取消进行中的任务;"
        "历史试卷和导出文件保留。"
    )
    return impact


@router.delete("/api/ai-profiles/{profile_id}", status_code=204)
def delete_profile(
    profile_id: str,
    x_deletion_token: str = Header(..., alias="X-Deletion-Token"),
) -> None:
    profiles.get_profile(profile_id)
    impact = _profile_impact(profile_id)
    impact_hash = hashlib.sha256(
        json.dumps(impact, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    session = get_session_factory()()
    try:
        row = (
            session.query(DeletionConfirmation)
            .filter(DeletionConfirmation.token == x_deletion_token)
            .one_or_none()
        )
        if (
            row is None
            or row.used_at is not None
            or row.expires_at < utcnow()
            or row.resource_id != profile_id
            or row.resource_type != "ai_profile"
            or row.impact_hash != impact_hash
        ):
            raise ApiError(409, "DELETE_CONFIRMATION_REQUIRED",
                           "删除前需要查看最新影响范围。", "重新打开删除确认")
        row.used_at = utcnow()
        session.commit()
    finally:
        session.close()
    profiles.soft_delete_profile(profile_id)


# --- 数据发送确认(规格 2.2、13.1)---


@router.get("/api/data-sharing-consents")
def consent_status(ai_profile_id: str = Query(..., alias="ai_profile_id")) -> dict[str, Any]:
    return profiles.consent_status(ai_profile_id)


class ConsentCreate(BaseModel):
    ai_profile_id: str
    accepted: bool
    disclosure_version: str = config.DISCLOSURE_VERSION


@router.post("/api/data-sharing-consents", status_code=201)
def create_consent(body: ConsentCreate) -> dict[str, Any]:
    return profiles.create_consent(
        body.ai_profile_id, body.accepted, body.disclosure_version
    )


@router.post("/api/data-sharing-consents/{consent_id}/revoke")
def revoke_consent(consent_id: str) -> dict[str, Any]:
    return profiles.revoke_consent(consent_id)
