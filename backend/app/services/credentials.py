"""API key 凭据存储(规格 2.3)。

优先 Windows Credential Manager(keyring);不可用时降级为进程内存,
界面需提示"关闭程序后需重新输入"。密钥不进 SQLite、日志、前端。
"""

from __future__ import annotations

import logging

import keyring
import keyring.errors

logger = logging.getLogger("ai_quiz")

SERVICE_NAME = "AI出题精灵"

_memory_fallback: dict[str, str] = {}
_using_memory_fallback = False


def _detect_fallback() -> None:
    global _using_memory_fallback
    if _using_memory_fallback:
        return
    try:
        backend = keyring.get_keyring()
        if backend.priority < 1 or "fail" in type(backend).__module__.lower():
            _using_memory_fallback = True
    except Exception:  # noqa: BLE001
        _using_memory_fallback = True


def is_memory_fallback() -> bool:
    _detect_fallback()
    return _using_memory_fallback


def save_credential(credential_key: str, api_key: str) -> None:
    """保存或替换密钥。credential_key 是数据库中的引用名。"""
    global _using_memory_fallback
    _detect_fallback()
    if _using_memory_fallback:
        _memory_fallback[credential_key] = api_key
        logger.info("凭据存储不可用,密钥仅保存在本进程内存")
        return
    try:
        keyring.set_password(SERVICE_NAME, credential_key, api_key)
    except keyring.errors.KeyringError:
        _memory_fallback[credential_key] = api_key
        _using_memory_fallback = True
        logger.warning("keyring 写入失败,降级为进程内存保存")


def load_credential(credential_key: str) -> str | None:
    _detect_fallback()
    if _using_memory_fallback:
        return _memory_fallback.get(credential_key)
    try:
        return keyring.get_password(SERVICE_NAME, credential_key)
    except keyring.errors.KeyringError:
        return _memory_fallback.get(credential_key)


def delete_credential(credential_key: str) -> None:
    _memory_fallback.pop(credential_key, None)
    _detect_fallback()
    if _using_memory_fallback:
        return
    try:
        keyring.delete_password(SERVICE_NAME, credential_key)
    except keyring.errors.KeyringError:
        logger.info("清理系统凭据失败(可能已不存在):%s", credential_key)
