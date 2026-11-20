import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '..', 'gemini-auto-continue.user.js');

function createSimulatedDom({ initialPath = '/app/chat-1' } = {}) {
  let nowMs = 1_000_000;
  const intervals = new Map();
  const timeouts = new Map();
  let nextTimerId = 1;

  const storage = new Map();
  const listeners = new Map();
  const docListeners = new Map();

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this._text = '';
      this.id = '';
      this.className = '';
      this.disabled = false;
      this.isConnected = true;
      this.offsetWidth = 100;
      this.offsetHeight = 20;
      this.value = '';
      this.type = '';
      this.min = '';
      this.max = '';
      this.title = '';
    }
    get innerText() {
      if (this.children.length === 0) return this._text;
      return this.children.map(c => c.innerText ?? c.textContent ?? '').join('\n');
    }
    set innerText(v) { this._text = String(v); this.children = []; }
    get textContent() { return this.innerText; }
    set textContent(v) { this.innerText = v; }
    get firstChild() { return this.children[0] ?? null; }
    get firstElementChild() { return this.children.find(c => c instanceof FakeElement) ?? null; }
    getClientRects() { return this.isConnected ? [{ width: 100, height: 20 }] : []; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'id') this.id = String(v); }
    getAttribute(k) {
      if (this.attributes.has(k)) return this.attributes.get(k);
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (camel in this.dataset) return String(this.dataset[camel]);
      }
      return null;
    }
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') this._text += n;
        else if (n) { n.parentNode = this; n.isConnected = this.isConnected; this.children.push(n); }
      }
    }
    appendChild(node) { this.append(node); return node; }
    insertBefore(node, ref) {
      node.parentNode = this;
      node.isConnected = this.isConnected;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) this.children.push(node);
      else this.children.splice(idx, 0, node);
    }
    replaceChildren(...nodes) {
      this.children = [];
      this._text = '';
      this.append(...nodes);
    }
    contains(target) {
      let cur = target;
      while (cur) { if (cur === this) return true; cur = cur.parentNode; }
      return false;
    }
    closest(selector) {
      const parts = selector.split(',').map(s => s.trim());
      let cur = this;
      while (cur) {
        for (const p of parts) {
          if (matchesSelector(cur, p)) return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }
    querySelector(selector) { return queryAllFrom(this, selector)[0] ?? null; }
    querySelectorAll(selector) { return queryAllFrom(this, selector); }
    addEventListener(type, fn) {
      if (!this._listeners) this._listeners = new Map();
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    dispatchEvent(event) {
      event.target = event.target ?? this;
      let cur = this;
      while (cur) {
        for (const fn of (cur._listeners?.get(event.type) ?? [])) {
          if (event.stoppedImmediate) break;
          fn(event);
        }
        if (!event.bubbles || event.stoppedImmediate) break;
        cur = cur.parentNode;
      }
      return !event.defaultPrevented;
    }
    focus() {}
    click() {
      this.dispatchEvent(new FakeEvent('click', { bubbles: true, isTrusted: true }));
    }
  }

  function matchesSimple(el, sel) {
    if (!el || !(el instanceof FakeElement)) return false;
    let rest = sel.trim();
    if (rest.startsWith('#')) return el.id === rest.slice(1);
    const tagMatch = rest.match(/^[a-z0-9-]+/i);
    if (tagMatch) {
      if (el.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    const classMatches = [...rest.matchAll(/\.([a-z0-9_-]+)/gi)];
    for (const m of classMatches) {
      if (!el.className.split(/\s+/).includes(m[1])) return false;
    }
    const attrMatches = [...rest.matchAll(/\[([^\]=*~]+)(\*?=)?(?:"([^"]*)")?(?:\s+i)?\]/gi)];
    for (const m of attrMatches) {
      const [, attr, op, val] = m;
      const actual = el.getAttribute(attr);
      if (actual === null) return false;
      if (val !== undefined) {
        if (op === '*=') {
          if (!actual.toLowerCase().includes(val.toLowerCase())) return false;
        } else if (actual !== val) {
          return false;
        }
      }
    }
    return true;
  }

  function matchesSelector(el, selector) {
    const parts = selector.trim().match(/(?:[^\s[]+|\[[^\]]*\])+/g) ?? [];
    if (parts.length === 0) return false;
    if (parts.length === 1) return matchesSimple(el, parts[0]);
    if (!matchesSimple(el, parts[parts.length - 1])) return false;
    let cur = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      while (cur && !matchesSimple(cur, parts[i])) cur = cur.parentNode;
      if (!cur) return false;
      cur = cur.parentNode;
    }
    return true;
  }

  function queryAllFrom(root, selector) {
    const selectors = selector.split(',').map(s => s.trim());
    const out = [];
    const walk = node => {
      for (const child of node.children ?? []) {
        if (child instanceof FakeElement) {
          if (selectors.some(s => matchesSelector(child, s))) out.push(child);
          walk(child);
        }
      }
    };
    walk(root);
    return out;
  }

  class FakeEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.bubbles = Boolean(opts.bubbles);
      this.isTrusted = opts.isTrusted !== undefined ? Boolean(opts.isTrusted) : true;
      this.key = opts.key;
      this.shiftKey = Boolean(opts.shiftKey);
      this.ctrlKey = Boolean(opts.ctrlKey);
      this.altKey = Boolean(opts.altKey);
      this.metaKey = Boolean(opts.metaKey);
      this.isComposing = Boolean(opts.isComposing);
      this.code = opts.code;
      this.detail = opts.detail;
      this.defaultPrevented = false;
      this.stoppedImmediate = false;
      this.target = opts.target ?? null;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopImmediatePropagation() { this.stoppedImmediate = true; }
  }

  const body = new FakeElement('body');
  const editor = new FakeElement('div');
  editor.className = 'ql-editor';
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  const sendBtn = new FakeElement('button');
  sendBtn.setAttribute('aria-label', 'Send message');
  body.append(editor, sendBtn);

  const document = {
    body,
    hidden: false,
    activeElement: null,
    createElement: tag => new FakeElement(tag),
    createTextNode: text => { const n = new FakeElement('#text'); n._text = String(text); return n; },
    querySelector: sel => queryAllFrom(body, sel)[0] ?? null,
    querySelectorAll: sel => queryAllFrom(body, sel),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    dispatchEvent: ev => {
      for (const fn of (docListeners.get(ev.type) ?? [])) {
        if (ev.stoppedImmediate) break;
        fn(ev);
      }
    },
    execCommand: () => false,
  };

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() { return nowMs; }
  }

  const windowObj = {
    location: { pathname: initialPath },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent: ev => {
      for (const fn of (listeners.get(ev.type) ?? [])) fn(ev);
    },
    open: () => {},
  };

  const observers = [];
  const sandbox = {
    window: windowObj,
    document,
    location: windowObj.location,
    localStorage: windowObj.localStorage,
    navigator: windowObj.navigator,
    Date: FakeDate,
    CustomEvent: FakeEvent,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    Event: FakeEvent,
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { observers.push(this.cb); }
      disconnect() {}
    },
    setInterval: (fn, ms) => { const id = nextTimerId++; intervals.set(id, { fn, ms, nextAt: nowMs + ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = nextTimerId++; timeouts.set(id, { fn, at: nowMs + ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    Math, Number, String, Boolean, Array, Object, Set, WeakMap, Map, JSON, RegExp, Error, Promise,
  };
  windowObj.window = windowObj;

  function triggerMutation(target = body) {
    for (const cb of observers) cb([{ target }]);
  }

  function advanceMs(ms, { clampIntervalMs = 0 } = {}) {
    const target = nowMs + ms;
    while (true) {
      let nextTime = target + 1;
      let nextKind = null;
      let nextId = null;
      for (const [id, t] of timeouts) {
        if (t.at <= target && t.at < nextTime) { nextTime = t.at; nextKind = 'timeout'; nextId = id; }
      }
      for (const [id, iv] of intervals) {
        if (iv.nextAt <= target && iv.nextAt < nextTime) { nextTime = iv.nextAt; nextKind = 'interval'; nextId = id; }
      }
      if (!nextKind) break;
      nowMs = nextTime;
      if (nextKind === 'timeout') {
        const t = timeouts.get(nextId);
        timeouts.delete(nextId);
        t?.fn();
      } else {
        const iv = intervals.get(nextId);
        if (iv) {
          iv.nextAt = nowMs + (clampIntervalMs > 0 ? Math.max(iv.ms, clampIntervalMs) : iv.ms);
          iv.fn();
        }
      }
    }
    nowMs = target;
  }

  function addModelResponse(id, text) {
    const mr = new FakeElement('model-response');
    const mc = new FakeElement('message-content');
    mc.setAttribute('id', id);
    mc.innerText = text;
    mr.append(mc);
    body.append(mr);
    return mc;
  }

  function setBusy(busy) {
    const existing = body.querySelector('[aria-busy="true"]');
    if (busy && !existing) {
      const b = new FakeElement('div');
      b.setAttribute('aria-busy', 'true');
      body.append(b);
    } else if (!busy && existing) {
      body.children = body.children.filter(c => c !== existing);
    }
  }

  return {
    sandbox, windowObj, document, body, editor, sendBtn, FakeEvent,
    advanceMs, addModelResponse, setBusy, triggerMutation,
  };
}

test('gemini-auto-continue: auto-stopped cap is not reset by Gemini response, and manual send re-arms with wired handshake tag', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sim = createSimulatedDom({ initialPath: '/app/chat-cap' });
  sim.addModelResponse('m0', 'Initial baseline');

  const sent = [];
  sim.sendBtn.addEventListener('click', () => {
    sent.push(sim.editor.innerText);
    sim.editor.innerText = '';
  });

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;
  api.setState({ mode: 'nturns', maxTurns: 1 });
  assert.equal('autoTag' in api.getState(), false, 'autoTag toggle must be removed (wired to Auto)');

  // First tick establishes baseline.
  sim.advanceMs(1500);
  // New response arrives -> wait 4s stability -> 5s countdown -> sends automatic turn 1/1 -> hits cap (autoStopped=true, armed=false).
  sim.addModelResponse('m1', 'Step 1 output');
  sim.advanceMs(1500); // stableSince set
  sim.advanceMs(4500); // stable -> startCountdown (5s)
  sim.advanceMs(5000); // countdown expires -> sendPrompt
  sim.advanceMs(600);  // sendPrompt confirm timers

  let st = api.getState();
  assert.equal(st.turnsUsed, 1);
  assert.equal(st.armed, false);
  assert.equal(st.autoStopped, true);

  // Now Gemini becomes busy and emits the response to that final automatic prompt.
  sim.setBusy(true);
  sim.advanceMs(1500);
  sim.setBusy(false);
  sim.addModelResponse('m2', 'Final automatic turn response');
  sim.advanceMs(3000);

  st = api.getState();
  assert.equal(st.armed, false, 'response to final automatic prompt must NOT re-arm');
  assert.equal(st.autoStopped, true);
  assert.equal(st.turnsUsed, 1);

  // Actual manual send re-arms and automatically prepends [wh-ac: ...] handshake tag.
  sim.editor.innerText = 'User follow-up prompt';
  sim.document.dispatchEvent(new sim.FakeEvent('click', { target: sim.sendBtn, isTrusted: true, bubbles: true }));
  sim.advanceMs(250);

  st = api.getState();
  assert.equal(st.armed, true, 'actual manual send must re-arm');
  assert.equal(st.autoStopped, false);
  assert.equal(st.turnsUsed, 0);
  assert.match(sent.at(-1), /^\[wh-ac: turn=0\/1 mode=nturns allow=on chat=1\/6\]/, 'wired handshake tag must prepend on manual send');

  // Manually turning Auto OFF prevents tag injection on manual send.
  api.setState({ armed: false });
  sim.editor.innerText = 'Plain chat prompt';
  const ev = new sim.FakeEvent('click', { target: sim.sendBtn, isTrusted: true, bubbles: true });
  sim.document.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'manual OFF must not intercept or tag user sends');
  assert.equal(sim.editor.innerText, 'Plain chat prompt');
});

test('gemini-auto-continue: Wrap Up guards empty/busy states, works while Auto OFF, and copies turnkey resume wrapper', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sim = createSimulatedDom({ initialPath: '/app' });
  let copied = '';
  sim.windowObj.navigator.clipboard.writeText = async (t) => { copied = t; };
  const sent = [];
  sim.sendBtn.addEventListener('click', () => {
    sent.push(sim.editor.innerText);
    sim.editor.innerText = '';
  });

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;

  // Empty chat -> Wrap Up must refuse instead of sending nonsense
  api.wrapUp();
  assert.equal(sent.length, 0, 'Wrap Up must not fire on empty chat');
  assert.equal(api.getState().status, 'Nothing to wrap up yet');

  // Add a reply, then manually turn Auto OFF, then click Wrap Up -> must still send and capture [[HANDOFF]]
  sim.addModelResponse('m1', 'Work in progress');
  api.setState({ armed: false });
  api.wrapUp();
  sim.advanceMs(600);
  assert.equal(sent.length, 1, 'Wrap Up must send even when Auto is OFF');
  assert.match(sent[0], /## Owed to the user/);
  assert.match(sent[0], /just handoff-state/);

  sim.addModelResponse('m2', '[[HANDOFF]]\n### Fresh-Chat Handoff\nhandoff_action: continue\n## Goal\nFinish migration');
  sim.advanceMs(1500);
  sim.advanceMs(4500);
  assert.equal(api.getState().handoffReady, true, 'handoff response must be captured even when Auto was OFF');
  assert.equal(api.getState().armed, false, 'Auto must remain OFF after manual handoff');

  await api.copyHandoff(false);
  assert.match(copied, /^Continue this task in a fresh chat from the handoff below\./, 'copied handoff must include turnkey resume header');
  assert.match(copied, /### Fresh-Chat Handoff\nhandoff_action: continue\n## Goal\nFinish migration/);
});

test('gemini-auto-continue: stable response without sentinel counts once and rendered handoff marker works without ###', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sim = createSimulatedDom({ initialPath: '/app/chat-cadence' });
  sim.addModelResponse('m0', 'Initial baseline');

  let lastSentText = '';
  sim.sendBtn.addEventListener('click', () => {
    lastSentText = sim.editor.innerText;
    sim.editor.innerText = '';
  });

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;
  api.setState({ mode: 'marker', handoffEvery: 2 });

  // Baseline
  sim.advanceMs(1500);

  // First stable response WITHOUT sentinel.
  sim.addModelResponse('m1', 'Ordinary reply without sentinel');
  sim.advanceMs(1500); // stableSince set
  sim.advanceMs(4500); // observed once (assistantTurnsObserved = 1)
  // Run 5 more ticks on the same unchanged response: must NOT increment assistantTurnsObserved to 2 and trigger handoff!
  sim.advanceMs(7500);
  assert.equal(lastSentText, '', 'unchanged stable response without sentinel must only count once');

  // Second unique stable response WITHOUT sentinel -> hits handoffEvery=2 -> requests seamless-claude [[HANDOFF]].
  sim.addModelResponse('m2', 'Second ordinary reply');
  sim.advanceMs(1500);
  sim.advanceMs(4500);
  sim.advanceMs(600);
  assert.match(lastSentText, /\[\[HANDOFF\]\]/, 'handoff prompt must request [[HANDOFF]]');
  assert.match(lastSentText, /## Owed to the user/, 'handoff prompt must include seamless-claude sections');
  assert.match(lastSentText, /## Next step/, 'handoff prompt must include ## Next step');

  // Simulated rendered DOM where Gemini strips ### from Markdown heading (innerText has "Fresh-Chat Handoff" without ###).
  sim.addModelResponse('m3', 'Fresh-Chat Handoff\n## Goal\nShip fix');
  sim.advanceMs(1500);
  sim.advanceMs(4500);
  const st = api.getState();
  assert.equal(st.handoffReady, true, 'rendered Fresh-Chat Handoff without ### must be recognized');
  assert.equal(st.armed, false);
  assert.equal(st.chatTurns, 3, 'truthful chatTurns count stays intact on old chat until you move to a new chat');
});

test('gemini-auto-continue: no fake ctx meter, ignores pre/code markers, and persists chatTurns across reload', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sharedStorage = new Map();
  const sim = createSimulatedDom({ initialPath: '/app/chat-honest' });
  sim.windowObj.localStorage.getItem = k => (sharedStorage.has(k) ? sharedStorage.get(k) : null);
  sim.windowObj.localStorage.setItem = (k, v) => { sharedStorage.set(k, String(v)); };
  const initialMsg = sim.addModelResponse('m0', 'Hello world');

  let sentPrompts = [];
  sim.sendBtn.addEventListener('click', () => {
    sentPrompts.push(sim.editor.innerText);
    sim.editor.innerText = '';
  });

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;
  let st = api.getState();
  assert.equal(st.handoffEvery, 6);
  assert.equal('estContextTokens' in st, false);

  // Baseline tick
  sim.advanceMs(1500);

  // Add a response whose ONLY handoff/stop/continue markers live inside <pre> and <code> blocks
  const mrCode = sim.document.createElement('model-response');
  const mcCode = sim.document.createElement('message-content');
  mcCode.setAttribute('id', 'm1');
  const pIntro = sim.document.createElement('p');
  pIntro.append(
    sim.document.createTextNode('Example markers: '),
    (() => { const c = sim.document.createElement('code'); c.innerText = '[[AUTO_STOP]]'; return c; })(),
    sim.document.createTextNode(' and '),
    (() => { const c = sim.document.createElement('code'); c.innerText = '[[AUTO_CONTINUE]]'; return c; })(),
  );
  const pre = sim.document.createElement('pre');
  const codeEl = sim.document.createElement('code');
  codeEl.innerText = '### Fresh-Chat Handoff\nGoal: Do not trigger from code block';
  pre.append(codeEl);
  mcCode.append(pIntro, pre);
  mrCode.append(mcCode);
  sim.body.append(mrCode);

  sim.advanceMs(1500);
  sim.advanceMs(4500);
  st = api.getState();
  assert.equal(st.handoffReady, false, 'code-block Fresh-Chat Handoff must NOT trigger handoff');
  assert.equal(st.armed, true, 'inline [[AUTO_STOP]] in code must NOT disarm');
  assert.equal(sentPrompts.length, 0, 'inline [[AUTO_CONTINUE]] in code must NOT auto-continue');
  assert.equal(st.chatTurns, 1, 'observed turn must increment to 1');
  assert.equal(st.userTouched, false, 'passive turn persistence must NOT mark userTouched');

  // Simulate full page reload on the same chat URL with shared localStorage
  const sim2 = createSimulatedDom({ initialPath: '/app/chat-honest' });
  sim2.windowObj.localStorage.getItem = k => (sharedStorage.has(k) ? sharedStorage.get(k) : null);
  sim2.windowObj.localStorage.setItem = (k, v) => { sharedStorage.set(k, String(v)); };
  sim2.addModelResponse('m1', 'Example markers');
  const sentPrompts2 = [];
  sim2.sendBtn.addEventListener('click', () => {
    sentPrompts2.push(sim2.editor.innerText);
    sim2.editor.innerText = '';
  });
  vm.runInNewContext(code, sim2.sandbox);
  const api2 = sim2.windowObj.__whAutoContinue;
  assert.equal(api2.getState().chatTurns, 1, 'chatTurns must survive page reload');
  assert.equal(api2.getState().userTouched, false);

  // Baseline after reload, then a real rendered <h3>Mid-Task Checkpoint</h3>
  sim2.advanceMs(1500);
  const mrCkpt = sim2.document.createElement('model-response');
  const mcCkpt = sim2.document.createElement('message-content');
  mcCkpt.setAttribute('id', 'm2');
  const h3 = sim2.document.createElement('h3');
  h3.innerText = 'Mid-Task Checkpoint';
  const pBody = sim2.document.createElement('p');
  pBody.innerText = 'Remaining step: verify tests.';
  mcCkpt.append(h3, pBody);
  mrCkpt.append(mcCkpt);
  sim2.body.append(mrCkpt);

  sim2.advanceMs(1500);
  sim2.advanceMs(4500);
  sim2.advanceMs(5000);
  sim2.advanceMs(600);
  assert.equal(sentPrompts2.length, 1, 'real rendered Mid-Task Checkpoint heading must auto-continue');
  assert.equal(api2.getState().chatTurns, 2, 'chatTurns must continue incrementing after reload');
  assert.match(sentPrompts2[0], /^\[wh-ac: turn=1\/5 mode=marker allow=on chat=2\/6\]/, 'telemetry tag must show honest persisted chat turn count without fake ctx=~...');
  assert.doesNotMatch(sentPrompts2[0], /ctx=/, 'telemetry tag must not include fake ctx= estimate');
  assert.ok(initialMsg.id === 'm0');
});

test('gemini-auto-continue: Status: Done and Auto: OFF still increment chatTurns, show Standby, and Reset preserves turn count', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sim = createSimulatedDom({ initialPath: '/app/chat-turns-fix' });
  sim.addModelResponse('m0', 'Baseline');

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;
  const hud = sim.document.querySelector('#wh-auto-continue-hud');

  // Baseline
  sim.advanceMs(1500);

  // Reply 1 ends with Status: Done -> must STILL increment chatTurns to 1 and show Auto: Standby
  sim.addModelResponse('m1', 'Task complete.\nStatus: Done');
  sim.advanceMs(1500);
  sim.advanceMs(4500);
  let st = api.getState();
  assert.equal(st.chatTurns, 1, 'Status: Done reply must increment chatTurns');
  assert.equal(st.armed, false);
  assert.equal(st.autoStopped, true);
  assert.match(hud.innerText, /Auto: Standby/, 'auto-stopped state must display Auto: Standby instead of Auto: OFF');
  assert.match(hud.innerText, /Handoff 1\/6/);

  // Reply 2 arrives while manually turned Auto: OFF -> passive tracker must STILL count it (chatTurns = 2)
  api.setState({ armed: false });
  assert.match(hud.innerText, /Auto: OFF/, 'manual OFF must display Auto: OFF');
  sim.addModelResponse('m2', 'Second reply while Auto OFF');
  sim.advanceMs(1500);
  sim.advanceMs(4500);
  st = api.getState();
  assert.equal(st.chatTurns, 2, 'replies while Auto OFF must still increment chatTurns');

  // Resetting per-chat overrides must keep chatTurns intact
  api.resetChat();
  st = api.getState();
  assert.equal(st.chatTurns, 2, 'resetChat must preserve honest chatTurns count');
  assert.equal(st.userTouched, false);
});

test('gemini-auto-continue: dynamic 2-turn Wrap Up, durable handoff across reload, Settings timers, and same-tab model restore', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sharedStorage = new Map();
  const sim = createSimulatedDom({ initialPath: '/app/chat-wrapup' });
  sim.windowObj.localStorage.getItem = k => (sharedStorage.has(k) ? sharedStorage.get(k) : null);
  sim.windowObj.localStorage.setItem = (k, v) => { sharedStorage.set(k, String(v)); };

  // Add Gemini model switcher button + New chat link to DOM
  const modeBtn = sim.document.createElement('button');
  modeBtn.setAttribute('data-test-id', 'bard-mode-menu-button');
  modeBtn.setAttribute('aria-label', 'Open mode picker, currently Neon');
  modeBtn.innerText = 'Neon High';
  let activeModelLabel = 'Neon High';

  // When modeBtn is clicked, open a simulated .cdk-overlay-pane with menuitemradio options
  modeBtn.addEventListener('click', () => {
    const old = sim.body.querySelector('.cdk-overlay-pane');
    if (old) sim.body.children = sim.body.children.filter(c => c !== old);
    const pane = sim.document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    const mkRadio = (testId, label, checked, onPick) => {
      const el = sim.document.createElement('gem-menu-item');
      el.setAttribute('role', 'menuitemradio');
      if (testId) el.setAttribute('data-test-id', testId);
      el.setAttribute('aria-checked', String(checked));
      el.innerText = label;
      el.addEventListener('click', onPick);
      return el;
    };
    pane.append(
      mkRadio('bard-mode-option-h', 'Everyday help Hydrogen', /Hydrogen/.test(activeModelLabel), () => {
        activeModelLabel = activeModelLabel.replace(/Neon|Hydrogen/, 'Hydrogen');
        modeBtn.setAttribute('aria-label', 'Open mode picker, currently Hydrogen');
        modeBtn.innerText = activeModelLabel;
      }),
      mkRadio('bard-mode-option-n', 'Deeper analysis Neon', /Neon/.test(activeModelLabel), () => {
        activeModelLabel = activeModelLabel.replace(/Neon|Hydrogen/, 'Neon');
        modeBtn.setAttribute('aria-label', 'Open mode picker, currently Neon');
        modeBtn.innerText = activeModelLabel;
      }),
      mkRadio(null, 'Low Fast and efficient', /Low/.test(activeModelLabel), () => {
        activeModelLabel = activeModelLabel.replace(/Low|Medium|High/, 'Low');
        modeBtn.innerText = activeModelLabel;
      }),
      mkRadio(null, 'High Extra thorough', /High/.test(activeModelLabel), () => {
        activeModelLabel = activeModelLabel.replace(/Low|Medium|High/, 'High');
        modeBtn.innerText = activeModelLabel;
      }),
    );
    sim.body.append(pane);
  });

  const newChatLink = sim.document.createElement('a');
  newChatLink.setAttribute('href', '/app');
  newChatLink.innerText = 'New chat';
  newChatLink.addEventListener('click', () => {
    // Simulate Gemini resetting to /app on Hydrogen Low (so restoreModel must switch it back to Neon High)
    sim.windowObj.location.pathname = '/app';
    sim.editor.innerText = '';
    activeModelLabel = 'Hydrogen Low';
    modeBtn.setAttribute('aria-label', 'Open mode picker, currently Hydrogen');
    modeBtn.innerText = 'Hydrogen Low';
  });

  sim.body.append(modeBtn, newChatLink);
  sim.addModelResponse('m0', 'Working on feature');

  const sent = [];
  sim.sendBtn.addEventListener('click', () => {
    sent.push(sim.editor.innerText);
    sim.editor.innerText = '';
  });

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;
  const hud = sim.document.querySelector('#wh-auto-continue-hud');

  // Open Settings UI via gear button, adjust timers (countdownSec=0, stableSec=2, allowDelayMs=250)
  const gearBtn = hud.querySelector('[data-act="settings"]');
  assert.ok(gearBtn, 'HUD must render gear settings button');
  gearBtn.click();
  assert.equal(api.getState().settingsOpen, true);
  assert.match(hud.innerText, /Timers & Delays/);
  assert.match(hud.innerText, /Send countdown/);

  api.setState({ countdownSec: 0, stableSec: 2, allowDelayMs: 250, wrapUpMaxTurns: 2, settingsOpen: false });
  assert.equal(api.getState().countdownSec, 0);
  assert.equal(api.getState().stableSec, 2);
  assert.equal(api.getState().allowDelayMs, 250);

  // Baseline
  sim.advanceMs(1500);

  // Trigger Wrap Up -> turn 1 sends WRAP_UP_REQUEST_PROMPT
  api.wrapUp();
  sim.advanceMs(600);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Wrap up this session to the nearest clean checkpoint/);

  // Gemini uses Turn 1 to move test to pueue and replies with Mid-Task Checkpoint (no [[HANDOFF]] yet)
  sim.addModelResponse('m1', 'Moved test suite to pueue job 7.\n### Mid-Task Checkpoint\nReady for final handoff.');
  sim.advanceMs(1500);
  sim.advanceMs(2500); // stableSec=2 -> countdownSec=0 -> sends final wrap-up nudge immediately
  sim.advanceMs(600);
  assert.equal(sent.length, 2, 'dynamic Wrap Up must automatically send final handoff nudge on turn 2');
  assert.match(sent[1], /Finish wrapping up now/);

  // Turn 2 emits [[HANDOFF]] -> stages handoff durably and captures Neon High
  sim.addModelResponse('m2', '[[HANDOFF]]\n### Fresh-Chat Handoff\nhandoff_action: continue\n## Goal\nResume tests\n## Live state\npueue job 7');
  sim.advanceMs(1500);
  sim.advanceMs(2500);
  assert.equal(api.getState().handoffReady, true);
  assert.equal(api.getState().handoffMeta.model, 'Neon');
  assert.equal(api.getState().handoffMeta.thinking, 'High');
  assert.match(hud.innerText, /Copy Prompt/);
  assert.match(hud.innerText, /Start New Chat/);

  // Verify staged handoff survives full page reload on the same chat URL
  const simReload = createSimulatedDom({ initialPath: '/app/chat-wrapup' });
  simReload.windowObj.localStorage.getItem = k => (sharedStorage.has(k) ? sharedStorage.get(k) : null);
  simReload.windowObj.localStorage.setItem = (k, v) => { sharedStorage.set(k, String(v)); };
  vm.runInNewContext(code, simReload.sandbox);
  assert.equal(simReload.windowObj.__whAutoContinue.getState().handoffReady, true, 'staged handoff must survive page reload');
  assert.equal(simReload.windowObj.__whAutoContinue.getState().handoffMeta.model, 'Neon');

  // Click Start New Chat (same-tab) -> clicks /app, restores Neon High, pastes prompt ready for Enter (autoSendHandoff=false)
  api.startNewChat(false);
  sim.advanceMs(1200);
  // Flush microtasks from async restoreModelSelection
  await new Promise(r => setImmediate(r));
  sim.advanceMs(800);
  await new Promise(r => setImmediate(r));
  sim.advanceMs(400);
  await new Promise(r => setImmediate(r));

  assert.equal(sim.windowObj.location.pathname, '/app', 'Start New Chat must navigate same tab to /app');
  assert.equal(modeBtn.innerText, 'Neon High', 'model + thinking level must be restored to Neon High');
  assert.match(sim.editor.innerText, /Continue this task in a fresh chat from the handoff below\./);
  assert.match(sim.editor.innerText, /pueue job 7/);
  assert.equal(sent.length, 2, 'with autoSendHandoff=false, handoff must paste and wait for user Enter');
});

test('gemini-auto-continue: Chrome background tab (60s-clamped setInterval) fires stability wake and [[AUTO_WAIT: 80]] on time', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sim = createSimulatedDom({ initialPath: '/app/chat-bg-chrome' });
  sim.addModelResponse('m0', 'Baseline reply');

  const sent = [];
  sim.sendBtn.addEventListener('click', () => {
    sent.push(sim.editor.innerText);
    sim.editor.innerText = '';
  });

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;
  api.setState({ mode: 'marker', maxTurns: 10, stableSec: 4, countdownSec: 5, skipBgCountdown: true });

  // Establish baseline, then background the tab and clamp all setInterval timers to 60s (Chrome Intensive Throttling).
  sim.advanceMs(1500);
  sim.document.hidden = true;
  sim.advanceMs(1500, { clampIntervalMs: 60_000 }); // pushes the 1500ms tick interval out to +60s

  // 1. Standard checkpoint in background tab: must fire in ~5s via one-shot stability wake (NOT wait 60s!)
  const m1 = sim.addModelResponse('m1', '### Mid-Task Checkpoint\nStep 1 done.');
  sim.triggerMutation(m1);
  sim.advanceMs(5000, { clampIntervalMs: 60_000 });
  assert.equal(sent.length, 1, 'background checkpoint must auto-continue within ~5s even when setInterval is clamped to 60s');

  // 2. [[AUTO_WAIT: 80]] + multiline [[AUTO_CONTINUE: ...]] in background tab: must NOT fire early, must fire at ~85s (not 120s+)
  const m2 = sim.addModelResponse('m2', [
    'Launched Phase 1 job.',
    '[[AUTO_WAIT: 80]]',
    '[[AUTO_CONTINUE: Inspect the completed Phase 1 report',
    'and run Phase 2 isolated ablations.]]',
  ].join('\n'));
  sim.triggerMutation(m2);
  sim.advanceMs(75_000, { clampIntervalMs: 60_000 });
  assert.equal(sent.length, 1, 'AUTO_WAIT: 80 must not fire early at 75s');

  sim.advanceMs(12_000, { clampIntervalMs: 60_000 }); // total 87s since m2 arrived (~4.1s stability + 80s wait + 0.6s send)
  assert.equal(sent.length, 2, 'AUTO_WAIT: 80 must fire on time in background Chrome tab via one-shot deadline timer');
  assert.match(sent[1], /Inspect the completed Phase 1 report and run Phase 2 isolated ablations\./, 'multiline AUTO_CONTINUE must normalize cleanly');
});
