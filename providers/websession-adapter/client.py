#!/usr/bin/env python3
"""Minimal WebSession HTTP client. Standard library only.

The capability stays in memory. Never write it to disk.

Environment:
  WS_BASE          WebSession base URL, for example https://mcp.example.com
  WS_CAP           capability secret
  WS_MAX_OUTPUT    call/sh display limit in UTF-8 bytes, default 8192
                   (0 prints the complete result)

Usage:
  client.py about
  client.py tools
  client.py schema TOOL
  client.py call TOOL '{"key":"value"}'
  client.py sh 'command to run'

Response formats by route:
  /v1/about        text
  /v1/tools        JSON
  /v1/tools/NAME   JSON
  /v1/calls        JSON
  status_url       JSON
  chunk URLs       JSON
"""

import http.client
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

POLL_SECONDS = 90.0
MAX_WAIT_SECONDS = 90
TIMEOUT_SECONDS = 120
DEFAULT_MAX_OUTPUT = 8192
TERMINAL_STATES = ("completed", "tool_failed", "unknown_outcome", "rejected", "expired")
USAGE = "usage: client.py about|tools|schema TOOL|call TOOL JSON|sh COMMAND"


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


def submission_unknown(message):
    fail("%s; submission outcome unknown; do not retry; check whether the tool ran" % message, 2)


def base_url():
    base = os.environ.get("WS_BASE", "").rstrip("/")
    if not base.startswith("http"):
        fail("set WS_BASE to the WebSession base URL")
    return base


def capability():
    value = os.environ.get("WS_CAP", "")
    if not value:
        fail("set WS_CAP to the capability secret")
    return value


def output_limit():
    value = os.environ.get("WS_MAX_OUTPUT")
    if value is None:
        return DEFAULT_MAX_OUTPUT
    if re.fullmatch(r"[0-9]+", value) is None:
        fail("WS_MAX_OUTPUT must be a nonnegative ASCII decimal byte count")
    try:
        return int(value)
    except ValueError:
        fail("WS_MAX_OUTPUT is too large")


def save_output(text):
    path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", delete=False, prefix="webharness-result-", suffix=".txt"
        ) as handle:
            path = handle.name
            handle.write(text.encode("utf-8"))
    except OSError as error:
        if path is not None:
            try:
                os.unlink(path)
            except OSError:
                pass
        return None, str(error)
    return path, None


def render_output(text, limit):
    raw = text.encode("utf-8")
    if limit == 0 or len(raw) <= limit:
        return text
    prefix_budget = (limit * 3) // 4
    suffix_budget = limit - prefix_budget
    prefix = raw[:prefix_budget].decode("utf-8", "ignore")
    suffix = raw[len(raw) - suffix_budget:].decode("utf-8", "ignore") if suffix_budget else ""
    shown = len(prefix.encode("utf-8")) + len(suffix.encode("utf-8"))
    path, error = save_output(text)
    saved = "full output: %s" % path if path else "full output not saved: %s; do not rerun the tool" % error
    notice = (
        "\n[ws: %d of %d bytes shown, middle omitted; %s; "
        "WS_MAX_OUTPUT=0 prints everything]\n" % (shown, len(raw), saved)
    )
    return prefix + notice + suffix


def with_wait(url, seconds):
    parts = urllib.parse.urlsplit(url)
    query = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if key != "wait"
    ]
    query.append(("wait", str(seconds)))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def request(url, cap=None, method="GET", body=None):
    headers = {"Accept": "application/json"}
    if cap:
        headers["Authorization"] = "Bearer " + cap
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Idempotency-Key"] = uuid.uuid4().hex
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            return response.headers.get("content-type", ""), response.read()
    except urllib.error.HTTPError as error:
        if method == "POST" and error.code >= 500:
            submission_unknown("HTTP %d from %s" % (error.code, url))
        try:
            raw = error.read()[:300].decode("utf-8", "replace")
        except (http.client.HTTPException, OSError):
            raw = "unreadable error response"
        fail("HTTP %d from %s: %s" % (error.code, url, raw))
    except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as error:
        message = "request failed for %s: %s" % (url, getattr(error, "reason", error))
        if method == "POST":
            submission_unknown(message)
        fail(message)


def request_json(url, cap=None, method="GET", body=None):
    content_type, raw = request(url, cap, method, body)
    if "json" not in content_type:
        text = raw[:200].decode("utf-8", "replace")
        message = "expected JSON from %s but got %s: %s" % (url, content_type or "no content type", text)
        if method == "POST":
            submission_unknown(message)
        fail(message)
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        if method == "POST":
            submission_unknown("invalid JSON submission response")
        fail("invalid JSON response from %s" % url)


def about():
    content_type, raw = request(base_url() + "/v1/about")
    text = raw.decode("utf-8", "replace")
    if not text.startswith("WEBSESSION-MCP-BRIDGE/1"):
        fail("not a WebSession endpoint: %s %s" % (content_type, text[:120]))
    return text


def tools():
    return request_json(base_url() + "/v1/tools", capability())


def schema(name):
    data = request_json(base_url() + "/v1/tools/" + name, capability())
    return data.get("tool", data)


def operation_snapshot(data, submission=False):
    valid = isinstance(data, dict) and isinstance(data.get("state"), str)
    if valid and data["state"] in ("queued", "running"):
        valid = isinstance(data.get("status_url"), str) and bool(data["status_url"])
    if valid and data["state"] == "completed":
        count = data.get("chunk_count", 1)
        valid = type(count) is int and count > 0
        if valid:
            field = "result" if count == 1 else "chunk_base_url"
            valid = isinstance(data.get(field), str)
            if count > 1:
                valid = valid and bool(data[field])
    if not valid:
        if submission:
            submission_unknown("invalid operation snapshot")
        fail("invalid operation snapshot; do not resubmit the tool")
    return data


def call(tool, arguments):
    deadline = time.monotonic() + POLL_SECONDS
    data = operation_snapshot(request_json(
        base_url() + "/v1/calls?wait=0",
        capability(),
        "POST",
        {"version": 1, "tool": tool, "arguments": arguments},
    ), submission=True)
    while data.get("state") not in TERMINAL_STATES:
        if data.get("state") not in ("queued", "running"):
            fail("unsupported operation state %s; do not resubmit the tool" % data.get("state"))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail("operation still %s; poll %s later" % (data.get("state"), data.get("status_url")))
        hold = min(MAX_WAIT_SECONDS, int(remaining))
        data = operation_snapshot(request_json(with_wait(data["status_url"], hold)))
        if hold == 0 and data.get("state") not in TERMINAL_STATES:
            fail("operation still %s; poll %s later" % (data.get("state"), data.get("status_url")))
    if data.get("state") != "completed":
        message = data.get("error") or data.get("state", "unknown state")
        if data.get("state") == "unknown_outcome":
            fail("%s; do not retry; check whether the tool ran" % message, 2)
        fail("%s; do not retry a mutating tool without checking its effects" % message)
    count = int(data.get("chunk_count", 1))
    if count == 1:
        return data.get("result", "")
    parts = []
    chunk_base = data["chunk_base_url"]
    for number in range(1, count + 1):
        chunk = request_json(chunk_base + str(number))
        if not isinstance(chunk, dict) or not isinstance(chunk.get("content"), str):
            fail("invalid result chunk; do not resubmit the tool")
        parts.append(chunk["content"])
    return "".join(parts)


def main(argv):
    if len(argv) < 2:
        fail(USAGE)
    command = argv[1]
    if command == "about":
        print(about().strip())
    elif command == "tools":
        data = tools()
        print("tool_count: %s" % data.get("tool_count"))
        for name in data.get("tools", []):
            print(name)
    elif command == "schema" and len(argv) > 2:
        print(json.dumps(schema(argv[2]), indent=2))
    elif command == "call" and len(argv) > 3:
        limit = output_limit()
        print(render_output(call(argv[2], json.loads(argv[3])), limit))
    elif command == "sh" and len(argv) > 2:
        limit = output_limit()
        print(render_output(call("dev_1mcp_bash", {"command": " ".join(argv[2:])}), limit))
    else:
        fail(USAGE)


if __name__ == "__main__":
    main(sys.argv)
