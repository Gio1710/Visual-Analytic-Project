# Visual-Analytic-Project

Interactive visual analytics for the **VAST Challenge 2024, Mini-Challenge 2**: helping FishEye International find illegal fishing in the fictional Oceanus archipelago, with SouthSeafood Express Corp as the main suspect.

The repository keeps **two versions** of the project side by side, each with its own report, so the work can be compared before and after the redesign.

| | Before: Version 1 | After: Version 2 |
|---|---|---|
| Code | [`v1-original/`](v1-original/) | [`v2-redesign/`](v2-redesign/) |
| Report | [`reports/Report_VAST2024_v1.pdf`](reports/Report_VAST2024_v1.pdf) | [`reports/Report_VAST2024_v2.pdf`](reports/Report_VAST2024_v2.pdf) (English) |
| Date | November 2025 (original submission) | September 2026 (redesign) |

## Repository layout

```
index.html                 landing page linking both versions and both reports
v1-original/               Version 1 exactly as submitted (index.html, script.js, style.css)
  setup_data.py            extracts the raw data v1 needs from the challenge zip
v2-redesign/               Version 2, "Oceanus Fleet Watch"
  index.html, style.css, script.js
  data/oceanus.json        3.5 MB analysis file derived from mc2.json
  data/geography.geojson   Oceanus geography
  scripts/build_data.py    rebuilds data/oceanus.json from mc2.json
reports/                   Report_VAST2024_v1.pdf and Report_VAST2024_v2.pdf
Data/                      original challenge zip (mc2.json, geography, answer sheet)
```

## What changed from v1 to v2

The redesign started as a visual update, but re-checking the data pipeline showed that v1's suspicion signature was not measuring what it intended. The v2 report (Section 2) documents this in detail.

**Analysis**
- **v1 used 41% of the pings.** Pings logged at a region (e.g. *Nemo Reef*) or at a "City of X" location were discarded, including every ping located *inside* a preserve.
- **v1 flagged every remaining ping as suspicious.** `d3.geoContains` reads the GeoJSON's counter-clockwise polygons as "the whole globe except this area", so every buoy tested as inside a preserve. The v1 ranking therefore reflected buoy traffic.
- **v2 uses all 258,542 pings** and ranks companies by **hours of dwell time inside the three ecological preserves**. Transponder gaps now account for dwell time.
- **Result:** SouthSeafood ranks 58th of 83 by volume, but shows a distinctive pattern: 4 visits to Ghoti Preserve (235 h, 2 Feb – 15 Mar 2035), then both vessels stop transmitting on 12–14 May 2035.

**Design**
- A D3 nautical chart replaces Leaflet/OpenStreetMap: procedural bathymetry and island relief, isobaths, soundings, a scale bar in nautical miles and a north arrow. Vessels appear as oriented boat markers, and a **Replay** moves the fleet through time.
- A header toolbar replaces the left sidebar. Below it are a KPI strip and a ranked suspect list that drills down from company to vessel to individual visits. Preserve pages show illustrated species.
- A company → preserve flow diagram replaces the force graph, whose nodes all pointed at a single "Forbidden zone".
- Design tokens drive light and dark themes; the layout works on phones.
- The data is 3.5 MB instead of 138 MB, so v2 runs straight from the repository and on GitHub Pages.

A Figma file documents the v2 design system: colour variables, text styles and the dashboard in both themes. The site does not need it to run; it serves review, collaboration and presentation.

## Run locally

Serve the repository root over HTTP and open the landing page:

```bash
python -m http.server 8000
# http://localhost:8000
```

- **Version 2** works immediately: <http://localhost:8000/v2-redesign/>
- **Version 1** needs its raw data first: run `python v1-original/setup_data.py` (it extracts `mc2.json` and the Oceanus geography from `Data/`; they are git-ignored). Then open <http://localhost:8000/v1-original/>. v1 also references two images that were never committed (`fishes.jpg` and the FishEye logo); it runs without them.

## Rebuild the v2 data

```bash
python v2-redesign/scripts/build_data.py "path/to/mc2.json" "path/to/Oceanus Information/Oceanus Geography.geojson"
```

## Using Version 2

- **Chart of Oceanus:** scroll or use the buttons to zoom, drag to pan. Hover a track or boat to highlight it; click it to open the vessel. Click a preserve or fishing ground to open its page. The seabed relief is generated for context, not survey data.
- **Suspect companies:** ranked by hours inside preserves. The pinned case card keeps SouthSeafood in view.
- **Activity over time:** drag to filter every view by date. Switch between hours in preserves and cargo landed.
- **Company → preserve:** hover a flow to isolate it; click to drill down.
- **Keyboard:** `/` focuses search, `Esc` goes back.

## Tooling

`.claude/`, `.agents/` and `skills-lock.json` hold the design skills (Emil Kowalski's design-engineering skills) used with Claude Code during the redesign. They are not needed to run either version.
