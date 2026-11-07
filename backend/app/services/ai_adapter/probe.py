"""AIProfile 能力探测(规格 8.2)。

一次 probe 最多:1 次模型列表请求 + 3 个最小 generation logical call。
界面执行前显示"最多 4 次探测调用"。
"""

from __future__ import annotations

import logging
from typing import Any

from app import config
from app.api.errors import ApiError
from app.services import credentials
from app.services.ai_adapter.client import AIClient, _raw_call, plain_call
from app.services.profiles import mock_ai_enabled

logger = logging.getLogger("ai_quiz")


class ProbeResult:
    def __init__(self) -> None:
        self.capabilities: dict[str, Any] = {
            "text_generation": "not_tested",
            "json_schema": "not_tested",
            "json_object": "not_tested",
            "plain_json": "not_tested",
            "models_list": "not_tested",
            "usage": "unknown",
            "tokenizer_known": False,
            "preferred_output_mode": None,
        }
        self.error: str | None = None

    def verdict_caps(self) -> dict[str, Any]:
        return dict(self.capabilities)


async def probe_profile(profile) -> ProbeResult:  # type: ignore[no-untyped-def]
    """执行完整能力探测并返回能力字段。"""
    result = ProbeResult()
    api_key = (
        credentials.load_credential(profile.credential_key) if profile.credential_key else ""
    )
    if not api_key and not mock_ai_enabled():
        raise ApiError(422, "AI_AUTH_FAILED", "缺少 API key。", "填写 API key 后重试")

    client = AIClient(
        base_url=profile.base_url,
        model=profile.model,
        api_key=api_key or "mock-key",
        api_mode=profile.api_mode.value,
        max_output_tokens=512,
        mock=mock_ai_enabled(),
    )
    try:
        await _probe_models_list(client, result)
        await _probe_generation(client, profile, result)
    finally:
        await client.close()
    return result


async def _probe_models_list(client: AIClient, result: ProbeResult) -> None:
    """独立请求模型列表;结果不决定模型可用性(规格 8.2 步骤 2)。"""
    if client.mock:
        result.capabilities["models_list"] = "unsupported"
        return
    try:
        await client.client().models.list()
        result.capabilities["models_list"] = "supported"
    except ApiError:
        raise
    except Exception as exc:  # noqa: BLE001
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status == 404:
            result.capabilities["models_list"] = "unsupported"
        elif status in (401, 403):
            result.capabilities["models_list"] = "unknown"
        else:
            result.capabilities["models_list"] = "unknown"
        logger.info("models.list 探测失败:%s", type(exc).__name__)


class _ProbePayload:
    """探测用的最小 JSON 结构。"""

    @classmethod
    def schema(cls) -> dict:  # type: ignore[type-arg]
        return {
            "type": "object",
            "properties": {"reply": {"type": "string"}},
            "required": ["reply"],
        }


async def _probe_generation(client: AIClient, profile, result: ProbeResult) -> None:  # type: ignore[no-untyped-def]
    """按 json_schema → json_object → plain_json 顺序测试最小生成(规格 8.2 步骤 3–6)。"""
    if client.mock:
        # Mock:完整模拟一个"json_schema 可用、usage 未知"的端点,不访问网络
        result.capabilities.update({
            "text_generation": "supported",
            "json_schema": "supported",
            "json_object": "not_tested",
            "plain_json": "not_tested",
            "models_list": result.capabilities.get("models_list", "unsupported"),
            "usage": "unknown",
            "tokenizer_known": False,
            "preferred_output_mode": "json_schema",
        })
        result.error = "测试模式:未访问真实端点"
        return

    from pydantic import BaseModel

    class ProbeReply(BaseModel):
        reply: str

    system = "你是连接测试器。只返回 JSON。"
    user = f"请返回一个 JSON 对象 {{\"reply\": \"{config.CONNECTION_TEST_STRING}\"}}。"

    modes: list[tuple[str, dict[str, Any] | None, str]] = [
        ("json_schema", {"type": "json_schema", "json_schema": {
            "name": "ProbeReply", "schema": _ProbePayload.schema()}},
         "必须通过 JSON Schema 返回。"),
        ("json_object", {"type": "json_object"},
         "必须只返回一个 JSON 对象,包含字符串字段 reply。"),
        ("plain_json", None,
         "只输出一个 JSON 对象(不要代码块),包含字符串字段 reply。"),
    ]

    from app.services.ai_adapter.client import _extract_json_object

    for mode_name, _fmt, _hint in modes:
        result.capabilities[mode_name] = "not_tested"

    hard_stop: ApiError | None = None
    for mode_name, response_format, extra in modes:
        if hard_stop is not None:
            break
        try:
            prompt = f"{user}\n{extra}"
            raw = await _raw_call(client, system, prompt, response_format=response_format)
            data = _extract_json_object(raw)
            ProbeReply.model_validate(data)
            result.capabilities[mode_name] = "supported"
            result.capabilities["text_generation"] = "supported"
            result.capabilities["preferred_output_mode"] = mode_name
            break
        except ApiError as exc:
            code = exc.code
            if code in ("AI_AUTH_FAILED", "AI_MODEL_UNAVAILABLE", "AI_RATE_LIMITED",
                        "AI_TIMEOUT"):
                # 认证/模型/限流/传输耗尽:立即停止,不误记 unsupported(8.2 步骤 7)。
                result.capabilities[mode_name] = "unknown"
                result.capabilities["text_generation"] = "unknown"
                result.error = exc.message
                hard_stop = exc
                break
            result.capabilities[mode_name] = "unsupported"
        except Exception:  # noqa: BLE001  结构校验失败 = 该模式能力不支持
            result.capabilities[mode_name] = "unsupported"

    if hard_stop is not None:
        return

    if result.capabilities.get("text_generation") != "supported":
        result.capabilities["text_generation"] = "unsupported"
        result.error = result.error or "所有结构化输出模式均失败"
        return

    # usage:只有真实响应携带 usage 统计才记 supported
    if not client.mock and client.stats.input_tokens > 0:
        result.capabilities["usage"] = "supported"

    # tokenizer_known:模型在已知清单内(保守维护)
    known_prefixes = ("gpt-", "o1", "o3", "o4", "claude", "deepseek", "glm-", "qwen",
                      "gemini", "kimi", "moonshot", "ernie", "doubao")
    result.capabilities["tokenizer_known"] = any(
        profile.model.lower().startswith(p) for p in known_prefixes
    )


async def test_connection_string() -> str:
    """连接测试只发送内置固定字符串(规格 2.2)。"""
    return config.CONNECTION_TEST_STRING


async def connection_smoke(profile) -> str:  # type: ignore[no-untyped-def]
    """纯文本最小生成:确认基本连通。"""
    api_key = (
        credentials.load_credential(profile.credential_key) if profile.credential_key else ""
    )
    client = AIClient(
        base_url=profile.base_url,
        model=profile.model,
        api_key=api_key or "mock-key",
        api_mode=profile.api_mode.value,
        mock=mock_ai_enabled(),
    )
    try:
        return await plain_call(client, "你是连接测试器。",
                                f"原样返回这句话:{config.CONNECTION_TEST_STRING}")
    finally:
        await client.close()
