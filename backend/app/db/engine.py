"""数据库引擎与会话。

SQLite 启用 `PRAGMA foreign_keys=ON` 与 WAL(规格 7.6)。
所有时间以 naive UTC 存储,API 层格式化为 ISO 8601。
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app import config


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


def to_iso(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(microsecond=0).isoformat() + "Z"


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        config.ensure_dirs()
        _engine = create_engine(
            f"sqlite:///{config.DB_PATH}",
            connect_args={"timeout": 30},
        )

        @event.listens_for(_engine, "connect")
        def _set_pragma(dbapi_connection, _record) -> None:  # type: ignore[no-untyped-def]
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.close()

    return _engine


def reset_engine() -> None:
    """仅测试使用:重置进程级引擎。"""
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None


def get_session_factory() -> sessionmaker[Session]:
    global _session_factory
    if _session_factory is None:
        _session_factory = sessionmaker(bind=get_engine(), expire_on_commit=False)
    return _session_factory


def session_scope() -> Iterator[Session]:
    """请求/任务级会话:提交或回滚,不关闭工厂。"""
    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def safe_commit(session: Session, *, attempts: int = 20, delay: float = 0.25) -> None:
    """并发下的提交:WAL 读快照升级失败时回滚重试。

    长任务后台协程与 API 请求并发写 SQLite 时可能遇到 BUSY,
    重试窗口覆盖单机使用场景。
    """
    import time

    from sqlalchemy.exc import OperationalError

    for attempt in range(1, attempts + 1):
        try:
            session.commit()
            return
        except OperationalError as exc:
            session.rollback()
            if attempt == attempts or "locked" not in str(exc).lower():
                raise
            time.sleep(delay)
