#!/usr/bin/env python3
"""Authenticated loopback wrapper for the pi-67 Hy-Memory integration."""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import enum
import hashlib
import hmac
import json
import logging
import logging.handlers
import os
import re
import signal
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse


SDK_VERSION = "1.2.20"
SERVICE_SCHEMA = "pi67-hy-memory-service/v1"
OUTBOX_SCHEMA = "pi67-hy-memory-outbox/v1"
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_CAPTURE_CHARS = 12_000
MEMORY_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,256}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="pi-67 authenticated Hy-Memory loopback service")
    parser.add_argument("--root", required=True, help="Hy-Memory pi-67 state root")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 asks the OS for a free port")
    return parser.parse_args()


def read_json_object(file: Path) -> Dict[str, Any]:
    value = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{file} must contain a JSON object")
    return value


def write_json_atomic(file: Path, value: Dict[str, Any], mode: int = 0o600) -> None:
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = file.with_name(f".{file.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), default=json_default)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, file)
        try:
            os.chmod(file, mode)
        except OSError:
            pass
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def json_default(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    if isinstance(value, enum.Enum):
        return value.value
    if hasattr(value, "to_dict") and callable(value.to_dict):
        return value.to_dict()
    return str(value)


def configure_logging(root: Path) -> None:
    logs = root / "logs"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    handler = logging.handlers.RotatingFileHandler(
        logs / "service.log", maxBytes=2 * 1024 * 1024, backupCount=2, encoding="utf-8"
    )
    handler.setLevel(logging.WARNING)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.WARNING)
    logging.disable(logging.INFO)


def secret(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"required secret environment variable {name} is missing")
    return value


def startup_trace(stage: str) -> None:
    if os.environ.get("PI67_HY_MEMORY_TEST_STARTUP_TRACE") == "1":
        print(f"pi67-hy-memory-startup:{stage}", file=sys.stderr, flush=True)


def safe_error(error: BaseException, known_secrets: List[str]) -> str:
    text = f"{type(error).__name__}: {error}"
    for value in known_secrets:
        if value:
            text = text.replace(value, "[REDACTED]")
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", "[REDACTED]", text)
    text = re.sub(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/-]{12,}", r"\1[REDACTED]", text)
    return re.sub(r"\s+", " ", text).strip()[:500]


def redact_text(value: str) -> str:
    value = re.sub(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{12,}", "Bearer [REDACTED]", value)
    value = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", "[REDACTED API KEY]", value)
    value = re.sub(
        r"(?im)^(\s*(?:Authorization|Cookie|Set-Cookie)\s*:\s*)[^\r\n]+$",
        r"\1[REDACTED]",
        value,
    )
    value = re.sub(
        r"(?i)([\"']?(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)[\"']?\s*[:=]\s*[\"'])[^\"'\r\n]{4,}([\"'])",
        r"\1[REDACTED]\2",
        value,
    )
    return re.sub(
        r"(?i)([?&](?:access_token|api_key|apikey|token|key|signature|sig)=)[^&#\s]+",
        r"\1[REDACTED]",
        value,
    )


class StatePaths:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.config_file = self.root / "config.json"
        self.data_dir = self.root / "data"
        self.runtime_dir = self.root / "runtime"
        self.service_file = self.runtime_dir / "service.json"
        self.outbox_dir = self.root / "outbox"
        self.pending_dir = self.outbox_dir / "pending"
        self.processing_dir = self.outbox_dir / "processing"
        self.dead_letter_dir = self.outbox_dir / "dead-letter"

    def ensure(self) -> None:
        for directory in (
            self.root,
            self.data_dir,
            self.runtime_dir,
            self.pending_dir,
            self.processing_dir,
            self.dead_letter_dir,
            self.root / "logs",
        ):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)


def validate_config(config: Dict[str, Any]) -> None:
    if config.get("schema") != "pi67-hy-memory-config/v1":
        raise ValueError("unsupported config schema")
    if config.get("mode") != "pro":
        raise ValueError("only pro mode is allowed for the persistent service")
    if not isinstance(config.get("userId"), str) or not config["userId"].strip():
        raise ValueError("userId is required")
    if not isinstance(config.get("agentId"), str) or not config["agentId"].strip():
        raise ValueError("agentId is required")
    llm = config.get("llm") or {}
    embedder = config.get("embedder") or {}
    if (
        llm.get("provider") != "openai"
        or llm.get("baseUrl") != "https://api.deepseek.com"
        or llm.get("model") != "deepseek-v4-flash"
    ):
        raise ValueError("LLM contract is not canonical")
    if (
        embedder.get("provider") != "openai"
        or embedder.get("baseUrl") != "https://api.siliconflow.cn/v1"
        or embedder.get("model") != "BAAI/bge-m3"
        or embedder.get("requestDimensions", "invalid") is not None
        or embedder.get("vectorDimensions") != 1024
    ):
        raise ValueError("BGE-M3 embedding contract is not canonical")


def create_memory_config(config: Dict[str, Any], paths: StatePaths, llm_key: str, embed_key: str) -> Any:
    from hy_memory import MemoryConfig

    embedder = config["embedder"]
    llm = config["llm"]
    return MemoryConfig.from_dict(
        {
            "vector_store": {
                "provider": "chroma",
                "collection_name": "pi67_memories_bge_m3_1024",
                "persist_directory": str(paths.data_dir / "vector_db"),
                "embedding_dims": 1024,
            },
            "cache": {"backend": "sqlite", "db_path": str(paths.data_dir / "cache.db")},
            "history": {
                "enable": True,
                "db_path": str(paths.data_dir / "history.db"),
                "record_searches": False,
            },
            "graph_store": {"provider": "kuzu", "db_path": str(paths.data_dir / "kuzu_db")},
            "llm": {
                "provider": "openai",
                "base_url": llm["baseUrl"],
                "model": llm["model"],
                "api_key": llm_key,
                "temperature": 0.1,
                "max_retries": 3,
                "timeout": 180,
            },
            "embedder": {
                "provider": "openai",
                "base_url": embedder["baseUrl"],
                "model": embedder["model"],
                "api_key": embed_key,
                # SiliconFlow BGE-M3 rejects the dimensions request parameter.
                "embedding_dims": None,
                "max_retries": 3,
                "timeout": 60,
            },
            "recall": {"default_limit": 5, "min_score_threshold": 0.3},
            "enable_graph": False,
            "enable_agent": True,
            "debug": False,
            "metrics_enabled": False,
        }
    )


class ClientHolder:
    def __init__(self, memory_config: Any, config: Dict[str, Any]):
        self._memory_config = memory_config
        self._config = config
        self._lock = threading.RLock()
        self._client = self._new_client("pro")

    def _new_client(self, mode: str) -> Any:
        from hy_memory import HyMemoryClient

        return HyMemoryClient(config=self._memory_config, mode=mode)

    def close(self) -> None:
        with self._lock:
            if self._client is not None:
                self._client.close()
                self._client = None

    def info(self) -> Dict[str, Any]:
        return {"mode": "pro", "vectorDimensions": int(self._memory_config.vector_store.embedding_dims)}

    def probe(self) -> Dict[str, Any]:
        with self._lock:
            embedding = self._client._loop_thread.run(self._client._embed_service.embed("pi-67 dimension probe"))
        vector = embedding.tolist() if hasattr(embedding, "tolist") else list(embedding)
        return {
            "success": True,
            "sdkVersion": SDK_VERSION,
            "vectorDimensions": len(vector),
            "finite": all(isinstance(value, (int, float)) and value == value for value in vector),
        }

    def search(self, body: Dict[str, Any]) -> Dict[str, Any]:
        query = required_text(body.get("query"), "query", MAX_CAPTURE_CHARS)
        recall = self._config["recall"]
        with self._lock:
            return self._client.search(
                query,
                scene="normal",
                user_ids=[self._config["userId"]],
                agent_ids=[self._config["agentId"]],
                limit=clamp_int(body.get("limit"), 1, 20, recall["topK"]),
                min_score=clamp_float(body.get("minScore"), 0.0, 1.0, recall["minScore"]),
                profile_limit=clamp_int(body.get("profileLimit"), 0, 20, recall["profileLimit"]),
                profile_min_score=clamp_float(
                    body.get("profileMinScore"), 0.0, 1.0, recall["profileMinScore"]
                ),
                intention_limit=clamp_int(body.get("intentionLimit"), 0, 20, recall["intentionLimit"]),
            )

    def capture(self, messages: List[Dict[str, str]], session_id: str, request_id: str) -> Dict[str, Any]:
        with self._lock:
            return self._client.add(
                messages,
                user_id=self._config["userId"],
                agent_id=self._config["agentId"],
                session_id=session_id,
                metadata={"source": "pi-67", "capture": "settled-turn"},
                request_id=request_id,
                extract_scene="chat",
            )

    def list_memories(self, limit: int, offset: int) -> Dict[str, Any]:
        with self._lock:
            return self._client.list_memories(
                user_id=self._config["userId"],
                agent_id=self._config["agentId"],
                limit=limit,
                offset=offset,
                order="desc",
            )

    def get(self, memory_id: str) -> Dict[str, Any]:
        with self._lock:
            value = self._client.get(memory_id)
        return {"memory": value}

    def forget(self, memory_id: str) -> Dict[str, Any]:
        with self._lock:
            return self._client.delete(memory_id)

    def digest(self) -> Dict[str, Any]:
        with self._lock:
            self._client.close()
            self._client = None
            ultra = None
            try:
                ultra = self._new_client("ultra")
                return ultra.digest(user_id=self._config["userId"], agent_id=self._config["agentId"])
            finally:
                if ultra is not None:
                    ultra.close()
                self._client = self._new_client("pro")


def required_text(value: Any, label: str, max_chars: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    text = value.strip()
    if len(text) > max_chars:
        raise ValueError(f"{label} exceeds {max_chars} characters")
    return text


def clamp_int(value: Any, minimum: int, maximum: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)
    return max(minimum, min(maximum, parsed))


def clamp_float(value: Any, minimum: float, maximum: float, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = float(default)
    return max(minimum, min(maximum, parsed))


def normalize_messages(value: Any) -> List[Dict[str, str]]:
    if not isinstance(value, list) or not value or len(value) > 20:
        raise ValueError("messages must be a non-empty list with at most 20 entries")
    messages: List[Dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
            raise ValueError("messages may contain only user/assistant text")
        content = required_text(item.get("content"), "message content", MAX_CAPTURE_CHARS)
        messages.append({"role": item["role"], "content": redact_text(content)})
    return messages


class OutboxProcessor:
    def __init__(self, paths: StatePaths, config: Dict[str, Any], holder: ClientHolder):
        self.paths = paths
        self.config = config
        self.holder = holder
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.force_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name="pi67-hy-memory-outbox", daemon=True)
        self._restore_processing()

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        self.thread.join(timeout=5)

    def counts(self) -> Dict[str, int]:
        return {
            "pending": self._count(self.paths.pending_dir),
            "processing": self._count(self.paths.processing_dir),
            "deadLetter": self._count(self.paths.dead_letter_dir),
        }

    def flush(self, timeout: float = 175.0) -> Dict[str, Any]:
        self.force_event.set()
        self.wake_event.set()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            counts = self.counts()
            if counts["pending"] == 0 and counts["processing"] == 0:
                return {"success": True, "outbox": counts}
            time.sleep(0.1)
        return {"success": False, "error": "outbox flush timed out", "outbox": self.counts()}

    @staticmethod
    def _count(directory: Path) -> int:
        try:
            return sum(1 for file in directory.iterdir() if file.is_file() and file.suffix == ".json")
        except FileNotFoundError:
            return 0

    def _restore_processing(self) -> None:
        for file in self.paths.processing_dir.glob("*.json"):
            target = self.paths.pending_dir / file.name
            try:
                os.replace(file, target)
            except OSError:
                logging.getLogger(__name__).warning("could not recover one interrupted outbox job")

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self._drain(force=self.force_event.is_set())
            except Exception as error:
                logging.getLogger(__name__).warning(
                    "outbox drain failed: error=%s", type(error).__name__
                )
            self.force_event.clear()
            self.wake_event.wait(timeout=2.0)
            self.wake_event.clear()

    def _drain(self, force: bool) -> None:
        while not self.stop_event.is_set():
            jobs = self._pending_jobs()
            if not jobs:
                return
            grouped: Dict[Tuple[str, str, str], List[Tuple[Path, Dict[str, Any]]]] = {}
            for file, job in jobs:
                key = (str(job.get("userId", "")), str(job.get("agentId", "")), str(job.get("sessionId", "")))
                grouped.setdefault(key, []).append((file, job))

            processed = False
            now = time.time()
            batch_turns = clamp_int(self.config["capture"].get("batchTurns"), 1, 20, 5)
            max_delay = clamp_int(self.config["capture"].get("maxDelayMs"), 1_000, 3_600_000, 60_000) / 1000.0
            for key, group in grouped.items():
                oldest = min(parse_time(job.get("createdAt")) for _, job in group)
                is_retry = any(int(job.get("attempts", 0)) > 0 for _, job in group)
                if not force and not is_retry and len(group) < batch_turns and now - oldest < max_delay:
                    continue
                self._process_batch(key, group[:batch_turns] if not force else group[:20])
                processed = True
            if not processed:
                return

    def _pending_jobs(self) -> List[Tuple[Path, Dict[str, Any]]]:
        result: List[Tuple[Path, Dict[str, Any]]] = []
        now = time.time()
        for file in sorted(self.paths.pending_dir.glob("*.json"), key=lambda item: item.name):
            try:
                job = read_json_object(file)
                if job.get("schema") != OUTBOX_SCHEMA or job.get("requestId") != file.stem:
                    raise ValueError("outbox schema/request ID mismatch")
                normalize_messages(job.get("messages"))
                if parse_time(job.get("nextAttemptAt")) > now:
                    continue
                result.append((file, job))
            except Exception as error:
                self._dead_letter_invalid(file, error)
        return result

    def _process_batch(
        self,
        key: Tuple[str, str, str],
        batch: List[Tuple[Path, Dict[str, Any]]],
    ) -> None:
        user_id, agent_id, session_id = key
        if user_id != self.config["userId"] or agent_id != self.config["agentId"] or not session_id:
            for file, _ in batch:
                self._dead_letter_invalid(file, ValueError("outbox identity is invalid"))
            return

        processing: List[Tuple[Path, Dict[str, Any]]] = []
        for file, job in batch:
            target = self.paths.processing_dir / file.name
            try:
                os.replace(file, target)
                processing.append((target, job))
            except FileNotFoundError:
                continue
        if not processing:
            return

        messages: List[Dict[str, str]] = []
        request_ids: List[str] = []
        for _, job in processing:
            messages.extend(normalize_messages(job["messages"]))
            request_ids.append(job["requestId"])
        batch_request_id = hashlib.sha256("\0".join(sorted(request_ids)).encode("utf-8")).hexdigest()

        try:
            result = self.holder.capture(messages, session_id, batch_request_id)
            if not isinstance(result, dict) or result.get("success") is False:
                raise RuntimeError("Hy-Memory capture did not report success")
            for file, _ in processing:
                file.unlink(missing_ok=True)
        except Exception as error:
            for file, job in processing:
                self._retry_or_dead_letter(file, job, error)

    def _retry_or_dead_letter(self, file: Path, job: Dict[str, Any], error: BaseException) -> None:
        attempts = int(job.get("attempts", 0)) + 1
        job["attempts"] = attempts
        now = dt.datetime.now(dt.timezone.utc)
        job["updatedAt"] = now.isoformat()
        sensitive_values = [
            str(message.get("content", ""))
            for message in job.get("messages", [])
            if isinstance(message, dict) and message.get("content")
        ]
        job["lastError"] = safe_error(error, sensitive_values)
        max_attempts = clamp_int(self.config["capture"].get("maxAttempts"), 1, 20, 5)
        if attempts >= max_attempts:
            job.pop("nextAttemptAt", None)
            destination = self.paths.dead_letter_dir
        else:
            delay_seconds = min(300, 5 * (2 ** (attempts - 1)))
            job["nextAttemptAt"] = (now + dt.timedelta(seconds=delay_seconds)).isoformat()
            destination = self.paths.pending_dir
        target = destination / file.name
        write_json_atomic(target, job)
        file.unlink(missing_ok=True)

    def _dead_letter_invalid(self, file: Path, error: BaseException) -> None:
        target = self.paths.dead_letter_dir / file.name
        try:
            value = read_json_object(file)
        except Exception:
            value = {"schema": OUTBOX_SCHEMA, "requestId": file.stem}
        value["lastError"] = safe_error(error, [])
        value["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_json_atomic(target, value)
        file.unlink(missing_ok=True)


def parse_time(value: Any) -> float:
    if not isinstance(value, str):
        return 0.0
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class ServiceState:
    def __init__(
        self,
        paths: StatePaths,
        config: Dict[str, Any],
        token: str,
        holder: ClientHolder,
        processor: OutboxProcessor,
        known_secrets: List[str],
    ):
        self.paths = paths
        self.config = config
        self.token = token
        self.holder = holder
        self.processor = processor
        self.known_secrets = known_secrets
        self.instance_id = uuid.uuid4().hex
        self.server: Optional[ThreadingHTTPServer] = None


def make_handler(state: ServiceState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "pi67-hy-memory"
        sys_version = ""

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self._json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "CORS is not enabled"})

        def _dispatch(self, method: str) -> None:
            try:
                self._validate_transport()
                parsed = urlparse(self.path)
                if method == "GET" and parsed.path == "/v1/info":
                    self._json(HTTPStatus.OK, self._info())
                    return
                if method == "POST" and parsed.path == "/v1/probe":
                    self._json(HTTPStatus.OK, state.holder.probe())
                    return
                if method == "POST" and parsed.path == "/v1/search":
                    self._json(HTTPStatus.OK, state.holder.search(self._body()))
                    return
                if method == "POST" and parsed.path == "/v1/capture":
                    body = self._body()
                    messages = normalize_messages(body.get("messages"))
                    session_id = required_text(body.get("sessionId"), "sessionId", 256)
                    request_id = body.get("requestId")
                    if not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{64}", request_id):
                        request_id = hashlib.sha256(
                            json.dumps([session_id, messages], ensure_ascii=False, sort_keys=True).encode("utf-8")
                        ).hexdigest()
                    self._json(HTTPStatus.OK, state.holder.capture(messages, session_id, request_id))
                    return
                if method == "POST" and parsed.path == "/v1/flush":
                    self._body()
                    self._json(HTTPStatus.OK, state.processor.flush())
                    return
                if method == "GET" and parsed.path == "/v1/memories":
                    query = parse_qs(parsed.query)
                    limit = clamp_int(first(query.get("limit")), 1, 100, 20)
                    offset = clamp_int(first(query.get("offset")), 0, 1_000_000, 0)
                    self._json(HTTPStatus.OK, state.holder.list_memories(limit, offset))
                    return
                if method == "GET" and parsed.path.startswith("/v1/memories/"):
                    memory_id = unquote(parsed.path[len("/v1/memories/") :])
                    if not MEMORY_ID_PATTERN.fullmatch(memory_id):
                        raise ValueError("memory ID is invalid")
                    self._json(HTTPStatus.OK, state.holder.get(memory_id))
                    return
                if method == "DELETE" and parsed.path.startswith("/v1/memories/"):
                    memory_id = unquote(parsed.path[len("/v1/memories/") :])
                    if not MEMORY_ID_PATTERN.fullmatch(memory_id):
                        raise ValueError("memory ID is invalid")
                    self._json(HTTPStatus.OK, state.holder.forget(memory_id))
                    return
                if method == "POST" and parsed.path == "/v1/digest":
                    self._body()
                    self._json(HTTPStatus.OK, state.holder.digest())
                    return
                if method == "POST" and parsed.path == "/v1/shutdown":
                    self._body()
                    self._json(HTTPStatus.OK, {"success": True})
                    threading.Thread(target=self._shutdown, daemon=True).start()
                    return
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            except PermissionError as error:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": str(error)})
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": safe_error(error, state.known_secrets)})
            except Exception as error:
                logging.getLogger(__name__).warning(
                    "request failed: method=%s path=%s error=%s",
                    method,
                    urlparse(self.path).path,
                    type(error).__name__,
                )
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal server error"})

        def _validate_transport(self) -> None:
            remote = self.client_address[0]
            if remote not in ("127.0.0.1", "::1"):
                raise PermissionError("loopback requests only")
            expected_host = f"127.0.0.1:{state.server.server_port if state.server else 0}"
            if self.headers.get("Host", "") != expected_host:
                raise PermissionError("invalid Host header")
            authorization = self.headers.get("Authorization", "")
            expected = f"Bearer {state.token}"
            if not hmac.compare_digest(authorization, expected):
                raise PermissionError("invalid bearer token")

        def _body(self) -> Dict[str, Any]:
            raw_length = self.headers.get("Content-Length")
            if raw_length is None:
                return {}
            try:
                length = int(raw_length)
            except ValueError as error:
                raise ValueError("invalid Content-Length") from error
            if length < 0 or length > MAX_REQUEST_BYTES:
                raise ValueError(f"request body exceeds {MAX_REQUEST_BYTES} bytes")
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if length > 0 and content_type != "application/json":
                raise ValueError("Content-Type must be application/json")
            raw = self.rfile.read(length)
            if not raw:
                return {}
            value = json.loads(raw.decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("request body must be a JSON object")
            return value

        def _info(self) -> Dict[str, Any]:
            holder_info = state.holder.info()
            return {
                "schema": SERVICE_SCHEMA,
                "instanceId": state.instance_id,
                "pid": os.getpid(),
                "root": str(state.paths.root),
                "dataDir": str(state.paths.data_dir),
                "sdkVersion": SDK_VERSION,
                "mode": holder_info["mode"],
                "vectorDimensions": holder_info["vectorDimensions"],
                "outbox": state.processor.counts(),
            }

        def _json(self, status: HTTPStatus, value: Dict[str, Any]) -> None:
            raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=json_default).encode("utf-8")
            if len(raw) > MAX_RESPONSE_BYTES:
                status = HTTPStatus.INTERNAL_SERVER_ERROR
                raw = b'{"error":"response exceeded the size limit"}'
            self.send_response(status.value)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        @staticmethod
        def _shutdown() -> None:
            if state.server is not None:
                state.server.shutdown()

    return Handler


def first(values: Optional[List[str]]) -> Optional[str]:
    return values[0] if values else None


def service_record(state: ServiceState, server: ThreadingHTTPServer) -> Dict[str, Any]:
    return {
        "schema": SERVICE_SCHEMA,
        "pid": os.getpid(),
        "port": server.server_port,
        "instanceId": state.instance_id,
        "root": str(state.paths.root),
        "dataDir": str(state.paths.data_dir),
        "sdkVersion": SDK_VERSION,
        "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def remove_own_service_record(state: ServiceState) -> None:
    try:
        record = read_json_object(state.paths.service_file)
        if record.get("instanceId") == state.instance_id and record.get("pid") == os.getpid():
            state.paths.service_file.unlink(missing_ok=True)
    except Exception:
        pass


def main() -> int:
    startup_trace("begin")
    args = parse_args()
    paths = StatePaths(Path(args.root))
    paths.ensure()
    startup_trace("paths-ready")
    configure_logging(paths.root)
    startup_trace("logging-ready")

    bearer_token = secret("PI67_HY_MEMORY_SERVICE_TOKEN")
    llm_key = secret("PI67_HY_MEMORY_LLM_API_KEY")
    embed_key = secret("PI67_HY_MEMORY_EMBEDDING_API_KEY")
    config = read_json_object(paths.config_file)
    validate_config(config)
    startup_trace("config-ready")

    import hy_memory

    actual_sdk_version = getattr(hy_memory, "__version__", "")
    if actual_sdk_version != SDK_VERSION:
        raise RuntimeError(f"Hy-Memory SDK version mismatch: expected {SDK_VERSION}, got {actual_sdk_version}")
    startup_trace("sdk-ready")

    memory_config = create_memory_config(config, paths, llm_key, embed_key)
    holder = ClientHolder(memory_config, config)
    processor = OutboxProcessor(paths, config, holder)
    state = ServiceState(paths, config, bearer_token, holder, processor, [bearer_token, llm_key, embed_key])
    startup_trace("client-ready")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(state))
    server.daemon_threads = True
    state.server = server
    startup_trace("server-ready")

    def request_shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    write_json_atomic(paths.service_file, service_record(state, server))
    startup_trace("metadata-ready")
    processor.start()
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        processor.stop()
        server.server_close()
        holder.close()
        remove_own_service_record(state)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # Startup errors go only to the warning log; stdout/stderr may be detached.
        logging.getLogger(__name__).critical("service startup failed: %s", safe_error(error, []))
        raise
