'use strict';

/* ======================================================================
   dakle-Ranking – Frontend (offline-fähig)

   - Oben das Datum mit ◀ ▶ (jeder Tag 2026 hat eine eigene Adresse #2026-11-16),
     darunter für jeden Namen ein Feld für die Kilometer dieses Tages.
   - Keine Accounts: Das Gerät wählt einmal "seinen" Namen und ist danach über
     eine zufällige Geräte-Kennung daran gebunden. Bearbeiten lässt sich nur die
     eigene Zeile – für heute und vergangene Tage, nicht für die Zukunft.
   - Alle Daten liegen lokal (localStorage). Eigene Änderungen werden sofort
     übernommen und gesammelt; etwa alle 2 Minuten (und kurz nach jeder
     Änderung, sobald online) wird mit dem Server abgeglichen.
   ====================================================================== */

const YEAR = 2026;
const SYNC_INTERVAL = 2 * 60 * 1000; // regelmäßiger Abgleich
const PUSH_DELAY = 3000; // Abgleich kurz nach einer eigenen Änderung
const MAX_KM_PER_DAY = 2000;

const LS = {
  device: 'dakle.device',
  me: 'dakle.meId',
  store: 'dakle.store.v2',
  outbox: 'dakle.outbox.v2',
  lastSync: 'dakle.lastSync',
};

const DAY_LONG = ['Nedjelja', 'Ponedjeljak', 'Utorak', 'Srijeda', 'Četvrtak', 'Petak', 'Subota'];

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Lokaler Speicher
// ---------------------------------------------------------------------------

function loadJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error('Lokales Speichern fehlgeschlagen', err);
  }
}

/** Zufällige, dauerhafte Kennung dieses Geräts (bzw. Browsers). */
function deviceId() {
  let id = localStorage.getItem(LS.device);
  if (!/^[a-f0-9]{32}$/.test(id || '')) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    id = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(LS.device, id);
  }
  return id;
}

const emptyStore = () => ({ rev: 0, users: {}, entries: {} });
let store = loadJson(LS.store, null) || emptyStore();
let outbox = new Map(loadJson(LS.outbox, []));

const state = {
  device: deviceId(),
  meId: localStorage.getItem(LS.me) || null,
  date: null,
  pendingDirection: 0,
  online: navigator.onLine,
  syncing: false,
  lastSync: Number(localStorage.getItem(LS.lastSync)) || 0,
  claimOffered: false,
};

const saveStore = () => saveJson(LS.store, store);
const saveOutbox = () => saveJson(LS.outbox, outbox.size ? [...outbox] : null);

function setMe(id) {
  state.meId = id || null;
  if (id) localStorage.setItem(LS.me, id);
  else localStorage.removeItem(LS.me);
}

// ---------------------------------------------------------------------------
// Datum
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const todayIso = () => isoOf(new Date());
const FIRST_DAY = `${YEAR}-01-01`;
const LAST_DAY = `${YEAR}-12-31`;

function addDays(iso, n) {
  const d = dateOf(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

const clampDay = (iso) => (iso < FIRST_DAY ? FIRST_DAY : iso > LAST_DAY ? LAST_DAY : iso);
const defaultDay = () => clampDay(todayIso());
const fmtDate = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const fmtKm = (n) => n.toLocaleString('hr-HR', { maximumFractionDigits: 1 });
const kmText = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
const fmtTime = (t) => new Date(t).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------------------
// Datenansicht = Serverstand + eigene ausstehende Änderungen
// ---------------------------------------------------------------------------

function listUsers() {
  return Object.values(store.users).sort((a, b) => a.name.localeCompare(b.name, 'hr'));
}

const me = () => (state.meId ? store.users[state.meId] || null : null);
const entryId = (userId, date) => `${userId}:${date}`;
const outboxKey = (date) => `km:${date}`;

/** Kilometer eines Namens an einem Tag (oder null). */
function kmOf(userId, date) {
  if (userId === state.meId) {
    const ch = outbox.get(outboxKey(date));
    if (ch) return ch.km;
  }
  return store.entries[entryId(userId, date)]?.km ?? null;
}

/** Rangliste: Summe der km; bei gleicher Punktzahl alphabetisch. */
function leaderboard() {
  const totals = new Map(listUsers().map((u) => [u.id, { km: 0, days: 0 }]));
  const values = new Map();
  for (const e of Object.values(store.entries)) if (e.km) values.set(e.id, e);
  if (state.meId) {
    for (const ch of outbox.values()) {
      const id = entryId(state.meId, ch.date);
      if (ch.km) values.set(id, { userId: state.meId, km: ch.km });
      else values.delete(id);
    }
  }
  for (const e of values.values()) {
    const t = totals.get(e.userId);
    if (!t) continue;
    t.km += e.km;
    t.days += 1;
  }
  const rows = listUsers().map((u) => {
    const t = totals.get(u.id);
    return { ...u, points: Math.round(t.km * 10) / 10, days: t.days };
  });
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'hr'));
  let rank = 0;
  rows.forEach((r, i) => {
    if (i === 0 || r.points !== rows[i - 1].points) rank = i + 1;
    r.rank = rank;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Eigene Änderungen (funktionieren auch offline)
// ---------------------------------------------------------------------------

function parseKm(raw) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > MAX_KM_PER_DAY) {
    throw new Error(`Unesi broj između 0 i ${MAX_KM_PER_DAY}`);
  }
  const km = Math.round(n * 10) / 10;
  return km > 0 ? km : null;
}

function setKm(date, raw) {
  if (!state.meId) throw new Error('Najprije odaberi svoje ime');
  if (date > todayIso()) throw new Error('Budući dani se ne mogu unositi');
  const km = parseKm(raw);
  outbox.set(outboxKey(date), { key: outboxKey(date), type: 'km', date, km, updatedAt: Date.now() });
  saveOutbox();
  scheduleSync(PUSH_DELAY);
  return km;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function headers(json) {
  const h = { 'X-Device-Id': state.device };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Za ovo je potrebna internetska veza.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Greška ${res.status}`);
  return data;
}

let syncTimer = null;
let syncQueued = false;

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), delay);
}

async function sync() {
  if (state.syncing) {
    syncQueued = true;
    return;
  }
  clearTimeout(syncTimer);
  state.syncing = true;
  renderSync();

  const sent = state.meId ? [...outbox.values()] : [];
  const rejected = [];
  try {
    let res;
    try {
      res = await fetch('/api/sync', { method: 'POST', headers: headers(true), body: JSON.stringify({ since: store.rev, changes: sent }) });
    } catch {
      throw new Error('offline');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    applyServerData(data);

    // Bindung laut Server übernehmen (z. B. nach einem Reset gelöst)
    if (state.meId && data.me !== state.meId) {
      setMe(data.me);
      outbox = new Map();
      saveOutbox();
      toast(data.me ? 'Ovaj uređaj je povezan s drugim imenom.' : 'Ovaj uređaj više nije povezan s imenom. Odaberi svoje ime.', true);
    } else if (!state.meId && data.me) {
      setMe(data.me);
    } else {
      for (const r of data.results || []) {
        const was = sent.find((c) => c.key === r.key);
        const cur = outbox.get(r.key);
        // nur entfernen, wenn seit dem Senden nicht erneut geändert
        if (was && cur && cur.updatedAt === was.updatedAt) outbox.delete(r.key);
        if (!r.ok) rejected.push(r.error);
      }
      saveOutbox();
    }
    state.online = true;
    state.lastSync = Date.now();
    localStorage.setItem(LS.lastSync, state.lastSync);
    if (rejected.length) toast(`Unos odbijen: ${rejected[0]}`, true);
  } catch (err) {
    state.online = false;
    if (err.message !== 'offline') console.warn('Sinkronizacija nije uspjela:', err);
  } finally {
    state.syncing = false;
    renderAll();
    offerClaim();
    if (syncQueued) {
      syncQueued = false;
      scheduleSync(500);
    }
  }
}

function applyServerData(data) {
  if (data.full) store = emptyStore();
  for (const u of data.users || []) {
    if (u.deleted) delete store.users[u.id];
    else store.users[u.id] = u;
  }
  for (const e of data.entries || []) {
    if (!e.km) delete store.entries[e.id];
    else store.entries[e.id] = e;
  }
  store.rev = data.rev;
  saveStore();
}

// ---------------------------------------------------------------------------
// UI-Helfer
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2500);
}

const initials = (name) => name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const avatar = (user) => el('span', { class: 'avatar', style: `background:${user.color}` }, initials(user.name));

// ---------------------------------------------------------------------------
// Rendern
// ---------------------------------------------------------------------------

function renderAll() {
  renderMe();
  renderSync();
  renderDay();
  renderList();
  renderLeaderboard();
  // Namensliste aktualisieren (z. B. wenn jemand anderes inzwischen einen Namen gewählt hat)
  if ($('#claimDialog').open && claimStep.mode === 'choose') renderClaim();
}

function renderMe() {
  const area = $('#meArea');
  const user = me();
  if (user) {
    area.replaceChildren(el('span', { class: 'me-chip', title: 'Ovaj uređaj je povezan s ovim imenom' }, avatar(user), el('span', { class: 'me-name' }, user.name)));
  } else {
    area.replaceChildren(el('button', {
      type: 'button',
      class: 'btn primary',
      onclick: openClaim,
      disabled: listUsers().length === 0,
    }, 'Odaberi svoje ime'));
  }
}

function renderSync() {
  const chip = $('#syncStatus');
  const pending = outbox.size;
  let text;
  let cls;
  if (state.syncing) {
    text = 'Sinkronizacija…';
    cls = 'busy';
  } else if (!state.online) {
    text = 'Izvan mreže';
    cls = 'offline';
  } else if (state.lastSync) {
    text = `Sinkronizirano ${fmtTime(state.lastSync)}`;
    cls = 'ok';
  } else {
    text = 'Nije sinkronizirano';
    cls = 'offline';
  }
  if (pending) text += ` · ${pending} na čekanju`;
  chip.className = `sync-chip ${cls}${pending ? ' pending' : ''}`;
  chip.replaceChildren(el('span', { class: 'sync-dot' }), el('span', { class: 'sync-text' }, text));
  chip.title = `${text}\nAutomatska sinkronizacija svake 2 minute. Klikni za sinkronizaciju odmah.`;
}

function renderDay() {
  const d = dateOf(state.date);
  const today = todayIso();
  $('#dayLabel').textContent = fmtDate(state.date);
  $('#daySub').textContent = DAY_LONG[d.getDay()] + (state.date === today ? ' · danas' : state.date > today ? ' · budući dan' : '');
  $('#prevDay').disabled = state.date <= FIRST_DAY;
  $('#nextDay').disabled = state.date >= LAST_DAY;
  $('#todayBtn').classList.toggle('away', state.date !== defaultDay());
  document.title = `${fmtDate(state.date)} – dakle-Ranking`;

  let hint = '';
  if (state.date > today) hint = 'Budući dan – unos još nije moguć.';
  else if (!state.meId) hint = 'Odaberi svoje ime kako bi unosio/la svoje kilometre.';
  else hint = 'Upiši svoje kilometre za ovaj dan i potvrdi s ✓. Radi i bez interneta.';
  $('#dayHint').textContent = hint;
}

function renderList() {
  const list = $('#kmList');
  const users = listUsers();
  // Ein gerade bearbeitetes Feld nicht überschreiben
  const active = document.activeElement;
  if (active && list.contains(active) && active.tagName === 'INPUT') return;

  if (users.length === 0) {
    list.replaceChildren(el('li', { class: 'hint empty' }, state.lastSync || state.online ? 'Još nema imena.' : 'Podaci još nisu učitani – potrebna je internetska veza.'));
    return;
  }
  const future = state.date > todayIso();
  list.replaceChildren(...users.map((u) => {
    const own = u.id === state.meId;
    const editable = own && !future;
    const value = kmOf(u.id, state.date);
    const input = el('input', {
      class: 'km-input',
      type: 'text',
      inputmode: 'decimal',
      placeholder: 'km',
      value: kmText(value),
      disabled: !editable,
      'aria-label': `Kilometri – ${u.name}, ${fmtDate(state.date)}`,
      dataset: { saved: kmText(value) },
    });
    const check = el('button', {
      type: 'button',
      class: 'check-btn' + (value ? ' saved' : ''),
      disabled: !editable,
      'aria-label': `Spremi kilometre – ${u.name}`,
      title: editable ? 'Spremi' : '',
    }, '✓');
    const save = () => {
      try {
        const km = setKm(state.date, input.value);
        input.value = kmText(km);
        input.dataset.saved = kmText(km);
        check.classList.toggle('saved', !!km);
        check.classList.remove('dirty');
        input.blur();
        renderLeaderboard();
        renderSync();
        toast(km ? `Spremljeno: ${fmtKm(km)} km` : 'Unos obrisan');
      } catch (err) {
        toast(err.message, true);
        input.focus();
      }
    };
    if (editable) {
      input.addEventListener('input', () => check.classList.toggle('dirty', input.value.trim() !== input.dataset.saved));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          input.value = input.dataset.saved;
          check.classList.remove('dirty');
          input.blur();
        }
      });
      check.addEventListener('click', save);
    }
    return el('li', { class: 'km-row' + (own ? ' own' : '') },
      el('span', { class: 'km-name' }, el('span', { class: 'dot', style: `background:${u.color}` }), u.name),
      input,
      check);
  }));
}

function renderLeaderboard() {
  const tbody = $('#rankBody');
  const rows = leaderboard();
  const medals = ['🥇', '🥈', '🥉'];
  if (rows.length === 0) {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: 4, class: 'hint' }, 'Još nema sudionika.')));
    return;
  }
  tbody.replaceChildren(...rows.map((r) => el('tr', { class: r.id === state.meId ? 'me' : null },
    el('td', {}, r.points > 0 && r.rank <= 3 ? el('span', { class: 'medal' }, medals[r.rank - 1]) : `${r.rank}.`),
    el('td', {}, el('span', { class: 'who' }, el('span', { class: 'dot', style: `background:${r.color}` }), el('span', {}, r.name))),
    el('td', { class: 'num' }, r.days),
    el('td', { class: 'num' }, fmtKm(r.points)))));
}

// ---------------------------------------------------------------------------
// Name wählen (einmalig pro Gerät)
// ---------------------------------------------------------------------------

// Ablauf im Dialog: Namen wählen -> bestätigen -> Erfolgsmeldung
const claimStep = { mode: 'choose', user: null, busy: false };

function openClaim() {
  Object.assign(claimStep, { mode: 'choose', user: null, busy: false });
  renderClaim();
  if (!$('#claimDialog').open) $('#claimDialog').showModal();
}

/** Beim ersten Öffnen einmal anbieten, solange das Gerät keinen Namen hat. */
function offerClaim() {
  if (state.claimOffered || state.meId || listUsers().length === 0) return;
  state.claimOffered = true;
  openClaim();
}

function renderClaim() {
  const d = $('#claimDialog');
  const body = $('#claimBody');
  const error = $('.form-error', d);
  const { mode, user } = claimStep;
  error.textContent = '';

  if (mode === 'choose') {
    $('#claimTitle').textContent = 'Tko si ti?';
    body.replaceChildren(
      el('p', { class: 'hint' }, 'Odaberi svoje ime. Na ovom uređaju tada možeš unositi samo svoje kilometre.'),
      el('div', { class: 'claim-list' }, ...listUsers().map((u) => el('button', {
        type: 'button',
        class: 'claim-user',
        disabled: u.bound,
        title: u.bound ? 'Već povezano s drugim uređajem' : `Ja sam ${u.name}`,
        onclick: () => {
          Object.assign(claimStep, { mode: 'confirm', user: u });
          renderClaim();
        },
      }, el('span', { class: 'avatar sm', style: `background:${u.color}` }, initials(u.name)), el('span', {}, u.name),
      u.bound ? el('small', {}, 'zauzeto') : null))),
    );
    return;
  }

  if (mode === 'confirm') {
    $('#claimTitle').textContent = 'Potvrda';
    const yes = el('button', { type: 'button', class: 'btn primary', disabled: claimStep.busy, onclick: () => claim(user) },
      claimStep.busy ? 'Povezivanje…' : 'Da, to sam ja');
    body.replaceChildren(el('div', { class: 'claim-confirm' },
      avatar(user),
      el('strong', {}, `Jesi li ti ${user.name}?`),
      el('p', {}, 'Ovaj uređaj se trajno povezuje s tim imenom. To se kasnije ne može promijeniti.'),
      el('div', { class: 'claim-actions' },
        el('button', { type: 'button', class: 'btn', disabled: claimStep.busy, onclick: () => { claimStep.mode = 'choose'; renderClaim(); } }, 'Natrag'),
        yes)));
    yes.focus();
    return;
  }

  // mode === 'done'
  $('#claimTitle').textContent = 'Povezano';
  const ok = el('button', { type: 'button', class: 'btn primary', onclick: () => d.close() }, 'U redu');
  body.replaceChildren(el('div', { class: 'claim-confirm claim-done' },
    el('span', { class: 'check-big' }, '✓'),
    el('strong', {}, `Bok, ${user.name}!`),
    el('p', {}, 'Ovaj uređaj je sada povezan s tvojim imenom. Možeš unositi svoje kilometre.'),
    el('div', { class: 'claim-actions' }, ok)));
  ok.focus();
}

async function claim(user) {
  claimStep.busy = true;
  renderClaim();
  try {
    await api('POST', '/api/claim', { userId: user.id });
    setMe(user.id);
    Object.assign(claimStep, { mode: 'done', busy: false });
    renderClaim();
    renderAll();
    sync();
  } catch (err) {
    Object.assign(claimStep, { mode: 'choose', busy: false });
    renderClaim();
    $('.form-error', $('#claimDialog')).textContent = err.message;
    sync();
  }
}

// ---------------------------------------------------------------------------
// Navigation: jeder Tag eine eigene Adresse (#2026-11-16)
// ---------------------------------------------------------------------------

function goToDay(iso, direction = 0) {
  iso = clampDay(iso);
  if (iso === state.date) return;
  state.pendingDirection = direction;
  location.hash = `#${iso}`;
}

function parseHash() {
  const m = /^#(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
  if (!m || m[1] < FIRST_DAY || m[1] > LAST_DAY || isoOf(dateOf(m[1])) !== m[1]) return null;
  return m[1];
}

function showDayFromHash() {
  const iso = parseHash();
  if (!iso) {
    history.replaceState(null, '', `#${state.date || defaultDay()}`);
    return;
  }
  state.date = iso;
  renderDay();
  renderList();

  const dir = state.pendingDirection;
  state.pendingDirection = 0;
  const list = $('#kmList');
  list.classList.remove('slide-next', 'slide-prev');
  if (dir) {
    void list.offsetWidth;
    list.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function cleanupOldVersion() {
  // Daten der früheren Kalender-/Login-Version entfernen
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('dakle.outbox.') && k !== LS.outbox) localStorage.removeItem(k);
  }
  for (const k of ['dakle.token', 'dakle.me', 'dakle.view', 'dakle.store', 'ranking.token', 'ranking.view', 'ranking.year']) {
    localStorage.removeItem(k);
  }
}

function init() {
  cleanupOldVersion();
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  $('#syncStatus').addEventListener('click', () => sync());
  $('#prevDay').addEventListener('click', () => goToDay(addDays(state.date, -1), -1));
  $('#nextDay').addEventListener('click', () => goToDay(addDays(state.date, 1), 1));
  $('#todayBtn').addEventListener('click', () => {
    const d = defaultDay();
    goToDay(d, d > state.date ? 1 : -1);
  });
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') goToDay(addDays(state.date, -1), -1);
    else if (e.key === 'ArrowRight') goToDay(addDays(state.date, 1), 1);
  });
  let touch = null;
  const board = $('.board');
  board.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    touch = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  board.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (e.target instanceof Element && e.target.closest('input')) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      goToDay(addDays(state.date, dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    }
  }, { passive: true });
  window.addEventListener('hashchange', showDayFromHash);

  state.date = parseHash() || defaultDay();
  history.replaceState(null, '', `#${state.date}`);

  // Sofort aus dem lokalen Speicher anzeigen – auch ohne Internet
  renderAll();

  // Synchronisieren: jetzt, alle 2 Minuten, beim Wieder-Online-Gehen und beim Zurückkehren zur App
  sync();
  setInterval(() => sync(), SYNC_INTERVAL);
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => {
    state.online = false;
    renderSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.lastSync > 30000) sync();
  });
  // Tageswechsel (heute / Zukunft) aktuell halten
  setInterval(() => {
    renderDay();
    renderList();
  }, 10 * 60 * 1000);

  if ('serviceWorker' in navigator) {
    // Kommt eine neue App-Version an, übernimmt der neue Service Worker sofort –
    // dann einmal neu laden, damit sie direkt sichtbar ist (nicht erst beim nächsten Öffnen).
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      const editing = document.activeElement && document.activeElement.tagName === 'INPUT';
      if (editing) return; // keine laufende Eingabe unterbrechen
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
