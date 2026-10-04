# Platform-Native Solutions

Before reaching for a package, ask whether the platform already ships the capability.

## Browser / HTML / CSS

| You think you need | Native option |
|---|---|
| Date picker | `<input type="date">` |
| Time picker | `<input type="time">` |
| Color picker | `<input type="color">` |
| Range slider | `<input type="range">` |
| Progress bar | `<progress>` |
| Meter/gauge | `<meter>` |
| Modal/dialog library | `<dialog>` + `showModal()` |
| Accordion/FAQ | `<details><summary>...` |
| Searchable dropdown | `<input list>` + `<datalist>` |
| Sticky header | `position: sticky` |
| Responsive font/spacing | CSS `clamp()` |
| Dark mode | `prefers-color-scheme` |
| Reduced motion | `prefers-reduced-motion` |
| Responsive grids | `repeat(auto-fill, minmax(...))` |
| Component responsive design | container queries |
| Parent selector | `:has()` |

## JavaScript / Browser APIs

| Package/custom code | Native option |
|---|---|
| query-string / qs | `URLSearchParams` |
| lodash.clonedeep | `structuredClone` |
| lodash.groupby | `Object.groupBy` |
| numeral/accounting | `Intl.NumberFormat` |
| date formatting | `Intl.DateTimeFormat` |
| relative time | `Intl.RelativeTimeFormat` |
| clipboard.js | `navigator.clipboard` |
| uuid v4 | `crypto.randomUUID()` |
| infinite scroll library | `IntersectionObserver` |
| resize listener library | `ResizeObserver` |
| DOM mutation watcher | `MutationObserver` |
| share sheet | `navigator.share` |
| simple storage wrapper | `localStorage` |
| fetch timeout | `AbortSignal.timeout()` |
| custom event bus | `EventTarget` |

## Node.js standard library

Prefer `fs.mkdirSync(..., {recursive:true})`, `fs.rmSync(..., {recursive:true, force:true})`, `path`, `crypto.randomUUID()`, `Set`, `Array.flat`, `JSON.parse`/`JSON.stringify`, and other built-ins before wrapper packages.

## Python standard library

Prefer `datetime.fromisoformat`, `zoneinfo.ZoneInfo`, `dataclasses.dataclass`, `pathlib.Path`, `enum.Enum`, `json`, `argparse`, `itertools`, and `functools` before third-party wrappers when they satisfy the real requirement.

## Database-native mechanisms

Prefer constraints, window functions, recursive CTEs, native JSON/search support, defaults/triggers, `UNIQUE`, `FOREIGN KEY`, and `CHECK` constraints over duplicating database invariants in application code.

Native is not dogma. A dependency earns its place when the native mechanism is genuinely insufficient for required compatibility, edge cases, ergonomics, or scale.
