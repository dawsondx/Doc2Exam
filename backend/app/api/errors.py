"""统一错误码注册表(规格 16)与错误包络。

message/action 面向用户;日志只允许记录 request_id、端点、异常类型等非敏感信息。
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    """携带稳定错误码的业务异常,由全局处理器转为统一包络。"""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        action: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.action = action
        self.headers = headers


ERROR_MESSAGES: dict[str, tuple[str, str]] = {
    "UNSUPPORTED_FILE_TYPE": ("仅支持 PDF 和 DOCX。", "重新选择文件"),
    "FILE_TOO_LARGE": ("单个文件不能超过 50 MB。", "选择更小文件"),
    "BATCH_TOO_LARGE": ("本次文件总大小超过 200 MB。", "减少文件"),
    "BATCH_FILE_COUNT_EXCEEDED": ("一次最多上传 10 个文件。", "减少文件后重试"),
    "SCANNED_PDF_UNSUPPORTED": ("检测到扫描件,当前版本不支持 OCR。", "先用受信任工具完成 OCR"),
    "DOCUMENT_NO_TEXT": ("文档没有可用于出题的文字。", "更换文档或先完成 OCR"),
    "DOCUMENT_ENCRYPTED": ("文档已加密,无法解析。", "解除密码后重试"),
    "DOCUMENT_PARSE_FAILED": ("文档无法解析,可能已损坏或格式特殊。", "查看预览或更换文件"),
    "DOCUMENT_LIMIT_EXCEEDED": ("文档页数、文本量或解析时间超过 v1.1 限制。", "拆分文档后重试"),
    "AI_AUTH_FAILED": ("AI 服务拒绝了当前密钥。", "重新输入并测试"),
    "AI_MODEL_UNAVAILABLE": ("当前模型无法完成最小生成请求。", "检查模型名或更换模型"),
    "AI_STRUCTURED_OUTPUT_UNSUPPORTED": ("当前服务无法稳定返回结构化数据。", "更换模型或端点"),
    "AI_RATE_LIMITED": ("请求频率受限,系统正在降速重试。", "等待或降低并发"),
    "AI_TIMEOUT": ("AI 服务响应超时。", "重试或检查网络"),
    "AI_RETRY_EXHAUSTED": ("AI 服务在限定次数内仍不可用。", "稍后重试或更换配置"),
    "AI_CONSENT_REQUIRED": ("当前 AI 配置尚未获得业务数据发送确认。", "查看发送范围并确认"),
    "AI_JOB_PROFILE_CHANGED": (
        "原任务的 AI 配置已修改或删除,不能混用结果。",
        "改回原配置或创建新任务",
    ),
    "INSUFFICIENT_POINTS": ("所选考点不足以覆盖题型配置。", "增选考点或减少题数"),
    "INSUFFICIENT_POINT_MATCHING": ("当前考点无法一对一覆盖全部题型槽位。", "增选兼容题型的考点"),
    "IDEMPOTENCY_KEY_REUSED": ("同一操作标识被用于不同请求。", "刷新页面后重新操作"),
    "DELETE_CONFIRMATION_REQUIRED": ("删除前需要查看最新影响范围。", "重新打开删除确认"),
    "DOCUMENT_IN_USE": ("文档仍被历史试卷引用。", "先删除列出的试卷"),
    "JOB_INTERRUPTED": ("上次任务被程序退出中断,已保存完成部分。", "点击继续"),
    "JOB_PARTIAL": ("部分槽位在限定次数内未生成成功。", "继续补题、编辑或换考点"),
    "EXPORT_NOT_READY": ("还有题目未通过校验或人工复核。", "返回复核"),
    "EXPORT_FAILED": ("Word 生成失败,题目数据仍已保存。", "查看错误并重试"),
    "STORAGE_FULL": ("磁盘空间不足。", "清理空间后重试"),
    "DATABASE_ERROR": ("本地数据读取失败,系统未继续写入。", "关闭程序并保留 data 目录"),
    "DATABASE_UNAVAILABLE": ("数据库不可查询或迁移未完成。", "重新运行 setup.ps1"),
}


def error_body(code: str, request_id: str | None = None) -> dict[str, Any]:
    message, action = ERROR_MESSAGES.get(code, (f"发生错误:{code}", "请重试"))
    if request_id is None:
        request_id = str(uuid.uuid4())
    return {
        "error": {
            "code": code,
            "message": message,
            "action": action,
            "request_id": request_id,
        }
    }


def error_response(
    status_code: int,
    code: str,
    request_id: str | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=error_body(code, request_id),
                        headers=headers)


async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code),
        headers=exc.headers,
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content=error_body("DATABASE_ERROR"))
