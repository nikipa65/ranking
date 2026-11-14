'use strict';

// Testdaten für die LOKALE Entwicklung (data/db.json):
//   node scripts/seed-test.js           -> Test-Städte + Testbenutzer mit Einträgen anlegen
//   node scripts/seed-test.js --remove  -> alle Testdaten wieder entfernen
//   node scripts/seed-test.js --remove --users -> nur Testbenutzer entfernen, Test-Städte behalten
//
// WICHTIG: Den Server vorher stoppen – er hält den Datenstand im Speicher und würde
// die Datei sonst beim nächsten Speichern überschreiben.
//
// Alles wird als "test: true" markiert. Entfernt wird über Lösch-Markierungen
// (mit neuer Revision), damit auch bereits synchronisierte Geräte es mitbekommen.
// Bestehende eigene Profile und Städte bleiben unverändert; das älteste Profil bleibt Admin.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const YEAR = 2026;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Test-Route (km vom Start). Bereits vorhandene Städte gleichen Namens werden nicht doppelt angelegt.
const TEST_CITIES = [
  ['Graz', 220], ['Maribor', 285], ['Varaždin', 340], ['Karlovac', 455], ['Plitvice', 535],
  ['Zadar', 685], ['Šibenik', 760], ['Split', 845], ['Makarska', 905], ['Dubrovnik', 1065],
];

// Testbenutzer: Name, PIN (nur für lokale Tests), Farbe, Anzahl Tage mit Eintrag, Reichweite (0–1)
const TEST_USERS = [
  ['Test Ana', '1111', '#2563eb', 10, 0.75],
  ['Test Ivan', '2222', '#dc2626', 7, 0.90],
];
const MAX_DAYS = 10; // kein Testbenutzer bekommt mehr Tage
const RECENT_DAYS = 42; // Einträge verteilt auf die letzten 6 Wochen (bis heute)

// ---------------------------------------------------------------------------

function load() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Object.assign({ rev: 0, users: [], sessions: {}, cities: [], entries: [] }, db);
  } catch (err) {
    if (err.code === 'ENOENT') return { rev: 0, users: [], sessions: {}, cities: [], entries: [] };
    throw err;
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/** Deterministischer Zufall, damit die Testdaten reproduzierbar sind. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoWeekDay(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7), day };
}

// ---------------------------------------------------------------------------

function seed(db) {
  const now = Date.now();
  const touch = (r) => Object.assign(r, { rev: ++db.rev, updatedAt: r.updatedAt || now });
  const active = db.users.filter((u) => !u.deleted);

  if (active.some((u) => u.test)) {
    console.log('Testdaten sind schon vorhanden. Erst entfernen: node scripts/seed-test.js --remove');
    return false;
  }

  // Städte
  const existing = new Set(db.cities.filter((c) => !c.deleted).map((c) => c.name.toLowerCase()));
  let addedCities = 0;
  for (const [name, km] of TEST_CITIES) {
    if (existing.has(name.toLowerCase())) continue;
    db.cities.push(touch({ id: crypto.randomBytes(8).toString('hex'), name, km, deleted: false, test: true }));
    addedCities++;
  }
  const cities = db.cities.filter((c) => !c.deleted).sort((a, b) => a.km - b.km);

  // Benutzer (nach den bestehenden angelegt -> das älteste Profil bleibt Admin)
  const usedColors = new Set(active.map((u) => u.color));
  const usedNames = new Set(active.map((u) => u.name.toLowerCase()));
  const created = [];
  TEST_USERS.forEach(([name, pin, color, days, reach], i) => {
    if (usedNames.has(name.toLowerCase())) return;
    if (usedColors.has(color)) {
      console.log(`Farbe ${color} ist belegt – ${name} wird übersprungen.`);
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = touch({
      id: crypto.randomBytes(8).toString('hex'),
      name,
      color,
      salt,
      pinHash: crypto.scryptSync(pin, salt, 32).toString('hex'),
      createdAt: new Date(now + i * 1000).toISOString(),
      test: true,
    });
    db.users.push(user);
    usedColors.add(color);
    created.push({ user, days: Math.min(days, MAX_DAYS), reach, random: rng(1000 + i) });
  });

  // Mögliche Tage: die letzten Wochen bis einschließlich heute (keine Tage in der Zukunft)
  const candidates = [];
  for (let back = 0; back < RECENT_DAYS; back++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    if (d.getFullYear() === YEAR) candidates.push(d);
  }

  let entries = 0;
  for (const { user, days, reach, random } of created) {
    // zufällige, verschiedene Tage auswählen
    const pool = candidates.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const d of pool.slice(0, days)) {
      const { year, week, day } = isoWeekDay(d);
      if (year !== YEAR) continue;
      // je höher "reach", desto häufiger weit entfernte Städte
      const idx = Math.min(cities.length - 1, Math.floor(Math.pow(random(), 1 / (reach * 2)) * cities.length));
      db.entries.push(touch({
        id: `${user.id}:${year}:${week}:${day}`,
        userId: user.id, year, week, day,
        cityId: cities[idx].id,
        test: true,
      }));
      entries++;
    }
  }

  console.log(`Angelegt: ${addedCities} Städte, ${created.length} Testbenutzer, ${entries} Einträge.`);
  console.log('Anmeldung der Testbenutzer: PINs stehen in TEST_USERS in scripts/seed-test.js.');
  return true;
}

function remove(db, { usersOnly = false } = {}) {
  const now = Date.now();
  const touch = (r, patch) => Object.assign(r, patch, { rev: ++db.rev, updatedAt: now });
  let n = 0;
  for (const e of db.entries) if (e.test && e.cityId) { touch(e, { cityId: null }); n++; }
  // Mit --users bleiben die Test-Städte erhalten (eigene Einträge darauf bleiben gültig)
  if (!usersOnly) for (const c of db.cities) if (c.test && !c.deleted) {
    touch(c, { deleted: true });
    for (const e of db.entries) if (e.cityId === c.id) touch(e, { cityId: null });
    n++;
  }
  for (const u of db.users) if (u.test && !u.deleted) {
    for (const k of ['name', 'color', 'salt', 'pinHash', 'createdAt']) delete u[k];
    touch(u, { deleted: true });
    for (const [t, uid] of Object.entries(db.sessions)) if (uid === u.id) delete db.sessions[t];
    n++;
  }
  console.log(n ? `Testdaten entfernt (${n} Datensätze markiert).` : 'Keine Testdaten vorhanden.');
  return n > 0;
}

const db = load();
const changed = process.argv.includes('--remove')
  ? remove(db, { usersOnly: process.argv.includes('--users') })
  : seed(db);
if (changed) save(db);
