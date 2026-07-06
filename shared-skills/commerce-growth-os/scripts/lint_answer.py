#!/usr/bin/env python3
"""Deterministic quality linter for saved commerce-growth-os answers."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "eval" / "cases.json"

EMPTY_ADVICE_TERMS = [
    "提升品牌曝光",
    "优化内容",
    "加强运营",
    "加大投放",
    "提高转化率",
    "找更多达人",
    "多做种草",
    "冲GMV",
    "冲gmv",
    "做全域布局",
]

NEGATION_TERMS = [
    "不要",
    "不能",
    "避免",
    "禁止",
    "不是",
    "不应",
    "拒绝",
    "avoid",
    "do not",
    "don't",
    "without",
]

MECHANISM_TERMS = [
    "机制",
    "动作",
    "指标",
    "owner",
    "负责人",
    "止损",
    "放量",
    "review",
    "复盘",
    "metric",
    "stop rule",
    "scale rule",
]

SCALE_TERMS = [
    "加预算",
    "加大投放",
    "放量",
    "翻倍预算",
    "投千川",
    "开万相台",
    "book",
    "double the budget",
    "scale budget",
    "add budget",
]

TACTIC_TERMS = [
    "投千川",
    "做小红书",
    "找达人",
    "开直播",
    "开万相台",
    "聚光",
    "达人直播",
    "talent livestream",
    "paid media",
]

ECONOMICS_TERMS = [
    "channel net profit",
    "渠道净利润",
    "break-even",
    "盈亏平衡",
    "gross-profit roi",
    "毛利roi",
    "unit economics",
    "经济模型",
    "算账",
    "毛利",
    "利润",
    "refund",
    "退款",
    "margin",
]

STOP_TERMS = ["stop rule", "止损", "停止", "暂停", "cut", "pause"]
SCALE_RULE_TERMS = ["scale rule", "放量", "加预算规则", "扩大", "increase only", "scale only"]

CURRENT_WORDS = [
    "当前",
    "现在",
    "最新",
    "还能",
    "是否还能",
    "still",
    "current",
    "latest",
    "today",
]

PLATFORM_TERMS = [
    "千川",
    "万相台",
    "聚光",
    "蒲公英",
    "星图",
    "京准通",
    "多多进宝",
    "磁力",
    "视频号",
    "微信小店",
    "juguang",
    "qianchuan",
    "wanxiangtai",
]

EVIDENCE_LABELS = [
    "Confirmed from user backend",
    "Officially verified",
    "Stable operating principle",
    "Needs current verification",
    "已由用户后台确认",
    "官方已核验",
    "稳定原则",
    "需要当前核验",
]

MODE_REQUIRED_GROUPS = {
    "quick_diagnosis": [
        ["current judgment", "当前判断", "判断"],
        ["bottleneck", "瓶颈"],
        ["missing data", "缺失数据", "假设", "assumptions"],
        ["next three actions", "next 3 actions", "三个动作", "3个动作"],
        ["risk", "风险"],
    ],
    "decision_memo": [
        ["decision", "结论", "判断", "建议", "不建议"],
        ["economics", "unit economics", "经济模型", "算账", "channel net profit", "渠道净利润"],
        ["assumptions", "假设", "confirmed facts", "已确认", "条件"],
        ["stop rule", "止损"],
        ["scale rule", "放量"],
        ["risk", "风险"],
    ],
    "full_operating_plan": [
        ["business model", "经营模型", "经济模型", "break-even", "盈亏平衡"],
        ["assortment", "货盘", "sku"],
        ["price ladder", "价盘", "价格线"],
        ["channel jobs", "渠道角色", "渠道分工"],
        ["content", "内容"],
        ["fulfillment", "履约", "after-sale", "售后", "refund", "退款"],
        ["review cadence", "复盘", "review loop"],
    ],
    "data_review": [
        ["metric movement", "指标变化", "数据变化"],
        ["likely cause", "可能原因", "原因"],
        ["decision", "结论", "决策"],
        ["owner", "负责人", "action", "动作"],
        ["stop rule", "止损"],
        ["scale rule", "放量"],
        ["next review", "下次复盘", "next week", "下周"],
    ],
}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def contains_any(text: str, terms: list[str]) -> bool:
    text_lower = text.lower()
    return any(term.lower() in text_lower for term in terms)


def term_occurrences(text: str, terms: list[str]) -> list[tuple[str, int]]:
    hits: list[tuple[str, int]] = []
    text_lower = text.lower()
    for term in terms:
        term_lower = term.lower()
        start = 0
        while True:
            idx = text_lower.find(term_lower, start)
            if idx < 0:
                break
            hits.append((term, idx))
            start = idx + len(term_lower)
    return hits


def is_negated_context(text: str, idx: int) -> bool:
    window = text[max(0, idx - 24): idx + 12].lower()
    return any(term.lower() in window for term in NEGATION_TERMS)


def add_finding(findings: list[dict[str, Any]], severity: str, code: str, message: str) -> None:
    findings.append({"severity": severity, "code": code, "message": message})


def load_case_modes(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    cases = payload.get("cases", [])
    if not isinstance(cases, list):
        raise ValueError("cases must be a list")
    modes: dict[str, str] = {}
    for case in cases:
        if isinstance(case, dict) and isinstance(case.get("id"), str):
            mode = case.get("output_mode")
            if isinstance(mode, str):
                modes[case["id"]] = mode
    return modes


def mode_from_source(source: str | None, case_modes: dict[str, str] | None) -> str | None:
    if not source or not case_modes:
        return None
    case_id = Path(source).stem
    return case_modes.get(case_id)


def lint_required_groups(findings: list[dict[str, Any]], text: str, mode: str) -> None:
    required_groups = MODE_REQUIRED_GROUPS.get(mode)
    if not required_groups:
        return
    missing = [
        group
        for group in required_groups
        if not contains_any(text, group)
    ]
    for group in missing:
        add_finding(
            findings,
            "error",
            f"{mode}_missing_required_element",
            "Mode-specific required element missing: " + " / ".join(group),
        )


def lint_answer(answer: str, source: str | None = None, mode: str | None = None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    text = answer.strip()
    text_lower = text.lower()

    if not text:
        add_finding(findings, "error", "empty_answer", "Answer is empty.")
        return {"source": source, "passed": False, "findings": findings}

    empty_hits = [
        term
        for term, idx in term_occurrences(text, EMPTY_ADVICE_TERMS)
        if not is_negated_context(text, idx)
    ]
    if empty_hits and not contains_any(text, MECHANISM_TERMS):
        add_finding(
            findings,
            "error",
            "empty_advice_without_mechanism",
            "Empty advice phrase found without mechanism, metric, owner, stop/scale rule, or review cadence: "
            + ", ".join(sorted(set(empty_hits))),
        )

    if contains_any(text, SCALE_TERMS):
        if not contains_any(text, ECONOMICS_TERMS):
            add_finding(
                findings,
                "error",
                "scale_without_economics",
                "Scale/budget/live recommendation appears without unit economics or profit terms.",
            )
        if not contains_any(text, STOP_TERMS):
            add_finding(
                findings,
                "error",
                "scale_without_stop_rule",
                "Scale/budget/live recommendation appears without a stop rule.",
            )
        if not contains_any(text, SCALE_RULE_TERMS):
            add_finding(
                findings,
                "error",
                "scale_without_scale_rule",
                "Scale/budget/live recommendation appears without a scale rule.",
            )

    if contains_any(text, TACTIC_TERMS) and not contains_any(text, ECONOMICS_TERMS):
        add_finding(
            findings,
            "warning",
            "tactic_without_economics",
            "Platform tactic appears without economics terms; verify the answer explains why profit still works.",
        )

    if contains_any(text, CURRENT_WORDS) and contains_any(text, PLATFORM_TERMS):
        if not contains_any(text, EVIDENCE_LABELS):
            add_finding(
                findings,
                "error",
                "currentness_without_evidence_label",
                "Platform-current claim appears without an evidence label.",
            )

    decision_terms = ["建议", "不建议", "should", "decision", "结论", "判断"]
    missing_data_terms = ["缺", "missing", "不知道", "只有", "仅知道", "不完整"]
    assumption_terms = ["假设", "assumption", "confirmed facts", "已确认", "条件"]
    if contains_any(text, decision_terms) and contains_any(text, missing_data_terms):
        if not contains_any(text, assumption_terms):
            add_finding(
                findings,
                "error",
                "missing_data_without_assumptions",
                "Decision with missing data should separate confirmed facts, assumptions, and conditions.",
            )

    if "roi" in text_lower and not contains_any(text, ["break-even", "盈亏平衡", "毛利roi", "gross-profit roi"]):
        add_finding(
            findings,
            "warning",
            "roi_without_break_even_context",
            "ROI is mentioned without break-even or gross-profit ROI context.",
        )

    if mode:
        lint_required_groups(findings, text, mode)

    passed = not any(finding["severity"] == "error" for finding in findings)
    return {"source": source, "mode": mode, "passed": passed, "findings": findings}


def lint_answer_dir(answer_dir: Path, case_modes: dict[str, str] | None = None, mode: str | None = None) -> dict[str, Any]:
    files = sorted(answer_dir.glob("*.txt"))
    if not files:
        return {
            "answer_dir": str(answer_dir),
            "passed": False,
            "findings": [
                {
                    "severity": "error",
                    "code": "missing_answer_files",
                    "message": "No .txt answer files found.",
                }
            ],
            "answers": [],
        }
    answers = [
        lint_answer(
            path.read_text(encoding="utf-8"),
            str(path),
            mode or mode_from_source(str(path), case_modes),
        )
        for path in files
    ]
    return {
        "answer_dir": str(answer_dir),
        "passed": all(answer["passed"] for answer in answers),
        "answers": answers,
    }


def self_test() -> None:
    positive = """
    Decision: 不建议直接翻倍预算。
    Confirmed facts: ROI 2.0, gross margin 55%.
    Assumptions: fulfillment and refund remain stable next week.
    Economics: channel net profit and break-even ROI must be checked before scale.
    Risk: marginal traffic, refund loss, and price-channel conflict can break profit.
    Stop rule: pause if marginal ROI stays below break-even or refund rises.
    Scale rule: add budget only after payment CVR and refund loss stabilize.
    Currentness:
    - Stable operating principle: budget follows contribution profit.
    - Needs current verification: exact Qianchuan backend product name and report field.
    """
    negative = "现在聚光还能做竞品词，建议加大投放、提高转化率、冲GMV。"
    positive_result = lint_answer(positive, "positive", mode="decision_memo")
    negative_result = lint_answer(negative, "negative", mode="decision_memo")
    if not positive_result["passed"]:
        raise AssertionError(f"positive self-test should pass: {positive_result}")
    if negative_result["passed"]:
        raise AssertionError(f"negative self-test should fail: {negative_result}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Lint commerce-growth-os saved answers.")
    parser.add_argument("--answer", help="Path to one answer text file")
    parser.add_argument("--answer-dir", help="Directory containing .txt answer files")
    parser.add_argument("--mode", choices=sorted(MODE_REQUIRED_GROUPS), help="Apply one output-mode gate")
    parser.add_argument("--cases", default=str(DEFAULT_CASES), help="Cases JSON used to infer modes for --answer-dir")
    parser.add_argument("--self-test", action="store_true", help="Run linter self-test")
    parser.add_argument("--json", action="store_true", help="Print JSON result")
    args = parser.parse_args()

    try:
        if args.self_test:
            self_test()
            print("commerce-growth-os answer linter self-test passed.")
            return 0
        case_modes = load_case_modes(Path(args.cases)) if args.cases else None
        if args.answer:
            path = Path(args.answer)
            result = lint_answer(
                path.read_text(encoding="utf-8"),
                str(path),
                args.mode or mode_from_source(str(path), case_modes),
            )
        elif args.answer_dir:
            result = lint_answer_dir(Path(args.answer_dir), case_modes, args.mode)
        else:
            result = {"passed": True, "message": "use --answer, --answer-dir, or --self-test"}

        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            print("commerce-growth-os answer lint passed." if result["passed"] else "commerce-growth-os answer lint failed.")
            for finding in result.get("findings", []):
                print(f"{finding['severity']}: {finding['code']}: {finding['message']}")
            for answer in result.get("answers", []):
                for finding in answer.get("findings", []):
                    print(f"{answer['source']}: {finding['severity']}: {finding['code']}: {finding['message']}")
        return 0 if result["passed"] else 1
    except Exception as exc:  # noqa: BLE001 - CLI should report clean errors.
        print(f"lint_answer error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
