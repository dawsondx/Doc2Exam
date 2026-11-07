"""应用配置与全局常量。

数据目录固定为项目根 `data/`,可用环境变量 `AI_QUIZ_DATA_DIR` 覆盖(测试隔离用)。
版本号由本模块的 `__version__` 单一来源提供。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

__version__ = "1.1.0"

APP_NAME = "AI出题精灵"


def _resolve_data_dir() -> Path:
    override = os.environ.get("AI_QUIZ_DATA_DIR")
    if override:
        return Path(override).resolve()
    return PROJECT_ROOT / "data"


DATA_DIR = _resolve_data_dir()
UPLOADS_DIR = DATA_DIR / "uploads"
EXPORTS_DIR = DATA_DIR / "exports"
TEMP_DIR = DATA_DIR / "temp"
LOGS_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "app.db"

HOST = "127.0.0.1"
DEFAULT_PORT = 8000

UPLOAD_MAX_FILES = 10
UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024
UPLOAD_MAX_TOTAL_BYTES = 200 * 1024 * 1024

PDF_MAX_PAGES = 500
PDF_MAX_CHARS = 2_000_000
PARSE_JOB_TIMEOUT_SECONDS = 120

CHUNK_TARGET_TOKENS_MIN = 2_000
CHUNK_TARGET_TOKENS_MAX = 4_000
SOURCE_BLOCK_SOFT_LIMIT = 800
SOURCE_BLOCK_MERGE_TAIL = 200

IDEMPOTENCY_RETENTION_HOURS = 24
DELETION_TOKEN_TTL_SECONDS = 300

DEFAULT_CONTEXT_WINDOW = 32_768
DEFAULT_MAX_OUTPUT_TOKENS = 4_096
DEFAULT_MAX_CONCURRENCY = 4

AI_HTTP_ATTEMPTS_PER_CALL = 3
AI_LOGICAL_CALLS_PER_CHUNK = 3
AI_LOGICAL_CALLS_PER_SLOT = 5
AI_ATTEMPT_TIMEOUT_SECONDS = 60.0
AI_RETRY_MAX_WAIT_SECONDS = 30.0

DISCLOSURE_VERSION = "1.0"
CONNECTION_TEST_STRING = "AI出题精灵连接测试"

PROMPT_VERSION = "v1.1-prompt-1"


def ensure_dirs() -> None:
    for d in (DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, TEMP_DIR, LOGS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def setup_logging() -> logging.Logger:
    """配置日志:写入 data/logs/app.log,只记录非敏感信息。"""
    ensure_dirs()
    logger = logging.getLogger("ai_quiz")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s", "%Y-%m-%dT%H:%M:%S"
    )
    file_handler = logging.FileHandler(LOGS_DIR / "app.log", encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    logger.addHandler(stream)
    logger.propagate = False
    return logger
