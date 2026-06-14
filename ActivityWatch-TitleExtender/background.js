// Background Service Worker for ActivityWatch Title Extender

// Listen for tab updates (audible state changes, mute/unmute)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const stateUpdate = {};
  let hasUpdate = false;

  if (changeInfo.audible !== undefined) {
    stateUpdate.audible = changeInfo.audible;
    hasUpdate = true;
  }
  if (changeInfo.mutedInfo !== undefined) {
    stateUpdate.muted = changeInfo.mutedInfo.muted;
    hasUpdate = true;
  }

  if (hasUpdate) {
    chrome.tabs.sendMessage(tabId, { type: "STATE_UPDATE", state: stateUpdate })
      .catch(() => {}); // Ignore: content script may not be active yet
  }
});

// Handle initial state query from content script on page load
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_TAB_STATE") {
    const tabId = sender.tab?.id ?? null;
    if (tabId !== null) {
      // Promise-based API (MV3); return true keeps channel open for async response
      chrome.tabs.get(tabId)
        .then(tab => sendResponse({
          audible: tab.audible || false,
          muted: tab.mutedInfo?.muted || false,
        }))
        .catch(() => sendResponse({ audible: false, muted: false }));
      return true;
    }
    // [B1] Always call sendResponse — even when tabId is unavailable
    sendResponse({ audible: false, muted: false });
  }
});
