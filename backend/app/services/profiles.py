"""AIProfile 服务:CRUD、Consent 指纹、能力兼容判定(规格 2.2、7.3、8)。

指纹 = 规范 JSON 的 UTF-8 SHA-256,键固定 base_url/api_mode/model 且按键排序;
base_url 规范化:scheme/host 小写、去默认端口、去末尾 /、拒绝 query/fragment。
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.api.errors import ApiError
from app.db.engine import get_session_factory, utcnow
from app.models import (
    AIProfile,
    ApiMode,
    DataSharingConsent,
    Job,
    JobStatus,
)
from app.services import credentials

CAPABILITY_KEYS = (
    "text_generation",
    "json_schema",
    "json_object",
    "plain_json",
    "models_list",
    "usage",
    "tokenizer_known",
    "preferred_output_mode",
)


def normalize_base_url(raw: str) -> str:
    """规范化 base_url(规格 2.2)。非法输入抛 ApiError。"""
    raw = (raw or "").strip()
    if not raw:
        raise ApiError(422, "INVALID_BASE_URL", "base_url 不能为空。", "填写 API 根地址")
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https"):
        raise ApiError(422, "INVALID_BASE_URL", "base_url 必须以 http/https 开头。",
                       "检查地址格式")
    if not parts.hostname:
        raise ApiError(422, "INVALID_BASE_URL", "base_url 缺少主机名。", "检查地址格式")
    if parts.query or parts.fragment:
        raise ApiError(422, "INVALID_BASE_URL", "base_url 不允许携带 query 或 fragment。",
                       "移除查询参数")
    scheme = parts.scheme.lower()
    host = parts.hostname.lower()
    port = parts.port
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None
    netloc = f"{host}:{port}" if port is not None else host
    path = parts.path.rstrip("/")
    return urlunsplit((scheme, netloc, path, "", ""))


def profile_fingerprint(base_url: str, api_mode: ApiMode, model: str) -> str:
    normalized = normalize_base_url(base_url)
    canonical = json.dumps(
        {"api_mode": api_mode.value, "base_url": normalized, "model": model},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def current_fingerprint(profile: AIProfile) -> str:
    return profile_fingerprint(profile.base_url, profile.api_mode, profile.model)


def compatible(profile: AIProfile) -> bool:
    caps = profile.capabilities or {}
    if caps.get("text_generation") != "supported":
        return False
    mode = caps.get("preferred_output_mode")
    return mode in ("json_schema", "json_object", "plain_json")


def create_profile(
    *,
    name: str,
    base_url: str,
    model: str,
    api_mode: ApiMode,
    api_key: str | None,
    context_window: int | None,
    max_output_tokens: int | None,
    max_concurrency: int,
    input_price: float | None,
    output_price: float | None,
    price_currency: str,
) -> AIProfile:
    normalized = normalize_base_url(base_url)
    profile = AIProfile(
        name=name.strip() or "未命名配置",
        base_url=normalized,
        model=model.strip(),
        api_mode=api_mode,
        context_window=context_window or 32_768,
        max_output_tokens=max_output_tokens or 4_096,
        max_concurrency=max(1, min(8, max_concurrency)),
        input_price_per_million=input_price,
        output_price_per_million=output_price,
        price_currency=(price_currency or "USD").upper()[:3],
        capabilities=None,
    )
    session = get_session_factory()()
    try:
        session.add(profile)
        session.commit()
        if api_key:
            credential_key = f"ai-profile:{profile.id}"
            credentials.save_credential(credential_key, api_key)
            profile.credential_key = credential_key
            session.commit()
        session.refresh(profile)
        return profile
    finally:
        session.close()


def update_profile(profile_id: str, patch: dict[str, Any]) -> AIProfile:
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")

        if "base_url" in patch:
            patch["base_url"] = normalize_base_url(patch["base_url"])
        changed_fingerprint = {
            field
            for field, current in (
                ("base_url", profile.base_url),
                ("api_mode", profile.api_mode.value),
                ("model", profile.model),
            )
            if field in patch and patch[field] is not None and patch[field] != current
        }
        if "name" in patch and patch["name"] is not None:
            profile.name = patch["name"].strip() or profile.name
        for field in ("base_url", "model"):
            if patch.get(field):
                setattr(profile, field, patch[field])
        if patch.get("api_mode") is not None:
            profile.api_mode = ApiMode(patch["api_mode"])
        if patch.get("context_window") is not None:
            profile.context_window = int(patch["context_window"])
        if patch.get("max_output_tokens") is not None:
            profile.max_output_tokens = int(patch["max_output_tokens"])
        if patch.get("max_concurrency") is not None:
            profile.max_concurrency = max(1, min(8, int(patch["max_concurrency"])))
        if "input_price_per_million" in patch:
            profile.input_price_per_million = patch["input_price_per_million"]
        if "output_price_per_million" in patch:
            profile.output_price_per_million = patch["output_price_per_million"]
        if patch.get("price_currency"):
            profile.price_currency = patch["price_currency"].upper()[:3]

        if patch.get("api_key"):
            credential_key = profile.credential_key or f"ai-profile:{profile.id}"
            credentials.save_credential(credential_key, patch["api_key"])
            profile.credential_key = credential_key

        if changed_fingerprint:
            # 指纹变化:旧 Consent 失效,能力结果清空(规格 2.2)。
            profile.capabilities = None
            profile.last_probe_at = None
            _revoke_consents(session, profile.id)
        session.commit()
        session.refresh(profile)
        return profile
    finally:
        session.close()


def _revoke_consents(session, profile_id: str) -> None:  # type: ignore[no-untyped-def]
    session.query(DataSharingConsent).filter(
        DataSharingConsent.ai_profile_id == profile_id,
        DataSharingConsent.revoked_at.is_(None),
    ).update({"revoked_at": utcnow()}, synchronize_session=False)


def active_profiles() -> list[AIProfile]:
    session = get_session_factory()()
    try:
        return (
            session.query(AIProfile)
            .filter(AIProfile.deleted_at.is_(None))
            .order_by(AIProfile.created_at.desc())
            .all()
        )
    finally:
        session.close()


def get_profile(profile_id: str, *, allow_deleted: bool = False) -> AIProfile:
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        if profile is None or (profile.deleted_at is not None and not allow_deleted):
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")
        return profile
    finally:
        session.close()


def soft_delete_profile(profile_id: str) -> dict[str, Any]:
    """软删除:删凭据、撤销 Consent、取消关联活动 AI Job(规格 7.3)。"""
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")
        if profile.credential_key:
            credentials.delete_credential(profile.credential_key)
            profile.credential_key = None
        _revoke_consents(session, profile_id)
        profile.deleted_at = utcnow()

        cancelled_jobs = []
        active_jobs = (
            session.query(Job)
            .filter(
                Job.ai_profile_id == profile_id,
                Job.status.in_(
                    [JobStatus.queued, JobStatus.running, JobStatus.interrupted]
                ),
            )
            .all()
        )
        for job in active_jobs:
            job.status = JobStatus.cancelled
            job.cancel_requested = True
            job.error_code = "AI_JOB_PROFILE_CHANGED"
            cancelled_jobs.append(job.id)
        session.commit()
        return {"cancelled_job_ids": cancelled_jobs}
    finally:
        session.close()


# --- Consent(规格 2.2、13.1)---


def consent_status(profile_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")
        fingerprint = current_fingerprint(profile)
        consent = (
            session.query(DataSharingConsent)
            .filter(
                DataSharingConsent.ai_profile_id == profile_id,
                DataSharingConsent.profile_fingerprint == fingerprint,
                DataSharingConsent.revoked_at.is_(None),
            )
            .order_by(DataSharingConsent.consented_at.desc())
            .first()
        )
        return {
            "ai_profile_id": profile_id,
            "profile_fingerprint": fingerprint,
            "consent": (
                {
                    "id": consent.id,
                    "profile_fingerprint": consent.profile_fingerprint,
                    "consented_at": consent.consented_at.isoformat() + "Z",
                    "revoked_at": None,
                }
                if consent
                else None
            ),
        }
    finally:
        session.close()


def create_consent(profile_id: str, accepted: bool, disclosure_version: str) -> dict[str, Any]:
    if not accepted:
        raise ApiError(422, "CONSENT_DECLINED", "未接受数据发送说明。",
                       "确认后才能发送业务数据")
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")
        fingerprint = current_fingerprint(profile)
        existing = (
            session.query(DataSharingConsent)
            .filter(
                DataSharingConsent.ai_profile_id == profile_id,
                DataSharingConsent.profile_fingerprint == fingerprint,
                DataSharingConsent.revoked_at.is_(None),
            )
            .first()
        )
        if existing:
            return {
                "id": existing.id,
                "profile_fingerprint": existing.profile_fingerprint,
                "consented_at": existing.consented_at.isoformat() + "Z",
                "revoked_at": None,
            }
        consent = DataSharingConsent(
            ai_profile_id=profile_id,
            profile_fingerprint=fingerprint,
            disclosure_version=disclosure_version,
        )
        session.add(consent)
        session.commit()
        return {
            "id": consent.id,
            "profile_fingerprint": consent.profile_fingerprint,
            "consented_at": consent.consented_at.isoformat() + "Z",
            "revoked_at": None,
        }
    finally:
        session.close()


def verify_consent(profile: AIProfile, consent_id: str) -> DataSharingConsent:
    """校验 Consent 与当前指纹一致且未撤销;失败抛 ApiError。"""
    session = get_session_factory()()
    try:
        consent = session.get(DataSharingConsent, consent_id)
        if (
            consent is None
            or consent.ai_profile_id != profile.id
            or consent.revoked_at is not None
        ):
            raise ApiError(409, "AI_CONSENT_REQUIRED",
                           "当前 AI 配置尚未获得业务数据发送确认。",
                           "查看发送范围并确认")
        if consent.profile_fingerprint != current_fingerprint(profile):
            raise ApiError(409, "AI_CONSENT_REQUIRED",
                           "配置已修改,原数据发送确认已失效。",
                           "重新确认数据发送范围")
        return consent
    finally:
        session.close()


def revoke_consent(consent_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        consent = session.get(DataSharingConsent, consent_id)
        if consent is None:
            raise ApiError(404, "CONSENT_NOT_FOUND", "确认记录不存在。", "返回配置列表")
        if consent.revoked_at is None:
            consent.revoked_at = utcnow()
            session.commit()
        return {
            "id": consent.id,
            "revoked_at": consent.revoked_at.isoformat() + "Z" if consent.revoked_at else None,
        }
    finally:
        session.close()


def mock_ai_enabled() -> bool:
    return os.environ.get("AI_QUIZ_MOCK_AI", "").strip() not in ("", "0", "false", "False")


def probe_verdict(caps: dict[str, Any] | None) -> str:
    """完全兼容 / 可降级兼容 / 当前无法验证 / 不兼容(规格 8.2)。"""
    if not caps:
        return "当前无法验证"
    if caps.get("text_generation") != "supported":
        return "不兼容"
    mode = caps.get("preferred_output_mode")
    if mode == "json_schema":
        return "完全兼容"
    if mode in ("json_object", "plain_json"):
        return "可降级兼容"
    return "当前无法验证"
