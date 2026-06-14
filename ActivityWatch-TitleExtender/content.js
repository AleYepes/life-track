// Isolated-World Content Script (Bridge)
(function () {
  "use strict";

  // Helper to forward state updates to the main-world script via a custom DOM event
  function dispatchToMainWorld(state) {
    const event = new CustomEvent("AW_STATE_UPDATE", { detail: state });
    window.dispatchEvent(event);
  }

  // 1. Listen for background events (e.g. audible/muted changes) and relay them
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "STATE_UPDATE" && message.state) {
      dispatchToMainWorld(message.state);
    }
  });

  // 2. Query the background script for the initial tab state on startup
  chrome.runtime.sendMessage({ type: "GET_TAB_STATE" })
    .then((response) => {
      if (response) {
        dispatchToMainWorld(response);
      }
    })
    .catch(() => {
      // Background worker might not be ready or we are on an unsupported scheme
    });
})();
