#!/usr/bin/env python3
"""Write a content-bounded inventory for an isolated Hy-Memory Python runtime."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path


SCHEMA = "pi67.hy-memory-python-runtime.v1"


def normalize_name(value: str) -> str:
    return "-".join(filter(None, value.lower().replace("_", "-").replace(".", "-").split("-")))


def distributions() -> list[dict[str, str]]:
    found: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        name = normalize_name(distribution.metadata.get("Name", ""))
        version = str(distribution.version or "").strip()
        if not name or not version:
            raise RuntimeError("installed distribution has missing name or version")
        if name in found and found[name] != version:
            raise RuntimeError(f"installed distribution is duplicated with conflicting versions: {name}")
        found[name] = version
    return [{"name": name, "version": found[name]} for name in sorted(found)]


def closure_sha256(items: list[dict[str, str]]) -> str:
    encoded = "".join(f"{item['name']}=={item['version']}\n" for item in items).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def atomic_write_json(destination: Path, value: dict[str, object]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--lock-id", required=True)
    parser.add_argument("--lock-target", required=True)
    parser.add_argument("--lock-sha256", required=True)
    parser.add_argument("--installer-kind", required=True, choices=("uv", "pip"))
    parser.add_argument("--installer-version", required=True)
    parser.add_argument("--hy-memory-wheel-sha256", required=True)
    arguments = parser.parse_args()

    items = distributions()
    by_name = {item["name"]: item["version"] for item in items}
    value: dict[str, object] = {
        "schema": SCHEMA,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "lock": {
            "id": arguments.lock_id,
            "target": arguments.lock_target,
            "sha256": arguments.lock_sha256,
        },
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "platform": sys.platform,
            "machine": platform.machine(),
            "libc": list(platform.libc_ver()),
        },
        "installer": {
            "kind": arguments.installer_kind,
            "version": arguments.installer_version,
        },
        "policy": {
            "requireHashes": True,
            "onlyBinary": True,
        },
        "distributions": items,
        "distributionCount": len(items),
        "closureSha256": closure_sha256(items),
        "hyMemory": {
            "version": by_name.get("hy-memory"),
            "wheelSha256": arguments.hy_memory_wheel_sha256,
        },
    }
    atomic_write_json(Path(arguments.output), value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
