// Shared helpers for reading and writing the user's site list and sidebar state.
//
// Storage layout:
//   chrome.storage.sync    sites: [{ id, title, url, userAgent }] -- the user's configured sites, in menu order
//                          (userAgent is 'desktop' or 'mobile'; missing means 'desktop')
//   chrome.storage.local   lastSiteId: string            -- last site shown (used when a sidebar opens fresh)
//   chrome.storage.session win:<windowId>: { id, url, ts } -- site requested for a given window's sidebar
//   chrome.storage.session cur:<windowId>: { url }        -- page currently showing in that window's sidebar

export const SITES_KEY = 'sites';
export const PAIRS_KEY = 'pairs';
export const LAST_SITE_KEY = 'lastSiteId';
export const SITE_FIT_KEY = 'siteFit';

export const UA_DESKTOP = 'desktop';
export const UA_MOBILE = 'mobile';

export function isMobile(site) {
  return site?.userAgent === UA_MOBILE;
}

export function isFit(site) {
  return Boolean(site?.fit);
}

/**
 * The user agent sent for sites set to "mobile": Chrome for Android, in Chrome's reduced-UA format,
 * with the same major version as the running browser. (mobile-ua.js builds the same string.)
 */
export function mobileUserAgent() {
  const major = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '130';
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

export function windowKey(windowId) {
  return `win:${windowId}`;
}

export function currentPageKey(windowId) {
  return `cur:${windowId}`;
}

export async function getSites() {
  const { [SITES_KEY]: sites } = await chrome.storage.sync.get(SITES_KEY);
  return Array.isArray(sites) ? sites : [];
}

export async function saveSites(sites) {
  await chrome.storage.sync.set({ [SITES_KEY]: sites });
}

export async function getPairs() {
  const { [PAIRS_KEY]: pairs } = await chrome.storage.sync.get(PAIRS_KEY);
  return Array.isArray(pairs) ? pairs : [];
}

export async function savePairs(pairs) {
  await chrome.storage.sync.set({ [PAIRS_KEY]: pairs });
}

export function newId() {
  return crypto.randomUUID();
}

/**
 * Normalizes user-entered URL text. Adds https:// when no scheme is given.
 * Returns the normalized URL string, or null if it isn't a valid http(s) URL.
 */
export function normalizeUrl(text) {
  let value = String(text ?? '').trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Returns the URL's origin plus likely mobile/desktop companion origins (e.g. m.example.com and
 * en.m.wikipedia.org for en.wikipedia.org) so cache clearing covers mobile redirects too.
 */
export function relatedOriginsOf(url) {
  try {
    const u = new URL(url);
    const base = baseDomainOf(u.hostname);
    const canon = canonicalHost(u.hostname);
    const hosts = new Set([u.hostname, canon, `www.${canon}`, `m.${canon}`]);
    if (canon !== base && !MULTI_APP_BASE_DOMAINS.has(base)) {
      const prefix = canon.slice(0, -(base.length + 1));
      hosts.add(`${prefix}.m.${base}`);
      hosts.add(`m.${base}`);
    }
    return [...hosts].filter(Boolean).map((h) => `${u.protocol}//${h}`);
  } catch {
    return [];
  }
}

// Common second-level labels under 2-letter country-code TLDs (e.g. .co.uk, .com.au, .or.jp).
const CC_SECOND_LEVEL = new Set([
  'ac', 'asn', 'co', 'com', 'edu', 'go', 'gob', 'gon', 'gouv', 'gov', 'gr', 'id', 'ind',
  'lg', 'ltd', 'me', 'mil', 'ne', 'net', 'nic', 'nom', 'or', 'org', 'per', 'plc', 'pp',
  'sch', 'sld', 'tur', 'tv',
]);

// Multi-app or shared-hosting domains where independent apps live on distinct subdomains
// (e.g. mail.google.com vs calendar.google.com), so we shouldn't collapse to the base domain.
const MULTI_APP_BASE_DOMAINS = new Set([
  'google.com',
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'blogspot.com',
  'wordpress.com',
  'tumblr.com',
]);

/**
 * Extracts the registrable base domain of a hostname, accounting for 2-part country-code suffixes
 * like .co.uk or .com.au (so news.bbc.co.uk -> bbc.co.uk, and en.wikipedia.org -> wikipedia.org).
 */
export function baseDomainOf(urlOrHost) {
  const host = urlOrHost.includes('://') ? hostnameOf(urlOrHost) : String(urlOrHost).toLowerCase();
  if (!host || !/[a-z]/i.test(host)) return host; // IP address or empty
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const isTwoPartCcTld = tld.length === 2 && (CC_SECOND_LEVEL.has(sld) || sld.length <= 2);
  const keep = isTwoPartCcTld ? 3 : 2;
  return parts.slice(-Math.min(keep, parts.length)).join('.');
}

/**
 * Strips common web/mobile subdomain labels (www, m, mobile) so that e.g. en.m.wikipedia.org and
 * en.wikipedia.org, or m.facebook.com and www.facebook.com, compare equal, while distinct apps like
 * mail.google.com and calendar.google.com stay distinct.
 */
export function canonicalHost(urlOrHost) {
  const host = urlOrHost.includes('://') ? hostnameOf(urlOrHost) : String(urlOrHost).toLowerCase();
  const base = baseDomainOf(host);
  if (!base || host === base) return host;
  const prefix = host.slice(0, -(base.length + 1));
  const kept = prefix.split('.').filter((label) => label !== 'www' && label !== 'm' && label !== 'mobile');
  return kept.length ? `${kept.join('.')}.${base}` : base;
}

/**
 * Returns the domain(s) to match for a site in declarativeNetRequest / content-script rules.
 * Uses the base domain (covering redirects like en.wikipedia.org -> en.m.wikipedia.org) unless the
 * site lives on a multi-app domain like google.com, where we keep the app's own subdomain.
 */
export function ruleDomainsForSite(urlOrHost) {
  const host = canonicalHost(urlOrHost);
  if (!host) return [];
  const base = baseDomainOf(host);
  if (MULTI_APP_BASE_DOMAINS.has(base) && host !== base) {
    return [host, `m.${host}`];
  }
  return [base];
}

/** Key used to remember a site's zoom / content width per host and desktop/mobile mode. */
export function siteFitKey(site) {
  if (!site?.url) return '';
  return `${canonicalHost(site.url)}:${isMobile(site) ? UA_MOBILE : UA_DESKTOP}`;
}

/** Favicon URL served by the browser's own favicon cache (requires the "favicon" permission). */
export function faviconUrl(pageUrl, size = 32) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.href;
}
