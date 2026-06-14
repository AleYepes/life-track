// Main-World Content Script (Executes in the page context)
(function () {
  "use strict";

  const SEP = "⌈";
  let rawTitle = "";
  let pollInterval = null;

  const tabState = {
    audible: false,
    muted: false,
  };

  // Helper to extract the raw title before our separator
  function stripMetadata(title) {
    if (!title) return "";
    return title.includes(SEP) ? title.split(SEP)[0] : title;
  }

  // 1. Hook Document.prototype.title setter/getter
  const titleDesc = Object.getOwnPropertyDescriptor(Document.prototype, "title");
  if (!titleDesc) {
    console.error("[AW Extender] Could not find Document.prototype.title descriptor.");
    return;
  }
  const rawGet = titleDesc.get;
  const rawSet = titleDesc.set;

  rawTitle = stripMetadata(rawGet.call(document));

  Object.defineProperty(Document.prototype, "title", {
    configurable: titleDesc.configurable,
    enumerable: titleDesc.enumerable,
    get() {
      return rawTitle;
    },
    set(value) {
      const newRaw = stripMetadata(value);
      if (newRaw !== rawTitle) {
        rawTitle = newRaw;
        updateTitle();
        startMetadataPolling();
      }
    },
  });

  // 2. Extensible Site Scraper Registry
  //    Each scraper may optionally define:
  //      isComplete() → true once all fields are resolved (enables early poll exit)
  //      _cache       → populated by scrape() to skip repeated work (P1)
  const SCRAPERS = [
    {
      name: "youtube",
      match: (host) => host === "youtube.com" || host.endsWith(".youtube.com"),
      _cache: null,
      isComplete() {
        return this._cache !== null;
      },
      _lastUrl: "",
      _urlVideoId: "",
      scrape() {
        // [P1] Return cached result once both fields are resolved
        if (this._cache) return this._cache;

        const currentUrl = window.location.href;
        if (this._lastUrl !== currentUrl) {
          this._lastUrl = currentUrl;
          const paramsVideoId = new URLSearchParams(window.location.search).get("v");
          const pathVideoId = window.location.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1];
          this._urlVideoId = paramsVideoId || pathVideoId || "";
        }

        const metadata = [];
        let channelName = "";
        let videoId = "";

        const urlVideoId = this._urlVideoId;

        // Primary: page-level global (fast, no DOM query). YouTube SPAs can leave
        // this global stale briefly, so only trust it when it matches the URL.
        const playerResponse = window.ytInitialPlayerResponse;
        const playerVideoId = playerResponse?.videoDetails?.videoId || "";
        if (urlVideoId && playerResponse?.videoDetails) {
          if (playerVideoId === urlVideoId) {
            channelName = playerResponse.videoDetails.author || "";
            videoId = playerVideoId;
          }
        }

        // Fallback: DOM query if global is not yet populated
        if (!channelName) {
          const channelEl = document.querySelector(
            "ytd-video-owner-renderer #channel-name a, #owner-name a, #upload-info .ytd-channel-name a",
          );
          if (channelEl) channelName = channelEl.innerText.trim();
        }

        if (!videoId) videoId = urlVideoId;

        if (channelName) metadata.push(`channel: ${channelName}`);
        if (videoId) metadata.push(`video_id: ${videoId}`);

        // Ensure the DOM is fresh before caching in SPAs
        const domVideoId = document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
        const isFresh = domVideoId === urlVideoId || playerVideoId === urlVideoId;

        // Cache only when the page-level response or DOM agrees with the current URL.
        if (channelName && videoId && isFresh) {
          this._cache = metadata;
        }

        return metadata;
      },
    },
    {
      name: "gmail",
      match: (host) => host === "mail.google.com",
      _cache: null,
      isComplete() {
        return this._cache !== null;
      },
      scrape() {
        if (this._cache) return this._cache;

        const metadata = [];
        const senderEl = document.querySelector(".gD");
        if (senderEl) {
          const sender = senderEl.getAttribute("email") || senderEl.innerText.trim();
          if (sender) metadata.push(`sender: ${sender}`);
        }
        if (metadata.length) this._cache = metadata;
        return metadata;
      },
    },
  ];

  // Cache the matched scraper for the current host (SCRAPERS.find is only called once)
  let _activeScraper = null;

  function getActiveScraper() {
    if (_activeScraper === null) {
      _activeScraper = SCRAPERS.find((s) => s.match(window.location.hostname)) ?? undefined;
    }
    return _activeScraper;
  }

  function getSiteMetadata() {
    const scraper = getActiveScraper();
    if (scraper) {
      try {
        return scraper.scrape();
      } catch (e) {
        console.error(`[AW Extender] Scraper error on ${scraper.name}:`, e);
      }
    }
    return [];
  }

  let isUpdatingTitle = false;

  // 3. Format and update the tab title
  //    Accepts optional pre-computed siteMetadata to avoid a redundant getSiteMetadata() call (P3)
  function updateTitle(siteMetadata) {
    // Note: Spread syntax is intentional to avoid mutating the cached array from the scraper
    const metadata = [...(siteMetadata ?? getSiteMetadata())];
    if (tabState.audible) metadata.push("audible: true");
    if (tabState.muted) metadata.push("muted: true");

    const formatted = [rawTitle || "", window.location.href, ...metadata].join(SEP) + SEP;

    try {
      isUpdatingTitle = true;
      rawSet.call(document, formatted);
    } catch (e) {
      console.error("[AW Extender] Failed to set document title:", e);
    } finally {
      // Clear flag after the MutationObserver microtask runs
      setTimeout(() => { isUpdatingTitle = false; }, 0);
    }
  }

  // 4. Poll for metadata when elements load asynchronously
  function startMetadataPolling() {
    if (pollInterval) clearInterval(pollInterval);

    const scraper = getActiveScraper();
    if (!scraper) {
      pollInterval = null;
      return;
    }

    let attempts = 0;
    const maxAttempts = 15; // 15 × 400ms = 6s max

    // [B4] Seed with current metadata so the first tick doesn't trigger a
    //      redundant updateTitle() when the caller already ran it.
    let lastMetadataStr = getSiteMetadata().join(",");

    pollInterval = setInterval(() => {
      attempts++;

      const siteMetadata = getSiteMetadata();
      const metadataStr = siteMetadata.join(",");

      if (metadataStr !== lastMetadataStr) {
        lastMetadataStr = metadataStr;
        updateTitle(siteMetadata); // [P3] pass pre-computed metadata
      }

      // [P2] Early exit: stop once the scraper signals completion or attempts are exhausted.
      const scraperDone = scraper.isComplete?.() ?? false; // has scraper but no isComplete → keep polling

      if (scraperDone || attempts >= maxAttempts) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 400);
  }

  // 5. Hook history pushState/replaceState to detect SPA URL transitions
  function hookHistory() {
    // [B3] Guard: pushState may not exist on non-HTTP pages (e.g. file://, chrome://)
    if (typeof history === "undefined" || !history.pushState) return;

    const pushState = history.pushState;
    const replaceState = history.replaceState;

    history.pushState = function (...args) {
      pushState.apply(this, args);
      handleUrlChange();
    };
    history.replaceState = function (...args) {
      replaceState.apply(this, args);
      handleUrlChange();
    };

    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
  }

  let lastUrl = window.location.href;
  function handleUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      _activeScraper = null; // Force re-evaluation of scraper on url change
      updateTitle([]); // Clear metadata fields immediately on URL change
      startMetadataPolling();
    }
  }

  // 6. MutationObservers for Title Changes
  function initMutationObserver() {
    let titleObserver = null;

    function handleTitleChange(el) {
      if (!el || isUpdatingTitle) return;
      const content = el.textContent;
      if (!content.includes(SEP)) {
        rawTitle = content;
        updateTitle();
        startMetadataPolling();
      }
    }

    function observeTitleEl(el) {
      if (titleObserver) titleObserver.disconnect();
      if (!el) return;

      rawTitle = stripMetadata(el.textContent);
      updateTitle();

      titleObserver = new MutationObserver(() => {
        handleTitleChange(el);
      });

      titleObserver.observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    // 1. Initially try to observe the title element
    const initialTitleEl = document.querySelector("title");
    if (initialTitleEl) observeTitleEl(initialTitleEl);

    // 2. Watch document.documentElement (shallow) for title element replacement/addition
    const headObserver = new MutationObserver((mutations) => {
      let newTitleEl = null;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeName === "TITLE") {
              newTitleEl = node;
              break;
            }
          }
        }
      }
      if (newTitleEl) {
        observeTitleEl(newTitleEl);
      }
    });

    headObserver.observe(document.documentElement, {
      childList: true,
      subtree: false, // Huge performance boost over subtree: true
    });
  }

  // 7. Receive state updates from the isolated-world content script
  window.addEventListener("AW_STATE_UPDATE", (e) => {
    const state = e.detail;
    let changed = false;

    if (state.audible !== undefined && state.audible !== tabState.audible) {
      tabState.audible = state.audible;
      changed = true;
    }
    if (state.muted !== undefined && state.muted !== tabState.muted) {
      tabState.muted = state.muted;
      changed = true;
    }

    if (changed) updateTitle();
  });

  // Start initialization
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initMutationObserver();
      startMetadataPolling();
    });
  } else {
    initMutationObserver();
    startMetadataPolling();
  }

  hookHistory();
})();
