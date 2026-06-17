# Research Notes: YouTube Metadata Scraper

## The Bug

When navigating between YouTube Shorts, the channel metadata from the **previous** short was incorrectly applied to the **next** short's title. The root cause: YouTube is an SPA that updates the tab title *before* the DOM hydrates with the new video's metadata. The extension's core engine would detect the title change, eagerly scrape the DOM, find the *old* channel name still rendered, and lock it into the enriched title.

Regular `/watch?` videos were unaffected because the `movie_player` API (`getVideoData()`) synchronizes with the correct video ID, providing a reliable channel source independent of DOM hydration timing.

## Architecture

The extension has two layers:

1. **Core Engine** — Intercepts `document.title` (via `Object.defineProperty` on `Document.prototype` and a `<title>` element `MutationObserver`), appends metadata (URL, scraper results) using a separator `∼`, and manages scraper lifecycle.

2. **Scrapers** — Site-specific plugins that implement `match()`, `shouldRun()`, `scrape()`, and optionally `observe(onRefresh, onApply)`. Currently: YouTube and Gmail.

### Observer Contract: `observe(onRefresh, onApply)`

Scrapers that need asynchronous metadata resolution implement `observe(onRefresh, onApply)`:

- **`onRefresh(explicitMetadata?)`** — Pushes metadata to global `currentMetadata`. If called with an argument, sets that value directly. If called without arguments, the core engine calls `scrape()` to get the metadata.
- **`onApply()`** — Triggers the enriched title to be written to `document.title`.

This two-callback pattern is essential for YouTube because it lets the observer's internal stability logic control *when* metadata enters global state, preventing the core engine from re-scraping stale DOM.

Gmail's observer simply calls `onRefresh()` (no args) followed by `onApply()`, which is equivalent to the old `onRelevantChange()` pattern.

---

## Essential Mechanisms (Confirmed Load-Bearing)

### 1. Metadata Reset on Title Change
**Where**: `Document.prototype.title` setter, `synchronizeTitle()` (the `<title>` MutationObserver callback).  
**What**: When `currentPlainTitle` changes, immediately set `currentMetadata = []`.  
**Why**: When YouTube navigates to a new short, it sets the tab title before the DOM updates. This reset ensures the enriched title goes out with only `title ∼ url ∼` — no stale channel name.

### 2. Deferred Observer-Only Scraping
**Where**: `installActiveScraper()` — skips `refreshMetadata()` if the scraper has an `observe` method.  
**What**: For scrapers with observers, the initial scrape is deferred entirely to the observer. `currentMetadata` stays `[]` until the observer explicitly publishes a result.  
**Why**: Eagerly calling `scrape()` during `installActiveScraper()` would immediately query the stale DOM and populate `currentMetadata` with the old channel name.

### 3. Two-Callback Observer Pattern (`onRefresh` / `onApply`)
**Where**: YouTube scraper's `observe()` method.  
**What**: The observer polls internally, and only when it has a stable result does it push it to global state via `onRefresh(scraped)` then trigger the title rewrite via `onApply()`.  
**Why**: The old single-callback `onRelevantChange()` pattern forced the core engine to call `scrape()` when notified — but the core engine doesn't know whether the DOM is ready. The observer must control the push.

### 4. Stability Polling (3 Consecutive Stable Polls)
**Where**: YouTube scraper's `observe()` poll loop.  
**What**: Requires 3 consecutive identical non-empty scrape results before publishing.  
**Why**: YouTube's DOM can briefly show stale channel names during transitions. A single successful scrape is insufficient.

### 5. Asynchronous Initial Poll
**Where**: `setTimeout(poll, 200)` at the end of YouTube's `observe()`.  
**What**: The first poll is delayed by 200ms.  
**Why**: Allows the title setter to fire first with `currentMetadata = []`, producing a clean title without metadata. If the poll ran synchronously, it could scrape stale DOM before the metadata reset in the title setter fires.

### 6. Video ID Cross-Checking
**Where**: `_scrapeShorts()` and `_scrapeWatch()`.  
**What**: Compare the URL's video ID against the DOM element's `video-id` attribute. Return `[]` on mismatch.  
**Why**: Recycled DOM elements retain previous data. This is a fast, reliable staleness check.

---

## Defensive Guards (Confirmed Redundant — Removed)

### 7. DOM Title Fuzzy Matching (`_isTitleStale`) — **REMOVED in phase 2a**
**What it was**: Normalized and compared the DOM's visible title element against `currentPlainTitle`. Returned `[]` if they diverged.  
**Why removed**: Confirmed redundant. The video-ID attribute check, stability polling (3×), and metadata reset on title change collectively prevent stale metadata from being published. Removing it caused no regressions.

---

## Essential — Misclassified as Defensive

### 8. `lastKnownUrl` Tracking in Title Setter
**Where**: `Document.prototype.title` setter + `lastKnownUrl = window.location.href` sync assignments in history hooks.  
**What**: Detects URL changes that haven't yet triggered history hooks and calls `installActiveScraper()`.  
**Why it's essential**: On YouTube Shorts navigation, the title change (step 1) consistently *precedes* the `replaceState` call (step 2). Without the title setter's URL check, `installActiveScraper()` is never called and the polling observer never starts — metadata stops working entirely on navigation. Confirmed load-bearing by phase 2b failure.

### 9. `pendingBodyWatcher`
**Where**: `installActiveScraper()`.  
**What**: Defers observer setup until `document.body` exists.  
**Why it's essential**: `run_at: "document_start"` means the script executes before `document.body` exists on cold page loads. `handleUrlChange()` is called at bootstrap, which calls `installActiveScraper()`. Without this guard, `activeScraper.observe()` would run before the body exists, and Gmail's observer (`document.querySelector('div[role="main"]') || document.body`) would fail silently.

---

## Failed Trimming Attempts

### Attempt 1 (by previous agent): Flatten to `onRelevantChange` + Re-enable Eager Scraping
**What was changed**: Replaced `observe(onRefresh, onApply)` with `observe(onRelevantChange)`, and re-enabled eager `refreshMetadata()` in `installActiveScraper()`.  
**Result**: Bug reintroduced. Stale metadata bled through immediately.  
**Root cause**: Two mechanisms broke simultaneously:
1. Eager scraping populated `currentMetadata` with the old channel name before the observer even started.
2. The single-callback pattern forced the core engine to re-scrape on notification. During a slow transition, the poll stabilized on the stale channel name (which remained static in the DOM), called `onRelevantChange()`, the core engine re-scraped, found the same stale data already in `currentMetadata`, detected no change, and exited — locking in the stale metadata permanently.

### Attempt 2 (phase 2b): Remove `lastKnownUrl` Tracking
**What was changed**: Removed the `lastKnownUrl` variable, the URL-change detection block in the title setter, and the two `lastKnownUrl = window.location.href` sync lines in the history hooks.  
**Result**: Metadata stopped working entirely on YouTube — no channel metadata appeared at all after navigating.  
**Root cause**: On YouTube Shorts navigation, `document.title` is set *before* `history.replaceState()` is called. The title setter's URL-change detection (`currentUrl !== lastKnownUrl → installActiveScraper()`) is therefore the *primary* mechanism that starts the polling observer. Removing it meant `installActiveScraper()` was never called on navigation, so the observer never ran. The history hooks alone are insufficient because they fire after the title has already been set.

> **Implication**: `lastKnownUrl` is not belt-and-suspenders — it is the essential trigger for scraper installation on YouTube. The `lastKnownUrl = window.location.href` sync assignments inside history hooks are equally essential: without them, every title change on the new page would re-detect the URL as changed and redundantly call `installActiveScraper()` again, tearing down the running observer on each title update.

## Current Stable State

Phase 2a (`f48fe2c`) is considered the refined final version:
- **527 → 418 lines** (-21% from the debugging-era WIP)
- All debug logs removed
- YouTube helpers encapsulated as private methods on the scraper object
- `_isTitleStale` confirmed redundant and removed
- All remaining mechanisms confirmed essential
- No further trimming is warranted without risking regressions
