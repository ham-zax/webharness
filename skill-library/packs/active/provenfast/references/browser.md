# Browser counters

Inject the meter before the interaction, run the interaction a fixed number of
times, and read `window.__perf` afterwards. It works from DevTools, Playwright
(`page.addInitScript` / `page.evaluate`), Puppeteer, or any browser tool your
harness has.

Use only the counters needed to explain the observed problem. A lean pass can
start with existing timings and a rendering trace; this meter and the frame
stepping recipe are optional tools. CI integration and dedicated rigs must earn
their setup and maintenance cost under `SKILL.md`'s scope rules.

## In-page meter

```js
(() => {
  const perf = (window.__perf = {
    domMutations: 0, styleRecalcs: 0, layoutShift: 0, shiftsByRegion: {},
    longFrames: 0, longFrameMs: 0, worstFrameMs: 0, frames: 0, reactCommits: 0,
  });

  // DOM mutations: every node added/removed/attribute/text change.
  new MutationObserver((records) => { perf.domMutations += records.length; })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  // Layout shifts, attributed to a named region (closest [data-region] or tag#id).
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      perf.layoutShift += e.value;
      for (const s of e.sources ?? []) {
        const el = s.node?.closest?.('[data-region]');
        const region = el?.dataset.region ?? s.node?.nodeName ?? 'unknown';
        perf.shiftsByRegion[region] = (perf.shiftsByRegion[region] ?? 0) + e.value;
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });

  // Long animation frames (Chromium): main-thread frames over 50 ms, with script attribution.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { perf.longFrames++; perf.longFrameMs += e.duration; }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}

  // Frame meter from requestAnimationFrame timestamps.
  let last = 0;
  const tick = (t) => {
    if (last) { perf.frames++; perf.worstFrameMs = Math.max(perf.worstFrameMs, t - last); }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // React commits: wrap the DevTools hook if present (dev or profiling builds).
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook?.onCommitFiberRoot) {
    const orig = hook.onCommitFiberRoot.bind(hook);
    hook.onCommitFiberRoot = (...a) => { perf.reactCommits++; return orig(...a); };
  }
})();
```

For React without DevTools, wrap the measured subtree in
`<Profiler id="journey" onRender={() => window.__perf.reactCommits++}>` in a
profiling build. For Vue, use `app.config.performance = true` together with the
`renderTracked`/`renderTriggered` hooks. For Svelte or Solid, count effect runs in
a wrapper.

## Requests before and after ready

Fewer requests is not automatically better (see `field-lessons.md` A6). Split
them at the moment the user can act. Place `performance.mark('journey:ready')`
there, which is also the end of the truth window, then:

```js
const ready = performance.getEntriesByName('journey:ready').at(-1).startTime;
const split = { beforeReady: 0, afterReady: 0, beforeReadyBytes: 0, afterReadyBytes: 0 };
for (const r of performance.getEntriesByType('resource')) {
  const k = r.startTime < ready ? 'beforeReady' : 'afterReady';
  split[k]++;
  split[`${k}Bytes`] += r.transferSize; // 0 for cross-origin without Timing-Allow-Origin
}
```

- Call `performance.setResourceTimingBufferSize(1000)` early. The default buffer of 250 entries silently drops entries on busy pages.
- "Started before ready" is an upper bound on blocking work. A request that starts early but doesn't gate the journey (analytics, prefetch) still competes for bandwidth and the main thread. The fix is to move it after the mark, not to stop counting it.
- When the trace leaves a dependency unclear, delay a request and see whether ready moves. A sufficiently long hold can put an otherwise overlapping request on the critical path, so compare its normal completion time with the trace and try smaller delays before attributing the original latency to it.

  ```js
  // Playwright: hold one endpoint, then compare journey:ready between HOLD_MS=0 and, say, 1000.
  // Any route disables Playwright's HTTP cache, so register it in the baseline run too;
  // otherwise the comparison also measures the lost cache.
  const holdMs = Number(process.env.HOLD_MS ?? 0);
  await page.route('**/api/models**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await route.continue();
  });
  ```

- If a request-count gate is useful, choose ceilings from observed noise and the intended behavior. Before-ready counts include non-blocking work, so reductions need latency validation. Never lower either count by removing revalidation or persistence calls without a redundancy proof.

## Cached data, freshness, and durability

Showing cached data before the network responds is one of the biggest
perceived-speed wins. It is also where speed work most often breaks
correctness. Every cache-first change needs these tests (`field-lessons.md` B1-B3).

**Layout: two cases, not one.** A "zero layout shift" test alone pushes toward
never reconciling with the server.

1. *Cache matches server.* Seed the cache, serve identical data (`page.route(..., r => r.fulfill({ json: same }))`), and assert zero layout shift and zero DOM mutations in the cached region after the response.
2. *Cache differs from server.* Serve one changed, added, and removed row. Assert that the final DOM equals the server data, and that shifts fall only in the rows that changed (`shiftsByRegion` with a `data-region` per row).

**Freshness and durability.** Playwright's `expect` retries until its timeout, so
these assert convergence, which is exactly what stale-while-revalidate promises.
`createItem`, `deleteItem`, and `sendFirst` stand for app-specific helpers.

```js
test('a delete on another device reaches this one', async ({ browser }) => {
  const ctx = () => browser.newContext({ storageState: 'auth.json' });
  const a = await (await ctx()).newPage(), b = await (await ctx()).newPage();
  await a.goto('/'); await b.goto('/');
  const title = await createItem(b);
  await a.reload(); await expect(a.getByText(title)).toBeVisible();
  await deleteItem(b, title);
  await a.reload();
  await expect(a.getByText(title)).toHaveCount(0); // fails if the cache wins forever
});

test('an item created just before a refresh survives it', async ({ page }) => {
  await page.goto('/');
  const title = await sendFirst(page); // do not wait for the response
  await page.reload();
  await expect(page.getByText(title)).toBeVisible();
});
```

Decide the durability contract before writing the second test. The contract is
either "it persists" or "the user is told it didn't". Silent loss is never acceptable. Run
both tests against cold, warm, and stale caches, and under `page.route` delays
or `context.setOffline(true)`.

## Style recalcs and layouts via CDP

The web platform does not expose the style-recalc count directly; read it through
the Chrome DevTools Protocol:

```js
// Playwright (Chromium)
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const before = await read();
await runInteraction(page);              // fixed, scripted journey
const after = await read();
const delta = (k) => after[k] - before[k];
console.log({ recalcStyle: delta('RecalcStyleCount'), layouts: delta('LayoutCount'),
              scriptMs: delta('ScriptDuration') * 1000, taskMs: delta('TaskDuration') * 1000 });
```

`RecalcStyleCount` and `LayoutCount` are near-deterministic for a scripted
interaction. The `*Duration` values are wall time: treat them as truth, not as gates.

## Deterministic frame stepping (frame budget in CI)

Headless Chromium can be driven one frame at a time, so frame-budget tests
do not depend on machine speed:

1. Launch with `--deterministic-mode` (or `--enable-begin-frame-control --run-all-compositor-stages-before-draw`) in headless mode.
2. For each frame, call CDP `HeadlessExperimental.beginFrame({ frameTimeTicks, interval: 8.333 })` for 120 Hz, or 16.667 for 60 Hz, advancing `frameTimeTicks` by the interval.
   Verify the rig before trusting it: keep a `requestAnimationFrame` loop running in the page and check that N `beginFrame` calls produce exactly N callbacks. The sprint's rig produced 240 frames from 240 begin frames at 8.33 ms. This validates virtual cadence, not real presentation smoothness or GPU throughput; validate the improvement on a representative device too.
3. Around each frame, read the main-thread task time (tracing or `Performance.getMetrics` `TaskDuration` delta). Flag frames whose work exceeds the budget.
4. Gate on **total main-thread blocking** and the **worst frame** over a long fixture, such as a long streamed reply or a big table render.

Headless mode does not have the real browser UI. Prerendering, tab-strip
resizes, and extensions do not happen there. When field layout-shift or frame
data disagrees with the lab, simulate the field condition explicitly (for
example, resize the viewport mid-load to mimic browser UI changes) and keep it as a test.

## Field conditions the lab misses

- **Prerendering.** Chrome can render a page before the user navigates (omnibox
  or new-tab predictions), at a different viewport size. Detect it with
  `document.prerendering` and the `prerenderingchange` event. Measure journeys from
  `performance.getEntriesByType('navigation')[0].activationStart`, not from 0, or
  prerendered loads will look instant. In the sprint, a prerender at the new-tab
  page's height made the page grow 56 px after first paint. Lab test: load at one
  viewport size, call `page.setViewportSize` after first paint, and assert no shift in
  pinned regions.
- **Rendering costs that CPU profiles miss.** Open the DevTools Rendering panel and
  turn on paint flashing, layout shift regions, layer borders, and frame rendering
  stats. For GPU and compositor time, record a trace with the `gpu` and `viz`
  categories in Perfetto or `chrome://tracing`.
- **Real devices.** Test 120 Hz displays, low-end Android, and throttled CPU (CDP
  `Emulation.setCPUThrottlingRate`). The developer's laptop is the best case.

## Gating

Write the counts per journey into `metrics.json`, for example
`{"open-conversation.domMutations": 412, "open-conversation.recalcStyle": 9}`, and
run `node scripts/ratchet.mjs check perf-baseline.json metrics.json`.
