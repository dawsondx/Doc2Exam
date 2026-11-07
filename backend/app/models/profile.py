"""AIProfile 与 DataSharingConsent(规格 7.3、2.2)。

明文 API key 只进操作系统凭据存储;本表仅保存 credential_key 引用。
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import JSON, DateTime, Enum, Index, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.engine import utcnow
from app.models.base import ApiMode, Base, new_uuid


class AIProfile(Base):
    __tablename__ = "ai_profiles"
    __table_args__ = (Index("ix_ai_profiles_deleted_at", "deleted_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(128))
    base_url: Mapped[str] = mapped_column(String(512))
    model: Mapped[str] = mapped_column(String(256))
    api_mode: Mapped[ApiMode] = mapped_column(
        Enum(ApiMode, native_enum=False), default=ApiMode.chat_completions
    )
    capabilities: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    context_window: Mapped[int] = mapped_column(Integer, default=32_768)
    max_output_tokens: Mapped[int] = mapped_column(Integer, default=4_096)
    max_concurrency: Mapped[int] = mapped_column(Integer, default=4)
    input_price_per_million: Mapped[float | None] = mapped_column(Numeric(12, 6), nullable=True)
    output_price_per_million: Mapped[float | None] = mapped_column(Numeric(12, 6), nullable=True)
    price_currency: Mapped[str] = mapped_column(String(3), default="USD")
    credential_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    last_probe_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class DataSharingConsent(Base):
    __tablename__ = "data_sharing_consents"
    __table_args__ = (Index("ix_consents_profile_active", "ai_profile_id", "revoked_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    ai_profile_id: Mapped[str] = mapped_column(String(36), index=True)
    profile_fingerprint: Mapped[str] = mapped_column(String(64))
    disclosure_version: Mapped[str] = mapped_column(String(16), default="1.0")
    consented_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
