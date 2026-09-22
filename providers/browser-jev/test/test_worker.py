import io
import json
import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker import WorkerRuntime, serve  # noqa: E402


class FakeAgent:
    def __init__(self, url, goal, *, screenshots):
        self.url = url
        self.goal = goal
        self.screenshots = screenshots
        self.calls = []
        self.closed = False
        self.current = {
            "goal": goal,
            "status": "ready",
            "elapsed_ms": 0,
            "page": {"url": url, "title": "Example", "text": "Example Domain", "scroll": {"y": 0, "height": 780}},
            "elements": [],
            "history": [],
            "decision": None,
        }

    def snapshot(self):
        self.calls.append("snapshot")
        return self.current

    def command(self, name):
        self.calls.append(("command", name))
        self.current = {**self.current, "elapsed_ms": 12}
        return self.current

    def close(self):
        self.calls.append("close")
        self.closed = True


def runtime_fixture(*, name="jev-test123", factory=None):
    agents = []
    daemon_calls = []

    def make_agent(*args, **kwargs):
        agent = (factory or FakeAgent)(*args, **kwargs)
        agents.append(agent)
        return agent

    def stop_daemon(daemon_name, *, require_clean):
        daemon_calls.append((daemon_name, require_clean))

    runtime = WorkerRuntime(
        agent_factory=make_agent,
        daemon_stopper=stop_daemon,
        daemon_pid_resolver=lambda _name: None,
        environ={"BU_NAME": name, "BU_CDP_URL": "http://127.0.0.1:9222"},
    )
    return runtime, agents, daemon_calls


def test_start_constructs_one_agent_and_state_only_snapshots():
    runtime, agents, _ = runtime_fixture()
    first = runtime.start({"url": "https://example.com", "goal": "Confirm it"})
    assert len(agents) == 1
    assert agents[0].screenshots is False
    assert first["status"] == "ready"
    assert runtime.state({})["page"]["title"] == "Example"
    assert agents[0].calls == ["snapshot", "snapshot"]
    with pytest.raises(ValueError, match="already started"):
        runtime.start({"url": "https://example.com", "goal": "Again"})


def test_tick_calls_exactly_one_agent_tick():
    runtime, agents, _ = runtime_fixture()
    runtime.start({"url": "https://example.com", "goal": "Confirm it"})
    result = runtime.tick({})
    assert result["elapsed_ms"] == 12
    assert agents[0].calls == ["snapshot", ("command", "tick")]


def test_stop_closes_agent_before_strict_namespaced_daemon_cleanup():
    calls = []

    class OrderedAgent(FakeAgent):
        def close(self):
            calls.append("agent.close")
            super().close()

    runtime = WorkerRuntime(
        agent_factory=OrderedAgent,
        daemon_stopper=lambda name, *, require_clean: calls.append(("restart_daemon", name, require_clean)),
        daemon_pid_resolver=lambda _name: None,
        environ={"BU_NAME": "jev-test123", "BU_CDP_URL": "http://127.0.0.1:9222"},
    )
    runtime.start({"url": "https://example.com", "goal": "Confirm it"})
    assert runtime.stop({}) == {"status": "stopped"}
    assert calls == ["agent.close", ("restart_daemon", "jev-test123", True)]
    runtime.close()
    assert calls == ["agent.close", ("restart_daemon", "jev-test123", True)]


def test_stop_reaps_the_namespaced_daemon_child_while_strict_cleanup_waits():
    calls = []
    release_stopper = threading.Event()
    reap_calls = 0

    def stop_daemon(name, *, require_clean):
        calls.append(("restart_daemon", name, require_clean))
        assert release_stopper.wait(timeout=1)

    def reap_child(pid, flags):
        nonlocal reap_calls
        assert pid == 4321
        assert flags == os.WNOHANG
        reap_calls += 1
        if reap_calls == 1:
            return 0, 0
        release_stopper.set()
        return pid, 0

    runtime = WorkerRuntime(
        agent_factory=FakeAgent,
        daemon_stopper=stop_daemon,
        daemon_pid_resolver=lambda _name: 4321,
        child_reaper=reap_child,
        environ={"BU_NAME": "jev-test123", "BU_CDP_URL": "http://127.0.0.1:9222"},
    )
    runtime.start({"url": "https://example.com", "goal": "Confirm it"})
    assert runtime.stop({}) == {"status": "stopped"}
    assert calls == [("restart_daemon", "jev-test123", True)]
    assert reap_calls == 2


def test_cleanup_still_stops_daemon_when_agent_close_fails():
    class BrokenCloseAgent(FakeAgent):
        def close(self):
            raise RuntimeError("close failed")

    runtime, _, daemon_calls = runtime_fixture(factory=BrokenCloseAgent)
    runtime.start({"url": "https://example.com", "goal": "Confirm it"})
    with pytest.raises(RuntimeError, match="close failed"):
        runtime.stop({})
    assert daemon_calls == [("jev-test123", True)]
    runtime.close()
    assert daemon_calls == [("jev-test123", True)]


@pytest.mark.parametrize("name", ["default", "jev-", "other-name", "jev-has spaces"])
def test_rejects_non_namespaced_daemon_names(name):
    with pytest.raises(ValueError, match="BU_NAME"):
        runtime_fixture(name=name)


def test_serve_emits_one_response_per_request_and_cleans_up_at_eof():
    runtime, agents, daemon_calls = runtime_fixture()
    requests = "\n".join([
        json.dumps({"id": "1", "command": "start", "arguments": {"url": "https://example.com", "goal": "Confirm it"}}),
        json.dumps({"id": "2", "command": "tick", "arguments": {}}),
        json.dumps({"id": "3", "command": "state", "arguments": {}}),
        "",
    ])
    output = io.StringIO()
    serve(runtime, io.StringIO(requests), output)
    responses = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [response["id"] for response in responses] == ["1", "2", "3"]
    assert all(response["ok"] is True for response in responses)
    assert agents[0].closed is True
    assert daemon_calls == [("jev-test123", True)]


def test_protocol_errors_do_not_expose_environment_values():
    secret = "super-secret-typesafe-value"

    class LeakyAgent(FakeAgent):
        def command(self, name):
            raise RuntimeError(f"provider echoed {secret}")

    runtime = WorkerRuntime(
        agent_factory=LeakyAgent,
        daemon_stopper=lambda *_args, **_kwargs: None,
        daemon_pid_resolver=lambda _name: None,
        environ={
            "BU_NAME": "jev-test123",
            "BU_CDP_URL": "http://127.0.0.1:9222",
            "TYPESAFE_API_KEY": secret,
        },
    )
    requests = "\n".join([
        json.dumps({"id": "1", "command": "start", "arguments": {"url": "https://example.com", "goal": "Confirm it"}}),
        json.dumps({"id": "2", "command": "tick", "arguments": {}}),
        "",
    ])
    output = io.StringIO()
    serve(runtime, io.StringIO(requests), output)
    assert secret not in output.getvalue()
    response = json.loads(output.getvalue().splitlines()[1])
    assert response["ok"] is False
    assert response["error"]["code"] == "WORKER_COMMAND_FAILED"


def test_request_validation_rejects_unknown_keys_and_wrong_arguments():
    runtime, _, _ = runtime_fixture()
    for request in [
        {"id": "1", "command": "state", "arguments": {}, "extra": True},
        {"id": "1", "command": "unknown", "arguments": {}},
        {"id": "1", "command": "state", "arguments": {"extra": True}},
    ]:
        with pytest.raises(ValueError):
            runtime.handle(request)

