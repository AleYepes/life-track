// Top-level constants for regular expressions (comply with lint/performance/useTopLevelRegex)
const REGEX_NOTIFICATION_COUNT = /^\(\d+\)\s+/;
const REGEX_YT_WATCH = /\/watch(\?|$)/;
const REGEX_YT_SHORTS = /\/shorts\//;
const REGEX_YT_SHORTS_ID = /\/shorts\/([^/?#]+)/;
const REGEX_GMAIL_PATH = /#(?:inbox|all|sent|drafts|starred|important|label)\//;
const REGEX_CLEAN_TITLE = /[^a-z0-9]/g;

(() => {
  console.log("[AW] Script initializing, URL:", window.location.href);
  const TITLE_METADATA_SEPARATOR = " ∼ ";

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

    const cleanTitle = title.replace(REGEX_NOTIFICATION_COUNT, ""); // Strip leading notification count
    const separatorIndex = cleanTitle.indexOf(TITLE_METADATA_SEPARATOR);
    return separatorIndex === -1
      ? cleanTitle
      : cleanTitle.slice(0, separatorIndex);
  }

  function applyEnrichedTitle() {
    if (!currentPlainTitle) return;

    const enrichedTitle = [
        currentPlainTitle,
        window.location.href,
        ...currentMetadata,
    ].join(TITLE_METADATA_SEPARATOR) + TITLE_METADATA_SEPARATOR;

    if (enrichedTitle === lastEnrichedTitle) return;

    console.log("[AW] applyEnrichedTitle", {
      plainTitle: currentPlainTitle,
      url: window.location.href,
      metadata: currentMetadata,
    });

    try {
      originalTitleSetter.call(document, enrichedTitle);
      lastEnrichedTitle = enrichedTitle;
    } catch (error) {
      console.error("[AW Extender] Failed to set enriched title:", error);
    }
  }

  function isShortsTitleStale(activeReel, currentPlainTitle) {
    if (!(activeReel && currentPlainTitle)) {
      return false;
    }
    const domTitleEl = activeReel.querySelector('#video-title, .title, h2, h3, [class*="title" i]');
    const domTitle = domTitleEl?.textContent?.trim();
    if (domTitle) {
      const normalizedDom = domTitle
        .toLowerCase()
        .replace(REGEX_CLEAN_TITLE, "");
      const normalizedTab = currentPlainTitle
        .toLowerCase()
        .replace(REGEX_CLEAN_TITLE, "");
      if (
        normalizedTab &&
        normalizedDom &&
        !normalizedTab.includes(normalizedDom) &&
        !normalizedDom.includes(normalizedTab)
      ) {
        return true;
      }
    }
    return false;
  }

  function scrapeShorts(url) {
    const match = url.match(REGEX_YT_SHORTS_ID);
    const expectedShortsId = match ? match[1] : null;

    let activeReel = document.querySelector("ytd-reel-video-renderer[is-active]");
    if (!activeReel) {
      activeReel = document.querySelector("ytd-reel-video-renderer");
    }

    const domVideoId =
      activeReel?.getAttribute("video-id") ||
      activeReel?.getAttribute("data-video-id");
    if (expectedShortsId && domVideoId && domVideoId !== expectedShortsId) {
      return [];
    }

    if (isShortsTitleStale(activeReel, currentPlainTitle)) {
      return [];
    }

    const el = activeReel?.querySelector("yt-reel-channel-bar-view-model .ytReelChannelBarViewModelChannelName a");
    const name = el?.textContent?.trim();
    return name ? [`channel:${name}`] : [];
  }

  function getChannelFromPlayer(v) {
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getVideoData === "function") {
        const videoData = player.getVideoData();
        if (videoData && videoData.video_id === v && videoData.author) {
          return [`channel:${videoData.author.trim()}`];
        }
      }
    } catch (e) {
      console.warn("[AW Extender] Failed to get channel from movie_player:", e);
    }
    return null;
  }

  function isDomTitleStale(currentPlainTitle) {
    const domTitleEl = document.querySelector("ytd-watch-metadata h1, #title h1, h1.ytd-video-primary-info-renderer");
    const domTitle = domTitleEl?.textContent?.trim();
    if (domTitle && currentPlainTitle) {
      const normalizedDom = domTitle
        .toLowerCase()
        .replace(REGEX_CLEAN_TITLE, "");
      const normalizedTab = currentPlainTitle
        .toLowerCase()
        .replace(REGEX_CLEAN_TITLE, "");
      if (
        normalizedTab &&
        normalizedDom &&
        !normalizedTab.includes(normalizedDom) &&
        !normalizedDom.includes(normalizedTab)
      ) {
        return true;
      }
    }
    return false;
  }

  function getChannelFromDomSelectors() {
    let channelName = null;

    const ownerEl = document.querySelector("ytd-video-owner-renderer ytd-channel-name a, ytd-watch-metadata #channel-name a, #owner-name a");
    if (ownerEl) {
      channelName = ownerEl.textContent?.trim();
    }

    if (!channelName) {
      const authorMeta = document.querySelector('span[itemprop="author"] meta[itemprop="name"], [itemprop="author"] [itemprop="name"]');
      if (authorMeta) {
        channelName = (
          authorMeta.getAttribute("content") || authorMeta.textContent
        )?.trim();
      }
    }

    if (!channelName) {
      const fallbackEl = document.querySelector("ytd-channel-name a");
      if (fallbackEl) {
        channelName = fallbackEl.textContent?.trim();
      }
    }

    return channelName ? [`channel:${channelName}`] : [];
  }

  function scrapeWatchPage(url) {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (!v) return [];

    // 1. Try internal player API first (fast and robust, synchronizes with the correct video ID)
    const playerChannel = getChannelFromPlayer(v);
    if (playerChannel) {
      return playerChannel;
    }

    // 2. Fallback to DOM elements, verifying video ID first
    const watchFlexy = document.querySelector("ytd-watch-flexy");
    const domVideoId = watchFlexy?.getAttribute("video-id");

    if (domVideoId && domVideoId !== v) {
      return [];
    }

    // 3. Verify that the DOM metadata matches the current tab title.
    if (isDomTitleStale(currentPlainTitle)) {
      return [];
    }

    return getChannelFromDomSelectors();
  }

  const SCRAPERS = [
    {
      name: "youtube",
      match: (host) => host === "www.youtube.com" || host === "youtube.com",
      shouldRun: (url) => REGEX_YT_WATCH.test(url) || REGEX_YT_SHORTS.test(url),

      scrape() {
        const url = window.location.href;
        const isShorts = REGEX_YT_SHORTS.test(url);
        return isShorts ? scrapeShorts(url) : scrapeWatchPage(url);
      },

      observe(onRefresh, onApply) {
        console.log("[AW:YT] observe() installed");

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
              console.log(`[AW:YT] Metadata stable after ${attempts} polls:`, scraped);
              onRefresh(scraped);
              onApply();
              return;
            }
          } else {
            stableCount = 0;
            lastResult = "";
          }

          if (attempts >= maxAttempts) {
            console.log(`[AW:YT] Stopped polling after ${maxAttempts} attempts`);
            if (scraped.length > 0) {
              onRefresh(scraped);
              onApply();
            }
            return;
          }

          timeoutId = setTimeout(poll, 200);
        };

        // Start polling asynchronously to let the initial URL change
        // set the title without metadata first.
        timeoutId = setTimeout(poll, 200);

        return () => {
          console.log("[AW:YT] observe() cleaned up/disconnected");
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        };
      },
    },
    {
      name: "gmail",
      match: (host) => host === "mail.google.com",
      shouldRun: (url) => REGEX_GMAIL_PATH.test(url),

      scrape() {
        const activeMessage = document.querySelector('[role="listitem"][aria-expanded="true"]');
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
      console.log("[AW] refreshMetadata: no active scraper → clearing metadata");
      currentMetadata = [];
      return;
    }

    try {
      const prev = JSON.stringify(currentMetadata);
      currentMetadata = explicitMetadata !== undefined ? explicitMetadata : (activeScraper.scrape() ?? []);

      if (JSON.stringify(currentMetadata) !== prev) {
        console.log(`[AW] refreshMetadata (${activeScraper.name}): ${prev} → ${JSON.stringify(currentMetadata)}`);
      }
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
      console.log("[AW] installActiveScraper: tearing down previous scraper");
      activeScraperCleanup();
      activeScraperCleanup = null;
    }

    activeScraper = getMatchingScraper();
    console.log("[AW] installActiveScraper: matched scraper →", activeScraper?.name ?? "(none)");

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
          () => {
            console.log("[AW] Metadata confirmed → applyEnrichedTitle()");
            applyEnrichedTitle();
          }
        );
      } catch (error) {
        console.error(`[AW Extender] Failed to initialize scraper "${activeScraper.name}":`, error);
      }
    }

    if (document.body) {
      setupObserver();
    } else {
      console.log("[AW] installActiveScraper: document.body is null, deferring observer until body appears");
      pendingBodyWatcher = new MutationObserver(() => {
        if (!document.body) {
          return;
        }
        pendingBodyWatcher.disconnect();
        pendingBodyWatcher = null;
        console.log("[AW] document.body appeared, installing deferred observer");
        setupObserver();
      });
      pendingBodyWatcher.observe(document.documentElement, { childList: true });
    }
  }

  function handleUrlChange() {
    const rawTitle = originalTitleGetter.call(document);
    currentPlainTitle = stripMetadata(rawTitle);
    installActiveScraper();
    applyEnrichedTitle();
  }

  Object.defineProperty(Document.prototype, "title", {
    configurable: titleDescriptor.configurable,
    enumerable: titleDescriptor.enumerable,
    get() {
      return stripMetadata(originalTitleGetter.call(document));
    },
    set(value) {
      const prev = currentPlainTitle;
      currentPlainTitle = stripMetadata(value);
      if (currentPlainTitle !== prev) {
        console.log("[AW] document.title set:", {
          raw: value,
          stripped: currentPlainTitle,
        });
        currentMetadata = [];
      }

      const currentUrl = window.location.href;
      if (currentUrl !== lastKnownUrl) {
        console.log(
          "[AW] URL change detected via title setter:",
          lastKnownUrl,
          "→",
          currentUrl
        );
        lastKnownUrl = currentUrl;
        installActiveScraper();
      }

      applyEnrichedTitle();
    },
  });

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

  function initializeHistoryHooks() {
    console.log("[AW] initializeHistoryHooks() called");
    if (typeof history === "undefined" || !history.pushState) return;

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      lastKnownUrl = window.location.href;
      console.log("[AW] history.pushState intercepted →", window.location.href);
      handleUrlChange();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      lastKnownUrl = window.location.href;
      console.log("[AW] history.replaceState intercepted →", window.location.href);
      handleUrlChange();
    };

    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
  }

  initializeDOMObservers();
  initializeHistoryHooks();
  console.log("[AW] Calling initial handleUrlChange(), document.body:", document.body);
  handleUrlChange();
})();