# Visual-Analytic-Project

**Oceanus Fleet Watch** — an interactive visual analytics dashboard for the VAST Challenge 2024 (Mini-Challenge 2). It shows which fishing companies spend time inside Oceanus' ecological preserves, and when.

## Views

- **Chart of Oceanus** — a nautical-chart map drawn with D3 from the Oceanus GeoJSON: islands, fishing grounds, hatched ecological preserves, ports and buoys, plus vessel tracks. Dashed lines mark transponder gaps (more than 12 h between the end of one ping and the next). Scroll or use the buttons to zoom; the corner readout shows the cursor position in degrees and minutes. The sea and islands carry procedural relief in nautical-chart style: depth bands, isobaths (5–150 m), soundings when zoomed in, surf lines and terrain contours. The seabed is generated for context and is not survey data. Boat markers show each vessel's last known position and heading; **Replay** sails the fleet along its pings through the selected period.
- **Suspect companies** — companies ranked by hours spent inside preserves. Click a company for its vessels, a vessel for its preserve visits, or a preserve for the species recorded there (with illustrations) and who fishes it.
- **Activity over time** — weekly hours inside preserves (or cargo landed). Drag across it to filter every view by date.
- **Company → preserve** — flow diagram of hours each company spent in each preserve.

SouthSeafood Express Corp is always highlighted in red. Keyboard: `/` focuses search, `Esc` goes back.

## Run locally

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Rebuild the data

The dashboard loads `data/oceanus.json` (3.5 MB), a compact version of the 138 MB `mc2.json` knowledge graph. To regenerate it, unzip `Data/Mini Challenge 2 (1).zip` and run:

```bash
python scripts/build_data.py "path/to/mc2.json" "path/to/Oceanus Information/Oceanus Geography.geojson"
```
