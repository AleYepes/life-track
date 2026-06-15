const AT_PREFIX = /^@/;

(() => {
  const SEP = " ∼ ";
  const ACTIVE_SCRAPER_UNSET = Symbol("active-scraper-unset");
  let rawTitle = "";
  let pollInterval = null;
  let lastFormattedTitle = "";

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
        const metadata = updateTitle();
        startMetadataPolling({ initialMetadata: metadata });
      }
    },
  });

  function ytVideoIdFromUrl(value) {
    if (!value || typeof value !== "string") {
      return "";
    }

    try {
      const url = new URL(value, window.location.origin);
      const fromSearch = url.searchParams.get("v");
      if (fromSearch) {
        return fromSearch;
      }

      const pathMatch = url.pathname.match(
        /^\/(?:shorts|embed|live)\/([^/?#]+)/
      );
      if (pathMatch) {
        return pathMatch[1];
      }

      if (url.hostname === "youtu.be") {
        return url.pathname.replace(/^\/+/, "").split("/")[0];
      }
    } catch {
      const match = value.match(
        /(?:[?&]v=|\/(?:shorts|embed|live)\/)([A-Za-z0-9_-]+)/
      );
      return match?.[1] || "";
    }

    return "";
  }

  function ytCurrentVideoId() {
    return ytVideoIdFromUrl(window.location.href);
  }

  function ytLdJsonMatchesCurrentVideo(item, currentVideoId) {
    if (!currentVideoId) {
      return true;
    }

    const candidates = [
      item.videoId,
      item.identifier,
      item.url,
      item.embedUrl,
      item.contentUrl,
      item["@id"],
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string") {
        if (
          candidate === currentVideoId ||
          ytVideoIdFromUrl(candidate) === currentVideoId
        ) {
          return true;
        }
      } else if (candidate?.value === currentVideoId) {
        return true;
      }
    }

    return false;
  }

  function ytRenderedVideoId() {
    const renderedVideo = document.querySelector(
      "ytd-watch-flexy[video-id], #movie_player[data-video-id]"
    );
    return (
      renderedVideo?.getAttribute("video-id") ||
      renderedVideo?.getAttribute("data-video-id") ||
      ""
    );
  }

  function ytRenderedPageMatchesCurrentVideo(currentVideoId) {
    const renderedVideoId = ytRenderedVideoId();
    return (
      !(currentVideoId && renderedVideoId) || renderedVideoId === currentVideoId
    );
  }

  function channelFromLdJsonData(data, currentVideoId) {
    let items;
    if (Array.isArray(data)) {
      items = data;
    } else if (data["@graph"]) {
      items = [].concat(data["@graph"]);
    } else {
      items = [data];
    }
    for (const item of items) {
      if (
        !item ||
        item["@type"] !== "VideoObject" ||
        !item.author ||
        !ytLdJsonMatchesCurrentVideo(item, currentVideoId)
      ) {
        continue;
      }
      const name =
        typeof item.author === "string" ? item.author : item.author?.name;
      if (name) {
        return name;
      }
    }
    return null;
  }

  function ytChannelFromLdJson(currentVideoId) {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of scripts) {
      try {
        const name = channelFromLdJsonData(
          JSON.parse(script.textContent),
          currentVideoId
        );
        if (name) {
          return name;
        }
      } catch {
        // malformed script tag — skip
      }
    }
    return null;
  }

  const SCRAPERS = [
    {
      name: "youtube",
      match: (host) => host === "youtube.com" || host.endsWith(".youtube.com"),
      scrape() {
        const currentVideoId = ytCurrentVideoId();
        const ldName = ytChannelFromLdJson(currentVideoId);
        if (ldName) {
          return { metadata: [`channel: ${ldName}`], complete: true };
        }

        if (!ytRenderedPageMatchesCurrentVideo(currentVideoId)) {
          return { metadata: [], complete: false };
        }

        const shortsAnchor = document.querySelector(
          "span.ytReelChannelBarViewModelChannelName a"
        );
        if (shortsAnchor) {
          const shortsTitleEl = document.querySelector(
            "yt-shorts-video-title-view-model"
          );
          const domShortTitle = shortsTitleEl?.textContent?.trim() || "";
          if (!(domShortTitle && rawTitle.startsWith(domShortTitle))) {
            return { metadata: [], complete: false };
          }

          const handle = shortsAnchor.textContent.trim().replace(AT_PREFIX, "");
          return {
            metadata: handle ? [`channel: ${handle}`] : [],
            complete: Boolean(handle),
          };
        }

        const channelName =
          document
            .querySelector('span[itemprop="author"] link[itemprop="name"]')
            ?.getAttribute("content") ||
          document
            .querySelector(
              "ytd-video-owner-renderer #channel-name a, #owner-name a"
            )
            ?.innerText.trim() ||
          "";
        return {
          metadata: channelName ? [`channel: ${channelName}`] : [],
          complete: Boolean(channelName),
        };
      },
    },
    {
      name: "gmail",
      match: (host) => host === "mail.google.com",
      scrape() {
        const metadata = [];
        const openMessage = document.querySelector(
          '[role="listitem"][aria-expanded="true"]'
        );

        if (openMessage) {
          const senderEl = openMessage.querySelector(
            "[jid], [data-hovercard-id]"
          );
          if (senderEl) {
            const sender =
              senderEl.getAttribute("jid") ||
              senderEl.getAttribute("data-hovercard-id");
            if (sender) {
              metadata.push(`sender: ${sender}`);
            }
          }
        }

        return { metadata, complete: Boolean(metadata.length > 0) };
      },
    },
  ];

  let _activeScraper = ACTIVE_SCRAPER_UNSET;

  function getActiveScraper() {
    if (_activeScraper === ACTIVE_SCRAPER_UNSET) {
      _activeScraper = SCRAPERS.find((s) => s.match(window.location.hostname));
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

  function updateTitle(siteMetadata) {
    const metadata = siteMetadata ?? scrapeSiteMetadata().metadata;

    const formatted =
      [rawTitle, window.location.href, ...metadata].join(SEP) + SEP;
    if (formatted === lastFormattedTitle) {
      return metadata;
    }

    try {
      rawSet.call(document, formatted);
      lastFormattedTitle = formatted;
    } catch (e) {
      console.error("[AW Extender] Failed to set document title:", e);
    }

    return metadata;
  }

  function startMetadataPolling({
    forceFirstUpdate = false,
    initialMetadata,
  } = {}) {
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
      : (initialMetadata ?? scrapeSiteMetadata().metadata).join(",");

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
      _activeScraper = ACTIVE_SCRAPER_UNSET;
      updateTitle([]);
      startMetadataPolling({ forceFirstUpdate: true });
    }
  }

  function initMutationObserver() {
    let titleObserver = null;
    let headObserver = null;

    function handleTitleChange(el) {
      if (!el) {
        return;
      }
      const content = el.textContent;
      if (!content.includes(SEP)) {
        rawTitle = content;
        const metadata = updateTitle();
        startMetadataPolling({ initialMetadata: metadata });
      }
    }

    function observeTitleEl(el) {
      if (titleObserver) {
        titleObserver.disconnect();
      }
      if (!el) {
        return false;
      }

      rawTitle = stripMetadata(el.textContent);
      const metadata = updateTitle();
      startMetadataPolling({ initialMetadata: metadata });

      titleObserver = new MutationObserver(() => {
        handleTitleChange(el);
      });

      titleObserver.observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });

      return true;
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
        return false;
      }

      const titleObserved = observeTitleEl(document.querySelector("title"));

      headObserver = new MutationObserver((mutations) => {
        const newTitleEl = findAddedTitleElement(mutations);
        if (newTitleEl) {
          observeTitleEl(newTitleEl);
        }
      });

      headObserver.observe(document.head, { childList: true });
      return titleObserved;
    }

    const titleObserved = observeHead();

    if (!headObserver) {
      const rootObserver = new MutationObserver(() => {
        observeHead();
        if (headObserver) {
          rootObserver.disconnect();
        }
      });

      rootObserver.observe(document.documentElement, { childList: true });
    }

    return titleObserved;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (!initMutationObserver()) {
        startMetadataPolling();
      }
    });
  } else if (!initMutationObserver()) {
    startMetadataPolling();
  }

  hookHistory();
})();
