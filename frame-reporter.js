// Runs in every frame, but only does anything in a page that's framed directly by a SideSites side
// panel. It tells the side panel:
//   1. The page's current URL (including in-page navigations in single-page apps), which the side
//      panel can't read itself because the page is cross-origin. That's what lets "Open side site
//      in a new tab" open the page you're actually looking at.
//   2. The minimum width the page needs when its layout is wider than the sidebar, so the side panel
//      can zoom the frame down to fit and smoothly zoom it back up as the sidebar is widened.
(() => {
  const ancestors = location.ancestorOrigins;
  if (ancestors?.length !== 1 || ancestors[0] !== `chrome-extension://${chrome.runtime.id}`) return;
  const parentOrigin = ancestors[0];

  // ---- URL reporting ----

  let lastUrl = null;
  let lastWidth = 0;
  let lastViewportMatchWidth = 0;

  const reportUrl = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    window.parent.postMessage({ type: 'sidesites-frame-url', url: location.href }, parentOrigin);
    scheduleMeasure(400);
  };

  // ---- Content-width reporting (for zoom-to-fit) ----

  // Cap at a small-desktop width so a stray offscreen element can't shrink the page to a speck.
  const MAX_FIT_WIDTH = 1024;
  const OVERFLOW_TOLERANCE = 4;

  const LAYOUT_SELECTORS = [
    'main',
    'header',
    'nav',
    'article',
    'section',
    '[role="main"]',
    '[role="feed"]',
    '[role="banner"]',
    '[role="navigation"]',
    '[role="article"]',
    'body > div',
    'body > div > div',
    '[role="main"] div',
  ].join(', ');

  let measureTimer = null;

  /**
   * True if `el` is inside a horizontally scrollable container (like a Stories/Reels carousel)
   * or a transformed sliding track whose children are meant to sit offscreen to the right.
   */
  function isInsideHorizontalScroller(el, viewportWidth) {
    let cur = el.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.getAttribute('aria-roledescription') === 'carousel') return true;
      const style = getComputedStyle(cur);
      if (
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        cur.clientWidth <= viewportWidth + OVERFLOW_TOLERANCE
      ) {
        return true;
      }
      if (style.transform !== 'none' && cur.scrollWidth > MAX_FIT_WIDTH) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function measureWidth() {
    measureTimer = null;
    const docEl = document.documentElement;
    if (!docEl) return;
    const clientWidth = docEl.clientWidth;
    if (!clientWidth) return;

    const scrollbarWidth = Math.max(0, window.innerWidth - clientWidth);
    let maxContentWidth = Math.max(docEl.scrollWidth, document.body?.scrollWidth ?? 0);

    // Many web apps (such as Facebook) put overflow-x: hidden on a wrapper div, which keeps
    // documentElement.scrollWidth equal to clientWidth while clipping inner columns on the right.
    // Inspect layout containers and visible blocks to find any that extend past the right edge.
    const candidates = document.querySelectorAll(LAYOUT_SELECTORS);
    const viewportHeight = window.innerHeight || 800;

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.height < 24 || rect.width <= 0) continue;
      if (rect.bottom <= 0 || rect.top >= viewportHeight * 2) continue;
      // Ignore offscreen items parked to the right inside a carousel.
      if (rect.left < -160 || rect.left > 120) continue;

      // Skip elements that already fit within clientWidth so rightMargin isn't added to
      // non-overflowing blocks (which would cause a feedback loop).
      if (rect.right <= clientWidth + OVERFLOW_TOLERANCE && rect.width <= clientWidth + OVERFLOW_TOLERANCE) {
        continue;
      }

      const rightMargin =
        rect.right > window.innerWidth + OVERFLOW_TOLERANCE ? Math.max(0, Math.min(rect.left, 24)) : 0;
      const span = Math.max(rect.right + rightMargin, rect.width);
      if (span <= clientWidth + OVERFLOW_TOLERANCE || span > MAX_FIT_WIDTH) continue;
      if (isInsideHorizontalScroller(el, clientWidth)) continue;

      if (span > maxContentWidth) maxContentWidth = span;
    }

    if (maxContentWidth <= clientWidth + OVERFLOW_TOLERANCE) return;

    // If maxContentWidth equals window.innerWidth when a scrollbar is present, it could be a
    // fixed-width layout that needs scrollbarWidth added (e.g. when the scrollbar just appeared),
    // OR a 100vw element that tracks window.innerWidth. Allow one adjustment; if it still matches
    // the new, wider window.innerWidth afterwards, it's viewport-relative (100vw) so stop.
    if (scrollbarWidth > 0 && Math.abs(maxContentWidth - window.innerWidth) <= 2) {
      if (lastViewportMatchWidth > 0 && window.innerWidth > lastViewportMatchWidth) return;
      lastViewportMatchWidth = window.innerWidth;
    }

    const needed = Math.min(Math.ceil(maxContentWidth + scrollbarWidth), MAX_FIT_WIDTH);
    if (needed > lastWidth + 8) {
      lastWidth = needed;
      window.parent.postMessage({ type: 'sidesites-content-width', width: needed }, parentOrigin);
    }
  }

  function scheduleMeasure(delay = 350) {
    clearTimeout(measureTimer);
    measureTimer = setTimeout(measureWidth, delay);
  }

  // ---- Site-specific cleanups (Facebook mobile "Open app" floating button) ----

  const isFacebook =
    location.hostname === 'facebook.com' || location.hostname.endsWith('.facebook.com');
  const FB_OPEN_APP_RE = /^(open( in)? app|use( the)? app|get( the)?( facebook)? app)$/i;

  function removeFacebookOpenApp() {
    if (!isFacebook || !document.body) return;

    const hideBannerContainer = (el) => {
      let target = el;
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const rect = p.getBoundingClientRect();
        if (rect.height > 140) break;
        const pos = getComputedStyle(p).position;
        const role = p.getAttribute('role');
        const textLen = (p.innerText || p.textContent || '').trim().length;
        if (pos === 'fixed' || pos === 'sticky' || role === 'button' || textLen <= 32) {
          target = p;
        }
      }
      target.style.setProperty('display', 'none', 'important');
    };

    for (const link of document.querySelectorAll(
      'a[href^="intent:"], a[href^="fb:"], a[href*="com.facebook.katana"]'
    )) {
      hideBannerContainer(link);
    }

    for (const el of document.querySelectorAll('[role="button"], button, a, span, div')) {
      if (el.childElementCount > 4) continue;
      const label = (el.getAttribute('aria-label') || '').trim();
      const text = (el.textContent || '').trim();
      if (FB_OPEN_APP_RE.test(text) || FB_OPEN_APP_RE.test(label)) {
        hideBannerContainer(el);
      }
    }
  }

  /**
   * Many mobile/responsive sites size outer wrappers to 100vw, which assumes mobile overlay
   * scrollbars (0px). On desktop, a classic ~15px vertical scrollbar overlaps 100vw content
   * and can trigger resize loops. Hiding the page scrollbar keeps clientWidth === window.innerWidth
   * in the side panel frame without affecting ordinary browser tabs.
   */
  function hideScrollbar() {
    if (document.getElementById('sidesites-scrollbar-hide')) return;
    const style = document.createElement('style');
    style.id = 'sidesites-scrollbar-hide';
    style.textContent = `
      html, body { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
    `;
    (document.head || document.documentElement)?.appendChild(style);
  }

  function startObservers() {
    hideScrollbar();
    removeFacebookOpenApp();
    scheduleMeasure(350);
    // Re-check after async app shells (like Facebook's feed) finish mounting.
    setTimeout(() => {
      removeFacebookOpenApp();
      measureWidth();
    }, 1200);

    const ro = new ResizeObserver(() => scheduleMeasure(250));
    if (document.documentElement) ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);

    const mo = new MutationObserver(() => {
      hideScrollbar();
      removeFacebookOpenApp();
      scheduleMeasure(350);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    if (event.data?.type !== 'sidesites-nav') return;
    if (event.data.action === 'back') history.back();
    else if (event.data.action === 'forward') history.forward();
    else if (event.data.action === 'reload') location.reload();
  });

  reportUrl();
  window.navigation?.addEventListener('currententrychange', reportUrl);
  window.addEventListener('popstate', reportUrl);
  window.addEventListener('hashchange', reportUrl);
  window.addEventListener('pageshow', () => {
    reportUrl();
    scheduleMeasure(0);
  });
  window.addEventListener('resize', () => scheduleMeasure(100));
  window.addEventListener('load', () => scheduleMeasure(0));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObservers, { once: true });
  } else {
    startObservers();
  }
})();
