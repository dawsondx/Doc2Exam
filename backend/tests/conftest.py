"""pytest 全局夹具:临时数据目录、迁移、Mock AI、内存凭据。

自动化测试完全离线:AI_QUIZ_MOCK_AI=1,凭据强制内存降级,不访问公网。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    """每个测试独立的数据目录 + 干净引擎。"""
    path = tmp_path / "data"
    path.mkdir()
    monkeypatch.setenv("AI_QUIZ_DATA_DIR", str(path))
    monkeypatch.setenv("AI_QUIZ_MOCK_AI", "1")
    os.environ["AI_QUIZ_MOCK_AI"] = "1"

    import app.config as config

    monkeypatch.setattr(config, "DATA_DIR", path)
    monkeypatch.setattr(config, "UPLOADS_DIR", path / "uploads")
    monkeypatch.setattr(config, "EXPORTS_DIR", path / "exports")
    monkeypatch.setattr(config, "TEMP_DIR", path / "temp")
    monkeypatch.setattr(config, "LOGS_DIR", path / "logs")
    monkeypatch.setattr(config, "DB_PATH", path / "app.db")

    from app.db import engine as db_engine

    db_engine.reset_engine()

    config.ensure_dirs()

    # 在测试数据目录上执行迁移
    import subprocess
    import sys

    backend_dir = Path(__file__).resolve().parent.parent
    env = dict(os.environ)
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend_dir, env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr

    yield path

    # 先等后台任务线程结束:否则它们会在数据目录与数据库被拆除后继续访问
    # 数据库,抛出 "no such table: jobs" 一类的线程异常(表现为随机告警/不稳定)。
    from app.services.jobs import runner

    runner.wait_for_all(30.0)

    db_engine.reset_engine()
    os.environ.pop("AI_QUIZ_MOCK_AI", None)


@pytest.fixture()
def client(data_dir, monkeypatch):
    """TestClient;凭据存储强制内存降级,避免触碰真实凭据管理器。"""
    from app.services import credentials

    monkeypatch.setattr(credentials, "_using_memory_fallback", True, raising=False)
    monkeypatch.setattr(credentials, "is_memory_fallback", lambda: True)

    import logging

    logging.getLogger("ai_quiz").handlers.clear()

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def wait_job(client):
    def _wait(job_id: str, timeout: float = 60.0, expect=None):
        import time

        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            resp = client.get(f"/api/jobs/{job_id}")
            assert resp.status_code == 200, resp.text
            last = resp.json()
            if last["status"] not in ("queued", "running"):
                break
            time.sleep(0.15)
        assert last is not None
        if expect:
            assert last["status"] == expect, json.dumps(last, ensure_ascii=False)
        return last

    return _wait


@pytest.fixture()
def uploaded_pdf(client):
    """上传 policy_text.pdf 并等待解析完成,返回 (document_id, job_id)。"""
    with open(FIXTURES / "policy_text.pdf", "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("policy_text.pdf", f, "application/pdf")},
            headers={"Idempotency-Key": "test-upload-pdf-1"},
        )
    assert resp.status_code == 202, resp.text
    item = resp.json()["items"][0]
    return item["document"]["id"], item["job_id"]


@pytest.fixture()
def uploaded_docx(client):
    with open(FIXTURES / "policy_text.docx", "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("policy_text.docx", f,
                             "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
            headers={"Idempotency-Key": "test-upload-docx-1"},
        )
    assert resp.status_code == 202, resp.text
    item = resp.json()["items"][0]
    return item["document"]["id"], item["job_id"]


@pytest.fixture()
def profile_with_consent(client, wait_job):
    """创建 Mock AI 配置 + probe + consent,返回 (profile_id, consent_id)。"""
    resp = client.post("/api/ai-profiles", json={
        "name": "测试模式配置",
        "base_url": "http://127.0.0.1:9/v1",
        "model": "mock-model",
        "api_key": "test-key-do-not-leak",
        "api_mode": "chat_completions",
    })
    assert resp.status_code == 201, resp.text
    profile_id = resp.json()["id"]

    resp = client.post(f"/api/ai-profiles/{profile_id}/probe")
    assert resp.status_code == 200, resp.text
    assert resp.json()["compatible"] is True

    resp = client.post("/api/data-sharing-consents", json={
        "ai_profile_id": profile_id,
        "accepted": True,
        "disclosure_version": "1.0",
    })
    assert resp.status_code == 201, resp.text
    consent_id = resp.json()["id"]
    return profile_id, consent_id
