import {
  getSites, windowKey, currentPageKey, siteFitKey, isMobile, isFit, LAST_SITE_KEY, SITES_KEY, SITE_FIT_KEY,
} from './sites.js';

const frame = document.getElementById('site');
const empty = document.getElementById('empty');

document.getElementById('manage').addEventListener('click', () => chrome.runtime.openOptionsPage());

const { id: windowId } = await chrome.windows.getCurrent();
const myKey = windowKey(windowId);
const { [SITE_FIT_KEY]: savedFits = {} } = await chrome.storage.local.get(SITE_FIT_KEY);

let lastRequestTs = null;
let currentSite = null;
let loadToken = 0;
let requiredWidth = 0;
let saveFitTimer = null;

/**
 * Scales the iframe down when the page inside it needs a wider viewport than the sidebar currently
 * has, and scales it smoothly back up toward 100% as the user widens the sidebar.
 */
function applyFitScale() {
  const panelWidth = window.innerWidth;
  const panelHeight = window.innerHeight;
  if (!isFit(currentSite) || !requiredWidth || !panelWidth || requiredWidth <= panelWidth) {
    frame.style.width = '';
    frame.style.height = '';
    frame.style.transform = '';
    return;
  }
  const scale = panelWidth / requiredWidth;
  frame.style.width = `${requiredWidth}px`;
  frame.style.height = `${panelHeight / scale}px`;
  frame.style.transform = `scale(${scale})`;
}

/** Remembers the current site's required width, sidebar width, and zoom factor across reloads. */
function rememberFit() {
  const key = siteFitKey(currentSite);
  const panelWidth = window.innerWidth;
  if (!key || !requiredWidth || !panelWidth) return;
  const zoom = Math.min(1, panelWidth / requiredWidth);
  savedFits[key] = { requiredWidth, sidebarWidth: panelWidth, zoom };
  chrome.storage.local.set({ [SITE_FIT_KEY]: savedFits });
}

window.addEventListener('resize', () => {
  applyFitScale();
  clearTimeout(saveFitTimer);
  saveFitTimer = setTimeout(rememberFit, 250);
});

function showEmpty() {
  loadToken++;
  currentSite = null;
  requiredWidth = 0;
  applyFitScale();
  frame.hidden = true;
  frame.removeAttribute('src');
  empty.hidden = false;
  document.title = 'SideSites';
  chrome.storage.session.remove(currentPageKey(windowId));
}

async function load(site) {
  const token = ++loadToken;
  currentSite = site;
  const remembered = savedFits[siteFitKey(site)];
  requiredWidth = remembered?.requiredWidth ?? 0;
  applyFitScale();
  empty.hidden = true;
  frame.hidden = false;
  document.title = site.title || 'SideSites';

  // Make sure the header-rewriting rules (including this site's user agent) are in place, and any
  // stale service worker is gone, before we try to frame it.
  await chrome.runtime.sendMessage({ type: 'ensure-rules', site }).catch(() => {});
  if (token !== loadToken) return; // another site was chosen meanwhile

  frame.src = site.url;
  setCurrentPage(site.url);
  chrome.storage.local.set({ [LAST_SITE_KEY]: site.id });
}

/** Remember the page showing in this sidebar, for the popup's "Open side site in a new tab". */
function setCurrentPage(url) {
  chrome.storage.session.set({ [currentPageKey(windowId)]: { url } });
}

// frame-reporter.js (running inside the framed page) tells us when the page navigates or when its
// layout is wider than the sidebar.
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;

  if (event.data?.type === 'sidesites-frame-url') {
    const url = String(event.data.url ?? '');
    // Accept only http(s) URLs on the origin the message actually came from.
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== event.origin) return;
    } catch {
      return;
    }
    setCurrentPage(url);
  } else if (event.data?.type === 'sidesites-content-width') {
    const width = Math.min(Math.round(Number(event.data.width)), 1024);
    if (!Number.isFinite(width) || width <= requiredWidth + 8) return;
    requiredWidth = width;
    applyFitScale();
    rememberFit();
  }
});

/** Resolve a request from the popup to the saved site it names, or use it as-is (unsaved URL). */
function resolve(request, sites) {
  return sites.find((s) => s.id === request.id) ?? request;
}

/** Load the site requested for this window, else the last site shown, else the first one. */
async function loadInitial() {
  const sites = await getSites();
  const { [myKey]: request } = await chrome.storage.session.get(myKey);
  const { [LAST_SITE_KEY]: lastId } = await chrome.storage.local.get(LAST_SITE_KEY);

  let site = null;
  if (request) {
    lastRequestTs = request.ts;
    site = resolve(request, sites);
  }
  site ??= sites.find((s) => s.id === lastId) ?? sites[0];
  if (site) load(site);
  else showEmpty();
}

chrome.storage.onChanged.addListener((changes, area) => {
  // The popup picked a site for this window.
  if (area === 'session' && changes[myKey]?.newValue) {
    const request = changes[myKey].newValue;
    if (request.ts === lastRequestTs) return;
    lastRequestTs = request.ts;
    getSites().then((sites) => load(resolve(request, sites)));
  }
  // Site list changed: if we had nothing to show, try again; if the site we're showing was saved and
  // has now been removed along with every other site, show the empty state; if the site we're showing
  // switched between desktop and mobile, reload it that way.
  if (area === 'sync' && changes[SITES_KEY]) {
    const sites = changes[SITES_KEY].newValue ?? [];
    const oldSites = changes[SITES_KEY].oldValue ?? [];
    const updated = currentSite && sites.find((s) => s.id === currentSite.id);
    const wasSaved = currentSite && oldSites.some((s) => s.id === currentSite.id);
    if (!currentSite) loadInitial();
    else if (!sites.length && wasSaved) showEmpty();
    else if (updated && isMobile(updated) !== isMobile(currentSite)) load(updated);
    else if (updated && isFit(updated) !== isFit(currentSite)) {
      currentSite = updated;
      applyFitScale();
    }
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.windowId !== windowId) return;
  if (msg.type === 'sidebar-ping') {
    sendResponse({ ok: true });
  } else if (msg.type === 'sidebar-nav') {
    frame.contentWindow?.postMessage({ type: 'sidesites-nav', action: msg.action }, '*');
  } else if (msg.type === 'sidebar-set-fit' && currentSite) {
    currentSite.fit = Boolean(msg.fit);
    applyFitScale();
  }
});

await loadInitial();
