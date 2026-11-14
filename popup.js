import {
  getSites, saveSites, newId, normalizeUrl, windowKey, currentPageKey, faviconUrl, hostnameOf,
  isMobile, isFit, LAST_SITE_KEY, UA_DESKTOP, UA_MOBILE,
} from './sites.js';

const list = document.getElementById('sites');
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url');
const adhocUaBtn = document.getElementById('adhoc-ua');
const adhocFitBtn = document.getElementById('adhoc-fit');
const saveBox = document.getElementById('save');
const nameInput = document.getElementById('name');
const urlError = document.getElementById('url-error');
const more = document.getElementById('more');

// Restore the "More" disclosure first, so the menu doesn't visibly jump.
const MORE_OPEN_KEY = 'menuMoreOpen';
const { [MORE_OPEN_KEY]: moreOpen } = await chrome.storage.local.get(MORE_OPEN_KEY);
more.open = Boolean(moreOpen);
let autoOpened = false; // opened by us (not the user), so don't remember it
more.addEventListener('toggle', () => {
  if (autoOpened) {
    autoOpened = false;
    return;
  }
  chrome.storage.local.set({ [MORE_OPEN_KEY]: more.open });
});

// The arrows on "Open side site in a new tab" / "Open current tab as side site" point away from and
// toward the sidebar. The HTML assumes it's on the right (Chrome's default); flip them if the user has
// put it on the left. chrome.sidePanel.getLayout() exists in Chrome 140+.
chrome.sidePanel.getLayout?.().then((layout) => {
  if (layout?.side !== 'left') return;
  document.getElementById('sidebar-to-tab-icon').textContent = '\u2197'; // ↗
  document.getElementById('tab-to-sidebar-icon').textContent = '\u21E4'; // ⇤
}).catch(() => {});

// Look these up before the user clicks anything: chrome.sidePanel.open() must be called while the
// click's user gesture is still active, so we can't await anything before calling it.
const { id: windowId } = await chrome.windows.getCurrent();
const sites = await getSites();
const { [windowKey(windowId)]: requested } = await chrome.storage.session.get(windowKey(windowId));
const { [LAST_SITE_KEY]: lastId } = await chrome.storage.local.get(LAST_SITE_KEY);
const panelOpen = await isSidePanelOpen();
const currentId = panelOpen ? (requested?.id ?? lastId) : null;
const { [currentPageKey(windowId)]: currentPage } = await chrome.storage.session.get(currentPageKey(windowId));
const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
const currentTabUrl = activeTab?.url && /^https?:/i.test(activeTab.url) ? activeTab.url : '';

async function isSidePanelOpen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
    if (contexts.some((c) => c.windowId === windowId)) return true;
  }
  return chrome.runtime
    .sendMessage({ type: 'sidebar-ping', windowId })
    .then((res) => Boolean(res?.ok))
    .catch(() => false);
}

function chooseSite(site, { saveList = null } = {}) {
  // Tell this window's side panel (open or about to open) which site to show. The timestamp makes
  // re-choosing the current site reload it from its starting URL. userAgent is included so that
  // sites that aren't in the saved list (from "Open URL in sidebar") get the right user agent.
  const writes = [
    chrome.storage.session.set({
      [windowKey(windowId)]: {
        id: site.id,
        title: site.title,
        url: site.url,
        userAgent: site.userAgent ?? UA_DESKTOP,
        fit: Boolean(site.fit),
        ts: Date.now(),
      },
    }),
  ];
  if (saveList) writes.push(saveSites(saveList));

  // No awaiting before this call, or the click's user gesture is lost.
  const opened = chrome.sidePanel.open({ windowId }).catch(console.error);
  Promise.allSettled([opened, ...writes]).finally(() => window.close());
}

function render() {
  list.replaceChildren();
  document.getElementById('empty').hidden = sites.length > 0;

  sites.forEach((site, index) => {
    const li = document.createElement('li');
    li.role = 'none';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item';
    button.role = 'menuitem';
    button.title = site.url;
    if (site.id === currentId) button.classList.add('current');

    const icon = document.createElement('img');
    icon.className = 'icon';
    icon.alt = '';
    icon.src = faviconUrl(site.url, 32);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = site.title || hostnameOf(site.url);

    button.append(icon, title);
    if (index < 9) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(index + 1);
      button.append(key);
    }

    button.addEventListener('click', () => chooseSite(site));
    li.append(button);
    list.append(li);
  });
}

// Number keys 1-9 pick a site; arrow keys move between menu items. (Not while focus is in the URL
// form, where these keys are for typing and for the Desktop/Mobile selector.)
document.addEventListener('keydown', (event) => {
  if (urlForm.contains(document.activeElement)) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (/^[1-9]$/.test(event.key)) {
    const site = sites[Number(event.key) - 1];
    if (site) chooseSite(site);
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = [...document.querySelectorAll('.item, summary')].filter((el) => !el.disabled && el.checkVisibility());
    const pos = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? pos + 1 : pos - 1;
    items[(next + items.length) % items.length]?.focus();
    event.preventDefault();
  }
});

document.getElementById('manage').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// "Open side site in a new tab": the page the sidebar is showing now (as reported by
// frame-reporter.js), falling back to the starting URL of the site it was told to show.
const sidebarUrl = panelOpen ? (currentPage?.url ?? requested?.url ?? sites.find((s) => s.id === lastId)?.url) : null;

const DESKTOP_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>';
const MOBILE_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="2" width="7" height="12" rx="1.5"/><path d="M7.5 11.5h1"/></svg>';

const savedSite = currentId ? sites.find((s) => s.id === currentId) : null;
const activeSite = panelOpen ? (savedSite ?? (requested?.id === currentId ? requested : null)) : null;

const toggleUaBtn = document.getElementById('toggle-ua');
const toggleFitBtn = document.getElementById('toggle-fit');

function renderUaButton(btn, mobile, enabled = true) {
  btn.disabled = !enabled;
  btn.innerHTML = mobile ? MOBILE_SVG : DESKTOP_SVG;
  btn.title = enabled
    ? (mobile ? 'Mobile version (click for Desktop)' : 'Desktop version (click for Mobile)')
    : 'No site open in sidebar';
  btn.setAttribute('aria-label', btn.title);
}

function renderFitButton(btn, fit, enabled = true) {
  btn.disabled = !enabled;
  btn.classList.toggle('active', Boolean(enabled && fit));
  btn.setAttribute('aria-pressed', String(Boolean(enabled && fit)));
  btn.title = enabled
    ? (fit ? 'Fit to sidebar: On' : 'Fit to sidebar: Off')
    : 'No site open in sidebar';
}

function renderHeaderToggles() {
  renderUaButton(toggleUaBtn, isMobile(activeSite), Boolean(activeSite));
  renderFitButton(toggleFitBtn, isFit(activeSite), Boolean(activeSite));
}

renderHeaderToggles();

toggleUaBtn.addEventListener('click', async () => {
  if (!activeSite) return;
  const nextUa = isMobile(activeSite) ? UA_DESKTOP : UA_MOBILE;
  activeSite.userAgent = nextUa;
  renderHeaderToggles();
  if (savedSite) {
    await saveSites(sites);
  } else {
    await chrome.storage.session.set({
      [windowKey(windowId)]: { ...activeSite, userAgent: nextUa, ts: Date.now() },
    });
  }
});

toggleFitBtn.addEventListener('click', async () => {
  if (!activeSite) return;
  const nextFit = !isFit(activeSite);
  activeSite.fit = nextFit;
  renderHeaderToggles();
  if (savedSite) {
    await saveSites(sites);
  } else {
    await chrome.storage.session.set({
      [windowKey(windowId)]: { ...activeSite, fit: nextFit },
    });
    chrome.runtime.sendMessage({ type: 'sidebar-set-fit', windowId, fit: nextFit }).catch(() => {});
  }
});

for (const [id, action] of [
  ['nav-back', 'back'],
  ['nav-forward', 'forward'],
  ['nav-reload', 'reload'],
]) {
  const btn = document.getElementById(id);
  btn.disabled = !sidebarUrl;
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'sidebar-nav', windowId, action }).catch(() => {});
  });
}

const sidebarToTab = document.getElementById('sidebar-to-tab');
sidebarToTab.disabled = !sidebarUrl;
sidebarToTab.title = sidebarUrl ?? 'The sidebar isn\u2019t showing a site';
sidebarToTab.addEventListener('click', () => {
  const props = { url: sidebarUrl, windowId };
  if (activeTab) props.index = activeTab.index + 1;
  chrome.tabs.create(props).finally(() => window.close());
});

// "Open current tab as side site": show the active tab's page in the sidebar. If it's one of the
// saved sites, use that (with its saved desktop/mobile setting); otherwise open it as a one-off.
const tabToSidebar = document.getElementById('tab-to-sidebar');
tabToSidebar.disabled = !currentTabUrl;
tabToSidebar.title = currentTabUrl || 'This tab can\u2019t be shown in the sidebar';
tabToSidebar.addEventListener('click', () => {
  const saved = sites.find((s) => s.url === currentTabUrl);
  chooseSite(saved ?? {
    id: `adhoc:${newId()}`,
    title: activeTab.title || hostnameOf(currentTabUrl),
    url: currentTabUrl,
    userAgent: UA_DESKTOP,
  });
});

render();

// ---- Open a URL (inline form below the saved sites) ----

function showUrlError(message) {
  urlError.textContent = message;
  urlError.hidden = !message;
  urlInput.classList.toggle('invalid', Boolean(message));
}

// When the empty URL field is first focused, fill in the current tab's address, selected, so it's easy
// to either use it or type over it.
let prefilled = false;
urlInput.addEventListener('focus', () => {
  if (prefilled || urlInput.value || !currentTabUrl) return;
  prefilled = true;
  urlInput.value = currentTabUrl;
  updateNamePlaceholder();
  urlInput.select();
});

function updateNamePlaceholder() {
  const url = normalizeUrl(urlInput.value);
  nameInput.placeholder = url ? `Name (${hostnameOf(url)})` : 'Name';
}

urlInput.addEventListener('input', () => {
  showUrlError('');
  updateNamePlaceholder();
});

saveBox.addEventListener('change', () => {
  nameInput.hidden = !saveBox.checked;
  updateNamePlaceholder();
  if (saveBox.checked) nameInput.focus();
});

let adhocUa = UA_DESKTOP;
let adhocFit = false;
renderUaButton(adhocUaBtn, false);
renderFitButton(adhocFitBtn, false);

adhocUaBtn.addEventListener('click', () => {
  adhocUa = adhocUa === UA_MOBILE ? UA_DESKTOP : UA_MOBILE;
  renderUaButton(adhocUaBtn, adhocUa === UA_MOBILE);
});

adhocFitBtn.addEventListener('click', () => {
  adhocFit = !adhocFit;
  renderFitButton(adhocFitBtn, adhocFit);
});

urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = normalizeUrl(urlInput.value);
  if (!url) {
    showUrlError('Please enter a valid web address.');
    urlInput.focus();
    return;
  }
  const userAgent = adhocUa;
  const fit = adhocFit;
  const title = nameInput.value.trim() || hostnameOf(url);

  if (!saveBox.checked) {
    // A one-off visit: not added to the saved list.
    chooseSite({ id: `adhoc:${newId()}`, title, url, userAgent, fit });
    return;
  }

  // If an identical site is already in the menu, just update it rather than adding a duplicate.
  const existing = sites.find((s) => s.url === url);
  if (existing) {
    existing.title = nameInput.value.trim() || existing.title;
    existing.userAgent = userAgent;
    existing.fit = fit;
    chooseSite(existing, { saveList: sites });
    return;
  }
  const site = { id: newId(), title, url, userAgent, fit };
  chooseSite(site, { saveList: [...sites, site] });
});

// Start with focus on the current (or first) saved site. With no saved sites, reveal the URL form
// (without remembering that as the user's choice) and focus the URL field.
if (sites.length) {
  document.querySelector('#sites .item.current, #sites .item')?.focus();
} else {
  if (!more.open) {
    autoOpened = true;
    more.open = true;
  }
  urlInput.focus();
}
