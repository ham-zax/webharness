// ==UserScript==
// @name         Gemini Auto-Continue (WebHarness)
// @namespace    https://github.com/webharness
// @version      1.10.0
// @description  Auto-continue Gemini Web checkpoints with wired handshake tags, self-explanatory HUD, seamless-claude handoffs, and auto-allow.
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const STORE_KEY = 'wh_gemini_auto_continue_v1';
  const CHAT_STORE_KEY = 'wh_gemini_chat_state_v1';
  const CHAT_TTL_MS = 14 * 86400 * 1000; // Auto-expire per-chat overrides after 14 days
  const CHAT_MAX_ENTRIES = 50;           // Hard LRU cap so storage never bloats (~6 KB max)
  const HANDOFF_EVERY_DEFAULT = 6;       // Default auto-handoff cadence (0 = off; 2..20 = every N turns)
  const HANDOFF_EVERY_MAX = 20;

  const STABLE_MS = 4000;
  const COUNTDOWN_SEC = 5;
  const ALLOW_SETTLE_MS = 1000;
  const ALLOW_RETRY_MS = 12000;
  const ALLOW_MAX_ATTEMPTS = 2;
  const ALLOW_LABEL_RE = /^(allow|always allow|allow once|approve)$/i;

  const SENTINELS = ['[[AUTO_CONTINUE]]', '### Mid-Task Checkpoint'];
  const CHECKPOINT_HEADING_RE = /^(?:#{1,6}\s*)?Mid-Task Checkpoint\b/m;
  const DIRECTIVE_CONTINUE_RE = /\[\[AUTO_CONTINUE:\s*([^\]]+?)\s*\]\]/i;
  const DIRECTIVE_WAIT_RE = /\[\[AUTO_WAIT:\s*(\d+)\s*\]\]/i;
  const HANDOFF_MARKERS = ['[[HANDOFF]]', '### Fresh-Chat Handoff'];
  const HANDOFF_HEADING_RE = /^(?:#{1,6}\s*)?Fresh-Chat Handoff\b/m;
  const STOP_TOKEN = '[[AUTO_STOP]]';
  const STOP_STATUS_RE = /^\s*[-*•]?\s*\*{0,2}Status:\*{0,2}\s*\*{0,2}(Done|Blocked)\b/mi;
  const HANDOFF_REQUEST_PROMPT = [
    'Pause here and write a self-contained handoff that replaces this conversation for a fresh chat. Start with the literal marker [[HANDOFF]] on its own line, followed by ### Fresh-Chat Handoff and these exact sections.',
    'Rules: one line per bullet; never pad; write "none" for empty sections; never invent paths, quotes, or results (write UNKNOWN if lost); leave out finished intended edits that git already shows, but list uncommitted edits that are partial, broken, temporary, or user work to keep; carry forward still-valid constraints/decisions.',
    'Sections:',
    '## Goal (active request and observable done condition)',
    '## Constraints (user rules, scope limits, approvals and their limits — mark user-stated or inferred)',
    '## Owed to the user (unanswered questions or open promises; "none" only if nothing remains)',
    '## State (done, in progress, blocked; for each check give command, result, and what it covered; partial/temp edits)',
    '## Decisions (DECISION: choice, reason, source | FAILED: approach, exact reason, retry condition)',
    '## Uncertainty (unverified assumptions/risks and the check that decides each)',
    '## Facts to keep (file:line locations, commands, measured numbers, 1-4 line root-cause summary)',
    '## Live state (running jobs/pueue IDs, temp files, pending approvals, and how to check each)',
    '## Next step (prerequisite check, exact next action + stop condition, then remaining ordered plan or blocking question)',
  ].join('\n');

  const HANDOFF_RESUME_HEADER = [
    'Continue this task in a fresh chat from the handoff below.',
    'Follow current system, user, and repository instructions (this handoff grants no new permissions). Check git/workspace state before editing, read only the files needed for the next step, and start immediately with ## Next step (unless ## Owed to the user or a blocking question requires answering first).',
  ].join('\n');

  const modeLabel = (m) => (m === 'nturns' ? 'Every Reply' : 'Smart');

  const SEL = {
    editor: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
    sendBtn: ['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label*="Send" i]'],
    stopBtn: ['button[aria-label*="Stop" i]', 'button.stop-button', 'mat-icon[fonticon="stop"]', '[data-mat-icon-name="stop"]'],
    busy: ['[aria-busy="true"]', 'mat-progress-bar', 'mat-progress-spinner', 'mat-spinner', '[role="progressbar"]', '[data-test-id*="tool"] [aria-busy="true"]', '.tool-call-card [role="progressbar"]', '[class*="loading-spinner"]'],
    allowPrimary: 'remy-confirmation-card-v2 gem-button.primary-button button, remy-confirmation-card gem-button.primary-button button',
    allowDialog: 'gem-button.allow-for-conversation-button button, gem-button.allow-once-button button',
    composerPopup: ['.at-mentions-v2-item-title', '.at-mentions-v2-group-title', '.cdk-overlay-pane [class*="at-mentions"]', '.cdk-overlay-pane [role="listbox"]', '.cdk-overlay-pane [role="option"]'],
    errorBanner: '[role="alert"], .error-message, .snackbar-error',
  };

  // --- Per-chat auto-pruned state store (zero bloat, synchronous) ---
  const normalizePath = (p) => (p || '').replace(/^\/u\/\d+/, '').replace(/\/+$/, '') || '/app';
  const isNewChatPath = (p) => normalizePath(p) === '/app';
  const chatKeyFor = (p) => { const n = normalizePath(p); return n === '/app' ? null : n; };

  const readGlobals = () => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
  };
  const writeGlobals = (g) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(g)); } catch {}
  };

  const pruneChatStore = (map) => {
    const now = Date.now();
    const entries = Object.entries(map).filter(([, v]) => v && typeof v === 'object' && now - (v.updatedAt || 0) <= CHAT_TTL_MS);
    entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    return Object.fromEntries(entries.slice(0, CHAT_MAX_ENTRIES));
  };
  const readChatStore = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(CHAT_STORE_KEY) || '{}');
      const pruned = pruneChatStore(raw && typeof raw === 'object' ? raw : {});
      if (Object.keys(pruned).length !== Object.keys(raw || {}).length) {
        localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(pruned));
      }
      return pruned;
    } catch { return {}; }
  };
  const writeChatStore = (map) => {
    try { localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(pruneChatStore(map))); } catch {}
  };
  const getChatOverride = (pathname) => {
    const key = chatKeyFor(pathname);
    return key ? readChatStore()[key] || null : null;
  };
  const isUserOverride = (ov) => Boolean(
    ov && (ov.userTouched === true || (ov.userTouched === undefined && ('armed' in ov || 'autoAllow' in ov || 'mode' in ov)))
  );
  const saveChatOverride = (pathname, snapshot) => {
    const key = chatKeyFor(pathname);
    if (!key) return;
    const map = readChatStore();
    const prev = map[key] || {};
    map[key] = { ...prev, ...snapshot, userTouched: true, updatedAt: Date.now() };
    writeChatStore(map);
  };
  const saveChatProgress = (pathname, chatTurns, lastObservedKey) => {
    const key = chatKeyFor(pathname);
    if (!key) return;
    const map = readChatStore();
    const prev = map[key] || {};
    map[key] = {
      ...prev,
      userTouched: isUserOverride(prev),
      chatTurns,
      lastObservedKey,
      updatedAt: Date.now(),
    };
    writeChatStore(map);
  };
  const deleteChatOverride = (pathname) => {
    const key = chatKeyFor(pathname);
    if (!key) return;
    const map = readChatStore();
    if (key in map) { delete map[key]; writeChatStore(map); }
  };

  const buildChatConfig = (pathname) => {
    const g = readGlobals();
    const ov = getChatOverride(pathname);
    const hasUserOv = isUserOverride(ov);
    const mode = ((hasUserOv ? ov?.mode : undefined) ?? g.mode) === 'nturns' ? 'nturns' : 'marker';
    const maxTurnsRaw = Number((hasUserOv ? ov?.maxTurns : undefined) ?? g.maxTurns);
    const maxTurns = maxTurnsRaw > 0 ? Math.min(50, maxTurnsRaw) : 5;
    const promptRaw = (hasUserOv ? ov?.prompt : undefined) ?? g.prompt;
    const prompt = typeof promptRaw === 'string' && promptRaw.trim() ? promptRaw : 'Continue from the checkpoint.';
    const handoffEverySrc = (hasUserOv && ov?.handoffEvery !== undefined) ? ov.handoffEvery : g.handoffEvery;
    const handoffEvery = handoffEverySrc === undefined
      ? HANDOFF_EVERY_DEFAULT
      : (Number(handoffEverySrc) > 0 ? Math.min(HANDOFF_EVERY_MAX, Math.max(2, Math.round(Number(handoffEverySrc)))) : 0);
    return {
      armed: hasUserOv && typeof ov?.armed === 'boolean' ? ov.armed : true,
      autoAllow: hasUserOv && typeof ov?.autoAllow === 'boolean' ? ov.autoAllow : true,
      mode,
      maxTurns,
      handoffEvery,
      prompt,
      collapsed: Boolean(g.collapsed),
      userTouched: hasUserOv,
      assistantTurnsObserved: Number(ov?.chatTurns) > 0 ? Math.round(Number(ov.chatTurns)) : 0,
      lastObservedKey: typeof ov?.lastObservedKey === 'string' ? ov.lastObservedKey : '',
    };
  };

  const initCfg = buildChatConfig(location.pathname);
  const state = {
    ...initCfg,
    turnsUsed: 0,
    allowsClicked: 0,
    compactRequested: false,
    url: location.pathname,
    needsBaseline: !isNewChatPath(location.pathname),
    lastHandledKey: '', lastSentCount: 0, stableKey: '', stableSince: 0,
    countdown: 0, countdownEndsAt: 0, countdownTimer: null, sending: false,
    autoStopped: false, autoStoppedAllow: false,
    pendingPrompt: null, handoffText: '',
    status: initCfg.armed ? `Ready (${modeLabel(initCfg.mode)})` : 'Off (saved)',
    lastRenderSig: '',
  };

  const emitState = () => {
    try {
      window.dispatchEvent(new CustomEvent('wh-auto-continue:state', { detail: getPublicState() }));
    } catch {}
  };

  const persistGlobal = () => {
    const g = readGlobals();
    writeGlobals({
      ...g,
      mode: state.mode,
      maxTurns: state.maxTurns,
      handoffEvery: state.handoffEvery,
      prompt: state.prompt,
      collapsed: state.collapsed,
    });
  };
  const persistChat = () => {
    state.userTouched = true;
    saveChatOverride(state.url, {
      armed: state.armed,
      autoAllow: state.autoAllow,
      mode: state.mode,
      maxTurns: state.maxTurns,
      handoffEvery: state.handoffEvery,
      prompt: state.prompt,
      chatTurns: state.assistantTurnsObserved,
      lastObservedKey: state.lastObservedKey,
    });
  };

  let releaseWakeLock = null;
  const syncKeepAlive = () => {
    const active = state.armed || state.autoAllow;
    if (active && !releaseWakeLock && navigator.locks) {
      navigator.locks.request('wh_gemini_keepalive_' + Math.random().toString(36).slice(2), () => new Promise((res) => { releaseWakeLock = res; })).catch(() => {});
    } else if (!active && releaseWakeLock) {
      releaseWakeLock();
      releaseWakeLock = null;
    }
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

  const isVisible = (el) => Boolean(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const isEnabled = (btn) => Boolean(
    isVisible(btn) &&
    !btn.disabled &&
    btn.getAttribute('aria-disabled') !== 'true' &&
    !btn.closest('.gem-button-disabled, [aria-disabled="true"]')
  );
  const queryFirst = (list) => { for (const s of list) { const el = document.querySelector(s); if (isVisible(el)) return el; } return null; };
  const hashStr = (s) => { let hVal = 2166136261; for (let i = 0; i < s.length; i++) hVal = Math.imul(hVal ^ s.charCodeAt(i), 16777619); return (hVal >>> 0).toString(36); };

  const getResponses = () => {
    const mr = [...document.querySelectorAll('model-response')];
    return mr.length ? mr : [...document.querySelectorAll('message-content')];
  };

  const SKIP_SIGNAL_TAGS = new Set(['PRE', 'CODE', 'CODE-BLOCK', 'SCRIPT', 'STYLE']);
  const BLOCK_SIGNAL_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'TR', 'SECTION', 'ARTICLE', 'BLOCKQUOTE']);

  // Extracts visible text excluding <pre>/<code>/<code-block> so quoted examples never false-trigger control markers.
  const extractSignalText = (root) => {
    if (!root) return '';
    const parts = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || '');
        return;
      }
      const tag = (node.tagName || '').toUpperCase();
      if (SKIP_SIGNAL_TAGS.has(tag)) return;
      if (tag === '#TEXT') {
        parts.push(node._text || node.textContent || '');
        return;
      }
      const isBlock = BLOCK_SIGNAL_TAGS.has(tag);
      if (isBlock) parts.push('\n');
      if (node.childNodes && node.childNodes.length) {
        for (const child of node.childNodes) walk(child);
      } else if (node.children && node.children.length) {
        for (const child of node.children) walk(child);
      } else if (typeof node._text === 'string') {
        parts.push(node._text);
      } else if (typeof node.innerText === 'string' && !node.childNodes) {
        parts.push(node.innerText);
      }
      if (isBlock) parts.push('\n');
    };
    walk(root);
    return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  };

  const getLatestResponse = () => {
    const list = getResponses();
    if (!list.length) return { count: 0, key: '', text: '', signalText: '' };
    const node = list[list.length - 1];
    const mc = node.querySelector('message-content[id]') || node;
    const text = (mc.innerText || '').trim();
    const signalText = extractSignalText(mc);
    return { count: list.length, key: `${mc.id || 'idx_' + list.length}:${text.length}:${hashStr(text)}`, text, signalText };
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
  const hasComposerPopup = () => Boolean(queryFirst(SEL.composerPopup));
  const hasErrorBanner = () => [...document.querySelectorAll(SEL.errorBanner)].some((el) => isVisible(el) && /something went wrong|error|failed|try again/i.test(el.innerText || ''));

  const setStatus = (msg) => { if (state.status !== msg) { state.status = msg; render(); emitState(); } };
  const clearCountdown = (reason) => {
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
    state.countdown = 0;
    state.countdownEndsAt = 0;
    state.pendingPrompt = null;
    if (reason) state.status = reason;
    render(true);
    emitState();
  };
  const disarm = (reason = 'Disarmed', alsoStopAllow = false, isAutoStop = false) => {
    state.armed = false;
    state.autoStopped = Boolean(isAutoStop);
    if (alsoStopAllow) {
      state.autoStoppedAllow = Boolean(isAutoStop && state.autoAllow);
      state.autoAllow = false;
    } else {
      state.autoStoppedAllow = false;
    }
    syncKeepAlive();
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
        emitState();
      }, document.hidden ? 300 : ALLOW_SETTLE_MS);
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

  const buildTelemetryTag = (nextTurn) => {
    const cadence = state.handoffEvery > 0 ? ` chat=${state.assistantTurnsObserved}/${state.handoffEvery}` : '';
    return `[wh-ac: turn=${nextTurn}/${state.maxTurns} mode=${state.mode} allow=${state.autoAllow ? 'on' : 'off'}${cadence}]`;
  };

  // Prepends [wh-ac: ...] on its own first <p> line so Quill @mention chips (<strong>@wsl_webharness</strong>) and multiline formatting stay intact.
  const prependTagInPlace = (editor, tag) => {
    const p = document.createElement('p');
    p.textContent = tag;
    editor.insertBefore(p, editor.firstChild);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: tag, inputType: 'insertText' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const insertTagIntoComposer = () => {
    const editor = queryFirst(SEL.editor);
    if (!editor) return setStatus('No composer found');
    const cur = (editor.innerText || '').trim();
    const tag = buildTelemetryTag(state.turnsUsed);
    if (!cur) {
      setEditorText(editor, `${tag} `);
    } else if (/^\[wh-ac:[^\]]*\]/i.test(cur)) {
      const firstP = editor.firstElementChild;
      if (firstP && /^\[wh-ac:[^\]]*\]$/i.test((firstP.textContent || '').trim())) {
        firstP.textContent = tag;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: tag, inputType: 'insertText' }));
      } else {
        setEditorText(editor, cur.replace(/^\[wh-ac:[^\]]*\]\s*/i, `${tag} `));
      }
    } else {
      prependTagInPlace(editor, tag);
    }
    setStatus('Tag inserted');
  };

  let injectingSend = false;
  const interceptManualSend = (e, sendBtn) => {
    if (state.sending || injectingSend) return;
    if (!state.armed && !state.autoStopped) return;
    const editor = queryFirst(SEL.editor);
    if (!editor) return;
    const cur = (editor.innerText || '').trim();
    if (!cur) return;

    const btn = sendBtn || queryFirst(SEL.sendBtn);
    if (!btn || !isEnabled(btn)) return;

    // If previous task finished cleanly (Status: Done / Cap), re-arm automatically on manual send.
    if (state.autoStopped && !state.armed) {
      state.autoStopped = false;
      state.armed = true;
      if (state.autoStoppedAllow) { state.autoAllow = true; state.autoStoppedAllow = false; }
      state.turnsUsed = 0;
      state.compactRequested = false;
      state.handoffText = '';
      state.stableKey = '';
      state.stableSince = 0;
      syncKeepAlive();
      setStatus(`Re-armed (${modeLabel(state.mode)})`);
    }

    // Handshake tag is wired directly to Auto: always injected when Auto is ON (never when manually OFF).
    if (/^\[wh-ac:/i.test(cur)) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    injectingSend = true;
    prependTagInPlace(editor, buildTelemetryTag(state.turnsUsed));
    setStatus('Sending...');

    setTimeout(() => {
      const liveBtn = queryFirst(SEL.sendBtn);
      if (liveBtn && isEnabled(liveBtn)) liveBtn.click();
      else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      setTimeout(() => { injectingSend = false; }, 150);
    }, 80);
  };

  const sendPrompt = (promptText = null, attempt = 1) => {
    const rawText = (promptText || state.prompt || 'Continue from the checkpoint.').trim();
    const textToSend = /^\[wh-ac:/i.test(rawText) ? rawText : `${buildTelemetryTag(state.turnsUsed + 1)} ${rawText}`;
    const editor = queryFirst(SEL.editor);
    if (!editor) { state.sending = false; return disarm('No composer found'); }
    if (attempt === 1 && (editor.innerText || '').trim().length > 0) {
      state.sending = false;
      return clearCountdown('Paused: draft in box');
    }

    state.sending = true;
    const beforeSnap = getLatestResponse();
    setEditorText(editor, textToSend);

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
          if (attempt < 2) return sendPrompt(textToSend, attempt + 1);
          state.sending = false;
          return disarm('Send failed (check box)', false, true);
        }

        state.sending = false;
        state.stableKey = '';
        state.stableSince = 0;
        state.handoffText = '';
        state.lastHandledKey = beforeSnap.key;
        state.lastSentCount = beforeSnap.count;
        state.turnsUsed += 1;
        state.status = `Sent (${state.turnsUsed}/${state.maxTurns})`;
        if (state.turnsUsed >= state.maxTurns) disarm(`Cap reached (${state.turnsUsed}/${state.maxTurns})`, false, true);
        else { render(true); emitState(); }
      }, 350);
    }, 180);
  };

  const startCountdown = (snap, customPrompt = null, waitSec = null) => {
    if (state.countdownTimer) return;
    const delaySec = waitSec != null ? Math.max(5, Math.min(120, waitSec)) : COUNTDOWN_SEC;
    // In a background tab with no explicit agent wait, skip the 5s timer so Chromium throttling can't stall it.
    if (document.hidden && waitSec == null) {
      const editor = queryFirst(SEL.editor);
      if (editor && (editor.innerText || '').trim().length > 0) {
        state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
        return setStatus('Paused: draft in box');
      }
      setStatus('Sending (background)...');
      return sendPrompt(customPrompt);
    }
    state.pendingPrompt = customPrompt;
    state.countdownEndsAt = Date.now() + delaySec * 1000;
    state.countdown = delaySec;
    state.status = waitSec != null ? `Waiting ${delaySec}s...` : `Sending in ${delaySec}s...`;
    render(true);
    state.countdownTimer = setInterval(() => {
      if (!state.armed || isBusy() || findPendingAllowButtons().length) return clearCountdown('Aborted: busy/approval');
      const editor = queryFirst(SEL.editor);
      if (editor && (editor.innerText || '').trim().length > 0) {
        state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
        return clearCountdown('Paused: draft in box');
      }
      const rem = Math.ceil((state.countdownEndsAt - Date.now()) / 1000);
      if (rem <= 0) {
        const nextPrompt = state.pendingPrompt;
        clearCountdown('Sending...');
        sendPrompt(nextPrompt);
      } else {
        state.countdown = rem;
        state.status = waitSec != null ? `Waiting ${rem}s...` : `Sending in ${rem}s...`;
        render(true);
      }
    }, 500);
  };

  const hasHandoffMarker = (text) => HANDOFF_MARKERS.some((m) => text.includes(m)) || HANDOFF_HEADING_RE.test(text);

  const extractHandoff = (text) => {
    const tokIdx = text.indexOf('[[HANDOFF]]');
    if (tokIdx !== -1) return text.slice(tokIdx + '[[HANDOFF]]'.length).trim() || text;
    const headingMatch = text.match(HANDOFF_HEADING_RE);
    if (headingMatch && headingMatch.index !== undefined) return text.slice(headingMatch.index).trim();
    return text;
  };

  const triggerCompactHandoff = () => {
    if (state.sending || isBusy()) return setStatus('Wait: reply in progress');
    if (getResponses().length === 0) return setStatus('Nothing to hand off yet');
    clearCountdown();
    state.compactRequested = true;
    setStatus('Requesting handoff...');
    sendPrompt(HANDOFF_REQUEST_PROMPT);
  };

  const copyHandoff = async (openNewTab = false) => {
    const body = (state.handoffText || getLatestResponse().text || '').trim();
    if (!body) return false;
    const text = body.startsWith('Continue this task in a fresh chat')
      ? body
      : `${HANDOFF_RESUME_HEADER}\n\n${body}`;
    try { await navigator.clipboard.writeText(text); } catch {}
    setStatus(openNewTab ? 'Handoff copied -> new tab' : 'Handoff copied');
    if (openNewTab) window.open('https://gemini.google.com/app', '_blank', 'noopener');
    return true;
  };

  const tick = () => {
    if (location.pathname !== state.url) {
      const fromNewChat = isNewChatPath(state.url) && !isNewChatPath(location.pathname);
      state.url = location.pathname;
      if (fromNewChat) {
        // Carry over any manual edits or observed turns from /app into the newly assigned chat ID.
        if (state.userTouched) persistChat();
        else if (state.assistantTurnsObserved > 0) saveChatProgress(state.url, state.assistantTurnsObserved, state.lastObservedKey);
      } else {
        clearCountdown();
        const cfg = buildChatConfig(location.pathname);
        Object.assign(state, cfg, {
          turnsUsed: 0, allowsClicked: 0,
          compactRequested: false, handoffText: '',
          autoStopped: false, autoStoppedAllow: false,
          lastHandledKey: '', lastSentCount: 0, stableKey: '', stableSince: 0,
          needsBaseline: !isNewChatPath(location.pathname),
          status: cfg.armed ? `Ready (${modeLabel(cfg.mode)})` : (cfg.userTouched ? 'Off (saved)' : 'Off'),
        });
        syncKeepAlive();
        render(true);
        emitState();
      }
      return;
    }
    if (!state.armed && !state.autoAllow && !state.compactRequested) return;
    if (hasErrorBanner()) return disarm('Stopped: error banner', true, true);
    if (handlePendingApprovals()) { state.needsBaseline = false; render(); return; }
    if ((!state.armed && !state.compactRequested) || state.countdownTimer || state.sending) return;
    if (state.armed && !state.compactRequested && state.turnsUsed >= state.maxTurns) return disarm(`Cap reached (${state.turnsUsed}/${state.maxTurns})`, false, true);
    if (isBusy()) { state.needsBaseline = false; state.stableKey = ''; state.stableSince = 0; return setStatus('Streaming / running...'); }

    const snap = getLatestResponse();
    if (!snap.count || !snap.text) return;
    if (state.needsBaseline) {
      state.needsBaseline = false;
      state.lastHandledKey = snap.key;
      state.lastSentCount = snap.count;
      return setStatus(`Ready (${modeLabel(state.mode)})`);
    }
    if (!(snap.count > state.lastSentCount || snap.key !== state.lastHandledKey)) return;

    if (snap.key !== state.stableKey) { state.stableKey = snap.key; state.stableSince = Date.now(); return setStatus('Waiting for stability...'); }
    if (Date.now() - state.stableSince < STABLE_MS) return;

    const sigText = snap.signalText;
    if (hasHandoffMarker(sigText)) {
      state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
      state.compactRequested = false;
      state.assistantTurnsObserved = 0;
      state.lastObservedKey = snap.key;
      saveChatProgress(state.url, 0, snap.key);
      state.handoffText = extractHandoff(snap.text);
      return disarm('Handoff ready (new chat)', false, true);
    }
    if (sigText.includes(STOP_TOKEN)) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; state.compactRequested = false; return disarm(`Stopped: ${STOP_TOKEN}`, false, true); }
    const statusMatch = sigText.match(STOP_STATUS_RE);
    if (statusMatch) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; state.compactRequested = false; return disarm(`Stopped: Status ${statusMatch[1]}`, false, true); }
    if (!state.armed) {
      state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
      state.compactRequested = false;
      return setStatus('Off (saved)');
    }

    if (state.lastObservedKey !== snap.key) {
      state.lastObservedKey = snap.key;
      state.assistantTurnsObserved += 1;
      saveChatProgress(state.url, state.assistantTurnsObserved, state.lastObservedKey);
      const hitCadence = state.handoffEvery > 0 && (state.assistantTurnsObserved % state.handoffEvery === 0);
      if (!state.compactRequested && hitCadence) {
        state.lastHandledKey = snap.key;
        state.lastSentCount = snap.count;
        return triggerCompactHandoff();
      }
    }

    const dirContinue = sigText.match(DIRECTIVE_CONTINUE_RE);
    const dirWait = sigText.match(DIRECTIVE_WAIT_RE);
    const hasMarker = Boolean(dirContinue) || SENTINELS.some((s) => sigText.includes(s)) || CHECKPOINT_HEADING_RE.test(sigText);
    if (state.mode === 'marker' && !hasMarker) {
      state.lastHandledKey = snap.key;
      state.lastSentCount = snap.count;
      return setStatus('Waiting for checkpoint');
    }

    const customPrompt = dirContinue ? dirContinue[1].trim() : null;
    const waitSec = dirWait ? Number(dirWait[1]) : null;
    startCountdown(snap, customPrompt, waitSec);
  };

  const hud = document.createElement('div');
  hud.id = 'wh-auto-continue-hud';
  Object.assign(hud.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '99999',
    background: 'rgba(20,22,27,0.9)', color: '#e8eaed', backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', padding: '8px 10px',
    font: '12px/1.35 system-ui,-apple-system,sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
    minWidth: '195px', maxWidth: '270px', userSelect: 'none',
  });
  document.body.appendChild(hud);

  const render = (force = false) => {
    if (!force && document.activeElement?.closest('#wh-auto-continue-hud input')) return;
    const canHandoffNow = !state.sending && !isBusy() && getResponses().length > 0;
    const sig = `${state.armed}|${state.autoAllow}|${state.allowsClicked}|${state.userTouched}|${Boolean(state.handoffText)}|${canHandoffNow}|${state.assistantTurnsObserved}|${state.handoffEvery}|${state.mode}|${state.turnsUsed}/${state.maxTurns}|${state.collapsed}|${state.countdown}|${state.status}`;
    if (!force && sig === state.lastRenderSig) return;
    state.lastRenderSig = sig;

    const cyclePos = state.handoffEvery > 0 ? (state.assistantTurnsObserved % state.handoffEvery) : state.assistantTurnsObserved;
    const cadenceNear = state.handoffEvery > 0 && (state.handoffEvery - cyclePos <= 1) && state.assistantTurnsObserved > 0;
    const handoffBadge = state.handoffEvery > 0 ? `Handoff ${state.assistantTurnsObserved}/${state.handoffEvery}` : `Turns ${state.assistantTurnsObserved}`;

    const row = (mt = '0') => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: mt });
    const dot = (color, sz = '8px') => h('span', { style: { width: sz, height: sz, borderRadius: '50%', background: color, display: 'inline-block' } });
    const topRow = h('div', { style: row() },
      h('button', { dataset: { act: 'toggle' }, title: 'Toggle Auto-Continue (Alt+Shift+A). Automatically attaches [wh-ac: ...] handshake tag while ON.', style: { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '600' } },
        dot(state.armed ? '#34d399' : '#9aa0a6'), `Auto: ${state.armed ? 'ON' : 'OFF'}`),
      h('span', { style: { opacity: '.85', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' } },
        state.userTouched ? h('span', { title: 'Saved override for this chat', style: { fontSize: '10px', opacity: '.85' } }, '📌') : null,
        h('span', { title: state.handoffEvery > 0 ? `Replies in this chat (${state.assistantTurnsObserved}) before auto-handoff at ${state.handoffEvery}` : `Replies observed in this chat (${state.assistantTurnsObserved})`, style: { color: cadenceNear ? '#fbbf24' : '#93c5fd', fontWeight: '600' } }, handoffBadge),
        h('span', { title: `Auto-sent continuations in this run (${state.turnsUsed} of ${state.maxTurns} max)` }, `Auto ${state.turnsUsed}/${state.maxTurns}`)),
      h('button', { dataset: { act: 'collapse' }, style: { all: 'unset', cursor: 'pointer', opacity: '.75', padding: '0 3px' } }, state.collapsed ? '+' : '−')
    );
    const allowRow = h('div', { style: row('5px') },
      h('button', { dataset: { act: 'allow' }, title: 'Toggle Auto-Allow for MCP confirmation cards (Alt+Shift+L)', style: { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: '600' } },
        dot(state.autoAllow ? '#f59e0b' : '#9aa0a6', '7px'), `Allow: ${state.autoAllow ? 'ON (All)' : 'OFF'}`),
      state.allowsClicked ? h('span', { style: { opacity: '.7', fontSize: '11px' } }, `✓${state.allowsClicked}`) : null
    );
    const statusRow = state.countdown > 0
      ? h('div', { style: { ...row('6px'), background: 'rgba(251,191,36,0.16)', padding: '4px 6px', borderRadius: '6px' } },
          h('span', {}, state.status),
          h('button', { dataset: { act: 'cancel' }, style: { background: '#ef4444', color: '#fff', border: '0', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '11px' } }, 'Cancel'))
      : h('div', { style: { marginTop: '4px', opacity: '.75', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, state.status);

    const nodes = [topRow, allowRow, statusRow];
    if (state.handoffText) {
      nodes.push(
        h('button', { dataset: { act: 'handoff' }, style: { marginTop: '6px', width: '100%', background: '#2563eb', color: '#fff', border: '0', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', fontWeight: '600' } }, 'Copy Handoff & New Chat')
      );
    }
    if (!state.collapsed) {
      nodes.push(
        h('div', { style: { marginTop: '7px', paddingTop: '7px', borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: row() },
            h('button', { dataset: { act: 'mode' }, title: state.mode === 'marker' ? 'Smart: only auto-continues when Gemini emits a checkpoint' : 'Every Reply: auto-continues after every reply until Max auto or Status: Done', style: { background: 'rgba(255,255,255,0.1)', color: '#fff', border: '0', borderRadius: '5px', padding: '3px 7px', cursor: 'pointer', fontSize: '11px' } }, `Mode: ${modeLabel(state.mode)}`),
            h('label', { title: 'Maximum automatic continuations per run before stopping', style: { fontSize: '11px', opacity: '.85' } }, 'Max auto ',
              h('input', { dataset: { act: 'cap' }, type: 'number', min: '1', max: '50', value: String(state.maxTurns), style: { width: '36px', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '1px 4px', fontSize: '11px' } })),
            state.userTouched ? h('button', { dataset: { act: 'reset' }, title: 'Clear saved override for this chat', style: { background: 'rgba(255,255,255,0.1)', color: '#cbd5e1', border: '0', borderRadius: '5px', padding: '3px 6px', cursor: 'pointer', fontSize: '10px' } }, 'Reset') : null
          ),
          h('div', { style: row() },
            h('label', { title: 'Auto-request a fresh-chat handoff every N replies (0 = off; persisted per chat)', style: { fontSize: '10px', opacity: '.85' } }, 'Handoff every ',
              h('input', { dataset: { act: 'every' }, type: 'number', min: '0', max: '20', value: String(state.handoffEvery), style: { width: '34px', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '1px 3px', fontSize: '10px' } }),
              ' turns'),
            h('button', { dataset: { act: 'compact' }, disabled: !canHandoffNow, title: canHandoffNow ? 'Ask Gemini to emit a structured Fresh-Chat Handoff now' : 'Available after at least one completed reply', style: { background: 'rgba(245,158,11,0.22)', color: '#fcd34d', border: '0', borderRadius: '5px', padding: '3px 7px', cursor: canHandoffNow ? 'pointer' : 'not-allowed', opacity: canHandoffNow ? '1' : '.45', fontSize: '10px' } }, 'Handoff Now')
          ),
          h('input', { dataset: { act: 'prompt' }, type: 'text', placeholder: 'Auto-continue prompt...', title: 'Default message sent on auto-continue turns', value: state.prompt, style: { width: '100%', boxSizing: 'border-box', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '5px', padding: '4px 6px', fontSize: '11px' } })
        )
      );
    }
    hud.replaceChildren(...nodes);
  };

  const toggleArmed = () => {
    state.armed = !state.armed;
    state.autoStopped = false;
    state.autoStoppedAllow = false;
    if (state.armed) {
      const snap = getLatestResponse();
      state.lastHandledKey = snap.key; state.lastSentCount = snap.count; state.stableKey = '';
      state.needsBaseline = false;
      state.status = `Ready (${modeLabel(state.mode)})`;
    } else clearCountdown('Off (saved)');
    persistChat();
    syncKeepAlive();
    render(true);
    emitState();
  };

  const toggleAllow = () => {
    state.autoAllow = !state.autoAllow;
    state.autoStoppedAllow = false;
    persistChat();
    syncKeepAlive();
    state.status = state.autoAllow ? 'Auto-Allow ON (All)' : 'Auto-Allow OFF (saved)';
    render(true);
    emitState();
    if (state.autoAllow) tick();
  };

  const resetCurrentChat = () => {
    deleteChatOverride(state.url);
    const cfg = buildChatConfig(state.url);
    Object.assign(state, cfg, {
      autoStopped: false, autoStoppedAllow: false,
      status: cfg.armed ? `Reset -> Ready (${modeLabel(cfg.mode)})` : 'Reset -> Off',
    });
    syncKeepAlive();
    render(true);
    emitState();
  };

  hud.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') toggleArmed();
    else if (act === 'allow') toggleAllow();
    else if (act === 'mode') { state.mode = state.mode === 'marker' ? 'nturns' : 'marker'; persistGlobal(); persistChat(); if (state.armed) state.status = `Ready (${modeLabel(state.mode)})`; render(true); emitState(); }
    else if (act === 'collapse') { state.collapsed = !state.collapsed; persistGlobal(); render(true); }
    else if (act === 'cancel') { const s = getLatestResponse(); state.lastHandledKey = s.key; state.lastSentCount = s.count; clearCountdown('Canceled (waiting next)'); }
    else if (act === 'handoff') copyHandoff(true);
    else if (act === 'compact') triggerCompactHandoff();
    else if (act === 'reset') resetCurrentChat();
  });

  hud.addEventListener('change', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'cap') { state.maxTurns = Math.max(1, Math.min(50, Number(e.target.value) || 5)); persistGlobal(); persistChat(); render(true); emitState(); }
    if (act === 'every') { const n = Number(e.target.value) || 0; state.handoffEvery = n > 0 ? Math.min(20, Math.max(2, Math.round(n))) : 0; persistGlobal(); persistChat(); render(true); emitState(); }
    if (act === 'prompt') { state.prompt = e.target.value.trim() || 'Continue from the checkpoint.'; persistGlobal(); persistChat(); emitState(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const editor = queryFirst(SEL.editor);
    if (!editor || !editor.contains(e.target) || hasComposerPopup()) return;
    interceptManualSend(e, null);
  }, true);

  document.addEventListener('click', (e) => {
    if (!e.isTrusted || hud.contains(e.target)) return;
    const btn = e.target.closest(SEL.sendBtn.join(', '));
    if (!btn || !isEnabled(btn)) return;
    interceptManualSend(e, btn);
  }, true);

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyA') { e.preventDefault(); toggleArmed(); }
    else if (e.code === 'KeyL') { e.preventDefault(); toggleAllow(); }
  });

  // --- Programmatic bridge for browser-daily / agent / DevTools ---
  const getPublicState = () => ({
    version: '1.10.0',
    url: state.url,
    armed: state.armed,
    autoAllow: state.autoAllow,
    autoStopped: state.autoStopped,
    mode: state.mode,
    modeLabel: modeLabel(state.mode),
    turnsUsed: state.turnsUsed,
    maxTurns: state.maxTurns,
    handoffEvery: state.handoffEvery,
    chatTurns: state.assistantTurnsObserved,
    allowsClicked: state.allowsClicked,
    prompt: state.prompt,
    userTouched: state.userTouched,
    handoffReady: Boolean(state.handoffText),
    status: state.status,
    savedChatCount: Object.keys(readChatStore()).length,
  });

  window.__whAutoContinue = {
    getState: getPublicState,
    setState: (patch = {}, { persist = true } = {}) => {
      if (typeof patch.armed === 'boolean') { state.armed = patch.armed; state.autoStopped = false; }
      if (typeof patch.autoAllow === 'boolean') { state.autoAllow = patch.autoAllow; state.autoStoppedAllow = false; }
      if (patch.mode === 'marker' || patch.mode === 'smart') state.mode = 'marker';
      else if (patch.mode === 'nturns' || patch.mode === 'every') state.mode = 'nturns';
      if (Number(patch.maxTurns) > 0) state.maxTurns = Math.min(50, Number(patch.maxTurns));
      if (Number.isFinite(Number(patch.handoffEvery))) {
        const n = Number(patch.handoffEvery);
        state.handoffEvery = n > 0 ? Math.min(HANDOFF_EVERY_MAX, Math.max(2, Math.round(n))) : 0;
      }
      if (typeof patch.prompt === 'string' && patch.prompt.trim()) state.prompt = patch.prompt.trim();
      if (persist) { persistGlobal(); persistChat(); }
      syncKeepAlive();
      render(true);
      emitState();
      return getPublicState();
    },
    insertTag: insertTagIntoComposer,
    handoffNow: triggerCompactHandoff,
    compactNow: triggerCompactHandoff,
    resetChat: () => { resetCurrentChat(); return getPublicState(); },
    clearStore: () => { writeChatStore({}); state.userTouched = false; render(true); return getPublicState(); },
    copyHandoff,
  };

  syncKeepAlive();
  render(true);
  let obsTimer = null;
  let lastObsRun = 0;
  new MutationObserver((muts) => {
    if (!state.armed && !state.autoAllow && !state.autoStopped && !state.compactRequested) return;
    if (muts.every((m) => hud.contains(m.target))) return;
    const now = Date.now();
    if (now - lastObsRun >= 250) {
      lastObsRun = now;
      tick();
    } else if (!obsTimer) {
      obsTimer = setTimeout(() => { obsTimer = null; lastObsRun = Date.now(); tick(); }, 250);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (state.armed || state.autoAllow)) tick(); });
  setInterval(tick, 1500);
})();
