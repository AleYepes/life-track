// Main-World Content Script (Executes in the page context)
(function () {
  "use strict";

  const SEP = " ||| ";
  let rawTitle = "";
  let isUpdating = false;
  let pollInterval = null;

  const tabState = {
    audible: false,
    muted: false
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

  // Initialize rawTitle from the current document title
  rawTitle = stripMetadata(rawGet.call(document));

  Object.defineProperty(Document.prototype, "title", {
    get() {
      return rawTitle;
    },
    set(value) {
      if (isUpdating) {
        rawSet.call(this, value);
        return;
      }
      
      const newRaw = stripMetadata(value);
      // Only trigger updates if the raw title content has actually changed
      if (newRaw !== rawTitle) {
        rawTitle = newRaw;
        updateTitle();
        startMetadataPolling();
      }
    }
  });

  // 2. Extensible Site Scraper Registry
  const SCRAPERS = [
    {
      name: "youtube",
      match: (host) => host.includes("youtube.com"),
      scrape: () => {
        const metadata = [];
        
        // Channel name selector matching various YouTube page structures
        const channelEl = document.querySelector(
          "ytd-video-owner-renderer #channel-name a, #owner-name a, #upload-info .ytd-channel-name a"
        );
        if (channelEl) {
          const channelName = channelEl.innerText.trim();
          if (channelName) {
            metadata.push(`channel: ${channelName}`);
          }
        }
        
        // Video ID from search queries
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get("v");
        if (videoId) {
          metadata.push(`video_id: ${videoId}`);
        }
        
        return metadata;
      }
    },
    {
      name: "gmail",
      match: (host) => host.includes("mail.google.com"),
      scrape: () => {
        const metadata = [];
        
        // Sender element selector in Gmail conversation view
        const senderEl = document.querySelector(".gD");
        if (senderEl) {
          const sender = senderEl.getAttribute("email") || senderEl.innerText.trim();
          if (sender) {
            metadata.push(`sender: ${sender}`);
          }
        }
        return metadata;
      }
    }
  ];

  function getSiteMetadata() {
    const host = window.location.hostname;
    const scraper = SCRAPERS.find(s => s.match(host));
    if (scraper) {
      try {
        return scraper.scrape();
      } catch (e) {
        console.error(`[AW Extender] Scraper error on ${scraper.name}:`, e);
      }
    }
    return [];
  }

  // 3. Format and update the tab title
  function updateTitle() {
    if (isUpdating) return;

    const currentTitle = rawTitle || "";
    const url = window.location.href;
    const siteMetadata = getSiteMetadata();

    // Combine site-specific metadata and generic tab states
    const metadata = [...siteMetadata];
    if (tabState.audible) {
      metadata.push("audible: true");
    }
    if (tabState.muted) {
      metadata.push("muted: true");
    }

    // Assemble components: Title ||| URL ||| key1: value1 ||| ... |||
    let parts = [currentTitle, url];
    if (metadata.length > 0) {
      parts = parts.concat(metadata);
    }
    const formatted = parts.join(SEP) + SEP;

    isUpdating = true;
    try {
      rawSet.call(document, formatted);
    } catch (e) {
      console.error("[AW Extender] Failed to set document title:", e);
    } finally {
      isUpdating = false;
    }
  }

  // 4. Poll for metadata when elements load asynchronously
  function startMetadataPolling() {
    if (pollInterval) clearInterval(pollInterval);

    let attempts = 0;
    const maxAttempts = 15; // 15 attempts * 400ms = 6s max
    let lastMetadataStr = "";

    pollInterval = setInterval(() => {
      attempts++;

      const siteMetadata = getSiteMetadata();
      const metadataStr = siteMetadata.join(",");

      // If async loading resolves new metadata values, trigger a title update
      if (metadataStr !== lastMetadataStr) {
        lastMetadataStr = metadataStr;
        updateTitle();
      }

      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 400);
  }

  // 5. Hook history pushState/replaceState to detect SPA URL transitions
  function hookHistory() {
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
      updateTitle();
      startMetadataPolling();
    }
  }

  // 6. MutationObserver to capture initial HTML-parsed <title> elements and DOM overrides
  function initMutationObserver() {
    const titleEl = document.querySelector("title");
    if (titleEl) {
      rawTitle = stripMetadata(titleEl.textContent);
      updateTitle();
    }

    const observer = new MutationObserver((mutations) => {
      let titleChanged = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const addedNode of mutation.addedNodes) {
            if (addedNode.nodeName === "TITLE") {
              titleChanged = true;
              break;
            }
          }
        }
        if (
          mutation.type === "characterData" &&
          mutation.target.parentNode &&
          mutation.target.parentNode.nodeName === "TITLE"
        ) {
          titleChanged = true;
        }
        if (titleChanged) break;
      }

      if (titleChanged) {
        const el = document.querySelector("title");
        if (el) {
          const content = el.textContent;
          // Ignore mutations we triggered ourselves (containing SEP)
          if (!content.includes(SEP)) {
            rawTitle = content;
            updateTitle();
            startMetadataPolling();
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
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

    if (changed) {
      updateTitle();
    }
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
