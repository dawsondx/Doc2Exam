"""AI 适配层:端点调用、重试策略与结构化输出降级(规格 6.3、8.3、8.4)。

- 每个 logical call 最多 3 次 HTTP attempt(首次+2 重试);仅对 408/429/连接/
  读取超时/5xx 重试;400/401/403/404 与结构校验失败不重试。
- 429 优先遵守 Retry-After(≤30 秒);否则 1s、2s + 0–250ms 抖动;单次 attempt 60 秒超时。
- 结构化输出降级:JSON Schema → json_object → 纯文本 JSON 提取。
- Mock AI:AI_QUIZ_MOCK_AI=1 时启用,响应来自测试夹具,日志与界面标记"测试模式"。
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from dataclasses import dataclass, field
from typing import Any

from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI
from pydantic import BaseModel, ValidationError

from app import config
from app.api.errors import ApiError

logger = logging.getLogger("ai_quiz")


RETRYABLE_STATUS = {408, 429} | set(range(500, 600))


@dataclass
class CallStats:
    logical_calls: int = 0
    http_attempts: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    def merge(self, other: CallStats) -> None:
        self.logical_calls += other.logical_calls
        self.http_attempts += other.http_attempts
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens


class TransportError(Exception):
    """传输层错误(可按 6.3 策略重试)。"""


class AICapabilityError(Exception):
    """端点能力不支持(不重试,触发降级)。"""


@dataclass
class AIClient:
    base_url: str
    model: str
    api_key: str
    api_mode: str = "chat_completions"
    preferred_mode: str = "json_schema"
    max_output_tokens: int = 4_096
    stats: CallStats = field(default_factory=CallStats)
    mock: bool = False
    _client: AsyncOpenAI | None = None

    def client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(
                base_url=self.base_url,
                api_key=self.api_key,
                max_retries=0,
                timeout=config.AI_ATTEMPT_TIMEOUT_SECONDS,
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None


def _error_code_from_status(status: int) -> str:
    if status in (401, 403):
        return "AI_AUTH_FAILED"
    if status == 404:
        return "AI_MODEL_UNAVAILABLE"
    if status == 429:
        return "AI_RATE_LIMITED"
    if status == 408:
        return "AI_TIMEOUT"
    if status >= 500:
        return "AI_TIMEOUT"
    return "AI_RETRY_EXHAUSTED"


def _retry_delay(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            delay = float(retry_after)
        except ValueError:
            delay = 1.0
        return min(delay, config.AI_RETRY_MAX_WAIT_SECONDS)
    base = (1.0, 2.0)[min(attempt - 1, 1)]
    return base + random.uniform(0, 0.25)


async def _raw_call(
    client: AIClient,
    system: str,
    user: str,
    *,
    response_format: dict[str, Any] | None,
) -> str:
    """单次 HTTP attempt,带传输重试(≤3 次 attempt)。"""
    last_error: ApiError | None = None
    for attempt in range(1, config.AI_HTTP_ATTEMPTS_PER_CALL + 1):
        try:
            client.stats.http_attempts += 1
            if client.api_mode == "responses":
                kwargs: dict[str, Any] = {
                    "model": client.model,
                    "input": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "max_output_tokens": client.max_output_tokens,
                }
                if response_format and response_format.get("type") == "json_schema":
                    kwargs["text"] = {"format": response_format}
                resp = await client.client().responses.create(**kwargs)
                _record_usage(client, getattr(resp, "usage", None))
                return _responses_output_text(getattr(resp, "output", []) or [])
            kwargs = {
                "model": client.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "max_tokens": client.max_output_tokens,
            }
            if response_format is not None:
                kwargs["response_format"] = response_format
            resp = await client.client().chat.completions.create(**kwargs)
            _record_usage(client, getattr(resp, "usage", None))
            message = resp.choices[0].message
            return message.content or ""
        except APIStatusError as exc:
            status = exc.response.status_code
            retry_after = exc.response.headers.get("Retry-After")
            if status in RETRYABLE_STATUS and attempt < config.AI_HTTP_ATTEMPTS_PER_CALL:
                await asyncio.sleep(_retry_delay(attempt, retry_after))
                continue
            last_error = ApiError(
                502, _error_code_from_status(status),
                f"AI 服务返回 HTTP {status}。", "稍后重试或更换配置",
            )
            break
        except (APIConnectionError, APITimeoutError) as exc:
            if attempt < config.AI_HTTP_ATTEMPTS_PER_CALL:
                await asyncio.sleep(_retry_delay(attempt, None))
                continue
            last_error = ApiError(
                504, "AI_TIMEOUT", "AI 服务响应超时。", "重试或检查网络"
            )
            logger.info("AI 传输错误:%s", type(exc).__name__)
            break
        except ApiError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = ApiError(502, "AI_RETRY_EXHAUSTED",
                                  "AI 调用失败。", "稍后重试或更换配置")
            logger.info("AI 调用异常:%s", type(exc).__name__)
            break
    raise last_error or ApiError(502, "AI_RETRY_EXHAUSTED", "AI 调用失败。",
                                 "稍后重试或更换配置")


def _responses_output_text(outputs: list) -> str:  # type: ignore[type-arg]
    """拼接 Responses API 输出中的全部文本内容。"""
    parts: list[str] = []
    for item in outputs:
        content = getattr(item, "content", None)
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                text = getattr(block, "text", None)
                if isinstance(text, str):
                    parts.append(text)
    return "".join(parts)


def _record_usage(client: AIClient, usage: Any) -> None:
    if usage is not None:
        client.stats.input_tokens += getattr(usage, "prompt_tokens", 0) or 0
        client.stats.output_tokens += getattr(usage, "completion_tokens", 0) or 0


def _extract_json_object(text: str) -> dict[str, Any]:
    """提取首个完整 JSON 对象(规格 8.3 策略 3)。禁止 eval。"""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    if start < 0:
        raise AICapabilityError("响应中没有 JSON 对象")
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"' and not in_string:
            in_string = True
            continue
        if ch == '"' and in_string:
            in_string = False
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start : i + 1]
                try:
                    parsed = json.loads(candidate)
                except json.JSONDecodeError as exc:
                    raise AICapabilityError("JSON 解析失败") from exc
                if isinstance(parsed, dict):
                    return parsed
                raise AICapabilityError("响应不是 JSON 对象")
    raise AICapabilityError("JSON 对象不完整")


def _schema_for(model: type[BaseModel]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": model.__name__,
            "schema": model.model_json_schema(),
            "strict": False,
        },
    }


async def structured_call[T: BaseModel](
    client: AIClient,
    system: str,
    user: str,
    model: type[T],
    *,
    mock_responses: list[dict[str, Any]] | None = None,
    mock_failure: dict[str, Any] | None = None,
) -> T:
    """一次 logical call:按 preferred_mode 起步,能力错误时逐级降级(8.3)。"""
    client.stats.logical_calls += 1

    if client.mock:
        return _mock_call(model, mock_responses, mock_failure)

    order = ["json_schema", "json_object", "plain_json"]
    start_index = order.index(client.preferred_mode) if client.preferred_mode in order else 0

    for mode in order[start_index:]:
        try:
            if mode == "json_schema":
                raw = await _raw_call(client, system, user,
                                      response_format=_schema_for(model))
                data = _extract_json_object(raw) if not raw.strip().startswith("{") \
                    else json.loads(raw)
            elif mode == "json_object":
                prompt = user + "\n\n必须只返回一个 JSON 对象,不要输出其他文本。"
                raw = await _raw_call(
                    client, system, prompt, response_format={"type": "json_object"}
                )
                data = _extract_json_object(raw)
            else:
                prompt = (
                    user
                    + "\n\n请只输出一个 JSON 对象(不要 Markdown 代码块),"
                    + "字段:" + ",".join(model.model_json_schema().get("properties", {}).keys())
                )
                raw = await _raw_call(client, system, prompt, response_format=None)
                data = _extract_json_object(raw)
            return model.model_validate(data)
        except AICapabilityError:
            continue
        except ValidationError:
            continue
        except json.JSONDecodeError:
            continue
    raise ApiError(
        502,
        "AI_STRUCTURED_OUTPUT_UNSUPPORTED",
        "当前服务无法稳定返回结构化数据。",
        "更换模型或端点",
    )


def _mock_call[T: BaseModel](
    model: type[T],
    mock_responses: list[dict[str, Any]] | None,
    mock_failure: dict[str, Any] | None,
) -> T:
    """Mock AI:确定性返回夹具数据;日志明确标记测试模式。"""
    if mock_failure:
        raise ApiError(
            mock_failure.get("status", 502),
            mock_failure.get("code", "AI_RETRY_EXHAUSTED"),
            mock_failure.get("message", "Mock AI 模拟失败。"),
            "这是测试模式的模拟错误",
        )
    if mock_responses:
        return model.model_validate(mock_responses[0])
    raise ApiError(502, "AI_STRUCTURED_OUTPUT_UNSUPPORTED",
                   "测试模式缺少夹具响应。", "补充 mock_ai_success.json 夹具")


async def plain_call(client: AIClient, system: str, user: str) -> str:
    client.stats.logical_calls += 1
    if client.mock:
        return config.CONNECTION_TEST_STRING
    return await _raw_call(client, system, user, response_format=None)


def make_client(
    *,
    base_url: str,
    model: str,
    api_key: str,
    api_mode: str,
    preferred_mode: str = "json_schema",
    max_output_tokens: int = 4_096,
    mock: bool = False,
) -> AIClient:
    return AIClient(
        base_url=base_url,
        model=model,
        api_key=api_key if not mock else "mock-key",
        api_mode=api_mode,
        preferred_mode=preferred_mode,
        max_output_tokens=max_output_tokens,
        mock=mock,
    )
