import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import worker as worker_module  # noqa: E402
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


def test_collect_forwards_prefer_wait_to_deterministic_collection_step():
    class CollectionAgent(FakeAgent):
        def collection_step(
            self,
            *,
            prefer_wait=False,
            start_prefix,
            end_exact,
            max_records,
        ):
            self.calls.append((
                "collection_step",
                prefer_wait,
                start_prefix,
                end_exact,
                max_records,
            ))
            return self.current

    runtime, agents, _ = runtime_fixture(factory=CollectionAgent)
    runtime.start({"url": "https://example.com", "goal": "Collect it"})
    runtime.collect({
        "prefer_wait": True,
        "start_prefix": "@",
        "end_exact": "Reply",
        "max_records": 50,
    })
    assert agents[0].calls == [
        "snapshot",
        ("collection_step", True, "@", "Reply", 50),
    ]


def test_daemon_cleanup_preserves_records_when_owned_target_never_disappears(monkeypatch):
    monkeypatch.setenv("BU_CDP_URL", "http://127.0.0.1:9222")
    monkeypatch.setattr(worker_module, "UPSTREAM_DAEMON_EXIT_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(worker_module.browser_harness_ipc, "identify", lambda *_args, **_kwargs: 123)
    monkeypatch.setattr(worker_module.os, "pidfd_open", lambda _pid: 9)
    monkeypatch.setattr(worker_module.os, "close", lambda _fd: None)
    monkeypatch.setattr(
        worker_module,
        "_daemon_request",
        lambda _name, body, **_kwargs: (
            {"targetId": "helper-target"}
            if body == {"meta": "current_tab"}
            else {"ok": True}
        ),
    )
    monkeypatch.setattr(worker_module, "_target_present", lambda *_args: True)
    monkeypatch.setattr(worker_module, "_pidfd_exited", lambda *_args, **_kwargs: False)
    signals = []
    monkeypatch.setattr(
        worker_module.signal,
        "pidfd_send_signal",
        lambda *_args, **_kwargs: signals.append(True),
    )
    cleaned = []
    monkeypatch.setattr(worker_module, "_cleanup_daemon_records", lambda name: cleaned.append(name))

    with pytest.raises(RuntimeError, match="did not remove its owned target"):
        worker_module.stop_namespaced_daemon("jev-stuck", require_clean=True)

    assert signals == []
    assert cleaned == []


def test_stop_closes_agent_before_strict_namespaced_daemon_cleanup():
    calls = []

    class OrderedAgent(FakeAgent):
        def close(self):
            calls.append("agent.close")
            super().close()

    runtime = WorkerRuntime(
        agent_factory=OrderedAgent,
        daemon_stopper=lambda name, *, require_clean: calls.append(("restart_daemon", name, require_clean)),
        environ={"BU_NAME": "jev-test123", "BU_CDP_URL": "http://127.0.0.1:9222"},
    )
    runtime.start({"url": "https://example.com", "goal": "Confirm it"})
    assert runtime.stop({}) == {"status": "stopped"}
    assert calls == ["agent.close", ("restart_daemon", "jev-test123", True)]
    runtime.close()
    assert calls == ["agent.close", ("restart_daemon", "jev-test123", True)]


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
