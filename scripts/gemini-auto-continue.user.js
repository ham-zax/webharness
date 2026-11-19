// ==UserScript==
// @name         Gemini Auto-Continue (WebHarness)
// @namespace    https://github.com/webharness
// @version      1.2.2
// @description  Safely auto-continue Gemini Web checkpoints and optionally auto-allow confirmation cards.
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const STORE_KEY = 'wh_gemini_auto_continue_v1';
  const STABLE_MS = 4000;
  const COUNTDOWN_SEC = 5;
  const ALLOW_SETTLE_MS = 1000;
  const ALLOW_RETRY_MS = 12000;
  const ALLOW_MAX_ATTEMPTS = 2;
  const ALLOW_LABEL_RE = /^(allow|always allow|allow once|approve)$/i;
  const SENTINELS = ['[[AUTO_CONTINUE]]', '### Mid-Task Checkpoint'];
  const HANDOFF_MARKERS = ['[[HANDOFF]]', '### Fresh-Chat Handoff'];
  const STOP_TOKEN = '[[AUTO_STOP]]';
  const STOP_STATUS_RE = /^\s*[-*•]?\s*\*{0,2}Status:\*{0,2}\s*\*{0,2}(Done|Blocked)\b/mi;

  const SEL = {
    editor: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
    sendBtn: ['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label*="Send" i]'],
    stopBtn: ['button[aria-label*="Stop" i]', 'button.stop-button', 'mat-icon[fonticon="stop"]', '[data-mat-icon-name="stop"]'],
    busy: ['[aria-busy="true"]', 'mat-progress-bar', 'mat-progress-spinner', 'mat-spinner', '[role="progressbar"]', '[data-test-id*="tool"] [aria-busy="true"]', '.tool-call-card [role="progressbar"]', '.avatar_spinner_animation', '[class*="loading-spinner"]'],
    allowPrimary: 'remy-confirmation-card-v2 gem-button.primary-button button, remy-confirmation-card gem-button.primary-button button',
    allowDialog: 'gem-button.allow-for-conversation-button button, gem-button.allow-once-button button',
    errorBanner: '[role="alert"], .error-message, .snackbar-error',
  };

  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } })();
  const state = {
    armed: false,     // Auto-Continue: always OFF on page load
    autoAllow: false, // Auto-Allow: always OFF on page load (no allowlist: approves any pending card when ON)
    mode: saved.mode === 'nturns' ? 'nturns' : 'marker',
    maxTurns: Number(saved.maxTurns) > 0 ? Number(saved.maxTurns) : 5,
    turnsUsed: 0,
    allowsClicked: 0,
    prompt: typeof saved.prompt === 'string' && saved.prompt.trim() ? saved.prompt : 'Continue from the checkpoint.',
    collapsed: Boolean(saved.collapsed),
    url: location.pathname,
    lastHandledKey: '', lastSentCount: 0, stableKey: '', stableSince: 0,
    countdown: 0, countdownTimer: null, sending: false, status: 'Idle', lastRenderSig: '',
  };

  const allowAttempts = new WeakMap(); // button -> { count, lastAt }
  const h = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const k of kids) if (k != null && k !== false) node.append(typeof k === 'string' ? document.createTextNode(k) : k);
    return node;
  };

  const persist = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ mode: state.mode, maxTurns: state.maxTurns, prompt: state.prompt, collapsed: state.collapsed })); } catch {}
  };
  const isVisible = (el) => Boolean(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const isEnabled = (btn) => Boolean(
    isVisible(btn) &&
    !btn.disabled &&
    btn.getAttribute('aria-disabled') !== 'true' &&
    !btn.closest('.gem-button-disabled, [aria-disabled="true"]')
  );
  const queryFirst = (list) => { for (const s of list) { const el = document.querySelector(s); if (isVisible(el)) return el; } return null; };
  const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

  const getLatestResponse = () => {
    const mr = [...document.querySelectorAll('model-response')];
    const list = mr.length ? mr : [...document.querySelectorAll('message-content')];
    if (!list.length) return { count: 0, key: '', text: '' };
    const node = list[list.length - 1];
    const mc = node.querySelector('message-content[id]') || node;
    const text = (mc.innerText || '').trim();
    return { count: list.length, key: `${mc.id || 'idx_' + list.length}:${text.length}:${hashStr(text)}`, text };
  };

  const findPendingAllowButtons = () => {
    const found = new Set();
    for (const btn of document.querySelectorAll(SEL.allowPrimary)) {
      if (isEnabled(btn) && ALLOW_LABEL_RE.test((btn.innerText || '').trim())) found.add(btn);
    }
    for (const btn of document.querySelectorAll(SEL.allowDialog)) {
      if (isEnabled(btn)) found.add(btn);
    }
    if (!found.size) {
      for (const btn of document.querySelectorAll('button, [role="button"]')) {
        if (!isEnabled(btn) || btn.closest('#wh-auto-continue-hud')) continue;
        const lbl = ((btn.innerText || '') + ' ' + (btn.getAttribute('aria-label') || '')).trim();
        if (/^(allow|always allow|allow once)$/i.test(lbl)) found.add(btn);
      }
    }
    return [...found];
  };

  const isBusy = () => Boolean(queryFirst(SEL.stopBtn) || queryFirst(SEL.busy));
  const hasErrorBanner = () => [...document.querySelectorAll(SEL.errorBanner)].some((el) => isVisible(el) && /something went wrong|error|failed|try again/i.test(el.innerText || ''));

  const setStatus = (msg) => { if (state.status !== msg) { state.status = msg; render(); } };
  const clearCountdown = (reason) => {
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
    state.countdown = 0;
    if (reason) state.status = reason;
    render(true);
  };
  const disarm = (reason = 'Disarmed', alsoStopAllow = false) => {
    state.armed = false;
    if (alsoStopAllow) state.autoAllow = false;
    clearCountdown(reason);
  };

  const handlePendingApprovals = () => {
    const pending = findPendingAllowButtons();
    if (!pending.length) return false;
    if (!state.autoAllow) {
      if (state.armed) setStatus('Waiting: Allow prompt');
      return true;
    }
    const now = Date.now();
    for (const btn of pending) {
      const rec = allowAttempts.get(btn) || { count: 0, lastAt: 0 };
      if (rec.count >= ALLOW_MAX_ATTEMPTS) {
        if (now - rec.lastAt >= ALLOW_RETRY_MS) setStatus('Approval stuck — check tab');
        continue;
      }
      if (now - rec.lastAt < ALLOW_RETRY_MS) continue;
      allowAttempts.set(btn, { count: rec.count + 1, lastAt: now });
      setStatus('Auto-allowing...');
      setTimeout(() => {
        if (!state.autoAllow || !isEnabled(btn)) return;
        btn.click();
        state.allowsClicked += 1;
        state.stableKey = '';
        state.stableSince = 0;
        state.status = `Allowed (#${state.allowsClicked})`;
        render(true);
      }, ALLOW_SETTLE_MS);
    }
    return true;
  };

  const setEditorText = (editor, text) => {
    editor.focus();
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } catch {}
    if ((editor.innerText || '').trim() !== text.trim()) {
      const p = document.createElement('p');
      p.textContent = text;
      editor.replaceChildren(p);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const sendPrompt = (attempt = 1) => {
    const editor = queryFirst(SEL.editor);
    if (!editor) { state.sending = false; return disarm('No composer found'); }
    if (attempt === 1 && (editor.innerText || '').trim().length > 0) {
      state.sending = false;
      return clearCountdown('Paused: draft in box');
    }

    state.sending = true;
    const beforeSnap = getLatestResponse();
    setEditorText(editor, state.prompt);

    setTimeout(() => {
      const btn = queryFirst(SEL.sendBtn);
      if (btn && isEnabled(btn)) btn.click();
      else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

      setTimeout(() => {
        const curEditor = queryFirst(SEL.editor);
        const remaining = curEditor ? (curEditor.innerText || '').trim() : '';
        const afterSnap = getLatestResponse();
        const submitted = remaining === '' || isBusy() || afterSnap.count > beforeSnap.count;

        if (!submitted) {
          if (attempt < 2) return sendPrompt(attempt + 1);
          state.sending = false;
          return disarm('Send failed (check box)');
        }

        state.sending = false;
        state.stableKey = '';
        state.stableSince = 0;
        state.lastHandledKey = beforeSnap.key;
        state.lastSentCount = beforeSnap.count;
        state.turnsUsed += 1;
        state.status = `Sent (${state.turnsUsed}/${state.maxTurns})`;
        if (state.turnsUsed >= state.maxTurns) disarm(`Cap reached (${state.turnsUsed}/${state.maxTurns})`);
        else render(true);
      }, 350);
    }, 180);
  };

  const startCountdown = (snap) => {
    if (state.countdownTimer) return;
    state.countdown = COUNTDOWN_SEC;
    state.status = `Sending in ${state.countdown}s...`;
    render(true);
    state.countdownTimer = setInterval(() => {
      if (!state.armed || isBusy() || findPendingAllowButtons().length) return clearCountdown('Aborted: busy/approval');
      const editor = queryFirst(SEL.editor);
      if (editor && (editor.innerText || '').trim().length > 0) {
        state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
        return clearCountdown('Paused: draft in box');
      }
      if (--state.countdown <= 0) { clearCountdown('Sending...'); sendPrompt(); }
      else { state.status = `Sending in ${state.countdown}s...`; render(true); }
    }, 1000);
  };

  const tick = () => {
    if (location.pathname !== state.url) {
      state.url = location.pathname; state.turnsUsed = 0; state.allowsClicked = 0;
      state.lastHandledKey = ''; state.lastSentCount = 0;
      if (state.armed || state.autoAllow) disarm('Disarmed: chat changed', true);
      return;
    }
    if (!state.armed && !state.autoAllow) return;
    if (hasErrorBanner()) return disarm('Stopped: error banner', true);
    if (handlePendingApprovals()) return;
    if (!state.armed || state.countdownTimer || state.sending) return;
    if (state.turnsUsed >= state.maxTurns) return disarm(`Cap reached (${state.turnsUsed}/${state.maxTurns})`);
    if (isBusy()) { state.stableKey = ''; state.stableSince = 0; return setStatus('Streaming / running...'); }

    const snap = getLatestResponse();
    if (!snap.count || !snap.text) return;
    if (!(snap.count > state.lastSentCount || snap.key !== state.lastHandledKey)) return;

    if (snap.key !== state.stableKey) { state.stableKey = snap.key; state.stableSince = Date.now(); return setStatus('Waiting for stability...'); }
    if (Date.now() - state.stableSince < STABLE_MS) return;

    const handoff = HANDOFF_MARKERS.find((m) => snap.text.includes(m));
    if (handoff) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; return disarm('Handoff ready (new chat)'); }
    if (snap.text.includes(STOP_TOKEN)) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; return disarm(`Stopped: ${STOP_TOKEN}`); }
    const statusMatch = snap.text.match(STOP_STATUS_RE);
    if (statusMatch) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; return disarm(`Stopped: Status ${statusMatch[1]}`); }
    if (state.mode === 'marker' && !SENTINELS.some((s) => snap.text.includes(s))) return setStatus('Armed (no sentinel)');
    startCountdown(snap);
  };

  const hud = document.createElement('div');
  hud.id = 'wh-auto-continue-hud';
  Object.assign(hud.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '99999',
    background: 'rgba(20,22,27,0.9)', color: '#e8eaed', backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', padding: '8px 10px',
    font: '12px/1.35 system-ui,-apple-system,sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
    minWidth: '185px', maxWidth: '260px', userSelect: 'none',
  });
  document.body.appendChild(hud);

  const render = (force = false) => {
    if (!force && document.activeElement?.closest('#wh-auto-continue-hud input')) return;
    const sig = `${state.armed}|${state.autoAllow}|${state.allowsClicked}|${state.mode}|${state.turnsUsed}/${state.maxTurns}|${state.collapsed}|${state.countdown}|${state.status}`;
    if (!force && sig === state.lastRenderSig) return;
    state.lastRenderSig = sig;

    const row = (mt = '0') => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: mt });
    const dot = (color, sz = '8px') => h('span', { style: { width: sz, height: sz, borderRadius: '50%', background: color, display: 'inline-block' } });
    const topRow = h('div', { style: row() },
      h('button', { dataset: { act: 'toggle' }, style: { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '600' } },
        dot(state.armed ? '#34d399' : '#9aa0a6'), `Auto: ${state.armed ? 'ON' : 'OFF'}`),
      h('span', { style: { opacity: '.75' } }, `${state.turnsUsed}/${state.maxTurns}`),
      h('button', { dataset: { act: 'collapse' }, style: { all: 'unset', cursor: 'pointer', opacity: '.75', padding: '0 3px' } }, state.collapsed ? '+' : '−')
    );
    const allowRow = h('div', { style: row('5px') },
      h('button', { dataset: { act: 'allow' }, style: { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: '600' } },
        dot(state.autoAllow ? '#f59e0b' : '#9aa0a6', '7px'), `Allow: ${state.autoAllow ? 'ON (All)' : 'OFF'}`),
      state.allowsClicked ? h('span', { style: { opacity: '.7', fontSize: '11px' } }, `✓${state.allowsClicked}`) : null
    );
    const statusRow = state.countdown > 0
      ? h('div', { style: { ...row('6px'), background: 'rgba(251,191,36,0.16)', padding: '4px 6px', borderRadius: '6px' } },
          h('span', {}, state.status),
          h('button', { dataset: { act: 'cancel' }, style: { background: '#ef4444', color: '#fff', border: '0', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '11px' } }, 'Cancel'))
      : h('div', { style: { marginTop: '4px', opacity: '.75', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, state.status);

    const nodes = [topRow, allowRow, statusRow];
    if (!state.collapsed) {
      nodes.push(
        h('div', { style: { marginTop: '7px', paddingTop: '7px', borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: row() },
            h('button', { dataset: { act: 'mode' }, style: { background: 'rgba(255,255,255,0.1)', color: '#fff', border: '0', borderRadius: '5px', padding: '3px 7px', cursor: 'pointer', fontSize: '11px' } }, `Mode: ${state.mode === 'marker' ? 'Marker' : 'N-Turns'}`),
            h('label', { style: { fontSize: '11px', opacity: '.85' } }, 'Cap ',
              h('input', { dataset: { act: 'cap' }, type: 'number', min: '1', max: '50', value: String(state.maxTurns), style: { width: '38px', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '1px 4px', fontSize: '11px' } }))
          ),
          h('input', { dataset: { act: 'prompt' }, type: 'text', value: state.prompt, style: { width: '100%', boxSizing: 'border-box', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '5px', padding: '4px 6px', fontSize: '11px' } })
        )
      );
    }
    hud.replaceChildren(...nodes);
  };

  hud.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') {
      state.armed = !state.armed;
      if (state.armed) {
        const snap = getLatestResponse();
        state.lastHandledKey = snap.key; state.lastSentCount = snap.count; state.stableKey = '';
        state.status = state.mode === 'marker' ? 'Armed (Marker)' : 'Armed (N-Turns)';
      } else clearCountdown('Idle');
      render(true);
    } else if (act === 'allow') {
      state.autoAllow = !state.autoAllow;
      state.status = state.autoAllow ? 'Auto-Allow ON (All)' : 'Auto-Allow OFF';
      render(true);
      if (state.autoAllow) tick();
    } else if (act === 'mode') { state.mode = state.mode === 'marker' ? 'nturns' : 'marker'; persist(); render(true); }
    else if (act === 'collapse') { state.collapsed = !state.collapsed; persist(); render(true); }
    else if (act === 'cancel') { const s = getLatestResponse(); state.lastHandledKey = s.key; state.lastSentCount = s.count; clearCountdown('Canceled (waiting next)'); }
  });

  hud.addEventListener('change', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'cap') { state.maxTurns = Math.max(1, Math.min(50, Number(e.target.value) || 5)); persist(); render(true); }
    if (act === 'prompt') { state.prompt = e.target.value.trim() || 'Continue from the checkpoint.'; persist(); }
  });

  render(true);
  let obsTimer = null;
  new MutationObserver((muts) => {
    if (!state.armed && !state.autoAllow) return;
    if (muts.every((m) => hud.contains(m.target))) return;
    if (!obsTimer) obsTimer = setTimeout(() => { obsTimer = null; tick(); }, 250);
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class'] });
  setInterval(tick, 1500);
})();
