(() => {
  function dispatchToMainWorld(state) {
    const event = new CustomEvent("AW_STATE_UPDATE", { detail: state });
    window.dispatchEvent(event);
  }

  globalThis.chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "STATE_UPDATE" && message.state) {
      dispatchToMainWorld(message.state);
    }
  });

  globalThis.chrome.runtime
    .sendMessage({ type: "GET_TAB_STATE" })
    .then((response) => {
      if (response) {
        dispatchToMainWorld(response);
      }
    })
    .catch(() => {
      // Background workers can be unavailable during startup or unsupported schemes.
    });
})();
