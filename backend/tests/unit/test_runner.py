"""单元测试:后台任务执行器(规格 12.3)。

覆盖"同步上下文提交任务"的执行形态:FastAPI 的同步路由在线程池中执行,
此时没有运行中的事件循环,submit() 走后台线程分支。该分支必须登记可用的
运行句柄,否则 is_job_active() 会因句柄类型错误而抛出 TypeError,
导致"继续/恢复任务"接口直接 500。
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from app.services.jobs import runner


@pytest.fixture(autouse=True)
def _clean_handles():
    runner._running_tasks.clear()
    yield
    runner._running_tasks.clear()


def _wait_until(predicate, timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def test_submit_without_running_loop_registers_usable_handle():
    """没有事件循环时提交任务,句柄必须可用,is_job_active 不得抛 TypeError。"""
    started = threading.Event()
    release = threading.Event()

    async def factory() -> None:
        started.set()
        await asyncio.to_thread(release.wait, 10)

    # pytest 线程内没有运行中的事件循环 -> 走后台线程分支
    runner.submit("job-sync-handle", factory)
    assert started.wait(5), "后台线程未启动"

    # 回归点:旧实现登记的是 asyncio.Task 类,这里会抛 TypeError
    assert runner.is_job_active("job-sync-handle") is True

    release.set()
    assert _wait_until(lambda: not runner.is_job_active("job-sync-handle")), "任务未结束"
    assert "job-sync-handle" not in runner._running_tasks, "结束后句柄未清理"


def test_duplicate_submit_ignored_while_job_active():
    """同一任务运行期间重复提交必须被忽略,而不是抛异常或重复执行。"""
    started = threading.Event()
    release = threading.Event()
    calls: list[int] = []

    async def factory() -> None:
        calls.append(1)
        started.set()
        await asyncio.to_thread(release.wait, 10)

    runner.submit("job-sync-dup", factory)
    assert started.wait(5), "后台线程未启动"

    # 回归点:旧实现在这里抛 TypeError(unbound method Task.done())
    runner.submit("job-sync-dup", factory)

    release.set()
    assert _wait_until(lambda: not runner.is_job_active("job-sync-dup")), "任务未结束"
    assert len(calls) == 1, f"任务被执行了 {len(calls)} 次,应当只执行一次"


def test_handle_cleanup_does_not_remove_newer_submission():
    """旧执行的收尾不得清掉同一任务更晚一次提交的句柄。"""
    release = threading.Event()
    started = threading.Event()

    async def factory() -> None:
        started.set()
        await asyncio.to_thread(release.wait, 10)

    runner.submit("job-sync-token", factory)
    assert started.wait(5), "后台线程未启动"

    # 模拟"旧执行还在收尾,同一 job_id 又被提交一次"
    old = runner._running_tasks["job-sync-token"]
    runner._running_tasks["job-sync-token"] = runner._JobHandle(old.token + 1)
    release.set()

    assert _wait_until(lambda: "job-sync-token" in runner._running_tasks)
    handle = runner._running_tasks.get("job-sync-token")
    assert handle is not None and handle.token == old.token + 1, "新句柄被旧执行误删"
