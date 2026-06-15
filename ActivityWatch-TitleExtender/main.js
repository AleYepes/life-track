(() => {
  const TITLE_METADATA_SEPARATOR = " ∼ ";

  const titleDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "title");
  if (!titleDescriptor?.get || !titleDescriptor?.set) {
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

  function debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), delay);
    };
  }

  function stripMetadata(title) {
    if (!title) return "";
    const separatorIndex = title.indexOf(TITLE_METADATA_SEPARATOR);
    return separatorIndex === -1 ? title : title.slice(0, separatorIndex);
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

  const SCRAPERS = [
    {
      name: "gmail",
      match: (host) => host === "mail.google.com",
      shouldRun: (url) => /#(?:inbox|all|sent|drafts|starred|important|label)\//.test(url),

      scrape() {
        const activeMessage = document.querySelector('[role="listitem"][aria-expanded="true"]');
        if (!activeMessage) return [];

        const senderElement = activeMessage.querySelector(".gD[email]");
        const email = senderElement?.getAttribute("email");
        return email ? [`sender:${email}`] : [];
      },

      observe(onRelevantChange) {
        const target = document.querySelector('div[role="main"]') || document.body;
        
        const debouncedCallback = debounce(() => {
          onRelevantChange();
        }, 150);

        const observer = new MutationObserver(debouncedCallback);
        observer.observe(target, {
          childList: true,
          subtree: true,
        });

        return () => observer.disconnect();
      }
    }
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

  function refreshMetadata() {
    if (!activeScraper) {
      currentMetadata = [];
      return;
    }
    try {
      currentMetadata = activeScraper.scrape() ?? [];
    } catch (error) {
      console.error(`[AW Extender] Scraper "${activeScraper.name}" failed:`, error);
      currentMetadata = [];
    }
  }

  function installActiveScraper() {
    if (activeScraperCleanup) {
      activeScraperCleanup();
      activeScraperCleanup = null;
    }

    activeScraper = getMatchingScraper();
    refreshMetadata();

    if (!activeScraper?.observe) return;

    try {
      activeScraperCleanup = activeScraper.observe(() => {
        const previousMetadata = JSON.stringify(currentMetadata);
        refreshMetadata();

        if (JSON.stringify(currentMetadata) !== previousMetadata) {
          applyEnrichedTitle();
        }
      });
    } catch (error) {
      console.error(`[AW Extender] Failed to initialize scraper "${activeScraper.name}":`, error);
    }
  }

  function handleUrlChange() {
    currentPlainTitle = stripMetadata(originalTitleGetter.call(document));
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
      currentPlainTitle = stripMetadata(value);
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
      currentPlainTitle = text;
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
    if (typeof history === "undefined" || !history.pushState) return;

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      handleUrlChange();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      handleUrlChange();
    };

    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
  }

  initializeDOMObservers();
  initializeHistoryHooks();
  handleUrlChange();
})();