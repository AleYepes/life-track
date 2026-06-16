(() => {
  const TITLE_METADATA_SEPARATOR = " ∼ ";
  const REGEX_NOTIFICATION_COUNT = /^\(\d+\)\s+/;
  const REGEX_YT_WATCH = /\/watch(\?|$)/;
  const REGEX_YT_SHORTS = /\/shorts\//;
  const REGEX_YT_SHORTS_ID = /\/shorts\/([^/?#]+)/;
  const REGEX_GMAIL_PATH = /#(?:inbox|all|sent|drafts|starred|important|label)\//;
  const REGEX_CLEAN_TITLE = /[^a-z0-9]/g;

  const titleDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "title");
  if (!(titleDescriptor?.get && titleDescriptor?.set)) {
    console.error("[AW Extender] Failed to locate Document.prototype.title descriptor.");
    return;
  }

  const originalTitleGetter = titleDescriptor.get;
  const originalTitleSetter = titleDescriptor.set;

  let currentPlainTitle = "";
  let currentMetadata = [];
  let lastEnrichedTitle = "";

  let activeScraper = null;
  let activeScraperCleanup = null;
  let pendingBodyWatcher = null;
  let lastKnownUrl = window.location.href;

  function debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), delay);
    };
  }

  function stripMetadata(title) {
    if (!title) return "";
    const cleanTitle = title.replace(REGEX_NOTIFICATION_COUNT, "");
    const separatorIndex = cleanTitle.indexOf(TITLE_METADATA_SEPARATOR);
    return separatorIndex === -1 ? cleanTitle : cleanTitle.slice(0, separatorIndex);
  }

  function applyEnrichedTitle() {
    if (!currentPlainTitle) return;

    const enrichedTitle = [
      currentPlainTitle,
      window.location.href,
      ...currentMetadata,
    ].join(TITLE_METADATA_SEPARATOR) + TITLE_METADATA_SEPARATOR;

    if (enrichedTitle === lastEnrichedTitle) return;

    try {
      originalTitleSetter.call(document, enrichedTitle);
      lastEnrichedTitle = enrichedTitle;
    } catch (error) {
      console.error("[AW Extender] Failed to set enriched title:", error);
    }
  }

  // ── Scrapers ──────────────────────────────────────────────────────────

  const SCRAPERS = [
    {
      name: "youtube",
      match: (host) => host === "www.youtube.com" || host === "youtube.com",
      shouldRun: (url) => REGEX_YT_WATCH.test(url) || REGEX_YT_SHORTS.test(url),

      // Returns true if the DOM title element doesn't match the current tab title,
      // indicating stale/recycled DOM content from a previous video.
      _isTitleStale(domTitleEl) {
        const domTitle = domTitleEl?.textContent?.trim();
        if (!(domTitle && currentPlainTitle)) return false;

        const normalizedDom = domTitle.toLowerCase().replace(REGEX_CLEAN_TITLE, "");
        const normalizedTab = currentPlainTitle.toLowerCase().replace(REGEX_CLEAN_TITLE, "");

        return (
          normalizedTab &&
          normalizedDom &&
          !normalizedTab.includes(normalizedDom) &&
          !normalizedDom.includes(normalizedTab)
        );
      },

      _scrapeShorts(url) {
        const match = url.match(REGEX_YT_SHORTS_ID);
        const expectedShortsId = match ? match[1] : null;

        const activeReel =
          document.querySelector("ytd-reel-video-renderer[is-active]") ||
          document.querySelector("ytd-reel-video-renderer");

        const domVideoId =
          activeReel?.getAttribute("video-id") ||
          activeReel?.getAttribute("data-video-id");
        if (expectedShortsId && domVideoId && domVideoId !== expectedShortsId) {
          return [];
        }

        const reelTitleEl = activeReel?.querySelector(
          '#video-title, .title, h2, h3, [class*="title" i]'
        );
        if (this._isTitleStale(reelTitleEl)) return [];

        const el = activeReel?.querySelector(
          "yt-reel-channel-bar-view-model .ytReelChannelBarViewModelChannelName a"
        );
        const name = el?.textContent?.trim();
        return name ? [`channel:${name}`] : [];
      },

      _scrapeWatch(url) {
        const v = new URL(url).searchParams.get("v");
        if (!v) return [];

        // Try internal player API first (fast, synchronizes with the correct video ID).
        try {
          const player = document.getElementById("movie_player");
          if (player && typeof player.getVideoData === "function") {
            const data = player.getVideoData();
            if (data?.video_id === v && data.author) {
              return [`channel:${data.author.trim()}`];
            }
          }
        } catch (_) { /* fall through to DOM selectors */ }

        // Fallback to DOM elements — verify video ID first.
        const watchFlexy = document.querySelector("ytd-watch-flexy");
        const domVideoId = watchFlexy?.getAttribute("video-id");
        if (domVideoId && domVideoId !== v) return [];

        // Verify DOM metadata matches the current tab title.
        const domTitleEl = document.querySelector(
          "ytd-watch-metadata h1, #title h1, h1.ytd-video-primary-info-renderer"
        );
        if (this._isTitleStale(domTitleEl)) return [];

        // Extract channel name from DOM (multiple selector strategies).
        const selectors = [
          "ytd-video-owner-renderer ytd-channel-name a, ytd-watch-metadata #channel-name a, #owner-name a",
          'span[itemprop="author"] meta[itemprop="name"], [itemprop="author"] [itemprop="name"]',
          "ytd-channel-name a",
        ];

        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const name = (el.getAttribute("content") || el.textContent)?.trim();
          if (name) return [`channel:${name}`];
        }

        return [];
      },

      scrape() {
        const url = window.location.href;
        return REGEX_YT_SHORTS.test(url)
          ? this._scrapeShorts(url)
          : this._scrapeWatch(url);
      },

      observe(onRefresh, onApply) {
        let attempts = 0;
        const maxAttempts = 50;
        const requiredStablePolls = 3;
        let timeoutId = null;
        let lastResult = "";
        let stableCount = 0;

        const poll = () => {
          attempts++;
          const scraped = this.scrape();
          const current = JSON.stringify(scraped);

          if (scraped.length > 0) {
            stableCount = current === lastResult ? stableCount + 1 : 1;
            lastResult = current;

            if (stableCount >= requiredStablePolls) {
              onRefresh(scraped);
              onApply();
              return;
            }
          } else {
            stableCount = 0;
            lastResult = "";
          }

          if (attempts >= maxAttempts) {
            if (scraped.length > 0) {
              onRefresh(scraped);
              onApply();
            }
            return;
          }

          timeoutId = setTimeout(poll, 200);
        };

        // Start polling asynchronously to let the initial title change
        // set the title without metadata first.
        timeoutId = setTimeout(poll, 200);

        return () => {
          if (timeoutId) clearTimeout(timeoutId);
        };
      },
    },
    {
      name: "gmail",
      match: (host) => host === "mail.google.com",
      shouldRun: (url) => REGEX_GMAIL_PATH.test(url),

      scrape() {
        const activeMessage = document.querySelector(
          '[role="listitem"][aria-expanded="true"]'
        );
        if (!activeMessage) return [];

        const senderElement = activeMessage.querySelector(".gD[email]");
        const email = senderElement?.getAttribute("email");
        return email ? [`sender:${email}`] : [];
      },

      observe(onRefresh, onApply) {
        const target = document.querySelector('div[role="main"]') || document.body;

        const debouncedCallback = debounce(() => {
          onRefresh();
          onApply();
        }, 150);

        const observer = new MutationObserver(debouncedCallback);
        observer.observe(target, {
          childList: true,
          subtree: true,
        });

        return () => observer.disconnect();
      },
    },
  ];

  // ── Core Engine ───────────────────────────────────────────────────────

  function getMatchingScraper() {
    const url = window.location.href;
    const hostname = window.location.hostname;

    return SCRAPERS.find((scraper) => {
      if (!scraper.match(hostname)) return false;
      if (scraper.shouldRun && !scraper.shouldRun(url)) return false;
      return true;
    });
  }

  function refreshMetadata(explicitMetadata) {
    if (!activeScraper) {
      currentMetadata = [];
      return;
    }
    try {
      currentMetadata = explicitMetadata !== undefined
        ? explicitMetadata
        : (activeScraper.scrape() ?? []);
    } catch (error) {
      console.error(`[AW Extender] Scraper "${activeScraper.name}" failed:`, error);
      currentMetadata = [];
    }
  }

  function installActiveScraper() {
    if (pendingBodyWatcher) {
      pendingBodyWatcher.disconnect();
      pendingBodyWatcher = null;
    }
    if (activeScraperCleanup) {
      activeScraperCleanup();
      activeScraperCleanup = null;
    }

    activeScraper = getMatchingScraper();
    currentMetadata = [];

    if (!activeScraper?.observe) {
      // No observer — scrape eagerly (or just clear if no scraper matched).
      refreshMetadata();
      return;
    }

    // For scrapers with observers, defer scraping entirely to the observer.
    // Eagerly scraping here risks injecting stale metadata before the DOM
    // has settled (e.g. YouTube Shorts channel bar lags behind video-id).

    function setupObserver() {
      try {
        activeScraperCleanup = activeScraper.observe(
          (explicitMetadata) => refreshMetadata(explicitMetadata),
          () => applyEnrichedTitle(),
        );
      } catch (error) {
        console.error(
          `[AW Extender] Failed to initialize scraper "${activeScraper.name}":`,
          error,
        );
      }
    }

    if (document.body) {
      setupObserver();
    } else {
      pendingBodyWatcher = new MutationObserver(() => {
        if (!document.body) return;
        pendingBodyWatcher.disconnect();
        pendingBodyWatcher = null;
        setupObserver();
      });
      pendingBodyWatcher.observe(document.documentElement, { childList: true });
    }
  }

  function handleUrlChange() {
    currentPlainTitle = stripMetadata(originalTitleGetter.call(document));
    installActiveScraper();
    applyEnrichedTitle();
  }

  // ── Title Interception ────────────────────────────────────────────────

  Object.defineProperty(Document.prototype, "title", {
    configurable: titleDescriptor.configurable,
    enumerable: titleDescriptor.enumerable,
    get() {
      return stripMetadata(originalTitleGetter.call(document));
    },
    set(value) {
      const prev = currentPlainTitle;
      currentPlainTitle = stripMetadata(value);

      // Reset metadata when the title actually changes — prevents stale
      // metadata from a previous video bleeding into the new title.
      if (currentPlainTitle !== prev) {
        currentMetadata = [];
      }

      // Detect URL changes that may not have triggered history hooks
      // (common on SPAs like YouTube that set the title before pushing state).
      const currentUrl = window.location.href;
      if (currentUrl !== lastKnownUrl) {
        lastKnownUrl = currentUrl;
        installActiveScraper();
      }

      applyEnrichedTitle();
    },
  });

  // ── <title> Element Observer ──────────────────────────────────────────

  let titleObserver = null;
  function observeTitleElement(titleElement) {
    if (titleObserver) titleObserver.disconnect();
    if (!titleElement) return;

    const synchronizeTitle = () => {
      const text = titleElement.textContent;
      if (typeof text !== "string" || text.includes(TITLE_METADATA_SEPARATOR)) return;

      const stripped = stripMetadata(text);
      if (stripped !== currentPlainTitle) {
        currentPlainTitle = stripped;
        currentMetadata = [];
      }
      applyEnrichedTitle();
    };

    synchronizeTitle();

    titleObserver = new MutationObserver(synchronizeTitle);
    titleObserver.observe(titleElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function observeHead(headElement) {
    const existingTitle = headElement.querySelector("title");
    if (existingTitle) observeTitleElement(existingTitle);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === "TITLE") {
            observeTitleElement(node);
          }
        }
      }
    });

    observer.observe(headElement, { childList: true });
  }

  function initializeDOMObservers() {
    if (document.head) {
      observeHead(document.head);
      return;
    }
    const observer = new MutationObserver((_, mutationObserver) => {
      if (!document.head) return;
      observeHead(document.head);
      mutationObserver.disconnect();
    });
    observer.observe(document.documentElement, { childList: true });
  }

  // ── History Hooks ─────────────────────────────────────────────────────

  function initializeHistoryHooks() {
    if (typeof history === "undefined" || !history.pushState) return;

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      lastKnownUrl = window.location.href;
      handleUrlChange();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      lastKnownUrl = window.location.href;
      handleUrlChange();
    };

    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────

  initializeDOMObservers();
  initializeHistoryHooks();
  handleUrlChange();
})();