"""考点分配与答案位置计划(规格 10.2、10.3、10.4)。

确定算法:槽位按"候选考点数升序、slot_number 升序";每个槽位的候选考点按
SHA-256(seed + slot_number + knowledge_point_id) 升序;按该顺序遍历的增广路
二分匹配。相同数据和 seed 产生相同分配。
"""

from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass

SLOT_PLAN_LETTERS = ("A", "B", "C", "D")


def slot_point_order_key(seed: int, slot_number: int, point_id: str) -> bytes:
    raw = f"{seed}:{slot_number}:{point_id}".encode()
    return hashlib.sha256(raw).digest()


def bipartite_match(
    slots: list[int],
    candidates: dict[int, list[str]],
    seed: int,
) -> dict[int, str] | None:
    """返回 slot_number → knowledge_point_id 的一对一匹配;不可覆盖时返回 None。

    slots:槽位编号列表;candidates:每个槽位的候选考点 ID 列表(未排序)。
    """
    # 槽位顺序:候选数升序、slot_number 升序
    ordered_slots = sorted(slots, key=lambda s: (len(candidates.get(s, [])), s))
    # 每槽候选按哈希序
    sorted_candidates = {
        s: sorted(candidates.get(s, []),
                  key=lambda pid: slot_point_order_key(seed, s, pid))
        for s in slots
    }

    match_point_to_slot: dict[str, int] = {}

    def try_assign(slot: int, visited: set[str]) -> bool:
        for point_id in sorted_candidates.get(slot, []):
            if point_id in visited:
                continue
            visited.add(point_id)
            holder = match_point_to_slot.get(point_id)
            if holder is None or try_assign(holder, visited):
                match_point_to_slot[point_id] = slot
                return True
        return False

    for slot in ordered_slots:
        if not try_assign(slot, set()):
            return None

    return {slot: point_id for point_id, slot in match_point_to_slot.items()}


@dataclass
class SlotPlan:
    slot_number: int
    question_type: str
    answer_letter: str | None  # 单选预定答案位置
    target_answer: bool | None  # 判断题预定正误


def build_slots(config: dict[str, int], seed: int) -> list[SlotPlan]:
    """按题型顺序建立固定槽位,并预生成答案位置/正误计划。"""
    single = config.get("single_choice", 0)
    true_false = config.get("true_false", 0)
    fill = config.get("fill_blank", 0)

    letters = balanced_letters(single, seed)
    targets = balanced_true_false(true_false, seed)

    plans: list[SlotPlan] = []
    slot_number = 0
    for _ in range(single):
        slot_number += 1
        plans.append(SlotPlan(slot_number, "single_choice", letters[slot_number - 1], None))
    for i in range(true_false):
        slot_number += 1
        plans.append(SlotPlan(slot_number, "true_false", None, targets[i]))
    for _ in range(fill):
        slot_number += 1
        plans.append(SlotPlan(slot_number, "fill_blank", None, None))
    return plans


def balanced_letters(n: int, seed: int) -> list[str]:
    """A/B/C/D 出现次数最大差 ≤ 1,再用 QuizRecord 种子打乱顺序(规格 10.3)。"""
    if n <= 0:
        return []
    base: list[str] = []
    for i in range(n):
        base.append(SLOT_PLAN_LETTERS[i % 4])
    rng = random.Random(seed)
    rng.shuffle(base)
    return base


def balanced_true_false(n: int, seed: int) -> list[bool]:
    """正确/错误目标数最大差 ≤ 1;奇数多出的一个由种子决定(规格 10.4)。"""
    if n <= 0:
        return []
    true_count = n // 2
    false_count = n // 2
    if n % 2 == 1:
        if random.Random(seed).randint(0, 1) == 0:
            true_count += 1
        else:
            false_count += 1
    plan = [True] * true_count + [False] * false_count
    rng = random.Random(seed + 1)
    rng.shuffle(plan)
    return plan
