# Shiny Hunter

Automated shiny hunting for Pokemon FireRed/LeafGreen on real Nintendo Switch hardware (via GBA NSO app). Uses an ESP32-S3 as a USB gamepad emulator, a capture card for frame analysis, and visual detection to identify shiny Pokemon.

Supports multiple hunt types: starter resets, wild encounters, static gift/fossil resets, and casino prize resets.

## Hardware Setup

| Component | Role |
|-----------|------|
| **Nintendo Switch** | Runs GBA game via NSO (Game Boy Advance app) |
| **ESP32-S3 DevKitC-1** | Emulates a Pokken Tournament DX Pro Pad (USB HID gamepad) |
| **USB capture card** (MiraBox) | Captures Switch HDMI output for frame analysis |
| **Mac** (host) | Runs this Node.js app — sends commands to ESP32, reads frames from capture card |

**Wiring:**
- ESP32 "USB" port (native) → Switch dock USB port (via USB-A-to-C cable)
- ESP32 "COM" port (UART) → Mac (serial commands at 115200 baud)
- Switch HDMI → capture card → Mac USB

The firmware is in `firmware/switch-controller/switch-controller.ino`. Flash it to the ESP32-S3 via Arduino IDE.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings (see Hunt Scenarios below)

# Build
npm run build

# Start the hunter
npm start

# Or dev mode with auto-reload
npm run dev
```

Once running, open the dashboard at **http://localhost:3002/dashboard** and hit `POST /api/hunt/start` to begin.

## Hunt Scenarios

Each scenario requires saving the game in a specific location, then configuring `.env` accordingly. The general workflow is:

1. Save the game in the right spot
2. Set `TARGET_POKEMON`, `HUNT_TYPE`, and other env vars
3. Start the server → start the hunt via API
4. Wait for Discord notification (or watch the dashboard)

### Starter Hunt (Charmander, Squirtle, Bulbasaur)

Reset-based hunt with optional RNG manipulation. Save in Oak's Lab in front of the Pokeball.

```env
TARGET_POKEMON=charmander    # or squirtle, bulbasaur
HUNT_TYPE=starter
HUNT_MODE=switch-rng         # or reset (no RNG)
```

**Flow:** Soft reset → title screen → load save → pick starter from Pokeball → open summary → check if shiny → reset if not.

The `switch-rng` mode uses TID/SID-based RNG manipulation to target specific shiny seeds, dramatically improving odds from 1/8192 to ~1/200 or better.

---

### Fossil Hunt (Aerodactyl, Kabuto, Omanyte)

Reset-based hunt. Revive a fossil at the Cinnabar Island lab.

**Pre-requisite:** Give your fossil to the scientist FIRST, then save the game standing in front of him.

```env
TARGET_POKEMON=aerodactyl    # or kabuto, omanyte
HUNT_TYPE=static
PARTY_SLOT=2                 # slot where revived Pokemon goes (usually 2)
```

**Flow:** Soft reset → load save → talk to scientist (mash A through dialogue) → receive Pokemon → decline nickname → open summary at party slot 2 → check if shiny → reset if not.

---

### Lapras Gift (Silph Co 7F)

Reset-based hunt. The Silph Co employee on 7F gives you a free Lapras.

**Pre-requisite:** Beat your rival on Silph Co 7F, then save in front of the employee.

```env
TARGET_POKEMON=lapras
HUNT_TYPE=static
PARTY_SLOT=2                 # adjust if you have more than 1 Pokemon
```

**Flow:** Soft reset → load save → talk to employee (3 dialogue boxes) → receive Lapras + fanfare → decline nickname → 4 explanation text boxes → open summary → check if shiny → reset if not.

---

### Wild Hunt (Pikachu, Nidoran, etc.)

Walk-in-grass continuous hunt. No soft resets — walks continuously until a shiny sparkle is detected in battle.

**Pre-requisite:** Save while standing in tall grass or on a water tile where the target Pokemon appears.

```env
TARGET_POKEMON=pikachu       # or nidoranm, nidoranf
HUNT_TYPE=wild
```

**Where to find them (LeafGreen):**
- **Pikachu**: Viridian Forest (5%) or Power Plant (25%)
- **Nidoran M**: Route 3, Route 22, Safari Zone
- **Nidoran F**: Route 3, Route 22, Safari Zone

**Flow:** Walk up/down/left/right in a cycle → detect battle screen → wait for Pokemon entry animation → scan 8 frames for sparkle clusters → if shiny: STOP (catch it manually!) → if not: run from battle → continue walking.

When a shiny is found, the bot stops completely so you can catch it manually.

---

### Casino Hunt (Dratini)

**Status: Framework planned, not yet implemented.**

Reset-based hunt. Buy a Pokemon from the Celadon Game Corner prize counter.

**Pre-requisite:** Have enough coins (Dratini costs 4,600 in LeafGreen), save at the prize counter.

```env
TARGET_POKEMON=dratini
HUNT_TYPE=casino
```

The casino hunt type needs menu navigation sequences for the prize exchange dialogue (select Pokemon from list → confirm purchase). This will be implemented when needed.

---

## Target Shiny Team

| # | Pokemon | Evolution | Hunt Type | Location |
|---|---------|-----------|-----------|----------|
| 1 | Charmander | Charizard | starter | Oak's Lab |
| 2 | Aerodactyl | - | fossil (static) | Cinnabar Lab |
| 3 | Dratini | Dragonite | casino | Celadon Game Corner |
| 4 | Lapras | - | static gift | Silph Co 7F |
| 5 | Pikachu | Raichu | wild | Viridian Forest / Power Plant |
| 6 | Nidoran | Nidoking/Nidoqueen | wild | Route 3 / Route 22 |

## API Reference

All endpoints are at `http://localhost:3002`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Current hunt status + lifetime stats |
| `POST` | `/api/hunt/start` | Start hunting |
| `POST` | `/api/hunt/stop` | Stop hunting |
| `GET` | `/api/history` | Hunt history + shiny finds |
| `GET` | `/dashboard` | Live dashboard (auto-selects based on hunt type) |

### RNG-specific endpoints (starter hunt with switch-rng mode)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/rng/status` | RNG engine state, calibration, encounter log |
| `POST` | `/api/rng/set-tid` | Set Trainer ID: `{ "tid": 24248 }` |
| `POST` | `/api/rng/skip-sid` | Skip SID deduction → multi-SID targeting |

### Static hunt endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/static/encounters` | Encounter log for static hunts |

### Wild hunt endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/wild/encounters` | Encounter log for wild hunts |

## Shiny Detection Methods

| Hunt Type | Detection Method |
|-----------|-----------------|
| **Starter / Static / Fossil / Casino** | Summary screen border color analysis — compares hue distribution against known normal/shiny palettes |
| **Wild** | Battle sparkle detection — scans enemy Pokemon region for bright white/yellow pixel clusters during entry animation |

## Project Structure

```
src/
  config.ts              # Environment config
  index.ts               # Entry point — routes to correct engine
  server.ts              # Express API + dashboards
  types.ts               # Shared types

  engine/
    hunt-engine.ts       # Basic soft-reset engine (emulator)
    rng-engine.ts        # RNG manipulation engine (emulator)
    rng-switch.ts        # Switch RNG engine (blind timing)
    wild-hunt.ts         # Wild encounter engine
    static-hunt.ts       # Static/fossil/gift encounter engine
    sequences.ts         # Button press sequences for all hunt types
    iv-calc.ts           # IV calculator (base stats for all supported Pokemon)
    rng.ts               # PRNG (linear congruential, Gen 3)
    pid-finder.ts        # PID identification from stats
    calibration.ts       # TID/SID calibration state
    multi-sid-target.ts  # Multi-SID seed scheduling
    seed-table.ts        # Seed → shiny lookup tables
    sid-deduction.ts     # SID elimination from PID observations

  detection/
    shiny-detector.ts    # Summary screen shiny detection
    battle-shiny.ts      # Battle sparkle detection (wild hunts)
    color-palettes.ts    # Normal/shiny hue signatures per Pokemon
    stats-ocr.ts         # Pixel template matching for stat values
    summary-info.ts      # Summary screen OCR (nature, gender, TID)
    screen-detector.ts   # Screen type classification
    sprite-regions.ts    # Pokemon sprite bounding boxes

  drivers/
    switch-input.ts      # ESP32 serial → Switch USB HID
    capture-card-frames.ts  # ffmpeg capture card frame grab
    emulator-input.ts    # mGBA Lua bridge input
    emulator-frames.ts   # mGBA screenshot capture
    frame-source.ts      # Frame source interface

  services/
    discord.ts           # Discord webhook notifications
    stats.ts             # SQLite hunt statistics

firmware/
  switch-controller/
    switch-controller.ino  # ESP32-S3 Arduino firmware (Pokken pad HID)

data/                    # SQLite DB + calibration JSON (gitignored)
screenshots/             # Encounter screenshots (gitignored)
test/                    # Jest test suites
```

## Supported Pokemon

All Pokemon with base stats (IV calc) and color palettes (shiny detection):

| Pokemon | Base Stats | Color Palette | Hunt Type |
|---------|-----------|---------------|-----------|
| Charmander | hp:39 atk:52 def:43 spa:60 spd:50 spe:65 | orange → yellow/gold | starter |
| Squirtle | hp:44 atk:48 def:65 spa:50 spd:64 spe:43 | blue → green accents | starter |
| Bulbasaur | hp:45 atk:49 def:49 spa:65 spd:65 spe:45 | teal → yellow-green | starter |
| Aerodactyl | hp:80 atk:105 def:65 spa:60 spd:75 spe:130 | purple → pink | fossil |
| Kabuto | hp:30 atk:80 def:90 spa:55 spd:45 spe:55 | brown → green | fossil |
| Omanyte | hp:35 atk:40 def:100 spa:90 spd:55 spe:35 | blue → purple | fossil |
| Lapras | hp:130 atk:85 def:80 spa:85 spd:95 spe:60 | blue → purple | gift |
| Pikachu | hp:35 atk:55 def:30 spa:50 spd:40 spe:90 | yellow → orange-gold | wild |
| Nidoran M | hp:46 atk:57 def:40 spa:40 spd:40 spe:50 | purple → blue | wild |
| Nidoran F | hp:55 atk:47 def:52 spa:40 spd:40 spe:41 | blue → purple/pink | wild |
| Dratini | hp:41 atk:64 def:45 spa:50 spd:50 spe:50 | blue → pink | casino |

## Testing

```bash
npm test                  # All tests (5 suites, 63+ tests)
npm run test:rng          # RNG engine tests
npm run test:switch       # Switch RNG tests
npm run test:pid          # PID identification tests
```

## Environment: Emulator vs Switch

The app supports two environments via `HUNT_ENV`:

- **`emulator`** — Connects to mGBA via Lua bridge (TCP). Supports save states, turbo mode, and memory reads for full RNG manipulation.
- **`switch`** — Uses ESP32-S3 serial + capture card. Supports soft reset (A+B+X+Y), visual detection only. RNG manipulation via blind timing (`switch-rng` mode).

Switch mode is the primary supported path. All hunt types work on Switch hardware.
