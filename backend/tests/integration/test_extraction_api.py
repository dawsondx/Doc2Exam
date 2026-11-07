"""集成测试:考点抽取、SSE、恢复与选择(规格 9.5、12、21.2-4/5/6/8)。"""

from __future__ import annotations

import time


def _create_extraction(client, document_ids, profile_id, consent_id, count=20):
    return client.post("/api/extraction-jobs", json={
        "document_ids": document_ids,
        "ai_profile_id": profile_id,
        "consent_id": consent_id,
        "target_question_count": count,
    }, headers={"Idempotency-Key": f"it-extract-{time.time_ns()}"})


def test_extraction_flow_points_and_selection(
    client, wait_job, uploaded_pdf, profile_with_consent
):
    document_id, job_id = uploaded_pdf
    wait_job(job_id, expect="completed")
    profile_id, consent_id = profile_with_consent

    resp = _create_extraction(client, [document_id], profile_id, consent_id)
    assert resp.status_code == 202, resp.text
    extraction_job = resp.json()["job_id"]
    wait_job(extraction_job, expect="completed")

    points = client.get(f"/api/extraction-jobs/{extraction_job}/points").json()
    assert points["total"] >= 1
    for point in points["items"]:
        assert point["selectable"] is True
        assert point["source_text"], "考点必须能回到原文"

    # 选择考点
    first = points["items"][0]["id"]
    resp = client.patch(f"/api/knowledge-points/{first}", json={"selected": True})
    assert resp.json()["selected"] is True

    # 批量选择
    ids = [p["id"] for p in points["items"]]
    resp = client.post("/api/knowledge-points/bulk-selection",
                       json={"point_ids": ids, "selected": True})
    assert resp.json()["updated"] == len(ids)


def test_extraction_requires_valid_consent(client, uploaded_pdf):
    document_id, job_id = uploaded_pdf
    resp = client.post("/api/extraction-jobs", json={
        "document_ids": [document_id], "ai_profile_id": "nonexistent",
        "consent_id": "nonexistent", "target_question_count": 20,
    }, headers={"Idempotency-Key": "it-noconsent"})
    assert resp.status_code == 404


def test_extraction_consent_revoked_rejected(
    client, wait_job, uploaded_pdf, profile_with_consent
):
    document_id, parse_job = uploaded_pdf
    wait_job(parse_job, expect="completed")
    profile_id, consent_id = profile_with_consent
    client.post(f"/api/data-sharing-consents/{consent_id}/revoke")
    resp = _create_extraction(client, [document_id], profile_id, consent_id)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "AI_CONSENT_REQUIRED"


def test_sse_events_replay_with_last_event_id(
    client, wait_job, uploaded_pdf, profile_with_consent
):
    document_id, job_id = uploaded_pdf
    wait_job(job_id, expect="completed")
    profile_id, consent_id = profile_with_consent

    resp = _create_extraction(client, [document_id], profile_id, consent_id)
    extraction_job = resp.json()["job_id"]
    wait_job(extraction_job, expect="completed")

    # 全量重放
    with client.stream("GET", f"/api/jobs/{extraction_job}/events") as stream:
        events = []
        for line in stream.iter_lines():
            if line.startswith("event: "):
                events.append(line[7:])
        assert "job_started" in events
        assert "job_completed" in events

    # Last-Event-ID 续传:从中间开始
    with client.stream(
        "GET", f"/api/jobs/{extraction_job}/events",
        headers={"Last-Event-ID": "1"},
    ) as stream:
        ids = [line[4:] for line in stream.iter_lines()
               if line.startswith("id: ")]
        assert ids == [str(i) for i in range(2, len(ids) + 2)], "sequence 递增重放"
        assert all(int(b) > int(a) for a, b in zip(ids, ids[1:], strict=False))


def test_prompt_injection_document_still_safe(
    client, wait_job, profile_with_consent
):
    from pathlib import Path

    fixtures = Path(__file__).resolve().parent.parent / "fixtures"
    with open(fixtures / "prompt_injection.pdf", "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("prompt_injection.pdf", f, "application/pdf")},
            headers={"Idempotency-Key": "it-injection"},
        )
    item = resp.json()["items"][0]
    wait_job(item["job_id"], expect="completed")
    detail = client.get(f"/api/documents/{item['document']['id']}").json()
    assert detail["parse_status"] == "ready"

    profile_id, consent_id = profile_with_consent
    resp = _create_extraction(client, [item["document"]["id"]], profile_id, consent_id)
    wait_job(resp.json()["job_id"], expect="completed")

    points = client.get(f"/api/extraction-jobs/{resp.json()['job_id']}/points").json()
    for point in points["items"]:
        assert "source_block_id" in point
        assert point["content"], "输出协议未被注入文本改变"


def test_cancel_running_extraction(client, wait_job, uploaded_pdf, profile_with_consent):
    document_id, parse_job = uploaded_pdf
    wait_job(parse_job, expect="completed")
    profile_id, consent_id = profile_with_consent

    resp = _create_extraction(client, [document_id], profile_id, consent_id)
    job_id = resp.json()["job_id"]
    resp = client.post(f"/api/jobs/{job_id}/cancel")
    assert resp.status_code == 200

    deadline = time.time() + 30
    while time.time() < deadline:
        status = client.get(f"/api/jobs/{job_id}").json()["status"]
        if status in ("cancelled", "completed", "failed", "partial"):
            break
        time.sleep(0.1)
    assert status in ("cancelled", "completed"), "取消应尽快生效且幂等"
    resp = client.post(f"/api/jobs/{job_id}/cancel")
    assert resp.status_code == 200


def test_idempotency_replay_and_conflict(client, uploaded_pdf):
    document_id, parse_job = uploaded_pdf
    key = "it-idem-key-1"
    body = {
        "document_ids": ["00000000-0000-0000-0000-000000000000"],
        "ai_profile_id": "x", "consent_id": "y", "target_question_count": 20,
    }

    def _strip_request_id(payload):
        if "error" in payload and payload["error"]:
            payload = dict(payload)
            payload["error"] = {k: v for k, v in payload["error"].items()
                                if k != "request_id"}
        return payload

    r1 = client.post("/api/extraction-jobs", json=body,
                     headers={"Idempotency-Key": key})
    r2 = client.post("/api/extraction-jobs", json=body,
                     headers={"Idempotency-Key": key})
    assert r1.status_code == r2.status_code
    assert _strip_request_id(r1.json()) == _strip_request_id(r2.json()), \
        "同 key 同请求返回原响应"

    r3 = client.post(
        "/api/extraction-jobs",
        json={**body, "target_question_count": 30},
        headers={"Idempotency-Key": key},
    )
    assert r3.status_code == 409
    assert r3.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
