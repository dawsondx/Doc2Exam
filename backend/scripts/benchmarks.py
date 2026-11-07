"""规格 21.5 本地性能基准:解析 / 导出 / 历史列表。一次性脚本,结果人工记录。

用法:cd backend && AI_QUIZ_MOCK_AI=1 uv run python scripts/benchmarks.py
前置:backend/tests/fixtures/bench_20p.pdf(20 页文字 PDF 夹具)。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 放到系统临时目录:与 pytest 集成测试环境一致,避免项目目录内同步工具/索引器
# 干扰 SQLite 锁(实测放在项目 data/ 下时 WAL 写锁被外部进程长时间占住)。
BENCH_DATA = Path(tempfile.mkdtemp(prefix="ai-quiz-bench-"))

os.environ["AI_QUIZ_MOCK_AI"] = "1"
os.environ["AI_QUIZ_DATA_DIR"] = str(BENCH_DATA)
shutil.rmtree(BENCH_DATA, ignore_errors=True)

sys.path.insert(0, str(ROOT))

from alembic.config import Config  # noqa: E402

from alembic import command  # noqa: E402

command.upgrade(Config(str(ROOT / "alembic.ini")), "head")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

RESULTS: list[tuple[str, float, str, bool]] = []


def record(name: str, elapsed: float, threshold: float) -> None:
    ok = elapsed < threshold
    RESULTS.append((name, elapsed, f"<{threshold:g}s", ok))
    print(f"{name}: {elapsed:.2f}s (阈值 <{threshold:g}s) -> {'PASS' if ok else 'FAIL'}")


def wait_job(client: TestClient, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        body = client.get(f"/api/jobs/{job_id}").json()
        if body["status"] not in ("queued", "running"):
            return body
        time.sleep(0.05)
    raise TimeoutError(f"job {job_id} 超时")


def prepare_quiz(client: TestClient) -> str:
    """上传 20 页 PDF → 抽考点 → 选全部 → 生成 10/6/4 → 批量通过。返回 quiz_id。"""
    src = ROOT / "tests" / "fixtures" / "bench_20p.pdf"
    resp = client.post(
        "/api/documents",
        files={"files": ("bench_20p.pdf", src.read_bytes(), "application/pdf")},
        headers={"Idempotency-Key": f"bench-doc-{uuid.uuid4()}"},
    )
    assert resp.status_code == 202, resp.text
    item = resp.json()["items"][0]
    final = wait_job(client, item["job_id"])
    assert final["status"] == "completed", final
    document_id = item["document"]["id"]

    resp = client.post("/api/ai-profiles", json={
        "name": "bench", "base_url": "http://127.0.0.1:9/v1", "model": "mock",
        "api_key": "k", "api_mode": "chat_completions",
    })
    profile_id = resp.json()["id"]
    client.post(f"/api/ai-profiles/{profile_id}/probe")
    consent_id = client.post("/api/data-sharing-consents", json={
        "ai_profile_id": profile_id, "accepted": True,
    }).json()["id"]

    resp = client.post("/api/extraction-jobs", json={
        "document_ids": [document_id], "ai_profile_id": profile_id,
        "consent_id": consent_id, "target_question_count": 20,
    }, headers={"Idempotency-Key": f"bench-extract-{uuid.uuid4()}"})
    assert resp.status_code == 202, resp.text
    ext_job = resp.json()["job_id"]
    final = wait_job(client, ext_job)
    assert final["status"] in ("completed", "partial"), final
    points = client.get(f"/api/extraction-jobs/{ext_job}/points").json()["items"]
    ids = [p["id"] for p in points]
    client.post("/api/knowledge-points/bulk-selection",
                json={"point_ids": ids, "selected": True})

    resp = client.post("/api/generation-jobs", json={
        "document_ids": [document_id],
        "selected_point_ids": ids,
        "ai_profile_id": profile_id, "consent_id": consent_id,
        "question_config": {"single_choice": 10, "true_false": 6, "fill_blank": 4},
        "seed": 42,
    }, headers={"Idempotency-Key": f"bench-gen-{uuid.uuid4()}"})
    assert resp.status_code == 202, resp.text
    gen_job, quiz_id = resp.json()["job_id"], resp.json()["quiz_record_id"]
    final = wait_job(client, gen_job, timeout=120)
    assert final["status"] == "completed", final

    quiz = client.get(f"/api/quiz-records/{quiz_id}").json()
    question_ids = [q["id"] for q in quiz["questions"]]
    resp = client.post(f"/api/quiz-records/{quiz_id}/reviews/bulk",
                       json={"question_ids": question_ids})
    assert resp.status_code == 200, resp.text
    return quiz_id


def main() -> None:
    with TestClient(app) as client:
        health = client.get("/api/health").json()
        assert health["status"] == "ok", health

        # ---- 基准 1:20 页文字 PDF 解析(上传 → ParseJob 完成),<5s ----
        src = ROOT / "tests" / "fixtures" / "bench_20p.pdf"
        t0 = time.perf_counter()
        resp = client.post(
            "/api/documents",
            files={"files": ("bench_20p.pdf", src.read_bytes(), "application/pdf")},
            headers={"Idempotency-Key": f"bench-parse-{uuid.uuid4()}"},
        )
        assert resp.status_code == 202, resp.text
        item = resp.json()["items"][0]
        final = wait_job(client, item["job_id"])
        parse_elapsed = time.perf_counter() - t0
        assert final["status"] == "completed", final
        record("基准1: 20 页 PDF 解析(上传→ParseJob 完成)", parse_elapsed, 5)

        quiz_id = prepare_quiz(client)

        # ---- 基准 2:20 题双 Word 导出,<3s ----
        t0 = time.perf_counter()
        resp = client.post(f"/api/quiz-records/{quiz_id}/exports",
                           headers={"Idempotency-Key": f"bench-export-{uuid.uuid4()}"})
        export_elapsed = time.perf_counter() - t0
        assert resp.status_code == 201, resp.text
        record("基准2: 20 题双 Word 导出(生成+校验+落库)", export_elapsed, 3)

        # ---- 基准 3:1000 条历史列表首屏,<1s ----
        import sqlalchemy

        from app.db.engine import get_session_factory
        from app.models.base import QuizStatus

        session = get_session_factory()()
        rows = []
        base_sql = (
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
        session.execute(sqlalchemy.text(base_sql), rows)
        session.commit()
        session.close()

        t0 = time.perf_counter()
        resp = client.get("/api/quiz-records?page=1&page_size=20")
        list_elapsed = time.perf_counter() - t0
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] >= 1000 and len(body["items"]) == 20, (body["total"], len(body["items"]))
        record("基准3: 1000 条历史列表首屏(API)", list_elapsed, 1)

    print("\n==== 汇总 ====")
    for name, elapsed, threshold, ok in RESULTS:
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {elapsed:.2f}s ({threshold})")
    if not all(ok for _, _, _, ok in RESULTS):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
