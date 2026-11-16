# dakle-Ranking

Progresivna web-aplikacija (PWA) za zajednički izazov u **2026.** godini: svatko upisuje koliko je kilometara prešao, a poredak se zbraja automatski.

- **Dan kao stranica**: gore je datum s ◀ ▶ (svaki dan ima vlastitu adresu, npr. `#2026-11-16`); listanje i tipkovnicom (← →) ili povlačenjem prsta. Gumb „📅 Danas” vodi na današnji dan.
- **Unos**: ispod datuma je svako ime s poljem „km” i gumbom ✓. Kilometri se mogu upisati za **današnji ili raniji dan** i naknadno ispraviti; budući dani se mogu pogledati, ali ne i uređivati (provjerava i poslužitelj). Prazno polje + ✓ briše unos.
- **Bez prijave**: nema korisničkih računa ni PIN-ova. Svaki uređaj jednom odabere svoje ime („Tko si ti?”) i od tada je trajno povezan s njim putem nasumične oznake uređaja. Na uređaju se mogu mijenjati samo vlastiti kilometri; ime povezano s jednim uređajem ne može odabrati drugi uređaj.
- **Poredak** (desno): 1 bod po kilometru, zbroj svih dana; kod istog broja bodova abecedno.

## Rad bez interneta i sinkronizacija

- Svi podaci spremaju se lokalno na uređaju; unos kilometara radi **i bez interneta**.
- Promjene čekaju u redu i šalju se poslužitelju: **automatski svake 2 minute**, nekoliko sekundi nakon svake promjene, pri ponovnom spajanju na mrežu i pri povratku u aplikaciju.
- Istovremeno se preuzimaju unosi ostalih, pa svi vide isti poredak.
- Status u zaglavlju pokazuje stanje (Sinkronizirano / Izvan mreže / broj promjena na čekanju); klik pokreće sinkronizaciju odmah.
- Samo **odabir imena** (prvo povezivanje uređaja) zahtijeva internetsku vezu.

## Pokretanje

Preduvjet: [Node.js](https://nodejs.org) verzija 18 ili novija.

```bash
npm install
npm start
```

Zatim u pregledniku otvori <http://localhost:3000>. Bez baze podaci se spremaju lokalno u `data/db.json`. Postavke putem varijabli okruženja:

| Varijabla            | Zadano     | Značenje                              |
|----------------------|------------|---------------------------------------|
| `PORT`               | `3000`     | HTTP port                             |
| `MONGODB_URI`        | prazno     | MongoDB Atlas adresa; ako je postavljena, svi podaci se trajno spremaju u MongoDB |
| `MONGODB_DB`         | `data-dr`  | baza u MongoDB-u                      |
| `MONGODB_COLLECTION` | `data-dr`  | kolekcija; svi podaci su u jednom dokumentu s `_id: "dakle-ranking"` |
| `DATABASE_URL`       | prazno     | alternativa: Postgres adresa (npr. Neon), tablica `dakle_state` |
| `DATA_DIR`           | `./data`   | mapa za `db.json` (samo bez baze)     |
| `YEAR`               | `2026`     | godina natjecanja (u aplikaciji: konstanta `YEAR` u `public/app.js`) |
| `TIMEZONE`           | `Europe/Zagreb` | vremenska zona po kojoj poslužitelj određuje „danas” |
| `RESET_USERS`        | prazno     | jednokratni reset, npr. `Marija` ili `Marija, Leo`: ime više nije povezano s uređajem (može se ponovno odabrati), svi kilometri te osobe se brišu. Svaka vrijednost se primjenjuje samo jednom; za ponovni reset iste osobe npr. `Marija:2` |

Imena sudionika nalaze se u `bootstrap.json`: pri pokretanju poslužitelj dodaje svako ime koje još ne postoji (postojeća imena, povezivanja i kilometri ostaju nepromijenjeni).

## Objavljivanje: Render (besplatno) + MongoDB Atlas (besplatno)

Render u besplatnom planu briše datotečni sustav pri svakom ponovnom pokretanju, zato podaci leže u MongoDB Atlasu.

1. **MongoDB Atlas:**
   - *Database Access*: korisnik s pravom čitanja i pisanja.
   - *Network Access*: dodaj `0.0.0.0/0` (*Allow access from anywhere*) – Render u besplatnom planu nema stalnu IP adresu.
   - *Connect → Drivers → Node.js*: kopiraj adresu `mongodb+srv://…` i u njoj zamijeni `<db_password>` lozinkom.
2. **Render:** <https://render.com> → *New → Blueprint* → odaberi repozitorij `ranking` i kod `MONGODB_URI` zalijepi adresu iz Atlasa.
3. `…/health` pokazuje `"storage":"mongodb"` kada je baza spojena.

Napomene:
- Besplatni Render servis „zaspi” nakon ~15 minuta bez prometa; prvo buđenje traje do oko minute. Aplikacija se ipak otvara odmah iz predmemorije uređaja, a unosi se sinkroniziraju čim se poslužitelj probudi.
- Umjesto MongoDB-a može se koristiti i Postgres (npr. Neon) – postavi `DATABASE_URL` umjesto `MONGODB_URI`.
- Nakon promjene datoteka u `public/` povećaj `VERSION` u `public/sw.js`, kako bi instalirane aplikacije dobile novu verziju.

## Instalacija kao aplikacija

PWA se instalira putem „Dodaj na početni zaslon” (iOS/Android) ili ikone za instalaciju u Chromeu/Edgeu.
Za instalaciju na drugim uređajima aplikacija mora biti dostupna preko **HTTPS-a** (Render to daje automatski). Lokalno radi `http://localhost`.

Povezivanje s imenom vrijedi za preglednik na tom uređaju. U drugom pregledniku ili nakon brisanja podataka preglednika uređaj je „nov” – tada pomaže `RESET_USERS`.

## Struktura

```
ranking/
├── server.js              # Node poslužitelj: statične datoteke + JSON API, pohrana u MongoDB, Postgres ili data/db.json
├── bootstrap.json         # početna imena
├── render.yaml            # nacrt za Render (New → Blueprint)
├── package.json
├── public/                # PWA
│   ├── index.html
│   ├── style.css
│   ├── app.js             # lokalna pohrana, red promjena, sinkronizacija, unos km, poredak
│   ├── sw.js              # service worker (aplikacija radi i offline)
│   ├── manifest.webmanifest
│   └── icons/             # ikone aplikacije (SVG + PNG)
└── scripts/make-icons.js  # ponovno generira PNG ikone (npm run icons)
```

## API (kratki pregled)

Svi zahtjevi šalju zaglavlje `X-Device-Id` (nasumična oznaka uređaja, 32 heksadecimalna znaka).

| Metoda  | Putanja       | Opis                                                        |
|---------|---------------|-------------------------------------------------------------|
| POST    | `/api/sync`   | sinkronizacija `{since, changes}` → novi podaci od revizije `since` i `me` (ime povezano s uređajem) |
| POST    | `/api/claim`  | jednokratno povezivanje uređaja s imenom `{userId}`         |
| GET     | `/health`     | stanje poslužitelja i vrsta pohrane                         |

Promjena u `changes`: `{key, type: "km", date: "2026-11-16", km, updatedAt}` – `km: null` briše unos. Dopušteno samo za ime povezano s uređajem, za 2026. i ne za budući dan.
