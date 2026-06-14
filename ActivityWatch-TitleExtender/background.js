// Background Service Worker for ActivityWatch Title Extender

// Listen for updates to tabs (e.g. audible state changes, mute/unmute)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
    // Send the state update to the tab's content script
    chrome.tabs.sendMessage(tabId, {
      type: "STATE_UPDATE",
      state: stateUpdate
    }).catch(() => {
      // Catch errors silently if content script is not yet injected or active
    });
  }
});

// Handle initial state query from content script when page loads
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_TAB_STATE") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId !== null) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          sendResponse({ audible: false, muted: false });
          return;
        }
        sendResponse({
          audible: tab.audible || false,
          muted: (tab.mutedInfo && tab.mutedInfo.muted) || false
        });
      });
      return true; // Keep message channel open for async response
    }
  }
});
