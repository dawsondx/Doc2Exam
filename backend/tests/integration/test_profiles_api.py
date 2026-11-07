"""集成测试:AIProfile、Consent 生命周期与探测(规格 2.2、8.2、21.2-21/30)。"""

from __future__ import annotations


def test_profile_crud_and_no_key_leak(client, data_dir):
    resp = client.post("/api/ai-profiles", json={
        "name": "配置A", "base_url": "https://api.example.com/v1/",
        "model": "gpt-test", "api_key": "sk-secret-key-123",
        "api_mode": "chat_completions",
    })
    assert resp.status_code == 201
    body = resp.json()
    _profile_id = body["id"]
    assert body["base_url"] == "https://api.example.com/v1", "末尾 / 应规范化"
    assert "sk-secret-key-123" not in resp.text
    assert body["has_api_key"] is True

    listing = client.get("/api/ai-profiles").json()
    assert listing["total"] == 1
    assert "sk-secret-key-123" not in repr(listing)

    # SQLite 中不保存明文密钥
    import sqlite3

    conn = sqlite3.connect(data_dir / "app.db")
    rows = conn.execute("SELECT name, base_url, credential_key FROM ai_profiles").fetchall()
    conn.close()
    assert all("sk-secret-key-123" not in repr(r) for r in rows)

    # 日志不记录密钥
    log_text = (data_dir / "logs" / "app.log").read_text(encoding="utf-8", errors="ignore")
    assert "sk-secret-key-123" not in log_text


def test_probe_saves_capabilities(client, profile_with_consent):
    resp = client.get("/api/ai-profiles").json()
    assert resp["items"][0]["compatible"] is True
    caps = resp["items"][0]["capabilities"]
    assert caps["text_generation"] == "supported"
    assert caps["json_schema"] == "supported"
    assert caps["json_object"] == "not_tested", "首个成功后未测下级模式记 not_tested"
    assert caps["preferred_output_mode"] == "json_schema"


def test_consent_lifecycle_and_fingerprint_invalidation(client):
    resp = client.post("/api/ai-profiles", json={
        "name": "B", "base_url": "https://api.b.com/v1", "model": "m1",
        "api_key": "k", "api_mode": "chat_completions",
    })
    profile_id = resp.json()["id"]

    status = client.get(f"/api/data-sharing-consents?ai_profile_id={profile_id}").json()
    assert status["consent"] is None

    resp = client.post("/api/data-sharing-consents", json={
        "ai_profile_id": profile_id, "accepted": True, "disclosure_version": "1.0"})
    assert resp.status_code == 201
    _consent_id = resp.json()["id"]

    # 修改名称不失效
    client.patch(f"/api/ai-profiles/{profile_id}", json={"name": "B2"})
    status = client.get(f"/api/data-sharing-consents?ai_profile_id={profile_id}").json()
    assert status["consent"] is not None

    # 编辑表单可能回传未变化的指纹字段,值相同不得误撤销 Consent
    client.patch(f"/api/ai-profiles/{profile_id}", json={
        "name": "B3",
        "base_url": "https://api.b.com/v1/",
        "model": "m1",
        "api_mode": "chat_completions",
    })
    status = client.get(f"/api/data-sharing-consents?ai_profile_id={profile_id}").json()
    assert status["consent"] is not None

    # 修改 model → 指纹变化 → 旧 Consent 失效、能力清空
    client.patch(f"/api/ai-profiles/{profile_id}", json={"model": "m2"})
    status = client.get(f"/api/data-sharing-consents?ai_profile_id={profile_id}").json()
    assert status["consent"] is None
    profile = [p for p in client.get("/api/ai-profiles").json()["items"]
               if p["id"] == profile_id][0]
    assert profile.get("capabilities") is None

    # 撤销
    resp = client.post("/api/data-sharing-consents", json={
        "ai_profile_id": profile_id, "accepted": True, "disclosure_version": "1.0"})
    consent2 = resp.json()["id"]
    resp = client.post(f"/api/data-sharing-consents/{consent2}/revoke")
    assert resp.json()["revoked_at"] is not None
    status = client.get(f"/api/data-sharing-consents?ai_profile_id={profile_id}").json()
    assert status["consent"] is None


def test_profile_soft_delete_revokes_and_hides(client, profile_with_consent):
    profile_id, _consent = profile_with_consent
    impact = client.get(f"/api/ai-profiles/{profile_id}/deletion-impact").json()
    assert impact["deletion_token"]

    resp = client.delete(
        f"/api/ai-profiles/{profile_id}",
        headers={"X-Deletion-Token": impact["deletion_token"]})
    assert resp.status_code == 204

    assert client.get("/api/ai-profiles").json()["total"] == 0
    status_resp = client.get(f"/api/data-sharing-consents?ai_profile_id={profile_id}")
    assert status_resp.status_code in (200, 404), "软删除配置不可再查询有效确认"
    if status_resp.status_code == 200:
        assert status_resp.json()["consent"] is None
