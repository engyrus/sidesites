// Registered by background.js on sites set to use a mobile user agent.
//
// Security / isolation note:
// This script is injected into the page's MAIN execution world (`world: 'MAIN'`) at `document_start`
// so that it can monkey-patch `Navigator.prototype` (`userAgent`, `appVersion`, `platform`,
// `maxTouchPoints`, and `userAgentData`) before any of the site's own scripts run. Without this,
// sites that check `navigator.userAgent` or `navigator.userAgentData.mobile` in client-side JS would
// detect a desktop browser despite the spoofed HTTP `User-Agent` / `Sec-CH-UA-*` request headers.
//
// Because `chrome.scripting.registerContentScripts` matches by URL pattern across the browser, we
// check `location.ancestorOrigins` first and bail out immediately unless the top-level ancestor is
// `chrome-extension://`, ensuring ordinary browser tabs on the same domain are never affected.
(() => {
  // Only act when this page is embedded in an extension page (i.e. the SideSites side panel), never in
  // an ordinary tab.
  const ancestors = location.ancestorOrigins;
  if (!ancestors?.length || !ancestors[ancestors.length - 1].startsWith('chrome-extension://')) return;

  // Keep in sync with mobileUserAgent() in sites.js.
  const major = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '130';
  const userAgent = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;

  const proto = Navigator.prototype;
  const define = (prop, value) =>
    Object.defineProperty(proto, prop, { get: () => value, configurable: true, enumerable: true });

  define('userAgent', userAgent);
  define('appVersion', userAgent.slice('Mozilla/'.length));
  define('platform', 'Linux armv81');
  define('maxTouchPoints', 5);

  const real = navigator.userAgentData;
  if (real) {
    const brands = real.brands;
    const overrides = {
      mobile: true,
      platform: 'Android',
      platformVersion: '10.0.0',
      architecture: '',
      bitness: '',
      model: 'K',
      wow64: false,
      formFactors: ['Mobile'],
    };
    const fake = {
      brands,
      mobile: true,
      platform: 'Android',
      async getHighEntropyValues(hints = []) {
        const values = await real.getHighEntropyValues(hints);
        const result = { ...values, brands, mobile: true, platform: 'Android' };
        for (const hint of hints) if (hint in overrides) result[hint] = overrides[hint];
        return result;
      },
      toJSON() {
        return { brands, mobile: true, platform: 'Android' };
      },
    };
    Object.setPrototypeOf(fake, Object.getPrototypeOf(real));
    define('userAgentData', fake);
  }
})();
