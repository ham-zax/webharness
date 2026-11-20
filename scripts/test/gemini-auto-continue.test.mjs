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
    getAttribute(k) { return this.attributes.get(k) ?? null; }
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
      for (const fn of (this._listeners?.get(event.type) ?? [])) fn(event);
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
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: (fn, ms) => { const id = nextTimerId++; intervals.set(id, { fn, ms, nextAt: nowMs + ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = nextTimerId++; timeouts.set(id, { fn, at: nowMs + ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    Math, Number, String, Boolean, Array, Object, Set, WeakMap, Map, JSON, RegExp, Error, Promise,
  };
  windowObj.window = windowObj;

  function advanceMs(ms) {
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
          iv.nextAt = nowMs + iv.ms;
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
    advanceMs, addModelResponse, setBusy,
  };
}

test('gemini-auto-continue: auto-stopped cap is not reset by Gemini response, but manual send restarts even with autoTag=false', async () => {
  const code = await fs.readFile(scriptPath, 'utf8');
  const sim = createSimulatedDom({ initialPath: '/app/chat-cap' });
  sim.addModelResponse('m0', 'Initial baseline');

  // When sendBtn is clicked programmatically or manually, simulate Gemini clearing the editor.
  sim.sendBtn.addEventListener('click', () => {
    sim.editor.innerText = '';
  });

  vm.runInNewContext(code, sim.sandbox);
  const api = sim.windowObj.__whAutoContinue;
  api.setState({ mode: 'nturns', maxTurns: 1, autoTag: true });

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

  // Now disable autoTag and perform an actual manual send (trusted click on sendBtn with text in editor).
  api.setState({ autoTag: false });
  sim.editor.innerText = 'User follow-up prompt';
  sim.document.dispatchEvent(new sim.FakeEvent('click', { target: sim.sendBtn, isTrusted: true, bubbles: true }));

  st = api.getState();
  assert.equal(st.armed, true, 'actual manual send must re-arm even when autoTag is false');
  assert.equal(st.autoStopped, false);
  assert.equal(st.turnsUsed, 0);
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

  // Second unique stable response WITHOUT sentinel -> hits handoffEvery=2 -> requests [[HANDOFF]].
  sim.addModelResponse('m2', 'Second ordinary reply');
  sim.advanceMs(1500);
  sim.advanceMs(4500);
  sim.advanceMs(600);
  assert.match(lastSentText, /\[\[HANDOFF\]\]/, 'compact handoff prompt must request [[HANDOFF]]');

  // Simulated rendered DOM where Gemini strips ### from Markdown heading (innerText has "Fresh-Chat Handoff" without ###).
  sim.addModelResponse('m3', 'Fresh-Chat Handoff\nGoal: Ship fix');
  sim.advanceMs(1500);
  sim.advanceMs(4500);
  const st = api.getState();
  assert.equal(st.handoffReady, true, 'rendered Fresh-Chat Handoff without ### must be recognized');
  assert.equal(st.armed, false);
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
