# SideSites v1.0

**SideSites** is a browser extension for Chrome and Chromium-based browsers that loads any web site you choose into the
browser's native side panel, including sites that normally refuse to be shown in a frame.

## Features

- **Any site in the side panel**: Click the SideSites toolbar icon (or press **`Alt+Shift+S`**) to get a menu of your sites.
  Choosing one opens the side panel if it isn't already open and loads that site in it.
- **Configurable site list**: The settings page lets you add, edit, remove, and rearrange sites (drag and drop, arrow buttons,
  or **`Alt+↑`/`Alt+↓`**). Each site has a title and a URL. The list syncs across your devices with your browser profile.
- **Desktop or mobile version**: Each site has a **Desktop**/**Mobile** toggle. **Mobile** makes the site see your browser as
  Chrome on an Android phone (in the `User-Agent` and client-hint headers, and in `navigator.userAgent` and friends), which
  often gets you a layout better suited to the narrow side panel. If the site is already open in the side panel, it reloads
  in the new mode.
- **Fit to sidebar width**: Each site has a **Fit** checkbox. When checked, if a site's minimum layout width is wider than the
  side panel, SideSites scales the frame down to fit and smoothly scales it back up toward 100% as you widen the side panel
  (remembering the discovered width across reloads).
- **Sidebar toolbar in the menu**: The top bar of the SideSites menu includes quick controls for the active side panel site:
  - **Desktop / Mobile** toggle (switches the current site between Desktop and Mobile mode and reloads it).
  - **Fit** toggle (toggles zoom-to-fit on the current site immediately without reloading).
  - **Back**, **Forward**, and **Reload** buttons to navigate the sidebar's history or reload the current page in place (without resetting to the site's starting URL).
- **One-click popular sites**: The settings page includes categorized buttons (Chat, Music, AI assistants, Productivity,
  Reference, Social, Shopping) to add popular sites with sensible defaults.
- **Keyboard friendly**: In the menu, press **`1`**–**`9`** to open the corresponding site, or use the arrow keys and **`Enter`**.
- **Manage sites…**: Located directly below your saved sites list to open the settings page.
- **Open any URL**: Below **Manage sites…**, a **More** disclosure triangle (which remembers whether you left it open) reveals:
  - **Open side site in a new tab**: opens the page the sidebar is currently showing in a regular tab.
  - **Open current tab as side site**: shows the current tab's page in the sidebar.
  - A URL field (which fills in the current tab's address when you click into it), a Desktop/Mobile selector, a **Fit**
    checkbox, and an **Add to extension menu** checkbox that reveals a name field. Press **Go** (or **`Enter`**) to open the
    URL in the sidebar.
- **Per-window**: Each browser window's side panel can show a different site.
- **Remembers your last site**: When a side panel opens without you choosing a site (e.g. from the browser's own side
  panel menu), it shows the site you used last.

## How it works

Many sites send `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` headers, or inspect the `Sec-Fetch-*`
request headers, to keep themselves from being embedded in other pages. SideSites uses `declarativeNetRequest` session
rules to:

1. Make frame requests from the side panel look like ordinary top-level navigations (`Sec-Fetch-Dest: document`,
   `Sec-Fetch-Site: none`, `Sec-Fetch-Mode: navigate`).
2. Remove the response headers that forbid framing (`X-Frame-Options`, `Content-Security-Policy`, and the
   `Cross-Origin-*-Policy` headers).

These rules only apply to requests that **don't belong to a browser tab** (tab ID −1), which is where the side panel lives,
so ordinary browsing in tabs is not affected. SideSites also clears cached service workers and caches for your configured
sites (when you add them or change their Desktop/Mobile setting, and on browser startup), because a page served by a
previously installed service worker would bypass the header rewriting.

For sites set to **Mobile**, additional session rules (again limited to non-tab requests) rewrite the `User-Agent` and
`Sec-CH-UA-*` request headers, and a content script (`mobile-ua.js`) that only activates when the page is framed by an
extension page overrides the page's `navigator` properties to match.

A small content script (`frame-reporter.js`) runs in every page but does nothing unless the page is framed directly by
SideSites' side panel. There, it reports the page's current URL to the side panel (which can't read a cross-origin frame's
address itself) so **Open side site in a new tab** opens the page you're actually looking at, measures the page's content
width when **Fit** is enabled, hides the frame's scrollbar gutter so `100vw` layouts aren't overlapped, and handles
Back/Forward/Reload navigation from the menu.

### Permissions justification (Chrome Web Store)

- **`sidePanel`**: Opens and manages the browser's native side panel where user-selected sites are displayed.
- **`declarativeNetRequest`**: Installs session rules (scoped to `tabIds: [-1]` so normal browser tabs are untouched) that strip
  anti-framing response headers (`X-Frame-Options`, `Content-Security-Policy`, `Cross-Origin-*-Policy`), adjust `Sec-Fetch-*`
  request headers so framed sites don't reject requests as cross-site/iframe loads, and rewrite `User-Agent` / `Sec-CH-UA-*`
  headers for sites configured to use Mobile mode.
- **`browsingData`**: Clears cached Service Workers, CacheStorage, and HTTP cache for configured sites when added, when their
  Desktop/Mobile mode changes, and on startup, so previously cached responses don't bypass `declarativeNetRequest` rules.
- **`scripting`**: Dynamically registers `mobile-ua.js` on sites configured to use Mobile mode so client-side `navigator`
  properties match the mobile `User-Agent` header inside the side panel.
- **`storage`**: Stores the user's configured site list (`chrome.storage.sync`), UI preferences and per-site fit dimensions
  (`chrome.storage.local`), and per-window active sidebar state (`chrome.storage.session`).
- **`favicon`**: Displays site favicons in the extension popup menu and settings page using Chrome's built-in `/_favicon/` cache.
- **`host_permissions` (`<all_urls>`)**: Required because users can add any URL to the side panel (and sites frequently redirect
  across authentication domains), which is needed by `declarativeNetRequest`, `browsingData`, `scripting`, and the
  `frame-reporter.js` content script.

## Installation (Unpacked Extension)

1. Clone or download this repository.
2. Open your Chromium browser and navigate to `chrome://extensions`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `sidesites` folder.
5. The settings page opens automatically the first time; add some sites. You can get back to it later by choosing
   **Manage sites…** from the SideSites menu.

## Limitations

- **Gmail** currently does not work in the side panel (it displays a "Temporary Error" page due to Google's framing and
  session restrictions); we're working on it.
- Some sites detect that they're framed using JavaScript, or refuse to let you sign in inside a frame. If signing in doesn't
  work in the side panel, sign in using a regular tab, then reopen the site in the side panel.
- Mobile mode changes what the site is *told*, not the device: touch-only features and `pointer: coarse` media queries
  still reflect your real mouse and keyboard. Requests a site's service worker makes in the background also aren't tied to
  a tab, so a Mobile site's service worker may fetch mobile content even while you're using that site in a regular tab.

## Development

The toolbar icons are rendered from a description that mirrors `icons/icon.svg`. To regenerate them on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
```
