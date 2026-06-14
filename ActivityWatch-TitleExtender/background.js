globalThis.chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
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
    globalThis.chrome.tabs
      .sendMessage(tabId, { type: "STATE_UPDATE", state: stateUpdate })
      .catch(() => {
        // Content scripts are not available on every tab or scheme.
      });
  }
});

globalThis.chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message.type === "GET_TAB_STATE") {
      const tabId = sender.tab?.id ?? null;
      if (tabId !== null) {
        globalThis.chrome.tabs
          .get(tabId)
          .then((tab) =>
            sendResponse({
              audible: tab.audible,
              muted: tab.mutedInfo?.muted,
            })
          )
          .catch(() => sendResponse({ audible: false, muted: false }));
        return true;
      }
      sendResponse({ audible: false, muted: false });
      return;
    }
  }
);
