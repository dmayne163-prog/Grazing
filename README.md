# Wealwandangie Grazing

The farm's own record of paddocks, water, mob movements and pasture. It covers the
parts of AgriWebb this property actually uses, on hardware the property owns, so the
records can't be held hostage to a price rise or a payment arrangement.

Runs on Unraid next to tank-monitor, behind the same Cloudflare Access + app login.

## Roadmap

| Phase | What | Status |
|---|---|---|
| 1 | **Farm map**: import from AgriWebb, draw and edit paddocks, fences, water points, gates; offline imagery | **done** |
| 2 | **Mobs and movements**: mobs with head, class and weight → AE; moves, splits, merges, sales, deaths; record in the paddock offline | mob list + full AgriWebb movement history imported; paddock grazing & rest history; moves recorded in the app |
| 3 | **Rainfall**: gauge records plus SILO. SILO back-fills **before 2020 only**; from 2020 on it is a comparison series against the gauges, never merged | gauge readings: AgriWebb import + entry in the app; SILO to come |
| 4 | **Pasture and projections**: biomass in, growth from rain, intake out → days of grazing left, stocking rates, dry/median/wet outlooks | |
| 5 | **Cibo Labs**: PastureKey biomass by file import, then by API once Cibo grants direct access | |

### Before cancelling AgriWebb

- [x] Map export (paddocks, water points, gates) imported
- [x] Mob list imported (current head, paddocks, last weight), checked against AgriWebb's paddock list
- [ ] Individual animal records (tags/EIDs, per-animal weights), if AgriWebb holds them
- [x] Movement history imported (Movement records report, 18 Sep 2025 onwards; replays exactly onto the mob list)
- [x] Rainfall records imported (AgriWebb has Oct 2025 onwards only; older gauge records to be dug out)
- [ ] PastureKey moved to a direct Cibo Labs subscription (it is currently billed through AgriWebb)

## The map

- **Import**: Tools → Import. Reads AgriWebb's map export (recognised and mapped field by
  field), KML/KMZ, zipped shapefiles (reprojected from MGA via the .prj) and GeoJSON.
  Everything is reviewed before it's added. Shapes that are already on the map are
  unticked, so importing the same export twice doesn't double it.
- **Draw**: paddocks, fences, water points, gates; tracks, pipelines and other areas under
  *More…*. Snapping is on, so a fence drawn along a paddock edge lands on it exactly.
- **Split a paddock**: draw the new part, overshooting the boundary is fine. The original
  keeps its id, name and history; the new part records where it came from.
- **Nothing is ever hard-deleted.** Every change is kept as a revision, so a paddock's area
  *as it was* on any date is recoverable, which stocking-rate history will need after a
  subdivision. Deleted features can be restored from Tools.
- **Export**: GeoJSON (every field) and KML (Google Earth). Both re-import losslessly.

### Areas

Areas are measured on the WGS84 ellipsoid (GeographicLib). They come out **about 0.45%
smaller than AgriWebb's**, about 48 ha across the property. AgriWebb evidently uses the
spherical formula Google Maps uses, which overstates area at this latitude. Imported
paddocks keep AgriWebb's figure as `agriwebb_area_ha` for comparison until their boundary
is changed here.

### Imagery

Tiles are fetched through the server, not by the browser:

- **QLD aerial** (Queensland Government, CC-BY 4.0) is the default. It's cached on disk
  in `DATA_DIR/tiles`, so the map draws on the LAN with the internet down, and phones can
  save the whole property for offline use (Tools → Offline map).
- **Esri satellite** is passed through but never stored; its terms don't allow an offline copy.

Phones only get offline storage when the app is opened through its **https://** address.
Browsers don't run service workers on plain-HTTP LAN addresses.

## Stock

Mobs are stored as **dated events** (opening count, moves, weighings, sales, deaths), and
where a mob is, how many there are and what they weigh is worked out from those events
for any date. AgriWebb's mob list is a snapshot of *today*, so it becomes each mob's
opening position.

- **AE is worked from liveweight** (a 450 kg steer = 1 AE, scaled by LW^0.75). AgriWebb
  counts every animal over weaner age as 1 AE whatever it weighs. On the 2026-09-24 list
  that's 2,236 AE against 1,898 by weight. AgriWebb's figure is kept on each mob for
  comparison.
- **A mob can have gates open across several paddocks.** Its AE is spread over their
  combined area, and its head is counted against the first. That's AgriWebb's convention,
  so the numbers can be checked against its paddock list. They agree on every paddock.
- **Agistment cattle** carry an owner and are shown apart from the herd's own numbers.
- AgriWebb exports mobs with no ID and repeated names, so duplicates are given a
  distinguishing name on import. Re-importing the same list is recognised and skipped.

### Movement history

AgriWebb's **Movement records** report (Reports → Movement records, date range set to
all time, Export → Excel) is replayed record by record. There are no mob IDs, so each
record is traced by mob name, paddock and head before. The mobs alive at the end must
match the mob list exactly, or nothing is imported. From the history, each paddock gets
its grazing periods (mob, days, head, head-days) and rests, and the paddock list shows
days since each was last grazed.

What the report doesn't carry: weights (only that a weighing happened) and gates open
across several paddocks. Open gates are only known from the mob list, so they show as
starting on the date of that export.

## Accounts

The same model as tank-monitor: the first administrator is created on first run, from
the LAN only (or with `SETUP_TOKEN`). **Admins** can edit; **viewers** can look.
Remote access goes through Cloudflare Access, and the app verifies the Access token itself.

## Development

```bash
npm install
cp .env.example .env   # set DATA_DIR=./data and CF_ACCESS_REQUIRED=false for local use
npm run dev            # builds and serves on PORT
```

Check an export file without touching the database:

```bash
npm run test:import -- path/to/export.json
```

## Deploying to Unraid

Copy the source to the server and run `./deploy/build-on-unraid.sh`. It serves on port
**8081** (tank-monitor has 8080) with data in `/mnt/user/appdata/grazing`. Cloudflare
Access values go in `/mnt/user/appdata/grazing/local.env`, never in the repo.
