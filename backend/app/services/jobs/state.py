"""Job 状态机(规格 7.4)。

queued → running → completed / partial(仅 GenerationJob) / failed / cancelled
running/interrupted 状态下 cancel 可转为 cancelled;interrupted 可 resume 回 running。
completed、failed、partial、cancelled 为终态,不可再变 running。
"""

from __future__ import annotations

from app.models import JobStatus

ALLOWED_TRANSITIONS: dict[JobStatus, set[JobStatus]] = {
    JobStatus.queued: {JobStatus.running, JobStatus.cancelled},
    JobStatus.running: {
        JobStatus.completed,
        JobStatus.partial,
        JobStatus.failed,
        JobStatus.cancelled,
        JobStatus.interrupted,
    },
    JobStatus.interrupted: {JobStatus.running, JobStatus.cancelled},
    # 仅进程内运行期允许 queued→interrupted(启动标记);运行中不能直接跳 interrupted 之外的状态。
    JobStatus.completed: set(),
    JobStatus.partial: set(),
    JobStatus.failed: set(),
    JobStatus.cancelled: set(),
}


def can_transition(source: JobStatus, target: JobStatus) -> bool:
    return target in ALLOWED_TRANSITIONS.get(source, set())


def assert_transition(source: JobStatus, target: JobStatus) -> None:
    if not can_transition(source, target):
        raise ValueError(f"非法状态迁移:{source.value} → {target.value}")


CANCELLABLE = {JobStatus.queued, JobStatus.running, JobStatus.interrupted}
RESUMABLE = {JobStatus.interrupted}
