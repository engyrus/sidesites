import {
  getSites, windowKey, currentPageKey, siteFitKey, faviconUrl, hostnameOf, newId, normalizeUrl,
  isMobile, isFit, UA_DESKTOP, UA_MOBILE, LAST_SITE_KEY, SITES_KEY, SITE_FIT_KEY,
} from './sites.js';

const SPLIT_RATIO_KEY = 'splitRatio';
const REMEMBER_SPLIT_PANE_KEY = 'rememberSplitPane';
const LAST_PANE_SITE_KEY = 'lastPaneSite';

const empty = document.getElementById('empty');
const splitter = document.getElementById('splitter');

document.getElementById('manage').addEventListener('click', () => chrome.runtime.openOptionsPage());

const { id: windowId } = await chrome.windows.getCurrent();
const myKey = windowKey(windowId);
const {
  [SITE_FIT_KEY]: savedFits = {},
  [SPLIT_RATIO_KEY]: savedRatio = 0.5,
  [REMEMBER_SPLIT_PANE_KEY]: savedRememberSplitPane = false,
  [LAST_PANE_SITE_KEY]: savedLastPaneSites = {},
} = await chrome.storage.local.get([
  SITE_FIT_KEY,
  SPLIT_RATIO_KEY,
  REMEMBER_SPLIT_PANE_KEY,
  LAST_PANE_SITE_KEY,
]);

let lastRequestTs = null;
let splitMode = false;
let focusedPane = 'top';
let splitRatio = Math.min(0.85, Math.max(0.15, Number(savedRatio) || 0.5));
let rememberSplitPane = Boolean(savedRememberSplitPane);
const lastPaneSites = { ...savedLastPaneSites };
let saveFitTimer = null;

const panes = {
  top: {
    name: 'top',
    el: document.getElementById('pane-top'),
    frame: document.getElementById('site'),
    picker: document.getElementById('picker-top'),
    site: null,
    loadToken: 0,
    requiredWidth: 0,
    currentUrl: null,
  },
  bottom: {
    name: 'bottom',
    el: document.getElementById('pane-bottom'),
    frame: document.getElementById('site-bottom'),
    picker: document.getElementById('picker-bottom'),
    site: null,
    loadToken: 0,
    requiredWidth: 0,
    currentUrl: null,
  },
};

function applySplitRatio() {
  document.body.style.setProperty('--split', `${(splitRatio * 100).toFixed(2)}%`);
}
applySplitRatio();

function setFocusedPane(name, { persist = true } = {}) {
  if (name !== 'top' && name !== 'bottom') return;
  focusedPane = name;
  panes.top.el.classList.toggle('focused', name === 'top');
  panes.bottom.el.classList.toggle('focused', name === 'bottom');
  updateDocumentTitle();
  syncCurrentPage();
  if (persist && splitMode) {
    chrome.storage.session.get(myKey).then(({ [myKey]: req }) => {
      if (req?.mode === 'split' && req.focused !== name) {
        chrome.storage.session.set({ [myKey]: { ...req, focused: name } });
      }
    }).catch(() => {});
  }
}

function swapPanes() {
  const prevTop = panes.top;
  const prevBottom = panes.bottom;
  panes.top = prevBottom;
  panes.bottom = prevTop;
  panes.top.name = 'top';
  panes.bottom.name = 'bottom';
  panes.top.el.classList.remove('pane-bottom');
  panes.top.el.classList.add('pane-top');
  panes.bottom.el.classList.remove('pane-top');
  panes.bottom.el.classList.add('pane-bottom');
  if (focusedPane === 'top') focusedPane = 'bottom';
  else if (focusedPane === 'bottom') focusedPane = 'top';
}

function updateDocumentTitle() {
  const active = splitMode ? panes[focusedPane]?.site : panes.top?.site;
  document.title = active?.title || 'SideSites';
}

/**
 * Scales a pane's iframe down when the page inside it needs a wider viewport than the pane
 * currently has, and scales it smoothly back up toward 100% as the pane is widened.
 */
function applyFitScale(pane) {
  const panelWidth = pane.el.clientWidth || window.innerWidth;
  const panelHeight = pane.el.clientHeight || window.innerHeight;
  if (!isFit(pane.site) || !pane.requiredWidth || !panelWidth || pane.requiredWidth <= panelWidth) {
    pane.frame.style.width = '';
    pane.frame.style.height = '';
    pane.frame.style.transform = '';
    return;
  }
  const scale = panelWidth / pane.requiredWidth;
  pane.frame.style.width = `${pane.requiredWidth}px`;
  pane.frame.style.height = `${panelHeight / scale}px`;
  pane.frame.style.transform = `scale(${scale})`;
}

function applyAllFitScales() {
  if (splitMode) {
    applyFitScale(panes.top);
    applyFitScale(panes.bottom);
  } else {
    applyFitScale(panes.top);
  }
}

/** Remembers a pane's required width, sidebar width, and zoom factor across reloads. */
function rememberFit(pane) {
  const key = siteFitKey(pane.site);
  const panelWidth = pane.el.clientWidth || window.innerWidth;
  if (!key || !pane.requiredWidth || !panelWidth) return;
  const zoom = Math.min(1, panelWidth / pane.requiredWidth);
  savedFits[key] = { requiredWidth: pane.requiredWidth, sidebarWidth: panelWidth, zoom };
  chrome.storage.local.set({ [SITE_FIT_KEY]: savedFits });
}

const paneObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    if (entry.target === panes.top.el && !panes.top.el.hidden) applyFitScale(panes.top);
    else if (entry.target === panes.bottom.el && !panes.bottom.el.hidden) applyFitScale(panes.bottom);
  }
});
paneObserver.observe(panes.top.el);
paneObserver.observe(panes.bottom.el);

window.addEventListener('resize', () => {
  applyAllFitScales();
  clearTimeout(saveFitTimer);
  saveFitTimer = setTimeout(() => {
    rememberFit(panes.top);
    if (splitMode) rememberFit(panes.bottom);
  }, 250);
});

// ---- Draggable split divider ----

let draggingSplit = false;

splitter.addEventListener('pointerdown', (event) => {
  if (!splitMode || event.button !== 0) return;
  draggingSplit = true;
  document.body.classList.add('dragging');
  splitter.setPointerCapture(event.pointerId);
  event.preventDefault();
});

splitter.addEventListener('pointermove', (event) => {
  if (!draggingSplit) return;
  const totalHeight = document.body.clientHeight;
  if (!totalHeight) return;
  const minRatio = Math.min(0.45, 80 / totalHeight);
  splitRatio = Math.min(1 - minRatio, Math.max(minRatio, event.clientY / totalHeight));
  applySplitRatio();
  applyAllFitScales();
});

function endSplitDrag() {
  if (!draggingSplit) return;
  draggingSplit = false;
  document.body.classList.remove('dragging');
  chrome.storage.local.set({ [SPLIT_RATIO_KEY]: splitRatio });
}

splitter.addEventListener('pointerup', endSplitDrag);
splitter.addEventListener('pointercancel', endSplitDrag);
splitter.addEventListener('dblclick', () => {
  splitRatio = 0.5;
  applySplitRatio();
  applyAllFitScales();
  chrome.storage.local.set({ [SPLIT_RATIO_KEY]: splitRatio });
});

// ---- Loading & empty states ----

const DESKTOP_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>';
const MOBILE_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="2" width="7" height="12" rx="1.5"/><path d="M7.5 11.5h1"/></svg>';
const FIT_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 8h6M6.5 6.5 5 8l1.5 1.5M9.5 6.5 11 8l-1.5 1.5"/></svg>';

function hidePanePicker(pane) {
  pane.picker.hidden = true;
  pane.picker.replaceChildren();
}

async function openSiteInPane(pane, site) {
  const { [myKey]: req } = await chrome.storage.session.get(myKey);
  const sitePayload = {
    id: site.id,
    title: site.title,
    url: site.url,
    userAgent: site.userAgent ?? UA_DESKTOP,
    fit: Boolean(site.fit),
  };
  const nextReq = {
    ...(req?.mode === 'split' ? req : { mode: 'split', top: null, bottom: null }),
    [pane.name]: sitePayload,
    focused: pane.name,
    reloadPane: pane.name,
    ts: Date.now(),
  };
  lastRequestTs = nextReq.ts;
  await chrome.storage.session.set({ [myKey]: nextReq });
  setFocusedPane(pane.name, { persist: false });
  hidePanePicker(pane);
  await loadPane(pane, site, { forceReload: true });
}

function showPanePicker(pane, sites) {
  pane.picker.replaceChildren();
  const title = document.createElement('div');
  title.className = 'pane-picker-title';
  title.textContent = `Choose a site for ${pane.name === 'top' ? 'Top' : 'Bottom'}`;

  const list = document.createElement('div');
  list.className = 'pane-picker-list';

  for (const site of sites) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-picker-btn';
    btn.title = site.url;

    const img = document.createElement('img');
    img.alt = '';
    img.src = faviconUrl(site.url, 32);

    const label = document.createElement('span');
    label.textContent = site.title || hostnameOf(site.url);

    btn.append(img, label);
    btn.addEventListener('click', () => openSiteInPane(pane, site));
    list.append(btn);
  }

  const form = document.createElement('form');
  form.className = 'pane-picker-form';
  form.autocomplete = 'off';
  form.noValidate = true;

  const row = document.createElement('div');
  row.className = 'pane-picker-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'url';
  input.className = 'pane-picker-input';
  input.placeholder = 'Open URL\u2026';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'URL');

  let ua = UA_DESKTOP;
  let fit = false;

  const uaBtn = document.createElement('button');
  uaBtn.type = 'button';
  uaBtn.className = 'pane-picker-icon-btn';
  const renderUa = () => {
    const mobile = ua === UA_MOBILE;
    uaBtn.innerHTML = mobile ? MOBILE_SVG : DESKTOP_SVG;
    uaBtn.title = mobile ? 'Mobile version (click for Desktop)' : 'Desktop version (click for Mobile)';
    uaBtn.setAttribute('aria-label', uaBtn.title);
  };
  renderUa();
  uaBtn.addEventListener('click', () => {
    ua = ua === UA_MOBILE ? UA_DESKTOP : UA_MOBILE;
    renderUa();
  });

  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'pane-picker-icon-btn';
  fitBtn.innerHTML = FIT_SVG;
  const renderFit = () => {
    fitBtn.classList.toggle('active', fit);
    fitBtn.setAttribute('aria-pressed', String(fit));
    fitBtn.title = fit ? 'Fit to sidebar: On' : 'Fit to sidebar: Off';
    fitBtn.setAttribute('aria-label', fitBtn.title);
  };
  renderFit();
  fitBtn.addEventListener('click', () => {
    fit = !fit;
    renderFit();
  });

  const goBtn = document.createElement('button');
  goBtn.type = 'submit';
  goBtn.className = 'pane-picker-icon-btn primary';
  goBtn.title = 'Open in pane';
  goBtn.setAttribute('aria-label', 'Go');
  goBtn.textContent = '\u2192';

  const error = document.createElement('p');
  error.className = 'pane-picker-error';
  error.hidden = true;

  input.addEventListener('input', () => {
    error.hidden = true;
    input.classList.remove('invalid');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = normalizeUrl(input.value);
    if (!url) {
      error.textContent = 'Please enter a valid web address.';
      error.hidden = false;
      input.classList.add('invalid');
      input.focus();
      return;
    }
    openSiteInPane(pane, {
      id: `adhoc:${newId()}`,
      title: hostnameOf(url),
      url,
      userAgent: ua,
      fit,
    });
  });

  row.append(input, uaBtn, fitBtn, goBtn);
  form.append(row, error);

  const rememberLabel = document.createElement('label');
  rememberLabel.className = 'pane-picker-remember';
  const rememberBox = document.createElement('input');
  rememberBox.type = 'checkbox';
  rememberBox.checked = rememberSplitPane;
  rememberBox.addEventListener('change', () => {
    rememberSplitPane = rememberBox.checked;
    chrome.storage.local.set({ [REMEMBER_SPLIT_PANE_KEY]: rememberSplitPane });
  });
  const rememberText = document.createElement('span');
  rememberText.textContent = 'Remember last site opened in this pane';
  rememberLabel.append(rememberBox, rememberText);

  const inner = document.createElement('div');
  inner.className = 'pane-picker-inner';
  inner.append(title, form, list, rememberLabel);

  pane.picker.append(inner);
  pane.picker.hidden = false;
}

function clearPane(pane) {
  pane.loadToken++;
  pane.site = null;
  pane.requiredWidth = 0;
  pane.currentUrl = null;
  applyFitScale(pane);
  pane.frame.removeAttribute('src');
  hidePanePicker(pane);
}

function showEmpty() {
  splitMode = false;
  document.body.classList.remove('split-active');
  clearPane(panes.top);
  clearPane(panes.bottom);
  panes.top.el.hidden = true;
  splitter.hidden = true;
  panes.bottom.el.hidden = true;
  empty.hidden = false;
  document.title = 'SideSites';
  chrome.storage.session.remove(currentPageKey(windowId));
}

async function loadPane(pane, site, { forceReload = false } = {}) {
  const sameSite =
    !forceReload &&
    pane.site &&
    pane.site.id === site.id &&
    pane.site.url === site.url &&
    isMobile(pane.site) === isMobile(site);

  pane.site = site;
  if (sameSite) {
    applyFitScale(pane);
    updateDocumentTitle();
    return;
  }

  const token = ++pane.loadToken;
  const remembered = savedFits[siteFitKey(site)];
  pane.requiredWidth = remembered?.requiredWidth ?? 0;
  pane.currentUrl = site.url;
  applyFitScale(pane);
  updateDocumentTitle();
  syncCurrentPage();

  // Make sure the header-rewriting rules (including this site's user agent) are in place, and any
  // stale service worker is gone, before we try to frame it.
  await chrome.runtime.sendMessage({ type: 'ensure-rules', site }).catch(() => {});
  if (token !== pane.loadToken) return; // another site was chosen meanwhile

  pane.frame.src = site.url;
  if (pane.name === focusedPane || !splitMode) {
    chrome.storage.local.set({ [LAST_SITE_KEY]: site.id });
  }
  if (splitMode) {
    lastPaneSites[pane.name] = {
      id: site.id,
      title: site.title,
      url: site.url,
      userAgent: site.userAgent ?? UA_DESKTOP,
      fit: Boolean(site.fit),
    };
    chrome.storage.local.set({ [LAST_PANE_SITE_KEY]: lastPaneSites });
  }
}

async function applyRequest(request, sites) {
  empty.hidden = true;
  if (request.mode === 'split') {
    if (splitMode && request.swap) {
      swapPanes();
    }
    splitMode = true;
    document.body.classList.add('split-active');
    panes.top.el.hidden = false;
    splitter.hidden = false;
    panes.bottom.el.hidden = false;
    const topSite = request.top ? resolve(request.top, sites) : null;
    const bottomSite = request.bottom ? resolve(request.bottom, sites) : null;
    setFocusedPane(request.focused === 'bottom' ? 'bottom' : 'top', { persist: false });
    if (topSite) {
      hidePanePicker(panes.top);
      await loadPane(panes.top, topSite, { forceReload: request.reloadPane === 'top' });
    } else {
      clearPane(panes.top);
      showPanePicker(panes.top, sites);
    }
    if (bottomSite) {
      hidePanePicker(panes.bottom);
      await loadPane(panes.bottom, bottomSite, { forceReload: request.reloadPane === 'bottom' });
    } else {
      clearPane(panes.bottom);
      showPanePicker(panes.bottom, sites);
    }
  } else {
    const site = resolve(request, sites);
    const fromBottom =
      request.keepPane === 'bottom' ||
      (request.keepIfSame &&
        panes.bottom.site &&
        panes.bottom.site.id === site.id &&
        panes.bottom.site.url === site.url &&
        isMobile(panes.bottom.site) === isMobile(site) &&
        panes.top.site?.id !== site.id);
    if (fromBottom) {
      swapPanes();
    }
    splitMode = false;
    document.body.classList.remove('split-active');
    panes.top.el.hidden = false;
    splitter.hidden = true;
    panes.bottom.el.hidden = true;
    clearPane(panes.bottom);
    setFocusedPane('top', { persist: false });
    hidePanePicker(panes.top);
    await loadPane(panes.top, site, { forceReload: !request.keepIfSame });
  }
}

/** Remember the page(s) showing in this sidebar, for the popup's "Open side site in a new tab". */
function syncCurrentPage() {
  const active = splitMode ? panes[focusedPane] : panes.top;
  const url = active?.currentUrl ?? active?.site?.url;
  if (!url) return;
  chrome.storage.session.set({
    [currentPageKey(windowId)]: {
      url,
      topUrl: panes.top.currentUrl ?? panes.top.site?.url ?? null,
      bottomUrl: splitMode ? (panes.bottom.currentUrl ?? panes.bottom.site?.url ?? null) : null,
    },
  });
}

// frame-reporter.js (running inside the framed page) tells us when the page navigates, when its
// layout is wider than the pane, or when the user interacts with it.
window.addEventListener('message', (event) => {
  const pane =
    event.source === panes.top.frame.contentWindow
      ? panes.top
      : event.source === panes.bottom.frame.contentWindow
        ? panes.bottom
        : null;
  if (!pane) return;

  if (event.data?.type === 'sidesites-frame-url') {
    const url = String(event.data.url ?? '');
    // Accept only http(s) URLs on the origin the message actually came from.
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== event.origin) return;
    } catch {
      return;
    }
    pane.currentUrl = url;
    syncCurrentPage();
  } else if (event.data?.type === 'sidesites-content-width') {
    const width = Math.min(Math.round(Number(event.data.width)), 1024);
    if (!Number.isFinite(width) || width <= pane.requiredWidth + 8) return;
    pane.requiredWidth = width;
    applyFitScale(pane);
    rememberFit(pane);
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

  if (request) {
    lastRequestTs = request.ts;
    await applyRequest(request, sites);
    return;
  }
  const site = sites.find((s) => s.id === lastId) ?? sites[0];
  if (site) {
    empty.hidden = true;
    panes.top.el.hidden = false;
    await loadPane(panes.top, site, { forceReload: true });
  } else {
    showEmpty();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  // The popup picked a site or changed split layout for this window.
  if (area === 'session' && changes[myKey]?.newValue) {
    const request = changes[myKey].newValue;
    if (request.ts === lastRequestTs) return;
    lastRequestTs = request.ts;
    getSites().then((sites) => applyRequest(request, sites));
  }
  // Site list changed: if we had nothing to show, try again; if a shown site was removed along with
  // every other site, show the empty state; if a shown site switched between desktop and mobile or
  // toggled fit, update that pane.
  if (area === 'sync' && changes[SITES_KEY]) {
    const sites = changes[SITES_KEY].newValue ?? [];
    const oldSites = changes[SITES_KEY].oldValue ?? [];
    const activePanes = splitMode ? [panes.top, panes.bottom] : [panes.top];
    if (!panes.top.site && !splitMode) {
      loadInitial();
      return;
    }
    const wasSaved = oldSites.some((s) => s.id === panes.top.site?.id);
    if (!sites.length && wasSaved) {
      showEmpty();
      return;
    }
    for (const pane of activePanes) {
      if (!pane.site) continue;
      const updated = sites.find((s) => s.id === pane.site.id);
      if (!updated) continue;
      if (isMobile(updated) !== isMobile(pane.site)) {
        loadPane(pane, updated, { forceReload: true });
      } else if (isFit(updated) !== isFit(pane.site)) {
        pane.site = updated;
        applyFitScale(pane);
      }
    }
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.windowId !== windowId) return;
  const targetPane = splitMode ? panes[focusedPane] : panes.top;
  if (msg.type === 'sidebar-ping') {
    sendResponse({ ok: true });
  } else if (msg.type === 'sidebar-nav') {
    targetPane?.frame.contentWindow?.postMessage({ type: 'sidesites-nav', action: msg.action }, '*');
  } else if (msg.type === 'sidebar-set-fit' && targetPane?.site) {
    targetPane.site.fit = Boolean(msg.fit);
    applyFitScale(targetPane);
  } else if (msg.type === 'sidebar-focus-pane' && splitMode) {
    setFocusedPane(msg.pane);
  }
});

async function exitSplitKeeping(targetPane) {
  if (!splitMode) return;
  if (!targetPane.site) {
    if (targetPane === panes.bottom) {
      swapPanes();
    }
    splitMode = false;
    document.body.classList.remove('split-active');
    panes.top.el.hidden = false;
    splitter.hidden = true;
    panes.bottom.el.hidden = true;
    clearPane(panes.bottom);
    setFocusedPane('top', { persist: false });
    const sites = await getSites();
    showPanePicker(panes.top, sites);
    chrome.storage.session.remove(myKey);
    return;
  }
  const sitePayload = {
    id: targetPane.site.id,
    title: targetPane.site.title,
    url: targetPane.site.url,
    userAgent: targetPane.site.userAgent ?? UA_DESKTOP,
    fit: Boolean(targetPane.site.fit),
    keepPane: targetPane.name,
    keepIfSame: true,
    ts: Date.now(),
  };
  lastRequestTs = sitePayload.ts;
  await chrome.storage.session.set({ [myKey]: sitePayload });
  const sites = await getSites();
  await applyRequest(sitePayload, sites);
}

for (const pane of [panes.top, panes.bottom]) {
  pane.el.addEventListener('pointerenter', () => {
    if (splitMode && !draggingSplit && focusedPane !== pane.name) {
      setFocusedPane(pane.name);
    }
  });
  const closeBtn = pane.el.querySelector('.pane-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.ctrlKey) {
        exitSplitKeeping(pane);
      } else {
        const otherPane = pane === panes.top ? panes.bottom : panes.top;
        exitSplitKeeping(otherPane);
      }
    });
    closeBtn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      exitSplitKeeping(pane);
    });
  }
}

await loadInitial();
