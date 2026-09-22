#!/usr/bin/env python3
"""Bounded JSON-lines adapter around one upstream Jev Agent."""

from __future__ import annotations

import json
import os
import re
import select
import signal
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, TextIO

from browser_harness import _ipc as browser_harness_ipc
from browser_harness.admin import restart_daemon
from browser_harness.helpers import cdp
from jev_runtime import ManagedAgent


REQUEST_KEYS = {"id", "command", "arguments"}
COMMANDS = {"start", "tick", "navigate", "collect", "state", "stop"}
SENSITIVE_ENV_KEYS = {
    "BU_CDP_URL",
    "TYPESAFE_API_KEY",
    "TEXT_MODEL_API_KEY",
}
DAEMON_NAME = re.compile(r"^jev-[A-Za-z0-9][A-Za-z0-9_-]*$")
FAST_DAEMON_CLEANUP_GRACE_SECONDS = 1.0
UPSTREAM_DAEMON_EXIT_GRACE_SECONDS = 15.0
DAEMON_POLL_SECONDS = 0.02
LEASE_VERSION = 3
LEASE_STORAGE_KEY = "__mcp_dev_bridge_browser_jev_owner_v1"
HELPER_MARKER_PREFIX = "about:blank#__mcp_dev_bridge_browser_jev_owner_v1="
WIRE_HISTORY_KEYS = {
    "step", "action", "kind", "choice", "operation", "target", "probability", "confidence",
    "latency_ms", "text", "text_helper", "text_latency_ms", "page_changed", "url",
    "executed_ms", "elapsed_ms", "usage", "source",
}
WIRE_DECISION_KEYS = {
    "operation", "choice", "target", "confidence", "target_confidence", "model", "latency_ms",
    "probabilities", "operation_probabilities", "target_probabilities", "usage",
}
WIRE_ELEMENT_KEYS = {
    "id", "index", "kind", "label", "role", "value", "checked", "selected", "expanded",
    "operations", "options",
}


def _pick(value: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in keys if key in value}


def wire_snapshot(snapshot: Any) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise ValueError("agent snapshot must be an object")
    result = _pick(snapshot, {"goal", "status", "elapsed_ms"})
    page = snapshot.get("page")
    if isinstance(page, dict):
        wire_page = _pick(page, {"url", "title", "text", "scroll"})
        marker = page.get("marker")
        if (
            isinstance(marker, list)
            and len(marker) >= 2
            and isinstance(marker[0], (int, float))
            and not isinstance(marker[0], bool)
            and isinstance(marker[1], str)
        ):
            wire_page["document_id"] = [marker[0], marker[1]]
        collection_records = page.get("collection_records")
        if isinstance(collection_records, list):
            wire_page["collection_records"] = [
                record[:2000]
                for record in collection_records
                if isinstance(record, str) and record
            ][:500]
        actions = page.get("actions")
        if isinstance(actions, list):
            wire_page["actions"] = [
                _pick(action, {"id", "kind", "delta"})
                for action in actions
                if isinstance(action, dict)
            ]
        result["page"] = wire_page
    elements = snapshot.get("elements")
    if isinstance(elements, list):
        result["elements"] = [
            _pick(element, WIRE_ELEMENT_KEYS)
            for element in elements
            if isinstance(element, dict)
        ]
    decision = snapshot.get("decision")
    if isinstance(decision, dict):
        result["decision"] = _pick(decision, WIRE_DECISION_KEYS)
    history = snapshot.get("history")
    if isinstance(history, list):
        result["history"] = [
            _pick(entry, WIRE_HISTORY_KEYS)
            for entry in history
            if isinstance(entry, dict)
        ]
    return result


def _daemon_request(name: str, body: dict[str, Any], *, timeout: float) -> dict[str, Any]:
    connection = None
    try:
        connection, token = browser_harness_ipc.connect(name, timeout=timeout)
        response = browser_harness_ipc.request(connection, token, body)
    finally:
        if connection is not None:
            connection.close()
    if not isinstance(response, dict):
        raise RuntimeError(f"daemon {name!r} returned an invalid response")
    return response


def _target_present(endpoint: str, target_id: str) -> bool:
    with urllib.request.urlopen(f"{endpoint.rstrip('/')}/json/list", timeout=0.25) as response:
        targets = json.load(response)
    if not isinstance(targets, list):
        raise RuntimeError("browser target list had an invalid shape")
    return any(isinstance(target, dict) and target.get("id") == target_id for target in targets)


def _pidfd_exited(pidfd: int, timeout: float = 0.0) -> bool:
    return bool(select.select([pidfd], [], [], timeout)[0])


def _state_base(environ: Mapping[str, str]) -> Path:
    configured = environ.get("XDG_STATE_HOME")
    if configured:
        return Path(configured)
    return Path.home() / ".local" / "state"


def _lease_root(environ: Mapping[str, str]) -> Path:
    return _state_base(environ) / "mcp-dev-bridge" / "browser-jev" / "leases"


def _process_start_ticks(pid: int) -> str | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        return stat.rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError, ValueError):
        return None


def _recorded_process_alive(pid: Any, start_ticks: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or not isinstance(start_ticks, str):
        return False
    return _process_start_ticks(pid) == start_ticks


def _lease_owner_alive(lease: dict[str, Any]) -> bool:
    pid = lease.get("owner_pid")
    start_ticks = lease.get("owner_start_ticks")
    if not isinstance(pid, int) or isinstance(pid, bool) or not isinstance(start_ticks, str):
        return True
    return _recorded_process_alive(pid, start_ticks)


def _close_browser_target(endpoint: str, target_id: str) -> bool:
    try:
        if not _target_present(endpoint, target_id):
            return True
        with urllib.request.urlopen(
            f"{endpoint.rstrip('/')}/json/close/{target_id}",
            timeout=0.5,
        ) as response:
            response.read(256)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            return False
    except (OSError, ValueError, json.JSONDecodeError):
        return False

    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        try:
            if not _target_present(endpoint, target_id):
                return True
        except (OSError, ValueError, json.JSONDecodeError):
            return False
        time.sleep(0.02)
    return False


def _cleanup_daemon_records(name: str) -> None:
    browser_harness_ipc.cleanup_endpoint(name)
    try:
        browser_harness_ipc.pid_path(name).unlink()
    except FileNotFoundError:
        pass


def stop_namespaced_daemon(name: str, *, require_clean: bool) -> None:
    if not require_clean:
        restart_daemon(name, require_clean=False)
        return

    endpoint = os.environ.get("BU_CDP_URL", "")
    pid = browser_harness_ipc.identify(name, timeout=1.0)
    if pid is None:
        raise RuntimeError(
            f"daemon {name!r} has no verifiable PID for required clean shutdown; ownership records were preserved"
        )
    if not endpoint:
        raise RuntimeError(
            f"daemon {name!r} has no browser endpoint for required clean shutdown; ownership records were preserved"
        )
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError(
            f"daemon {name!r} cannot prove process identity for required clean shutdown; ownership records were preserved"
        )

    try:
        pidfd = os.pidfd_open(pid)
    except OSError as error:
        raise RuntimeError(
            f"daemon {name!r} process identity could not be pinned for required clean shutdown; ownership records were preserved"
        ) from error

    try:
        try:
            current = _daemon_request(name, {"meta": "current_tab"}, timeout=1.0)
        except FileNotFoundError:
            raise RuntimeError(
                f"daemon {name!r} IPC disappeared before clean shutdown acknowledgement"
            ) from None
        target_id = current.get("targetId")
        if not isinstance(target_id, str) or not target_id:
            raise RuntimeError(
                f"daemon {name!r} did not expose its owned target for required clean shutdown; ownership records were preserved"
            )
        try:
            target_gone = not _target_present(endpoint, target_id)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError(
                f"daemon {name!r} owned-target state could not be proven for required clean shutdown; ownership records were preserved"
            ) from error

        try:
            shutdown = _daemon_request(name, {"meta": "shutdown"}, timeout=2.0)
        except FileNotFoundError:
            raise RuntimeError(
                f"daemon {name!r} IPC disappeared before clean shutdown acknowledgement"
            ) from None
        if shutdown.get("ok") is not True or bool(shutdown.get("error")):
            raise RuntimeError(shutdown.get("error") or f"daemon {name!r} did not confirm clean shutdown")

        started = time.monotonic()
        fast_deadline = started + FAST_DAEMON_CLEANUP_GRACE_SECONDS
        full_deadline = started + UPSTREAM_DAEMON_EXIT_GRACE_SECONDS
        while time.monotonic() < full_deadline:
            if _pidfd_exited(pidfd):
                target_gone = not _target_present(endpoint, target_id)
                if not target_gone:
                    raise RuntimeError(f"daemon {name!r} exited before owned target cleanup was verified")
                break
            try:
                target_gone = not _target_present(endpoint, target_id)
            except (OSError, ValueError, json.JSONDecodeError):
                target_gone = False
            if target_gone:
                try:
                    signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                if not _pidfd_exited(pidfd, 1.0):
                    raise RuntimeError(
                        f"daemon {name!r} remained alive after owned target cleanup was verified"
                    )
                break
            time.sleep(DAEMON_POLL_SECONDS if time.monotonic() < fast_deadline else 0.1)
        else:
            raise RuntimeError(
                f"daemon {name!r} did not remove its owned target before the clean shutdown deadline"
            )

        if not _pidfd_exited(pidfd):
            raise RuntimeError(f"daemon {name!r} cleanup completed without process exit")
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        _cleanup_daemon_records(name)
    finally:
        os.close(pidfd)


class WorkerRuntime:
    def __init__(
        self,
        *,
        agent_factory: Callable[..., Any] = ManagedAgent,
        daemon_stopper: Callable[..., Any] = stop_namespaced_daemon,
        environ: Mapping[str, str] = os.environ,
    ) -> None:
        self.agent_factory = agent_factory
        self.daemon_stopper = daemon_stopper
        self.environ = environ
        self.daemon_name = environ.get("BU_NAME", "")
        if not DAEMON_NAME.fullmatch(self.daemon_name) or self.daemon_name == "default":
            raise ValueError("BU_NAME must be a non-default jev-<run-id> namespace")
        self.endpoint = environ.get("BU_CDP_URL", "")
        if not self.endpoint:
            raise ValueError("BU_CDP_URL is required")
        self.profile_key = environ.get("BROWSER_JEV_PROFILE_KEY", "") or self.endpoint
        self.lease_root = _lease_root(environ)
        self.lease_path = self.lease_root / f"{self.daemon_name}.json"
        self.owner_start_ticks = _process_start_ticks(os.getpid())
        self.agent: Any | None = None
        self.cleaned = False

    def _read_lease(self, path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def _owned_target_roles(self) -> dict[str, str]:
        agent = self.agent
        if agent is None:
            return {}
        roles: dict[str, str] = {}
        content_target = getattr(getattr(agent, "browser", None), "target", None)
        if isinstance(content_target, str) and content_target:
            roles["content"] = content_target
        try:
            current = _daemon_request(self.daemon_name, {"meta": "current_tab"}, timeout=1.0)
            helper_target = current.get("targetId")
            if isinstance(helper_target, str) and helper_target:
                roles["helper"] = helper_target
        except Exception:
            pass
        return roles

    @staticmethod
    def _marker_expression(token: str) -> str:
        key = json.dumps(LEASE_STORAGE_KEY)
        value = json.dumps(token)
        return (
            "(() => { try { sessionStorage.setItem("
            + key
            + ","
            + value
            + "); return true; } catch { return false; } })()"
        )

    def _mark_content_target(self, target_id: str, token: str) -> bool:
        session_id = None
        try:
            attached = cdp("Target.attachToTarget", targetId=target_id, flatten=True)
            session_id = attached.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                return False
            result = cdp(
                "Runtime.evaluate",
                session_id=session_id,
                expression=self._marker_expression(token),
                returnByValue=True,
            )
            return result.get("result", {}).get("value") is True
        except Exception:
            return False
        finally:
            if session_id:
                try:
                    cdp("Target.detachFromTarget", sessionId=session_id)
                except Exception:
                    pass

    def _mark_helper_target(self, target_id: str, token: str) -> bool:
        session_id = None
        expected_url = f"{HELPER_MARKER_PREFIX}{token}"
        try:
            attached = cdp("Target.attachToTarget", targetId=target_id, flatten=True)
            session_id = attached.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                return False
            fragment = expected_url.split("#", 1)[1]
            expression = (
                "(() => { try { history.replaceState(history.state,'','#'+"
                + json.dumps(fragment)
                + "); return location.href; } catch { return null; } })()"
            )
            result = cdp(
                "Runtime.evaluate",
                session_id=session_id,
                expression=expression,
                returnByValue=True,
            )
            return result.get("result", {}).get("value") == expected_url
        except Exception:
            return False
        finally:
            if session_id:
                try:
                    cdp("Target.detachFromTarget", sessionId=session_id)
                except Exception:
                    pass

    def _marked_target_ids(self, token: str) -> list[str] | None:
        try:
            infos = cdp("Target.getTargets").get("targetInfos")
        except Exception:
            return None
        if not isinstance(infos, list):
            return None

        found: list[str] = []
        key = json.dumps(LEASE_STORAGE_KEY)
        expression = f"(() => {{ try {{ return sessionStorage.getItem({key}); }} catch {{ return null; }} }})()"
        helper_url = f"{HELPER_MARKER_PREFIX}{token}"
        for info in infos:
            if not isinstance(info, dict) or info.get("type") != "page":
                continue
            target_id = info.get("targetId")
            if not isinstance(target_id, str) or not target_id:
                continue
            if info.get("url") == helper_url:
                found.append(target_id)
                continue
            session_id = None
            try:
                attached = cdp("Target.attachToTarget", targetId=target_id, flatten=True)
                session_id = attached.get("sessionId")
                if not isinstance(session_id, str) or not session_id:
                    continue
                result = cdp(
                    "Runtime.evaluate",
                    session_id=session_id,
                    expression=expression,
                    returnByValue=True,
                )
                if result.get("result", {}).get("value") == token:
                    found.append(target_id)
            except Exception:
                continue
            finally:
                if session_id:
                    try:
                        cdp("Target.detachFromTarget", sessionId=session_id)
                    except Exception:
                        pass
        return found

    def _close_marked_targets(self, token: str) -> bool:
        target_ids = self._marked_target_ids(token)
        if not target_ids:
            return False
        closed = True
        for target_id in target_ids:
            try:
                result = cdp("Target.closeTarget", targetId=target_id)
                closed = result.get("success") is True and closed
            except Exception:
                closed = False
        if not closed:
            return False
        remaining = self._marked_target_ids(token)
        return remaining == []

    def _write_lease(self) -> None:
        roles = self._owned_target_roles()
        targets = list(dict.fromkeys(roles.values()))
        daemon_pid = browser_harness_ipc.identify(self.daemon_name, timeout=0.5)
        daemon_start_ticks = (
            _process_start_ticks(daemon_pid)
            if isinstance(daemon_pid, int) and not isinstance(daemon_pid, bool)
            else None
        )
        content_target = roles.get("content")
        helper_target = roles.get("helper")
        content_marked = (
            isinstance(content_target, str)
            and self._mark_content_target(content_target, self.daemon_name)
        )
        helper_marked = (
            isinstance(helper_target, str)
            and (
                content_marked
                if helper_target == content_target
                else self._mark_helper_target(helper_target, self.daemon_name)
            )
        )

        self.lease_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.lease_root, 0o700)
        except OSError:
            pass
        payload = {
            "version": LEASE_VERSION,
            "owner_pid": os.getpid(),
            "owner_start_ticks": self.owner_start_ticks,
            "daemon_name": self.daemon_name,
            "daemon_pid": daemon_pid,
            "daemon_start_ticks": daemon_start_ticks,
            "endpoint": self.endpoint,
            "profile_key": self.profile_key,
            "marker": self.daemon_name,
            "marker_complete": bool(content_marked and helper_marked),
            "targets": targets,
        }
        temp = self.lease_path.with_name(f".{self.lease_path.name}.{os.getpid()}.tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.lease_path)
        finally:
            try:
                temp.unlink()
            except FileNotFoundError:
                pass

    def _remove_lease(self) -> None:
        try:
            self.lease_path.unlink()
        except FileNotFoundError:
            pass

    def _reclaim_stale_leases(self) -> None:
        root = self.lease_root
        try:
            candidates = list(root.glob("jev-*.json"))
        except OSError:
            return
        for path in candidates:
            if path == self.lease_path:
                continue
            lease = self._read_lease(path)
            if not lease or lease.get("version") not in {1, 2, LEASE_VERSION}:
                continue
            if _lease_owner_alive(lease):
                continue
            lease_endpoint = lease.get("endpoint")
            lease_profile_key = lease.get("profile_key")
            same_profile = (
                lease_profile_key == self.profile_key
                if isinstance(lease_profile_key, str) and lease_profile_key
                else lease_endpoint == self.endpoint
            )
            if not same_profile:
                continue

            daemon_name = lease.get("daemon_name")
            if isinstance(daemon_name, str) and DAEMON_NAME.fullmatch(daemon_name):
                try:
                    daemon_alive = (
                        browser_harness_ipc.identify(daemon_name, timeout=0.2) is not None
                        or browser_harness_ipc.ping(daemon_name, timeout=0.2)
                    )
                    if daemon_alive and lease_endpoint == self.endpoint:
                        self.daemon_stopper(daemon_name, require_clean=True)
                except Exception as error:
                    print(
                        f"browser-jev stale daemon cleanup failed for {daemon_name}: {error.__class__.__name__}",
                        file=sys.stderr,
                    )

            marker_closed = False
            marker = lease.get("marker")
            if (
                lease.get("marker_complete") is True
                and isinstance(marker, str)
                and marker
            ):
                marker_closed = self._close_marked_targets(marker)

            direct_closed = False
            targets = lease.get("targets")
            recorded_targets = (
                [target_id for target_id in targets if isinstance(target_id, str) and target_id]
                if isinstance(targets, list)
                else []
            )
            if lease_endpoint == self.endpoint and recorded_targets:
                direct_results = [
                    _close_browser_target(self.endpoint, target_id)
                    for target_id in recorded_targets
                ]
                direct_closed = all(direct_results)

            # Recorded IDs are the same-browser proof when available. Marker
            # discovery is still useful after session restore, but an empty
            # marker scan is never evidence that an owned target disappeared.
            all_closed = (
                direct_closed
                if lease_endpoint == self.endpoint and recorded_targets
                else marker_closed
            )

            daemon_pid = lease.get("daemon_pid")
            daemon_start_ticks = lease.get("daemon_start_ticks")
            recorded_daemon_alive = _recorded_process_alive(daemon_pid, daemon_start_ticks)

            daemon_still_alive = recorded_daemon_alive
            if isinstance(daemon_name, str) and DAEMON_NAME.fullmatch(daemon_name):
                try:
                    daemon_still_alive = daemon_still_alive or (
                        browser_harness_ipc.identify(daemon_name, timeout=0.1) is not None
                        or browser_harness_ipc.ping(daemon_name, timeout=0.1)
                    )
                except Exception:
                    daemon_still_alive = True

            if all_closed and recorded_daemon_alive:
                if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
                    try:
                        pidfd = os.pidfd_open(daemon_pid)
                    except OSError:
                        pass
                    else:
                        try:
                            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                            if _pidfd_exited(pidfd, 1.0):
                                daemon_still_alive = False
                                if isinstance(daemon_name, str) and DAEMON_NAME.fullmatch(daemon_name):
                                    _cleanup_daemon_records(daemon_name)
                        except ProcessLookupError:
                            daemon_still_alive = False
                        finally:
                            os.close(pidfd)

            if all_closed and not daemon_still_alive:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass

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
        self._exact_keys(arguments, {"url", "goal", "wait_for_scroll"}, "start arguments")
        if self.agent is not None:
            raise ValueError("worker run is already started")
        url = arguments.get("url")
        goal = arguments.get("goal")
        wait_for_scroll = arguments.get("wait_for_scroll", False)
        if not isinstance(url, str) or not url:
            raise ValueError("start url must be a non-empty string")
        if not isinstance(goal, str) or not goal.strip():
            raise ValueError("start goal must be a non-empty string")
        if not isinstance(wait_for_scroll, bool):
            raise ValueError("start wait_for_scroll must be a boolean")
        self.agent = self.agent_factory(url, goal, screenshots=False)
        self._write_lease()
        self._reclaim_stale_leases()
        if wait_for_scroll:
            settle = getattr(self.agent, "settle_for_collection", None)
            if callable(settle):
                settle()
        return wire_snapshot(self.agent.snapshot())

    def tick(self, arguments: dict[str, Any]) -> dict[str, Any]:
        self._exact_keys(
            arguments,
            {"context", "allow_done", "allow_blocked", "settle_after_scroll"},
            "tick arguments",
        )
        if self.agent is None:
            raise ValueError("worker run is not started")
        context = arguments.get("context", "")
        allow_done = arguments.get("allow_done", True)
        allow_blocked = arguments.get("allow_blocked", True)
        settle_after_scroll = arguments.get("settle_after_scroll", False)
        if not isinstance(context, str) or len(context) > 4000:
            raise ValueError("tick context must be a string up to 4000 characters")
        if not isinstance(allow_done, bool):
            raise ValueError("tick allow_done must be a boolean")
        if not isinstance(allow_blocked, bool):
            raise ValueError("tick allow_blocked must be a boolean")
        if not isinstance(settle_after_scroll, bool):
            raise ValueError("tick settle_after_scroll must be a boolean")
        tick_with_context = getattr(self.agent, "tick_with_context", None)
        if callable(tick_with_context):
            return wire_snapshot(tick_with_context(
                context=context,
                allow_done=allow_done,
                allow_blocked=allow_blocked,
                settle_after_scroll=settle_after_scroll,
            ))
        return wire_snapshot(self.agent.command("tick"))

    def navigate(self, arguments: dict[str, Any]) -> dict[str, Any]:
        self._exact_keys(arguments, {"url_contains"}, "navigate arguments")
        if self.agent is None:
            raise ValueError("worker run is not started")
        expected = arguments.get("url_contains")
        if (
            not isinstance(expected, list)
            or not expected
            or len(expected) > 20
            or any(not isinstance(item, str) or not item or len(item) > 200 for item in expected)
        ):
            raise ValueError("navigate url_contains must be a non-empty array of bounded strings")
        navigate = getattr(self.agent, "navigate_url_contains", None)
        if not callable(navigate):
            raise ValueError("worker agent does not support deterministic URL navigation")
        snapshot, matched = navigate(expected)
        result = wire_snapshot(snapshot)
        result["provider_navigation"] = {"matched": matched}
        return result

    def collect(self, arguments: dict[str, Any]) -> dict[str, Any]:
        self._exact_keys(
            arguments,
            {"prefer_wait", "start_prefix", "end_exact", "max_records"},
            "collect arguments",
        )
        if self.agent is None:
            raise ValueError("worker run is not started")
        prefer_wait = arguments.get("prefer_wait", False)
        start_prefix = arguments.get("start_prefix")
        end_exact = arguments.get("end_exact")
        max_records = arguments.get("max_records")
        if not isinstance(prefer_wait, bool):
            raise ValueError("collect prefer_wait must be a boolean")
        if not isinstance(start_prefix, str) or not start_prefix:
            raise ValueError("collect start_prefix must be a non-empty string")
        if not isinstance(end_exact, str) or not end_exact:
            raise ValueError("collect end_exact must be a non-empty string")
        if not isinstance(max_records, int) or isinstance(max_records, bool) or not 1 <= max_records <= 500:
            raise ValueError("collect max_records must be an integer from 1 to 500")
        collection_step = getattr(self.agent, "collection_step", None)
        if not callable(collection_step):
            raise ValueError("worker agent does not support deterministic collection traversal")
        return wire_snapshot(collection_step(
            prefer_wait=prefer_wait,
            start_prefix=start_prefix,
            end_exact=end_exact,
            max_records=max_records,
        ))

    def state(self, arguments: dict[str, Any]) -> dict[str, Any]:
        self._exact_keys(arguments, set(), "state arguments")
        if self.agent is None:
            raise ValueError("worker run is not started")
        return wire_snapshot(self.agent.snapshot())

    def stop(self, arguments: dict[str, Any]) -> dict[str, str]:
        self._exact_keys(arguments, set(), "stop arguments")
        self.close()
        return {"status": "stopped"}

    def close(self) -> None:
        if self.cleaned:
            return
        self.cleaned = True
        agent, self.agent = self.agent, None
        cleanup_error: BaseException | None = None
        try:
            if agent is not None:
                agent.close()
        except BaseException as error:
            cleanup_error = error
        try:
            self.daemon_stopper(self.daemon_name, require_clean=True)
        except BaseException as error:
            if cleanup_error is None:
                cleanup_error = error
        if cleanup_error is None:
            self._remove_lease()
            return
        raise cleanup_error

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
