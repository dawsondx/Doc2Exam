"""任务事件:统一包络、持久化与 SSE 重放(规格 12.2)。

data 包络:job_id、sequence、stage、current、total、message、resource_id、error。
事件不包含 API key 或完整文档;实体正文由普通 GET API 获取。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.engine import get_session_factory
from app.models import JobEvent, JobStatus

EVENT_TYPES = {
    "job_started",
    "progress",
    "document_ready",
    "point_created",
    "question_ready",
    "question_failed",
    "job_partial",
    "job_completed",
    "job_failed",
    "job_cancelled",
    "heartbeat",
}

TERMINAL_EVENTS = {"job_partial", "job_completed", "job_failed", "job_cancelled"}
HEARTBEAT_SECONDS = 15


@dataclass
class EventEnvelope:
    job_id: str
    sequence: int
    event_type: str
    stage: str | None = None
    current: int | None = None
    total: int | None = None
    message: str | None = None
    resource_id: str | None = None
    error: dict[str, Any] | None = None

    def payload(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "sequence": self.sequence,
            "stage": self.stage,
            "current": self.current,
            "total": self.total,
            "message": self.message,
            "resource_id": self.resource_id,
            "error": self.error,
        }

    def sse_frame(self) -> str:
        lines = [f"id: {self.sequence}", f"event: {self.event_type}"]
        data = json.dumps(self.payload(), ensure_ascii=False)
        for part in data.splitlines() or [""]:
            lines.append(f"data: {part}")
        return "\n".join(lines) + "\n\n"


class JobEventBus:
    """进程内事件总线:活动 Job 的 SSE 订阅者实时接收,断线者靠 job_events 重放。"""

    def __init__(self) -> None:
        self._waiters: dict[str, list[asyncio.Future[None]]] = {}

    def subscribe(self, job_id: str) -> asyncio.Future[None]:
        fut: asyncio.Future[None] = asyncio.get_event_loop().create_future()
        self._waiters.setdefault(job_id, []).append(fut)
        return fut

    def unsubscribe(self, job_id: str, fut: asyncio.Future[None]) -> None:
        waiters = self._waiters.get(job_id, [])
        if fut in waiters:
            waiters.remove(fut)
        if not waiters:
            self._waiters.pop(job_id, None)

    def publish(self, job_id: str) -> None:
        for fut in list(self._waiters.get(job_id, [])):
            if not fut.done():
                fut.set_result(None)


bus = JobEventBus()


def next_sequence(job_id: str) -> int:
    session = get_session_factory()()
    try:
        current = (
            session.execute(
                select(JobEvent.sequence).where(JobEvent.job_id == job_id).order_by(
                    JobEvent.sequence.desc()
                ).limit(1)
            ).scalar_one_or_none()
        )
        return (current or 0) + 1
    finally:
        session.close()


def _retry_write[T](operation: Callable[[Session], T], *, attempts: int = 20,
                    delay: float = 0.25) -> T:
    """重试整个写操作(重新执行),覆盖 SQLite 并发锁。"""
    import time

    from sqlalchemy.exc import OperationalError

    for attempt in range(1, attempts + 1):
        session = get_session_factory()()
        try:
            result = operation(session)
            session.commit()
            return result
        except OperationalError as exc:
            session.rollback()
            if attempt == attempts or "locked" not in str(exc).lower():
                raise
            time.sleep(delay)
        finally:
            session.close()
    raise RuntimeError("unreachable")


def emit(
    job_id: str,
    event_type: str,
    *,
    stage: str | None = None,
    current: int | None = None,
    total: int | None = None,
    message: str | None = None,
    resource_id: str | None = None,
    error: dict[str, Any] | None = None,
) -> EventEnvelope:
    """持久化事件并唤醒订阅者。事件类型必须在注册表中。"""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"未注册的事件类型:{event_type}")

    def _write(session):  # type: ignore[no-untyped-def]
        current_seq = (
            session.execute(
                select(JobEvent.sequence)
                .where(JobEvent.job_id == job_id)
                .order_by(JobEvent.sequence.desc())
                .limit(1)
            ).scalar_one_or_none()
        )
        seq = (current_seq or 0) + 1
        session.add(
            JobEvent(
                job_id=job_id,
                sequence=seq,
                event_type=event_type,
                payload={
                    "job_id": job_id,
                    "sequence": seq,
                    "stage": stage,
                    "current": current,
                    "total": total,
                    "message": message,
                    "resource_id": resource_id,
                    "error": error,
                },
            )
        )
        return EventEnvelope(
            job_id=job_id,
            sequence=seq,
            event_type=event_type,
            stage=stage,
            current=current,
            total=total,
            message=message,
            resource_id=resource_id,
            error=error,
        )

    envelope: EventEnvelope = _retry_write(_write)
    bus.publish(job_id)
    return envelope


def load_events_after(job_id: str, last_sequence: int) -> list[EventEnvelope]:
    """从 job_events 重放 sequence > last_sequence 的事件(规格 12.2)。"""
    session = get_session_factory()()
    try:
        rows = (
            session.execute(
                select(JobEvent)
                .where(JobEvent.job_id == job_id, JobEvent.sequence > last_sequence)
                .order_by(JobEvent.sequence)
            )
            .scalars()
            .all()
        )
        return [
            EventEnvelope(
                job_id=row.job_id,
                sequence=row.sequence,
                event_type=row.event_type,
                stage=row.payload.get("stage"),
                current=row.payload.get("current"),
                total=row.payload.get("total"),
                message=row.payload.get("message"),
                resource_id=row.payload.get("resource_id"),
                error=row.payload.get("error"),
            )
            for row in rows
        ]
    finally:
        session.close()


def _job_status(job_id: str) -> JobStatus | None:
    from app.models import Job

    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        return job.status if job else None
    finally:
        session.close()


async def sse_stream(job_id: str,
                     last_event_id: str | None) -> AsyncIterator[str]:
    """可重放 SSE:先补发遗漏事件,再实时推送;终态后关闭(规格 12.2)。"""
    last_seq = int(last_event_id) if last_event_id else 0
    terminal_seen = False

    while not terminal_seen:
        for envelope in load_events_after(job_id, last_seq):
            last_seq = envelope.sequence
            yield envelope.sse_frame()
            if envelope.event_type in TERMINAL_EVENTS:
                terminal_seen = True
        if terminal_seen:
            break

        # 任务已不存在或已被启动标记中断且无新事件时,发一次心跳后重查。
        status = _job_status(job_id)
        if status is not None and status not in (JobStatus.queued, JobStatus.running):
            # 任务结束但没有终态事件(如进程中断转 interrupted):补一个可重放终点。
            if status == JobStatus.interrupted:
                yield EventEnvelope(
                    job_id=job_id, sequence=last_seq + 1, event_type="job_failed",
                    error={"code": "JOB_INTERRUPTED", "message": "任务被中断,可继续。"},
                ).sse_frame()
            break

        fut = bus.subscribe(job_id)
        try:
            await asyncio.wait_for(fut, timeout=HEARTBEAT_SECONDS)
        except TimeoutError:
            yield ": heartbeat\n\n"
        finally:
            bus.unsubscribe(job_id, fut)


def sse_response(job_id: str, request: Request) -> StreamingResponse:
    last_event_id = request.headers.get("Last-Event-ID")
    return StreamingResponse(
        sse_stream(job_id, last_event_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
