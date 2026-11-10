#!/usr/bin/env python3
"""Canonical WebSession HTTP client and workstation harness CLI. Standard library only.

Environment:
  WS_BASE          WebSession base URL, e.g. https://mcp.example.com (overrides session file)
  WS_CAP           capability secret (overrides session file; stays in memory when set)
  WS_CWD           optional default remote working directory (overrides session file)
  WS_WAIT          initial POST wait=N seconds, 0..90 (default 2)
  WS_TURN_ID       optional monotonically increasing turn number
  WS_MAX_OUTPUT    display limit in UTF-8 bytes, default 8192 (0 prints everything)
  WH_SESSION_FILE  optional session file path, default ~/.wh/session.json (mode 0600)

Usage:
  client.py connect BASE PAIR_CODE [--cwd DIR]
  client.py about | tools [--names] | sigs | instructions | schema TOOL
  client.py pwd | cd DIR | cd --clear | ls [PATH] [--limit N]
  client.py read PATH [OFFSET] [LIMIT] [--outline] | read --targets [JSON|@FILE|-]
  client.py rg PATTERN [PATH] [-g GLOB]... [-m MAX] [--all]
  client.py edit [JSON|@FILE|-]
  client.py write PATH [--overwrite] [--mkdir] [--mode OCTAL]
  client.py review [PATH...]
  client.py batch [JSON|@FILE|-]
  client.py call [--unwrap] TOOL [JSON|@FILE|-]
  client.py sh COMMAND... | sh - | sh < script.sh
"""

import http.client
import json
import os
import posixpath
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
USER_AGENT = "websession-client/1.0"
TERMINAL_STATES = ("completed", "tool_failed", "unknown_outcome", "rejected", "expired")
CWD_INJECT_TOOLS = ("dev_1mcp_bash", "dev_1mcp_exec", "dev_1mcp_review_changes", "dev_1mcp_file_ops")
OPTIONAL_PATH_CWD_TOOLS = ("dev_1mcp_list_directory", "dev_1mcp_search")
PATH_RESOLVE_TOOLS = ("dev_1mcp_read", "dev_1mcp_list_directory", "dev_1mcp_search", "dev_1mcp_write")
USAGE = (
    "usage: client.py connect BASE CODE [--cwd DIR]|about|tools [--names]|sigs|instructions|"
    "schema TOOL|pwd|cd DIR|ls [PATH]|read PATH [OFFSET] [LIMIT] [--outline]|"
    "rg PATTERN [PATH]|edit [JSON|@FILE|-]|write PATH|review [PATH...]|"
    "batch [JSON|@FILE|-]|call TOOL [JSON|@FILE|-]|sh COMMAND|sh -"
)


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


def submission_unknown(message):
    fail("%s; submission outcome unknown; do not retry; check whether the tool ran" % message, 2)


def session_file_path():
    custom = os.environ.get("WH_SESSION_FILE", "")
    return custom if custom else os.path.expanduser("~/.wh/session.json")


def load_session():
    path = session_file_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        fail("invalid session file %s: %s" % (path, error))
    if not isinstance(data, dict):
        fail("invalid session file %s: expected JSON object" % path)
    return data


def save_session(data):
    path = os.path.abspath(session_file_path())
    parent = os.path.dirname(path)
    tmp_path = None
    try:
        os.makedirs(parent, mode=0o700, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=parent, prefix=".session-", suffix=".tmp", delete=False
        ) as handle:
            tmp_path = handle.name
            os.chmod(tmp_path, 0o600)
            json.dump(data, handle)
            handle.write("\n")
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
    except OSError as error:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        fail("failed to save session file %s: %s" % (path, error))


def base_url():
    env_base = os.environ.get("WS_BASE", "")
    base = (env_base if env_base else str(load_session().get("base", ""))).rstrip("/")
    if not base.startswith("http"):
        fail("set WS_BASE to the WebSession base URL")
    return base


def capability():
    env_cap = os.environ.get("WS_CAP", "")
    value = env_cap if env_cap else str(load_session().get("cap", ""))
    if not value:
        fail("set WS_CAP to the capability secret")
    return value


def sticky_cwd():
    if "WS_CWD" in os.environ:
        val = os.environ["WS_CWD"]
        return val if val else None
    if os.environ.get("WS_CAP", ""):
        return None
    cwd = load_session().get("cwd")
    return cwd if isinstance(cwd, str) and cwd else None


def effective_wait():
    raw = os.environ.get("WS_WAIT")
    if raw is not None:
        if re.fullmatch(r"[0-9]+", raw) is None:
            fail("WS_WAIT must be an integer from 0 to 90")
        value = int(raw)
        if value > MAX_WAIT_SECONDS:
            fail("WS_WAIT must be an integer from 0 to 90")
        return value
    if os.environ.get("WS_CAP", ""):
        return 2
    wait_val = load_session().get("wait", 2)
    if type(wait_val) is int and 0 <= wait_val <= MAX_WAIT_SECONDS:
        return wait_val
    return 2


def resolve_remote_path(raw_path, cwd=None):
    if cwd is None:
        cwd = sticky_cwd()
    if not raw_path:
        return cwd
    if raw_path == "~" or raw_path.startswith("~/"):
        return raw_path
    if raw_path.startswith("/"):
        return raw_path
    if not cwd:
        return raw_path
    if cwd == "~":
        rel = posixpath.normpath(raw_path)
        return "~" if rel == "." else "~/" + rel.lstrip("/")
    if cwd.startswith("~/"):
        rel = posixpath.normpath(posixpath.join(cwd[2:], raw_path))
        if rel == ".":
            return "~"
        if not rel.startswith(".."):
            return "~/" + rel
    return posixpath.normpath(posixpath.join(cwd, raw_path))


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
    saved = (
        "saved in local sandbox: %s" % path
        if path
        else "local sandbox file not saved: %s; do not rerun the tool" % error
    )
    notice = (
        "\n[ws: %d of %d bytes shown, middle omitted; %s; "
        "WS_MAX_OUTPUT=0 prints everything]\n" % (shown, len(raw), saved)
    )
    return prefix + notice + suffix


def unwrap_mcp_text(text):
    if not text or not text.startswith("{"):
        return text
    try:
        data = json.loads(text)
    except ValueError:
        return text
    if not isinstance(data, dict) or "structuredContent" not in data:
        return text
    content = data.get("content")
    if not isinstance(content, list) or not content:
        return text
    parts = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
            return text
        parts.append(block["text"])
    return "\n".join(parts)


def with_wait(url, seconds):
    parts = urllib.parse.urlsplit(url)
    query = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if key != "wait"
    ]
    query.append(("wait", str(seconds)))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def request(url, cap=None, method="GET", body=None, idempotent_submission=True):
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if cap:
        headers["Authorization"] = "Bearer " + cap
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        if idempotent_submission:
            headers["Idempotency-Key"] = uuid.uuid4().hex
            if os.environ.get("WS_TURN_ID") is not None:
                headers["X-Turn-Id"] = os.environ["WS_TURN_ID"]
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            return response.headers.get("content-type", ""), response.read()
    except urllib.error.HTTPError as error:
        if method == "POST" and idempotent_submission and error.code >= 500:
            submission_unknown("HTTP %d from %s" % (error.code, url))
        try:
            raw = error.read()[:300].decode("utf-8", "replace")
        except (http.client.HTTPException, OSError):
            raw = "unreadable error response"
        fail("HTTP %d from %s: %s" % (error.code, url, raw))
    except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as error:
        message = "request failed for %s: %s" % (url, getattr(error, "reason", error))
        if method == "POST" and idempotent_submission:
            submission_unknown(message)
        fail(message)


def request_json(url, cap=None, method="GET", body=None, idempotent_submission=True):
    content_type, raw = request(url, cap, method, body, idempotent_submission=idempotent_submission)
    if "json" not in content_type:
        text = raw[:200].decode("utf-8", "replace")
        message = "expected JSON from %s but got %s: %s" % (url, content_type or "no content type", text)
        if method == "POST" and idempotent_submission:
            submission_unknown(message)
        fail(message)
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        if method == "POST" and idempotent_submission:
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


def signatures_list(base=None, cap=None):
    target_base = (base or base_url()).rstrip("/")
    target_cap = cap or capability()
    return request_json(target_base + "/v1/signatures", target_cap)


def instructions_text():
    data = request_json(base_url() + "/v1/instructions", capability())
    value = data.get("instructions", "")
    return value if isinstance(value, str) else ""


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


def resolve_operation(data, deadline):
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


def call(tool, arguments, wait_override=None):
    initial_wait = effective_wait() if wait_override is None else wait_override
    deadline = time.monotonic() + POLL_SECONDS
    data = operation_snapshot(request_json(
        base_url() + ("/v1/calls?wait=%d" % initial_wait),
        capability(),
        "POST",
        {"version": 1, "tool": tool, "arguments": arguments},
    ), submission=True)
    return resolve_operation(data, deadline)


def load_json_source(spec, default_empty_object=False):
    if spec is None:
        if default_empty_object:
            return {}
        raw = sys.stdin.read()
    elif spec == "-":
        raw = sys.stdin.read()
    elif spec.startswith("@"):
        file_path = spec[1:]
        if not file_path:
            fail("missing file path after @")
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except OSError as error:
            fail("failed to read %s: %s" % (file_path, error))
    else:
        raw = spec
    try:
        return json.loads(raw)
    except ValueError as error:
        fail("invalid JSON input: %s" % error)


def parse_positive_int(value, label):
    if re.fullmatch(r"[1-9][0-9]*", value) is None:
        fail("%s must be a positive integer" % label)
    return int(value)


def cmd_connect(args):
    explicit_cwd = None
    positional = []
    index = 0
    while index < len(args):
        if args[index] == "--cwd":
            if index + 1 >= len(args):
                fail("usage: client.py connect BASE PAIR_CODE [--cwd DIR]")
            explicit_cwd = args[index + 1]
            index += 2
        else:
            positional.append(args[index])
            index += 1
    if len(positional) != 2:
        fail("usage: client.py connect BASE PAIR_CODE [--cwd DIR]")
    target_base = positional[0].rstrip("/")
    pair_code = positional[1].strip()
    if not target_base.startswith("http") or not pair_code:
        fail("usage: client.py connect BASE PAIR_CODE [--cwd DIR]")
    paired = request_json(
        target_base + "/v1/pair",
        cap=None,
        method="POST",
        body={"code": pair_code},
        idempotent_submission=False,
    )
    cap = paired.get("capability") if isinstance(paired, dict) else None
    if not isinstance(paired, dict) or paired.get("state") != "ready" or not isinstance(cap, str) or not cap:
        fail("pairing failed: unexpected server response")
    cwd = explicit_cwd if explicit_cwd is not None else paired.get("default_cwd")
    if cwd is not None and (not isinstance(cwd, str) or not cwd):
        cwd = None
    sig_data = signatures_list(target_base, cap)
    sigs = sig_data.get("signatures", []) if isinstance(sig_data, dict) else []
    if cwd is None and isinstance(sig_data, dict) and isinstance(sig_data.get("default_cwd"), str):
        cwd = sig_data["default_cwd"] or None
    session = {"base": target_base, "cap": cap, "wait": 2}
    if cwd:
        session["cwd"] = cwd
    save_session(session)
    print("CONNECTED")
    print("base: %s" % target_base)
    print("cwd: %s" % (cwd if cwd else "(default)"))
    print("tools: %d" % len(sigs))
    for line in sigs:
        print(line)


def cmd_cd(args):
    if len(args) != 1:
        fail("usage: client.py cd DIR|--clear")
    session = load_session()
    if not session.get("base") and os.environ.get("WS_BASE"):
        session["base"] = os.environ["WS_BASE"].rstrip("/")
    if not session.get("cap") and os.environ.get("WS_CAP"):
        session["cap"] = os.environ["WS_CAP"]
    if not session.get("base") or not session.get("cap"):
        fail("no active session; run client.py connect first")
    if args[0] == "--clear":
        session.pop("cwd", None)
        save_session(session)
        print("cwd: (default)")
        return
    if args[0] == "~" or args[0].startswith("~/"):
        home_lines = unwrap_mcp_text(call("dev_1mcp_bash", {"command": "printf '%s\\n' \"$HOME\""})).splitlines()
        remote_home = home_lines[0].strip() if home_lines else ""
        if not remote_home or not remote_home.startswith("/"):
            fail("could not resolve remote HOME for ~")
        suffix = args[0][2:] if args[0].startswith("~/") else ""
        new_cwd = posixpath.normpath(posixpath.join(remote_home, suffix) if suffix else remote_home)
    else:
        new_cwd = resolve_remote_path(args[0], session.get("cwd"))
    session["cwd"] = new_cwd
    save_session(session)
    print("cwd: %s" % new_cwd)


def cmd_ls(args):
    limit = output_limit()
    path_arg = None
    entry_limit = None
    index = 0
    while index < len(args):
        if args[index] == "--limit":
            if index + 1 >= len(args):
                fail("usage: client.py ls [PATH] [--limit N]")
            entry_limit = parse_positive_int(args[index + 1], "--limit")
            index += 2
        elif path_arg is None and not args[index].startswith("-"):
            path_arg = args[index]
            index += 1
        else:
            fail("usage: client.py ls [PATH] [--limit N]")
    payload = {}
    resolved = resolve_remote_path(path_arg) if path_arg is not None else sticky_cwd()
    if resolved:
        payload["path"] = resolved
    if entry_limit is not None:
        payload["limit"] = entry_limit
    print(render_output(unwrap_mcp_text(call("dev_1mcp_list_directory", payload)), limit))


def cmd_read(args):
    limit = output_limit()
    if args and args[0] == "--targets":
        if len(args) > 2:
            fail("usage: client.py read --targets [JSON|@FILE|-]")
        spec = args[1] if len(args) == 2 else None
        loaded = load_json_source(spec)
        targets = loaded.get("targets") if isinstance(loaded, dict) else loaded
        if not isinstance(targets, list) or not targets:
            fail("read --targets expects a non-empty targets list or {\"targets\": [...]}")
        normalized_targets = []
        for item in targets:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not item["path"]:
                fail("each read target must be an object with a non-empty path")
            copy = dict(item)
            copy["path"] = resolve_remote_path(copy["path"])
            normalized_targets.append(copy)
        payload = dict(loaded) if isinstance(loaded, dict) else {}
        payload["targets"] = normalized_targets
        print(render_output(unwrap_mcp_text(call("dev_1mcp_read", payload)), limit))
        return

    outline = False
    positional = []
    for item in args:
        if item == "--outline":
            outline = True
        elif item.startswith("-"):
            fail("usage: client.py read PATH [OFFSET] [LIMIT] [--outline]")
        else:
            positional.append(item)
    if not positional or len(positional) > 3:
        fail("usage: client.py read PATH [OFFSET] [LIMIT] [--outline]")
    payload = {"path": resolve_remote_path(positional[0])}
    if len(positional) >= 2:
        payload["offset"] = parse_positive_int(positional[1], "offset")
    if len(positional) == 3:
        payload["limit"] = parse_positive_int(positional[2], "limit")
    if outline:
        payload["mode"] = "outline"
    print(render_output(unwrap_mcp_text(call("dev_1mcp_read", payload)), limit))


def cmd_rg(args):
    limit = output_limit()
    globs = []
    max_count = 80
    include_all = False
    literal = False
    case_sensitive = None
    positional = []
    index = 0
    rg_usage = "usage: client.py rg PATTERN [PATH] [-g GLOB]... [-m MAX] [-F] [-s|-i] [--all]"
    while index < len(args):
        token = args[index]
        if token == "--all":
            include_all = True
            index += 1
        elif token in ("-F", "--fixed-strings"):
            literal = True
            index += 1
        elif token in ("-s", "--case-sensitive"):
            case_sensitive = True
            index += 1
        elif token in ("-i", "--ignore-case"):
            case_sensitive = False
            index += 1
        elif token == "-g":
            if index + 1 >= len(args):
                fail(rg_usage)
            globs.append(args[index + 1])
            index += 2
        elif token == "-m":
            if index + 1 >= len(args):
                fail(rg_usage)
            max_count = parse_positive_int(args[index + 1], "-m")
            index += 2
        elif token == "--":
            positional.extend(args[index + 1:])
            break
        elif token.startswith("-") and positional:
            fail(rg_usage)
        else:
            positional.append(token)
            index += 1
    if not positional or len(positional) > 2:
        fail(rg_usage)
    payload = {"pattern": positional[0], "max_results": max_count}
    resolved_path = resolve_remote_path(positional[1]) if len(positional) == 2 else sticky_cwd()
    if resolved_path:
        payload["path"] = resolved_path
    if globs:
        payload["globs"] = globs
    if literal:
        payload["literal"] = True
    if case_sensitive is not None:
        payload["case_sensitive"] = case_sensitive
    if include_all:
        payload["include_vendor"] = True
    print(render_output(unwrap_mcp_text(call("dev_1mcp_search", payload)), limit))


def cmd_edit(args):
    limit = output_limit()
    if len(args) > 1:
        fail("usage: client.py edit [JSON|@FILE|-]")
    loaded = load_json_source(args[0] if args else None)
    if not isinstance(loaded, dict):
        fail("edit expects a JSON object")
    payload = {}
    if isinstance(loaded.get("diff"), bool):
        payload["diff"] = loaded["diff"]
    if "targets" in loaded:
        if not isinstance(loaded["targets"], list) or not loaded["targets"]:
            fail("edit targets must be a non-empty list")
        targets = []
        for target in loaded["targets"]:
            if not isinstance(target, dict) or not isinstance(target.get("path"), str):
                fail("each edit target requires a string path")
            copy = dict(target)
            copy["path"] = resolve_remote_path(copy["path"])
            targets.append(copy)
        payload["targets"] = targets
    elif isinstance(loaded.get("path"), str) and isinstance(loaded.get("edits"), list):
        payload["targets"] = [{
            "path": resolve_remote_path(loaded["path"]),
            "edits": loaded["edits"],
        }]
    elif (
        isinstance(loaded.get("path"), str)
        and isinstance(loaded.get("oldText"), str)
        and isinstance(loaded.get("newText"), str)
    ):
        payload["targets"] = [{
            "path": resolve_remote_path(loaded["path"]),
            "edits": [{"oldText": loaded["oldText"], "newText": loaded["newText"]}],
        }]
    else:
        fail("edit requires {\"targets\": [...]} or {\"path\": ..., \"oldText\": ..., \"newText\": ...}")
    print(render_output(unwrap_mcp_text(call("dev_1mcp_edit", payload)), limit))


def cmd_write(args):
    limit = output_limit()
    overwrite = False
    mkdir_parents = False
    mode_val = None
    positional = []
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--overwrite":
            overwrite = True
            index += 1
        elif token == "--mkdir":
            mkdir_parents = True
            index += 1
        elif token == "--mode":
            if index + 1 >= len(args):
                fail("usage: client.py write PATH [--overwrite] [--mkdir] [--mode OCTAL]")
            mode_val = args[index + 1]
            index += 2
        elif token.startswith("-"):
            fail("usage: client.py write PATH [--overwrite] [--mkdir] [--mode OCTAL]")
        else:
            positional.append(token)
            index += 1
    if len(positional) != 1:
        fail("usage: client.py write PATH [--overwrite] [--mkdir] [--mode OCTAL]")
    content = sys.stdin.read()
    payload = {"path": resolve_remote_path(positional[0]), "content": content}
    if overwrite:
        payload["overwrite"] = True
    if mkdir_parents:
        payload["mkdir_parents"] = True
    if mode_val is not None:
        payload["mode"] = mode_val
    print(render_output(unwrap_mcp_text(call("dev_1mcp_write", payload)), limit))


def cmd_review(args):
    limit = output_limit()
    payload = {}
    cwd = sticky_cwd()
    if cwd:
        payload["cwd"] = cwd
    if args:
        payload["paths"] = list(args)
    print(render_output(unwrap_mcp_text(call("dev_1mcp_review_changes", payload)), limit))


def prepare_batch_arguments(tool_name, raw_args):
    args = dict(raw_args)
    cwd = sticky_cwd()
    if cwd and tool_name in CWD_INJECT_TOOLS and "cwd" not in args:
        args["cwd"] = cwd
    if cwd and tool_name in OPTIONAL_PATH_CWD_TOOLS and "path" not in args:
        args["path"] = cwd
    elif tool_name in PATH_RESOLVE_TOOLS and isinstance(args.get("path"), str):
        args["path"] = resolve_remote_path(args["path"], cwd)
    if tool_name in ("dev_1mcp_read", "dev_1mcp_edit") and isinstance(args.get("targets"), list):
        resolved_targets = []
        for item in args["targets"]:
            if isinstance(item, dict) and isinstance(item.get("path"), str):
                copy = dict(item)
                copy["path"] = resolve_remote_path(copy["path"], cwd)
                resolved_targets.append(copy)
            else:
                resolved_targets.append(item)
        args["targets"] = resolved_targets
    return args


def cmd_batch(args):
    limit = output_limit()
    if len(args) > 1:
        fail("usage: client.py batch [JSON|@FILE|-]")
    items = load_json_source(args[0] if args else None)
    if not isinstance(items, list) or not items or len(items) > 20:
        fail("batch expects a JSON array of 1 to 20 {\"tool\": ..., \"arguments\": {...}} items")
    total = len(items)
    validated = []
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get("tool"), str) or not item["tool"]:
            fail("batch[%d] requires a non-empty tool name" % index)
        item_args = item.get("arguments", {})
        if not isinstance(item_args, dict):
            fail("batch[%d].arguments must be an object" % index)
        validated.append((item["tool"], prepare_batch_arguments(item["tool"], item_args)))
    initial_wait = effective_wait()
    deadline = time.monotonic() + POLL_SECONDS
    batch_payload = {
        "version": 1,
        "calls": [{"tool": tool_name, "arguments": item_args} for tool_name, item_args in validated],
    }
    response_data = request_json(
        base_url() + ("/v1/batch?wait=%d" % initial_wait),
        capability(),
        "POST",
        batch_payload,
    )
    results = response_data.get("results") if isinstance(response_data, dict) else None
    if not isinstance(response_data, dict) or response_data.get("state") != "ready" or not isinstance(results, list) or len(results) != total:
        submission_unknown("invalid batch response")
    outputs = []
    for index, ((tool_name, _item_args), raw_snap) in enumerate(zip(validated, results), start=1):
        snap = operation_snapshot(raw_snap, submission=True)
        result_text = unwrap_mcp_text(resolve_operation(snap, deadline))
        outputs.append("=== [%d/%d] %s ===\n%s" % (index, total, tool_name, render_output(result_text, limit)))
    print("\n".join(outputs))


def main(argv):
    if len(argv) < 2:
        fail(USAGE)
    command = argv[1]
    rest = argv[2:]
    if command == "about" and not rest:
        print(about().strip())
    elif command == "tools":
        if rest == ["--names"]:
            data = tools()
            print("tool_count: %s" % data.get("tool_count"))
            for name in data.get("tools", []):
                print(name)
        elif not rest:
            for line in signatures_list().get("signatures", []):
                print(line)
        else:
            fail(USAGE)
    elif command in ("sigs", "signatures") and not rest:
        for line in signatures_list().get("signatures", []):
            print(line)
    elif command == "instructions" and not rest:
        text = instructions_text()
        if text:
            print(text, end="" if text.endswith("\n") else "\n")
    elif command == "schema" and len(rest) == 1:
        print(json.dumps(schema(rest[0]), indent=2))
    elif command == "connect":
        cmd_connect(rest)
    elif command == "pwd" and not rest:
        cwd = sticky_cwd()
        if cwd:
            print(cwd)
        else:
            limit = output_limit()
            print(render_output(unwrap_mcp_text(call("dev_1mcp_bash", {"command": "pwd"})).strip(), limit))
    elif command == "cd":
        cmd_cd(rest)
    elif command == "ls":
        cmd_ls(rest)
    elif command == "read":
        cmd_read(rest)
    elif command == "rg":
        cmd_rg(rest)
    elif command == "edit":
        cmd_edit(rest)
    elif command == "write":
        cmd_write(rest)
    elif command == "review":
        cmd_review(rest)
    elif command == "batch":
        cmd_batch(rest)
    elif command == "call":
        limit = output_limit()
        unwrap = False
        call_args = list(rest)
        if call_args and call_args[0] == "--unwrap":
            unwrap = True
            call_args = call_args[1:]
        if not call_args or len(call_args) > 2:
            fail(USAGE)
        parsed_args = load_json_source(call_args[1] if len(call_args) == 2 else None, default_empty_object=True)
        if not isinstance(parsed_args, dict):
            fail("call arguments must be a JSON object")
        raw_result = call(call_args[0], parsed_args)
        if unwrap:
            raw_result = unwrap_mcp_text(raw_result)
        print(render_output(raw_result, limit))
    elif command == "sh":
        limit = output_limit()
        if rest == ["-"]:
            script = sys.stdin.read()
        elif not rest:
            if sys.stdin.isatty():
                fail(USAGE)
            script = sys.stdin.read()
            if not script:
                fail(USAGE)
        else:
            script = " ".join(rest)
        payload = {"command": script}
        cwd = sticky_cwd()
        if cwd:
            payload["cwd"] = cwd
        print(render_output(call("dev_1mcp_bash", payload), limit))
    else:
        fail(USAGE)


if __name__ == "__main__":
    main(sys.argv)
