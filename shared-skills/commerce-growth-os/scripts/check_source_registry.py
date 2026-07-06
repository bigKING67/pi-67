#!/usr/bin/env python3
"""Validate official-source registry entries without caching platform facts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = ROOT / "references" / "currentness-official-sources.md"

ALLOWED_DOMAIN_SUFFIXES = [
    "oceanengine.com",
    "jinritemai.com",
    "xingtu.cn",
    "alimama.com",
    "xiaohongshu.com",
    "jd.com",
    "pinduoduo.com",
    "yangkeduo.com",
    "kuaishou.com",
    "kwaixiaodian.com",
    "weixin.qq.com",
]

URL_RE = re.compile(r"https://[^\s`|,)]+")


def domain_allowed(hostname: str) -> bool:
    return any(hostname == suffix or hostname.endswith(f".{suffix}") for suffix in ALLOWED_DOMAIN_SUFFIXES)


def extract_urls(text: str) -> list[str]:
    return URL_RE.findall(text)


def validate_registry(path: Path, minimum_urls: int = 10) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    urls = extract_urls(text)
    findings: list[dict[str, str]] = []

    if len(urls) < minimum_urls:
        findings.append(
            {
                "severity": "error",
                "code": "too_few_urls",
                "message": f"Expected at least {minimum_urls} official URLs, found {len(urls)}.",
            }
        )

    duplicates = sorted({url for url in urls if urls.count(url) > 1})
    for url in duplicates:
        findings.append({"severity": "error", "code": "duplicate_url", "message": url})

    for url in urls:
        parsed = urlparse(url)
        if parsed.scheme != "https":
            findings.append({"severity": "error", "code": "non_https_url", "message": url})
        if not parsed.hostname or not domain_allowed(parsed.hostname):
            findings.append({"severity": "error", "code": "unexpected_domain", "message": url})
        if "utm_" in parsed.query.lower() or "utm_" in parsed.path.lower():
            findings.append({"severity": "error", "code": "tracking_url", "message": url})

    return {
        "path": str(path),
        "passed": not any(finding["severity"] == "error" for finding in findings),
        "url_count": len(urls),
        "urls": urls,
        "findings": findings,
    }


def self_test() -> None:
    good = """
    | Area | Entry |
    | --- | --- |
    | A | `https://www.oceanengine.com/`, `https://school.jinritemai.com/` |
    | B | `https://ad.xiaohongshu.com/`, `https://jzt.jd.com/school/problem` |
    """
    bad = "https://example.com/?utm_campaign=example https://www.oceanengine.com/"
    good_path = ROOT / ".source-registry-good.tmp"
    bad_path = ROOT / ".source-registry-bad.tmp"
    try:
        good_path.write_text(good, encoding="utf-8")
        bad_path.write_text(bad, encoding="utf-8")
        if not validate_registry(good_path, minimum_urls=4)["passed"]:
            raise AssertionError("good sample should pass")
        if validate_registry(bad_path, minimum_urls=1)["passed"]:
            raise AssertionError("bad sample should fail")
        if DEFAULT_REGISTRY.exists() and not validate_registry(DEFAULT_REGISTRY)["passed"]:
            raise AssertionError("default registry should pass")
    finally:
        for path in (good_path, bad_path):
            if path.exists():
                path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate commerce-growth-os official source registry.")
    parser.add_argument("registry", nargs="?", default=str(DEFAULT_REGISTRY), help="Registry markdown path")
    parser.add_argument("--json", action="store_true", help="Print JSON result")
    parser.add_argument("--self-test", action="store_true", help="Run self-test")
    args = parser.parse_args()

    try:
        if args.self_test:
            self_test()
            print("commerce-growth-os source registry checker self-test passed.")
            return 0
        result = validate_registry(Path(args.registry))
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            print("commerce-growth-os source registry check passed." if result["passed"] else "commerce-growth-os source registry check failed.")
            for finding in result["findings"]:
                print(f"{finding['severity']}: {finding['code']}: {finding['message']}")
        return 0 if result["passed"] else 1
    except Exception as exc:  # noqa: BLE001 - CLI should report clean errors.
        print(f"check_source_registry error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
