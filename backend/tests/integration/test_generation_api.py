"""集成测试:题目生成、槽位、答案平衡与复核导出(规格 10、11、13.5、21.2)。"""

from __future__ import annotations

import time
from collections import Counter
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def _prepare(client, wait_job, count=30):
    """上传 → 解析 → 抽考点,返回 (document_id, profile_id, consent_id, points)。"""
    with open(FIXTURES / "policy_text.pdf", "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("policy_text.pdf", f, "application/pdf")},
            headers={"Idempotency-Key": "gen-setup-doc"},
        )
    item = resp.json()["items"][0]
    wait_job(item["job_id"], expect="completed")
    document_id = item["document"]["id"]

    resp = client.post("/api/ai-profiles", json={
        "name": "测试模式", "base_url": "http://127.0.0.1:9/v1", "model": "mock",
        "api_key": "k", "api_mode": "chat_completions",
    })
    profile_id = resp.json()["id"]
    client.post(f"/api/ai-profiles/{profile_id}/probe")
    resp = client.post("/api/data-sharing-consents", json={
        "ai_profile_id": profile_id, "accepted": True, "disclosure_version": "1.0"})
    consent_id = resp.json()["id"]

    resp = client.post("/api/extraction-jobs", json={
        "document_ids": [document_id], "ai_profile_id": profile_id,
        "consent_id": consent_id, "target_question_count": count,
    }, headers={"Idempotency-Key": "gen-setup-extract"})
    wait_job(resp.json()["job_id"], expect="completed")

    points = client.get(f"/api/extraction-jobs/{resp.json()['job_id']}/points").json()
    ids = [p["id"] for p in points["items"]]
    client.post("/api/knowledge-points/bulk-selection",
                json={"point_ids": ids, "selected": True})
    return document_id, profile_id, consent_id, ids


def _generate(client, document_id, profile_id, consent_id, point_ids, config=None):
    config = config or {"single_choice": 3, "true_false": 2, "fill_blank": 1}
    return client.post("/api/generation-jobs", json={
        "document_ids": [document_id],
        "selected_point_ids": point_ids,
        "ai_profile_id": profile_id,
        "consent_id": consent_id,
        "question_config": config,
        "seed": 20260823,
    }, headers={"Idempotency-Key": f"gen-run-{time.time_ns()}"})


def test_generation_full_flow_and_review_export(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    assert resp.status_code == 202, resp.text
    job_id, quiz_id = resp.json()["job_id"], resp.json()["quiz_record_id"]
    wait_job(job_id, expect="completed")

    quiz = client.get(f"/api/quiz-records/{quiz_id}").json()
    questions = quiz["questions"]
    assert len(questions) == 6, "3+2+1 槽位"
    assert [q["slot_number"] for q in questions] == [1, 2, 3, 4, 5, 6]
    for q in questions:
        assert q["validation_state"] == "passed", q
        assert q["stem"] and q["explanation"]
        assert q["source"]["locator_label"], "出处必须来自 SourceBlock"

    # 未复核 → 不可导出
    resp = client.post(f"/api/quiz-records/{quiz_id}/exports",
                       headers={"Idempotency-Key": "gen-export-early"})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "EXPORT_NOT_READY"

    # 批量通过前:一道题未通过校验的批量应 409(先全部通过)
    ids = [q["id"] for q in questions]
    resp = client.post(f"/api/quiz-records/{quiz_id}/reviews/bulk",
                       json={"question_ids": ids})
    assert resp.status_code == 200

    quiz = client.get(f"/api/quiz-records/{quiz_id}").json()
    assert quiz["status"] == "ready"
    assert quiz["progress"]["export_ready"] is True

    resp = client.post(f"/api/quiz-records/{quiz_id}/exports",
                       headers={"Idempotency-Key": "gen-export-1"})
    assert resp.status_code == 201, resp.text
    exports = resp.json()
    assert exports["student"]["download_url"].startswith("/api/exports/")
    assert exports["answer"]["download_url"].startswith("/api/exports/")
    assert "题目版" in exports["student"]["filename"]
    assert "答案版" in exports["answer"]["filename"]

    # 下载两个文件并校验
    for key in ("student", "answer"):
        dl = client.get(exports[key]["download_url"])
        assert dl.status_code == 200
        assert dl.headers["content-type"].startswith(
            "application/vnd.openxmlformats")

    verify_export_content(client, exports, quiz_id)


def verify_export_content(client, exports, quiz_id):
    """python-docx 重开双版本并校验题目版无答案(规格 21.4)。

    RichText 生成的题干位于 SDT 内,paragraph.text 不可见,需读 XML 全文本。
    """
    import io
    import re
    import zipfile

    from docx import Document

    def _full(content):
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            xml = z.read("word/document.xml").decode("utf-8")
        return "\n".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml))

    student = client.get(exports["student"]["download_url"]).content
    answer = client.get(exports["answer"]["download_url"]).content
    Document(io.BytesIO(student))
    Document(io.BytesIO(answer))
    s_text = _full(student)
    a_text = _full(answer)
    assert "答案" not in s_text
    assert "解析" not in s_text
    assert "出处" not in s_text
    assert "答案" in a_text
    assert "解析" in a_text
    assert "出处" in a_text
    assert "SENTINEL-" not in s_text
    assert "SENTINEL-" not in a_text


def test_generation_missing_matching_rejected(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    if len(point_ids) >= 3:
        point_ids = point_ids[:2]
    resp = client.post("/api/generation-jobs", json={
        "document_ids": [document_id],
        "selected_point_ids": point_ids,
        "ai_profile_id": profile_id, "consent_id": consent_id,
        "question_config": {"single_choice": 3, "true_false": 0, "fill_blank": 0},
        "seed": 1,
    }, headers={"Idempotency-Key": "gen-no-match"})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] in ("INSUFFICIENT_POINTS",
                                            "INSUFFICIENT_POINT_MATCHING")


def test_generation_insufficient_points(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = client.post("/api/generation-jobs", json={
        "document_ids": [document_id],
        "selected_point_ids": point_ids[:1],
        "ai_profile_id": profile_id, "consent_id": consent_id,
        "question_config": {"single_choice": 5, "true_false": 5, "fill_blank": 5},
    }, headers={"Idempotency-Key": "gen-few-points"})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] in ("INSUFFICIENT_POINTS",
                                            "INSUFFICIENT_POINT_MATCHING")


def test_answer_position_balance_10_6_4(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job, count=50)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids,
                     config={"single_choice": 10, "true_false": 6, "fill_blank": 4})
    assert resp.status_code == 202, resp.text
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"])
    quiz_job = wait_job(resp.json()["job_id"])
    if quiz_job["status"] != "completed":
        detail = client.get(f"/api/quiz-records/{quiz_id}").json()
        for q in detail["questions"]:
            if q["validation_state"] != "passed":
                print("FAILED SLOT:", q["slot_number"], q["question_type"],
                      q["validation_issues"])
    assert quiz_job["status"] == "completed"

    quiz = client.get(f"/api/quiz-records/{quiz_id}").json()
    questions = quiz["questions"]
    assert len(questions) == 20, "10/6/4 → 20 槽位"

    singles = [q for q in questions if q["question_type"] == "single_choice"]
    letters = Counter(q["answer"] for q in singles)
    assert max(letters.values()) - min(letters.values()) <= 1
    assert set(letters) == {"A", "B", "C", "D"}

    tfs = [q for q in questions if q["question_type"] == "true_false"]
    answers = Counter(q["answer"] for q in tfs)
    assert answers["正确"] == 3 and answers["错误"] == 3

    fills = [q for q in questions if q["question_type"] == "fill_blank"]
    assert len(fills) == 4
    for q in fills:
        assert q["stem"].count("____") == 1

    # 生成结果确定:同 seed 重现(直接验证分配函数已经覆盖,此处验证题目数量与类型正确)


def test_slot_numbers_stable_by_type(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")
    quiz = client.get(f"/api/quiz-records/{quiz_id}").json()
    types = [q["question_type"] for q in quiz["questions"]]
    assert types == ["single_choice"] * 3 + ["true_false"] * 2 + ["fill_blank"]


def test_edit_question_revalidates_and_resets(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")
    quiz = client.get(f"/api/quiz-records/{quiz_id}").json()

    client.post(f"/api/quiz-records/{quiz_id}/reviews/bulk",
                json={"question_ids": [q["id"] for q in quiz["questions"]]})
    assert client.get(f"/api/quiz-records/{quiz_id}").json()["status"] == "ready"

    q1 = quiz["questions"][0]
    resp = client.patch(f"/api/questions/{q1['id']}", json={
        "stem": "改短", "explanation": "改",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["validation_state"] == "failed"
    assert body["review_state"] == "unreviewed"
    assert client.get(f"/api/quiz-records/{quiz_id}").json()["status"] == "draft"


def test_reject_and_delete_break_export_gate(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")
    questions = client.get(f"/api/quiz-records/{quiz_id}").json()["questions"]
    ids = [q["id"] for q in questions]

    client.post(f"/api/quiz-records/{quiz_id}/reviews/bulk", json={"question_ids": ids})
    resp = client.post(f"/api/quiz-records/{quiz_id}/exports",
                       headers={"Idempotency-Key": "gate-1"})
    assert resp.status_code == 201

    # 驳回一题 → 导出失效
    client.post(f"/api/questions/{ids[0]}/review", json={"decision": "reject"})
    resp = client.post(f"/api/quiz-records/{quiz_id}/exports",
                       headers={"Idempotency-Key": "gate-2"})
    assert resp.status_code == 409
    detail = client.get(f"/api/quiz-records/{quiz_id}").json()
    assert detail["progress"]["missing"] >= 1

    # 恢复通过 → 删除一题 → 仍不可导出
    client.post(f"/api/questions/{ids[0]}/review", json={"decision": "approve"})
    client.delete(f"/api/questions/{ids[1]}")
    resp = client.post(f"/api/quiz-records/{quiz_id}/exports",
                       headers={"Idempotency-Key": "gate-3"})
    assert resp.status_code == 409

    # 旧导出批次仍可下载,但不再是当前
    exports = client.get(f"/api/quiz-records/{quiz_id}/exports").json()
    assert exports["total"] == 1
    batch = exports["items"][0]
    assert batch["is_current"] is False
    dl = client.get(batch["files"][0]["download_url"])
    assert dl.status_code == 200


def test_fill_missing_after_delete(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")
    questions = client.get(f"/api/quiz-records/{quiz_id}").json()["questions"]

    client.delete(f"/api/questions/{questions[0]['id']}")
    detail = client.get(f"/api/quiz-records/{quiz_id}").json()
    assert detail["questions"][0]["stem"] is None

    resp = client.post(f"/api/quiz-records/{quiz_id}/fill-missing",
                       json={"consent_id": consent_id},
                       headers={"Idempotency-Key": "fill-1"})
    assert resp.status_code == 202, resp.text
    wait_job(resp.json()["job_id"], expect="completed")
    detail = client.get(f"/api/quiz-records/{quiz_id}").json()
    assert detail["questions"][0]["stem"], "补题后槽位重新有内容"
    assert len(detail["questions"]) == 6


def test_manual_fill_empty_slot_requires_frozen_point(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")
    questions = client.get(f"/api/quiz-records/{quiz_id}").json()["questions"]
    target = questions[0]
    client.delete(f"/api/questions/{target['id']}")

    # 不选考点直接手填 → 拒绝
    resp = client.patch(f"/api/questions/{target['id']}", json={
        "stem": "根据规定,机电保障部接报后多长时间内上报?",
        "options": ["15分钟", "30分钟", "1小时", "2小时"],
        "answer_content": "30分钟",
        "explanation": "原文规定为30分钟。",
    })
    assert resp.status_code == 422

    # 用冻结考点手填 → 通过并继承出处
    frozen = client.get(f"/api/quiz-records/{quiz_id}").json()["frozen_points"]
    unused = next(p for p in frozen if not p["used"])
    resp = client.patch(f"/api/questions/{target['id']}", json={
        "knowledge_point_id": unused["id"],
        "stem": "根据规定,机电保障部接报后应在多长时间内完成初步核实并上报?",
        "options": ["15分钟", "30分钟", "1小时", "2小时"],
        "answer_content": "30分钟",
        "explanation": "原文规定为30分钟内完成初步核实并上报。",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["validation_state"] == "passed"
    assert body["source"]["locator_label"], "后端从考点继承出处"


def test_quiz_record_deletion_flow(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")

    impact = client.get(f"/api/quiz-records/{quiz_id}/deletion-impact").json()
    assert impact["counts"]["questions"] == 6
    assert impact["deletion_token"]

    resp = client.delete(f"/api/quiz-records/{quiz_id}",
                         headers={"X-Deletion-Token": "bad"})
    assert resp.status_code == 409

    resp = client.delete(
        f"/api/quiz-records/{quiz_id}",
        headers={"X-Deletion-Token": impact["deletion_token"]})
    assert resp.status_code == 204
    assert client.get("/api/quiz-records").json()["total"] == 0

    # 文档因历史试卷已删除,现在可以删除
    doc_impact = client.get(f"/api/documents/{document_id}/deletion-impact").json()
    assert doc_impact["can_delete"] is True


def test_document_in_use_blocked(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")

    impact = client.get(f"/api/documents/{document_id}/deletion-impact").json()
    assert impact["can_delete"] is False
    assert quiz_id in impact["blocking_quiz_record_ids"]

    resp = client.delete(
        f"/api/documents/{document_id}",
        headers={"X-Deletion-Token": impact.get("deletion_token", "")})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "DOCUMENT_IN_USE"


def test_regenerate_question(client, wait_job):
    document_id, profile_id, consent_id, point_ids = _prepare(client, wait_job)
    resp = _generate(client, document_id, profile_id, consent_id, point_ids)
    quiz_id = resp.json()["quiz_record_id"]
    wait_job(resp.json()["job_id"], expect="completed")
    questions = client.get(f"/api/quiz-records/{quiz_id}").json()["questions"]

    resp = client.post(f"/api/questions/{questions[0]['id']}/regenerate",
                       json={"consent_id": consent_id},
                       headers={"Idempotency-Key": "regen-1"})
    assert resp.status_code == 202, resp.text
    wait_job(resp.json()["job_id"], expect="completed")
    detail = client.get(f"/api/quiz-records/{quiz_id}").json()
    assert detail["questions"][0]["validation_state"] == "passed"
    assert detail["questions"][0]["review_state"] == "unreviewed"
