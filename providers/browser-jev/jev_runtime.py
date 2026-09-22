"""Provider-local runtime adaptations for the pinned Jev Ultrafast agent."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from jev_ultrafast import Agent as UpstreamAgent
from jev_ultrafast import agent as upstream_agent
from jev_ultrafast import browser as upstream_browser
from jev_ultrafast import model as upstream_model


LOCAL_READ_STATE = Path(__file__).with_name("snapshot.js").read_text(encoding="utf-8")
upstream_browser.READ_STATE = LOCAL_READ_STATE
upstream_browser.MARKER = f"(() => {{ const state={LOCAL_READ_STATE}; return state?.marker ?? null; }})()"

_UPSTREAM_ACTION_SPACE = upstream_model.action_space


def action_space_with_hrefs(actions: list[dict[str, Any]]):
    """Preserve observed link destinations in both TypeSafe state and target criteria."""
    model_actions: list[dict[str, Any]] = []
    for action in actions:
        href = action.get("href")
        if isinstance(href, str) and href:
            action = {**action, "label": f"{action['label']} [href={href[:240]}]"}
        model_actions.append(action)

    elements, targets, controls = _UPSTREAM_ACTION_SPACE(model_actions)
    for element in elements:
        label = element.get("label")
        if not isinstance(label, str):
            continue
        marker = " [href="
        if marker not in label or not label.endswith("]"):
            continue
        base, href = label.rsplit(marker, 1)
        element["label"] = base
        element["href"] = href[:-1]
    return elements, targets, controls


upstream_model.action_space = action_space_with_hrefs
upstream_agent.action_space = action_space_with_hrefs


def collection_read_state(start_prefix: str, end_exact: str, max_records: int) -> str:
    prefix = json.dumps(start_prefix, ensure_ascii=False)
    end = json.dumps(end_exact, ensure_ascii=False)
    return rf"""(() => {{
  if (!document.body) return null;
  const prefix={prefix}, end={end}, maxRecords={max_records};
  const records=[];
  let current=null;
  const blocked=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE']);
  const visible=e=>!e.closest('[aria-hidden="true"],[hidden],[inert]') &&
    e.checkVisibility({{checkOpacity:true,checkVisibilityCSS:true}});
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let node,visited=0;
  while ((node=walker.nextNode()) && records.length<maxRecords && visited<200000) {{
    visited+=1;
    const parent=node.parentElement;
    if (!parent || blocked.has(parent.tagName)) continue;
    const raw=node.textContent||'';
    if (!raw.trim()) continue;
    let parentVisible;
    const isVisible=()=>{{
      if (parentVisible===undefined) parentVisible=visible(parent);
      return parentVisible;
    }};
    for (const part of raw.split(/\r?\n/)) {{
      const line=part.trim();
      if (!line) continue;
      if (current===null) {{
        if (!line.startsWith(prefix) || !isVisible()) continue;
        current=[line];
        continue;
      }}
      if (!isVisible()) continue;
      if (line.startsWith(prefix) && line!==current[0]) {{
        current=[line];
        continue;
      }}
      current.push(line);
      if (line===end) {{
        records.push(current.join('\n').slice(0,2000));
        current=null;
        if (records.length>=maxRecords) break;
      }}
    }}
  }}
  const height=document.documentElement.scrollHeight;
  const delta=Math.max(360,Math.floor(innerHeight*0.55));
  const actions=[];
  if (scrollY+innerHeight<height-2) actions.push({{
    id:'scroll_down',kind:'scroll',label:'Scroll down',delta
  }});
  if (scrollY>0) actions.push({{
    id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-delta
  }});
  actions.push({{id:'wait',kind:'wait',label:'Wait for the page to update'}});
  return {{
    url:location.href,title:document.title,text:'',collection_records:records,
    scroll:{{x:scrollX,y:scrollY,height,max_y:Math.max(0,height-innerHeight),viewport_height:innerHeight}},
    actions,
    marker:[performance.timeOrigin,location.href,scrollX,scrollY,document.title,records.length,height],
    page_key:[],guards:{{}},omitted_actions:0
  }};
}})()"""

INITIAL_SPARSE_TEXT_CHARS = 80
INITIAL_SETTLE_SECONDS = 6.0
INITIAL_POST_HYDRATION_GRACE_SECONDS = 1.5
INITIAL_SETTLE_POLL_SECONDS = 0.1
LAZY_SCROLL_SETTLE_SECONDS = 0.8
LAZY_SCROLL_POLL_SECONDS = 0.1
COLLECTION_SCROLL_SETTLE_SECONDS = 1.2
COLLECTION_SCROLL_QUIET_SECONDS = 0.25
BLOCKED_PROGRESS_SETTLE_SECONDS = 3.0
MAX_COLLECTION_STEPS = 120
COLLECTION_OBSERVE_RETRIES = 12
COLLECTION_OBSERVE_RETRY_SECONDS = 0.03
DETERMINISTIC_NAVIGATION_SETTLE_SECONDS = 1.5
DETERMINISTIC_NAVIGATION_POLL_SECONDS = 0.1


class ManagedAgent(UpstreamAgent):
    """Pinned upstream Agent with bounded dynamic-page settling."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._settle_sparse_initial_page()

    def _settle_sparse_initial_page(self) -> None:
        page = self.state["page"]
        if len(page.get("text", "").strip()) >= INITIAL_SPARSE_TEXT_CHARS:
            return
        deadline = time.monotonic() + INITIAL_SETTLE_SECONDS
        while time.monotonic() < deadline:
            time.sleep(INITIAL_SETTLE_POLL_SECONDS)
            page = self.browser.observe(screenshot=self.screenshots)
            self.state["page"] = page
            if len(page.get("text", "").strip()) >= INITIAL_SPARSE_TEXT_CHARS:
                return

    def settle_for_collection(self) -> None:
        """Give dynamic collection pages a bounded chance to become scrollable."""
        page = self.state["page"]
        scroll = page.get("scroll") or {}
        if float(scroll.get("max_y", 0) or 0) > 2:
            return
        deadline = time.monotonic() + INITIAL_SETTLE_SECONDS
        hydrated_at = time.monotonic() if len(page.get("text", "").strip()) >= INITIAL_SPARSE_TEXT_CHARS else None
        while time.monotonic() < deadline:
            time.sleep(INITIAL_SETTLE_POLL_SECONDS)
            page = self.browser.observe(screenshot=self.screenshots)
            self.state["page"] = page
            scroll = page.get("scroll") or {}
            if float(scroll.get("max_y", 0) or 0) > 2:
                return
            if len(page.get("text", "").strip()) >= INITIAL_SPARSE_TEXT_CHARS:
                hydrated_at = hydrated_at or time.monotonic()
                if time.monotonic() - hydrated_at >= INITIAL_POST_HYDRATION_GRACE_SECONDS:
                    return
            else:
                hydrated_at = None

    def _recover_lazy_scroll_block(self, result: dict[str, Any]) -> dict[str, Any]:
        state = self.state
        if state.get("status") != "blocked":
            return result
        recent = state.get("history", [])[-3:]
        if len(recent) != 3 or not all(
            item.get("kind") == "scroll" and item.get("page_changed") is False
            for item in recent
        ):
            return result

        previous = state["page"]
        previous_fingerprint = previous.get("fingerprint")
        deadline = time.monotonic() + LAZY_SCROLL_SETTLE_SECONDS
        while time.monotonic() < deadline:
            time.sleep(LAZY_SCROLL_POLL_SECONDS)
            candidate = self.browser.observe(screenshot=self.screenshots)
            state["page"] = candidate
            if candidate.get("fingerprint") != previous_fingerprint:
                state["status"] = "ready"
                state["history"][-1].update(
                    page_changed=True,
                    url=candidate.get("url", state["history"][-1].get("url")),
                )
                if state.get("started_at") is not None:
                    elapsed = round((time.perf_counter() - state["started_at"]) * 1000)
                    state["elapsed_ms"] = elapsed
                    state["history"][-1]["elapsed_ms"] = elapsed
                return self.snapshot()
        return result

    def _settle_after_collection_scroll(self) -> None:
        state = self.state
        recent = state.get("history", [])
        if not recent or recent[-1].get("kind") != "scroll":
            return

        baseline = state["page"].get("fingerprint")
        quiet_since = time.monotonic()
        deadline = quiet_since + COLLECTION_SCROLL_SETTLE_SECONDS
        changed_after_initial_observe = False
        while time.monotonic() < deadline:
            time.sleep(LAZY_SCROLL_POLL_SECONDS)
            candidate = self.browser.observe(screenshot=self.screenshots)
            fingerprint = candidate.get("fingerprint")
            state["page"] = candidate
            now = time.monotonic()
            if fingerprint != baseline:
                baseline = fingerprint
                quiet_since = now
                changed_after_initial_observe = True
            elif now - quiet_since >= COLLECTION_SCROLL_QUIET_SECONDS:
                break

        last = state["history"][-1]
        if changed_after_initial_observe:
            last["page_changed"] = True
        last["url"] = state["page"].get("url", last.get("url"))
        if state.get("started_at") is not None:
            elapsed = round((time.perf_counter() - state["started_at"]) * 1000)
            state["elapsed_ms"] = elapsed
            last["elapsed_ms"] = elapsed

    def command(self, name: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        result = super().command(name, body)
        if name == "tick":
            return self._recover_lazy_scroll_block(result)
        return result

    def _collection_evaluate(self, expression: str) -> Any:
        last_error: BaseException | None = None
        for attempt in range(COLLECTION_OBSERVE_RETRIES):
            try:
                value = self.browser.evaluate(expression)
                if value is not None:
                    return value
            except upstream_browser.StalePage as error:
                last_error = error
            if attempt + 1 < COLLECTION_OBSERVE_RETRIES:
                time.sleep(COLLECTION_OBSERVE_RETRY_SECONDS)
        if last_error is not None:
            raise last_error
        raise upstream_browser.StalePage("Collection page did not settle")

    def _collection_action_and_observe(
        self,
        page: dict[str, Any],
        action: dict[str, Any],
        *,
        start_prefix: str,
        end_exact: str,
        max_records: int,
    ) -> tuple[dict[str, Any], bool]:
        """Traverse with CDP input and return only bounded matching record blocks."""
        expected_origin = page.get("marker", [None])[0]
        expected_url = page.get("url")
        identity = self._collection_evaluate("[performance.timeOrigin,location.href]")
        same_document = (
            isinstance(identity, list)
            and len(identity) == 2
            and identity[0] == expected_origin
            and identity[1] == expected_url
        )
        if same_document:
            if action["kind"] == "scroll":
                self.browser.call(
                    "Input.dispatchMouseEvent",
                    type="mouseWheel",
                    x=550,
                    y=650,
                    deltaX=0,
                    deltaY=float(action.get("delta", 0)),
                )
                time.sleep(0.18)
            else:
                time.sleep(0.45)

        read_state = collection_read_state(start_prefix, end_exact, max_records)
        observed = self._collection_evaluate(read_state)
        if not isinstance(observed, dict):
            raise upstream_browser.StalePage("Document changed during collection traversal")

        if same_document and action["kind"] == "scroll":
            old_height = float((page.get("scroll") or {}).get("height", 0) or 0)
            new_height = float((observed.get("scroll") or {}).get("height", 0) or 0)
            previous_records = page.get("collection_records") or []
            current_records = observed.get("collection_records") or []
            if len(current_records) <= len(previous_records) and new_height <= old_height + 2:
                time.sleep(0.26)
                candidate = self._collection_evaluate(read_state)
                if isinstance(candidate, dict):
                    observed = candidate

        base_text = page.get("text", "") if isinstance(page.get("text"), str) else ""
        record_text = "\n".join(observed.get("collection_records") or [])
        observed["text"] = (base_text[:6000] + "\n" + record_text[:6000]).strip()
        observed["fingerprint"] = upstream_browser.fingerprint(observed)
        return observed, same_document

    def navigate_url_contains(self, expected: list[str]) -> tuple[dict[str, Any], bool]:
        """Click one uniquely identified link before asking TypeSafe to make a semantic choice."""
        state = self.state
        page = state.get("page") or {}

        def absolute_href(raw: str, current_url: str) -> str:
            return urljoin(current_url, raw)

        def visible_matches(current: dict[str, Any], target_href: str | None = None) -> list[dict[str, Any]]:
            current_url = current.get("url", "")
            matches = []
            for action in current.get("actions") or []:
                raw_href = action.get("href")
                if action.get("kind") != "click" or not isinstance(raw_href, str) or not raw_href:
                    continue
                resolved = absolute_href(raw_href, current_url)
                if target_href is not None:
                    if resolved == target_href:
                        matches.append(action)
                elif all(part in resolved for part in expected):
                    matches.append(action)
            return matches

        matches = visible_matches(page)
        hrefs = {
            absolute_href(action["href"], page.get("url", ""))
            for action in matches
        }
        target_href = next(iter(hrefs)) if len(hrefs) == 1 else None

        if target_href is None:
            parts = json.dumps(expected, ensure_ascii=False)
            deadline = time.monotonic() + DETERMINISTIC_NAVIGATION_SETTLE_SECONDS
            while time.monotonic() < deadline and target_href is None:
                target_href = self.browser.evaluate(f"""(() => {{
                  const parts={parts};
                  const matching=[...document.querySelectorAll('a[href]')].map(a=>({{
                    anchor:a,
                    href:new URL(a.getAttribute('href'),location.href).href
                  }})).filter(item=>parts.every(part=>item.href.includes(part)));
                  const hrefs=[...new Set(matching.map(item=>item.href))];
                  if (hrefs.length!==1) return null;
                  const item=matching.find(item=>item.href===hrefs[0]);
                  if (!item) return null;
                  item.anchor.scrollIntoView({{block:'center',inline:'center'}});
                  return hrefs[0];
                }})()""")
                if isinstance(target_href, str) and target_href:
                    break
                target_href = None
                time.sleep(DETERMINISTIC_NAVIGATION_POLL_SECONDS)

            if target_href is None:
                return self.snapshot(), False

            time.sleep(DETERMINISTIC_NAVIGATION_POLL_SECONDS)
            page = self.browser.observe(screenshot=self.screenshots)
            state["page"] = page
            matches = visible_matches(page, target_href)
            if not matches:
                return self.snapshot(), False

        action = matches[0]
        if state.get("started_at") is None:
            state["started_at"] = time.perf_counter()
        self.browser.act(action, page)
        observed = self.browser.observe(screenshot=self.screenshots)
        state["page"] = observed
        elapsed = round((time.perf_counter() - state["started_at"]) * 1000)
        state["elapsed_ms"] = elapsed
        state["status"] = "ready"
        state["history"].append({
            "step": len(state["history"]) + 1,
            "action": action["label"],
            "kind": action["kind"],
            "choice": action["id"],
            "operation": "CLICK",
            "target": str(action.get("node", action["id"])),
            "source": "navigation",
            "page_changed": observed["fingerprint"] != page["fingerprint"],
            "url": observed["url"],
            "executed_ms": elapsed,
            "elapsed_ms": elapsed,
        })
        return self.snapshot(), True

    def collection_step(
        self,
        *,
        prefer_wait: bool = False,
        start_prefix: str,
        end_exact: str,
        max_records: int,
    ) -> dict[str, Any]:
        """Advance an already-started collection without another model decision."""
        state = self.state
        if state.get("started_at") is None:
            state["started_at"] = time.perf_counter()
        page = state["page"]
        collection_steps = sum(
            1 for entry in state["history"] if entry.get("source") == "collection"
        )
        if collection_steps >= MAX_COLLECTION_STEPS:
            state["status"] = "blocked"
            raise ValueError(
                f"Stopped at the {MAX_COLLECTION_STEPS}-step deterministic collection budget"
            )

        actions = page.get("actions") or []
        wait_action = next((item for item in actions if item.get("kind") == "wait"), None)
        scroll_action = next((
            item for item in actions
            if item.get("id") == "scroll_down"
            or (item.get("kind") == "scroll" and float(item.get("delta", 0)) > 0)
        ), None)
        action = wait_action if prefer_wait and wait_action is not None else scroll_action
        if action is None:
            action = wait_action
        if action is None:
            raise ValueError("Collection traversal requires an observed scroll or wait action")

        observed, executed = self._collection_action_and_observe(
            page,
            action,
            start_prefix=start_prefix,
            end_exact=end_exact,
            max_records=max_records,
        )
        state["page"] = observed
        elapsed = round((time.perf_counter() - state["started_at"]) * 1000)
        state["elapsed_ms"] = elapsed
        state["status"] = "ready"
        if not executed:
            return self.snapshot()

        state["history"].append({
            "step": len(state["history"]) + 1,
            "action": action["label"],
            "kind": action["kind"],
            "choice": action["id"],
            "operation": "SCROLL_DOWN" if action["kind"] == "scroll" else "WAIT",
            "target": action["id"],
            "source": "collection",
            "page_changed": observed["fingerprint"] != page["fingerprint"],
            "url": observed["url"],
            "executed_ms": elapsed,
            "elapsed_ms": elapsed,
        })
        return self.snapshot()

    def _recover_blocked_progress(self) -> bool:
        state = self.state
        page = state.get("page") or {}
        actions = page.get("actions") or []
        if any(
            action.get("id") == "scroll_down"
            or (action.get("kind") == "scroll" and float(action.get("delta", 0)) > 0)
            for action in actions
        ):
            state["status"] = "ready"
            return True

        baseline_text = len(page.get("text", ""))
        baseline_actions = len(actions)
        deadline = time.monotonic() + BLOCKED_PROGRESS_SETTLE_SECONDS
        while time.monotonic() < deadline:
            time.sleep(LAZY_SCROLL_POLL_SECONDS)
            candidate = self.browser.observe(screenshot=self.screenshots)
            state["page"] = candidate
            candidate_actions = candidate.get("actions") or []
            scroll = candidate.get("scroll") or {}
            meaningful_progress = (
                float(scroll.get("max_y", 0) or 0) > 2
                or any(
                    action.get("id") == "scroll_down"
                    or (action.get("kind") == "scroll" and float(action.get("delta", 0)) > 0)
                    for action in candidate_actions
                )
                or len(candidate_actions) >= baseline_actions + 2
                or len(candidate.get("text", "")) >= baseline_text + 80
            )
            if meaningful_progress:
                state["status"] = "ready"
                if state.get("started_at") is not None:
                    state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                return True
        return False

    def tick_with_context(
        self,
        *,
        context: str = "",
        allow_done: bool = True,
        allow_blocked: bool = True,
        settle_after_scroll: bool = False,
    ) -> dict[str, Any]:
        original_goal = self.state["goal"]
        if context:
            self.state["goal"] = f"{original_goal}\n\nRuntime progress from Browser-Jev:\n{context}"
        try:
            result = self.command("tick")
            if settle_after_scroll:
                self._settle_after_collection_scroll()
                result = self.snapshot()
            status = result.get("status")
            if status == "done" and not allow_done:
                self.state["status"] = "ready"
                self.state["plan_index"] = 0
            elif status == "blocked" and not allow_blocked:
                self._recover_blocked_progress()
            return self.snapshot()
        finally:
            self.state["goal"] = original_goal
