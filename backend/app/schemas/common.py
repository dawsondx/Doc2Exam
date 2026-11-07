"""API DTO 基础:列表包络与通用模型(规格 13)。

所有列表统一返回 {items, total, page, page_size}。
"""

from __future__ import annotations

from pydantic import BaseModel

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 20


class ListEnvelope[T](BaseModel):
    items: list[T]
    total: int
    page: int = 1
    page_size: int = DEFAULT_PAGE_SIZE


def paginate[T](items: list[T], total: int, page: int,
                page_size: int) -> ListEnvelope[T]:
    return ListEnvelope(items=items, total=total, page=page, page_size=page_size)


def normalize_paging(page: int | None, page_size: int | None) -> tuple[int, int]:
    p = max(1, page or 1)
    ps = min(MAX_PAGE_SIZE, max(1, page_size or DEFAULT_PAGE_SIZE))
    return p, ps


def page_bounds(page: int, page_size: int, total: int) -> tuple[int, int]:
    start = (page - 1) * page_size
    end = min(start + page_size, total)
    return start, end
