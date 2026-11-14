'use strict';

/* ======================================================================
   dakle-Ranking – Frontend (offline-fähig)

   - Jede Kalenderwoche 2026 ist eine eigene Seite (#2026-KW).
   - Spalten = Wochentage, Zeilen = Städte (nächste oben, entfernteste unten).
   - Alle Daten liegen lokal (localStorage). Eigene Änderungen werden sofort
     lokal übernommen und in einer Warteschlange gesammelt. Etwa alle 2 Minuten
     (und kurz nach jeder Änderung, sobald online) wird mit dem Server
     abgeglichen: Warteschlange hochladen, Neuigkeiten der anderen herunterladen.
   ====================================================================== */

const YEAR = 2026;
const SYNC_INTERVAL = 2 * 60 * 1000; // regelmäßiger Abgleich
const PUSH_DELAY = 4000; // Abgleich kurz nach einer eigenen Änderung

const LS = {
  token: 'dakle.token',
  me: 'dakle.me',
  view: 'dakle.view',
  store: 'dakle.store',
  lastSync: 'dakle.lastSync',
  outbox: (userId) => `dakle.outbox.${userId}`,
};

const DAY_SHORT = ['Pon', 'Uto', 'Sri', 'Čet', 'Pet', 'Sub', 'Ned'];
const DAY_LONG = ['Ponedjeljak', 'Utorak', 'Srijeda', 'Četvrtak', 'Petak', 'Subota', 'Nedjelja'];
// Feste Farbpalette (wie im Server) – jede Farbe darf nur ein Profil haben
const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#65a30d',
  '#ca8a04', '#475569', '#0d9488', '#92400e', '#4338ca', '#c026d3', '#fb7185',
];

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

// Stand des Servers (zuletzt synchronisiert)
const emptyStore = () => ({ rev: 0, users: {}, cities: {}, entries: {} });
let store = loadJson(LS.store, null) || emptyStore();

const state = {
  token: localStorage.getItem(LS.token) || null,
  me: loadJson(LS.me, null),
  week: 1,
  pendingDirection: 0,
  flashToday: false, // heutigen Tag beim nächsten Zeichnen einmal blinken lassen
  viewUserId: localStorage.getItem(LS.view) || null,
  online: navigator.onLine,
  syncing: false,
  lastSync: Number(localStorage.getItem(LS.lastSync)) || 0,
};

// Warteschlange eigener, noch nicht synchronisierter Änderungen (pro Profil)
let outbox = new Map();

function loadOutbox() {
  outbox = new Map(state.me ? loadJson(LS.outbox(state.me.id), []) : []);
}

function saveOutbox() {
  if (state.me) saveJson(LS.outbox(state.me.id), outbox.size ? [...outbox] : null);
}

function saveStore() {
  saveJson(LS.store, store);
}

function setSession(token, user) {
  state.token = token;
  state.me = user;
  if (token) localStorage.setItem(LS.token, token);
  else localStorage.removeItem(LS.token);
  saveJson(LS.me, user);
  loadOutbox();
}

// ---------------------------------------------------------------------------
// Kalender (ISO 8601)
// ---------------------------------------------------------------------------

function isoWeekOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7) };
}

const WEEKS = isoWeekOf(new Date(YEAR, 11, 28)).week; // 2026: 53

/** Montag einer ISO-Woche (lokale Zeit). */
function mondayOf(year, week) {
  const jan4 = new Date(year, 0, 4);
  const day = jan4.getDay() || 7;
  return new Date(year, 0, 4 - day + 1 + (week - 1) * 7);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Woche, die beim Öffnen angezeigt wird: aktuelle KW, sonst Anfang/Ende 2026. */
function defaultWeek() {
  const now = isoWeekOf();
  if (now.year === YEAR) return now.week;
  return now.year < YEAR ? 1 : WEEKS;
}

const fmtDay = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
const fmtNum = (n) => n.toLocaleString('hr-HR');
const fmtTime = (t) => new Date(t).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
const pointsForKm = (km) => Math.round(km);

function randomId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Datenansicht = Serverstand + eigene ausstehende Änderungen
// ---------------------------------------------------------------------------

const isMe = (userId) => !!state.me && state.me.id === userId;

function listUsers() {
  const users = Object.values(store.users).map((u) => ({ ...u }));
  if (state.me) {
    let me = users.find((u) => u.id === state.me.id);
    if (!me) users.push((me = { ...state.me }));
    const p = outbox.get('profile');
    if (p) Object.assign(me, { name: p.name, color: p.color });
  }
  return users.sort((a, b) => a.name.localeCompare(b.name, 'hr'));
}

// Kennzeichnung des Admins: Chip mit "A" (in Auswahllisten, die kein HTML können: Ⓐ)
const ADMIN_MARK = 'Ⓐ';
const adminChip = () => el('span', { class: 'admin-chip', title: 'Administrator', 'aria-label': 'Administrator' }, 'A');

/** Der festgelegte Benutzer, der die gemeinsame Städteliste bearbeitet. */
const isAdmin = () => !!state.me && store.adminId === state.me.id;
const adminName = () => listUsers().find((u) => u.id === store.adminId)?.name || 'administrator';

/** Gemeinsame Städteliste für alle, sortiert von der nächsten zur entferntesten Stadt. */
function allCities() {
  const map = new Map();
  for (const c of Object.values(store.cities)) if (!c.deleted) map.set(c.id, c);
  for (const ch of outbox.values()) {
    if (ch.type !== 'city') continue;
    if (ch.deleted) map.delete(ch.id);
    else map.set(ch.id, { id: ch.id, name: ch.name, km: ch.km });
  }
  return [...map.values()].sort((a, b) => a.km - b.km || a.name.localeCompare(b.name, 'hr'));
}

const entryId = (userId, week, day) => `${userId}:${YEAR}:${week}:${day}`;
const outboxEntryKey = (week, day) => `entry:${YEAR}:${week}:${day}`;

/** Erreichte Stadt eines Tages (oder null). */
function entryCity(userId, week, day) {
  if (isMe(userId)) {
    const ch = outbox.get(outboxEntryKey(week, day));
    if (ch) return ch.cityId;
  }
  return store.entries[entryId(userId, week, day)]?.cityId || null;
}

function leaderboard() {
  const byUser = new Map();
  for (const e of Object.values(store.entries)) {
    if (e.year !== YEAR || !e.cityId) continue;
    if (!byUser.has(e.userId)) byUser.set(e.userId, new Map());
    byUser.get(e.userId).set(entryId(e.userId, e.week, e.day), e.cityId);
  }
  if (state.me) {
    const mine = byUser.get(state.me.id) || new Map();
    for (const ch of outbox.values()) {
      if (ch.type === 'entry') mine.set(entryId(state.me.id, ch.week, ch.day), ch.cityId);
    }
    byUser.set(state.me.id, mine);
  }

  const cities = new Map(allCities().map((c) => [c.id, c]));
  const rows = listUsers().map((u) => {
    let points = 0;
    let days = 0;
    let bestKm = 0;
    for (const cityId of (byUser.get(u.id) || new Map()).values()) {
      const city = cities.get(cityId);
      if (!city) continue;
      points += pointsForKm(city.km);
      days += 1;
      bestKm = Math.max(bestKm, city.km);
    }
    return { ...u, points, days, bestKm };
  });
  rows.sort((a, b) => b.points - a.points || b.bestKm - a.bestKm || a.name.localeCompare(b.name, 'hr'));
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

function queue(change) {
  if (!state.me) return;
  outbox.set(change.key, { ...change, updatedAt: Date.now() });
  saveOutbox();
  scheduleSync(PUSH_DELAY);
}

function validateCity(name, kmRaw, exceptId) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Polje „Grad“ je obavezno');
  if (n.length > 40) throw new Error('Polje „Grad“ smije imati najviše 40 znakova');
  const km = Number(String(kmRaw).replace(',', '.'));
  if (!Number.isFinite(km) || km < 0 || km > 100000) throw new Error('Kilometri moraju biti broj između 0 i 100000');
  if (!isAdmin()) throw new Error('Gradove može uređivati samo administrator');
  const cities = allCities();
  if (cities.some((c) => c.id !== exceptId && c.name.toLowerCase() === n.toLowerCase())) throw new Error('Taj grad je već dodan');
  if (!exceptId && cities.length >= 100) throw new Error('Najviše 100 gradova');
  return { name: n, km: Math.round(km * 10) / 10 };
}

function saveCity(id, name, km) {
  const v = validateCity(name, km, id);
  const cityId = id || randomId();
  queue({ key: `city:${cityId}`, type: 'city', id: cityId, ...v });
}

function deleteCity(id) {
  if (!isAdmin()) throw new Error('Gradove može uređivati samo administrator');
  queue({ key: `city:${id}`, type: 'city', id, deleted: true });
}

function setEntry(week, day, cityId) {
  queue({ key: outboxEntryKey(week, day), type: 'entry', year: YEAR, week, day, cityId: cityId || null });
}

function saveProfile(name, color) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Polje „Ime“ je obavezno');
  if (n.length > 30) throw new Error('Polje „Ime“ smije imati najviše 30 znakova');
  if (listUsers().some((u) => u.id !== state.me.id && u.name.toLowerCase() === n.toLowerCase())) {
    throw new Error('To ime je već zauzeto');
  }
  if (!color) throw new Error('Odaberi boju');
  if (takenColors(state.me.id).has(color)) throw new Error('Tu boju već koristi drugi korisnik');
  queue({ key: 'profile', type: 'profile', name: n, color });
  state.me = { ...state.me, name: n, color };
  saveJson(LS.me, state.me);
}

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

let syncTimer = null;
let syncQueued = false;

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), delay);
}

class AuthLost extends Error {}

async function sync() {
  if (state.syncing) {
    syncQueued = true;
    return;
  }
  clearTimeout(syncTimer);
  state.syncing = true;
  renderSync();

  const sent = state.me && state.token && !state.me.mustChangePin ? [...outbox.values()] : [];
  const rejected = [];
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch('/api/sync', { method: 'POST', headers, body: JSON.stringify({ since: store.rev, changes: sent }) });
    } catch {
      throw new Error('offline');
    }
    if (res.status === 401) throw new AuthLost();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Gespeicherte Anmeldung gilt auf dem Server nicht mehr (z. B. Profil gelöscht oder Daten neu angelegt)
    if (state.token && 'me' in data && data.me !== state.me?.id) throw new AuthLost();

    applyServerData(data);
    if (state.me && state.token) setMustChangePin(!!data.mustChangePin);
    for (const r of data.results || []) {
      const was = sent.find((c) => c.key === r.key);
      const cur = outbox.get(r.key);
      // nur entfernen, wenn seit dem Senden nicht erneut geändert
      if (was && cur && cur.updatedAt === was.updatedAt) outbox.delete(r.key);
      if (!r.ok) rejected.push(r.error);
    }
    saveOutbox();
    refreshMe();
    state.online = true;
    state.lastSync = Date.now();
    localStorage.setItem(LS.lastSync, state.lastSync);
    if (rejected.length) toast(`Promjena odbijena: ${rejected[0]}`, true);
  } catch (err) {
    if (err instanceof AuthLost) {
      // Sitzung ungültig: ausstehende Änderungen bleiben gespeichert, bis man sich wieder anmeldet
      const pending = outbox.size;
      setSession(null, null);
      toast(pending ? 'Prijava je istekla – prijavi se ponovno da se promjene sinkroniziraju.' : 'Prijava je istekla.', true);
      syncQueued = true;
    } else {
      state.online = false;
      if (err.message !== 'offline') console.warn('Sinkronizacija nije uspjela:', err);
    }
  } finally {
    state.syncing = false;
    renderAll();
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
  for (const c of data.cities || []) {
    if (c.deleted) delete store.cities[c.id];
    else store.cities[c.id] = c;
  }
  for (const e of data.entries || []) {
    if (!e.cityId) delete store.entries[e.id];
    else store.entries[e.id] = e;
  }
  store.rev = data.rev;
  if ('adminId' in data) store.adminId = data.adminId;
  saveStore();

  // eigenes Profil wurde (auf einem anderen Gerät) gelöscht
  if (state.me && (data.users || []).some((u) => u.id === state.me.id && u.deleted)) {
    localStorage.removeItem(LS.outbox(state.me.id));
    setSession(null, null);
    toast('Tvoj profil je obrisan.', true);
  }
}

/** Eigenes Profil mit dem Serverstand abgleichen (sofern keine eigene Änderung aussteht). */
function refreshMe() {
  const me = state.me && store.users[state.me.id];
  if (me && !outbox.has('profile')) {
    state.me = { id: me.id, name: me.name, color: me.color, mustChangePin: !!state.me.mustChangePin };
    saveJson(LS.me, state.me);
  }
}

// ---------------------------------------------------------------------------
// Online-Aufrufe (nur für Anmeldung / Profil anlegen / löschen)
// ---------------------------------------------------------------------------

async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Za ovo je potrebna internetska veza.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Greška ${res.status}`);
  return data;
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
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 3000);
}

function initials(name) {
  return name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function avatar(user) {
  return el('span', { class: 'avatar', style: `background:${user.color}` }, initials(user.name));
}

const viewUser = () => listUsers().find((u) => u.id === state.viewUserId) || null;
const isOwnView = () => !!state.me && state.me.id === state.viewUserId;

function ensureViewUser() {
  const users = listUsers();
  if (!users.some((u) => u.id === state.viewUserId)) {
    state.viewUserId = state.me ? state.me.id : users[0]?.id || null;
  }
}

// ---------------------------------------------------------------------------
// Rendern
// ---------------------------------------------------------------------------

function renderAll() {
  ensureViewUser();
  renderAuth();
  renderSync();
  renderWeek();
  renderViewSelect();
  renderBoard();
  renderLeaderboard();
  if ($('#citiesDialog').open) renderCityList();
}

function renderAuth() {
  const area = $('#authArea');
  area.replaceChildren();
  if (state.me) {
    area.append(
      el('button', { type: 'button', class: 'me-btn', title: 'Moj profil', onclick: openProfile },
        avatar(state.me), el('span', { class: 'me-name' }, state.me.name),
        isAdmin() ? adminChip() : null),
    );
  } else {
    area.append(
      el('button', { type: 'button', class: 'btn primary login-btn', onclick: () => openLogin(), disabled: listUsers().length === 0 }, '🔑 Prijava'),
    );
  }
  renderLoginCta();
}

/** Gut sichtbare Anmelde-Karte über dem Raster, solange niemand angemeldet ist. */
function renderLoginCta() {
  const box = $('#loginCta');
  const users = listUsers();
  box.hidden = !!state.me || users.length === 0;
  if (box.hidden) return;
  $('#loginCtaUsers').replaceChildren(
    ...users.map((u) => el('button', {
      type: 'button',
      class: 'login-user',
      title: `Prijava: ${u.name}`,
      onclick: () => openLogin(u.id),
    }, avatar(u), el('span', {}, u.name), u.id === store.adminId ? adminChip() : null)),
  );
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

function renderWeek() {
  const mon = mondayOf(YEAR, state.week);
  const sun = addDays(mon, 6);
  const now = isoWeekOf();
  const isNow = now.year === YEAR && now.week === state.week;
  $('#weekLabel').textContent = `${state.week}. tjedan ${YEAR}.`;
  $('#weekRange').textContent = `${fmtDay(mon)}${mon.getFullYear() !== sun.getFullYear() ? mon.getFullYear() + '.' : ''} – ${fmtDay(sun)}${sun.getFullYear()}.` + (isNow ? ' · ovaj tjedan' : '');
  $('#prevWeek').disabled = state.week <= 1;
  $('#nextWeek').disabled = state.week >= WEEKS;
  $('#todayBtn').classList.toggle('away', state.week !== defaultWeek());
  document.title = `${state.week}. tjedan ${YEAR}. – dakle-Ranking`;
}

function renderViewSelect() {
  const sel = $('#viewUser');
  const users = listUsers();
  sel.replaceChildren(
    ...users.map((u) => el('option', { value: u.id, selected: u.id === state.viewUserId },
      (u.id === store.adminId ? `${ADMIN_MARK} ` : '') + u.name + (isMe(u.id) ? ' (ja)' : ''))),
  );
  sel.disabled = users.length === 0;
  $('#manageCitiesBtn').hidden = !isAdmin();
}

function renderBoard() {
  const user = viewUser();
  const own = isOwnView();
  const grid = $('#grid');
  const wrap = $('#gridWrap');
  const empty = $('#emptyState');
  const total = $('#weekTotal');
  const cities = user ? allCities() : [];

  $('#boardTitle').textContent = user ? `Etape: ${user.name}` : 'Etape';
  document.documentElement.style.setProperty('--uc', user ? user.color : '#2563eb');

  let hint = '';
  if (!user) hint = '';
  else if (own) hint = 'Za današnji ili raniji dan dodirni grad do kojeg si stigao/la. Ponovni dodir briše unos. Budući dani se ne mogu unositi. Radi i bez interneta.';
  else if (state.me) hint = `Gledaš etape korisnika ${user.name}. Gore odaberi svoj profil za unos.`;
  else hint = '';
  $('#boardHint').textContent = hint;

  if (!user || cities.length === 0) {
    grid.replaceChildren();
    wrap.hidden = true;
    total.hidden = true;
    empty.hidden = false;
    empty.replaceChildren();
    if (!user) {
      empty.append(
        el('p', {}, state.lastSync || state.online ? 'Profili još nisu postavljeni.' : 'Podaci još nisu učitani – potrebna je internetska veza.'),
      );
    } else if (isAdmin()) {
      empty.append(
        el('p', {}, 'Još nema gradova. Kao administrator unosiš zajedničku rutu za sve – od najbližeg do najudaljenijeg grada.'),
        el('button', { type: 'button', class: 'btn primary', onclick: openCities }, 'Dodaj gradove'),
      );
    } else {
      empty.append(el('p', {}, `Još nema gradova. Rutu za sve unosi administrator (${adminName()}).`));
    }
    return;
  }

  wrap.hidden = false;
  total.hidden = false;
  empty.hidden = true;

  const mon = mondayOf(YEAR, state.week);
  const todayStr = new Date().toDateString();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(mon, i);
    const outside = date.getFullYear() !== YEAR;
    const future = !outside && date > todayStart; // Tage in der Zukunft sind gesperrt
    return { day: i + 1, date, isToday: date.toDateString() === todayStr, outside, future, locked: outside || future };
  });
  const cityIndex = new Map(cities.map((c, i) => [c.id, i]));
  const cityById = new Map(cities.map((c) => [c.id, c]));
  const reached = new Map(days.map((d) => [d.day, d.outside ? null : entryCity(user.id, state.week, d.day)]));

  // Kopfzeile: Wochentage
  const headRow = el('tr', {}, el('th', { class: 'city', scope: 'col' }, 'Grad / km'));
  for (const d of days) {
    const cls = [d.isToday && 'now', d.outside && 'outside', d.future && 'future'].filter(Boolean).join(' ') || null;
    headRow.append(
      el('th', { scope: 'col', class: cls, title: `${DAY_LONG[d.day - 1]}, ${fmtDay(d.date)}${d.date.getFullYear()}.${d.outside ? ` (nije u ${YEAR}.)` : d.future ? ' (budući dan)' : ''}` },
        el('span', { class: 'dname' }, DAY_SHORT[d.day - 1]), el('small', {}, fmtDay(d.date))),
    );
  }

  // Zeilen: Städte (nächste oben)
  const body = el('tbody');
  cities.forEach((city, row) => {
    const tr = el('tr', {}, el('th', { class: 'city', scope: 'row', title: `${city.name} – ${fmtNum(city.km)} km` },
      el('span', { class: 'cname' }, city.name), el('small', {}, `${fmtNum(city.km)} km`)));
    for (const d of days) {
      const reachedRow = cityIndex.get(reached.get(d.day));
      const classes = [];
      if (reachedRow !== undefined && row < reachedRow) classes.push('filled');
      if (reachedRow === row) classes.push('reached');
      if (d.isToday) classes.push('now');
      if (d.isToday && state.flashToday) classes.push('flash');
      if (d.outside) classes.push('outside');
      if (d.future) classes.push('future');
      const label = `${DAY_LONG[d.day - 1]} ${fmtDay(d.date)}: ${city.name} (${fmtNum(pointsForKm(city.km))} bodova)`;
      const content = reachedRow === row ? '●' : '';
      const cell = own && !d.locked
        ? el('button', { type: 'button', 'aria-label': label, title: label, 'aria-pressed': reachedRow === row ? 'true' : 'false', dataset: { day: d.day, city: city.id } }, content)
        : el('span', { class: 'cellv', title: d.outside ? `Nije u ${YEAR}.` : d.future ? 'Budući dan – unos još nije moguć' : label }, content);
      tr.append(el('td', { class: classes.join(' ') || null }, cell));
    }
    body.append(tr);
  });

  // Fußzeile: Punkte je Tag
  let weekPoints = 0;
  const footRow = el('tr', {}, el('th', { class: 'city', scope: 'row' }, 'Bodovi'));
  for (const d of days) {
    const city = cityById.get(reached.get(d.day));
    if (city) weekPoints += pointsForKm(city.km);
    footRow.append(el('td', { class: [d.isToday && 'now', d.outside && 'outside', d.future && 'future'].filter(Boolean).join(' ') || null }, city ? fmtNum(pointsForKm(city.km)) : ''));
  }

  grid.replaceChildren(el('thead', {}, headRow), body, el('tfoot', {}, footRow));
  state.flashToday = false; // nur einmal pro Aufruf der Woche
  total.replaceChildren('Ukupno ovaj tjedan: ', el('strong', {}, `${fmtNum(weekPoints)} bodova`));
}

function renderLeaderboard() {
  const tbody = $('#rankBody');
  const rows = leaderboard();
  const medals = ['🥇', '🥈', '🥉'];
  if (rows.length === 0) {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: 4, class: 'hint' }, 'Još nema sudionika.')));
    return;
  }
  tbody.replaceChildren(
    ...rows.map((r) => {
      const classes = [];
      if (isMe(r.id)) classes.push('me');
      if (state.viewUserId === r.id) classes.push('viewing');
      return el('tr', {
        class: classes.join(' ') || null,
        title: `Prikaži etape: ${r.name}`,
        onclick: () => selectViewUser(r.id),
      },
      el('td', {}, r.points > 0 && r.rank <= 3 ? el('span', { class: 'medal' }, medals[r.rank - 1]) : `${r.rank}.`),
      el('td', {}, el('span', { class: 'who' },
        el('span', { class: 'dot', style: `background:${r.color}` }),
        el('span', {}, r.name),
        r.id === store.adminId ? adminChip() : null)),
      el('td', { class: 'num' }, r.days),
      el('td', { class: 'num' }, fmtNum(r.points)));
    }),
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function selectViewUser(id) {
  state.viewUserId = id;
  localStorage.setItem(LS.view, id);
  renderViewSelect();
  renderBoard();
  renderLeaderboard();
}

/** Wochenseite wechseln – jede KW hat eine eigene Adresse (#2026-46). */
function goToWeek(week, direction = 0) {
  week = Math.min(Math.max(week, 1), WEEKS);
  if (week === state.week) return;
  state.pendingDirection = direction;
  location.hash = `#${YEAR}-${week}`;
}

function parseHash() {
  const m = /^#(\d{4})-(\d{1,2})$/.exec(location.hash);
  if (!m || Number(m[1]) !== YEAR) return null;
  const week = Number(m[2]);
  return week >= 1 && week <= WEEKS ? week : null;
}

function showWeekFromHash() {
  const week = parseHash();
  if (!week) {
    history.replaceState(null, '', `#${YEAR}-${state.week || defaultWeek()}`);
    return;
  }
  state.week = week;
  state.flashToday = true; // Woche neu aufgerufen
  renderWeek();
  renderBoard();

  const dir = state.pendingDirection;
  state.pendingDirection = 0;
  const wrap = $('#gridWrap');
  wrap.classList.remove('slide-next', 'slide-prev');
  if (dir) {
    void wrap.offsetWidth;
    wrap.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
  }
}

function onGridClick(ev) {
  const btn = ev.target.closest('td button');
  if (!btn || !isOwnView()) return;
  const day = Number(btn.dataset.day);
  const cityId = btn.dataset.city;
  const current = entryCity(state.me.id, state.week, day);
  setEntry(state.week, day, current === cityId ? null : cityId);
  renderBoard();
  renderLeaderboard();
  renderSync();
  $(`#grid button[data-day="${day}"][data-city="${cityId}"]`)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Dialoge
// ---------------------------------------------------------------------------

function openDialog(id) {
  const d = $(id);
  d.querySelectorAll('.form-error').forEach((e) => (e.textContent = ''));
  d.showModal();
  return d;
}

/** Farben, die andere Profile bereits verwenden. */
function takenColors(exceptUserId) {
  return new Set(listUsers().filter((u) => u.id !== exceptUserId).map((u) => String(u.color).toLowerCase()));
}

/** Farbauswahl: belegte Farben sind gesperrt. */
function renderSwatches(form, selected, exceptUserId) {
  const taken = takenColors(exceptUserId);
  const box = $('[data-swatches]', form);
  form.color.value = selected && !taken.has(selected) ? selected : '';
  const owner = (c) => listUsers().find((u) => u.id !== exceptUserId && String(u.color).toLowerCase() === c)?.name;
  box.replaceChildren(
    ...PALETTE.map((c) => {
      const isTaken = taken.has(c);
      return el('button', {
        type: 'button',
        class: 'swatch',
        style: `--sw:${c}`,
        dataset: { color: c },
        disabled: isTaken,
        'aria-pressed': form.color.value === c ? 'true' : 'false',
        'aria-label': isTaken ? `Boja zauzeta (${owner(c)})` : 'Odaberi boju',
        title: isTaken ? `Zauzeto: ${owner(c)}` : '',
        onclick: () => {
          form.color.value = c;
          box.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === c)));
        },
      });
    }),
  );
}

function openLogin(userId) {
  const form = $('#loginForm');
  form.reset();
  const selected = userId || state.viewUserId;
  form.userId.replaceChildren(...listUsers().map((u) => el('option', { value: u.id, selected: u.id === selected }, u.name)));
  openDialog('#loginDialog');
  form.pin.focus();
}

function openProfile() {
  const form = $('#profileForm');
  form.name.value = state.me.name;
  renderSwatches(form, String(state.me.color).toLowerCase(), state.me.id);
  openDialog('#profileDialog');
}

function openCities() {
  renderCityList();
  $('#addCityForm').reset();
  $('#cityError').textContent = '';
  openDialog('#citiesDialog');
  $('#addCityForm').name.focus();
}

const kmText = (km) => String(km).replace('.', ',');

function renderCityList() {
  if (!isAdmin()) {
    $('#citiesDialog').close();
    return;
  }
  const list = $('#cityList');
  const cities = allCities();
  // Liste nicht neu aufbauen, während gerade ein Feld bearbeitet wird
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  if (cities.length === 0) {
    list.replaceChildren(el('li', { class: 'hint', style: 'display:block' }, 'Još nema gradova.'));
    return;
  }
  list.replaceChildren(
    ...cities.map((c, i) => {
      const nameInput = el('input', { value: c.name, maxlength: 40, 'aria-label': 'Grad' });
      const kmInput = el('input', { value: kmText(c.km), inputmode: 'decimal', 'aria-label': 'Kilometri' });
      const save = () => {
        if (nameInput.value.trim() === c.name && kmInput.value.trim() === kmText(c.km)) return;
        try {
          saveCity(c.id, nameInput.value, kmInput.value);
          $('#cityError').textContent = '';
        } catch (err) {
          $('#cityError').textContent = err.message;
          nameInput.value = c.name;
          kmInput.value = kmText(c.km);
        }
        nameInput.blur();
        kmInput.blur();
        renderAll();
      };
      nameInput.addEventListener('change', save);
      kmInput.addEventListener('change', save);
      return el('li', {},
        el('span', { class: 'idx' }, `${i + 1}.`),
        nameInput,
        kmInput,
        el('button', {
          type: 'button',
          class: 'del',
          title: 'Obriši grad',
          'aria-label': `Obriši ${c.name}`,
          onclick: () => {
            if (!confirm(`Obrisati „${c.name}“? Unosi SVIH korisnika s tim gradom također će biti uklonjeni.`)) return;
            try {
              deleteCity(c.id);
            } catch (err) {
              $('#cityError').textContent = err.message;
            }
            renderAll();
          },
        }, '✕'));
    }),
  );
}

/** Merker "Start-PIN muss noch geändert werden" setzen und ggf. Dialog öffnen. */
function setMustChangePin(value) {
  if (!state.me || !!state.me.mustChangePin === value) {
    if (value && !$('#pinDialog').open) openPinDialog(true);
    return;
  }
  state.me = { ...state.me, mustChangePin: value };
  saveJson(LS.me, state.me);
  if (value && !$('#pinDialog').open) openPinDialog(true);
}

/** PIN-Dialog: forced = nach Anmeldung mit der Start-PIN (nicht abbrechbar). */
function openPinDialog(forced) {
  const d = $('#pinDialog');
  const f = $('#pinForm');
  f.reset();
  $('.form-error', f).textContent = '';
  $('#pinCurrentWrap').hidden = forced;
  f.currentPin.required = !forced;
  $('.dialog-x', d).hidden = forced;
  $('h2', d).textContent = forced ? 'Postavi svoj PIN' : 'Promijeni PIN';
  $('#pinHint').textContent = forced
    ? 'Prijavio/la si se početnim PIN-om. Prije nastavka odaberi svoj osobni PIN (4–8 znamenki).'
    : 'Unesi trenutni PIN i odaberi novi.';
  if (!d.open) d.showModal();
  (forced ? f.newPin : f.currentPin).focus();
}

function bindDialogs() {
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const { token, user, mustChangePin } = await api('POST', '/api/login', { userId: f.userId.value, pin: f.pin.value });
      setSession(token, { ...user, mustChangePin: !!mustChangePin });
      state.viewUserId = user.id;
      localStorage.setItem(LS.view, user.id);
      f.closest('dialog').close();
      renderAll();
      if (mustChangePin) {
        openPinDialog(true);
      } else {
        sync();
        toast(`Bok, ${user.name}!`);
      }
    } catch (e) {
      $('.form-error', f).textContent = e.message;
    }
  });

  $('#profileForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      saveProfile(f.name.value, f.color.value);
      f.closest('dialog').close();
      renderAll();
      toast('Profil je spremljen');
    } catch (e) {
      $('.form-error', f).textContent = e.message;
    }
  });

  $('#changePinBtn').addEventListener('click', () => {
    $('#profileDialog').close();
    openPinDialog(false);
  });

  // Im Pflicht-Modus lässt sich der PIN-Dialog nicht wegklicken (Esc)
  $('#pinDialog').addEventListener('cancel', (ev) => {
    if (state.me?.mustChangePin) ev.preventDefault();
  });

  $('#pinForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const err = $('.form-error', f);
    const forced = !!state.me?.mustChangePin;
    if (!/^[0-9]{4,8}$/.test(f.newPin.value)) {
      err.textContent = 'PIN mora imati 4 do 8 znamenki';
      return;
    }
    if (f.newPin.value !== f.newPin2.value) {
      err.textContent = 'PIN-ovi se ne podudaraju';
      return;
    }
    try {
      await api('POST', '/api/pin', { currentPin: forced ? undefined : f.currentPin.value, newPin: f.newPin.value });
      setMustChangePin(false);
      f.closest('dialog').close();
      toast(forced ? `Dobro došli, ${state.me.name}! PIN je postavljen.` : 'PIN je promijenjen');
      sync();
    } catch (e) {
      err.textContent = e.message;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    if (outbox.size && state.online) await sync();
    const pending = outbox.size;
    if (state.token) api('POST', '/api/logout').catch(() => {});
    setSession(null, null);
    $('#profileDialog').close();
    renderAll();
    toast(pending ? `Odjavljeni ste. ${pending} promjena čeka sljedeću prijavu na ovom uređaju.` : 'Odjavljeni ste');
  });

  $('#deleteProfileBtn').addEventListener('click', async () => {
    if (!confirm('Trajno obrisati profil sa svim gradovima i unosima? Ovo se ne može poništiti.')) return;
    try {
      await api('DELETE', '/api/me');
      const id = state.me.id;
      outbox = new Map();
      saveOutbox();
      localStorage.removeItem(LS.outbox(id));
      setSession(null, null);
      state.viewUserId = null;
      $('#profileDialog').close();
      await sync();
      toast('Profil je obrisan');
    } catch (e) {
      $('.form-error', $('#profileForm')).textContent = e.message;
    }
  });

  $('#addCityForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      saveCity(null, f.name.value, f.km.value);
      f.reset();
      $('#cityError').textContent = '';
      renderAll();
      f.name.focus();
    } catch (e) {
      $('#cityError').textContent = e.message;
    }
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function migrateOldKeys() {
  // Schlüssel aus früheren Versionen übernehmen
  const oldToken = localStorage.getItem('ranking.token');
  if (oldToken && !state.token) {
    state.token = oldToken;
    localStorage.setItem(LS.token, oldToken);
  }
  for (const k of ['ranking.token', 'ranking.view', 'ranking.year']) localStorage.removeItem(k);
}

async function init() {
  migrateOldKeys();
  loadOutbox();
  bindDialogs();

  $('#grid').addEventListener('click', onGridClick);
  $('#viewUser').addEventListener('change', (e) => selectViewUser(e.target.value));
  $('#manageCitiesBtn').addEventListener('click', openCities);
  $('#syncStatus').addEventListener('click', () => sync());

  // Wochen blättern: Pfeile, Tastatur, Wischen
  $('#prevWeek').addEventListener('click', () => goToWeek(state.week - 1, -1));
  $('#nextWeek').addEventListener('click', () => goToWeek(state.week + 1, 1));
  $('#todayBtn').addEventListener('click', () => {
    const w = defaultWeek();
    if (w !== state.week) goToWeek(w, w > state.week ? 1 : -1);
  });
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') goToWeek(state.week - 1, -1);
    else if (e.key === 'ArrowRight') goToWeek(state.week + 1, 1);
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
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) goToWeek(state.week + 1, 1);
      else goToWeek(state.week - 1, -1);
    }
  }, { passive: true });
  window.addEventListener('hashchange', showWeekFromHash);

  state.week = parseHash() || defaultWeek();
  state.flashToday = true; // erste angezeigte Woche
  history.replaceState(null, '', `#${YEAR}-${state.week}`);

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
  // Tageswechsel (Markierung "heute") aktuell halten
  setInterval(() => renderBoard(), 10 * 60 * 1000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
