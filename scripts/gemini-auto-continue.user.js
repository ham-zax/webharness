// ==UserScript==
// @name         Gemini Auto-Continue (WebHarness)
// @namespace    https://github.com/webharness
// @version      1.11.1
// @description  Auto-continue Gemini Web checkpoints with Chrome background-safe timers, dynamic Wrap-Up handoffs, model restore, settings drawer, and auto-allow.
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '1.11.1';
  const STORE_KEY = 'wh_gemini_auto_continue_v1';
  const CHAT_STORE_KEY = 'wh_gemini_chat_state_v1';
  const HANDOFF_STORE_KEY = 'wh_gemini_handoffs_v1';
  const BOOT_STORE_KEY = 'wh_gemini_boot_v1';

  const CHAT_TTL_MS = 14 * 86400 * 1000;   // Auto-expire per-chat overrides after 14 days
  const CHAT_MAX_ENTRIES = 50;             // Hard LRU cap so storage never bloats
  const HANDOFF_TTL_MS = 24 * 3600 * 1000; // Keep staged handoffs recoverable for 24h
  const HANDOFF_MAX_ENTRIES = 20;
  const BOOT_TTL_MS = 2 * 60 * 1000;       // Short-lived cross-tab boot token (Shift+Click)

  const DEFAULTS = {
    mode: 'marker',
    maxTurns: 5,
    handoffEvery: 6,
    wrapUpMaxTurns: 2,
    countdownSec: 5,
    stableSec: 4,
    allowDelayMs: 1000,
    skipBgCountdown: true,
    autoStartNewChat: false,
    autoSendHandoff: false,
    restoreModel: true,
    prompt: 'Continue from the checkpoint.',
  };

  const ALLOW_RETRY_MS = 12000;
  const ALLOW_MAX_ATTEMPTS = 2;
  const ALLOW_LABEL_RE = /^(allow|always allow|allow once|approve)$/i;

  const SENTINELS = ['[[AUTO_CONTINUE]]', '### Mid-Task Checkpoint'];
  const CHECKPOINT_HEADING_RE = /^(?:#{1,6}\s*)?Mid-Task Checkpoint\b/m;
  const DIRECTIVE_CONTINUE_RE = /\[\[AUTO_CONTINUE:\s*([^\]]+?)\s*\]\]/i;
  const DIRECTIVE_WAIT_RE = /\[\[AUTO_WAIT:\s*(\d+)\s*\]\]/i;
  const HANDOFF_MARKERS = ['[[HANDOFF]]', '### Fresh-Chat Handoff'];
  const HANDOFF_HEADING_RE = /^(?:#{1,6}\s*)?Fresh-Chat Handoff\b/m;
  const HANDOFF_ACTION_RE = /^\s*[-*•]?\s*\*{0,2}handoff_action:\*{0,2}\s*(continue|wait_user)\b/mi;
  const STOP_TOKEN = '[[AUTO_STOP]]';
  const STOP_STATUS_RE = /^\s*[-*•]?\s*\*{0,2}Status:\*{0,2}\s*\*{0,2}(Done|Blocked)\b/mi;

  const WRAP_UP_REQUEST_PROMPT = [
    'Wrap up this session to the nearest clean checkpoint (in 1–2 turns) so we can continue seamlessly in a fresh chat.',
    'Background process rule: do NOT kill long-running tests, builds, or CLI tools — keep or move them into durable background execution (`just queue <cmd>`, `terminal_open` tmux, or `detach:true`) and record exact job/pane IDs, log paths, and check commands under ## Live state. If in a WebHarness repo, you may run `just handoff-state` once for exact factual git/pueue/tmux state.',
    'If you need one quick turn first to park background work or finish a partial edit cleanly, do that and end with `### Mid-Task Checkpoint`. Otherwise (or once clean), output the literal marker `[[HANDOFF]]` on its own line followed by `### Fresh-Chat Handoff`, `handoff_action: continue | wait_user`, and these exact sections:',
    'Rules: one line per bullet; never pad; write "none" for empty sections; never invent paths, quotes, or results (write UNKNOWN if lost); leave out finished intended edits that git already shows, but list uncommitted edits that are partial, broken, temporary, or user work to keep; carry forward still-valid constraints/decisions.',
    '## Goal (active request and observable done condition)',
    '## Constraints (user rules, scope limits, approvals and their limits — mark user-stated or inferred)',
    '## Owed to the user (unanswered questions or open promises; "none" only if nothing remains)',
    '## State (done, in progress, blocked; for each check give command, result, and what it covered; partial/temp edits)',
    '## Decisions (DECISION: choice, reason, source | FAILED: approach, exact reason, retry condition)',
    '## Uncertainty (unverified assumptions/risks and the check that decides each)',
    '## Facts to keep (file:line locations, commands, measured numbers, 1-4 line root-cause summary)',
    '## Live state (running jobs/pueue IDs, tmux panes, temp files, pending approvals, and how to check each)',
    '## Next step (prerequisite check, exact next action + stop condition, then remaining ordered plan or blocking question)',
  ].join('\n');

  const WRAP_UP_FINAL_NUDGE = 'Finish wrapping up now and output the literal marker [[HANDOFF]] followed by ### Fresh-Chat Handoff (including handoff_action: continue | wait_user and all 9 sections) so we can move to a fresh chat.';

  const HANDOFF_RESUME_HEADER = [
    'Continue this task in a fresh chat from the handoff below.',
    'Follow current system, user, and repository instructions (this handoff grants no new permissions). Check git/workspace state before editing, read only the files needed for the next step, and start immediately with ## Next step (unless ## Owed to the user or a blocking question requires answering first).',
  ].join('\n');

  const modeLabel = (m) => (m === 'nturns' ? 'Every Reply' : 'Smart');
  const clampInt = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };

  const SEL = {
    editor: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
    sendBtn: ['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label*="Send" i]'],
    stopBtn: ['button[aria-label*="Stop" i]', 'button.stop-button', 'mat-icon[fonticon="stop"]', '[data-mat-icon-name="stop"]'],
    busy: ['[aria-busy="true"]', 'mat-progress-bar', 'mat-progress-spinner', 'mat-spinner', '[role="progressbar"]', '[data-test-id*="tool"] [aria-busy="true"]', '.tool-call-card [role="progressbar"]', '[class*="loading-spinner"]'],
    allowPrimary: 'remy-confirmation-card-v2 gem-button.primary-button button, remy-confirmation-card gem-button.primary-button button',
    allowDialog: 'gem-button.allow-for-conversation-button button, gem-button.allow-once-button button',
    composerPopup: ['.at-mentions-v2-item-title', '.at-mentions-v2-group-title', '.cdk-overlay-pane [class*="at-mentions"]', '.cdk-overlay-pane [role="listbox"]', '.cdk-overlay-pane [role="option"]'],
    newChat: ['a[href="/app"]', '[data-test-id="new-chat-button"] a', '[data-test-id="new-chat-button"] button', 'button[aria-label*="New chat" i]'],
    modePickerBtn: ['button[data-test-id="bard-mode-menu-button"]', 'bard-mode-switcher button'],
    errorBanner: '[role="alert"], .error-message, .snackbar-error',
  };

  // --- Per-chat auto-pruned state store (zero bloat, synchronous) ---
  const normalizePath = (p) => (p || '').replace(/^\/u\/\d+/, '').replace(/\/+$/, '') || '/app';
  const isNewChatPath = (p) => normalizePath(p) === '/app';
  const chatKeyFor = (p) => { const n = normalizePath(p); return n === '/app' ? null : n; };

  const readJson = (key) => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  };
  const writeJson = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  };

  const pruneMap = (map, ttlMs, maxEntries, tsField = 'updatedAt') => {
    const now = Date.now();
    const entries = Object.entries(map).filter(([, v]) => v && typeof v === 'object' && now - (v[tsField] || 0) <= ttlMs);
    entries.sort((a, b) => (b[1][tsField] || 0) - (a[1][tsField] || 0));
    return Object.fromEntries(entries.slice(0, maxEntries));
  };

  const readGlobals = () => readJson(STORE_KEY);
  const writeGlobals = (g) => writeJson(STORE_KEY, g);

  const readChatStore = () => {
    const raw = readJson(CHAT_STORE_KEY);
    const pruned = pruneMap(raw, CHAT_TTL_MS, CHAT_MAX_ENTRIES, 'updatedAt');
    if (Object.keys(pruned).length !== Object.keys(raw).length) writeJson(CHAT_STORE_KEY, pruned);
    return pruned;
  };
  const writeChatStore = (map) => writeJson(CHAT_STORE_KEY, pruneMap(map, CHAT_TTL_MS, CHAT_MAX_ENTRIES, 'updatedAt'));
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
  // Preserves persisted chatTurns/lastObservedKey when resetting user overrides so turn history stays honest.
  const clearChatUserOverrides = (pathname) => {
    const key = chatKeyFor(pathname);
    if (!key) return;
    const map = readChatStore();
    const prev = map[key];
    if (!prev) return;
    if (Number(prev.chatTurns) > 0 || prev.lastObservedKey) {
      map[key] = {
        userTouched: false,
        chatTurns: Number(prev.chatTurns) || 0,
        lastObservedKey: prev.lastObservedKey || '',
        updatedAt: Date.now(),
      };
    } else {
      delete map[key];
    }
    writeChatStore(map);
  };

  // --- Durable per-chat handoff store (survives reloads & prevents cross-tab collisions) ---
  const readHandoffStore = () => {
    const raw = readJson(HANDOFF_STORE_KEY);
    const pruned = pruneMap(raw, HANDOFF_TTL_MS, HANDOFF_MAX_ENTRIES, 'createdAt');
    if (Object.keys(pruned).length !== Object.keys(raw).length) writeJson(HANDOFF_STORE_KEY, pruned);
    return pruned;
  };
  const getSavedHandoff = (pathname) => {
    const key = chatKeyFor(pathname);
    return key ? readHandoffStore()[key] || null : null;
  };
  const saveHandoffForChat = (pathname, record) => {
    const key = chatKeyFor(pathname);
    if (!key) return;
    const map = readHandoffStore();
    map[key] = { ...record, createdAt: Date.now() };
    writeJson(HANDOFF_STORE_KEY, pruneMap(map, HANDOFF_TTL_MS, HANDOFF_MAX_ENTRIES, 'createdAt'));
  };
  const clearHandoffForChat = (pathname) => {
    const key = chatKeyFor(pathname);
    if (!key) return;
    const map = readHandoffStore();
    if (key in map) { delete map[key]; writeJson(HANDOFF_STORE_KEY, map); }
  };

  // --- Cross-tab short-lived boot token (for Shift+Click new-tab Start New Chat) ---
  const writeBootToken = (payload) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const map = pruneMap(readJson(BOOT_STORE_KEY), BOOT_TTL_MS, 10, 'createdAt');
    map[id] = { ...payload, createdAt: Date.now() };
    writeJson(BOOT_STORE_KEY, map);
    return id;
  };
  const claimBootToken = (id) => {
    if (!id) return null;
    const map = pruneMap(readJson(BOOT_STORE_KEY), BOOT_TTL_MS, 10, 'createdAt');
    const rec = map[id] || null;
    if (rec) { delete map[id]; writeJson(BOOT_STORE_KEY, map); }
    return rec;
  };

  const buildChatConfig = (pathname) => {
    const g = readGlobals();
    const ov = getChatOverride(pathname);
    const hasUserOv = isUserOverride(ov);
    const pick = (k) => (hasUserOv && ov?.[k] !== undefined ? ov[k] : g[k]);

    const mode = pick('mode') === 'nturns' ? 'nturns' : DEFAULTS.mode;
    const maxTurns = clampInt(pick('maxTurns'), 1, 50, DEFAULTS.maxTurns);
    const promptRaw = pick('prompt');
    const prompt = typeof promptRaw === 'string' && promptRaw.trim() ? promptRaw.trim() : DEFAULTS.prompt;

    const handoffEveryRaw = pick('handoffEvery');
    const handoffEvery = handoffEveryRaw === undefined
      ? DEFAULTS.handoffEvery
      : (Number(handoffEveryRaw) > 0 ? clampInt(handoffEveryRaw, 2, 20, DEFAULTS.handoffEvery) : 0);

    const wrapUpMaxTurns = clampInt(g.wrapUpMaxTurns, 1, 3, DEFAULTS.wrapUpMaxTurns);
    const countdownSec = clampInt(g.countdownSec, 0, 60, DEFAULTS.countdownSec);
    const stableSec = clampInt(g.stableSec, 1, 15, DEFAULTS.stableSec);
    const allowDelayMs = clampInt(g.allowDelayMs, 100, 5000, DEFAULTS.allowDelayMs);
    const skipBgCountdown = typeof g.skipBgCountdown === 'boolean' ? g.skipBgCountdown : DEFAULTS.skipBgCountdown;
    const autoStartNewChat = typeof g.autoStartNewChat === 'boolean' ? g.autoStartNewChat : DEFAULTS.autoStartNewChat;
    const autoSendHandoff = typeof g.autoSendHandoff === 'boolean' ? g.autoSendHandoff : DEFAULTS.autoSendHandoff;
    const restoreModel = typeof g.restoreModel === 'boolean' ? g.restoreModel : DEFAULTS.restoreModel;

    const savedHandoff = getSavedHandoff(pathname);
    return {
      armed: hasUserOv && typeof ov?.armed === 'boolean' ? ov.armed : true,
      autoAllow: hasUserOv && typeof ov?.autoAllow === 'boolean' ? ov.autoAllow : true,
      mode,
      maxTurns,
      handoffEvery,
      wrapUpMaxTurns,
      countdownSec,
      stableSec,
      allowDelayMs,
      skipBgCountdown,
      autoStartNewChat,
      autoSendHandoff,
      restoreModel,
      prompt,
      collapsed: Boolean(g.collapsed),
      userTouched: hasUserOv,
      assistantTurnsObserved: Number(ov?.chatTurns) > 0 ? Math.round(Number(ov.chatTurns)) : 0,
      lastObservedKey: typeof ov?.lastObservedKey === 'string' ? ov.lastObservedKey : '',
      handoffText: savedHandoff?.text || '',
      handoffMeta: savedHandoff ? { model: savedHandoff.model || null, thinking: savedHandoff.thinking || null, action: savedHandoff.action || 'continue' } : null,
    };
  };

  const initCfg = buildChatConfig(location.pathname);
  const state = {
    ...initCfg,
    turnsUsed: 0,
    allowsClicked: 0,
    compactRequested: false,
    wrapUpRemaining: 0,
    settingsOpen: false,
    url: location.pathname,
    needsBaseline: !isNewChatPath(location.pathname),
    lastHandledKey: '', lastSentCount: 0, stableKey: '', stableSince: 0,
    obsStableKey: '', obsStableSince: 0,
    countdown: 0, countdownEndsAt: 0, countdownTimer: null, countdownDeadlineTimer: null, countdownFire: null, sending: false,
    autoStopped: false, autoStoppedAllow: false,
    pendingPrompt: null, pendingAction: null,
    status: initCfg.handoffText
      ? 'Handoff ready — review & start'
      : (initCfg.armed ? `Ready (${modeLabel(initCfg.mode)})` : 'Off (saved)'),
    lastRenderSig: '',
  };

  let pendingSameTabBoot = null;
  let bootPollTimer = null;
  let stableWakeTimer = null;
  let pendingSendConfirm = null;

  const clearStabilityWake = () => {
    if (stableWakeTimer) { clearTimeout(stableWakeTimer); stableWakeTimer = null; }
  };
  const scheduleStabilityWake = (delayMs) => {
    clearStabilityWake();
    stableWakeTimer = setTimeout(() => {
      stableWakeTimer = null;
      tick();
    }, Math.max(50, Math.round(delayMs)));
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
      wrapUpMaxTurns: state.wrapUpMaxTurns,
      countdownSec: state.countdownSec,
      stableSec: state.stableSec,
      allowDelayMs: state.allowDelayMs,
      skipBgCountdown: state.skipBgCountdown,
      autoStartNewChat: state.autoStartNewChat,
      autoSendHandoff: state.autoSendHandoff,
      restoreModel: state.restoreModel,
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
    const active = state.armed || state.autoAllow || state.compactRequested;
    if (active && !releaseWakeLock && navigator.locks) {
      navigator.locks.request('wh_gemini_keepalive_' + Math.random().toString(36).slice(2), () => new Promise((res) => { releaseWakeLock = res; })).catch(() => {});
    } else if (!active && releaseWakeLock) {
      releaseWakeLock();
      releaseWakeLock = null;
    }
  };

  const allowAttempts = new WeakMap();
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
      if (node.nodeType === 3) { parts.push(node.nodeValue || ''); return; }
      const tag = (node.tagName || '').toUpperCase();
      if (SKIP_SIGNAL_TAGS.has(tag)) return;
      if (tag === '#TEXT') { parts.push(node._text || node.textContent || ''); return; }
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

  // --- Model & Thinking-level detection & restore (verified against Gemini's bard-mode-menu-button) ---
  const captureActiveModel = () => {
    const btn = queryFirst(SEL.modePickerBtn);
    if (!btn) return { model: null, thinking: null };
    const combined = `${btn.getAttribute('aria-label') || ''} ${btn.innerText || ''}`;
    const modelMatch = combined.match(/\b(Neon|Hydrogen|Carbon|Auto)\b/i);
    const thinkMatch = combined.match(/\b(Low|Medium|High)\b/i);
    return {
      model: modelMatch ? modelMatch[1][0].toUpperCase() + modelMatch[1].slice(1).toLowerCase() : null,
      thinking: thinkMatch ? thinkMatch[1][0].toUpperCase() + thinkMatch[1].slice(1).toLowerCase() : null,
    };
  };

  const restoreModelSelection = async (target) => {
    if (!target || (!target.model && !target.thinking)) return { ok: true, changed: false };
    const btn = queryFirst(SEL.modePickerBtn);
    if (!btn) return { ok: false, changed: false };
    const current = captureActiveModel();
    const needsModel = Boolean(target.model && current.model !== target.model);
    const needsThink = Boolean(target.thinking && current.thinking !== target.thinking);
    if (!needsModel && !needsThink) return { ok: true, changed: false };

    const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const openMenu = async () => {
      const b = queryFirst(SEL.modePickerBtn);
      if (!b) return [];
      b.click();
      await waitMs(320);
      return [...document.querySelectorAll('.cdk-overlay-pane [role="menuitemradio"]')].filter(isVisible);
    };

    let changed = false;
    let items = await openMenu();
    if (needsModel) {
      const mRe = new RegExp(`\\b${target.model}\\b`, 'i');
      const mItem = items.find((el) => (el.getAttribute('data-test-id') || '').startsWith('bard-mode-option-') && mRe.test(el.innerText || ''))
        || items.find((el) => mRe.test(el.innerText || ''));
      if (mItem && mItem.getAttribute('aria-checked') !== 'true') {
        mItem.click();
        changed = true;
        await waitMs(320);
      }
    }
    if (needsThink) {
      items = [...document.querySelectorAll('.cdk-overlay-pane [role="menuitemradio"]')].filter(isVisible);
      if (!items.length) items = await openMenu();
      const tRe = new RegExp(`\\b${target.thinking}\\b`, 'i');
      const tItem = items.find((el) => !(el.getAttribute('data-test-id') || '').startsWith('bard-mode-option-') && tRe.test(el.innerText || ''));
      if (tItem && tItem.getAttribute('aria-checked') !== 'true') {
        tItem.click();
        changed = true;
        await waitMs(180);
      }
    }
    // Dismiss menu if still open
    if (document.querySelector('.cdk-overlay-pane [role="menuitemradio"]')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
    const after = captureActiveModel();
    const ok = (!target.model || after.model === target.model);
    return { ok, changed, after };
  };

  const isBusy = () => Boolean(queryFirst(SEL.stopBtn) || queryFirst(SEL.busy));
  const hasComposerPopup = () => Boolean(queryFirst(SEL.composerPopup));
  const hasErrorBanner = () => [...document.querySelectorAll(SEL.errorBanner)].some((el) => isVisible(el) && /something went wrong|error|failed|try again/i.test(el.innerText || ''));

  const setStatus = (msg) => { if (state.status !== msg) { state.status = msg; render(); emitState(); } };
  const clearCountdown = (reason) => {
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
    if (state.countdownDeadlineTimer) { clearTimeout(state.countdownDeadlineTimer); state.countdownDeadlineTimer = null; }
    state.countdownFire = null;
    state.countdown = 0;
    state.countdownEndsAt = 0;
    state.pendingPrompt = null;
    state.pendingAction = null;
    if (reason) state.status = reason;
    render(true);
    emitState();
  };
  const disarm = (reason = 'Off', alsoStopAllow = false, isAutoStop = false) => {
    clearStabilityWake();
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
      if (state.armed || state.compactRequested) setStatus('Waiting: Allow prompt');
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
      const delay = document.hidden ? Math.min(300, state.allowDelayMs) : state.allowDelayMs;
      setTimeout(() => {
        if (!state.autoAllow || !isEnabled(btn)) return;
        btn.click();
        state.allowsClicked += 1;
        state.stableKey = '';
        state.stableSince = 0;
        state.status = `Allowed (#${state.allowsClicked})`;
        render(true);
        emitState();
      }, delay);
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
      const lines = text.split('\n');
      const nodes = lines.map((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        return p;
      });
      editor.replaceChildren(...nodes);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const buildTelemetryTag = (nextTurn) => {
    const cadence = state.handoffEvery > 0 ? ` chat=${state.assistantTurnsObserved}/${state.handoffEvery}` : '';
    return `[wh-ac: turn=${nextTurn}/${state.maxTurns} mode=${state.mode} allow=${state.autoAllow ? 'on' : 'off'}${cadence}]`;
  };

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

    if (state.autoStopped && !state.armed) {
      state.autoStopped = false;
      state.armed = true;
      if (state.autoStoppedAllow) { state.autoAllow = true; state.autoStoppedAllow = false; }
      state.turnsUsed = 0;
      state.compactRequested = false;
      state.wrapUpRemaining = 0;
      state.stableKey = '';
      state.stableSince = 0;
      syncKeepAlive();
      setStatus(`Ready (${modeLabel(state.mode)})`);
    }

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

  const sendPrompt = (promptText = null, { attempt = 1, countTowardCap = true, allowOverwriteDraft = false } = {}) => {
    const rawText = (promptText || state.prompt || DEFAULTS.prompt).trim();
    const nextTurn = countTowardCap ? state.turnsUsed + 1 : state.turnsUsed;
    const textToSend = /^\[wh-ac:/i.test(rawText) ? rawText : `${buildTelemetryTag(nextTurn)} ${rawText}`;
    const editor = queryFirst(SEL.editor);
    if (!editor) { state.sending = false; return disarm('No composer found'); }
    if (attempt === 1 && !allowOverwriteDraft && (editor.innerText || '').trim().length > 0) {
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

      let confirmDone = false;
      const confirmSubmission = (fromObserver = false) => {
        if (confirmDone) return;
        const curEditor = queryFirst(SEL.editor);
        const remaining = curEditor ? (curEditor.innerText || '').trim() : '';
        const afterSnap = getLatestResponse();
        const submitted = remaining === '' || isBusy() || afterSnap.count > beforeSnap.count;

        if (!submitted) {
          if (fromObserver) return;
          confirmDone = true;
          pendingSendConfirm = null;
          if (attempt < 2) return sendPrompt(textToSend, { attempt: attempt + 1, countTowardCap, allowOverwriteDraft: true });
          state.sending = false;
          return disarm('Send failed (check box)', false, true);
        }

        confirmDone = true;
        pendingSendConfirm = null;
        state.sending = false;
        state.stableKey = '';
        state.stableSince = 0;
        state.lastHandledKey = beforeSnap.key;
        state.lastSentCount = beforeSnap.count;
        if (countTowardCap) {
          state.turnsUsed += 1;
          state.status = `Sent (${state.turnsUsed}/${state.maxTurns})`;
          if (state.turnsUsed >= state.maxTurns && !state.compactRequested) {
            disarm(`Cap reached (${state.turnsUsed}/${state.maxTurns})`, false, true);
          } else {
            render(true);
            emitState();
          }
        } else {
          state.status = state.compactRequested ? 'Wrapping up...' : 'Sent';
          render(true);
          emitState();
        }
      };

      pendingSendConfirm = () => confirmSubmission(true);
      setTimeout(() => confirmSubmission(false), 350);
    }, 180);
  };

  const startCountdown = (snap, { customPrompt = null, waitSec = null, action = null, label = null, countTowardCap = true, allowOverwriteDraft = false } = {}) => {
    if (state.countdownTimer || state.countdownDeadlineTimer) return;
    clearStabilityWake();
    const delaySec = waitSec != null ? clampInt(waitSec, 5, 600, state.countdownSec) : state.countdownSec;
    const executeNow = () => {
      if (action) return action();
      sendPrompt(customPrompt, { countTowardCap, allowOverwriteDraft });
    };

    if (delaySec === 0 || (document.hidden && state.skipBgCountdown && waitSec == null)) {
      if (!action && !allowOverwriteDraft) {
        const editor = queryFirst(SEL.editor);
        if (editor && (editor.innerText || '').trim().length > 0) {
          if (snap) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; }
          return setStatus('Paused: draft in box');
        }
      }
      setStatus(document.hidden ? 'Sending (background)...' : (label ? `${label}...` : 'Sending...'));
      return executeNow();
    }

    state.pendingPrompt = customPrompt;
    state.pendingAction = action;
    state.countdownEndsAt = Date.now() + delaySec * 1000;
    state.countdown = delaySec;
    const prefix = label || (waitSec != null ? 'Waiting' : 'Sending in');
    state.status = `${prefix} ${delaySec}s...`;
    render(true);

    const checkAbort = () => {
      if (!action && !state.armed && !state.compactRequested) { clearCountdown('Aborted'); return true; }
      if (isBusy() || findPendingAllowButtons().length) { clearCountdown('Aborted: busy/approval'); return true; }
      if (!action && !allowOverwriteDraft) {
        const editor = queryFirst(SEL.editor);
        if (editor && (editor.innerText || '').trim().length > 0) {
          if (snap) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; }
          clearCountdown('Paused: draft in box');
          return true;
        }
      }
      return false;
    };

    const fireCountdown = () => {
      if (!state.countdownEndsAt) return;
      if (checkAbort()) return;
      const nextPrompt = state.pendingPrompt;
      const nextAction = state.pendingAction;
      clearCountdown(label ? `${label}...` : 'Sending...');
      if (nextAction) nextAction();
      else sendPrompt(nextPrompt, { countTowardCap, allowOverwriteDraft });
    };

    // Single one-shot deadline timer (chain depth < 5) so Chrome's 1-minute Intensive Throttling cannot stall background waits.
    state.countdownFire = fireCountdown;
    state.countdownDeadlineTimer = setTimeout(fireCountdown, delaySec * 1000);
    state.countdownTimer = setInterval(() => {
      if (checkAbort()) return;
      const rem = Math.ceil((state.countdownEndsAt - Date.now()) / 1000);
      if (rem <= 0) {
        fireCountdown();
      } else {
        state.countdown = rem;
        state.status = `${prefix} ${rem}s...`;
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

  const buildResumePrompt = (body) => {
    const clean = (body || '').trim();
    if (!clean) return '';
    return clean.startsWith('Continue this task in a fresh chat')
      ? clean
      : `${HANDOFF_RESUME_HEADER}\n\n${clean}`;
  };

  const triggerWrapUp = () => {
    if (state.sending || isBusy()) return setStatus('Wait: reply in progress');
    if (getResponses().length === 0) return setStatus('Nothing to wrap up yet');
    clearCountdown();
    state.compactRequested = true;
    state.wrapUpRemaining = state.wrapUpMaxTurns;
    state.handoffMeta = captureActiveModel();
    syncKeepAlive();
    setStatus(`Wrapping up (1/${state.wrapUpMaxTurns})...`);
    sendPrompt(WRAP_UP_REQUEST_PROMPT, { countTowardCap: false });
  };

  const copyHandoff = async (openNewTab = false) => {
    const text = buildResumePrompt(state.handoffText || getLatestResponse().text);
    if (!text) return false;
    try { await navigator.clipboard.writeText(text); } catch {}
    setStatus(openNewTab ? 'Handoff copied -> new tab' : 'Prompt copied');
    if (openNewTab) window.open('https://gemini.google.com/app', '_blank', 'noopener');
    return true;
  };

  const applyBootPayload = async (payload) => {
    if (!payload || !payload.resumePrompt) return false;
    if (location.pathname !== state.url) {
      // Sync SPA chat transition first so a later tick() doesn't overwrite the pasted-handoff status.
      tick();
    }
    const editor = queryFirst(SEL.editor);
    if (!editor) return false;

    if (state.restoreModel && (payload.model || payload.thinking)) {
      setStatus(`Restoring ${payload.model || 'model'}...`);
      try { await restoreModelSelection(payload); } catch {}
    }

    const liveEditor = queryFirst(SEL.editor);
    if (!liveEditor) return setStatus('Handoff ready — composer missing');
    setEditorText(liveEditor, payload.resumePrompt);
    const verified = (liveEditor.innerText || '').trim().length > 0;
    if (!verified) {
      setStatus('Paste failed — use Copy Prompt');
      return false;
    }

    if (payload.autoSend) {
      startCountdown(null, {
        customPrompt: payload.resumePrompt,
        label: 'Auto-sending handoff in',
        countTowardCap: false,
        allowOverwriteDraft: true,
      });
    } else {
      setStatus('Handoff pasted — press Enter');
    }
    return true;
  };

  const pollForFreshAppComposer = (payload) => {
    if (bootPollTimer) { clearInterval(bootPollTimer); bootPollTimer = null; }
    const deadline = Date.now() + 8000;
    bootPollTimer = setInterval(() => {
      const onFreshApp = isNewChatPath(location.pathname);
      const editor = queryFirst(SEL.editor);
      if (onFreshApp && editor && !isBusy() && (editor.innerText || '').trim() === '') {
        clearInterval(bootPollTimer);
        bootPollTimer = null;
        pendingSameTabBoot = null;
        void applyBootPayload(payload);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(bootPollTimer);
        bootPollTimer = null;
        pendingSameTabBoot = null;
        setStatus('New chat timed out — use Copy Prompt');
      }
    }, 200);
  };

  const startNewChatWithHandoff = (openNewTab = false) => {
    const resumePrompt = buildResumePrompt(state.handoffText || getLatestResponse().text);
    if (!resumePrompt) return setStatus('No handoff staged');
    const captured = state.handoffMeta || captureActiveModel();
    const payload = {
      resumePrompt,
      model: captured?.model || null,
      thinking: captured?.thinking || null,
      autoSend: state.autoSendHandoff,
    };

    if (openNewTab) {
      const bootId = writeBootToken(payload);
      window.open(`https://gemini.google.com/app#wh-boot=${bootId}`, '_blank', 'noopener');
      setStatus('Opened handoff in new tab');
      return true;
    }

    // Same-tab transition: stays strictly inside this tab's memory (zero cross-tab collision).
    pendingSameTabBoot = payload;
    const newChatBtn = queryFirst(SEL.newChat);
    if (newChatBtn) {
      setStatus('Opening new chat...');
      newChatBtn.click();
      pollForFreshAppComposer(payload);
      return true;
    }
    // Fallback if sidebar is hidden/collapsed: navigate with short-lived boot token.
    const bootId = writeBootToken(payload);
    location.href = `https://gemini.google.com/app#wh-boot=${bootId}`;
    return true;
  };

  const checkStartupBootHash = () => {
    const m = (location.hash || '').match(/#wh-boot=([a-z0-9]+)/i);
    if (!m) return;
    const payload = claimBootToken(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    if (payload) pollForFreshAppComposer(payload);
  };

  const tick = () => {
    if (location.pathname !== state.url) {
      const fromNewChat = isNewChatPath(state.url) && !isNewChatPath(location.pathname);
      state.url = location.pathname;
      if (fromNewChat) {
        if (state.userTouched) persistChat();
        else if (state.assistantTurnsObserved > 0) saveChatProgress(state.url, state.assistantTurnsObserved, state.lastObservedKey);
      } else {
        clearCountdown();
        clearStabilityWake();
        const cfg = buildChatConfig(location.pathname);
        Object.assign(state, cfg, {
          turnsUsed: 0, allowsClicked: 0,
          compactRequested: false, wrapUpRemaining: 0,
          autoStopped: false, autoStoppedAllow: false,
          lastHandledKey: '', lastSentCount: 0, stableKey: '', stableSince: 0,
          obsStableKey: '', obsStableSince: 0,
          needsBaseline: !isNewChatPath(location.pathname),
          status: cfg.handoffText
            ? 'Handoff ready — review & start'
            : (cfg.armed ? `Ready (${modeLabel(cfg.mode)})` : (cfg.userTouched ? 'Off (saved)' : 'Off')),
        });
        syncKeepAlive();
        render(true);
        emitState();
      }
      return;
    }

    const stableMs = state.stableSec * 1000;
    const busyNow = isBusy();

    // Passive truthful turn tracking: counts EVERY unique completed reply (even after Status: Done or Auto: OFF).
    let justObservedTurn = false;
    const snap = getLatestResponse();
    if (!busyNow && snap.count && snap.text) {
      if (state.needsBaseline) {
        state.needsBaseline = false;
        state.lastHandledKey = snap.key;
        state.lastSentCount = snap.count;
        if (!state.lastObservedKey) state.lastObservedKey = snap.key;
        if (state.armed && !state.handoffText) setStatus(`Ready (${modeLabel(state.mode)})`);
      } else if (snap.key !== state.lastObservedKey) {
        if (snap.key !== state.obsStableKey) {
          state.obsStableKey = snap.key;
          state.obsStableSince = Date.now();
          scheduleStabilityWake(stableMs + 100);
        } else if (Date.now() - state.obsStableSince >= stableMs) {
          state.lastObservedKey = snap.key;
          state.assistantTurnsObserved += 1;
          saveChatProgress(state.url, state.assistantTurnsObserved, state.lastObservedKey);
          justObservedTurn = true;
          render();
          emitState();
        } else if (!stableWakeTimer) {
          scheduleStabilityWake(stableMs - (Date.now() - state.obsStableSince) + 80);
        }
      }
    } else if (busyNow) {
      clearStabilityWake();
      state.obsStableKey = '';
      state.obsStableSince = 0;
    }

    if (!state.armed && !state.autoAllow && !state.compactRequested) return;
    if (hasErrorBanner()) {
      state.compactRequested = false;
      state.wrapUpRemaining = 0;
      return disarm('Stopped: error banner', true, true);
    }
    if (handlePendingApprovals()) { state.needsBaseline = false; render(); return; }
    if ((!state.armed && !state.compactRequested) || state.countdownTimer || state.countdownDeadlineTimer || state.sending) return;
    if (state.armed && !state.compactRequested && state.turnsUsed >= state.maxTurns) {
      return disarm(`Cap reached (${state.turnsUsed}/${state.maxTurns})`, false, true);
    }
    if (busyNow) { state.needsBaseline = false; state.stableKey = ''; state.stableSince = 0; return setStatus('Streaming / running...'); }

    if (!snap.count || !snap.text) return;
    if (!(snap.count > state.lastSentCount || snap.key !== state.lastHandledKey)) return;

    if (snap.key !== state.stableKey) {
      state.stableKey = snap.key;
      state.stableSince = Date.now();
      scheduleStabilityWake(stableMs + 100);
      return setStatus('Waiting for stability...');
    }
    const stableElapsed = Date.now() - state.stableSince;
    if (stableElapsed < stableMs) {
      if (!stableWakeTimer) scheduleStabilityWake(stableMs - stableElapsed + 80);
      return;
    }
    clearStabilityWake();

    const sigText = snap.signalText;
    if (hasHandoffMarker(sigText)) {
      state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
      const wasArmed = state.armed;
      state.compactRequested = false;
      state.wrapUpRemaining = 0;
      const body = extractHandoff(snap.text);
      const actionMatch = sigText.match(HANDOFF_ACTION_RE);
      const action = actionMatch ? actionMatch[1].toLowerCase() : 'continue';
      const meta = state.handoffMeta || captureActiveModel();
      state.handoffText = body;
      state.handoffMeta = { model: meta.model || null, thinking: meta.thinking || null, action };
      saveHandoffForChat(state.url, { text: body, model: meta.model || null, thinking: meta.thinking || null, action });
      if (state.autoStartNewChat && action !== 'wait_user') {
        disarm('Handoff ready — starting new chat', false, wasArmed);
        return startCountdown(snap, {
          label: 'Starting new chat in',
          action: () => startNewChatWithHandoff(false),
        });
      }
      return disarm(action === 'wait_user' ? 'Handoff ready (needs input)' : 'Handoff ready — review & start', false, wasArmed);
    }

    // Dynamic 1–2 turn Wrap-Up continuation: if Gemini used turn 1 to park background jobs / finish a step, nudge once more for [[HANDOFF]].
    if (state.compactRequested) {
      if (state.wrapUpRemaining > 1) {
        state.wrapUpRemaining -= 1;
        state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
        const dirWait = sigText.match(DIRECTIVE_WAIT_RE);
        const waitSec = dirWait ? Number(dirWait[1]) : null;
        return startCountdown(snap, {
          customPrompt: WRAP_UP_FINAL_NUDGE,
          waitSec,
          label: 'Final wrap-up in',
          countTowardCap: false,
        });
      }
      state.compactRequested = false;
      state.wrapUpRemaining = 0;
      state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
      if (!state.armed) return setStatus('Wrap-up ended (no handoff)');
    }

    if (sigText.includes(STOP_TOKEN)) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; return disarm(`Stopped: ${STOP_TOKEN}`, false, true); }
    const statusMatch = sigText.match(STOP_STATUS_RE);
    if (statusMatch) { state.lastHandledKey = snap.key; state.lastSentCount = snap.count; return disarm(`Stopped: Status ${statusMatch[1]}`, false, true); }
    if (!state.armed) {
      state.lastHandledKey = snap.key; state.lastSentCount = snap.count;
      return setStatus(state.autoStopped ? 'Standby' : 'Off (saved)');
    }

    if (justObservedTurn && state.handoffEvery > 0 && state.assistantTurnsObserved >= state.handoffEvery && (state.assistantTurnsObserved % state.handoffEvery === 0)) {
      state.lastHandledKey = snap.key;
      state.lastSentCount = snap.count;
      return triggerWrapUp();
    }

    const dirContinue = sigText.match(DIRECTIVE_CONTINUE_RE);
    const dirWait = sigText.match(DIRECTIVE_WAIT_RE);
    const hasMarker = Boolean(dirContinue) || SENTINELS.some((s) => sigText.includes(s)) || CHECKPOINT_HEADING_RE.test(sigText);
    if (state.mode === 'marker' && !hasMarker) {
      state.lastHandledKey = snap.key;
      state.lastSentCount = snap.count;
      return setStatus('Waiting for checkpoint');
    }

    const customPrompt = dirContinue ? dirContinue[1].replace(/\s+/g, ' ').trim() : null;
    const waitSec = dirWait ? Number(dirWait[1]) : null;
    startCountdown(snap, { customPrompt, waitSec });
  };

  // --- Floating HUD + Settings Drawer (100% DOM API, zero innerHTML) ---
  const hud = document.createElement('div');
  hud.id = 'wh-auto-continue-hud';
  Object.assign(hud.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '99999',
    background: 'rgba(20,22,27,0.92)', color: '#e8eaed', backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', padding: '8px 10px',
    font: '12px/1.35 system-ui,-apple-system,sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,0.38)',
    minWidth: '220px', maxWidth: '305px', userSelect: 'none',
  });
  document.body.appendChild(hud);

  const renderSettingsPanel = () => {
    const row = (mt = '5px') => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: mt });
    const numInput = (act, val, min, max, w = '46px') => h('input', {
      dataset: { act }, type: 'number', min: String(min), max: String(max), value: String(val),
      style: { width: w, background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '2px 4px', fontSize: '11px', textAlign: 'right' },
    });
    const toggleBtn = (act, on, title) => h('button', {
      dataset: { act }, title,
      style: {
        background: on ? 'rgba(52,211,153,0.22)' : 'rgba(255,255,255,0.1)',
        color: on ? '#6ee7b7' : '#9aa0a6',
        border: '0', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '10px', fontWeight: '600',
      },
    }, on ? 'ON' : 'OFF');
    const secHeader = (txt) => h('div', {
      style: { marginTop: '7px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase', opacity: '.65' },
    }, txt);

    return [
      h('div', { style: row('0') },
        h('span', { style: { fontWeight: '700', fontSize: '12px' } }, `Settings (v${VERSION})`),
        h('button', { dataset: { act: 'settings' }, style: { background: 'rgba(255,255,255,0.12)', color: '#fff', border: '0', borderRadius: '5px', padding: '2px 8px', cursor: 'pointer', fontSize: '11px' } }, 'Done')
      ),
      secHeader('Timers & Delays'),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Send countdown (s)'), numInput('countdownSec', state.countdownSec, 0, 60)),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Stability wait (s)'), numInput('stableSec', state.stableSec, 1, 15)),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Allow delay (ms)'), numInput('allowDelayMs', state.allowDelayMs, 100, 5000, '56px')),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Skip countdown in bg'), toggleBtn('skipBgCountdown', state.skipBgCountdown, 'Send immediately when tab is hidden')),

      secHeader('Continuation & Wrap-Up'),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Max auto turns'), numInput('cap', state.maxTurns, 1, 50)),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Handoff every (0=off)'), numInput('every', state.handoffEvery, 0, 20)),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Wrap-up max turns'), numInput('wrapUpMaxTurns', state.wrapUpMaxTurns, 1, 3)),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Restore model on handoff'), toggleBtn('restoreModel', state.restoreModel, 'Re-select the same model & thinking level in new chat')),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Auto-start new chat'), toggleBtn('autoStartNewChat', state.autoStartNewChat, 'Automatically click New chat once Wrap Up finishes (default OFF)')),
      h('div', { style: row() }, h('span', { style: { fontSize: '11px' } }, 'Auto-send after paste'), toggleBtn('autoSendHandoff', state.autoSendHandoff, 'Automatically send pasted handoff after countdown (default OFF)')),

      secHeader('Default Continue Prompt'),
      h('input', {
        dataset: { act: 'prompt' }, type: 'text', value: state.prompt,
        style: { marginTop: '5px', width: '100%', boxSizing: 'border-box', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '5px', padding: '4px 6px', fontSize: '11px' },
      }),

      h('div', { style: { ...row('8px'), paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.1)' } },
        h('button', { dataset: { act: 'clearStore' }, title: 'Clear all saved per-chat overrides & turn counters', style: { background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: '0', borderRadius: '5px', padding: '3px 7px', cursor: 'pointer', fontSize: '10px' } }, 'Clear Saved Chats'),
        h('button', { dataset: { act: 'resetDefaults' }, title: 'Restore default timers and wrap-up settings', style: { background: 'rgba(255,255,255,0.1)', color: '#cbd5e1', border: '0', borderRadius: '5px', padding: '3px 7px', cursor: 'pointer', fontSize: '10px' } }, 'Reset Timers')
      ),
    ];
  };

  const render = (force = false) => {
    if (!force && document.activeElement?.closest('#wh-auto-continue-hud input, #wh-auto-continue-hud select')) return;
    const canWrapUp = !state.sending && !isBusy() && getResponses().length > 0;
    const sig = [
      state.armed, state.autoStopped, state.autoAllow, state.allowsClicked, state.userTouched,
      Boolean(state.handoffText), canWrapUp, state.assistantTurnsObserved, state.handoffEvery,
      state.mode, state.turnsUsed, state.maxTurns, state.collapsed, state.settingsOpen,
      state.countdown, state.status, state.countdownSec, state.stableSec, state.allowDelayMs,
      state.skipBgCountdown, state.autoStartNewChat, state.autoSendHandoff, state.restoreModel, state.wrapUpMaxTurns,
    ].join('|');
    if (!force && sig === state.lastRenderSig) return;
    state.lastRenderSig = sig;

    if (state.settingsOpen) {
      hud.replaceChildren(...renderSettingsPanel());
      return;
    }

    const cyclePos = state.handoffEvery > 0 ? (state.assistantTurnsObserved % state.handoffEvery) : state.assistantTurnsObserved;
    const cadenceNear = state.handoffEvery > 0 && (state.handoffEvery - cyclePos <= 1) && state.assistantTurnsObserved > 0;
    const handoffBadge = state.handoffEvery > 0 ? `Handoff ${state.assistantTurnsObserved}/${state.handoffEvery}` : `Turns ${state.assistantTurnsObserved}`;

    const autoDotColor = state.armed ? '#34d399' : (state.autoStopped ? '#38bdf8' : '#9aa0a6');
    const autoText = state.armed ? 'Auto: ON' : (state.autoStopped ? 'Auto: Standby' : 'Auto: OFF');
    const autoTitle = state.armed
      ? 'Auto-Continue ON (Alt+Shift+A). Click to turn OFF for this chat.'
      : (state.autoStopped
        ? 'Standby after completion/cap — resumes automatically on your next message (Alt+Shift+A to arm now).'
        : 'Auto-Continue OFF (saved for this chat). Click to turn ON.');

    const row = (mt = '0') => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: mt });
    const dot = (color, sz = '8px') => h('span', { style: { width: sz, height: sz, borderRadius: '50%', background: color, display: 'inline-block' } });

    const topRow = h('div', { style: row() },
      h('button', { dataset: { act: 'toggle' }, title: autoTitle, style: { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '600' } },
        dot(autoDotColor), autoText),
      h('span', { style: { opacity: '.85', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' } },
        state.userTouched ? h('span', { title: 'Saved override for this chat', style: { fontSize: '10px', opacity: '.85' } }, '📌') : null,
        h('span', { title: state.handoffEvery > 0 ? `Completed replies in this chat (${state.assistantTurnsObserved}) before auto-wrap-up at ${state.handoffEvery}` : `Completed replies in this chat (${state.assistantTurnsObserved})`, style: { color: cadenceNear ? '#fbbf24' : '#93c5fd', fontWeight: '600' } }, handoffBadge),
        h('span', { title: `Auto-sent continuations in this run (${state.turnsUsed} of ${state.maxTurns} max)` }, `Auto ${state.turnsUsed}/${state.maxTurns}`)),
      h('span', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        h('button', { dataset: { act: 'settings' }, title: 'Configure timers, wrap-up & defaults', style: { all: 'unset', cursor: 'pointer', opacity: '.8', padding: '0 2px', fontSize: '12px' } }, '⚙'),
        h('button', { dataset: { act: 'collapse' }, title: state.collapsed ? 'Expand' : 'Collapse', style: { all: 'unset', cursor: 'pointer', opacity: '.75', padding: '0 3px' } }, state.collapsed ? '+' : '−'))
    );

    const allowRow = h('div', { style: row('5px') },
      h('button', { dataset: { act: 'allow' }, title: 'Toggle Auto-Allow for MCP confirmation cards (Alt+Shift+L)', style: { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: '600' } },
        dot(state.autoAllow ? '#f59e0b' : '#9aa0a6', '7px'), `Allow: ${state.autoAllow ? 'ON (All)' : 'OFF'}`),
      h('span', { style: { opacity: '.7', fontSize: '10px' } },
        `${state.allowsClicked ? `✓${state.allowsClicked} · ` : ''}${state.countdownSec}s / ${state.stableSec}s`)
    );

    const statusRow = state.countdown > 0
      ? h('div', { style: { ...row('6px'), background: 'rgba(251,191,36,0.16)', padding: '4px 6px', borderRadius: '6px' } },
          h('span', {}, state.status),
          h('button', { dataset: { act: 'cancel' }, style: { background: '#ef4444', color: '#fff', border: '0', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '11px' } }, 'Cancel'))
      : h('div', { style: { marginTop: '4px', opacity: '.75', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, state.status);

    const nodes = [topRow, allowRow, statusRow];
    if (state.handoffText) {
      const modelNote = state.handoffMeta?.model
        ? ` (${state.handoffMeta.model}${state.handoffMeta.thinking ? ' ' + state.handoffMeta.thinking : ''})`
        : '';
      nodes.push(
        h('div', { style: { marginTop: '6px', padding: '6px', background: 'rgba(37,99,235,0.16)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: '7px', display: 'flex', flexDirection: 'column', gap: '5px' } },
          h('div', { style: row('0') },
            h('span', { style: { fontSize: '10px', fontWeight: '600', color: '#bfdbfe' } }, `Handoff Staged${modelNote}`),
            h('button', { dataset: { act: 'dismissHandoff' }, title: 'Dismiss staged handoff', style: { all: 'unset', cursor: 'pointer', opacity: '.7', fontSize: '11px', padding: '0 3px' } }, '×')
          ),
          h('div', { style: { display: 'flex', gap: '5px' } },
            h('button', { dataset: { act: 'copyHandoff' }, title: 'Copy full ready-to-paste handoff prompt', style: { flex: '1', background: 'rgba(255,255,255,0.12)', color: '#fff', border: '0', borderRadius: '5px', padding: '4px 6px', cursor: 'pointer', fontSize: '11px', fontWeight: '600' } }, 'Copy Prompt'),
            h('button', { dataset: { act: 'startNewChat' }, title: 'Same-tab New Chat + restore model + paste prompt (Shift+Click for new tab)', style: { flex: '1', background: '#2563eb', color: '#fff', border: '0', borderRadius: '5px', padding: '4px 6px', cursor: 'pointer', fontSize: '11px', fontWeight: '600' } }, 'Start New Chat')
          )
        )
      );
    }

    if (!state.collapsed) {
      nodes.push(
        h('div', { style: { marginTop: '7px', paddingTop: '7px', borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: row('0') },
            h('button', { dataset: { act: 'mode' }, title: state.mode === 'marker' ? 'Smart: only auto-continues when Gemini emits a checkpoint' : 'Every Reply: auto-continues after every reply until Max auto or Status: Done', style: { background: 'rgba(255,255,255,0.1)', color: '#fff', border: '0', borderRadius: '5px', padding: '3px 7px', cursor: 'pointer', fontSize: '11px' } }, `Mode: ${modeLabel(state.mode)}`),
            h('button', { dataset: { act: 'wrapUp' }, disabled: !canWrapUp, title: canWrapUp ? 'Wrap up in 1–2 turns, park background jobs, and stage a fresh-chat handoff' : 'Available after at least one completed reply', style: { background: 'rgba(245,158,11,0.22)', color: '#fcd34d', border: '0', borderRadius: '5px', padding: '3px 8px', cursor: canWrapUp ? 'pointer' : 'not-allowed', opacity: canWrapUp ? '1' : '.45', fontSize: '11px', fontWeight: '600' } }, 'Wrap Up'),
            state.userTouched ? h('button', { dataset: { act: 'reset' }, title: 'Clear saved overrides for this chat (keeps turn count)', style: { background: 'rgba(255,255,255,0.1)', color: '#cbd5e1', border: '0', borderRadius: '5px', padding: '3px 6px', cursor: 'pointer', fontSize: '10px' } }, 'Reset') : null
          )
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
    clearChatUserOverrides(state.url);
    const cfg = buildChatConfig(state.url);
    Object.assign(state, cfg, {
      autoStopped: false, autoStoppedAllow: false,
      status: cfg.armed ? `Reset -> Ready (${modeLabel(cfg.mode)})` : 'Reset -> Off',
    });
    syncKeepAlive();
    render(true);
    emitState();
  };

  const resetTimersAndDefaults = () => {
    Object.assign(state, {
      countdownSec: DEFAULTS.countdownSec,
      stableSec: DEFAULTS.stableSec,
      allowDelayMs: DEFAULTS.allowDelayMs,
      skipBgCountdown: DEFAULTS.skipBgCountdown,
      wrapUpMaxTurns: DEFAULTS.wrapUpMaxTurns,
      autoStartNewChat: DEFAULTS.autoStartNewChat,
      autoSendHandoff: DEFAULTS.autoSendHandoff,
      restoreModel: DEFAULTS.restoreModel,
      handoffEvery: DEFAULTS.handoffEvery,
      maxTurns: DEFAULTS.maxTurns,
      prompt: DEFAULTS.prompt,
    });
    persistGlobal();
    render(true);
    emitState();
  };

  hud.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'toggle') toggleArmed();
    else if (act === 'allow') toggleAllow();
    else if (act === 'settings') { state.settingsOpen = !state.settingsOpen; render(true); }
    else if (act === 'mode') { state.mode = state.mode === 'marker' ? 'nturns' : 'marker'; persistGlobal(); persistChat(); if (state.armed) state.status = `Ready (${modeLabel(state.mode)})`; render(true); emitState(); }
    else if (act === 'collapse') { state.collapsed = !state.collapsed; persistGlobal(); render(true); }
    else if (act === 'cancel') { const s = getLatestResponse(); state.lastHandledKey = s.key; state.lastSentCount = s.count; clearCountdown('Canceled (waiting next)'); }
    else if (act === 'wrapUp') triggerWrapUp();
    else if (act === 'copyHandoff') copyHandoff(false);
    else if (act === 'startNewChat') startNewChatWithHandoff(Boolean(e.shiftKey));
    else if (act === 'dismissHandoff') { state.handoffText = ''; state.handoffMeta = null; clearHandoffForChat(state.url); state.status = state.armed ? `Ready (${modeLabel(state.mode)})` : (state.autoStopped ? 'Standby' : 'Off (saved)'); render(true); emitState(); }
    else if (act === 'reset') resetCurrentChat();
    else if (act === 'skipBgCountdown') { state.skipBgCountdown = !state.skipBgCountdown; persistGlobal(); render(true); emitState(); }
    else if (act === 'autoStartNewChat') { state.autoStartNewChat = !state.autoStartNewChat; persistGlobal(); render(true); emitState(); }
    else if (act === 'autoSendHandoff') { state.autoSendHandoff = !state.autoSendHandoff; persistGlobal(); render(true); emitState(); }
    else if (act === 'restoreModel') { state.restoreModel = !state.restoreModel; persistGlobal(); render(true); emitState(); }
    else if (act === 'clearStore') { writeChatStore({}); state.userTouched = false; state.assistantTurnsObserved = 0; render(true); emitState(); }
    else if (act === 'resetDefaults') resetTimersAndDefaults();
  });

  hud.addEventListener('change', (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === 'cap') { state.maxTurns = clampInt(e.target.value, 1, 50, DEFAULTS.maxTurns); persistGlobal(); persistChat(); }
    else if (act === 'every') { const n = Number(e.target.value); state.handoffEvery = n > 0 ? clampInt(n, 2, 20, DEFAULTS.handoffEvery) : 0; persistGlobal(); persistChat(); }
    else if (act === 'wrapUpMaxTurns') { state.wrapUpMaxTurns = clampInt(e.target.value, 1, 3, DEFAULTS.wrapUpMaxTurns); persistGlobal(); }
    else if (act === 'countdownSec') { state.countdownSec = clampInt(e.target.value, 0, 60, DEFAULTS.countdownSec); persistGlobal(); }
    else if (act === 'stableSec') { state.stableSec = clampInt(e.target.value, 1, 15, DEFAULTS.stableSec); persistGlobal(); }
    else if (act === 'allowDelayMs') { state.allowDelayMs = clampInt(e.target.value, 100, 5000, DEFAULTS.allowDelayMs); persistGlobal(); }
    else if (act === 'prompt') { state.prompt = e.target.value.trim() || DEFAULTS.prompt; persistGlobal(); persistChat(); }
    render(true);
    emitState();
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
    version: VERSION,
    url: state.url,
    armed: state.armed,
    autoAllow: state.autoAllow,
    autoStopped: state.autoStopped,
    mode: state.mode,
    modeLabel: modeLabel(state.mode),
    turnsUsed: state.turnsUsed,
    maxTurns: state.maxTurns,
    handoffEvery: state.handoffEvery,
    wrapUpMaxTurns: state.wrapUpMaxTurns,
    wrapUpRemaining: state.wrapUpRemaining,
    countdownSec: state.countdownSec,
    stableSec: state.stableSec,
    allowDelayMs: state.allowDelayMs,
    skipBgCountdown: state.skipBgCountdown,
    autoStartNewChat: state.autoStartNewChat,
    autoSendHandoff: state.autoSendHandoff,
    restoreModel: state.restoreModel,
    chatTurns: state.assistantTurnsObserved,
    allowsClicked: state.allowsClicked,
    prompt: state.prompt,
    userTouched: state.userTouched,
    handoffReady: Boolean(state.handoffText),
    handoffMeta: state.handoffMeta,
    settingsOpen: state.settingsOpen,
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
      if (patch.maxTurns !== undefined) state.maxTurns = clampInt(patch.maxTurns, 1, 50, state.maxTurns);
      if (patch.handoffEvery !== undefined) {
        const n = Number(patch.handoffEvery);
        state.handoffEvery = n > 0 ? clampInt(n, 2, 20, DEFAULTS.handoffEvery) : 0;
      }
      if (patch.wrapUpMaxTurns !== undefined) state.wrapUpMaxTurns = clampInt(patch.wrapUpMaxTurns, 1, 3, state.wrapUpMaxTurns);
      if (patch.countdownSec !== undefined) state.countdownSec = clampInt(patch.countdownSec, 0, 60, state.countdownSec);
      if (patch.stableSec !== undefined) state.stableSec = clampInt(patch.stableSec, 1, 15, state.stableSec);
      if (patch.allowDelayMs !== undefined) state.allowDelayMs = clampInt(patch.allowDelayMs, 100, 5000, state.allowDelayMs);
      if (typeof patch.skipBgCountdown === 'boolean') state.skipBgCountdown = patch.skipBgCountdown;
      if (typeof patch.autoStartNewChat === 'boolean') state.autoStartNewChat = patch.autoStartNewChat;
      if (typeof patch.autoSendHandoff === 'boolean') state.autoSendHandoff = patch.autoSendHandoff;
      if (typeof patch.restoreModel === 'boolean') state.restoreModel = patch.restoreModel;
      if (typeof patch.settingsOpen === 'boolean') state.settingsOpen = patch.settingsOpen;
      if (typeof patch.prompt === 'string' && patch.prompt.trim()) state.prompt = patch.prompt.trim();
      if (persist) { persistGlobal(); persistChat(); }
      syncKeepAlive();
      render(true);
      emitState();
      return getPublicState();
    },
    insertTag: insertTagIntoComposer,
    wrapUp: triggerWrapUp,
    handoffNow: triggerWrapUp,
    compactNow: triggerWrapUp,
    startNewChat: startNewChatWithHandoff,
    captureActiveModel,
    restoreModelSelection,
    resetChat: () => { resetCurrentChat(); return getPublicState(); },
    clearStore: () => { writeChatStore({}); state.userTouched = false; state.assistantTurnsObserved = 0; render(true); return getPublicState(); },
    copyHandoff,
  };

  syncKeepAlive();
  render(true);
  checkStartupBootHash();
  let obsTimer = null;
  let lastObsRun = 0;
  new MutationObserver((muts) => {
    if (muts.every((m) => hud.contains(m.target))) return;
    if (pendingSendConfirm) pendingSendConfirm();
    const now = Date.now();
    if (now - lastObsRun >= 250) {
      lastObsRun = now;
      tick();
    } else if (!obsTimer) {
      obsTimer = setTimeout(() => { obsTimer = null; lastObsRun = Date.now(); tick(); }, 250);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class'] });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.countdownEndsAt && Date.now() >= state.countdownEndsAt && state.countdownFire) {
      state.countdownFire();
      return;
    }
    if (state.armed || state.autoAllow || state.compactRequested) tick();
  });
  setInterval(tick, 1500);
})();
