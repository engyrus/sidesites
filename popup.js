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
const REMEMBER_SPLIT_PANE_KEY = 'rememberSplitPane';
const LAST_PANE_SITE_KEY = 'lastPaneSite';

const { id: windowId } = await chrome.windows.getCurrent();
const sites = await getSites();
const { [windowKey(windowId)]: requested } = await chrome.storage.session.get(windowKey(windowId));
const {
  [LAST_SITE_KEY]: lastId,
  [REMEMBER_SPLIT_PANE_KEY]: rememberSplitPane = false,
  [LAST_PANE_SITE_KEY]: lastPaneSites = {},
} = await chrome.storage.local.get([LAST_SITE_KEY, REMEMBER_SPLIT_PANE_KEY, LAST_PANE_SITE_KEY]);
const panelOpen = await isSidePanelOpen();
const splitActive = panelOpen && requested?.mode === 'split';
const focusedPane = splitActive && requested.focused === 'bottom' ? 'bottom' : 'top';
const topId = splitActive ? requested.top?.id : null;
const bottomId = splitActive ? requested.bottom?.id : null;
const currentId = panelOpen
  ? (splitActive ? requested[focusedPane]?.id : (requested?.id ?? lastId))
  : null;
const savedSite = currentId ? sites.find((s) => s.id === currentId) : null;
const activeRequested = splitActive ? requested[focusedPane] : requested;
const activeSite = panelOpen
  ? (savedSite ?? (activeRequested?.id === currentId ? activeRequested : null))
  : null;
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

function toPayload(site) {
  return {
    id: site.id,
    title: site.title,
    url: site.url,
    userAgent: site.userAgent ?? UA_DESKTOP,
    fit: Boolean(site.fit),
  };
}

function chooseSite(site, { target = null, saveList = null } = {}) {
  // Tell this window's side panel (open or about to open) which site to show. Left-clicking in
  // split mode targets the focused pane; right-clicking lets you pick Full, Top, or Bottom.
  const effectiveTarget = target ?? (splitActive ? focusedPane : 'full');
  let payload;
  if (effectiveTarget === 'top' || effectiveTarget === 'bottom') {
    const otherPane = effectiveTarget === 'top' ? 'bottom' : 'top';
    const otherSite = splitActive
      ? requested[otherPane]
      : (rememberSplitPane ? lastPaneSites[otherPane] ?? null : null);
    payload = {
      mode: 'split',
      focused: effectiveTarget,
      top: effectiveTarget === 'top' ? toPayload(site) : (otherSite ? toPayload(otherSite) : null),
      bottom: effectiveTarget === 'bottom' ? toPayload(site) : (otherSite ? toPayload(otherSite) : null),
      reloadPane: effectiveTarget,
      ts: Date.now(),
    };
  } else {
    payload = { ...toPayload(site), ts: Date.now() };
  }

  const writes = [chrome.storage.session.set({ [windowKey(windowId)]: payload })];
  if (saveList) writes.push(saveSites(saveList));

  // No awaiting before this call, or the click's user gesture is lost.
  const opened = chrome.sidePanel.open({ windowId }).catch(console.error);
  Promise.allSettled([opened, ...writes]).finally(() => window.close());
}

const contextMenu = document.getElementById('context-menu');
let contextAction = null;

function hideContextMenu() {
  contextMenu.hidden = true;
  contextAction = null;
}

function showContextMenu(onSelect, x, y) {
  contextAction = onSelect;
  contextMenu.hidden = false;
  const maxX = Math.max(0, window.innerWidth - contextMenu.offsetWidth - 4);
  const maxY = Math.max(0, window.innerHeight - contextMenu.offsetHeight - 4);
  contextMenu.style.left = `${Math.min(x, maxX)}px`;
  contextMenu.style.top = `${Math.min(y, maxY)}px`;
  contextMenu.querySelector('button')?.focus();
}

contextMenu.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-target]');
  if (!btn || !contextAction) return;
  const action = contextAction;
  const target = btn.dataset.target;
  hideContextMenu();
  action(target);
});

document.addEventListener('click', (event) => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target)) hideContextMenu();
});

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
    button.title = `${site.url}\nRight-click to target a pane`;
    if (site.id === currentId) button.classList.add('current');

    const icon = document.createElement('img');
    icon.className = 'icon';
    icon.alt = '';
    icon.src = faviconUrl(site.url, 32);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = site.title || hostnameOf(site.url);

    button.append(icon, title);
    if (splitActive && (site.id === topId || site.id === bottomId)) {
      const badge = document.createElement('span');
      badge.className = 'pane-badge';
      const inBoth = site.id === topId && site.id === bottomId;
      badge.textContent = inBoth ? 'Top/Bot' : site.id === topId ? 'Top' : 'Bottom';
      button.append(badge);
    }
    if (index < 9) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(index + 1);
      button.append(key);
    }

    button.addEventListener('click', () => chooseSite(site));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu((target) => chooseSite(site, { target }), event.clientX, event.clientY);
    });
    li.append(button);
    list.append(li);
  });
}

// Number keys 1-9 pick a site; arrow keys move between menu items. (Not while focus is in the URL
// form, where these keys are for typing.) Escape closes the context menu if open.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !contextMenu.hidden) {
    hideContextMenu();
    event.preventDefault();
    return;
  }
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

// "Open side site in a new tab": the page the focused pane is showing now (as reported by
// frame-reporter.js), falling back to the starting URL of that pane's site.
const sidebarUrl = panelOpen
  ? (currentPage?.url ?? activeSite?.url ?? sites.find((s) => s.id === lastId)?.url)
  : null;

const DESKTOP_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>';
const MOBILE_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="2" width="7" height="12" rx="1.5"/><path d="M7.5 11.5h1"/></svg>';

const toggleUaBtn = document.getElementById('toggle-ua');
const toggleFitBtn = document.getElementById('toggle-fit');
const toggleSplitBtn = document.getElementById('toggle-split');

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
  const canSplit = Boolean(panelOpen && (splitActive || activeSite));
  toggleSplitBtn.disabled = !canSplit;
  toggleSplitBtn.classList.toggle('active', Boolean(splitActive));
  toggleSplitBtn.setAttribute('aria-pressed', String(Boolean(splitActive)));
  toggleSplitBtn.title = !canSplit
    ? 'No site open in sidebar'
    : splitActive
      ? 'Exit split view (right-click to swap panes)'
      : 'Split sidebar (right-click to put current site on bottom)';
}

renderHeaderToggles();

async function setSplitState(payload) {
  await chrome.storage.session.set({ [windowKey(windowId)]: payload });
  window.close();
}

toggleSplitBtn.addEventListener('click', () => {
  if (splitActive) {
    const keepSite = activeSite ?? requested.top ?? requested.bottom;
    if (!keepSite) return;
    setSplitState({
      ...toPayload(keepSite),
      keepPane: activeSite ? focusedPane : (requested.top ? 'top' : 'bottom'),
      keepIfSame: true,
      ts: Date.now(),
    });
    return;
  }
  if (!activeSite) return;
  const rememberedBottom = rememberSplitPane ? lastPaneSites.bottom ?? null : null;
  setSplitState({
    mode: 'split',
    focused: rememberedBottom ? 'top' : 'bottom',
    top: toPayload(activeSite),
    bottom: rememberedBottom ? toPayload(rememberedBottom) : null,
    ts: Date.now(),
  });
});

toggleSplitBtn.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (splitActive) {
    setSplitState({
      mode: 'split',
      focused: focusedPane === 'top' ? 'bottom' : 'top',
      top: requested.bottom ?? null,
      bottom: requested.top ?? null,
      swap: true,
      ts: Date.now(),
    });
    return;
  }
  if (!activeSite) return;
  const rememberedTop = rememberSplitPane ? lastPaneSites.top ?? null : null;
  setSplitState({
    mode: 'split',
    focused: rememberedTop ? 'bottom' : 'top',
    top: rememberedTop ? toPayload(rememberedTop) : null,
    bottom: toPayload(activeSite),
    reloadPane: 'bottom',
    ts: Date.now(),
  });
});

toggleUaBtn.addEventListener('click', async () => {
  if (!activeSite) return;
  const nextUa = isMobile(activeSite) ? UA_DESKTOP : UA_MOBILE;
  activeSite.userAgent = nextUa;
  renderHeaderToggles();
  if (savedSite) {
    await saveSites(sites);
  } else if (splitActive) {
    await chrome.storage.session.set({
      [windowKey(windowId)]: {
        ...requested,
        [focusedPane]: { ...activeSite, userAgent: nextUa },
        reloadPane: focusedPane,
        ts: Date.now(),
      },
    });
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
  } else if (splitActive) {
    await chrome.storage.session.set({
      [windowKey(windowId)]: {
        ...requested,
        [focusedPane]: { ...activeSite, fit: nextFit },
      },
    });
    chrome.runtime.sendMessage({ type: 'sidebar-set-fit', windowId, fit: nextFit }).catch(() => {});
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
tabToSidebar.title = currentTabUrl
  ? `${currentTabUrl}\nRight-click to target a pane`
  : 'This tab can\u2019t be shown in the sidebar';
function openCurrentTab(target = null) {
  const saved = sites.find((s) => s.url === currentTabUrl);
  chooseSite(
    saved ?? {
      id: `adhoc:${newId()}`,
      title: activeTab.title || hostnameOf(currentTabUrl),
      url: currentTabUrl,
      userAgent: UA_DESKTOP,
    },
    { target }
  );
}

tabToSidebar.addEventListener('click', () => openCurrentTab());
tabToSidebar.addEventListener('contextmenu', (event) => {
  if (!currentTabUrl) return;
  event.preventDefault();
  showContextMenu((target) => openCurrentTab(target), event.clientX, event.clientY);
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

function submitAdhocUrl(target = null) {
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
    chooseSite({ id: `adhoc:${newId()}`, title, url, userAgent, fit }, { target });
    return;
  }

  // If an identical site is already in the menu, just update it rather than adding a duplicate.
  const existing = sites.find((s) => s.url === url);
  if (existing) {
    existing.title = nameInput.value.trim() || existing.title;
    existing.userAgent = userAgent;
    existing.fit = fit;
    chooseSite(existing, { target, saveList: sites });
    return;
  }
  const site = { id: newId(), title, url, userAgent, fit };
  chooseSite(site, { target, saveList: [...sites, site] });
}

urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAdhocUrl();
});

const goBtn = document.getElementById('go');
goBtn.title = 'Open in sidebar\nRight-click to target a pane';
goBtn.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showContextMenu((target) => submitAdhocUrl(target), event.clientX, event.clientY);
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
