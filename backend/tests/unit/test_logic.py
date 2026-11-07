"""单元测试:去重、组块、分配与校验(规格 9.3、9.5、10.2–10.4、11)。"""

from __future__ import annotations

import json
from pathlib import Path

from app.schemas.ai_dtos import KnowledgePointCandidate
from app.services.extraction import chunker, dedupe
from app.services.generation import allocation
from app.services.validation import validator

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def _item(content: str, ordinal: int = 1, types=None) -> dict:
    return {
        "content": content,
        "category": "时限要求",
        "bloom_level": "remember",
        "eligible_types": types or ["single_choice", "true_false", "fill_blank"],
        "source_block_id": f"blk-{ordinal}",
        "document_order": 1,
        "block_ordinal": ordinal,
    }


def test_near_duplicate_clusters_transitive_closure():
    data = json.loads((FIXTURES / "duplicate_points.json").read_text(encoding="utf-8"))
    items = []
    for cluster in data["clusters"]:
        items.append(_item(cluster["keep"]))
        for dup in cluster.get("duplicates", []):
            items.append(_item(dup))
        for diff in cluster.get("different", []):
            items.append(_item(diff))

    result = dedupe.dedupe_candidates(items)
    contents = [r["content"] for r in result]
    for cluster in data["clusters"]:
        assert cluster["keep"] in contents, "簇内排序第一项必须保留"
    kept_dupes = [d for c in data["clusters"] for d in c.get("duplicates", [])
                  if d in contents]
    assert kept_dupes == [], "近似重复应被传递闭包去掉"


def test_dedupe_deterministic_same_input():
    items = [_item("机电保障部应在接报后30分钟内完成初步核实并上报", 1),
             _item("机电保障部应在接报后30分钟内完成初步核实并向上级上报", 2),
             _item("安保部接到指令后应在10分钟内完成警戒区域设置", 3)]
    r1 = dedupe.dedupe_candidates(items)
    r2 = dedupe.dedupe_candidates(items)
    assert [x["content"] for x in r1] == [x["content"] for x in r2]


def test_exact_dedupe_same_block():
    items = [_item("同一考点", 1), _item("同一考点", 1)]
    assert len(dedupe.dedupe_candidates(items)) == 1


def test_validate_candidate_bounds():
    good = KnowledgePointCandidate(
        source_block_id="b1", content="十位字符以上的考点内容", bloom_level="remember",
        category="时限要求", eligible_types=["true_false"],
    )
    verdict = dedupe.validate_candidate(good, {"b1"})
    assert verdict.ok
    assert verdict.requires_source_review is False or verdict.requires_source_review is True

    bad_id = good.model_copy(update={"source_block_id": "b2"})
    assert not dedupe.validate_candidate(bad_id, {"b1"}).ok

    short = good.model_copy(update={"content": "太短"})
    assert not dedupe.validate_candidate(short, {"b1"}).ok

    bad_type = good.model_copy(update={"eligible_types": ["essay"]})
    assert not dedupe.validate_candidate(bad_type, {"b1"}).ok


def test_target_point_count_clamp():
    assert chunker.target_point_count(8) == 20
    assert chunker.target_point_count(20) == 50
    assert chunker.target_point_count(200) == 200


def test_chunk_assembly_boundary_and_overlap():
    blocks = [
        chunker.ChunkBlock(f"b{i}", i, "文本" * 120, 240) for i in range(1, 21)
    ]
    chunks = chunker.assemble_chunks(blocks, context_window=32_768,
                                     max_output_tokens=4096)
    assert len(chunks) > 1
    ids = [[b.block_id for b in c.blocks] for c in chunks]
    # 相邻 chunk 最多重复一个边界块
    for a, b in zip(ids, ids[1:], strict=False):
        overlap = set(a) & set(b)
        assert len(overlap) <= 1
    assert chunker.chunk_budget(32_768, 4096) >= 2000


def test_bipartite_matching_full_cover():
    config = {"single_choice": 2, "true_false": 2, "fill_blank": 1}
    slots = allocation.build_slots(config, seed=42)
    candidates = {}
    for slot in slots:
        candidates[slot.slot_number] = [f"p{i}" for i in range(5)]
    match = allocation.bipartite_match([s.slot_number for s in slots], candidates, 42)
    assert match is not None and len(match) == 5
    assert len(set(match.values())) == 5


def test_bipartite_matching_fails_when_insufficient():
    config = {"single_choice": 3, "true_false": 0, "fill_blank": 0}
    slots = allocation.build_slots(config, seed=7)
    candidates = {s.slot_number: ["only-one-point"] for s in slots}
    assert allocation.bipartite_match(
        [s.slot_number for s in slots], candidates, 7) is None


def test_matching_deterministic_by_seed():
    config = {"single_choice": 4, "true_false": 2, "fill_blank": 2}
    slots = [s.slot_number for s in allocation.build_slots(config, seed=99)]
    candidates = {s: [f"p{i}" for i in range(10)] for s in slots}
    m1 = allocation.bipartite_match(slots, candidates, 99)
    m2 = allocation.bipartite_match(slots, candidates, 99)
    assert m1 == m2


def test_balanced_letters_max_diff_one():
    letters = allocation.balanced_letters(10, seed=1)
    from collections import Counter

    counts = Counter(letters)
    assert max(counts.values()) - min(counts.values()) <= 1


def test_balanced_true_false():
    plan = allocation.balanced_true_false(6, seed=5)
    assert plan.count(True) == 3 and plan.count(False) == 3
    odd = allocation.balanced_true_false(5, seed=5)
    assert abs(odd.count(True) - odd.count(False)) == 1


# --- 程序校验(规格 11)---


def test_validate_single_choice_ok():
    report = validator.validate_single_choice(
        stem="根据规定,机电保障部接报后应在多长时间内完成初步核实并上报?",
        options=["15分钟", "30分钟", "1小时", "2小时"],
        answer_content="30分钟",
        explanation="原文规定时限为30分钟,其余选项不符。",
        point_content="机电保障部应在接报后30分钟内完成初步核实并上报",
        block_text="机电保障部应在接报后30分钟内完成初步核实并上报",
    )
    assert report.passed, report.all_issues()


def test_validate_single_choice_duplicate_options_fail():
    report = validator.validate_single_choice(
        stem="根据规定的时限要求,以下哪一项是正确的?",
        options=["30分钟", "30分钟", "1小时", "2小时"],
        answer_content="30分钟",
        explanation="解析内容足够长。",
        point_content="30分钟内上报",
        block_text="30分钟内上报",
    )
    assert not report.passed


def test_validate_single_choice_forbidden_option():
    report = validator.validate_single_choice(
        stem="根据规定,以下哪一项表述是正确的?",
        options=["以上都对", "30分钟", "1小时", "2小时"],
        answer_content="30分钟",
        explanation="解析内容足够长。",
        point_content="30分钟内上报", block_text="30分钟内上报",
    )
    assert not report.passed


def test_validate_true_false_target_mismatch():
    report = validator.validate_true_false(
        stem="机电保障部接报后应在30分钟内完成初步核实并上报。",
        answer="错误", target_answer=True,
        explanation="原文规定为30分钟内完成初步核实并上报。",
        point_content="30分钟内上报", block_text="30分钟内上报",
    )
    assert not report.passed


def test_validate_true_false_question_stem_rejected():
    report = validator.validate_true_false(
        stem="机电保障部接报后应在多长时间内上报?", answer="正确",
        target_answer=True, explanation="解析内容足够长。",
        point_content="30分钟", block_text="30分钟",
    )
    assert not report.passed


def test_validate_fill_blank_rules():
    ok = validator.validate_fill_blank(
        stem="机电保障部接报后应在____内完成初步核实并上报。",
        answer="30分钟", acceptable_answers=["三十分钟"],
        explanation="原文规定的时限为30分钟。",
        point_content="30分钟内上报", block_text="机电保障部应在接报后30分钟内上报",
    )
    assert ok.passed, ok.all_issues()

    leaked = validator.validate_fill_blank(
        stem="应在30分钟也就是____内完成核实并上报,时限是30分钟。",
        answer="30分钟", acceptable_answers=[],
        explanation="原文规定的时限为30分钟。",
        point_content="30分钟", block_text="30分钟",
    )
    assert not leaked.passed

    missing_blank = validator.validate_fill_blank(
        stem="机电保障部接报后应在多长时间内完成初步核实并上报。",
        answer="30分钟", acceptable_answers=[],
        explanation="原文规定的时限为30分钟。",
        point_content="30分钟", block_text="30分钟",
    )
    assert not missing_blank.passed


def test_mock_failure_fixture_bounded_error():
    """mock_ai_failures.json 的每种失败注入 _mock_call 都抛稳定 ApiError(规格 21.2-12)。"""
    import pytest

    from app.api.errors import ApiError
    from app.schemas.ai_dtos import SingleChoiceDraft
    from app.services.ai_adapter.client import _mock_call

    failures = json.loads(
        (FIXTURES / "mock_ai_failures.json").read_text(encoding="utf-8")
    )
    cases = failures if isinstance(failures, list) else failures.get("cases", [])
    assert len(cases) >= 2, "夹具应包含失败用例"
    # 带 error_code 的用例(429/超时)注入后必须抛出同码 ApiError;
    # 非法 JSON / 结构失败用例由解析层(AICapabilityError)处理,不进 _mock_call。
    coded = [c for c in cases if c.get("error_code")]
    assert {c["error_code"] for c in coded} == {"AI_RATE_LIMITED", "AI_TIMEOUT"}
    for case in coded:
        payload = {"status": case.get("http_status", 502), "code": case["error_code"],
                   "message": f"Mock AI 模拟失败:{case.get('name', '')}"}
        with pytest.raises(ApiError) as exc_info:
            _mock_call(SingleChoiceDraft, None, payload)
        assert exc_info.value.code == case["error_code"]


def test_export_sentinel_fixture_unique():
    """export_sentinel.json 四个哨兵互不相同且格式唯一(规格 15.5、20)。"""
    data = json.loads(
        (FIXTURES / "export_sentinel.json").read_text(encoding="utf-8")
    )
    values = [
        data["answer_sentinel"],
        data["explanation_sentinel"],
        data["locator_sentinel"],
        data["source_sentinel"],
    ]
    assert len(set(values)) == 4
