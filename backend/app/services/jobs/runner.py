"""后台任务执行器:启动、取消、恢复与幂等单元提交(规格 12.3)。

每个单元完成后立即提交数据库;取消只阻止新单元,已提交结果保留。
任务以 asyncio Task 形式常驻进程;进程退出后由启动钩子标记 interrupted。
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import threading
from collections.abc import Awaitable, Callable
from typing import Any

from app.db.engine import get_session_factory
from app.models import Job, JobStatus, JobUnit, UnitStatus
from app.services.jobs import events
from app.services.jobs.state import CANCELLABLE, RESUMABLE, assert_transition

logger = logging.getLogger("ai_quiz")

_execution_counter = itertools.count()


class _JobHandle:
    """任务运行句柄。

    任务有两种执行形态:事件循环内的 asyncio.Task,以及同步路由在线程池中
    提交时新建的后台线程。两者统一暴露 done(),供"同一任务不重复提交"的
    判定使用。
    """

    __slots__ = ("token", "_task", "_thread")

    def __init__(
        self,
        token: int,
        *,
        task: asyncio.Task[None] | None = None,
        thread: threading.Thread | None = None,
    ) -> None:
        self.token = token
        self._task = task
        self._thread = thread

    def done(self) -> bool:
        if self._task is not None:
            return self._task.done()
        return self._thread is None or not self._thread.is_alive()

    @property
    def thread(self) -> threading.Thread | None:
        return self._thread


_running_tasks: dict[str, _JobHandle] = {}


class JobCancelled(Exception):
    """任务被用户取消:已提交单元保留,未提交结果丢弃。"""


class JobFailed(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def check_cancelled(job_id: str) -> None:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is not None and job.cancel_requested:
            raise JobCancelled()
    finally:
        session.close()


def is_job_active(job_id: str) -> bool:
    handle = _running_tasks.get(job_id)
    return handle is not None and not handle.done()


def wait_for_all(timeout: float = 30.0) -> None:
    """等待当前所有后台任务线程结束。

    测试夹具收尾时必须先调用:否则后台线程会在数据目录被拆除后继续访问
    数据库,抛出 "no such table" 一类的线程异常。
    """
    import time

    deadline = time.monotonic() + timeout
    for handle in list(_running_tasks.values()):
        thread = handle.thread
        if thread is None:
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        thread.join(timeout=remaining)


def submit(job_id: str, factory: Callable[[], Awaitable[None]]) -> None:
    """把 Job 的执行协程注册到事件循环。重复提交同一活动任务时忽略。"""
    if is_job_active(job_id):
        return

    token = next(_execution_counter)

    async def _wrap() -> None:
        try:
            await factory()
        except JobCancelled:
            _set_status(job_id, JobStatus.cancelled, event="job_cancelled",
                        message="任务已取消,已完成部分已保存。")
        except JobFailed as exc:
            _set_status(job_id, JobStatus.failed, event="job_failed",
                        code=exc.code, message=exc.message)
        except Exception as exc:  # noqa: BLE001
            logger.exception("job %s 执行异常: %s", job_id, type(exc).__name__)
            _set_status(job_id, JobStatus.failed, event="job_failed",
                        code="JOB_FAILED", message="任务执行失败,已完成部分已保存。")
        finally:
            handle = _running_tasks.get(job_id)
            # 只清理本次执行登记的句柄,避免误删同任务更晚一次提交的句柄。
            if handle is not None and handle.token == token:
                _running_tasks.pop(job_id, None)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        _running_tasks[job_id] = _JobHandle(token, task=loop.create_task(_wrap()))
    else:
        # 同步上下文(FastAPI 的同步路由在线程池中执行,没有运行中的事件循环):
        # 新建线程与独立事件循环执行。
        def _run() -> None:
            asyncio.run(_wrap())

        thread = threading.Thread(target=_run, daemon=True, name=f"job-{job_id[:8]}")
        # 先登记句柄再启动线程:否则线程极快结束时 finally 里的 pop 会先执行,
        # 留下一条永不清理的僵尸句柄。
        _running_tasks[job_id] = _JobHandle(token, thread=thread)
        thread.start()


def _set_status(
    job_id: str,
    status: JobStatus,
    *,
    event: str,
    code: str | None = None,
    message: str | None = None,
) -> None:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            return
        assert_transition(job.status, status)
        job.status = status
        if code:
            job.error_code = code
        if message:
            job.error_message = message
        session.commit()
    except ValueError:
        session.rollback()
    finally:
        session.close()

    events.emit(
        job_id,
        event,
        error={"code": code, "message": message} if code else None,
        message=message,
    )


def begin(job_id: str) -> None:
    """把 queued/interrupted 任务置为 running 并发 job_started。"""
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            raise JobFailed("JOB_NOT_FOUND", "任务不存在。")
        assert_transition(job.status, JobStatus.running)
        job.status = JobStatus.running
        job.cancel_requested = False
        job.error_code = None
        job.error_message = None
        from app.db.engine import utcnow

        job.started_at = job.started_at or utcnow()
        session.commit()
    finally:
        session.close()
    events.emit(job_id, "job_started", message="任务已开始。")


def mark_completed(job_id: str, *, partial: bool = False, message: str | None = None) -> None:
    target = JobStatus.partial if partial else JobStatus.completed
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            return
        assert_transition(job.status, target)
        job.status = target
        from app.db.engine import utcnow

        job.finished_at = utcnow()
        session.commit()
    finally:
        session.close()
    events.emit(
        job_id,
        "job_partial" if partial else "job_completed",
        message=message or ("部分单元未完成,可继续补齐。" if partial else "任务完成。"),
    )


def request_cancel(job_id: str) -> dict[str, Any]:
    """幂等取消:设置取消标志;活动任务在单元边界停止。"""
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            raise KeyError(job_id)
        if job.status in CANCELLABLE:
            job.cancel_requested = True
            if job.status != JobStatus.running:
                # queued/interrupted 直接落终态;running 等待执行器在边界处理。
                assert_transition(job.status, JobStatus.cancelled)
                job.status = JobStatus.cancelled
            session.commit()
        already_cancelled = job.status == JobStatus.cancelled
        return {"status": job.status.value, "already_cancelled": already_cancelled}
    finally:
        session.close()


def resume_allowed(job_id: str) -> bool:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        return job is not None and job.status in RESUMABLE
    finally:
        session.close()


def pending_units(job_id: str) -> list[JobUnit]:
    session = get_session_factory()()
    try:
        return list(
            session.query(JobUnit)
            .filter(JobUnit.job_id == job_id)
            .filter(JobUnit.status != UnitStatus.done)
            .order_by(JobUnit.id)
            .all()
        )
    finally:
        session.close()


def upsert_unit(
    job_id: str,
    unit_key: str,
    *,
    status: UnitStatus,
    attempt_count: int = 1,
    payload_hash: str | None = None,
) -> None:
    import time

    from sqlalchemy.exc import OperationalError

    for attempt in range(1, 21):
        session = get_session_factory()()
        try:
            unit = (
                session.query(JobUnit)
                .filter(JobUnit.job_id == job_id, JobUnit.unit_key == unit_key)
                .one_or_none()
            )
            if unit is None:
                unit = JobUnit(job_id=job_id, unit_key=unit_key)
                session.add(unit)
            unit.status = status
            unit.attempt_count = attempt_count
            unit.payload_hash = payload_hash
            session.commit()
            return
        except OperationalError as exc:
            session.rollback()
            if attempt == 20 or "locked" not in str(exc).lower():
                raise
            time.sleep(0.25)
        finally:
            session.close()
