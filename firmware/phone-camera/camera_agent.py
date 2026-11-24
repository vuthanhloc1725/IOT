#!/usr/bin/env python3
"""Termux smartphone camera node: captures with Termux:API, uploads media over HTTPS.

Online status: an HTTPS heartbeat (POST /api/camera/heartbeat, same Bearer token) every
heartbeat_interval_seconds. The server marks the camera online/offline from it and replies with
its lifecycle; while the camera is in FAULT/MAINTENANCE uploads pause and media stays queued.

MQTT is optional and only used for on-demand commands and status. Media bytes never travel over MQTT.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import signal
import sqlite3
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # MQTT is optional: HTTPS-only nodes do not need paho installed.
    import paho.mqtt.client as mqtt
except ModuleNotFoundError:  # pragma: no cover - depends on the device
    mqtt = None  # type: ignore[assignment]


AGENT_VERSION = "0.4.0"
ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger("phone-camera")
STOP = threading.Event()
MAX_RESPONSE_BYTES = 64 * 1024

# Upload outcomes
STORED, REJECTED, RETRY = "stored", "rejected", "retry"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def heartbeat_url(upload_cfg: dict[str, Any]) -> str:
    """upload.heartbeat_url, or derived from upload.url (.../api/camera/media -> .../api/camera/heartbeat)."""
    explicit = str(upload_cfg.get("heartbeat_url") or "").strip()
    if explicit:
        return explicit
    url = str(upload_cfg.get("url", "")).rstrip("/")
    return (url[: -len("/media")] if url.endswith("/media") else url) + "/heartbeat"


def api_base_url(upload_cfg: dict[str, Any]) -> str:
    """.../api/camera (derived from the heartbeat URL) - base for /commands/poll and /commands/<id>/ack."""
    url = heartbeat_url(upload_cfg).rstrip("/")
    return url[: -len("/heartbeat")] if url.endswith("/heartbeat") else url


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        config = json.load(stream)
    required = ("camera_id", "upload", "capture", "storage")
    missing = [key for key in required if key not in config]
    if missing:
        raise ValueError(f"Missing config sections: {', '.join(missing)}")
    if not str(config["camera_id"]).strip():
        raise ValueError("camera_id must not be empty")
    if int(config["capture"].get("interval_seconds", 0)) < 0:
        raise ValueError("interval_seconds cannot be negative")

    upload = config["upload"]
    parsed = urllib.parse.urlparse(str(upload.get("url", "")))
    if parsed.scheme not in ("https", "http") or not parsed.netloc:
        raise ValueError("upload.url must be an absolute https:// URL")
    if parsed.scheme == "http" and not upload.get("allow_insecure_http", False):
        raise ValueError("upload.url uses http://; use https:// or set upload.allow_insecure_http=true for LAN tests only")
    if not str(upload.get("token", "")).strip() or "REPLACE" in str(upload.get("token")):
        raise ValueError("upload.token is not set")
    hb_url = heartbeat_url(upload)
    hb = urllib.parse.urlparse(hb_url)
    if hb.scheme not in ("https", "http") or not hb.netloc:
        raise ValueError("upload.heartbeat_url must be an absolute URL")
    if hb.scheme == "http" and not upload.get("allow_insecure_http", False):
        raise ValueError("upload.heartbeat_url uses http://; set upload.allow_insecure_http=true for LAN tests only")
    ca_file = upload.get("ca_file")
    if ca_file and not Path(ca_file).expanduser().is_file():
        raise ValueError(f"upload.ca_file not found: {ca_file}")
    return config


# --------------------------------------------------------------------------- HTTP helpers

def encode_multipart(fields: dict[str, str], file_field: str, filename: str, mime: str, data: bytes) -> tuple[bytes, str]:
    """Build a multipart/form-data body without third-party libraries."""
    boundary = f"----phonecam{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n'
            f"Content-Type: application/json; charset=utf-8\r\n\r\n".encode("utf-8")
            + value.encode("utf-8") + b"\r\n"
        )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n".encode("utf-8") + data + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _parse_retry_after(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return max(0.0, float(value))
    except ValueError:
        return 0.0


def classify_response(status: int, body: bytes, retry_after: str | None, expected_sha256: str) -> tuple[str, str, float]:
    """Map an HTTP response to (outcome, detail, retry_after_seconds)."""
    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
        if not isinstance(payload, dict):
            payload = {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = {}
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    reason = str(payload.get("reason") or payload.get("message") or error.get("code") or error.get("message") or "")[:160]

    if 200 <= status < 300:
        server_status = str(payload.get("status", "stored"))
        if server_status in ("stored", "duplicate"):
            server_sha = str(payload.get("sha256", "")).lower()
            if server_sha and server_sha != expected_sha256.lower():
                return RETRY, "server_sha256_mismatch", 0.0
            return STORED, server_status, 0.0
        if server_status == "rejected":
            return REJECTED, reason or "rejected", 0.0
        return RETRY, f"unexpected_server_status:{server_status}", 0.0
    # Permanent: the same request will never succeed, keep the file for inspection.
    if status in (400, 409, 413, 415, 422):
        return REJECTED, f"http_{status}:{reason}".rstrip(":"), 0.0
    # 401/403 (token), 404 (wrong URL), 408, 429, 5xx: retry with backoff.
    return RETRY, f"http_{status}:{reason}".rstrip(":"), _parse_retry_after(retry_after)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: urllib would silently turn the POST into a GET."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


# --------------------------------------------------------------------------- local spool

class Spool:
    """SQLite-backed retry queue; media is kept until the server confirms storage."""

    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.db:
            self.db.execute("""CREATE TABLE IF NOT EXISTS media (
                event_id TEXT PRIMARY KEY, request_id TEXT, media_type TEXT NOT NULL,
                mime_type TEXT NOT NULL, path TEXT NOT NULL, captured_at TEXT NOT NULL,
                size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
                created_at TEXT NOT NULL
            )""")
            self.db.execute("""CREATE TABLE IF NOT EXISTS commands (
                request_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL
            )""")
            columns = {row[1] for row in self.db.execute("PRAGMA table_info(media)")}
            if "attempts" not in columns:
                self.db.execute("ALTER TABLE media ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
            if "last_error" not in columns:
                self.db.execute("ALTER TABLE media ADD COLUMN last_error TEXT")
            # Rows left by the old MQTT-chunk agent are simply uploaded again over HTTPS.
            self.db.execute("UPDATE media SET status='queued' WHERE status='awaiting_server_ack'")

    def add_media(self, item: dict[str, Any]) -> None:
        with self.lock, self.db:
            self.db.execute("""INSERT OR IGNORE INTO media
                (event_id,request_id,media_type,mime_type,path,captured_at,size_bytes,sha256,created_at)
                VALUES (:event_id,:request_id,:media_type,:mime_type,:path,:captured_at,:size_bytes,:sha256,:created_at)""", item)

    def pending(self) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute("SELECT * FROM media WHERE status='queued' ORDER BY created_at, rowid").fetchall()

    def count_pending(self) -> int:
        with self.lock:
            return int(self.db.execute("SELECT COUNT(*) FROM media WHERE status='queued'").fetchone()[0])

    def remove(self, event_id: str) -> str | None:
        """Forget a stored item and return its local path so the caller can delete it."""
        with self.lock, self.db:
            row = self.db.execute("SELECT path FROM media WHERE event_id=?", (event_id,)).fetchone()
            if not row:
                return None
            self.db.execute("DELETE FROM media WHERE event_id=?", (event_id,))
            return str(row["path"])

    def mark_failed(self, event_id: str, error: str) -> None:
        with self.lock, self.db:
            self.db.execute("UPDATE media SET attempts=attempts+1, last_error=? WHERE event_id=?", (error[:300], event_id))

    def mark_rejected(self, event_id: str, error: str) -> None:
        with self.lock, self.db:
            self.db.execute("UPDATE media SET status='rejected', attempts=attempts+1, last_error=? WHERE event_id=?",
                            (error[:300], event_id))

    def trim(self, max_items: int) -> list[str]:
        """Drop the oldest queued items beyond max_items; return their paths."""
        if max_items <= 0:
            return []
        with self.lock, self.db:
            rows = self.db.execute(
                "SELECT event_id, path FROM media WHERE status='queued' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
                (max_items,)).fetchall()
            for row in rows:
                self.db.execute("DELETE FROM media WHERE event_id=?", (row["event_id"],))
            return [str(row["path"]) for row in rows]

    def get_command(self, request_id: str) -> dict[str, Any] | None:
        with self.lock:
            row = self.db.execute("SELECT result_json FROM commands WHERE request_id=?", (request_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_command(self, request_id: str, result: dict[str, Any]) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO commands VALUES (?,?,?)", (request_id, json.dumps(result), utc_now()))


# --------------------------------------------------------------------------- HTTPS uploader

class HttpsUploader:
    def __init__(self, camera_id: str, cfg: dict[str, Any]):
        self.camera_id = camera_id
        self.url = str(cfg["url"])
        self.token = str(cfg["token"]).strip()
        self.timeout = max(5, int(cfg.get("timeout_seconds", 60)))
        ca_file = cfg.get("ca_file") or None
        context = ssl.create_default_context(cafile=str(Path(ca_file).expanduser()) if ca_file else None)
        self.opener = urllib.request.build_opener(_NoRedirect(), urllib.request.HTTPSHandler(context=context))
        self.heartbeat_url = heartbeat_url(cfg)
        self.api_base = api_base_url(cfg)

    def heartbeat(self, status: dict[str, Any]) -> tuple[int, dict[str, Any] | None, str]:
        """POST a JSON heartbeat. Returns (http_status or 0 for network error, server JSON, detail)."""
        body = {"cameraId": self.camera_id, "at": utc_now(), "agentVersion": AGENT_VERSION, **status}
        return self._post_json(self.heartbeat_url, body, min(self.timeout, 20))

    def poll_commands(self, wait_seconds: int) -> tuple[int, dict[str, Any] | None, str]:
        """Long-poll for on-demand commands; the server holds the request up to wait_seconds."""
        return self._post_json(f"{self.api_base}/commands/poll", {"waitSeconds": wait_seconds}, wait_seconds + 15)

    def ack_command(self, request_id: str, result: dict[str, Any]) -> tuple[int, dict[str, Any] | None, str]:
        body = {"success": bool(result.get("success")), "message": result.get("message"), "eventId": result.get("eventId")}
        quoted = urllib.parse.quote(request_id, safe="")
        return self._post_json(f"{self.api_base}/commands/{quoted}/ack", body, min(self.timeout, 20))

    def _post_json(self, url: str, data: dict[str, Any], timeout: float) -> tuple[int, dict[str, Any] | None, str]:
        """POST JSON with the camera token. Returns (http_status or 0 for network error, server JSON, detail)."""
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"phone-camera-agent/{AGENT_VERSION}",
            "X-Camera-Id": self.camera_id,
        })
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES)
                code = response.status
        except urllib.error.HTTPError as exc:
            raw, code = exc.read(MAX_RESPONSE_BYTES), exc.code
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            return 0, None, f"network_error:{getattr(exc, 'reason', exc)}"[:200]
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        if 200 <= code < 300:
            return code, payload, "ok"
        error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        return code, payload, f"http_{code}:{error.get('code') or error.get('message') or ''}".rstrip(":")[:200]

    def upload(self, row: sqlite3.Row | dict[str, Any]) -> tuple[str, str, float]:
        path = Path(row["path"])
        if not path.is_file():
            return REJECTED, "local_media_missing", 0.0
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            return REJECTED, "local_media_corrupted", 0.0
        metadata = {
            "schemaVersion": 2, "cameraId": self.camera_id, "eventId": row["event_id"],
            "requestId": row["request_id"], "mediaType": row["media_type"], "mimeType": row["mime_type"],
            "capturedAt": row["captured_at"], "sizeBytes": len(data), "sha256": row["sha256"],
            "agentVersion": AGENT_VERSION,
        }
        body, content_type = encode_multipart({"metadata": json.dumps(metadata, separators=(",", ":"))},
                                              "file", path.name, row["mime_type"], data)
        request = urllib.request.Request(self.url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self.token}",
            "Content-Type": content_type,
            "Accept": "application/json",
            "User-Agent": f"phone-camera-agent/{AGENT_VERSION}",
            "X-Camera-Id": self.camera_id,
            "Idempotency-Key": row["event_id"],
            "X-Content-SHA256": row["sha256"],
        })
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return classify_response(response.status, response.read(MAX_RESPONSE_BYTES), None, row["sha256"])
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                return RETRY, f"http_{exc.code}_redirect_to:{exc.headers.get('Location', '?')} (fix upload.url)", 0.0
            return classify_response(exc.code, exc.read(MAX_RESPONSE_BYTES), exc.headers.get("Retry-After"), row["sha256"])
        except ssl.SSLCertVerificationError as exc:
            return RETRY, f"tls_verify_failed:{exc.verify_message} (check upload.ca_file / server certificate)", 0.0
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, ssl.SSLCertVerificationError):
                return RETRY, f"tls_verify_failed:{reason.verify_message} (check upload.ca_file / server certificate)", 0.0
            return RETRY, f"network_error:{reason}"[:200], 0.0


# --------------------------------------------------------------------------- agent

class CameraAgent:
    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.camera_id = str(config["camera_id"]).strip()
        upload_cfg = config["upload"]
        storage = Path(config["storage"].get("directory", str(ROOT / "spool"))).expanduser()
        self.media_dir = Path(config["storage"].get("media_directory", str(ROOT / "captures"))).expanduser()
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.max_queue_items = int(config["storage"].get("max_queue_items", 500))
        self.spool = Spool(storage / "camera_queue.sqlite3")
        self.uploader = HttpsUploader(self.camera_id, upload_cfg)
        self.retry_min = max(1, int(upload_cfg.get("retry_min_seconds", 5)))
        self.retry_max = max(self.retry_min, int(upload_cfg.get("retry_max_seconds", 300)))
        self.max_media_bytes = int(upload_cfg.get("max_media_bytes", 8 * 1024 * 1024))
        self.capture_lock = threading.Lock()
        self.wake = threading.Event()
        self.online = threading.Event()
        self.last_heartbeat = 0.0
        self.last_capture = 0.0
        self.last_upload_error: str | None = None
        # HTTPS heartbeat: server lifecycle decides whether uploads are accepted.
        self.http_heartbeat = bool(upload_cfg.get("http_heartbeat", True))
        self.heartbeat_interval = max(10, int(config.get("heartbeat_interval_seconds", 30)))
        self.accepting_uploads = threading.Event()
        self.accepting_uploads.set()
        self.server_lifecycle: str | None = None
        # Periodic capture interval: starts from config.json, then follows the web (heartbeat / command poll).
        self.capture_interval = max(0, int(config["capture"].get("interval_seconds", 0)))
        # On-demand "capture now" from the web, delivered by HTTPS long-poll (works without MQTT).
        self.http_commands = bool(upload_cfg.get("http_commands", True))
        self._inflight: set[str] = set()
        self._inflight_lock = threading.Lock()

        mqtt_cfg = config.get("mqtt") or {}
        self.mqtt_enabled = bool(mqtt_cfg.get("enabled", False))
        self.client = None
        if self.mqtt_enabled:
            if mqtt is None:
                raise RuntimeError("mqtt.enabled=true but paho-mqtt is not installed: pip install -r requirements.txt")
            self.root_topic = mqtt_cfg.get("topic_prefix", "camera").strip("/") + "/" + self.camera_id
            self.topic = {name: f"{self.root_topic}/{name}" for name in ("heartbeat", "status", "command")}
            self.topic["command_ack"] = f"{self.root_topic}/command/ack"
            self.topic["uploaded"] = f"{self.root_topic}/media/uploaded"
            self.client = self._make_client(mqtt_cfg)

    # ---------------------------------------------------------------- MQTT (optional)
    def _make_client(self, cfg: dict[str, Any]):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"phone-camera-{self.camera_id}", clean_session=True)
        if cfg.get("username"):
            client.username_pw_set(cfg["username"], cfg.get("password", ""))
        tls = cfg.get("tls", {})
        if tls.get("enabled", True):
            client.tls_set(ca_certs=tls.get("ca_file") or None)
            client.tls_insecure_set(False)
        client.reconnect_delay_set(min_delay=1, max_delay=60)
        client.will_set(self.topic["status"], json.dumps({"state": "offline", "cameraId": self.camera_id}), qos=1)
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        return client

    def _on_connect(self, client, _userdata, _flags, reason_code, _properties) -> None:
        if reason_code.is_failure:
            LOG.error("MQTT connect failed: %s", reason_code)
            return
        self.online.set()
        client.subscribe(self.topic["command"], qos=1)
        # Never block inside a paho callback: publish without waiting.
        self.publish("status", {"state": "online", "cameraId": self.camera_id, "at": utc_now()}, wait=False)
        LOG.info("MQTT connected; listening on %s", self.topic["command"])

    def _on_disconnect(self, _client, _userdata, _flags, reason_code, _properties) -> None:
        self.online.clear()
        LOG.warning("MQTT disconnected: %s", reason_code)

    def publish(self, name: str, payload: dict[str, Any], wait: bool = True) -> bool:
        if not self.client or not self.online.is_set():
            return False
        info = self.client.publish(self.topic[name], json.dumps(payload, separators=(",", ":")), qos=1)
        if not wait:
            return True
        try:
            info.wait_for_publish(timeout=10)
            return info.is_published()
        except (ValueError, RuntimeError):
            return False

    def _on_message(self, _client, _userdata, message) -> None:
        if message.topic != self.topic["command"]:
            return
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            LOG.warning("Ignoring non-JSON command")
            return
        if isinstance(payload, dict):
            threading.Thread(target=self.handle_command, args=(payload,), daemon=True).start()

    def _ack_command(self, request_id: str, success: bool, message: str, event_id: str | None = None) -> None:
        result = {"requestId": request_id, "cameraId": self.camera_id, "success": success, "message": message,
                  "eventId": event_id, "completedAt": utc_now()}
        self.spool.save_command(request_id, result)
        self._send_ack(result)

    def _send_ack(self, result: dict[str, Any]) -> None:
        self.publish("command_ack", result)
        if not self.http_commands:
            return
        for attempt in range(3):
            code, _payload, detail = self.uploader.ack_command(str(result["requestId"]), result)
            if 200 <= code < 300 or code in (400, 401, 403, 404):
                if not 200 <= code < 300:
                    LOG.warning("Command ack %s refused: %s", result["requestId"], detail)
                return
            if STOP.wait(2 * (attempt + 1)):
                return
        LOG.warning("Command ack %s failed: %s", result["requestId"], detail)

    def handle_command(self, command: dict[str, Any]) -> None:
        request_id = str(command.get("requestId", ""))
        if not request_id or len(request_id) > 100:
            LOG.warning("Ignoring command without a valid requestId")
            return
        prior = self.spool.get_command(request_id)
        if prior:
            self._send_ack(prior)
            return
        LOG.info("Command %s: %s", request_id, command.get("action"))
        action = command.get("action")
        if action not in ("capture", "record_video"):
            self._ack_command(request_id, False, "unsupported_action")
            return
        try:
            camera = str(command.get("camera", self.config["capture"].get("camera", "back")))
            item = self.capture_image(request_id, camera) if action == "capture" else self.capture_video(request_id, command)
            self._ack_command(request_id, True, "media_queued", item["event_id"])
            self.wake.set()  # upload right away instead of waiting for the uploader's next round
        except Exception as exc:
            LOG.exception("Capture request failed")
            self._ack_command(request_id, False, str(exc)[:160])

    # ---------------------------------------------------------------- capture
    def capture_image(self, request_id: str | None = None, camera: str = "back") -> dict[str, Any]:
        with self.capture_lock:
            event_id = self._new_event_id()
            path = self.media_dir / f"{event_id}.jpg"
            self._capture_to_path(path, camera)
            self._shrink_jpeg(path)
            self._check_size(path)
            return self._register_media(event_id, request_id, "image", "image/jpeg", path)

    def _new_event_id(self) -> str:
        return f"{self.camera_id}-{int(time.time())}-{uuid.uuid4().hex[:12]}"

    def _capture_to_path(self, path: Path, camera: str) -> None:
        if not shutil.which("termux-camera-photo"):
            raise RuntimeError("termux-camera-photo not found: pkg install termux-api (and install the Termux:API app)")
        camera_index = "1" if camera == "front" else "0"
        timeout = int(self.config["capture"].get("capture_timeout_seconds", 30))
        try:
            result = subprocess.run(["termux-camera-photo", "-c", camera_index, str(path)],
                                    capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            path.unlink(missing_ok=True)
            raise RuntimeError("camera_capture_timeout (is Termux:API installed and camera permission granted?)")
        if result.returncode != 0 or not path.exists() or path.stat().st_size == 0:
            path.unlink(missing_ok=True)
            raise RuntimeError((result.stderr or "camera_capture_failed").strip()[:160])

    def _shrink_jpeg(self, path: Path) -> None:
        """Optionally downscale with ffmpeg to save mobile data and stay under server limits."""
        max_width = int(self.config["capture"].get("resize_max_width", 0))
        if max_width <= 0:
            return
        if not shutil.which("ffmpeg"):
            LOG.warning("capture.resize_max_width set but ffmpeg is missing; uploading original image")
            return
        quality = max(2, min(int(self.config["capture"].get("jpeg_quality", 4)), 31))
        tmp = path.with_suffix(".small.jpg")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
               "-vf", f"scale='min({max_width},iw)':-2", "-q:v", str(quality), str(tmp)]
        try:
            subprocess.run(cmd, check=True, timeout=60)
            if tmp.exists() and tmp.stat().st_size > 0:
                tmp.replace(path)
        except (subprocess.SubprocessError, OSError) as exc:
            LOG.warning("Resize failed, keeping original: %s", exc)
        finally:
            tmp.unlink(missing_ok=True)

    def _check_size(self, path: Path) -> None:
        if path.stat().st_size > self.max_media_bytes:
            size = path.stat().st_size
            path.unlink(missing_ok=True)
            raise RuntimeError(f"media_exceeds_max_media_bytes ({size} > {self.max_media_bytes}); set capture.resize_max_width")

    def capture_video(self, request_id: str, command: dict[str, Any]) -> dict[str, Any]:
        with self.capture_lock:
            video = self.config.get("video", {})
            if video.get("mode", "timelapse") != "timelapse":
                raise RuntimeError("video_mode_not_configured: use timelapse mode")
            if not shutil.which("ffmpeg"):
                raise RuntimeError("ffmpeg_not_installed: pkg install ffmpeg")
            duration = max(2, min(int(command.get("durationSeconds", video.get("default_duration_seconds", 10))),
                                  int(video.get("max_duration_seconds", 30))))
            interval = max(1, min(int(command.get("frameIntervalSeconds", video.get("frame_interval_seconds", 1))), 10))
            camera = str(command.get("camera", self.config["capture"].get("camera", "back")))
            event_id = self._new_event_id()
            frame_dir = self.media_dir / f"{event_id}-frames"
            frame_dir.mkdir(parents=True, exist_ok=False)
            output = self.media_dir / f"{event_id}.mp4"
            try:
                end_at = time.monotonic() + duration
                frame_index = 0
                while time.monotonic() < end_at and not STOP.is_set():
                    self._capture_to_path(frame_dir / f"frame-{frame_index:06d}.jpg", camera)
                    frame_index += 1
                    STOP.wait(interval)
                if frame_index < 2:
                    raise RuntimeError("timelapse_requires_at_least_two_frames")
                fps = max(1, min(int(video.get("output_fps", 2)), 30))
                width = int(video.get("max_width", 1280))
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
                                "-i", str(frame_dir / "frame-%06d.jpg"),
                                "-vf", f"scale='min({width},iw)':-2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                                str(output)], check=True, timeout=180)
                if not output.exists() or output.stat().st_size == 0:
                    raise RuntimeError("video_encode_failed")
                self._check_size(output)
                return self._register_media(event_id, request_id, "video", "video/mp4", output)
            except Exception:
                output.unlink(missing_ok=True)
                raise
            finally:
                shutil.rmtree(frame_dir, ignore_errors=True)

    def _register_media(self, event_id: str, request_id: str | None, media_type: str, mime: str, path: Path) -> dict[str, Any]:
        item = {"event_id": event_id, "request_id": request_id, "media_type": media_type, "mime_type": mime,
                "path": str(path), "captured_at": utc_now(), "size_bytes": path.stat().st_size,
                "sha256": self._sha256(path), "created_at": utc_now()}
        self.spool.add_media(item)
        for old_path in self.spool.trim(self.max_queue_items):
            Path(old_path).unlink(missing_ok=True)
            LOG.warning("Spool full (%d items): dropped oldest %s", self.max_queue_items, Path(old_path).name)
        self.wake.set()
        return item

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    # ---------------------------------------------------------------- upload
    def upload_pending(self) -> float | None:
        """Upload every queued item. Return None when the queue is drained, or a retry hint
        (seconds, 0 = use backoff) when a transient error stopped the run."""
        if not self.accepting_uploads.is_set():
            # FAULT/MAINTENANCE on the server: keep media queued, the heartbeat thread wakes us up.
            return float(self.heartbeat_interval) if self.spool.count_pending() else None
        for row in self.spool.pending():
            if STOP.is_set():
                return None
            outcome, detail, retry_after = self.uploader.upload(row)
            event_id = row["event_id"]
            if outcome == STORED:
                path = self.spool.remove(event_id)
                if path:
                    Path(path).unlink(missing_ok=True)
                self.last_upload_error = None
                LOG.info("Uploaded %s (%s, %d bytes): %s", event_id, row["media_type"], row["size_bytes"], detail)
                self.publish("uploaded", {"cameraId": self.camera_id, "eventId": event_id, "requestId": row["request_id"],
                                          "result": detail, "at": utc_now()})
            elif outcome == REJECTED:
                self.spool.mark_rejected(event_id, detail)
                LOG.error("Server rejected %s: %s (file kept at %s, not retried)", event_id, detail, row["path"])
            else:
                if "CAMERA_NOT_ACCEPTING" in detail:
                    self.accepting_uploads.clear()
                self.spool.mark_failed(event_id, detail)
                self.last_upload_error = detail
                LOG.warning("Upload %s deferred: %s", event_id, detail)
                return retry_after
        return None

    def upload_worker(self) -> None:
        backoff = self.retry_min
        self.wake.set()  # flush whatever is left from a previous run
        while not STOP.is_set():
            self.wake.wait(timeout=60)
            self.wake.clear()
            if STOP.is_set():
                break
            hint = self.upload_pending()
            if hint is None:
                backoff = self.retry_min
                continue
            delay = min(hint, self.retry_max) if hint > 0 else backoff
            backoff = min(backoff * 2, self.retry_max)
            LOG.info("Retrying upload in %ds (%d queued)", delay, self.spool.count_pending())
            if STOP.wait(delay):
                break
            self.wake.set()

    # ---------------------------------------------------------------- HTTPS heartbeat
    def send_heartbeat(self) -> bool:
        code, payload, detail = self.uploader.heartbeat({
            "queuedMedia": self.spool.count_pending(),
            "lastUploadError": self.last_upload_error,
        })
        if code == 0 or payload is None or not (200 <= code < 300):
            if code in (401, 403):
                LOG.error("Heartbeat refused (%s): token revoked/expired or camera decommissioned - ask Admin for a new token", detail)
            else:
                LOG.warning("Heartbeat failed: %s", detail)
            return False
        lifecycle = str(payload.get("lifecycle") or "")
        if lifecycle != self.server_lifecycle:
            LOG.info("Server lifecycle: %s (accepting uploads: %s)", lifecycle or "?", payload.get("acceptingUploads"))
            self.server_lifecycle = lifecycle
        if payload.get("acceptingUploads", True):
            if not self.accepting_uploads.is_set():
                self.accepting_uploads.set()
                self.wake.set()  # flush media queued while paused
        else:
            self.accepting_uploads.clear()
        server_interval = payload.get("heartbeatIntervalSeconds")
        if isinstance(server_interval, int) and 10 <= server_interval <= 3600 and server_interval != self.heartbeat_interval:
            LOG.info("Heartbeat interval set by server: %ss", server_interval)
            self.heartbeat_interval = server_interval
        self.apply_capture_interval(payload.get("captureIntervalSeconds"))
        self.dispatch_commands(payload.get("commands"))
        return True

    def apply_capture_interval(self, value: Any) -> None:
        """0 = periodic capture off (on-demand only); 5..86400 seconds; anything else (null) keeps the current value."""
        if isinstance(value, bool) or not isinstance(value, int):
            return
        if value != 0 and not 5 <= value <= 86400:
            return
        if value != self.capture_interval:
            LOG.info("Capture interval set by server: %s", f"{value}s" if value else "off (on-demand only)")
            self.capture_interval = value

    def dispatch_commands(self, commands: Any) -> None:
        if not isinstance(commands, list):
            return
        for command in commands[:10]:
            if isinstance(command, dict):
                threading.Thread(target=self._run_command_once, args=(command,), daemon=True).start()

    def _run_command_once(self, command: dict[str, Any]) -> None:
        """Heartbeat and long-poll may both hand over a redelivered command; run each requestId once at a time."""
        request_id = str(command.get("requestId", ""))
        with self._inflight_lock:
            if request_id in self._inflight:
                return
            self._inflight.add(request_id)
        try:
            self.handle_command(command)
        finally:
            with self._inflight_lock:
                self._inflight.discard(request_id)

    def command_worker(self) -> None:
        """Long-poll /api/camera/commands/poll so "Chụp ngay" on the web fires within a second or two."""
        failures = 0
        while not STOP.is_set():
            code, payload, detail = self.uploader.poll_commands(25)
            if 200 <= code < 300 and payload is not None:
                failures = 0
                self.apply_capture_interval(payload.get("captureIntervalSeconds"))
                self.dispatch_commands(payload.get("commands"))
                continue
            failures += 1
            if code == 404:
                LOG.warning("Server has no /commands/poll (old Backend?) - on-demand capture falls back to heartbeat")
                delay = 300
            elif code in (401, 403):
                delay = 60  # the heartbeat worker already logs token problems
            else:
                if failures == 1 or failures % 10 == 0:
                    LOG.warning("Command poll failed: %s", detail)
                delay = min(60, self.retry_min * (2 ** min(failures, 4)))
            if STOP.wait(delay):
                break

    def heartbeat_worker(self) -> None:
        failures = 0
        while not STOP.is_set():
            ok = self.send_heartbeat()
            failures = 0 if ok else failures + 1
            # Back off a little after repeated failures, but never beyond the interval x 2.
            delay = self.heartbeat_interval if ok else min(self.heartbeat_interval * 2, self.retry_min * (2 ** min(failures, 5)))
            if STOP.wait(delay):
                break

    # ---------------------------------------------------------------- main loop
    def run(self) -> None:
        if self.client:
            cfg = self.config["mqtt"]
            self.client.connect_async(cfg["host"], int(cfg.get("port", 8883)), int(cfg.get("keepalive_seconds", 45)))
            self.client.loop_start()
        worker = threading.Thread(target=self.upload_worker, name="uploader", daemon=True)
        worker.start()
        if self.http_heartbeat:
            threading.Thread(target=self.heartbeat_worker, name="heartbeat", daemon=True).start()
        if self.http_commands:
            threading.Thread(target=self.command_worker, name="commands", daemon=True).start()
        capture_cfg = self.config["capture"]
        LOG.info("Agent %s started: camera=%s upload=%s heartbeat=%s periodic=%ss commands=%s mqtt=%s", AGENT_VERSION,
                 self.camera_id, self.uploader.url, f"{self.heartbeat_interval}s" if self.http_heartbeat else "off",
                 self.capture_interval or "off", "https-poll" if self.http_commands else "off", "on" if self.client else "off")
        while not STOP.wait(1):
            now = time.monotonic()
            if self.online.is_set() and now - self.last_heartbeat >= self.heartbeat_interval:
                self.publish("heartbeat", {"cameraId": self.camera_id, "state": "online", "at": utc_now(),
                                           "queuedMedia": self.spool.count_pending(),
                                           "lastUploadError": self.last_upload_error, "agentVersion": AGENT_VERSION})
                self.last_heartbeat = now
            interval = self.capture_interval
            if interval > 0 and (self.last_capture == 0 or now - self.last_capture >= interval):
                self.last_capture = now
                try:
                    item = self.capture_image(camera=str(capture_cfg.get("camera", "back")))
                    LOG.info("Periodic capture queued: %s (%d bytes)", item["event_id"], item["size_bytes"])
                except Exception as exc:
                    LOG.error("Periodic capture failed: %s", exc)
        self.wake.set()
        worker.join(timeout=5)
        if self.client:
            self.publish("status", {"state": "offline", "cameraId": self.camera_id, "at": utc_now()})
            self.client.disconnect()
            self.client.loop_stop()
        LOG.info("Agent stopped")


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--check-camera", action="store_true", help="Take one test photo (no upload) and exit")
    parser.add_argument("--check-upload", action="store_true", help="Take one photo, upload it over HTTPS and exit")
    parser.add_argument("--check-heartbeat", action="store_true", help="Send one HTTPS heartbeat (marks the camera online) and exit")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = load_config(args.config)
        if args.check_camera or args.check_upload or args.check_heartbeat:
            config = {**config, "mqtt": {"enabled": False}}
        agent = CameraAgent(config)
        if args.check_heartbeat:
            code, payload, detail = agent.uploader.heartbeat({"queuedMedia": agent.spool.count_pending()})
            if 200 <= code < 300 and payload is not None:
                LOG.info("Heartbeat OK: lifecycle=%s acceptingUploads=%s interval=%ss",
                         payload.get("lifecycle"), payload.get("acceptingUploads"), payload.get("heartbeatIntervalSeconds"))
                return 0
            LOG.error("Heartbeat failed: %s", detail)
            return 2
        if args.check_camera:
            item = agent.capture_image(camera=str(config["capture"].get("camera", "back")))
            agent.spool.remove(item["event_id"])
            LOG.info("Test image OK: %s (%d bytes) - not uploaded", item["path"], item["size_bytes"])
            return 0
        if args.check_upload:
            item = agent.capture_image(camera=str(config["capture"].get("camera", "back")))
            outcome, detail, _ = agent.uploader.upload(item)
            if outcome == STORED:
                agent.spool.remove(item["event_id"])
                Path(item["path"]).unlink(missing_ok=True)
                LOG.info("Upload OK (%s): %s", detail, item["event_id"])
                return 0
            LOG.error("Upload %s: %s (image stays queued for the agent)", outcome.upper(), detail)
            if outcome == REJECTED:
                agent.spool.mark_rejected(item["event_id"], detail)
            return 2
        signal.signal(signal.SIGINT, lambda *_: STOP.set())
        signal.signal(signal.SIGTERM, lambda *_: STOP.set())
        agent.run()
        return 0
    except Exception as exc:
        LOG.error("Startup failed: %s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
