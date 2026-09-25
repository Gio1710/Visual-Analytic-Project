"""Extract the raw files the original (v1) dashboard loads from the challenge zip.

Usage: python v1-original/setup_data.py
"""
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ZIP = HERE.parent / "Data" / "Mini Challenge 2 (1).zip"
NEEDED = ("mc2.json", "Oceanus Information/Oceanus Geography.geojson", "Oceanus Information/Oceanus Geography Nodes.json")

with zipfile.ZipFile(ZIP) as z:
    for name in NEEDED:
        z.extract(name, HERE)
        print(f"extracted {name}")
