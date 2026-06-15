(() => {
  const TITLE_METADATA_SEPARATOR = " ∼ ";

  const originalTitleDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "title");
  if (!originalTitleDescriptor) {
    console.error("[AW Extender] Could not find Document.prototype.title descriptor.");
    return;
  }

  const originalTitleGetter = originalTitleDescriptor.get;
  const originalTitleSetter = originalTitleDescriptor.set;

  // Placeholder for future site-specific metadata extractors
  function getSiteMetadata() {
    return [];
  }

  function applyEnrichedTitle(plainTitle) {
    const siteMetadata = getSiteMetadata();
    const enrichedTitle = [
        plainTitle,
        window.location.href,
        ...siteMetadata
    ].join(TITLE_METADATA_SEPARATOR) + TITLE_METADATA_SEPARATOR;

    try {
      originalTitleSetter.call(document, enrichedTitle);
    } catch (error) {
      console.error("[AW Extender] Failed to set enriched document title:", error);
    }
  }

  function stripEnrichedMetadata(title) {
    if (!title) {
      return "";
    }
    const separatorIndex = title.indexOf(TITLE_METADATA_SEPARATOR);
    return separatorIndex === -1 ? title : title.slice(0, separatorIndex);
  }

  // PROXY: Lie to the SPA
  Object.defineProperty(Document.prototype, "title", {
    configurable: originalTitleDescriptor.configurable,
    enumerable: originalTitleDescriptor.enumerable,
    get() {
      return stripEnrichedMetadata(originalTitleGetter.call(document));
    },
    set(value) {
      applyEnrichedTitle(stripEnrichedMetadata(value));
    },
  });

  // TITLE OBSERVER: Catch DOM text bypasses
  let titleMutationObserver = null;
  function observeTitleElement(titleElement) {
    if (titleMutationObserver) {
      titleMutationObserver.disconnect();
    }
    if (!titleElement) {
      return;
    }

    const currentText = titleElement.textContent;
    if (typeof currentText === "string" && !currentText.includes(TITLE_METADATA_SEPARATOR)) {
      applyEnrichedTitle(currentText);
    }

    titleMutationObserver = new MutationObserver(() => {
      const updatedText = titleElement.textContent;
      if (typeof updatedText === "string" && !updatedText.includes(TITLE_METADATA_SEPARATOR)) {
        applyEnrichedTitle(updatedText);
      }
    });

    titleMutationObserver.observe(titleElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  // HEAD OBSERVER: Catch node replacements
  function observeHead(headElement) {
    const existingTitle = headElement.querySelector("title");
    if (existingTitle) {
      observeTitleElement(existingTitle);
    }

    const headMutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const addedNode of mutation.addedNodes) {
          if (addedNode.nodeName === "TITLE") {
            observeTitleElement(addedNode);
          }
        }
      }
    });

    headMutationObserver.observe(headElement, { childList: true });
  }

  // INITIALIZATION: run_at document_start handling
  function initializeDOMObservers() {
    if (document.head) {
      observeHead(document.head);
    } else {
      const documentObserver = new MutationObserver((_, obs) => {
        if (document.head) {
          observeHead(document.head);
          obs.disconnect();
        }
      });
      documentObserver.observe(document.documentElement, { childList: true });
    }
  }

  // HISTORY HOOKS: Catch URL changes
  function initializeHistoryHooks() {
    if (typeof history === "undefined" || !history.pushState) {
      return;
    }
    
    function handleUrlChange() {
        applyEnrichedTitle(
            stripEnrichedMetadata(originalTitleGetter.call(document))
        );
    }

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
})();
