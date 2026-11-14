'use strict';

// dakle-Ranking – kleiner Node-Server.
// Liefert die PWA aus (Ordner /public) und stellt eine JSON-API bereit.
//
// Offline-Fähigkeit: Die App speichert alle Daten lokal und schickt Änderungen
// gesammelt an POST /api/sync. Jeder Datensatz hat eine fortlaufende Server-
// Revision (rev); Clients holen nur, was seit ihrer letzten Revision neu ist.
// Konflikte (gleicher Datensatz auf zwei Geräten geändert) löst "last write wins"
// anhand des Zeitstempels der Änderung (updatedAt).
//
// Speicherung (nötig auf Hostern wie Render Free, deren Dateisystem bei jedem
// Neustart gelöscht wird):
//   MONGODB_URI gesetzt  -> MongoDB Atlas (ein Dokument in Datenbank/Collection "data-dr")
//   DATABASE_URL gesetzt -> Postgres (z. B. Neon, Tabelle dakle_state)
//   sonst                -> lokale Datei data/db.json

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const YEAR = Number(process.env.YEAR) || 2026; // Wettbewerbsjahr
const TIMEZONE = (process.env.TIMEZONE || 'Europe/Zagreb').trim(); // bestimmt, welcher Tag "heute" ist
// Gemeinsame Start-PIN für die Profile aus bootstrap.json (nur als Umgebungsvariable, nie im Repo).
const START_PIN = (process.env.START_PIN || '').trim();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const BOOTSTRAP_FILE = path.join(ROOT, 'bootstrap.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const MONGODB_DB = (process.env.MONGODB_DB || 'data-dr').trim();
const MONGODB_COLLECTION = (process.env.MONGODB_COLLECTION || 'data-dr').trim();
const MONGO_DOC_ID = 'dakle-ranking'; // der komplette Datenstand liegt in diesem einen Dokument

// ---------------------------------------------------------------------------
// Datenhaltung
// ---------------------------------------------------------------------------

const EMPTY_DB = { rev: 0, users: [], sessions: {}, cities: [], entries: [] };

function readFileDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('db.json nije moguće pročitati:', err.message);
    return null;
  }
}

/** Datenstand vervollständigen und ältere Formate nachrüsten. */
function normalizeDb(raw) {
  const data = Object.assign(JSON.parse(JSON.stringify(EMPTY_DB)), raw || {});
  // Ältere Datenstände nachrüsten (Revisionen, Zeitstempel, Tages-Einträge)
  const now = Date.now();
  data.rev = data.rev || 0;
  for (const list of [data.users, data.cities, data.entries]) {
    for (const r of list) {
      if (!r.rev) r.rev = ++data.rev;
      if (!r.updatedAt) r.updatedAt = now;
    }
  }
  for (const e of data.entries) {
    if (!e.day) e.day = 1;
    if (!e.id) e.id = entryKey(e.userId, e.year, e.week, e.day);
  }
  return data;
}

function entryKey(userId, year, week, day) {
  return `${userId}:${year}:${week}:${day}`;
}

let db = normalizeDb(null);
let pool = null; // Postgres-Verbindung, falls DATABASE_URL gesetzt
let mongo = null; // MongoDB-Collection, falls MONGODB_URI gesetzt
let writeChain = Promise.resolve();

const storageName = () => (mongo ? 'mongodb' : pool ? 'postgres' : 'file');

/** Speicher öffnen und Datenstand laden. */
async function initStorage() {
  if (MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 20000, appName: 'dakle-ranking' });
    await client.connect();
    mongo = client.db(MONGODB_DB).collection(MONGODB_COLLECTION);
    const doc = await mongo.findOne({ _id: MONGO_DOC_ID });
    if (doc && doc.state) {
      db = normalizeDb(doc.state);
    } else {
      // Erster Start mit MongoDB: vorhandene lokale Daten übernehmen
      db = normalizeDb(readFileDb());
      await saveDb();
    }
    console.log(`Pohrana: MongoDB ${MONGODB_DB}/${MONGODB_COLLECTION} (${db.users.length} profila, revizija ${db.rev})`);
    return;
  }
  if (!DATABASE_URL) {
    db = normalizeDb(readFileDb());
    console.log(`Pohrana: datoteka ${DB_FILE}`);
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, max: 3, connectionTimeoutMillis: 15000 });
  pool.on('error', (err) => console.error('Postgres:', err.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS dakle_state (
    id integer PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  const res = await pool.query('SELECT data FROM dakle_state WHERE id = 1');
  if (res.rows.length) {
    db = normalizeDb(res.rows[0].data);
  } else {
    // Erster Start mit Datenbank: vorhandene lokale Daten übernehmen
    db = normalizeDb(readFileDb());
    await saveDb();
  }
  console.log(`Pohrana: Postgres (${db.users.length} profila, revizija ${db.rev})`);
}

/**
 * Datenstand dauerhaft speichern. Gibt ein Promise zurück, das erst erfüllt ist,
 * wenn genau dieser Stand geschrieben wurde. Schreibvorgänge laufen nacheinander.
 */
function saveDb() {
  if (mongo) {
    const state = JSON.parse(JSON.stringify(db)); // Momentaufnahme dieses Stands
    const write = writeChain.then(() => mongo.replaceOne(
      { _id: MONGO_DOC_ID },
      { _id: MONGO_DOC_ID, app: 'dakle-ranking', updatedAt: new Date(), state },
      { upsert: true },
    ));
    writeChain = write.catch(() => {});
    return write;
  }
  if (!pool) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
    return Promise.resolve();
  }
  const snapshot = JSON.stringify(db);
  const write = writeChain.then(() => pool.query(
    `INSERT INTO dakle_state (id, data, updated_at) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [snapshot],
  ));
  writeChain = write.catch(() => {}); // ein Fehler blockiert spätere Schreibvorgänge nicht
  return write;
}

/** Datensatz als geändert markieren (neue Revision). */
function touch(record) {
  record.rev = ++db.rev;
  return record;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

const newId = () => crypto.randomBytes(8).toString('hex');

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function checkPin(user, pin) {
  const a = Buffer.from(hashPin(pin, user.salt), 'hex');
  const b = Buffer.from(user.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const activeUsers = () => db.users.filter((u) => !u.deleted);

/**
 * Der festgelegte Benutzer (Admin), der als Einziger die gemeinsame Städteliste
 * bearbeiten darf: Profil mit dem Namen aus ADMIN, sonst das älteste Profil.
 */
function adminUser() {
  const users = activeUsers();
  const wanted = (process.env.ADMIN || '').trim().toLowerCase();
  if (wanted) {
    const named = users.find((u) => u.name.toLowerCase() === wanted);
    if (named) return named;
  }
  return users.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}

const publicUser = (u) => (u.deleted ? { id: u.id, deleted: true } : { id: u.id, name: u.name, color: u.color });

/** Anzahl ISO-Kalenderwochen eines Jahres (52 oder 53). */
function isoWeeksInYear(year) {
  const d = new Date(Date.UTC(year, 11, 28));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Heutiges Datum (JJJJ-MM-TT) in der Zeitzone der Gruppe. */
function todayInZone() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Kalenderdatum (UTC) eines ISO-Wochentags. */
function isoDate(year, week, day) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  monday.setUTCDate(monday.getUTCDate() + day - 1);
  return monday;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 20 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Zahtjev je prevelik'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Neispravan JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function currentUser(req) {
  const token = bearer(req);
  if (!token || !db.sessions[token]) return null;
  return activeUsers().find((u) => u.id === db.sessions[token]) || null;
}

function requireUser(req, { allowPinChange = false } = {}) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Najprije se prijavi');
  // Wer noch die Start-PIN hat, darf erst nach dem Setzen einer eigenen PIN etwas ändern.
  if (user.mustChangePin && !allowPinChange) throw new HttpError(403, 'Najprije postavi svoj novi PIN');
  return user;
}

function cleanName(value, max, label) {
  const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw new HttpError(400, `Polje „${label}“ je obavezno`);
  if (s.length > max) throw new HttpError(400, `Polje „${label}“ smije imati najviše ${max} znakova`);
  return s;
}

function cleanPin(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4,8}$/.test(s)) throw new HttpError(400, 'PIN mora imati 4 do 8 znamenki');
  return s;
}

function cleanKm(value) {
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) {
    throw new HttpError(400, 'Kilometri moraju biti broj između 0 i 100000');
  }
  return Math.round(n * 10) / 10;
}

// Feste, gut unterscheidbare Farben – jede darf nur ein Profil haben.
const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#65a30d',
  '#ca8a04', '#475569', '#0d9488', '#92400e', '#4338ca', '#c026d3', '#fb7185',
];

function colorTaken(color, exceptId) {
  return activeUsers().some((u) => u.id !== exceptId && String(u.color).toLowerCase() === color);
}

function cleanColor(value, exceptId) {
  const color = String(value || '').toLowerCase();
  if (!PALETTE.includes(color)) throw new HttpError(400, 'Neispravna boja');
  if (colorTaken(color, exceptId)) throw new HttpError(409, 'Tu boju već koristi drugi korisnik');
  return color;
}

function cleanTime(value) {
  const t = Number(value);
  // Zeitstempel aus der Zukunft auf "jetzt" begrenzen (falsch gehende Uhren)
  return Number.isFinite(t) && t > 0 ? Math.min(t, Date.now() + 60000) : Date.now();
}

function nameTaken(name, exceptId) {
  return activeUsers().some((u) => u.id !== exceptId && u.name.toLowerCase() === name.toLowerCase());
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = userId;
  return token;
}

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

/** Eine Änderung eines Clients übernehmen. Wirft HttpError bei ungültigen Daten. */
function applyChange(user, ch) {
  const updatedAt = cleanTime(ch.updatedAt);

  if (ch.type === 'city') {
    // Gemeinsame Städteliste – nur der Admin darf sie ändern
    if (adminUser()?.id !== user.id) throw new HttpError(403, 'Gradove može uređivati samo administrator');
    const id = String(ch.id || '');
    if (!/^[\w-]{6,40}$/.test(id)) throw new HttpError(400, 'Neispravan grad');
    let city = db.cities.find((c) => c.id === id);
    if (city && city.updatedAt > updatedAt) return false; // veraltete Änderung
    if (ch.deleted) {
      if (!city) return false;
      Object.assign(city, { deleted: true, updatedAt });
      touch(city);
      for (const e of db.entries) {
        if (e.cityId === id) touch(Object.assign(e, { cityId: null, updatedAt }));
      }
      return true;
    }
    const name = cleanName(ch.name, 40, 'Grad');
    const km = cleanKm(ch.km);
    if (!city) {
      if (db.cities.filter((c) => !c.deleted).length >= 100) throw new HttpError(400, 'Najviše 100 gradova');
      city = { id };
      db.cities.push(city);
    }
    Object.assign(city, { name, km, deleted: false, updatedAt });
    touch(city);
    return true;
  }

  if (ch.type === 'entry') {
    const year = Number(ch.year);
    const week = Number(ch.week);
    const day = Number(ch.day);
    if (year !== YEAR) throw new HttpError(400, `Unosi su mogući samo za ${YEAR}.`);
    if (!Number.isInteger(week) || week < 1 || week > isoWeeksInYear(year)) throw new HttpError(400, 'Neispravan tjedan');
    if (!Number.isInteger(day) || day < 1 || day > 7) throw new HttpError(400, 'Neispravan dan');
    const date = isoDate(year, week, day);
    if (date.getUTCFullYear() !== YEAR) throw new HttpError(400, `Taj dan nije u ${YEAR}.`);
    // Nur heute oder vergangene Tage – "heute" nach der Zeitzone der Gruppe (TIMEZONE).
    if (date.toISOString().slice(0, 10) > todayInZone()) throw new HttpError(400, 'Budući dani se ne mogu unositi');
    const id = entryKey(user.id, year, week, day);
    let entry = db.entries.find((e) => e.id === id);
    if (entry && entry.updatedAt > updatedAt) return false;
    let cityId = null;
    if (ch.cityId) {
      const city = db.cities.find((c) => c.id === ch.cityId && !c.deleted);
      if (!city) throw new HttpError(404, 'Grad nije pronađen');
      cityId = city.id;
    }
    if (!entry) {
      if (!cityId) return false;
      entry = { id, userId: user.id, year, week, day };
      db.entries.push(entry);
    }
    Object.assign(entry, { cityId, updatedAt });
    touch(entry);
    return true;
  }

  if (ch.type === 'profile') {
    if ((user.profileUpdatedAt || 0) > updatedAt) return false;
    const name = ch.name !== undefined ? cleanName(ch.name, 30, 'Ime') : user.name;
    const color = ch.color !== undefined ? cleanColor(ch.color, user.id) : user.color;
    if (nameTaken(name, user.id)) throw new HttpError(409, 'To ime je već zauzeto');
    Object.assign(user, { name, color, profileUpdatedAt: updatedAt, updatedAt });
    touch(user);
    return true;
  }

  throw new HttpError(400, 'Nepoznata promjena');
}

function syncResponse(since, extra = {}) {
  const pick = (list, fields) => list.filter((r) => r.rev > since).map((r) => {
    const o = {};
    for (const f of fields) if (r[f] !== undefined) o[f] = r[f];
    return o;
  });
  return {
    year: YEAR,
    adminId: adminUser()?.id || null,
    rev: db.rev,
    full: since === 0,
    users: db.users.filter((u) => u.rev > since).map(publicUser),
    cities: pick(db.cities, ['id', 'name', 'km', 'deleted', 'updatedAt']),
    entries: pick(db.entries, ['id', 'userId', 'year', 'week', 'day', 'cityId', 'updatedAt']),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  const route = `${method} /${parts.join('/')}`;

  // Daten abgleichen: lokale Änderungen hochladen, neue Daten herunterladen
  if (route === 'POST /sync') {
    const body = await readBody(req, 2 * 1024 * 1024);
    const since = Number.isInteger(body.since) && body.since >= 0 && body.since <= db.rev ? body.since : 0;
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, 5000) : [];
    const results = [];
    if (changes.length) {
      const user = requireUser(req);
      let dirty = false;
      for (const ch of changes) {
        try {
          dirty = applyChange(user, ch) || dirty;
          results.push({ key: ch.key, ok: true });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          results.push({ key: ch.key, ok: false, error: err.message });
        }
      }
      if (dirty) await saveDb();
    }
    const me = currentUser(req);
    return sendJson(res, 200, syncResponse(since, { results, mustChangePin: !!me?.mustChangePin }));
  }

  // Profil anlegen (nur online)
  if (route === 'POST /users') {
    const body = await readBody(req);
    const name = cleanName(body.name, 30, 'Ime');
    const pin = cleanPin(body.pin);
    if (nameTaken(name)) throw new HttpError(409, 'To ime je već zauzeto');
    let color;
    if (body.color) {
      color = cleanColor(body.color);
    } else {
      color = PALETTE.find((c) => !colorTaken(c));
      if (!color) throw new HttpError(409, 'Sve boje su već zauzete');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const user = touch({ id: newId(), name, color, salt, pinHash: hashPin(pin, salt), createdAt: new Date(now).toISOString(), updatedAt: now });
    db.users.push(user);
    const token = createSession(user.id);
    await saveDb();
    return sendJson(res, 201, { token, user: publicUser(user) });
  }

  if (route === 'POST /login') {
    const body = await readBody(req);
    const user = activeUsers().find((u) => u.id === body.userId);
    if (!user || !checkPin(user, String(body.pin ?? ''))) throw new HttpError(401, 'Pogrešan profil ili PIN');
    const token = createSession(user.id);
    await saveDb();
    return sendJson(res, 200, { token, user: publicUser(user), mustChangePin: !!user.mustChangePin });
  }

  if (route === 'POST /logout') {
    const token = bearer(req);
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      await saveDb();
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /me') {
    const user = currentUser(req);
    return sendJson(res, 200, { user: user ? publicUser(user) : null, mustChangePin: !!user?.mustChangePin });
  }

  // Eigene PIN ändern (Pflicht nach Anmeldung mit der Start-PIN)
  if (route === 'POST /pin') {
    const user = requireUser(req, { allowPinChange: true });
    const body = await readBody(req);
    if (!user.mustChangePin && !checkPin(user, String(body.currentPin ?? ''))) {
      throw new HttpError(401, 'Trenutni PIN nije točan');
    }
    const pin = cleanPin(body.newPin);
    if (checkPin(user, pin)) throw new HttpError(400, 'Novi PIN mora se razlikovati od dosadašnjeg');
    user.salt = crypto.randomBytes(16).toString('hex');
    user.pinHash = hashPin(pin, user.salt);
    user.mustChangePin = false;
    // andere Sitzungen dieses Profils beenden, die aktuelle bleibt
    const current = bearer(req);
    for (const [t, uid] of Object.entries(db.sessions)) if (uid === user.id && t !== current) delete db.sessions[t];
    await saveDb();
    return sendJson(res, 200, { ok: true });
  }

  // Profil inkl. aller Daten löschen (nur online)
  if (route === 'DELETE /me') {
    const user = requireUser(req);
    const now = Date.now();
    // Die gemeinsame Städteliste bleibt erhalten, nur die eigenen Einträge verschwinden.
    for (const e of db.entries) if (e.userId === user.id && e.cityId) touch(Object.assign(e, { cityId: null, updatedAt: now }));
    for (const k of ['name', 'color', 'salt', 'pinHash', 'createdAt', 'profileUpdatedAt']) delete user[k];
    Object.assign(user, { deleted: true, updatedAt: now });
    touch(user);
    for (const [t, uid] of Object.entries(db.sessions)) if (uid === user.id) delete db.sessions[t];
    await saveDb();
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Nepoznata adresa');
}

// ---------------------------------------------------------------------------
// Statische Dateien
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nije pronađeno');
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    // "no-cache" = Browser darf cachen, muss aber per ETag nachfragen -> Updates kommen sofort an.
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      // für den Health Check des Hosters (Render)
      return sendJson(res, 200, { ok: true, storage: storageName(), rev: db.rev });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
    } else {
      throw new HttpError(405, 'Metoda nije dopuštena');
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Interna greška' : err.message });
  }
});

/**
 * Erstbefüllung einer LEEREN Datenbank aus bootstrap.json:
 * Profile mit der gemeinsamen START_PIN (müssen beim ersten Anmelden geändert werden)
 * und die Städte-Route. Läuft nur, wenn noch kein Profil existiert.
 */
async function bootstrap() {
  if (activeUsers().length > 0) return;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(BOOTSTRAP_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!START_PIN) {
    console.log('bootstrap.json postoji, ali START_PIN nije postavljen – profili nisu izrađeni.');
    return;
  }
  const pin = cleanPin(START_PIN);
  const now = Date.now();
  // Admin zuerst anlegen -> ältestes Profil
  const names = (config.users || []).slice().sort((a, b) => (b === config.admin) - (a === config.admin));
  names.forEach((name, i) => {
    const salt = crypto.randomBytes(16).toString('hex');
    db.users.push(touch({
      id: newId(),
      name: cleanName(name, 30, 'Ime'),
      color: PALETTE.find((c) => !colorTaken(c)),
      salt,
      pinHash: hashPin(pin, salt),
      mustChangePin: true,
      createdAt: new Date(now + i).toISOString(),
      updatedAt: now,
    }));
  });
  if (!db.cities.some((c) => !c.deleted)) {
    for (const [name, km] of config.cities || []) {
      db.cities.push(touch({ id: newId(), name: cleanName(name, 40, 'Grad'), km: cleanKm(km), deleted: false, updatedAt: now }));
    }
  }
  await saveDb();
  console.log(`Početni podaci: ${names.length} profila, ${(config.cities || []).length} gradova (admin: ${adminUser()?.name}).`);
}

initStorage()
  .then(bootstrap)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`dakle-Ranking radi na http://localhost:${PORT} (godina ${YEAR})`);
    });
  })
  .catch((err) => {
    console.error('Pohrana se ne može otvoriti:', err.message);
    process.exit(1);
  });
