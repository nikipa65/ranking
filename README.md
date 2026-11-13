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

Zatim u pregledniku otvori <http://localhost:3000>. Bez `DATABASE_URL` podaci se spremaju lokalno u `data/db.json`. Postavke putem varijabli okruženja:

| Varijabla      | Zadano     | Značenje                              |
|----------------|------------|---------------------------------------|
| `PORT`         | `3000`     | HTTP port                             |
| `DATABASE_URL` | prazno     | Postgres adresa (npr. Neon); ako je postavljena, svi podaci se trajno spremaju u bazu |
| `DATA_DIR`     | `./data`   | mapa za `db.json` (samo bez `DATABASE_URL`) |
| `YEAR`         | `2026`     | godina natjecanja (u aplikaciji: konstanta `YEAR` u `public/app.js`) |
| `ADMIN`        | prazno     | ime profila koji uređuje gradove; prazno = najstariji profil |

## Objavljivanje: Render (besplatno) + Neon (besplatna baza)

Render u besplatnom planu briše datotečni sustav pri svakom ponovnom pokretanju, zato podaci leže u vanjskoj Postgres bazi.

1. **Baza (Neon):** na <https://neon.tech> otvori besplatan račun → *New Project* (regija npr. *Frankfurt / eu-central-1*) → kopiraj *Connection string* (`postgresql://…?sslmode=require`). Tablicu `dakle_state` poslužitelj izrađuje sam.
2. **Kod na GitHub:** ovaj repozitorij gurni na GitHub (grana `main`).
3. **Render:** na <https://render.com> → *New → Blueprint* → odaberi repozitorij. Render čita `render.yaml` i pita za:
   - `DATABASE_URL` → zalijepi Neon connection string,
   - `ADMIN` → (neobavezno) ime profila koji smije uređivati gradove.
4. Nakon izgradnje aplikacija je dostupna na `https://dakle-ranking.onrender.com` (ili sličnoj adresi). Tu adresu podijeli s ostalima i instaliraj kao aplikaciju.

Napomene:
- Besplatni Render servis „zaspi” nakon ~15 minuta bez prometa; prvo buđenje traje do oko minute. Aplikacija se ipak otvara odmah iz predmemorije uređaja, a unosi se sinkroniziraju čim se poslužitelj probudi.
- Svaka druga Postgres baza (npr. Supabase) također radi – dovoljno je postaviti `DATABASE_URL`. Supabase besplatne projekte pauzira nakon tjedan dana bez korištenja, Neon ne.
- Pri prvom pokretanju s bazom poslužitelj preuzima postojeći `data/db.json`, ako postoji.
- Nakon promjene datoteka u `public/` povećaj `VERSION` u `public/sw.js`, kako bi instalirane aplikacije dobile novu verziju.

## Instalacija kao aplikacija

PWA se instalira putem „Dodaj na početni zaslon” (iOS/Android) ili ikone za instalaciju u Chromeu/Edgeu.
Za instalaciju na drugim uređajima aplikacija mora biti dostupna preko **HTTPS-a** (Render to daje automatski). Lokalno radi `http://localhost`.

## Struktura

```
ranking/
├── server.js              # Node poslužitelj: statične datoteke + JSON API, pohrana u Postgres ili data/db.json
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
