"""集成测试:文档上传、解析与删除(规格 13.2、21.2-1/2/3/22)。"""

from __future__ import annotations

import io
import json
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
EXPECTED = json.loads((FIXTURES / "expected_source_blocks.json").read_text(encoding="utf-8"))


def test_upload_pdf_parse_flow(client, wait_job):
    with open(FIXTURES / "policy_text.pdf", "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("policy_text.pdf", f, "application/pdf")},
            headers={"Idempotency-Key": "it-upload-1"},
        )
    assert resp.status_code == 202
    data = resp.json()
    assert data["items"][0]["document"]["parse_status"] == "pending"
    wait_job(data["items"][0]["job_id"], expect="completed")

    document_id = data["items"][0]["document"]["id"]
    detail = client.get(f"/api/documents/{document_id}").json()
    assert detail["parse_status"] == "ready"
    assert detail["page_count"] == EXPECTED["policy_text.pdf"]["page_count"]
    assert detail["block_count"] == len(EXPECTED["policy_text.pdf"]["blocks"])
    assert detail["preview"], "应有前 300 字符预览"


def test_upload_docx_no_page_number(client, wait_job):
    with open(FIXTURES / "policy_text.docx", "rb") as f:
        resp = client.post(
            "/api/documents",
            files={"files": ("policy_text.docx", f,
                             "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
            headers={"Idempotency-Key": "it-upload-2"},
        )
    assert resp.status_code == 202
    item = resp.json()["items"][0]
    wait_job(item["job_id"], expect="completed")
    detail = client.get(f"/api/documents/{item['document']['id']}").json()
    assert detail["parse_status"] == "ready"
    assert detail["page_count"] is None, "DOCX 不显示页码"
    kinds = {b["locator_kind"] for b in detail["blocks"]}
    assert "docx_paragraph" in kinds


def test_invalid_type_rejected_no_document(client):
    resp = client.post(
        "/api/documents",
        files={"files": ("evil.txt", io.BytesIO(b"hello"), "text/plain")},
        headers={"Idempotency-Key": "it-upload-3"},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "UNSUPPORTED_FILE_TYPE"
    assert client.get("/api/documents").json()["total"] == 0


def test_oversize_file_rejected(client):
    big = io.BytesIO(b"%PDF-1.7" + b"0" * (50 * 1024 * 1024 + 10))
    resp = client.post(
        "/api/documents",
        files={"files": ("big.pdf", big, "application/pdf")},
        headers={"Idempotency-Key": "it-upload-4"},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_batch_count_rejected(client):
    files = [("f.pdf", io.BytesIO(b"%PDF-1.7 minimal"), "application/pdf")
             for _ in range(11)]
    resp = client.post(
        "/api/documents",
        files=[("files", f) for f in files],
        headers={"Idempotency-Key": "it-upload-5"},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "BATCH_FILE_COUNT_EXCEEDED"


def test_scanned_and_encrypted_fail_parse_only(client, wait_job):
    results = {}
    for name, _code in [
        ("scanned.pdf", "SCANNED_PDF_UNSUPPORTED"),
        ("encrypted.pdf", "DOCUMENT_ENCRYPTED"),
        ("corrupt.docx", "DOCUMENT_PARSE_FAILED"),
    ]:
        media = (
            "application/pdf" if name.endswith(".pdf")
            else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        with open(FIXTURES / name, "rb") as f:
            resp = client.post(
                "/api/documents",
                files={"files": (name, f, media)},
                headers={"Idempotency-Key": f"it-bad-{name}"},
            )
        assert resp.status_code == 202
        item = resp.json()["items"][0]
        job = wait_job(item["job_id"], expect="failed")
        results[name] = job
        detail = client.get(f"/api/documents/{item['document']['id']}").json()
        assert detail["parse_status"] == "failed"
    assert results["scanned.pdf"]["error"]["code"] == "SCANNED_PDF_UNSUPPORTED"


def test_reuse_parse_result(client, wait_job):
    for key in ("it-reuse-1", "it-reuse-2"):
        with open(FIXTURES / "policy_text.pdf", "rb") as f:
            resp = client.post(
                "/api/documents",
                files={"files": ("policy_text.pdf", f, "application/pdf")},
                headers={"Idempotency-Key": key},
            )
        assert resp.status_code == 202
        item = resp.json()["items"][0]
        wait_job(item["job_id"], expect="completed")
    docs = client.get("/api/documents").json()
    assert docs["total"] == 2
    counts = [d["block_count"] for d in docs["items"]]
    assert counts[0] == counts[1] == len(EXPECTED["policy_text.pdf"]["blocks"])


def test_document_deletion_requires_token_and_impact(client, wait_job, uploaded_pdf):
    document_id, _ = uploaded_pdf
    wait_job_finished_documents(client, document_id)

    impact = client.get(f"/api/documents/{document_id}/deletion-impact").json()
    assert impact["can_delete"] is True
    assert impact["deletion_token"]

    resp = client.delete(f"/api/documents/{document_id}",
                         headers={"X-Deletion-Token": "wrong-token"})
    assert resp.status_code == 409

    resp = client.delete(
        f"/api/documents/{document_id}",
        headers={"X-Deletion-Token": impact["deletion_token"]})
    assert resp.status_code == 204
    assert client.get("/api/documents").json()["total"] == 0


def wait_job_finished_documents(client, document_id):
    import time

    deadline = time.time() + 60
    while time.time() < deadline:
        detail = client.get(f"/api/documents/{document_id}").json()
        if detail["parse_status"] in ("ready", "failed"):
            return detail
        time.sleep(0.15)
    raise AssertionError("parse job timeout")
