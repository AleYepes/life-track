const YOUTUBE_PATH_VIDEO_ID_RE = /^\/(?:shorts|live|embed)\/([^/?#]+)/;

(() => {
  const SEP = "⌈";
  let rawTitle = "";
  let pollInterval = null;
  let lastFormattedTitle = "";

  const tabState = {
    audible: false,
    muted: false,
  };

  function stripMetadata(title) {
    if (!title) {
      return "";
    }
    const sepIndex = title.indexOf(SEP);
    return sepIndex === -1 ? title : title.slice(0, sepIndex);
  }

  const titleDesc = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "title"
  );
  if (!titleDesc) {
    console.error(
      "[AW Extender] Could not find Document.prototype.title descriptor."
    );
    return;
  }
  const rawGet = titleDesc.get;
  const rawSet = titleDesc.set;

  rawTitle = stripMetadata(rawGet.call(document));

  // Page scripts keep seeing the clean title while Chromium exposes the enriched title.
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

  const SCRAPERS = [
    {
      name: "youtube",
      match: (host) => host === "youtube.com" || host.endsWith(".youtube.com"),
      scrape() {
        const metadata = [];
        let channelName = "";
        const paramsVideoId = new URLSearchParams(window.location.search).get(
          "v"
        );
        const pathVideoId = window.location.pathname.match(
          YOUTUBE_PATH_VIDEO_ID_RE
        )?.[1];
        const urlVideoId = paramsVideoId || pathVideoId || "";
        let videoId = urlVideoId;

        const playerResponse = window.ytInitialPlayerResponse;
        const playerVideoId = playerResponse?.videoDetails?.videoId || "";
        const domVideoId = document
          .querySelector("ytd-watch-flexy")
          ?.getAttribute("video-id");

        if (
          urlVideoId &&
          playerResponse?.videoDetails &&
          playerVideoId === urlVideoId
        ) {
          channelName = playerResponse.videoDetails.author || "";
          videoId = playerVideoId;
        }

        if (!channelName && (!urlVideoId || domVideoId === urlVideoId)) {
          const channelEl = document.querySelector(
            "ytd-video-owner-renderer #channel-name a, #owner-name a, #upload-info .ytd-channel-name a"
          );
          if (channelEl) {
            channelName = channelEl.innerText.trim();
          }
        }

        if (channelName) {
          metadata.push(`channel: ${channelName}`);
        }
        if (videoId) {
          metadata.push(`video_id: ${videoId}`);
        }

        const complete =
          !urlVideoId ||
          Boolean(
            channelName &&
              videoId &&
              (domVideoId === urlVideoId || playerVideoId === urlVideoId)
          );

        return { metadata, complete };
      },
    },
    {
      name: "gmail",
      match: (host) => host === "mail.google.com",
      scrape() {
        const metadata = [];
        const senderEls = Array.from(
          document.querySelectorAll(".adn.ads .gD[email], .gD[email], .gD")
        );
        const senderEl = senderEls.find((el) => el.getClientRects().length > 0);

        if (senderEl) {
          const sender =
            senderEl.getAttribute("email") || senderEl.innerText.trim();
          if (sender) {
            metadata.push(`sender: ${sender}`);
          }
        }

        return { metadata, complete: false };
      },
    },
  ];

  let _activeScraper = null;

  function getActiveScraper() {
    if (_activeScraper === null) {
      _activeScraper =
        SCRAPERS.find((s) => s.match(window.location.hostname)) ?? undefined;
    }
    return _activeScraper;
  }

  function scrapeSiteMetadata() {
    const scraper = getActiveScraper();
    if (scraper) {
      try {
        return scraper.scrape();
      } catch (e) {
        console.error(`[AW Extender] Scraper error on ${scraper.name}:`, e);
      }
    }
    return { metadata: [], complete: true };
  }

  let isUpdatingTitle = false;

  function updateTitle(siteMetadata) {
    const metadata = [...(siteMetadata ?? scrapeSiteMetadata().metadata)];
    if (tabState.audible) {
      metadata.push("audible: true");
    }
    if (tabState.muted) {
      metadata.push("muted: true");
    }

    const formatted =
      [rawTitle || "", window.location.href, ...metadata].join(SEP) + SEP;
    if (formatted === lastFormattedTitle) {
      return;
    }

    try {
      isUpdatingTitle = true;
      rawSet.call(document, formatted);
      lastFormattedTitle = formatted;
    } catch (e) {
      console.error("[AW Extender] Failed to set document title:", e);
    } finally {
      setTimeout(() => {
        isUpdatingTitle = false;
      }, 0);
    }
  }

  function startMetadataPolling(forceFirstUpdate = false) {
    if (pollInterval) {
      clearInterval(pollInterval);
    }

    const scraper = getActiveScraper();
    if (!scraper) {
      pollInterval = null;
      return;
    }

    let attempts = 0;
    const maxAttempts = 15;
    let lastMetadataStr = forceFirstUpdate
      ? null
      : scrapeSiteMetadata().metadata.join(",");

    pollInterval = setInterval(() => {
      attempts++;

      const result = scrapeSiteMetadata();
      const metadataStr = result.metadata.join(",");

      if (metadataStr !== lastMetadataStr) {
        lastMetadataStr = metadataStr;
        updateTitle(result.metadata);
      }

      if (result.complete || attempts >= maxAttempts) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 400);
  }

  function hookHistory() {
    if (typeof history === "undefined" || !history.pushState) {
      return;
    }

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
      _activeScraper = null;
      updateTitle([]);
      startMetadataPolling(true);
    }
  }

  function initMutationObserver() {
    let titleObserver = null;
    let headObserver = null;

    function handleTitleChange(el) {
      if (!el || isUpdatingTitle) {
        return;
      }
      const content = el.textContent;
      if (!content.includes(SEP)) {
        rawTitle = content;
        updateTitle();
        startMetadataPolling();
      }
    }

    function observeTitleEl(el) {
      if (titleObserver) {
        titleObserver.disconnect();
      }
      if (!el) {
        return;
      }

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

    function findAddedTitleElement(mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === "TITLE") {
            return node;
          }
        }
      }
      return null;
    }

    function observeHead() {
      if (!document.head || headObserver) {
        return;
      }

      observeTitleEl(document.querySelector("title"));

      headObserver = new MutationObserver((mutations) => {
        const newTitleEl = findAddedTitleElement(mutations);
        if (newTitleEl) {
          observeTitleEl(newTitleEl);
        }
      });

      headObserver.observe(document.head, { childList: true });
    }

    observeHead();

    if (!headObserver) {
      const rootObserver = new MutationObserver(() => {
        observeHead();
        if (headObserver) {
          rootObserver.disconnect();
        }
      });

      rootObserver.observe(document.documentElement, { childList: true });
    }
  }

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

    if (changed) {
      updateTitle();
    }
  });

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
