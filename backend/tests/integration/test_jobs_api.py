"""集成测试:任务中断、恢复与 Consent 约束(规格 12.3、21.2-9/23/27)。"""

from __future__ import annotations

import time


def test_jobs_list_discovery_and_recoverable_filter(
    client, wait_job, uploaded_pdf, profile_with_consent
):
    document_id, parse_job = uploaded_pdf
    wait_job(parse_job, expect="completed")
    profile_id, consent_id = profile_with_consent

    resp = client.post("/api/extraction-jobs", json={
        "document_ids": [document_id], "ai_profile_id": profile_id,
        "consent_id": consent_id, "target_question_count": 20,
    }, headers={"Idempotency-Key": "jobs-disc"})
    job_id = resp.json()["job_id"]
    wait_job(job_id, expect="completed")

    listing = client.get("/api/jobs").json()
    assert listing["total"] >= 2
    types = {item["job_type"] for item in listing["items"]}
    assert "parse" in types and "extraction" in types

    # completed 任务不属于可继续任务
    recoverable = client.get("/api/jobs?recoverable=true").json()
    assert all(item["id"] not in {job_id, parse_job} for item in recoverable["items"])


def test_interrupted_job_marked_and_parse_resumable(client, data_dir, monkeypatch):
    """模拟程序退出:running 任务在启动时标记 interrupted;resume 只处理未完成单元。"""
    from pathlib import Path

    fixtures = Path(__file__).resolve().parent.parent / "fixtures"
    with open(fixtures / "policy_text.pdf", "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("policy_text.pdf", f, "application/pdf")},
            headers={"Idempotency-Key": "it-resume-doc"},
        )
    job_id = resp.json()["items"][0]["job_id"]

    # 等解析完成后,人为把任务改回 interrupted 模拟程序退出
    wait = 0
    while wait < 60:
        status = client.get(f"/api/jobs/{job_id}").json()["status"]
        if status in ("completed", "failed"):
            break
        time.sleep(0.15)
        wait += 0.15

    import sqlite3

    conn = sqlite3.connect(data_dir / "app.db")
    conn.execute(
        "UPDATE jobs SET status='interrupted' WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()

    # resume 只允许 interrupted
    resp = client.post(f"/api/jobs/{job_id}/resume")
    assert resp.status_code == 202, resp.text
    deadline = time.time() + 60
    while time.time() < deadline:
        status = client.get(f"/api/jobs/{job_id}").json()["status"]
        if status in ("completed", "failed"):
            break
        time.sleep(0.2)
    assert status == "completed", "恢复后应完成(幂等跳过已完成单元)"


def test_ai_job_profile_changed_after_fingerprint_change(
    client, wait_job, uploaded_pdf, profile_with_consent, data_dir
):
    document_id, parse_job = uploaded_pdf
    wait_job(parse_job, expect="completed")
    profile_id, consent_id = profile_with_consent

    resp = client.post("/api/extraction-jobs", json={
        "document_ids": [document_id], "ai_profile_id": profile_id,
        "consent_id": consent_id, "target_question_count": 20,
    }, headers={"Idempotency-Key": "it-pc-1"})
    job_id = resp.json()["job_id"]
    wait_job(job_id, expect="completed")

    # 修改模型 → 指纹变化 → 旧 job 不能 resume
    client.patch(f"/api/ai-profiles/{profile_id}", json={"model": "changed-model"})
    resp = client.post(f"/api/jobs/{job_id}/resume")
    assert resp.status_code == 412 or resp.status_code in (409, 422)

    # 人为标记 interrupted 后 resume 必须返回 AI_JOB_PROFILE_CHANGED
    import sqlite3

    conn = sqlite3.connect(data_dir / "app.db")
    conn.execute("UPDATE jobs SET status='interrupted' WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()

    resp = client.post(f"/api/jobs/{job_id}/resume")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "AI_JOB_PROFILE_CHANGED"


def test_consent_revoked_interrupted_job_requires_reconsent(
    client, wait_job, uploaded_pdf, profile_with_consent, data_dir
):
    document_id, parse_job = uploaded_pdf
    wait_job(parse_job, expect="completed")
    profile_id, consent_id = profile_with_consent

    resp = client.post("/api/extraction-jobs", json={
        "document_ids": [document_id], "ai_profile_id": profile_id,
        "consent_id": consent_id, "target_question_count": 20,
    }, headers={"Idempotency-Key": "it-consent-1"})
    job_id = resp.json()["job_id"]
    wait_job(job_id, expect="completed")

    import sqlite3

    conn = sqlite3.connect(data_dir / "app.db")
    conn.execute("UPDATE jobs SET status='interrupted' WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()

    client.post(f"/api/data-sharing-consents/{consent_id}/revoke")

    # 裸 resume(旧 consent 已撤销)→ 拒绝
    resp = client.post(f"/api/jobs/{job_id}/resume")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "AI_CONSENT_REQUIRED"

    # 同指纹新 consent → 可继续
    new_consent = client.post("/api/data-sharing-consents", json={
        "ai_profile_id": profile_id, "accepted": True,
        "disclosure_version": "1.0",
    }).json()["id"]
    resp = client.post(f"/api/jobs/{job_id}/resume",
                       json={"consent_id": new_consent})
    assert resp.status_code == 202
