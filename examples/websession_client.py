#!/usr/bin/env python3
"""Minimal zero-dependency WebSession HTTPS client for AI agents.

Usage:
  export WS_TOKEN="<capability-token>"
  export WS_BASE_URL="https://mcp.example.com"  # optional

  python3 examples/websession_client.py instructions
  python3 examples/websession_client.py signatures
  python3 examples/websession_client.py cwd /path/to/repo
  python3 examples/websession_client.py call dev_read '{"path":"README.md","limit":50}'
  python3 examples/websession_client.py call dev_bash '{"command":"git status -sb"}' 10
  python3 examples/websession_client.py batch '[{"tool":"dev_read","arguments":{"path":"README.md","limit":20}}]'
"""

from __future__ import annotations

import json
import http.client
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

DEFAULT_BASE_URL = "https://mcp.example.com"


class SubmissionUnknown(RuntimeError):
    """The request may have executed. Check effects before submitting again."""


def _base_url() -> str:
    return os.environ.get("WS_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def _token() -> str:
    token = os.environ.get("WS_TOKEN") or os.environ.get("WEBSESSION_TOKEN")
    if not token:
        raise RuntimeError("Set WS_TOKEN or WEBSESSION_TOKEN in the environment.")
    return token


def req_json(
    method: str,
    path_or_url: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: int = 30,
) -> dict[str, Any]:
    url = path_or_url if path_or_url.startswith("http") else _base_url() + path_or_url
    headers = {
        "Authorization": f"Bearer {_token()}",
        "User-Agent": "websession-client/1.0",
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if method == "POST":
        headers["Idempotency-Key"] = uuid.uuid4().hex
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            value = json.loads(resp.read().decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("Expected a JSON object")
            return value
    except urllib.error.HTTPError as exc:
        if method == "POST" and exc.code >= 500:
            raise SubmissionUnknown("Submission may have succeeded. Do not automatically retry.") from exc
        raise
    except (OSError, http.client.HTTPException, ValueError) as exc:
        if method == "POST":
            raise SubmissionUnknown("Submission response was lost or invalid. Do not automatically retry.") from exc
        raise


def call_tool(
    tool: str,
    arguments: dict[str, Any],
    *,
    wait: int = 2,
    poll_wait: int = 30,
) -> Any:
    res = req_json(
        "POST",
        f"/v1/calls?wait={wait}",
        {"version": 1, "tool": tool, "arguments": arguments},
        timeout=max(30, wait + 15),
    )
    return resolve_operation(res, tool=tool, poll_wait=poll_wait)


def resolve_operation(res: dict[str, Any], *, tool: str, poll_wait: int = 30) -> Any:
    while res.get("state") in ("queued", "running"):
        status_url = res.get("status_url")
        if not isinstance(status_url, str):
            raise SubmissionUnknown("Missing recovery URL. Check effects before submitting again.")
        sep = "&" if "?" in status_url else "?"
        for attempt in range(3):
            try:
                res = req_json(
                    "GET", f"{status_url}{sep}wait={poll_wait}", timeout=poll_wait + 15
                )
                break
            except urllib.error.HTTPError as exc:
                if exc.code in (502, 503, 504) and attempt < 2:
                    time.sleep(1)
                    continue
                raise
    state = res.get("state")
    if state == "unknown_outcome":
        raise SubmissionUnknown(f"Tool {tool} has an unknown outcome. Do not automatically retry.")
    if state != "completed":
        raise RuntimeError(f"Tool {tool} ended in state {state}: {res.get('error', '')}")
    chunk_count = int(res.get("chunk_count", 1))
    if chunk_count == 1:
        return res.get("result")
    base = res["chunk_base_url"]
    return "".join(req_json("GET", f"{base}{i}")["content"] for i in range(1, chunk_count + 1))


def call_batch(calls: list[dict[str, Any]], *, sequential: bool, continue_on_error: bool) -> tuple[list[Any], int]:
    if continue_on_error and not sequential:
        raise ValueError("--continue requires --seq")
    body: dict[str, Any] = {"version": 1, "calls": calls}
    if sequential:
        body.update(sequential=True, stop_on_error=not continue_on_error)
    res = req_json("POST", "/v1/batch?wait=10", body, timeout=45)
    snapshots = res.get("results")
    if res.get("state") != "ready" or not isinstance(snapshots, list) or len(snapshots) != len(calls):
        raise SubmissionUnknown("Invalid batch response. Do not automatically retry.")
    outputs = []
    exit_code = 0
    for index, snapshot in enumerate(snapshots):
        try:
            outputs.append({"index": index, "result": resolve_operation(snapshot, tool=calls[index]["tool"])})
        except SubmissionUnknown as exc:
            outputs.append({"index": index, "error": str(exc)})
            exit_code = 2
        except (RuntimeError, OSError, http.client.HTTPException, ValueError, KeyError) as exc:
            outputs.append({"index": index, "error": str(exc)})
            exit_code = max(exit_code, 1)
    return outputs, exit_code


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd = argv[1]
    exit_code = 0
    if cmd == "instructions":
        out: Any = req_json("GET", "/v1/instructions")
    elif cmd == "signatures":
        out = req_json("GET", "/v1/signatures")
    elif cmd == "cwd":
        if len(argv) >= 3:
            out = req_json("POST", "/v1/cwd", {"cwd": argv[2]})
        else:
            out = req_json("GET", "/v1/cwd")
    elif cmd == "call":
        tool = argv[2]
        args = json.loads(argv[3]) if len(argv) >= 4 else {}
        wait = int(argv[4]) if len(argv) >= 5 else 2
        out = call_tool(tool, args, wait=wait)
    elif cmd == "batch":
        calls = json.loads(argv[2])
        flags = set(argv[3:])
        if flags - {"--seq", "--continue"}:
            raise ValueError("batch accepts --seq and --continue")
        out, exit_code = call_batch(calls, sequential="--seq" in flags, continue_on_error="--continue" in flags)
    else:
        print(f"Unknown subcommand: {cmd}", file=sys.stderr)
        return 2
    print(out if isinstance(out, str) else json.dumps(out, indent=2))
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except SubmissionUnknown as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
    except (RuntimeError, OSError, http.client.HTTPException, ValueError, KeyError, IndexError) as exc:
        print(f"{exc}. Do not retry a mutation without checking its effects.", file=sys.stderr)
        raise SystemExit(1)
