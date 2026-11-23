import email
import email.policy
import hashlib
import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("camera_agent", ROOT / "camera_agent.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def make_config(tmp: str, url: str) -> dict:
    config = json.loads((ROOT / "config.example.json").read_text())
    config["upload"].update({"url": url, "token": "test-token", "allow_insecure_http": url.startswith("http://")})
    config["storage"] = {"directory": tmp, "media_directory": tmp}
    return config


class FakeServer(BaseHTTPRequestHandler):
    """Minimal receiver implementing the HTTPS upload contract (served over plain HTTP in tests)."""
    responses: list = []
    received: list = []

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        raw = f"Content-Type: {self.headers['Content-Type']}\r\n\r\n".encode() + body
        message = email.message_from_bytes(raw, policy=email.policy.HTTP)
        parts = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
        FakeServer.received.append({
            "auth": self.headers.get("Authorization"),
            "idempotency": self.headers.get("Idempotency-Key"),
            "metadata": json.loads(parts["metadata"].get_content()),
            "file": parts["file"].get_content(),
            "file_type": parts["file"].get_content_type(),
        })
        status, payload = FakeServer.responses.pop(0)
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class AgentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeServer)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/api/camera/media"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeServer.responses.clear()
        FakeServer.received.clear()

    def _agent_with_image(self, tmp: str, content: bytes = b"\xff\xd8fake-jpeg\xff\xd9"):
        agent = MODULE.CameraAgent(make_config(tmp, self.url))
        path = Path(tmp) / "PHONE-CAM-01-1-abc.jpg"
        path.write_bytes(content)
        item = agent._register_media("PHONE-CAM-01-1-abc", "req-1", "image", "image/jpeg", path)
        return agent, path, item

    def test_load_config_rejects_placeholder_token_and_plain_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.json"
            cfg_path.write_text((ROOT / "config.example.json").read_text())
            with self.assertRaisesRegex(ValueError, "token"):
                MODULE.load_config(cfg_path)
            config = make_config(tmp, "http://example.org/x")
            config["upload"]["allow_insecure_http"] = False
            cfg_path.write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "https"):
                MODULE.load_config(cfg_path)
            cfg_path.write_text(json.dumps(make_config(tmp, "https://example.org/x")))
            self.assertEqual(MODULE.load_config(cfg_path)["camera_id"], "PHONE-CAM-01")

    def test_spool_is_idempotent_for_event_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            spool = MODULE.Spool(Path(tmp) / "queue.sqlite3")
            item = {
                "event_id": "event-1", "request_id": "request-1", "media_type": "image",
                "mime_type": "image/jpeg", "path": "/tmp/event-1.jpg", "captured_at": "2026-11-03T00:00:00Z",
                "size_bytes": 10, "sha256": "abc", "created_at": "2026-11-03T00:00:00Z",
            }
            spool.add_media(item)
            spool.add_media(item)
            self.assertEqual(len(spool.pending()), 1)
            self.assertEqual(spool.remove("event-1"), "/tmp/event-1.jpg")
            self.assertEqual(spool.pending(), [])

    def test_successful_upload_sends_contract_and_deletes_local_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent, path, item = self._agent_with_image(tmp)
            FakeServer.responses.append((201, {"status": "stored", "eventId": item["event_id"], "sha256": item["sha256"]}))
            self.assertIsNone(agent.upload_pending())
            self.assertFalse(path.exists())
            self.assertEqual(agent.spool.count_pending(), 0)
            sent = FakeServer.received[0]
            self.assertEqual(sent["auth"], "Bearer test-token")
            self.assertEqual(sent["idempotency"], item["event_id"])
            self.assertEqual(sent["file"], path.name and b"\xff\xd8fake-jpeg\xff\xd9")
            self.assertEqual(sent["file_type"], "image/jpeg")
            self.assertEqual(sent["metadata"]["sha256"], hashlib.sha256(sent["file"]).hexdigest())
            self.assertEqual(sent["metadata"]["requestId"], "req-1")

    def test_server_error_keeps_item_queued_and_honours_retry_after(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent, path, _item = self._agent_with_image(tmp)
            FakeServer.responses.append((503, {"message": "busy"}))
            self.assertEqual(agent.upload_pending(), 0.0)
            self.assertTrue(path.exists())
            self.assertEqual(agent.spool.count_pending(), 1)

    def test_validation_error_marks_rejected_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent, path, _item = self._agent_with_image(tmp)
            FakeServer.responses.append((422, {"reason": "unsupported_mime"}))
            self.assertIsNone(agent.upload_pending())
            self.assertTrue(path.exists())  # kept for inspection
            self.assertEqual(agent.spool.count_pending(), 0)

    def test_network_failure_is_retryable(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = make_config(tmp, "http://127.0.0.1:9/api/camera/media")
            agent = MODULE.CameraAgent(config)
            path = Path(tmp) / "x.jpg"
            path.write_bytes(b"data")
            agent._register_media("x", None, "image", "image/jpeg", path)
            self.assertEqual(agent.upload_pending(), 0.0)
            self.assertEqual(agent.spool.count_pending(), 1)

    def test_classify_response(self):
        sha = "a" * 64
        self.assertEqual(MODULE.classify_response(200, b'{"status":"duplicate"}', None, sha)[0], MODULE.STORED)
        self.assertEqual(MODULE.classify_response(200, b'{"status":"stored","sha256":"' + b"b" * 64 + b'"}', None, sha)[0],
                         MODULE.RETRY)
        self.assertEqual(MODULE.classify_response(401, b"", None, sha)[0], MODULE.RETRY)
        self.assertEqual(MODULE.classify_response(413, b"", None, sha)[0], MODULE.REJECTED)
        self.assertEqual(MODULE.classify_response(429, b"", "30", sha), (MODULE.RETRY, "http_429", 30.0))

    def test_spool_trim_drops_oldest(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = make_config(tmp, self.url)
            config["storage"]["max_queue_items"] = 2
            agent = MODULE.CameraAgent(config)
            for index in range(3):
                path = Path(tmp) / f"{index}.jpg"
                path.write_bytes(b"x")
                agent._register_media(f"e{index}", None, "image", "image/jpeg", path)
            self.assertEqual([row["event_id"] for row in agent.spool.pending()], ["e1", "e2"])
            self.assertFalse((Path(tmp) / "0.jpg").exists())


if __name__ == "__main__":
    unittest.main()
