(() => {
  const TITLE_METADATA_SEPARATOR = " ∼ ";

  const originalTitleDescriptor = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "title"
  );

  if (!originalTitleDescriptor) {
    console.error(
      "[AW Extender] Could not find Document.prototype.title descriptor."
    );
    return;
  }

  const originalTitleGetter = originalTitleDescriptor.get;
  const originalTitleSetter = originalTitleDescriptor.set;

  // Helper to remove any existing enriched metadata from a title string
  function stripEnrichedMetadata(title) {
    if (!title) {
      return "";
    }
    const separatorIndex = title.indexOf(TITLE_METADATA_SEPARATOR);
    return separatorIndex === -1 ? title : title.slice(0, separatorIndex);
  }

  // Store the plain title locally so page scripts only interact with this clean value
  let currentPlainTitle = stripEnrichedMetadata(
    originalTitleGetter.call(document)
  );

  // Placeholder for future site-specific metadata extractors
  function getSiteMetadata() {
    return [];
  }

  // Updates the actual DOM title using the original descriptor setter
  function updateEnrichedTitle() {
    const siteMetadata = getSiteMetadata();
    const enrichedTitle =
      [currentPlainTitle, window.location.href, ...siteMetadata].join(
        TITLE_METADATA_SEPARATOR
      ) + TITLE_METADATA_SEPARATOR;

    try {
      originalTitleSetter.call(document, enrichedTitle);
    } catch (error) {
      console.error(
        "[AW Extender] Failed to set enriched document title:",
        error
      );
    }
  }

  // Intercept reads and writes to document.title so SPA scripts only see the plain title
  Object.defineProperty(Document.prototype, "title", {
    configurable: originalTitleDescriptor.configurable,
    enumerable: originalTitleDescriptor.enumerable,
    get() {
      return currentPlainTitle;
    },
    set(value) {
      currentPlainTitle = stripEnrichedMetadata(value);
      updateEnrichedTitle();
    },
  });

  let titleMutationObserver = null;

  // Watch the <title> tag text content for changes bypassing the document.title setter
  function observeTitleElement(titleElement) {
    if (titleMutationObserver) {
      titleMutationObserver.disconnect();
    }
    if (!titleElement) {
      return;
    }

    const currentText = titleElement.textContent;
    if (!currentText.includes(TITLE_METADATA_SEPARATOR)) {
      currentPlainTitle = currentText;
      updateEnrichedTitle();
    }

    titleMutationObserver = new MutationObserver(() => {
      const updatedText = titleElement.textContent;
      // Prevent infinite loops by ensuring we only handle plain updates
      if (!updatedText.includes(TITLE_METADATA_SEPARATOR)) {
        currentPlainTitle = updatedText;
        updateEnrichedTitle();
      }
    });

    titleMutationObserver.observe(titleElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  // Set up observers for the title element and the document <head>
  function initializeObservers() {
    const titleElement = document.querySelector("title");
    observeTitleElement(titleElement);

    if (document.head) {
      const headMutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const addedNode of mutation.addedNodes) {
            if (addedNode.nodeName === "TITLE") {
              observeTitleElement(addedNode);
            }
          }
        }
      });
      headMutationObserver.observe(document.head, { childList: true });
    }
  }

  // Hook into SPA history transitions to update the URL in the enriched title
  function initializeHistoryHooks() {
    if (typeof history === "undefined" || !history.pushState) {
      return;
    }

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      handleUrlChange();
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      handleUrlChange();
    };

    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
  }

  let lastObservedUrl = window.location.href;
  function handleUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastObservedUrl) {
      lastObservedUrl = currentUrl;
      updateEnrichedTitle();
    }
  }

  function start() {
    if (document.head) {
      initializeObservers();
    } else {
      const documentObserver = new MutationObserver(() => {
        if (document.head) {
          initializeObservers();
          documentObserver.disconnect();
        }
      });
      documentObserver.observe(document.documentElement, { childList: true });
    }
    initializeHistoryHooks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
