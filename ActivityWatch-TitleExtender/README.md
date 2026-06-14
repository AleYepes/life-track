# ActivityWatch Title Extender

A lightweight Manifest V3 Chromium extension that enriches browser tab titles with rich metadata (URLs, audio states, YouTube channel names/IDs, Gmail senders) so that generic operating system window-trackers (like ActivityWatch, RescueTime, or WakaTime) can capture browser context indirectly.

## Key Features
- **Zero-Clutter UI**: Overrides the `document.title` getter so web apps see their clean raw title (preventing SPA breakage), while the browser/OS sees the metadata.
- **Smarter Extraction**: Directly accesses YouTube's page-level global player variables (`ytInitialPlayerResponse`) for resilient and fast data fetching.
- **Low Footprint Delimiter**: Appends metadata using the obscure Left Ceiling symbol ` ⌈ ` (`\u2308`) for conflict-free, database-efficient downstream parsing.
- **Native Audibility & Mute Detection**: Leverages background service worker events (`chrome.tabs.onUpdated`) to log audio activity instantly.
