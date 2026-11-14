// SideSites background service worker.
//
// Sites that send X-Frame-Options / CSP frame-ancestors headers or check Sec-Fetch-* request headers
// normally refuse to load inside an <iframe>. To get them into the side panel we:
//
//   1. Make the side panel's frame requests look like top-level navigations (Sec-Fetch-* headers).
//   2. Strip the response headers that forbid framing.
//   3. Clear cached service workers / caches for configured sites, since responses served by a
//      previously-installed service worker bypass the header rewriting.
//
// The rules are scoped to tabId -1 (TAB_ID_NONE), i.e. requests that don't belong to a browser tab,
// which is where side panel frames live. Ordinary browsing in tabs is never affected.

import {
  getSites, originOf, relatedOriginsOf, ruleDomainsForSite, isMobile, mobileUserAgent,
  windowKey, currentPageKey, SITES_KEY,
} from './sites.js';

const RULE_SPOOF_NAVIGATION = 1;
const RULE_ALLOW_FRAMING = 2;
const RULE_MOBILE_UA_TO_SITE = 3;
const RULE_MOBILE_UA_FROM_SITE = 4;
const ALL_RULE_IDS = [
  RULE_SPOOF_NAVIGATION,
  RULE_ALLOW_FRAMING,
  RULE_MOBILE_UA_TO_SITE,
  RULE_MOBILE_UA_FROM_SITE,
];

const MOBILE_UA_SCRIPT_ID = 'mobile-ua';

const NOT_IN_A_TAB = [chrome.tabs?.TAB_ID_NONE ?? -1];

// Security policy override #1: Strip response headers that block cross-origin framing or isolate
// browsing contexts.
//   - X-Frame-Options / Frame-Options: legacy anti-clickjacking headers (DENY / SAMEORIGIN) that tell
//     the browser to refuse to render the document inside an <iframe>.
//   - Content-Security-Policy: may contain a `frame-ancestors` directive restricting which origins
//     can embed the page.
//   - Cross-Origin-Resource-Policy (CORP) / Cross-Origin-Opener-Policy (COOP) /
//     Cross-Origin-Embedder-Policy (COEP): cross-origin isolation headers that can block sub-frame
//     loads, subresources, or OAuth popups when embedded inside the extension's side panel page.
const FRAMING_RESPONSE_HEADERS = [
  'x-frame-options',
  'frame-options',
  'content-security-policy',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
].map((header) => ({ header, operation: 'remove' }));

// Security policy override #2: Spoof W3C Fetch Metadata request headers (`Sec-Fetch-*`).
// Normally, Chrome labels an <iframe> load inside `chrome-extension://<id>/sidepanel.html` with
// `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site`. Many servers (Google, banking/auth
// endpoints, etc.) inspect Fetch Metadata and reject framed or cross-site requests outright.
// Overwriting these headers on `sub_frame` navigations makes them look like direct, top-level
// browser navigations.
const NAVIGATION_REQUEST_HEADERS = [
  { header: 'Sec-Fetch-Dest', operation: 'set', value: 'document' },
  { header: 'Sec-Fetch-Site', operation: 'set', value: 'none' },
  { header: 'Sec-Fetch-Mode', operation: 'set', value: 'navigate' },
];

// Security policy / identity override #3: Spoof User-Agent and User-Agent Client Hints (`Sec-CH-UA-*`)
// for sites configured to use the Mobile version. We overwrite `User-Agent`, `Sec-CH-UA-Mobile`, and
// `Sec-CH-UA-Platform`, and strip high-entropy desktop client-hint headers (`Sec-CH-UA-Arch`,
// `Sec-CH-UA-Bitness`, `Sec-CH-UA-Platform-Version`, etc.) that would otherwise leak the desktop OS.
const MOBILE_REQUEST_HEADERS = [
  { header: 'User-Agent', operation: 'set', value: mobileUserAgent() },
  { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?1' },
  { header: 'Sec-CH-UA-Platform', operation: 'set', value: '"Android"' },
  ...[
    'Sec-CH-UA-Platform-Version',
    'Sec-CH-UA-Arch',
    'Sec-CH-UA-Bitness',
    'Sec-CH-UA-WoW64',
    'Sec-CH-UA-Model',
    'Sec-CH-UA-Form-Factors',
  ].map((header) => ({ header, operation: 'remove' })),
];

function uniqueRuleDomains(sites) {
  return [...new Set(sites.flatMap((s) => ruleDomainsForSite(s.url)))];
}

/**
 * Sites currently showing in a sidebar that aren't in the saved list (opened with "Open URL in
 * sidebar" or "Open current tab as side site"). They need rules and cookie access too.
 */
async function getAdHocSites() {
  const [saved, session] = await Promise.all([getSites(), chrome.storage.session.get(null)]);
  const savedIds = new Set(saved.map((s) => s.id));
  const candidates = Object.entries(session)
    .filter(([key]) => key.startsWith('win:'))
    .flatMap(([, value]) => (value?.mode === 'split' ? [value.top, value.bottom] : [value]));
  return candidates.filter((site) => site?.url && !savedIds.has(site.id));
}

// Rule updates can be triggered from several places at once; run them one at a time.
let updateChain = Promise.resolve();
function updateRules() {
  updateChain = updateChain.then(applyRules).catch(console.error);
  return updateChain;
}

async function applyRules() {
  const sites = [...(await getSites()), ...(await getAdHocSites())];

  // The user agent is switched per site domain, so if two sites on the same domain disagree,
  // "mobile" (the deliberate, non-default choice) wins.
  const mobileDomains = uniqueRuleDomains(sites.filter(isMobile));

  const addRules = [
    {
      id: RULE_SPOOF_NAVIGATION,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: NAVIGATION_REQUEST_HEADERS },
      condition: {
        tabIds: NOT_IN_A_TAB,
        resourceTypes: ['sub_frame'],
      },
    },
    {
      id: RULE_ALLOW_FRAMING,
      priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: FRAMING_RESPONSE_HEADERS },
      condition: {
        tabIds: NOT_IN_A_TAB,
        resourceTypes: ['sub_frame', 'xmlhttprequest', 'other'],
      },
    },
  ];

  // Sites set to "mobile": send a mobile user agent with the page itself and everything it loads.
  // (Omitting resourceTypes matches every request type except top-level tab navigations.)
  if (mobileDomains.length) {
    addRules.push(
      {
        id: RULE_MOBILE_UA_TO_SITE,
        priority: 2,
        action: { type: 'modifyHeaders', requestHeaders: MOBILE_REQUEST_HEADERS },
        condition: { tabIds: NOT_IN_A_TAB, requestDomains: mobileDomains },
      },
      {
        id: RULE_MOBILE_UA_FROM_SITE,
        priority: 2,
        action: { type: 'modifyHeaders', requestHeaders: MOBILE_REQUEST_HEADERS },
        condition: { tabIds: NOT_IN_A_TAB, initiatorDomains: mobileDomains },
      }
    );
  }

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ALL_RULE_IDS, addRules });
  await updateMobileUaScript(mobileDomains);
}

/**
 * Registers mobile-ua.js on "mobile" sites so that navigator.userAgent etc. agree with the
 * User-Agent header. The script itself checks that it's running inside the side panel.
 */
async function updateMobileUaScript(mobileDomains) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [MOBILE_UA_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [MOBILE_UA_SCRIPT_ID] });
  if (!mobileDomains.length) return;

  const matches = mobileDomains.flatMap((host) =>
    /[a-z]/i.test(host) ? [`*://${host}/*`, `*://*.${host}/*`] : [`*://${host}/*`]
  );
  await chrome.scripting.registerContentScripts([
    {
      id: MOBILE_UA_SCRIPT_ID,
      js: ['mobile-ua.js'],
      matches,
      allFrames: true,
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: false,
    },
  ]);
}

// ---- Security policy override #4: Evicting cached service workers and HTTP caches ----
//
// If the user previously visited a site in a normal browser tab, that site may have registered a
// Service Worker or cached responses in CacheStorage / the HTTP cache that still carry the original
// `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` headers. Responses served directly
// by an existing Service Worker from its cache can bypass `declarativeNetRequest` header stripping,
// and cached desktop responses won't reflect a switch to a Mobile user agent. We therefore clear
// service workers, CacheStorage, and HTTP cache for configured sites (and their mobile/www companion
// origins) when added, when their Desktop/Mobile mode changes, and on browser startup.
async function clearCachedFramingHeaders(urls) {
  const origins = [...new Set(urls.flatMap(relatedOriginsOf))];
  if (!origins.length) return;
  await chrome.browsingData.remove(
    { origins },
    { serviceWorkers: true, cacheStorage: true, cache: true }
  );
}

// Cache clearing kicked off by the most recent settings change (the side panel waits for it).
let pendingCacheClear = Promise.resolve();

async function clearAllConfiguredSites() {
  const sites = await getSites();
  await clearCachedFramingHeaders(sites.map((s) => s.url));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[SITES_KEY]) return;
  updateRules();

  // Clear caches for origins that weren't configured before, or whose user agent setting changed
  // (cached pages may have been built for the other kind of device).
  const before = new Map((changes[SITES_KEY].oldValue ?? []).map((s) => [originOf(s.url), isMobile(s)]));
  const changed = (changes[SITES_KEY].newValue ?? [])
    .filter((s) => before.get(originOf(s.url)) !== isMobile(s))
    .map((s) => s.url);
  pendingCacheClear = clearCachedFramingHeaders(changed).catch(console.error);
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  pendingCacheClear = clearAllConfiguredSites().catch(console.error);
  if (reason === 'install' && !(await getSites()).length) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  pendingCacheClear = clearAllConfiguredSites().catch(console.error);
});

// Session rules don't survive a browser restart, so (re)install them whenever the worker starts.
updateRules();

// The side panel asks for this before loading each site, so the rules are guaranteed to be in place
// and up to date before the iframe makes its first request.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ensure-rules') return;
  ensureReadyFor(msg.site)
    .catch(console.error)
    .then(() => sendResponse({ ok: true }));
  return true; // keep the channel open for the async response
});

async function ensureReadyFor(site) {
  await updateRules();
  await pendingCacheClear;
  if (site?.url) {
    const savedOrigins = new Set((await getSites()).map((s) => originOf(s.url)));
    // Saved sites' caches are cleared when they're added and at startup. An unsaved site may have a
    // service worker installed from ordinary browsing, which would bypass the header rewriting.
    if (!savedOrigins.has(originOf(site.url))) {
      await clearCachedFramingHeaders([site.url]);
    }
  }
}

// Forget which site a window's sidebar was showing once the window is gone.
chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.session.remove([windowKey(windowId), currentPageKey(windowId)]).then(updateRules);
});
