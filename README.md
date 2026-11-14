# dakle-Ranking

Progresivna web-aplikacija (PWA) za izazov po etapama u **2026.** godini:

- **Tjedni kao stranice**: svaki tjedan 2026. (1.–53., ISO) ima vlastitu stranicu (`#2026-46`); listanje strelicama, tipkovnicom (← →) ili povlačenjem prsta.
- **Vodoravno**: dani u tjednu (Pon–Ned) s datumom, današnji dan je označen. Dani izvan 2026. (29.–31.12.2025. i 1.–3.1.2027.) su zatamnjeni i ne mogu se unositi.
- **Okomito**: zajednički gradovi, poredani od najbližeg (gore) do najudaljenijeg (dolje).
- **Trenutni tjedan**: gumb „📅 Trenutni tjedan” jednim klikom vodi na tekući tjedan.
- **Profili**: svaka osoba izrađuje vlastiti profil s imenom, PIN-om i bojom. Svaku boju (15 boja) može imati samo jedan korisnik.
- **Gradovi i kilometri**: jedan zajednički popis za sve. Uređuje ga samo **administrator** – profil naveden u `ADMIN`, inače najstariji profil. Brisanjem grada uklanjaju se i unosi svih korisnika s tim gradom.
- **Unos**: za svaki dan dodirne se grad do kojeg se stiglo (ponovni dodir = brisanje).
- **Bodovi**: 1 bod po kilometru dosegnutog grada – što dalje, to više bodova.
- **Poredak** (desno): zbroj svih dnevnih bodova po osobi za 2026.

## Rad bez interneta i sinkronizacija

- Svi podaci spremaju se lokalno na uređaju. Gradovi, unosi i promjene profila rade **i bez interneta**.
- Promjene čekaju u redu i šalju se poslužitelju čim je veza dostupna: **automatski svake 2 minute**, nekoliko sekundi nakon svake promjene, pri ponovnom spajanju na mrežu i pri povratku u aplikaciju.
- Istovremeno se preuzimaju promjene drugih korisnika, pa svi s različitih mjesta vide isti poredak.
- Status u zaglavlju pokazuje stanje (Sinkronizirano / Izvan mreže / broj promjena na čekanju); klik pokreće sinkronizaciju odmah.
- Ako se isti podatak promijeni na dva uređaja, vrijedi kasnija promjena („last write wins”).
- Samo **izrada profila, prijava i brisanje profila** zahtijevaju internetsku vezu.

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
| `ADMIN`              | prazno     | ime profila koji uređuje gradove; prazno = najstariji profil |

## Objavljivanje: Render (besplatno) + MongoDB Atlas (besplatno)

Render u besplatnom planu briše datotečni sustav pri svakom ponovnom pokretanju, zato podaci leže u MongoDB Atlasu.

1. **MongoDB Atlas:**
   - *Database Access*: korisnik s pravom čitanja i pisanja.
   - *Network Access*: dodaj `0.0.0.0/0` (*Allow access from anywhere*) – Render u besplatnom planu nema stalnu IP adresu.
   - *Connect → Drivers → Node.js*: kopiraj adresu `mongodb+srv://…` i u njoj zamijeni `<db_password>` lozinkom.
2. **Render:** <https://render.com> → *New → Blueprint* → odaberi repozitorij `ranking`. Render čita `render.yaml` i pita za:
   - `MONGODB_URI` → zalijepi adresu iz Atlasa,
   - `ADMIN` → (neobavezno) ime profila koji smije uređivati gradove.
3. Nakon izgradnje aplikacija je dostupna na `https://dakle-ranking.onrender.com` (ili sličnoj adresi). `…/health` pokazuje `"storage":"mongodb"` kada je baza spojena.

Napomene:
- Besplatni Render servis „zaspi” nakon ~15 minuta bez prometa; prvo buđenje traje do oko minute. Aplikacija se ipak otvara odmah iz predmemorije uređaja, a unosi se sinkroniziraju čim se poslužitelj probudi.
- Umjesto MongoDB-a može se koristiti i Postgres (npr. Neon) – postavi `DATABASE_URL` umjesto `MONGODB_URI`.
- Pri prvom pokretanju s bazom poslužitelj preuzima postojeći `data/db.json`, ako postoji.
- Nakon promjene datoteka u `public/` povećaj `VERSION` u `public/sw.js`, kako bi instalirane aplikacije dobile novu verziju.

## Instalacija kao aplikacija

PWA se instalira putem „Dodaj na početni zaslon” (iOS/Android) ili ikone za instalaciju u Chromeu/Edgeu.
Za instalaciju na drugim uređajima aplikacija mora biti dostupna preko **HTTPS-a** (Render to daje automatski). Lokalno radi `http://localhost`.

## Struktura

```
ranking/
├── server.js              # Node poslužitelj: statične datoteke + JSON API, pohrana u MongoDB, Postgres ili data/db.json
├── render.yaml            # nacrt za Render (New → Blueprint)
├── package.json
├── public/                # PWA
│   ├── index.html
│   ├── style.css
│   ├── app.js             # lokalna pohrana, red promjena, sinkronizacija, tablica, poredak
│   ├── sw.js              # service worker (aplikacija radi i offline)
│   ├── manifest.webmanifest
│   └── icons/             # ikone aplikacije (SVG + PNG)
└── scripts/make-icons.js  # ponovno generira PNG ikone (npm run icons)
```

## API (kratki pregled)

| Metoda  | Putanja        | Opis                                                        |
|---------|----------------|-------------------------------------------------------------|
| POST    | `/api/sync`    | sinkronizacija `{since, changes}` → novi podaci od revizije `since` |
| POST    | `/api/users`   | izradi profil `{name, pin, color}`                          |
| POST    | `/api/login`   | prijava `{userId, pin}`                                     |
| POST    | `/api/logout`  | odjava                                                      |
| GET     | `/api/me`      | trenutno prijavljeni profil                                 |
| DELETE  | `/api/me`      | obriši vlastiti profil sa svim podacima                     |

Vrste promjena u `changes` (svaka s `key` i `updatedAt`):

- `{type: "city", id, name, km}` ili `{type: "city", id, deleted: true}` – samo administrator
- `{type: "entry", year, week, day, cityId}` (`day` 1–7 = Pon–Ned, `cityId: null` briše)
- `{type: "profile", name, color}`

Slanje promjena zahtijeva zaglavlje `Authorization: Bearer <token>` dobiveno prijavom ili izradom profila.

## Prilagodba bodova

Pravilo bodovanja nalazi se u `pointsForKm()` u `public/app.js`. Zadano: `Math.round(km)`.
