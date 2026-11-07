"""健康检查在保持固定 JSON 的同时暴露运行模式响应头。"""


def test_health_contract_and_mock_header(client):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "app": "AI出题精灵",
        "version": "1.1.0",
        "database": "ok",
    }
    assert response.headers["X-AI-Quiz-Mock"] == "1"
