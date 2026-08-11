# Video Pixel Rearranger

Two Python scripts for tile-based video effects using OpenCV and ffmpeg.

---

## Files

| File | Description |
|---|---|
| `rearrange.py` | Spatial shuffle — cuts each frame into tiles and scrambles their positions |
| `rearrange_time.py` | Time offset mosaic — each tile plays the video at a different point in time |
| `requirements.txt` | Python dependencies |

---

## Requirements

- Python 3.8+
- ffmpeg

**Install ffmpeg:**
```bash
# Mac
brew install ffmpeg

# Windows
choco install ffmpeg

# Linux
sudo apt install ffmpeg
```

---

## One-time Setup

```bash
# Create a virtual environment in the project folder
python3 -m venv .venv

# Activate it
source .venv/bin/activate          # Mac/Linux
.venv\Scripts\activate             # Windows

# Install Python dependencies
pip install -r requirements.txt
```

---

## Each Session

Activate the venv before running either script:

```bash
source .venv/bin/activate          # Mac/Linux
.venv\Scripts\activate             # Windows
```

---

## Script 1 — Spatial Shuffle (`rearrange.py`)

Cuts each frame into square tiles and randomly scrambles their positions. The tile size controls the effect — small tiles (~15px) give a fine-grain scramble, large tiles (~80px) relocate recognisable chunks.

```bash
python rearrange.py -i input.mp4 -o out.mp4 -t 50 --seed 42
```

| Flag | Default | Description |
|---|---|---|
| `-i` / `--input` | required | Input video path |
| `-o` / `--output` | required | Output video path |
| `-t` / `--tile-size` | `50` | Tile size in pixels |
| `-s` / `--seed` | none | Fixed seed for repeatable results |
| `--per-frame-shuffle` | off | New scramble every frame (flickering effect) |

**Examples:**
```bash
# 50px tiles, consistent shuffle
python rearrange.py -i storm.mp4 -o out_50.mp4 -t 50 --seed 42

# Fine grain
python rearrange.py -i storm.mp4 -o out_15.mp4 -t 15 --seed 42

# Flickering per-frame scramble
python rearrange.py -i storm.mp4 -o out_flicker.mp4 -t 30 --per-frame-shuffle
```

---

## Script 2 — Time Offset Mosaic (`rearrange_time.py`)

Each tile stays in its original position but plays the video at a different temporal offset. The result is a mosaic where every square is slightly out of phase with its neighbours. Output is shorter than the input by the max offset amount.

```bash
python rearrange_time.py -i input.mp4 -o out_time.mp4 -t 50 -m 2.0 --seed 42
```

| Flag | Default | Description |
|---|---|---|
| `-i` / `--input` | required | Input video path |
| `-o` / `--output` | required | Output video path |
| `-t` / `--tile-size` | `50` | Tile size in pixels |
| `-m` / `--max-offset` | `2.0` | Max temporal offset in seconds |
| `-s` / `--seed` | none | Fixed seed for repeatable results |

**Examples:**
```bash
# 2-second spread, 50px tiles
python rearrange_time.py -i storm.mp4 -o out_time_50.mp4 -t 50 -m 2.0 --seed 42

# Subtle 0.5s spread, fine tiles
python rearrange_time.py -i storm.mp4 -o out_time_fine.mp4 -t 20 -m 0.5 --seed 42

# Big tiles, long spread
python rearrange_time.py -i storm.mp4 -o out_time_chunky.mp4 -t 80 -m 4.0 --seed 42
```

> **Note:** The output will be `input duration − max offset` seconds long. A 10s clip with `-m 2.0` produces an 8s output.
