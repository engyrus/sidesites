import {
  getSites, saveSites, newId, normalizeUrl, hostnameOf, canonicalHost, faviconUrl, isMobile, isFit,
  SITES_KEY, UA_DESKTOP, UA_MOBILE,
} from './sites.js';

const list = document.getElementById('sites');
const template = document.getElementById('row-template');
const addForm = document.getElementById('add');
const addTitle = document.getElementById('add-title');
const addUrl = document.getElementById('add-url');
const addUa = document.getElementById('add-ua');
const addFit = document.getElementById('add-fit');
const addError = document.getElementById('add-error');

let sites = await getSites();

// Suggestions for the "Popular sites" section, grouped by category. userAgent is the version that
// suits a narrow sidebar best.
const POPULAR_CATEGORIES = [
  {
    name: 'Chat',
    sites: [
      { title: 'Messages', url: 'https://messages.google.com/web/' },
      { title: 'WhatsApp', url: 'https://web.whatsapp.com/' },
      { title: 'Telegram', url: 'https://web.telegram.org/' },
      { title: 'Discord', url: 'https://discord.com/app' },
      { title: 'Slack', url: 'https://app.slack.com/client' },
    ],
  },
  {
    name: 'Music',
    sites: [
      { title: 'Spotify', url: 'https://open.spotify.com/' },
      { title: 'YouTube Music', url: 'https://music.youtube.com/' },
    ],
  },
  {
    name: 'AI assistants',
    sites: [
      { title: 'Gemini', url: 'https://gemini.google.com/' },
      { title: 'ChatGPT', url: 'https://chatgpt.com/' },
      { title: 'Claude', url: 'https://claude.ai/' },
      { title: 'Perplexity', url: 'https://www.perplexity.ai/' },
    ],
  },
  {
    name: 'Productivity',
    sites: [
      { title: 'Google Calendar', url: 'https://calendar.google.com/' },
      { title: 'Google Keep', url: 'https://keep.google.com/' },
    ],
  },
  {
    name: 'Reference',
    sites: [
      { title: 'Wikipedia', url: 'https://en.wikipedia.org/', userAgent: UA_MOBILE },
      { title: 'Dictionary', url: 'https://www.merriam-webster.com/' },
      { title: 'Thesaurus', url: 'https://www.merriam-webster.com/thesaurus' },
      { title: 'Google Translate', url: 'https://translate.google.com/' },
    ],
  },
  {
    name: 'Social',
    sites: [
      { title: 'Reddit', url: 'https://www.reddit.com/', userAgent: UA_MOBILE },
      { title: 'Bluesky', url: 'https://bsky.app/' },
      { title: 'Facebook', url: 'https://www.facebook.com/', userAgent: UA_MOBILE, fit: true },
      { title: 'Xitter', url: 'https://x.com/', userAgent: UA_MOBILE },
    ],
  },
  {
    name: 'Shopping',
    sites: [
      { title: 'Shop', url: 'https://shop.app/' },
    ],
  },
];

/**
 * True if the user already has this popular site. When a popular entry represents the root of a
 * site, any URL on that host counts unless another popular entry on the same host has a more
 * specific path that matches instead (e.g. Dictionary vs Thesaurus).
 */
const ALL_POPULAR = POPULAR_CATEGORIES.flatMap((c) => c.sites);

function hasSite(popular) {
  const p = new URL(popular.url);
  const pHost = canonicalHost(p.hostname);
  return sites.some((s) => {
    try {
      const u = new URL(s.url);
      if (canonicalHost(u.hostname) !== pHost || !u.pathname.startsWith(p.pathname)) return false;
      return !ALL_POPULAR.some((other) => {
        if (other === popular) return false;
        const o = new URL(other.url);
        return (
          canonicalHost(o.hostname) === pHost &&
          o.pathname.length > p.pathname.length &&
          u.pathname.startsWith(o.pathname)
        );
      });
    } catch {
      return false;
    }
  });
}

function renderPopular() {
  const container = document.getElementById('popular');
  container.replaceChildren(
    ...POPULAR_CATEGORIES.map((category) => {
      const group = document.createElement('div');
      group.className = 'popular-group';

      const heading = document.createElement('h3');
      heading.textContent = category.name;

      const row = document.createElement('div');
      row.className = 'popular';
      row.append(
        ...category.sites.map((popular) => {
          const button = document.createElement('button');
          button.type = 'button';
          const icon = document.createElement('img');
          icon.alt = '';
          icon.src = faviconUrl(popular.url, 16);
          const label = document.createElement('span');
          label.textContent = popular.title;
          button.append(icon, label);

          const added = hasSite(popular);
          button.disabled = added;
          button.title = added ? `${popular.title} is already in your list` : `Add ${popular.url}`;
          button.addEventListener('click', () => {
            sites.push({
              id: newId(),
              title: popular.title,
              url: popular.url,
              userAgent: popular.userAgent ?? UA_DESKTOP,
              fit: Boolean(popular.fit),
            });
            render();
            commit();
          });
          return button;
        })
      );

      group.append(heading, row);
      return group;
    })
  );
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const UA_ICONS = {
  // Monitor on a stand
  [UA_DESKTOP]: 'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6z',
  // Phone
  [UA_MOBILE]: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v13h8V5zm4 14.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z',
};

/** Shows a Desktop/Mobile toggle button's current state. */
function renderUaButton(button, mode) {
  const mobile = mode === UA_MOBILE;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', UA_ICONS[mobile ? UA_MOBILE : UA_DESKTOP]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  const label = document.createElement('span');
  label.textContent = mobile ? 'Mobile' : 'Desktop';
  button.replaceChildren(svg, label);
  button.dataset.mode = mobile ? UA_MOBILE : UA_DESKTOP;
  button.setAttribute('aria-pressed', String(mobile));
  button.setAttribute('aria-label', 'Use mobile version');
  button.title = mobile
    ? 'Requesting the mobile version of this site. Click to request the desktop version.'
    : 'Requesting the desktop version of this site. Click to request the mobile version.';
}

function toggledMode(mode) {
  return mode === UA_MOBILE ? UA_DESKTOP : UA_MOBILE;
}

async function commit() {
  await saveSites(sites);
}

function move(from, to) {
  if (to < 0 || to >= sites.length || from === to) return;
  const [site] = sites.splice(from, 1);
  sites.splice(to, 0, site);
  render();
  commit();
}

function render() {
  // Preserve focus across re-renders where possible.
  const focused = document.activeElement;
  const focusId = focused?.closest?.('.site')?.dataset.id;
  const focusClass = focused?.className.split(' ')[0];

  list.replaceChildren();
  document.getElementById('empty').hidden = sites.length > 0;

  sites.forEach((site, index) => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.id = site.id;
    row.dataset.index = String(index);

    const favicon = row.querySelector('.favicon');
    const title = row.querySelector('.title');
    const url = row.querySelector('.url');
    favicon.src = faviconUrl(site.url, 16);
    title.value = site.title;
    title.placeholder = hostnameOf(site.url);
    url.value = site.url;

    title.addEventListener('change', () => {
      site.title = title.value.trim();
      commit();
    });

    url.addEventListener('input', () => url.classList.toggle('invalid', !normalizeUrl(url.value)));
    url.addEventListener('change', () => {
      const normalized = normalizeUrl(url.value);
      if (!normalized) return; // leave the invalid text in place, marked red, without saving
      site.url = normalized;
      url.value = normalized;
      title.placeholder = hostnameOf(normalized);
      favicon.src = faviconUrl(normalized, 16);
      renderPopular();
      commit();
    });

    const ua = row.querySelector('.ua');
    renderUaButton(ua, isMobile(site) ? UA_MOBILE : UA_DESKTOP);
    ua.addEventListener('click', () => {
      site.userAgent = toggledMode(ua.dataset.mode);
      renderUaButton(ua, site.userAgent);
      commit();
    });

    const fit = row.querySelector('.fit');
    fit.checked = isFit(site);
    fit.addEventListener('change', () => {
      site.fit = fit.checked;
      commit();
    });

    const up = row.querySelector('.up');
    const down = row.querySelector('.down');
    up.disabled = index === 0;
    down.disabled = index === sites.length - 1;
    up.addEventListener('click', () => move(index, index - 1));
    down.addEventListener('click', () => move(index, index + 1));

    row.querySelector('.remove').addEventListener('click', () => {
      const label = site.title || hostnameOf(site.url);
      if (!confirm(`Remove "${label}" from SideSites?`)) return;
      sites.splice(index, 1);
      render();
      commit();
    });

    // Alt+Up / Alt+Down within a row also reorders it.
    row.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      move(index, event.key === 'ArrowUp' ? index - 1 : index + 1);
    });

    setUpDrag(row, index);
    list.append(row);
  });

  if (focusId && focusClass) {
    list.querySelector(`.site[data-id="${CSS.escape(focusId)}"] .${CSS.escape(focusClass)}`)?.focus();
  }
  renderPopular();
}

// ---- Drag and drop reordering (drag by the handle only, so text in the inputs stays selectable) ----

let dragIndex = null;

function clearDropMarkers() {
  list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

function setUpDrag(row, index) {
  const handle = row.querySelector('.handle');
  handle.addEventListener('mousedown', () => (row.draggable = true));
  handle.addEventListener('mouseup', () => (row.draggable = false));

  row.addEventListener('dragstart', (event) => {
    dragIndex = index;
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  });

  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('dragging');
    clearDropMarkers();
    dragIndex = null;
  });

  row.addEventListener('dragover', (event) => {
    if (dragIndex === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const { top, height } = row.getBoundingClientRect();
    const after = event.clientY > top + height / 2;
    clearDropMarkers();
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });

  row.addEventListener('drop', (event) => {
    if (dragIndex === null) return;
    event.preventDefault();
    const { top, height } = row.getBoundingClientRect();
    const after = event.clientY > top + height / 2;
    let target = index + (after ? 1 : 0);
    if (dragIndex < target) target -= 1;
    move(dragIndex, target);
  });
}

// ---- Adding sites ----

function showAddError(message) {
  addError.textContent = message;
  addError.hidden = !message;
}

addUrl.addEventListener('input', () => {
  addUrl.classList.remove('invalid');
  showAddError('');
});

addUa.addEventListener('click', () => renderUaButton(addUa, toggledMode(addUa.dataset.mode)));
renderUaButton(addUa, UA_DESKTOP);

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = normalizeUrl(addUrl.value);
  if (!url) {
    addUrl.classList.add('invalid');
    showAddError('Please enter a valid web address starting with http:// or https://.');
    addUrl.focus();
    return;
  }
  sites.push({
    id: newId(),
    title: addTitle.value.trim() || hostnameOf(url),
    url,
    userAgent: addUa.dataset.mode,
    fit: addFit.checked,
  });
  addForm.reset();
  renderUaButton(addUa, UA_DESKTOP);
  showAddError('');
  render();
  commit();
  addTitle.focus();
});

// ---- Misc ----

const REMEMBER_SPLIT_PANE_KEY = 'rememberSplitPane';
const rememberSplitBox = document.getElementById('remember-split-pane');
chrome.storage.local.get(REMEMBER_SPLIT_PANE_KEY).then(({ [REMEMBER_SPLIT_PANE_KEY]: val }) => {
  rememberSplitBox.checked = Boolean(val);
});
rememberSplitBox.addEventListener('change', () => {
  chrome.storage.local.set({ [REMEMBER_SPLIT_PANE_KEY]: rememberSplitBox.checked });
});

document.getElementById('shortcuts').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Pick up changes made elsewhere (another settings tab, or sync from another device).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[REMEMBER_SPLIT_PANE_KEY]) {
    rememberSplitBox.checked = Boolean(changes[REMEMBER_SPLIT_PANE_KEY].newValue);
    return;
  }
  if (area !== 'sync' || !changes[SITES_KEY]) return;
  const incoming = changes[SITES_KEY].newValue ?? [];
  if (JSON.stringify(incoming) === JSON.stringify(sites)) return;
  sites = incoming;
  render();
});

render();
