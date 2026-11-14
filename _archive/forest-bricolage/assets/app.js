/* ==========================================================================
   Northstar shared runtime
   API client, geocoding, glossary tooltips, dropdowns, page chrome.
   ========================================================================== */

const API = 'https://clinicaltrials.gov/api/v2';

/* ---------- Tiny helpers ---------- */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// CT.gov text is markdown-ish with backslash escapes like "\>=" and "\<".
function unescapeMd(s) {
  return String(s ?? '').replace(/\\([<>=~^*_\[\]()#+\-.!|])/g, '$1');
}

function fmtNum(n) { return Number(n).toLocaleString('en-US'); }
function plural(n, one, many = one + 's') { return `${fmtNum(n)} ${n === 1 ? one : many}`; }

function parseDate(s) {
  if (!s) return null;
  const [y, m = '01', d = '01'] = s.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d));
}
function fmtDate(s, withDay = false) {
  const d = parseDate(s);
  if (!d) return null;
  const hasDay = s.split('-').length === 3;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', ...(withDay && hasDay ? { day: 'numeric' } : {}) });
}

// "18 Years" -> 18, "6 Months" -> 0.5
function ageYears(s) {
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(Year|Month|Week|Day|Hour|Minute)s?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return { year: n, month: n / 12, week: n / 52, day: n / 365, hour: 0, minute: 0 }[m[2].toLowerCase()];
}
// "18 Years" -> "18", "6 Months" -> "6 months"
function tidyAge(s) {
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(\w+)$/);
  if (!m) return s.toLowerCase();
  return /^years?$/i.test(m[2]) ? m[1] : `${m[1]} ${m[2].toLowerCase()}`;
}
function ageRange(min, max) {
  const lo = tidyAge(min), hi = tidyAge(max);
  if (lo && hi) return `Ages ${lo} to ${hi}`;
  if (lo) return `Ages ${lo} and up`;
  if (hi) return `Up to age ${hi}`;
  return 'Any age';
}

function milesBetween(a, b) {
  const R = 3958.8, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtMiles(mi) {
  if (mi == null) return '';
  if (mi < 1) return 'Under 1 mi';
  return `${fmtNum(Math.round(mi))} mi`;
}

/* ---------- API ---------- */
async function api(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ClinicalTrials.gov returned ${res.status}`);
  return res.json();
}

// Multi-word conditions search as an exact phrase. As loose words, "cervical cancer" also matches
// every other cancer and anything "cervical" (neck, spine), about 5 off-topic studies for each good one.
const isPhrase = q => /\s/.test(q.trim()) && !/["()]|\b(AND|OR|NOT)\b/.test(q);
function condQuery(q, loose = false) {
  const t = (q ?? '').trim();
  return !loose && isPhrase(t) ? `"${t}"` : t;
}

async function suggestConditions(q) {
  if (!q || q.length < 2) return [];
  try {
    const res = await fetch(`https://clinicaltrials.gov/api/int/suggest?input=${encodeURIComponent(q)}&dictionary=Condition`);
    if (!res.ok) return [];
    return (await res.json()).slice(0, 8);
  } catch { return []; }
}

let versionPromise;
function dataVersion() {
  versionPromise ??= api('/version').catch(() => null);
  return versionPromise;
}

/* ---------- Plain-language maps ---------- */
const STATUS = {
  RECRUITING:              { label: 'Recruiting',             tone: 'go' },
  NOT_YET_RECRUITING:      { label: 'Opening Soon',           tone: 'soon' },
  ENROLLING_BY_INVITATION: { label: 'By Invitation Only',     tone: 'soon' },
  ACTIVE_NOT_RECRUITING:   { label: 'Underway, Not Enrolling', tone: 'idle' },
  COMPLETED:               { label: 'Completed',              tone: 'idle' },
  SUSPENDED:               { label: 'Paused',                 tone: 'stop' },
  TERMINATED:              { label: 'Stopped Early',          tone: 'stop' },
  WITHDRAWN:               { label: 'Withdrawn',              tone: 'stop' },
  AVAILABLE:               { label: 'Available',              tone: 'go' },
  UNKNOWN:                 { label: 'Status Unknown',         tone: 'idle' },
};
function statusTag(code) {
  const s = STATUS[code] ?? { label: code ?? 'Unknown', tone: 'idle' };
  return `<span class="tag tag-${s.tone}"><span class="dot"></span>${esc(s.label)}</span>`;
}

const PHASE = {
  EARLY_PHASE1: { short: 'Early Phase 1', plain: 'First tests in people' },
  PHASE1:       { short: 'Phase 1',       plain: 'Is it safe?' },
  PHASE2:       { short: 'Phase 2',       plain: 'Does it work?' },
  PHASE3:       { short: 'Phase 3',       plain: 'Is it better?' },
  PHASE4:       { short: 'Phase 4',       plain: 'After approval' },
  NA:           null,
};
function phaseLabel(phases = [], studyType) {
  const known = phases.map(p => PHASE[p]).filter(Boolean);
  if (!known.length) return studyType === 'OBSERVATIONAL' ? 'Observational' : studyType === 'EXPANDED_ACCESS' ? 'Expanded Access' : null;
  if (known.length === 1) return `${known[0].short} · ${known[0].plain}`;
  return `${known.map(k => k.short.replace('Phase ', '')).join('/').replace(/^/, 'Phase ')} · ${known.at(-1).plain}`;
}

const INTERVENTION = {
  DRUG: 'Medicine', DEVICE: 'Device', BIOLOGICAL: 'Biologic', PROCEDURE: 'Procedure',
  RADIATION: 'Radiation', BEHAVIORAL: 'Behavioral', GENETIC: 'Genetic', DIETARY_SUPPLEMENT: 'Supplement',
  COMBINATION_PRODUCT: 'Combination', DIAGNOSTIC_TEST: 'Diagnostic Test', OTHER: 'Other',
};

const SEX = { ALL: 'All sexes', FEMALE: 'Women only', MALE: 'Men only' };

/* ---------- Glossary ---------- */
const GLOSSARY = {
  'randomized':        ['Randomized', 'People are placed into groups by chance, like a coin flip, so the groups are fair to compare.'],
  'randomised':        ['Randomized', 'People are placed into groups by chance, like a coin flip, so the groups are fair to compare.'],
  'placebo':           ['Placebo', 'Looks like the real treatment but has no active ingredient. It helps show whether the real one works.'],
  'double-blind':      ['Double-blind', 'Neither you nor the study team knows which treatment you are getting until the study ends.'],
  'double blind':      ['Double-blind', 'Neither you nor the study team knows which treatment you are getting until the study ends.'],
  'open-label':        ['Open-label', 'Everyone knows which treatment is being given. Nothing is hidden.'],
  'open label':        ['Open-label', 'Everyone knows which treatment is being given. Nothing is hidden.'],
  'efficacy':          ['Efficacy', 'How well a treatment works under study conditions.'],
  'tolerability':      ['Tolerability', 'How well people handle a treatment’s side effects.'],
  'pharmacokinetics':  ['Pharmacokinetics', 'How your body absorbs, moves, and clears a drug over time.'],
  'informed consent':  ['Informed consent', 'The process of learning about a study, asking questions, and agreeing in writing before joining. You can still leave at any time.'],
  'inclusion criteria':['Inclusion criteria', 'Things that must be true about you to join the study.'],
  'exclusion criteria':['Exclusion criteria', 'Things that would keep you from joining, usually for your safety.'],
  'comorbidit':        ['Comorbidity', 'Another health condition you have at the same time.'],
  'contraindicat':     ['Contraindication', 'A reason a treatment could be unsafe for you.'],
  'eGFR':              ['eGFR', 'A blood-test estimate of how well your kidneys filter. Higher is generally better.'],
  'HbA1c':             ['HbA1c', 'Your average blood sugar over the last two to three months.'],
  'BMI':               ['BMI', 'Body mass index, a rough measure of body size based on height and weight.'],
  'ECOG':              ['ECOG score', 'A 0 to 5 scale doctors use to describe how much a condition affects daily activity. 0 means fully active.'],
  'metastatic':        ['Metastatic', 'Cancer that has spread from where it started to other parts of the body.'],
  'refractory':        ['Refractory', 'A condition that has not responded to treatment.'],
  'relapsed':          ['Relapsed', 'A condition that came back after getting better.'],
  'adjuvant':          ['Adjuvant', 'Treatment given after the main treatment to lower the chance of it coming back.'],
  'pregnan':           ['Pregnancy rules', 'Many studies exclude pregnancy because effects on a baby are not yet known.'],
  'lactating':         ['Lactating', 'Breastfeeding or producing breast milk.'],
  'washout':           ['Washout', 'A break from a medicine so it leaves your body before the next step.'],
  'wash-out':          ['Washout', 'A break from a medicine so it leaves your body before the next step.'],
  'cohort':            ['Cohort', 'A group of participants who share something, like age or when they joined.'],
  'biomarker':         ['Biomarker', 'Something measurable in your body, like a protein in the blood, that signals a condition or response.'],
  'subcutaneous':      ['Subcutaneous', 'Given as a shot just under the skin.'],
  'intravenous':       ['Intravenous (IV)', 'Given through a vein, usually by a drip.'],
  'oral':              ['Oral', 'Taken by mouth.'],
  'primary outcome':   ['Primary outcome', 'The main thing the study is measuring to decide if the treatment works.'],
  'investigator':      ['Investigator', 'A doctor or scientist who runs the study at a site.'],
  'sponsor':           ['Sponsor', 'The company, university, or agency responsible for the study.'],
};
const GLOSS_KEYS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
const glossPattern = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]/g, '[-\\s]');
const GLOSS_MATCHERS = GLOSS_KEYS.map(k => [k, new RegExp(`^${glossPattern(k)}$`, 'i')]);
const GLOSS_RE = new RegExp(`\\b(${GLOSS_KEYS.map(glossPattern).join('|')})\\w*`, 'gi');

// Wraps glossary terms (first occurrence per `seen` set) in focusable buttons. Input must be escaped plain text.
function glossify(html, seen = new Set()) {
  return html.replace(GLOSS_RE, (match, stem) => {
    const key = GLOSS_MATCHERS.find(([, re]) => re.test(stem))?.[0];
    if (!key) return match;
    const [title] = GLOSSARY[key];
    if (seen.has(title)) return match;
    seen.add(title);
    return `<button type="button" class="term" data-term="${esc(key)}">${match}</button>`;
  });
}

function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current = null;

  function show(el) {
    const entry = GLOSSARY[el.dataset.term];
    if (!entry) return;
    current = el;
    tip.innerHTML = `<b>${esc(entry[0])}</b>${esc(entry[1])}`;
    const r = el.getBoundingClientRect();
    tip.classList.add('show');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = Math.min(Math.max(12, r.left + r.width / 2 - tw / 2), innerWidth - tw - 12);
    let top = r.top - th - 10;
    if (top < 76) top = r.bottom + 10;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hide() { current = null; tip.classList.remove('show'); }

  document.addEventListener('mouseover', e => { const t = e.target.closest('.term'); if (t) show(t); });
  document.addEventListener('mouseout',  e => { if (e.target.closest('.term')) hide(); });
  document.addEventListener('focusin',   e => { const t = e.target.closest('.term'); if (t) show(t); });
  document.addEventListener('focusout',  e => { if (e.target.closest('.term')) hide(); });
  document.addEventListener('click',     e => { const t = e.target.closest('.term'); if (t) { current === t ? hide() : show(t); } });
  addEventListener('scroll', hide, { passive: true });
}

/* ---------- Location ---------- */
// Offline fallback so location search works even if the geocoder is unreachable.
const US_CITIES = [
  ['New York', 'NY', 40.7128, -74.006], ['Los Angeles', 'CA', 34.0522, -118.2437], ['Chicago', 'IL', 41.8781, -87.6298],
  ['Houston', 'TX', 29.7604, -95.3698], ['Phoenix', 'AZ', 33.4484, -112.074], ['Philadelphia', 'PA', 39.9526, -75.1652],
  ['San Antonio', 'TX', 29.4241, -98.4936], ['San Diego', 'CA', 32.7157, -117.1611], ['Dallas', 'TX', 32.7767, -96.797],
  ['Austin', 'TX', 30.2672, -97.7431], ['San Jose', 'CA', 37.3382, -121.8863], ['Jacksonville', 'FL', 30.3322, -81.6557],
  ['Columbus', 'OH', 39.9612, -82.9988], ['Fort Worth', 'TX', 32.7555, -97.3308], ['Charlotte', 'NC', 35.2271, -80.8431],
  ['Indianapolis', 'IN', 39.7684, -86.1581], ['San Francisco', 'CA', 37.7749, -122.4194], ['Seattle', 'WA', 47.6062, -122.3321],
  ['Denver', 'CO', 39.7392, -104.9903], ['Washington', 'DC', 38.9072, -77.0369], ['Boston', 'MA', 42.3601, -71.0589],
  ['Nashville', 'TN', 36.1627, -86.7816], ['Detroit', 'MI', 42.3314, -83.0458], ['Portland', 'OR', 45.5152, -122.6784],
  ['Las Vegas', 'NV', 36.1699, -115.1398], ['Memphis', 'TN', 35.1495, -90.049], ['Louisville', 'KY', 38.2527, -85.7585],
  ['Baltimore', 'MD', 39.2904, -76.6122], ['Milwaukee', 'WI', 43.0389, -87.9065], ['Albuquerque', 'NM', 35.0844, -106.6504],
  ['Tucson', 'AZ', 32.2226, -110.9747], ['Sacramento', 'CA', 38.5816, -121.4944], ['Kansas City', 'MO', 39.0997, -94.5786],
  ['Atlanta', 'GA', 33.749, -84.388], ['Miami', 'FL', 25.7617, -80.1918], ['Raleigh', 'NC', 35.7796, -78.6382],
  ['Durham', 'NC', 35.994, -78.8986], ['Minneapolis', 'MN', 44.9778, -93.265], ['Rochester', 'MN', 44.0121, -92.4802],
  ['Cleveland', 'OH', 41.4993, -81.6944], ['Tampa', 'FL', 27.9506, -82.4572], ['Orlando', 'FL', 28.5383, -81.3792],
  ['Pittsburgh', 'PA', 40.4406, -79.9959], ['Cincinnati', 'OH', 39.1031, -84.512], ['St. Louis', 'MO', 38.627, -90.1994],
  ['Salt Lake City', 'UT', 40.7608, -111.891], ['New Orleans', 'LA', 29.9511, -90.0715], ['Birmingham', 'AL', 33.5186, -86.8104],
  ['Richmond', 'VA', 37.5407, -77.436], ['Omaha', 'NE', 41.2565, -95.9345], ['Oklahoma City', 'OK', 35.4676, -97.5164],
  ['Honolulu', 'HI', 21.3069, -157.8583], ['Anchorage', 'AK', 61.2181, -149.9003], ['Boise', 'ID', 43.615, -116.2023],
  ['Iowa City', 'IA', 41.6611, -91.5302], ['Ann Arbor', 'MI', 42.2808, -83.743], ['New Haven', 'CT', 41.3083, -72.9279],
  ['Providence', 'RI', 41.824, -71.4128], ['Buffalo', 'NY', 42.8864, -78.8784], ['Madison', 'WI', 43.0731, -89.4012],
  ['Palo Alto', 'CA', 37.4419, -122.143], ['Oakland', 'CA', 37.8044, -122.2712], ['Spokane', 'WA', 47.6588, -117.426],
  ['Charleston', 'SC', 32.7765, -79.9311], ['Little Rock', 'AR', 34.7465, -92.2896], ['Burlington', 'VT', 44.4759, -73.2121],
  ['Hershey', 'PA', 40.2859, -76.6502], ['Gainesville', 'FL', 29.6516, -82.3248], ['Chapel Hill', 'NC', 35.9132, -79.0558],
];

async function geocode(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const local = US_CITIES
    .filter(([c, s]) => `${c}, ${s}`.toLowerCase().startsWith(needle) || c.toLowerCase().includes(needle))
    .map(([c, s, lat, lon]) => ({ label: `${c}, ${s}`, lat, lon }));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.split(',')[0].trim())}&count=8&countryCode=US&language=en`, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const remote = (data.results ?? []).map(r => ({
      label: `${r.name}, ${STATE_ABBR[r.admin1] ?? r.admin1 ?? ''}`.replace(/, $/, ''),
      lat: r.latitude, lon: r.longitude,
    }));
    const seen = new Set();
    return [...local, ...remote].filter(r => (seen.has(r.label) ? false : seen.add(r.label))).slice(0, 8);
  } catch {
    return local.slice(0, 8);
  }
}

const STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'Puerto Rico': 'PR',
};

function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available in this browser.'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ label: 'My location', lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4) }),
      () => reject(new Error('We couldn’t get your location. Try typing a city instead.')),
      { timeout: 8000, maximumAge: 600000 },
    );
  });
}

/* ---------- Saved search (so detail pages know where "you" are) ---------- */
const SEARCH_KEY = 'northstar:search';
function saveSearch(s) { try { localStorage.setItem(SEARCH_KEY, JSON.stringify(s)); } catch {} }
function loadSearch() { try { return JSON.parse(localStorage.getItem(SEARCH_KEY)) ?? {}; } catch { return {}; } }
function searchToUrl(s) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v);
  return `results.html?${p}`;
}

/* ---------- Autocomplete input ---------- */
function autocomplete(input, { fetch: fetcher, render = x => esc(x), pick, minChars = 2 }) {
  const combo = input.closest('.combo');
  const menu = document.createElement('ul');
  menu.className = 'combo-menu';
  menu.setAttribute('role', 'listbox');
  combo.appendChild(menu);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  let items = [], active = -1, seq = 0, debounce;

  function close() { combo.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); active = -1; }
  function open() { if (items.length) { combo.classList.add('open'); input.setAttribute('aria-expanded', 'true'); } }
  function paint() {
    menu.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">${render(it)}</li>`).join('');
  }
  function choose(i) { const it = items[i]; if (!it) return; pick(it); close(); }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value;
    if (q.trim().length < minChars) { items = []; close(); return; }
    debounce = setTimeout(async () => {
      const mine = ++seq;
      const res = await fetcher(q);
      if (mine !== seq) return;
      items = res; active = -1; paint();
      items.length ? open() : close();
    }, 160);
  });
  input.addEventListener('keydown', e => {
    if (!combo.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') close();
  });
  menu.addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
  input.addEventListener('blur', () => setTimeout(close, 120));
  return { close, get items() { return items; } };
}

/* ---------- Custom dropdown (always opens below, never native <select>) ---------- */
function dropdown(button, { options, value, onChange }) {
  const combo = button.closest('.combo');
  const menu = document.createElement('ul');
  menu.className = 'combo-menu';
  menu.setAttribute('role', 'listbox');
  combo.appendChild(menu);
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const labelEl = button.querySelector('[data-label]') ?? button;

  let current = value;
  function paint() {
    menu.innerHTML = options.map(o => `<li role="option" data-v="${esc(o.value)}" aria-selected="false" class="${o.value === current ? 'check' : ''}">${esc(o.label)}</li>`).join('');
    labelEl.textContent = options.find(o => o.value === current)?.label ?? '';
  }
  function close() { combo.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); }
  button.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = combo.classList.toggle('open');
    button.setAttribute('aria-expanded', String(isOpen));
  });
  menu.addEventListener('click', e => {
    const li = e.target.closest('li[data-v]');
    if (!li) return;
    current = li.dataset.v;
    paint(); close();
    onChange?.(current);
  });
  document.addEventListener('click', e => { if (!combo.contains(e.target)) close(); });
  button.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  paint();
  return { get value() { return current; }, set value(v) { current = v; paint(); } };
}

// Autosize an inline sentence input to its rendered text (ch units overshoot on display fonts).
function autosize(input) {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
  document.body.appendChild(probe);
  const fit = () => {
    const cs = getComputedStyle(input);
    probe.style.font = cs.font;
    probe.style.letterSpacing = cs.letterSpacing;
    probe.textContent = input.value || input.placeholder;
    input.style.width = `${Math.ceil(probe.getBoundingClientRect().width) + 4}px`;
  };
  input.addEventListener('input', fit);
  fit();
  document.fonts?.ready.then(fit);
  return fit;
}

/* ---------- Eligibility text -> structured lists ---------- */
// Shared by the study page and the doctor summary. Item keys are i0, i1… (inclusion) and o0, o1… (exclusion).
function parseCriteria(text) {
  if (!text) return null;
  const groups = { in: [], out: [], pre: [] };
  let cur = 'pre';
  for (const raw of unescapeMd(text).replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) continue;
    const bare = raw.trim().replace(/[*_#]+/g, '').trim();
    const hdrIn = bare.match(/^(key\s+|main\s+)?inclusion(\s+criteria)?\s*:?\s*(.*)$/i);
    const hdrOut = bare.match(/^(key\s+|main\s+)?exclusion(\s+criteria)?\s*:?\s*(.*)$/i);
    if (hdrIn && (hdrIn[2] || bare.endsWith(':'))) { cur = 'in'; if (hdrIn[3]) groups.in.push({ text: hdrIn[3] }); continue; }
    if (hdrOut && (hdrOut[2] || bare.endsWith(':'))) { cur = 'out'; if (hdrOut[3]) groups.out.push({ text: hdrOut[3] }); continue; }
    const m = raw.match(/^(\s*)(?:[*\-•·]|\d{1,2}[.)]|[a-z][.)]|[ivx]{1,4}[.)])\s+(.+)$/i);
    if (m) groups[cur].push({ text: m[2].trim(), sub: m[1].replace(/\t/g, '    ').length >= 2 });
    else groups[cur].push({ text: bare, head: /:$/.test(bare) });
  }
  if (!groups.in.length && !groups.out.length) return null;
  if (groups.pre.length) groups.in = [...groups.pre, ...groups.in];
  return groups;
}


// Yes on an inclusion item, or No on an exclusion item, counts in your favor.
const rowState = (key, a) => !a ? '' : a === 'u' ? 'unsure' : (key[0] === 'i') === (a === 'y') ? 'fit' : 'block';

/* ---------- Toast ---------- */
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- Icons ---------- */
const I = {
  // Brand mark: a compass needle, solid north half, lighter south half, hollow pivot (cut out, not painted, so it works on any background).
  mark:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 15.4 12H8.6zM13.7 12a1.7 1.7 0 0 0-3.4 0z" fill="currentColor" fill-rule="evenodd"/><path d="M3 12l6.4-1.5v3zM21 12l-6.4-1.5v3z" fill="currentColor" opacity=".45"/><path d="M8.6 12h6.8L12 21.5zM10.3 12a1.7 1.7 0 0 0 3.4 0z" fill="currentColor" fill-rule="evenodd" opacity=".45"/></svg>',
  arrow:  '<svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  back:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H3M7 4L3 8l4 4"/></svg>',
  ext:    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5"/></svg>',
  chev:   '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>',
  pin:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14.5s5-4.6 5-8.5a5 5 0 0 0-10 0c0 3.9 5 8.5 5 8.5z"/><circle cx="8" cy="6" r="1.8"/></svg>',
  locate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/></svg>',
  person: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5" r="2.8"/><path d="M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/></svg>',
  people: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5.5" r="2.3"/><path d="M1.5 13.5c.5-2.4 2.2-3.6 4.5-3.6s4 1.2 4.5 3.6"/><circle cx="11.5" cy="5" r="1.8"/><path d="M11.5 9c1.7 0 2.8.9 3.1 2.6"/></svg>',
  pill:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="5.2" width="12.4" height="5.6" rx="2.8" transform="rotate(-35 8 8)"/><path d="M6.2 5.4l3.2 4.6"/></svg>',
  clock:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.3 1.5"/></svg>',
  flask:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.5h4M6.5 1.5v4.2L2.6 12.6a1.3 1.3 0 0 0 1.1 1.9h8.6a1.3 1.3 0 0 0 1.1-1.9L9.5 5.7V1.5"/><path d="M4.4 9.5h7.2"/></svg>',
  check:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>',
  x:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  q:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M6.8 6a1.3 1.3 0 1 1 1.7 1.2c-.4.2-.5.4-.5.8M8 9.2h.01"/></svg>',
  phone:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2h3l1.5 3.5-2 1.3a8 8 0 0 0 3.7 3.7l1.3-2L14 10v3a1 1 0 0 1-1 1A11 11 0 0 1 2 3a1 1 0 0 1 1-1z"/></svg>',
  mail:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M2 4l6 4.5L14 4"/></svg>',
  shuffle:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5h2.8c3.6 0 3.8 7 7.4 7h2.8M12.2 9.2l2.3 2.3-2.3 2.3M1.5 11.5h2.8c1.3 0 2-.9 2.6-2M9.2 6.5c.6-1.1 1.3-2 2.5-2h2.8M12.2 2.2l2.3 2.3-2.3 2.3"/></svg>',
  eye:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2 2l12 12"/></svg>',
  split:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5v4M8 5.5L3.5 10v4.5M8 5.5l4.5 4.5v4.5"/></svg>',
  heart:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13.8S1.8 10.2 1.8 5.9A3.1 3.1 0 0 1 8 4.6a3.1 3.1 0 0 1 6.2 1.3c0 4.3-6.2 7.9-6.2 7.9z"/></svg>',
  cal:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
  copy:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>',
  print:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6V1.5h8V6M4 12H2.5A1 1 0 0 1 1.5 11V7a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H12"/><rect x="4" y="9.5" width="8" height="5" rx=".5"/></svg>',
  minus:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M5 8h6"/></svg>',
};

/* ---------- Chrome ---------- */
function mountChrome(active) {
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `
    <div class="wrap">
      <a class="brand" href="index.html" aria-label="Northstar home">
        <span class="brand-mark">${I.mark}</span>
        <span class="brand-word">Northstar</span>
      </a>
      <nav class="site-nav" aria-label="Main">
        <a href="index.html" ${active === 'home' ? 'aria-current="page"' : ''}>Home</a>
        <a href="${searchToUrl(loadSearch())}" ${active === 'find' ? 'aria-current="page"' : ''}>Find a Study</a>
        <a href="index.html#phases">How Studies Work</a>
      </nav>
      <div class="header-note"><span class="live-dot"></span><span data-sync>Live from ClinicalTrials.gov</span></div>
    </div>`;
  document.body.prepend(header);

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <div class="wrap">
      <div>
        <a class="brand" href="index.html"><span class="brand-mark">${I.mark}</span><span class="brand-word">Northstar</span></a>
        <p>Northstar is an independent design concept. It is not affiliated with the National Library of Medicine, NIH, or any study sponsor, and nothing here is medical advice. Every study listed comes directly from <a href="https://clinicaltrials.gov" target="_blank" rel="noopener">ClinicalTrials.gov</a>. Talk with your doctor before joining a study.</p>
      </div>
      <div class="foot-meta">
        <div>Data refreshed <span data-sync-date>daily</span></div>
        <div data-api-version></div>
      </div>
    </div>`;
  document.body.append(footer);

  dataVersion().then(v => {
    if (!v) return;
    const d = new Date(v.dataTimestamp);
    const nice = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    $$('[data-sync]').forEach(el => { el.textContent = `Updated ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`; });
    $$('[data-sync-date]').forEach(el => { el.textContent = nice; });
    $$('[data-api-version]').forEach(el => { el.textContent = `ClinicalTrials.gov API ${v.apiVersion}`; });
  });

  initTooltips();
}

/* ---------- Leaflet helpers ---------- */
function makeMap(el, opts = {}) {
  const map = L.map(el, { zoomControl: true, scrollWheelZoom: false, attributionControl: true, ...opts });
  // Esri's light gray canvas needs no API key and works from file:// (CARTO serves an "API key required" tile there).
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    maxZoom: 16,
  }).addTo(map);
  map.setView([39.5, -98.35], 4);
  // Leaflet measures its container once; keep it in sync with sticky/responsive layouts.
  new ResizeObserver(() => map.invalidateSize()).observe(el);
  el.addEventListener('click', () => map.scrollWheelZoom.enable(), { once: true });
  return map;
}
function youMarker(lat, lon) {
  return L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="you-pin" title="You"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000, keyboard: false });
}
function dotMarker(lat, lon, cls = '') {
  return L.marker([lat, lon], { icon: L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) });
}
