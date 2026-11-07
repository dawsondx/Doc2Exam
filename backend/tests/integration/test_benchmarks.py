"""规格 21.5 本地性能基准(默认跳过,不进入常规测试)。

运行方式:
    cd backend && AI_QUIZ_BENCH=1 AI_QUIZ_MOCK_AI=1 \
        uv run pytest tests/integration/test_benchmarks.py -s -q

阈值:20 页文字 PDF 解析 <5s;20 题双 Word 导出 <3s;1000 条历史列表首屏 <1s。
"""
from __future__ import annotations

import os
import time
import uuid

import sqlalchemy
from fastapi.testclient import TestClient

if not os.environ.get("AI_QUIZ_BENCH"):
    pytest_skip_reason = (
        "性能基准需显式运行:AI_QUIZ_BENCH=1 uv run pytest "
        "tests/integration/test_benchmarks.py -s"
    )
else:
    pytest_skip_reason = None

import pytest

if pytest_skip_reason:
    pytest.skip(pytest_skip_reason, allow_module_level=True)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BENCH_PDF = os.path.join(ROOT, "tests", "fixtures", "bench_20p.pdf")


def _wait(client: TestClient, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.perf_counter() + timeout
    last = None
    while time.perf_counter() < deadline:
        resp = client.get(f"/api/jobs/{job_id}")
        assert resp.status_code == 200, resp.text
        last = resp.json()
        if last["status"] not in ("queued", "running"):
            return last
        time.sleep(0.05)
    raise TimeoutError(job_id)


def _prepare_quiz(client: TestClient) -> str:
    """上传 20 页 PDF → 抽考点 → 全选 → 生成 10/6/4 → 批量通过。返回 quiz_id。"""
    with open(BENCH_PDF, "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("bench_20p.pdf", f, "application/pdf")},
            headers={"Idempotency-Key": f"bench-doc-{uuid.uuid4()}"},
        )
    assert resp.status_code == 202, resp.text
    item = resp.json()["items"][0]
    final = _wait(client, item["job_id"])
    assert final["status"] == "completed", final
    document_id = item["document"]["id"]

    resp = client.post("/api/ai-profiles", json={
        "name": "bench", "base_url": "http://127.0.0.1:9/v1", "model": "mock",
        "api_key": "k", "api_mode": "chat_completions",
    })
    assert resp.status_code == 201, resp.text
    profile_id = resp.json()["id"]
    resp = client.post(f"/api/ai-profiles/{profile_id}/probe")
    assert resp.status_code == 200, resp.text
    resp = client.post("/api/data-sharing-consents", json={
        "ai_profile_id": profile_id, "accepted": True,
        "disclosure_version": "1.0"})
    consent_id = resp.json()["id"]

    resp = client.post("/api/extraction-jobs", json={
        "document_ids": [document_id], "ai_profile_id": profile_id,
        "consent_id": consent_id, "target_question_count": 20,
    }, headers={"Idempotency-Key": f"bench-extract-{uuid.uuid4()}"})
    assert resp.status_code == 202, resp.text
    ext_job = resp.json()["job_id"]
    final = _wait(client, ext_job)
    assert final["status"] == "completed", final

    points = client.get(f"/api/extraction-jobs/{ext_job}/points").json()
    ids = [p["id"] for p in points["items"]]
    client.post("/api/knowledge-points/bulk-selection",
                json={"point_ids": ids, "selected": True})

    resp = client.post("/api/generation-jobs", json={
        "document_ids": [document_id], "selected_point_ids": ids,
        "ai_profile_id": profile_id, "consent_id": consent_id,
        "question_config": {"single_choice": 10, "true_false": 6, "fill_blank": 4},
        "seed": 42,
    }, headers={"Idempotency-Key": f"bench-gen-{uuid.uuid4()}"})
    assert resp.status_code == 202, resp.text
    gen_job, quiz_id = resp.json()["job_id"], resp.json()["quiz_record_id"]
    final = _wait(client, gen_job)
    assert final["status"] == "completed", final

    quiz = client.get(f"/api/quiz-records/{quiz_id}").json()
    qids = [q["id"] for q in quiz["questions"]]
    assert len(qids) == 20, len(qids)
    resp = client.post(f"/api/quiz-records/{quiz_id}/reviews/bulk",
                       json={"question_ids": qids})
    assert resp.status_code == 200, resp.text
    return quiz_id


def test_benchmark_parse_upload(client):
    """基准 1:20 页文字 PDF 上传到解析完成,<5 秒。"""
    with open(BENCH_PDF, "rb") as f:
        t0 = time.perf_counter()
        resp = client.post(
            "/api/documents",
            files={"files": ("bench_20p.pdf", f, "application/pdf")},
            headers={"Idempotency-Key": f"bench-parse-{uuid.uuid4()}"},
        )
        assert resp.status_code == 202, resp.text
        item = resp.json()["items"][0]
        final = _wait(client, item["job_id"])
        elapsed = time.perf_counter() - t0
    assert final["status"] == "completed", final
    print(f"\n[BENCH] 基准1 20页PDF解析:{elapsed:.2f}s 阈值<5s -> "
          f"{'PASS' if elapsed < 5 else 'FAIL'}")
    assert elapsed < 5, elapsed


def test_benchmark_double_export(client):
    """基准 2:20 题双 Word 导出(生成+哨兵校验+落库),<3 秒。"""
    quiz_id = _prepare_quiz(client)
    t0 = time.perf_counter()
    resp = client.post(f"/api/quiz-records/{quiz_id}/exports",
                       headers={"Idempotency-Key": f"bench-export-{uuid.uuid4()}"})
    elapsed = time.perf_counter() - t0
    assert resp.status_code == 201, resp.text
    print(f"\n[BENCH] 基准2 20题双Word导出:{elapsed:.2f}s 阈值<3s -> "
          f"{'PASS' if elapsed < 3 else 'FAIL'}")
    assert elapsed < 3, elapsed


def test_benchmark_history_first_page(client):
    """基准 3:1000 条历史列表首屏查询,<1 秒。"""
    from app.db.engine import get_session_factory
    from app.models.base import QuizStatus

    session = get_session_factory()()
    try:
        rows = []
        sql = (
            "INSERT INTO quiz_records (id, status, question_config, seed,"
            " created_at, updated_at) VALUES (:id, :status, :qc, :seed,"
            " :created_at, :updated_at)"
        )
        for i in range(1000):
            now = f"2026-08-24 00:{i // 60:02d}:{i % 60:02d}.000000"
            rows.append({
                "id": str(uuid.uuid4()), "status": QuizStatus.ready.value,
                "qc": '{"single_choice":1,"true_false":0,"fill_blank":0}',
                "seed": i, "created_at": now, "updated_at": now,
            })
        session.execute(sqlalchemy.text(sql), rows)
        session.commit()
    finally:
        session.close()

    t0 = time.perf_counter()
    resp = client.get("/api/quiz-records?page=1&page_size=20")
    elapsed = time.perf_counter() - t0
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] >= 1000 and len(body["items"]) == 20, body["total"]
    print(f"\n[BENCH] 基准3 1000条历史列表首屏:{elapsed * 1000:.0f}ms 阈值<1s -> "
          f"{'PASS' if elapsed < 1 else 'FAIL'}")
    assert elapsed < 1, elapsed
