'use strict';

// dakle-Ranking – kleiner Node-Server.
// Liefert die PWA aus (Ordner /public) und stellt eine JSON-API bereit.
//
// Prinzip: Für jeden Namen werden pro Tag die gefahrenen/gelaufenen Kilometer
// eingetragen. Es gibt keine Accounts: Jedes Gerät wählt einmal "seinen" Namen
// und ist danach über eine zufällige Geräte-Kennung daran gebunden. Ein Gerät
// kann nur die Kilometer seines eigenen Namens eintragen – für heute und
// vergangene Tage, nie für die Zukunft.
//
// Offline-Fähigkeit: Die App speichert alle Daten lokal und schickt Änderungen
// gesammelt an POST /api/sync. Jeder Datensatz hat eine fortlaufende Server-
// Revision (rev); Clients holen nur, was seit ihrer letzten Revision neu ist.
// Konflikte (gleicher Tag auf zwei Geräten geändert) löst "last write wins"
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
const MAX_KM_PER_DAY = 2000;
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

const EMPTY_DB = { rev: 0, users: [], entries: [], meta: {} };

function readFileDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('db.json nije moguće pročitati:', err.message);
    return null;
  }
}

/** Datenstand vervollständigen und ältere Formate (Kalender/Städte/PIN) aufräumen. */
function normalizeDb(raw) {
  const data = Object.assign(JSON.parse(JSON.stringify(EMPTY_DB)), raw || {});
  const now = Date.now();
  data.rev = data.rev || 0;
  data.meta = data.meta || {};
  // Aus früheren Versionen: Städte, Sitzungen und Kalender-Einträge werden nicht mehr verwendet
  delete data.cities;
  delete data.sessions;
  data.entries = data.entries.filter((e) => typeof e.date === 'string');
  for (const u of data.users) {
    for (const k of ['salt', 'pinHash', 'mustChangePin', 'profileUpdatedAt']) delete u[k];
  }
  for (const list of [data.users, data.entries]) {
    for (const r of list) {
      if (!r.rev) r.rev = ++data.rev;
      if (!r.updatedAt) r.updatedAt = now;
    }
  }
  return data;
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
const activeUsers = () => db.users.filter((u) => !u.deleted);

/** Öffentliche Sicht auf ein Profil (die Geräte-Kennung selbst bleibt geheim). */
const publicUser = (u) => (u.deleted
  ? { id: u.id, deleted: true }
  : { id: u.id, name: u.name, color: u.color, bound: !!u.deviceHash });

// Feste, gut unterscheidbare Farben – jede bekommt nur ein Profil.
const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#65a30d',
  '#ca8a04', '#475569', '#0d9488', '#92400e', '#4338ca', '#c026d3', '#fb7185',
];

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

/** Heutiges Datum (JJJJ-MM-TT) in der Zeitzone der Gruppe. */
function todayInZone() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Prüft ein Datum JJJJ-MM-TT: gültig, im Wettbewerbsjahr, nicht in der Zukunft. */
function cleanDate(value) {
  const s = String(value || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, 'Neispravan datum');
  if (+m[1] !== YEAR) throw new HttpError(400, `Unosi su mogući samo za ${YEAR}.`);
  if (s > todayInZone()) throw new HttpError(400, 'Budući dani se ne mogu unositi');
  return s;
}

/** km: null/leer = Eintrag löschen, sonst Zahl 0–MAX_KM_PER_DAY (eine Nachkommastelle). */
function cleanKm(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_KM_PER_DAY) {
    throw new HttpError(400, `Kilometri moraju biti broj između 0 i ${MAX_KM_PER_DAY}`);
  }
  const km = Math.round(n * 10) / 10;
  return km > 0 ? km : null;
}

function cleanTime(value) {
  const t = Number(value);
  // Zeitstempel aus der Zukunft auf "jetzt" begrenzen (falsch gehende Uhren)
  return Number.isFinite(t) && t > 0 ? Math.min(t, Date.now() + 60000) : Date.now();
}

// ---------------------------------------------------------------------------
// Geräte-Bindung
// ---------------------------------------------------------------------------

/** Geräte-Kennung aus dem Header (zufällig erzeugt und im Browser gespeichert). */
function deviceKey(req) {
  const id = String(req.headers['x-device-id'] || '').trim();
  return /^[a-f0-9]{32,64}$/.test(id) ? id : null;
}

const hashDevice = (id) => crypto.createHash('sha256').update(id).digest('hex');

/** Profil, an das dieses Gerät gebunden ist (oder null). */
function deviceUser(req) {
  const id = deviceKey(req);
  if (!id) return null;
  const h = hashDevice(id);
  return activeUsers().find((u) => u.deviceHash === h) || null;
}

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

/** Eine Änderung eines Geräts übernehmen. Wirft HttpError bei ungültigen Daten. */
function applyChange(user, ch) {
  if (ch.type !== 'km') throw new HttpError(400, 'Nepoznata promjena');
  const updatedAt = cleanTime(ch.updatedAt);
  const date = cleanDate(ch.date);
  const km = cleanKm(ch.km);
  const id = `${user.id}:${date}`;
  let entry = db.entries.find((e) => e.id === id);
  if (entry && entry.updatedAt > updatedAt) return false; // veraltete Änderung
  if (!entry) {
    if (km === null) return false;
    entry = { id, userId: user.id, date };
    db.entries.push(entry);
  }
  Object.assign(entry, { km, updatedAt });
  touch(entry);
  return true;
}

function syncResponse(since, extra = {}) {
  return {
    year: YEAR,
    today: todayInZone(),
    rev: db.rev,
    full: since === 0,
    users: db.users.filter((u) => u.rev > since).map(publicUser),
    entries: db.entries.filter((e) => e.rev > since).map(({ id, userId, date, km, updatedAt }) => ({ id, userId, date, km, updatedAt })),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const route = `${req.method} /${parts.join('/')}`;

  // Daten abgleichen: eigene Änderungen hochladen, neue Daten herunterladen
  if (route === 'POST /sync') {
    const body = await readBody(req, 2 * 1024 * 1024);
    const since = Number.isInteger(body.since) && body.since >= 0 && body.since <= db.rev ? body.since : 0;
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, 5000) : [];
    const me = deviceUser(req);
    const results = [];
    if (changes.length) {
      if (!me) throw new HttpError(403, 'Ovaj uređaj još nije povezan s imenom');
      let dirty = false;
      for (const ch of changes) {
        try {
          dirty = applyChange(me, ch) || dirty;
          results.push({ key: ch.key, ok: true });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          results.push({ key: ch.key, ok: false, error: err.message });
        }
      }
      if (dirty) await saveDb();
    }
    // "me": an welchen Namen dieses Gerät gebunden ist (null = an keinen)
    return sendJson(res, 200, syncResponse(since, { results, me: me ? me.id : null }));
  }

  // Gerät einmalig an einen Namen binden
  if (route === 'POST /claim') {
    const id = deviceKey(req);
    if (!id) throw new HttpError(400, 'Nedostaje oznaka uređaja');
    const current = deviceUser(req);
    if (current) throw new HttpError(409, `Ovaj uređaj je već povezan s imenom ${current.name}`);
    const body = await readBody(req);
    const user = activeUsers().find((u) => u.id === body.userId);
    if (!user) throw new HttpError(404, 'Ime nije pronađeno');
    if (user.deviceHash) throw new HttpError(409, `${user.name} je već povezan/a s drugim uređajem`);
    user.deviceHash = hashDevice(id);
    user.boundAt = new Date().toISOString();
    user.updatedAt = Date.now();
    touch(user);
    await saveDb();
    console.log(`Uređaj povezan s imenom ${user.name}`);
    return sendJson(res, 200, { user: publicUser(user) });
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

/** Erstbefüllung einer LEEREN Datenbank mit den Namen aus bootstrap.json. */
async function bootstrap() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(BOOTSTRAP_FILE, 'utf8'));
  } catch {
    return;
  }
  // Jeden Namen aus bootstrap.json anlegen, der noch fehlt (bestehende bleiben unverändert)
  const now = Date.now();
  const existing = new Set(activeUsers().map((u) => u.name.toLowerCase()));
  const used = new Set(activeUsers().map((u) => String(u.color).toLowerCase()));
  const added = [];
  (config.users || []).forEach((raw, i) => {
    const name = String(raw).trim().slice(0, 30);
    if (!name || existing.has(name.toLowerCase())) return;
    const color = PALETTE.find((c) => !used.has(c)) || PALETTE[(activeUsers().length + i) % PALETTE.length];
    used.add(color);
    existing.add(name.toLowerCase());
    db.users.push(touch({ id: newId(), name, color, createdAt: new Date(now + i).toISOString(), updatedAt: now }));
    added.push(name);
  });
  if (!added.length) return;
  await saveDb();
  console.log(`Nova imena iz bootstrap.json: ${added.join(', ')}`);
}

/**
 * Einmaliger Reset über die Umgebungsvariable RESET_USERS, z. B. "Marija" oder
 * "Marija, Leo": löst die Geräte-Bindung (der Name kann neu gewählt werden) und
 * löscht alle Kilometer-Einträge. Jeder Wert wird nur EINMAL angewendet (gemerkt
 * in db.meta) – für einen weiteren Reset derselben Person z. B. "Marija:2".
 */
async function applyResets() {
  const items = (process.env.RESET_USERS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!items.length) return;
  db.meta.appliedResets = db.meta.appliedResets || [];
  const now = Date.now();
  let changed = false;
  for (const item of items) {
    if (db.meta.appliedResets.includes(item)) continue;
    const name = item.split(':')[0].trim().toLowerCase();
    const user = activeUsers().find((u) => u.name.toLowerCase() === name);
    if (!user) {
      console.log(`Reset: ime "${item}" nije pronađeno.`);
      continue;
    }
    delete user.deviceHash;
    delete user.boundAt;
    user.updatedAt = now;
    touch(user);
    for (const e of db.entries) if (e.userId === user.id && e.km) touch(Object.assign(e, { km: null, updatedAt: now }));
    db.meta.appliedResets.push(item);
    changed = true;
    console.log(`Reset: ${user.name} više nije povezan/a s uređajem, unosi obrisani.`);
  }
  if (changed) await saveDb();
}

initStorage()
  .then(bootstrap)
  .then(applyResets)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`dakle-Ranking radi na http://localhost:${PORT} (godina ${YEAR})`);
    });
  })
  .catch((err) => {
    console.error('Pohrana se ne može otvoriti:', err.message);
    process.exit(1);
  });
