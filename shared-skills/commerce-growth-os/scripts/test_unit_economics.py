#!/usr/bin/env python3
"""Regression tests for the commerce unit-economics calculator."""

from __future__ import annotations

from unit_economics import calculate


def assert_close(actual: float | None, expected: float, *, tolerance: float = 0.00001) -> None:
    if actual is None or abs(actual - expected) > tolerance:
        raise AssertionError(f"expected {expected}, got {actual}")


def assert_raises(message: str, func) -> None:
    try:
        func()
    except Exception as exc:  # noqa: BLE001 - small CLI-style regression runner.
        if message not in str(exc):
            raise AssertionError(f"expected error containing {message!r}, got {exc!r}") from exc
        return
    raise AssertionError(f"expected error containing {message!r}")


def test_qianchuan_budget_case() -> None:
    result = calculate(
        {
            "gmv": 300000,
            "ad_spend": 150000,
            "gross_margin_rate": 55,
            "gift_cost_rate": 6,
            "fulfillment_cost_rate": 6,
            "refund_loss_rate": 6,
        }
    )
    metrics = result["metrics"]
    assert_close(metrics["roi"], 2.0)
    assert_close(metrics["break_even_roi"], 2.702703)
    assert_close(metrics["channel_net_profit"], -39000.0)


def test_talent_booking_case() -> None:
    result = calculate(
        {
            "gmv": 400000,
            "product_cost_rate": 32,
            "platform_fee_rate": 5,
            "creator_commission_rate": 25,
            "pit_fee": 50000,
            "gift_cost_rate": 8,
            "fulfillment_cost_rate": 4,
            "refund_loss_rate": 7,
            "ad_spend": 0,
            "orders": 2000,
        }
    )
    metrics = result["metrics"]
    assert_close(metrics["channel_net_profit"], 26000.0)
    assert_close(metrics["allowable_cac"], 88.0)
    assert_close(metrics["max_creator_commission_rate"], 0.315)


def test_strict_mode_rejects_missing_inputs() -> None:
    assert_raises(
        "strict mode missing required inputs",
        lambda: calculate({"gmv": 100000, "gross_margin_rate": 50}, strict=True),
    )


def test_invalid_rate_rejected() -> None:
    assert_raises(
        "must be a rate between 0 and 1",
        lambda: calculate({"gmv": 100000, "gross_margin_rate": 150}),
    )


def test_sensitivity_output() -> None:
    result = calculate(
        {
            "gmv": 400000,
            "product_cost_rate": 32,
            "platform_fee_rate": 5,
            "creator_commission_rate": 25,
            "pit_fee": 50000,
            "gift_cost_rate": 8,
            "fulfillment_cost_rate": 4,
            "refund_loss_rate": 7,
            "ad_spend": 0,
            "orders": 2000,
        },
        sensitivity=True,
    )
    sensitivity = result["sensitivity"]
    for key in [
        "refund_loss_rate_plus_3pt",
        "refund_loss_rate_plus_5pt",
        "creator_commission_rate_plus_5pt",
        "gmv_minus_10pct_same_spend",
        "gmv_minus_20pct_same_spend",
    ]:
        if key not in sensitivity:
            raise AssertionError(f"missing sensitivity scenario: {key}")


def main() -> int:
    tests = [
        test_qianchuan_budget_case,
        test_talent_booking_case,
        test_strict_mode_rejects_missing_inputs,
        test_invalid_rate_rejected,
        test_sensitivity_output,
    ]
    for test in tests:
        test()
    print("unit_economics regression tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
