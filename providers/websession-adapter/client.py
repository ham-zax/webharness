#!/usr/bin/env python3
"""Minimal WebSession HTTP client. Standard library only.

The capability stays in memory. Never write it to disk.

Environment:
  WS_BASE  WebSession base URL, for example https://mcp.example.com
  WS_CAP   capability secret

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

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

POLL_SECONDS = 90.0
POLL_INTERVAL = 1.5
TIMEOUT_SECONDS = 120
TERMINAL_STATES = ("completed", "tool_failed", "unknown_outcome", "rejected", "expired")
USAGE = "usage: client.py about|tools|schema TOOL|call TOOL JSON|sh COMMAND"


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


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
        raw = error.read()[:300].decode("utf-8", "replace")
        fail("HTTP %d from %s: %s" % (error.code, url, raw))
    except urllib.error.URLError as error:
        fail("request failed for %s: %s" % (url, error.reason))


def request_json(url, cap=None, method="GET", body=None):
    content_type, raw = request(url, cap, method, body)
    if "json" not in content_type:
        text = raw[:200].decode("utf-8", "replace")
        fail("expected JSON from %s but got %s: %s" % (url, content_type or "no content type", text))
    return json.loads(raw)


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


def call(tool, arguments):
    data = request_json(
        base_url() + "/v1/calls",
        capability(),
        "POST",
        {"version": 1, "tool": tool, "arguments": arguments},
    )
    deadline = time.time() + POLL_SECONDS
    while data.get("state") not in TERMINAL_STATES:
        if time.time() > deadline:
            fail("operation still %s; poll %s later" % (data.get("state"), data.get("status_url")))
        time.sleep(POLL_INTERVAL)
        data = request_json(data["status_url"])
    if data.get("state") != "completed":
        fail(data.get("error") or data.get("state", "unknown state"))
    count = int(data.get("chunk_count", 1))
    if count == 1:
        return data.get("result", "")
    parts = []
    chunk_base = data["chunk_base_url"]
    for number in range(1, count + 1):
        chunk = request_json(chunk_base + str(number))
        parts.append(chunk.get("content", ""))
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
        print(call(argv[2], json.loads(argv[3])))
    elif command == "sh" and len(argv) > 2:
        print(call("dev_1mcp_bash", {"command": " ".join(argv[2:])}))
    else:
        fail(USAGE)


if __name__ == "__main__":
    main(sys.argv)
