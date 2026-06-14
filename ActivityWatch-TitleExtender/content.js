(function () {
  "use strict";

  const SEP = " ||| ";
  let currentExtraInfo = "";
  let isUpdating = false;
  let pollId = null;

  const titleDesc = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "title",
  );
  const rawGet = titleDesc.get;
  const rawSet = titleDesc.set;

  Object.defineProperty(document, "title", {
    get() {
      return rawGet.call(this);
    },
    set(value) {
      if (isUpdating) {
        rawSet.call(this, value);
        return;
      }

      let base = value.includes(SEP) ? value.split(SEP)[0] : value;
      let formatted = `${base}${SEP}${window.location.href}`;
      if (currentExtraInfo) formatted += `${SEP}${currentExtraInfo}`;
      formatted += SEP;

      isUpdating = true;
      rawSet.call(this, formatted);
      isUpdating = false;

      waitForExtraInfo();
    },
  });

  function getExtraInfo() {
    const host = window.location.hostname;

    if (host.includes("youtube.com")) {
      const el = document.querySelector(
        "ytd-video-owner-renderer #channel-name a, #owner-name a, #upload-info .ytd-channel-name a",
      );
      return el ? `channel: ${el.innerText.trim()}` : "";
    }

    if (host.includes("mail.google.com")) {
      const el = document.querySelector(".gD");
      return el
        ? `sender: ${el.getAttribute("email") || el.innerText.trim()}`
        : "";
    }

    return "";
  }

  function tryLoadExtraInfo() {
    const info = getExtraInfo();
    const currentTitle = rawGet.call(document);
    const hasSeparator = currentTitle.includes(SEP);

    if (info === currentExtraInfo && hasSeparator) return false;

    currentExtraInfo = info;
    const base = currentTitle.includes(SEP)
      ? currentTitle.split(SEP)[0]
      : currentTitle;

    let formatted = `${base}${SEP}${window.location.href}`;
    if (currentExtraInfo) formatted += `${SEP}${currentExtraInfo}`;
    formatted += SEP;

    rawSet.call(document, formatted);

    return info !== "";
  }

  function waitForExtraInfo() {
    if (pollId) clearInterval(pollId);
    if (tryLoadExtraInfo()) return;

    let attempts = 0;
    const MAX = 20;

    pollId = setInterval(() => {
      attempts++;
      if (tryLoadExtraInfo() || attempts >= MAX) {
        clearInterval(pollId);
        pollId = null;
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForExtraInfo);
  } else {
    waitForExtraInfo();
  }
})();
