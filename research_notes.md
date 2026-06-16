# Research Notes: YouTube Metadata Scraper Investigation

This document summarizes the findings from debugging the YouTube Shorts metadata lag bug, including the some lessons learned from a failed refinement attempt.

---

## Theorized Key Mechanisms

1. **Deferred Eager Scraping for Observers**:
   - **Why**: YouTube Shorts transition logic is slow to hydrate the DOM. Eagerly calling `refreshMetadata()` for scrapers that have observers (like YouTube) immediately scrapes the old/stale DOM elements of the previous video.
   - **Fix**: The core engine must check if a matched scraper has an `observe` method. If it does, eager scraping MUST be bypassed during `installActiveScraper()`, allowing `currentMetadata` to remain empty (`[]`) until the observer's stability poll publishes a verified result.

2. **Stability Guarding via Separate Observer Callbacks (`onRefresh`, `onApply`)**:
   - **Why**: In a simplified decoupled observer (`onRelevantChange`), the core engine is forced to call `scrape()` again when notified. This creates a race condition where the scraper poll determines when to notify, but the core engine manages the actual global state updates. If the poll stabilizes too early (e.g., on a stale channel name that is static during transition), it updates the global metadata with the stale data.
   - **Fix**: The observer must use a distinct `onRefresh(explicitMetadata)` callback to publish its *internally verified, stable* metadata directly to the core state, and `onApply()` to trigger the title rewrite. This ensures that the global `currentMetadata` is *only* mutated when the observer explicitly publishes a stable, verified result.

3. **Immediate Metadata Reset on Title Change**:
   - **Why**: YouTube updates the page title before it updates the URL or invokes the title setter's URL change detection.
   - **Fix**: Resetting `currentMetadata = []` the very millisecond the stripped title changes (both in the `Document.prototype.title` setter and in the `<title>` element's MutationObserver `synchronizeTitle()`) prevents old metadata from bleeding into the new title.

4. **Asynchronous Initial Poll**:
   - **Why**: Starting the poll synchronously during setup causes it to immediately scrape the old/stale DOM elements of the previous video.
   - **Fix**: Starting the poll asynchronously via `setTimeout(poll, 200)` gives the page a tick to update the DOM and allows the initial title setter to cleanly update without metadata first.

5. **Stale DOM Detection via Video ID and Title Matching**:
   - **Why**: Recycled DOM elements in YouTube's scroll list retain previous data.
   - **Fix**: Returning `[]` in `scrapeShorts` if the active reel's `video-id` does not match the URL's expected ID, or if the active reel's DOM title is empty or does not match the tab's plain title.

6. **Syncing `lastKnownUrl` in History Hooks**:
   - **Why**: If `pushState`/`replaceState` updates the URL, it calls `handleUrlChange()`. If we do not update `lastKnownUrl` inside these hooks, the subsequent `title` setter call will detect the URL change a second time, triggering redundant scraper re-installation and teardowns.
   - **Fix**: Assigning `lastKnownUrl = window.location.href` inside the history hook intercepts.

---

## Lessons from the Refinement Failure

We attempted to refactor the code to match a cleaner, decoupled layout:
- We merged all eager scraping paths into `installActiveScraper()`.
- We replaced the specialized `onRefresh(scraped)` and `onApply()` callbacks with a single `onRelevantChange()` callback.

**Why it failed**:
1. **Eager Scraping Captures Stale DOM**: Calling `refreshMetadata()` eagerly for the YouTube scraper immediately queried the stale DOM, setting `currentMetadata` to the old channel name.
2. **Decoupled Callbacks Locked in Stale Data**: The poll loop checked for stability on a non-empty scrape. During a slow transition, the stale channel name `@AsmongoldShorts1` remained in the DOM for several hundred milliseconds. The poll loop detected this as "stable" and called `onRelevantChange()`.
3. **Double Querying/Early Exit**: Since `currentMetadata` was already populated with `@AsmongoldShorts1` (from the eager scrape), the callback detected no change and exited early. However, because the poll loop returned after reaching stability, it stopped polling entirely, locking in the stale channel name and preventing the scraper from ever detecting the new channel name (`@ProZD`) once it finally loaded.
