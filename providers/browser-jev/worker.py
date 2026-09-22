#!/usr/bin/env python3
"""Bounded JSON-lines adapter around one upstream Jev Agent."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
from collections.abc import Callable, Mapping
from typing import Any, TextIO

from browser_harness import _ipc as browser_harness_ipc
from browser_harness.admin import restart_daemon
from jev_ultrafast import Agent


REQUEST_KEYS = {"id", "command", "arguments"}
COMMANDS = {"start", "tick", "state", "stop"}
SENSITIVE_ENV_KEYS = {
    "BU_CDP_URL",
    "TYPESAFE_API_KEY",
    "TEXT_MODEL_API_KEY",
}
DAEMON_NAME = re.compile(r"^jev-[A-Za-z0-9][A-Za-z0-9_-]*$")


class WorkerRuntime:
    def __init__(
        self,
        *,
        agent_factory: Callable[..., Any] = Agent,
        daemon_stopper: Callable[..., Any] = restart_daemon,
        daemon_pid_resolver: Callable[[str], int | None] = lambda name: browser_harness_ipc.identify(name, timeout=1.0),
        child_reaper: Callable[[int, int], tuple[int, int]] = os.waitpid,
        environ: Mapping[str, str] = os.environ,
    ) -> None:
        self.agent_factory = agent_factory
        self.daemon_stopper = daemon_stopper
        self.daemon_pid_resolver = daemon_pid_resolver
        self.child_reaper = child_reaper
        self.environ = environ
        self.daemon_name = environ.get("BU_NAME", "")
        if not DAEMON_NAME.fullmatch(self.daemon_name) or self.daemon_name == "default":
            raise ValueError("BU_NAME must be a non-default jev-<run-id> namespace")
        endpoint = environ.get("BU_CDP_URL", "")
        if not endpoint:
            raise ValueError("BU_CDP_URL is required")
        self.agent: Any | None = None
        self.cleaned = False

    @staticmethod
    def _object(value: Any, name: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError(f"{name} must be an object")
        return value

    @staticmethod
    def _exact_keys(value: dict[str, Any], keys: set[str], name: str) -> None:
        unknown = set(value) - keys
        if unknown:
            raise ValueError(f"{name} has unknown key: {sorted(unknown)[0]}")

    def start(self, arguments: dict[str, Any]) -> dict[str, Any]:
        self._exact_keys(arguments, {"url", "goal"}, "start arguments")
        if self.agent is not None:
            raise ValueError("worker run is already started")
        url = arguments.get("url")
        goal = arguments.get("goal")
        if not isinstance(url, str) or not url:
            raise ValueError("start url must be a non-empty string")
        if not isinstance(goal, str) or not goal.strip():
            raise ValueError("start goal must be a non-empty string")
        self.agent = self.agent_factory(url, goal, screenshots=False)
        return self.agent.snapshot()

    def tick(self, arguments: dict[str, Any]) -> dict[str, Any]:
        self._exact_keys(arguments, set(), "tick arguments")
        if self.agent is None:
            raise ValueError("worker run is not started")
        return self.agent.command("tick")

    def state(self, arguments: dict[str, Any]) -> dict[str, Any]:
        self._exact_keys(arguments, set(), "state arguments")
        if self.agent is None:
            raise ValueError("worker run is not started")
        return self.agent.snapshot()

    def stop(self, arguments: dict[str, Any]) -> dict[str, str]:
        self._exact_keys(arguments, set(), "stop arguments")
        self.close()
        return {"status": "stopped"}

    def _stop_daemon_and_reap(self, daemon_pid: int | None) -> None:
        if daemon_pid is None:
            self.daemon_stopper(self.daemon_name, require_clean=True)
            return

        failure: list[BaseException] = []

        def stop_daemon() -> None:
            try:
                self.daemon_stopper(self.daemon_name, require_clean=True)
            except BaseException as error:
                failure.append(error)

        stopper = threading.Thread(
            target=stop_daemon,
            name=f"browser-jev-stop-{self.daemon_name}",
            daemon=True,
        )
        stopper.start()
        while stopper.is_alive():
            try:
                reaped_pid, _ = self.child_reaper(daemon_pid, os.WNOHANG)
            except ChildProcessError:
                break
            except InterruptedError:
                continue
            if reaped_pid == daemon_pid:
                break
            stopper.join(0.05)
        stopper.join()
        if failure:
            raise failure[0]

    def close(self) -> None:
        if self.cleaned:
            return
        self.cleaned = True
        agent, self.agent = self.agent, None
        daemon_pid = self.daemon_pid_resolver(self.daemon_name)
        try:
            if agent is not None:
                agent.close()
        finally:
            self._stop_daemon_and_reap(daemon_pid)

    def handle(self, request: Any) -> tuple[str, Any]:
        body = self._object(request, "request")
        self._exact_keys(body, REQUEST_KEYS, "request")
        request_id = body.get("id")
        command = body.get("command")
        arguments = self._object(body.get("arguments"), "arguments")
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("request id must be a non-empty string")
        if command not in COMMANDS:
            raise ValueError("request command is invalid")
        return request_id, getattr(self, command)(arguments)

    def public_error(self, error: BaseException) -> dict[str, str]:
        message = str(error) or error.__class__.__name__
        for key in SENSITIVE_ENV_KEYS:
            value = self.environ.get(key)
            if value:
                message = message.replace(value, "[redacted]")
        return {"code": "WORKER_COMMAND_FAILED", "message": message[:1000]}


def serve(runtime: WorkerRuntime, input_stream: TextIO, output_stream: TextIO) -> None:
    try:
        for raw_line in input_stream:
            if not raw_line.strip():
                continue
            request_id: str | None = None
            try:
                request = json.loads(raw_line)
                if isinstance(request, dict) and isinstance(request.get("id"), str):
                    request_id = request["id"]
                request_id, result = runtime.handle(request)
                response = {"id": request_id, "ok": True, "result": result}
            except Exception as error:  # one bounded error response; never retry commands
                response = {"id": request_id, "ok": False, "error": runtime.public_error(error)}
            output_stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            output_stream.flush()
    finally:
        runtime.close()


def main() -> int:
    try:
        runtime = WorkerRuntime()
        serve(runtime, sys.stdin, sys.stdout)
        return 0
    except Exception as error:
        # Startup failures happen before the JSON-lines contract is available.
        print(f"browser-jev worker startup failed: {error.__class__.__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
