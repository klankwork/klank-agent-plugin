#!/usr/bin/env python3
"""Tests for scripts/klank-trajectory. Standard library only; run by `npm test`.

The redaction corpus is assembled at run time from fragments, so no
secret-shaped string (and no literal Klank agent-key prefix) is ever committed:
GitHub push protection and test/validate.mjs would both refuse one.
"""

import gzip
import hashlib
import http.server
import importlib.machinery
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "klank-trajectory")

loader = importlib.machinery.SourceFileLoader("klank_trajectory", SCRIPT)
spec = importlib.util.spec_from_loader("klank_trajectory", loader)
kt = importlib.util.module_from_spec(spec)
loader.exec_module(kt)

TOKEN = "Tq" + "7" * 40 + "x"  # 43 base64url characters, like a real token
CAP = {"token": TOKEN, "expires_at": "2026-10-01T00:00:00Z", "max_bytes": 536870912}


def j(*parts):
    return "".join(parts)


# One sample of every kind the script redacts, each built from fragments.
SECRETS = {
    "pem": j("-----BEGIN ", "RSA PRIVATE KEY-----\\nMIIEow", "IBAAKCAQEA7", "\\n-----END RSA PRIVATE KEY-----"),
    "jwt": j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    "anthropic_key": j("sk-", "ant-api03-", "Zx9" * 12),
    "openai_key": j("sk-", "proj-", "Ab3" * 12),
    "provider_api_key": j("gsk", "_", "Q1w" * 15),
    "google_api_key": j("AI", "za", "Sy", "B" * 33),
    "stripe_key": j("sk", "_live_", "51H" * 8),
    "github_token": j("gh", "p_", "a1B2" * 9),
    "aws_access_key": j("AK", "IA", "IOSFODNN7EXAMPLE"),
    "aws_secret_key": j("aws_secret_access_key=", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY"),
    "slack_token": j("xo", "xb-", "1234567890-", "abcdefghijKL"),
    "klank_key": j("klank", "_", "agent", "_", "0a1b2c3d4e5f", "_", "0123456789abcdef0123456789abcdef"),
    "presigned_signature": j("https://bucket.r2.cloudflarestorage.com/o?X-Amz-Date=20260930T000000Z&X-Amz-",
                             "Signature=", "3f" * 32),
    "trajectory_token": j("/v1/trajectory-uploads/", TOKEN),
    "url_credential": j("https://x-access-token", ":", "ghs_", "Tk" * 20, "@code.storage/acme/repo.git"),
    "bearer_token": j("Authorization: ", "Bearer ", "Zm9vYmFy" * 4),
    "env_secret": j("hunter2", "-correct-horse"),
}
# An env value with characters JSON escapes; json.dumps writes it as \" and \\.
ESCAPED_ENV_SECRET = j('pa"ss', "\\", "word-with-quote")

# The part of each sample that must not survive (a presigned URL keeps its
# path and unsigned parameters; an assignment keeps its name).
SECRET_PARTS = dict(SECRETS)
SECRET_PARTS["presigned_signature"] = "3f" * 32
SECRET_PARTS["trajectory_token"] = TOKEN
SECRET_PARTS["url_credential"] = j("ghs_", "Tk" * 20)
SECRET_PARTS["bearer_token"] = "Zm9vYmFy" * 4
SECRET_PARTS["aws_secret_key"] = j("wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY")

# Look-alikes that must come out untouched.
BENIGN = [
    "pip install scikit-learn; import sk-learn-compat-shim-module-name-here",
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "commit 2151c72e1f0f4d3a9b7c6d5e4f3a2b1c0d9e8f7a",
    "task 3fa85f64-5717-4562-b3fc-2c963f66afa6 and KLNK-12",
    "the AKIA prefix names an access key; eyJ starts a JWT header",
    "Authorization: Bearer $KLANK_API_KEY",
    "https://api.klank.fun:443/v1/tasks?limit=25&after=abc",
    "X-Amz-Date=20260930T000000Z&X-Amz-Expires=900",
    "set the password in the dashboard; the token is single-use",
    "ghp_short and sk-ant- alone are not keys",
]


def corpus_lines():
    lines = []
    for kind, secret in SECRETS.items():
        lines.append(json.dumps({"type": "tool_result", "kind": kind, "content": "found: " + secret}) + "\n")
    lines.append(json.dumps({"content": "\\\"token\\\":\\\"" + TOKEN + "\\\""}) + "\n")
    # An env secret holding a quote and a backslash, as a transcript escapes it.
    lines.append(json.dumps({"content": "env: " + ESCAPED_ENV_SECRET}) + "\n")
    for text in BENIGN:
        lines.append(json.dumps({"type": "assistant", "content": text}) + "\n")
    return lines


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Stub:
    """A local stand-in for the Klank API and the object store."""

    def __init__(self, skip=()):
        self.requests = []
        self.puts = {}
        self.skip = set(skip)
        self.done = threading.Event()
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _json(self, status, doc):
                raw = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                body = json.loads(self._body() or b"{}")
                stub.requests.append(("POST", self.path, body))
                if self.path.endswith("/complete"):
                    self._json(200, {"data": {"trajectory_id": "t", "files": [], "skipped": [], "completed_at": "now"}})
                    stub.done.set()
                    return
                uploads, skipped = [], []
                for f in body["files"]:
                    if f["name"] in stub.skip:
                        skipped.append({"name": f["name"], "bytes": f["bytes"], "reason": "too_large"})
                    else:
                        uploads.append({
                            "name": f["name"], "method": "PUT", "expires_at": "later",
                            "url": "http://127.0.0.1:%d/bucket/%s?X-Amz-Signature=%s" % (stub.port, f["name"], "ab" * 32),
                            "headers": {"Content-Type": "application/gzip", "x-amz-meta-klank": "1"},
                        })
                self._json(201, {"data": {"trajectory_id": "t", "uploads": uploads, "skipped": skipped}})

            def do_PUT(self):
                stub.requests.append(("PUT", self.path, dict(self.headers)))
                stub.puts[self.path.split("?")[0].rsplit("/", 1)[-1]] = (dict(self.headers), self._body())
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def run_hook(event, env_extra, stdin_bytes=None, timeout=5):
    env = dict(os.environ)
    env.pop("KLANK_TRAJECTORY", None)
    env.update(env_extra)
    raw = stdin_bytes if stdin_bytes is not None else json.dumps(event).encode()
    started = time.monotonic()
    proc = subprocess.run([sys.executable, SCRIPT], input=raw, env=env, timeout=timeout, capture_output=True)
    return proc, time.monotonic() - started


def claude_event(transcript, tool="mcp__plugin_klank_klank__submit_work", cap=CAP):
    text = json.dumps({"data": {"submission_id": "s1", "trajectory_upload": cap}})
    return {
        "session_id": "abc", "transcript_path": transcript, "hook_event_name": "PostToolUse",
        "tool_name": tool, "tool_input": {}, "tool_response": [{"type": "text", "text": text}],
    }


class Redaction(unittest.TestCase):
    def test_corpus_comes_out_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "t.jsonl")
            with open(src, "w") as f:
                f.writelines(corpus_lines())
            env = {"MY_SERVICE_PASSWORD": SECRETS["env_secret"], "DB_PASSWORD": ESCAPED_ENV_SECRET,
                   "HOME": "/home/x", "TOKENIZERS_PARALLELISM": "false"}
            rules = kt.compile_rules(env, TOKEN)
            counts = {}
            kt.redact_file(src, os.path.join(tmp, "t.gz"), rules, counts)
            with gzip.open(os.path.join(tmp, "t.gz"), "rt") as f:
                out = f.read()
        for kind, part in SECRET_PARTS.items():
            self.assertNotIn(part, out, kind)
            self.assertGreaterEqual(counts.get(kind, 0), 1, kind)
            self.assertIn("[REDACTED:%s]" % kind, out, kind)
        for text in BENIGN:
            self.assertIn(json.dumps({"type": "assistant", "content": text}), out, text)
        self.assertNotIn(json.dumps(ESCAPED_ENV_SECRET)[1:-1], out)
        self.assertNotIn("word-with-quote", out)
        self.assertIn("X-Amz-Date=20260930T000000Z", out)
        self.assertIn("@code.storage/acme/repo.git", out)

    def test_escaped_env_secret(self):
        rules = kt.compile_rules({"DB_PASSWORD": ESCAPED_ENV_SECRET}, None)
        once = json.dumps(ESCAPED_ENV_SECRET)[1:-1]
        twice = json.dumps(once)[1:-1]
        for text in [ESCAPED_ENV_SECRET, json.dumps({"c": ESCAPED_ENV_SECRET}), json.dumps({"c": json.dumps({"c": ESCAPED_ENV_SECRET})})]:
            counts = {}
            out = kt.redact_line(text, rules, counts)
            for form in (ESCAPED_ENV_SECRET, once, twice):
                self.assertNotIn(form, out)
            self.assertEqual(counts, {"env_secret": 1}, text)

    def test_multiline_pem_in_plain_text(self):
        body = j("MIIEow", "IBAAKCAQEA7") + "\nq1w2e3r4t5y6u7i8o9p0\n"
        text = ("before\n-----BEGIN " + "OPENSSH PRIVATE KEY-----\n" + body +
                "-----END OPENSSH PRIVATE KEY-----\nafter\n"
                "-----BEGIN CERTIFICATE----- never closed\nline\n")
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "t.txt")
            with open(src, "w") as f:
                f.write(text)
            counts = {}
            kt.redact_file(src, os.path.join(tmp, "t.gz"), kt.compile_rules({}, None), counts)
            with gzip.open(os.path.join(tmp, "t.gz"), "rt") as f:
                out = f.read()
        self.assertEqual(out, "before\n[REDACTED:pem]\nafter\n-----BEGIN CERTIFICATE----- never closed\nline\n")
        self.assertEqual(counts.get("pem"), 1)

    def test_source_is_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "t.jsonl")
            with open(src, "w") as f:
                f.writelines(corpus_lines())
            with open(src, "rb") as f:
                before = f.read()
            kt.redact_file(src, os.path.join(tmp, "t.gz"), kt.compile_rules({}, TOKEN), {})
            with open(src, "rb") as f:
                self.assertEqual(before, f.read())


class ToolResultShapes(unittest.TestCase):
    def test_every_harness_shape(self):
        data = {"data": {"submission_id": "s", "trajectory_upload": CAP}}
        text = json.dumps(data)
        shapes = {
            "claude content blocks": [{"type": "text", "text": text}],
            "structuredContent": {"content": [{"type": "text", "text": text}], "structuredContent": data},
            "codex call result": {"Ok": {"content": [{"type": "text", "text": text}], "isError": False}},
            "cursor result_json": json.dumps({"content": [{"type": "text", "text": text}]}),
            "plain text": text,
        }
        for label, shape in shapes.items():
            self.assertEqual(kt.find_capability(shape), CAP, label)

    def test_no_token(self):
        self.assertIsNone(kt.find_capability([{"type": "text", "text": '{"data":{"submission_id":"s"}}'}]))
        self.assertIsNone(kt.find_capability("not json"))

    def test_only_klank_decision_tools(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl") as f:
            for tool in ["mcp__plugin_klank_klank__submit_work", "mcp__klank__complete_task", "no_award_task"]:
                self.assertIsNotNone(kt.plan(claude_event(f.name, tool)), tool)
            for tool in ["mcp__plugin_klank_klank__get_self", "Bash", "mcp__other__checkpoint"]:
                self.assertIsNone(kt.plan(claude_event(f.name, tool)), tool)
            self.assertIsNone(kt.plan(claude_event(f.name, cap={})))

    def test_each_harness_event(self):
        text = json.dumps({"data": {"submission_id": "s", "trajectory_upload": CAP}})
        with tempfile.NamedTemporaryFile(suffix=".jsonl") as f:
            codex = {"session_id": "t", "turn_id": "u", "transcript_path": f.name, "model": "gpt",
                     "hook_event_name": "PostToolUse", "tool_name": "mcp__klank__submit_work",
                     "tool_response": {"content": [{"type": "text", "text": text}]}}
            cursor = {"conversation_id": "c", "cursor_version": "3.22.12", "transcript_path": f.name,
                      "hook_event_name": "afterMCPExecution", "tool_name": "submit_work",
                      "mcp_server_name": "klank", "tool_input": "{}", "result_json": json.dumps({"content": [{"type": "text", "text": text}]})}
            self.assertEqual(kt.plan(claude_event(f.name))["harness"], "claude_code")
            self.assertEqual(kt.plan(codex)["harness"], "codex")
            job = kt.plan(cursor)
            self.assertEqual((job["harness"], job["cursor_version"], job["token"]), ("cursor", "3.22.12", TOKEN))


class Transcripts(unittest.TestCase):
    def test_claude_code_subagents(self):
        with tempfile.TemporaryDirectory() as tmp:
            main = os.path.join(tmp, "s1.jsonl")
            sub = os.path.join(tmp, "s1", "subagents")
            os.makedirs(sub)
            for p in [main, os.path.join(sub, "agent-a.jsonl"), os.path.join(sub, "agent-a.meta.json")]:
                open(p, "w").close()
            expected = [main, os.path.join(sub, "agent-a.jsonl")]
            self.assertEqual(kt.transcript_files(main), expected)
            # A hook inside a subagent points at the subagent's own file.
            self.assertEqual(kt.transcript_files(os.path.join(sub, "agent-a.jsonl")), expected)
            self.assertEqual(kt.transcript_files(os.path.join(tmp, "missing.jsonl")), [])


class Hook(unittest.TestCase):
    def test_off_reads_nothing(self):
        # stdin is held open and never written: a read would block past the timeout.
        env = dict(os.environ, KLANK_TRAJECTORY="off")
        started = time.monotonic()
        proc = subprocess.Popen([sys.executable, SCRIPT], stdin=subprocess.PIPE, env=env)
        self.assertEqual(proc.wait(timeout=5), 0)
        self.assertLess(time.monotonic() - started, 3)
        proc.stdin.close()

    def test_off_never_touches_transcript_or_network(self):
        stub = Stub()
        with tempfile.TemporaryDirectory() as tmp:
            fifo = os.path.join(tmp, "s1.jsonl")
            os.mkfifo(fifo)  # opening it for reading would be visible to a writer
            proc, _ = run_hook(claude_event(fifo), {"KLANK_TRAJECTORY": "off", "KLANK_API_URL": "http://127.0.0.1:%d" % stub.port})
            self.assertEqual(proc.returncode, 0)
            time.sleep(kt.SETTLE_SECONDS + 1)
            with self.assertRaises(OSError):  # ENXIO: nobody has the FIFO open for reading
                os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
        stub.close()
        self.assertEqual(stub.requests, [])

    def test_no_token_no_network(self):
        stub = Stub()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s1.jsonl")
            with open(path, "w") as f:
                f.write("{}\n")
            proc, _ = run_hook(claude_event(path, cap={"expires_at": "x"}), {"KLANK_API_URL": "http://127.0.0.1:%d" % stub.port})
            self.assertEqual(proc.returncode, 0)
            time.sleep(kt.SETTLE_SECONDS + 1)
        stub.close()
        self.assertEqual(stub.requests, [])

    def test_fast_exit_when_server_down(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s1.jsonl")
            with open(path, "w") as f:
                f.writelines(corpus_lines())
            env = {"KLANK_API_URL": "http://127.0.0.1:%d" % free_port(), "TMPDIR": tmp}
            proc, elapsed = run_hook(claude_event(path), env)
            self.assertEqual(proc.returncode, 0)
            self.assertLess(elapsed, 2)
            self.assertEqual(proc.stdout + proc.stderr, b"")
            for junk in [b"", b"not json", b"[]", json.dumps({"tool_name": 5}).encode()]:
                self.assertEqual(run_hook(None, env, stdin_bytes=junk)[0].returncode, 0)

    def test_upload_sequence(self):
        stub = Stub(skip={"agent-a.jsonl.gz"})
        with tempfile.TemporaryDirectory() as tmp:
            main = os.path.join(tmp, "s1.jsonl")
            sub = os.path.join(tmp, "s1", "subagents")
            os.makedirs(sub)
            lines = [json.dumps({"version": "2.1.263", "type": "user"}) + "\n"] + corpus_lines()
            with open(main, "w") as f:
                f.writelines(lines)
            with open(os.path.join(sub, "agent-a.jsonl"), "w") as f:
                f.write(json.dumps({"type": "user", "content": "sub"}) + "\n")
            work = os.path.join(tmp, "work")
            os.makedirs(work)
            env = {"KLANK_API_URL": "http://127.0.0.1:%d" % stub.port, "TMPDIR": work,
                   "MY_SERVICE_PASSWORD": SECRETS["env_secret"]}
            proc, elapsed = run_hook(claude_event(main), env)
            self.assertEqual(proc.returncode, 0)
            self.assertLess(elapsed, 2)
            self.assertTrue(stub.done.wait(20), "complete was never called")
            time.sleep(0.5)
            self.assertEqual(os.listdir(work), [], "temp files left behind")
        stub.close()

        methods = [(m, p.split("?")[0]) for m, p, _ in stub.requests]
        self.assertEqual(methods, [
            ("POST", "/v1/trajectory-uploads/" + TOKEN),
            ("PUT", "/bucket/s1.jsonl.gz"),
            ("POST", "/v1/trajectory-uploads/%s/complete" % TOKEN),
        ])
        start = stub.requests[0][2]
        self.assertEqual(start["harness"], "claude_code")
        self.assertEqual(start["harness_version"], "2.1.263")
        self.assertEqual(start["format"], "claude_code_jsonl")
        self.assertEqual([f["name"] for f in start["files"]], ["s1.jsonl.gz", "agent-a.jsonl.gz"])

        headers, body = stub.puts["s1.jsonl.gz"]
        headers = {k.lower(): v for k, v in headers.items()}  # header names are case-insensitive
        self.assertEqual(headers["content-type"], "application/gzip")
        self.assertEqual(headers["x-amz-meta-klank"], "1")
        self.assertEqual(headers["content-length"], str(len(body)))
        declared = start["files"][0]
        self.assertEqual(declared["bytes"], len(body))
        self.assertEqual(declared["sha256"], hashlib.sha256(body).hexdigest())
        text = gzip.decompress(body).decode()
        for kind, part in SECRET_PARTS.items():
            self.assertNotIn(part, text, kind)

        complete = stub.requests[2][2]
        self.assertEqual(set(complete), {"redaction"})
        self.assertEqual(complete["redaction"]["version"], kt.REDACTION_VERSION)
        counts = complete["redaction"]["counts"]
        for kind in SECRET_PARTS:
            self.assertGreaterEqual(counts[kind], 1, kind)


if __name__ == "__main__":
    unittest.main(verbosity=1)
