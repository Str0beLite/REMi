"""Mock of vLLM's OpenAI-compatible server (CONTRACT.md §9, §11).

Run: uv run python -m remi.mocks.vllm --port 8999
  POST /v1/chat/completions      replies with the next scripted string, else "ok"
  GET  /v1/models                base model + loaded LoRAs
  POST /v1/load_lora_adapter     {"lora_name", "lora_path"}
  POST /v1/unload_lora_adapter   {"lora_name"}
Mock-only:
  POST /mock/script    ["reply 1", "/sh df -h", ...]   queue replies, consumed in order
  GET  /mock/requests  every request body received
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from remi import contract as C


class MockVLLM:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.script: list[str] = []
        self.requests: list[dict] = []
        self.loras: dict[str, str] = {}


def make_server(port: int = 8999, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    st = MockVLLM()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status: int, payload) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/v1/models":
                ids = [C.BASE_MODEL, *st.loras]
                return self._send(200, {"object": "list", "data": [{"id": i, "object": "model"} for i in ids]})
            if self.path == "/mock/requests":
                return self._send(200, st.requests)
            self._send(404, {"error": "not found"})

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")
            except ValueError:
                return self._send(400, {"error": "invalid JSON"})
            with st.lock:
                if self.path == "/mock/script":
                    st.script.extend(map(str, body))
                    return self._send(200, {"queued": len(st.script)})
                st.requests.append({"path": self.path, "body": body})
                if self.path == "/v1/load_lora_adapter":
                    st.loras[body["lora_name"]] = body["lora_path"]
                    return self._send(200, {"ok": True})
                if self.path == "/v1/unload_lora_adapter":
                    if st.loras.pop(body["lora_name"], None) is None:
                        return self._send(404, {"error": "lora not loaded"})
                    return self._send(200, {"ok": True})
                if self.path == "/v1/chat/completions":
                    model = body.get("model")
                    if model != C.BASE_MODEL and model not in st.loras:
                        return self._send(404, {"error": f"model {model!r} not found"})
                    reply = st.script.pop(0) if st.script else "ok"
                    return self._send(200, {
                        "id": f"mock-{len(st.requests)}", "object": "chat.completion", "created": int(time.time()),
                        "model": model,
                        "choices": [{"index": 0, "finish_reason": "stop",
                                     "message": {"role": "assistant", "content": reply}}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                    })
            self._send(404, {"error": "not found"})

    server = ThreadingHTTPServer((host, port), Handler)
    server.state = st  # type: ignore[attr-defined]
    return server


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8999)
    args = p.parse_args()
    print(f"mock vLLM on http://127.0.0.1:{args.port} (base model {C.BASE_MODEL})")
    make_server(args.port).serve_forever()


if __name__ == "__main__":
    main()
