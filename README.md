# MESI Cache Coherence Simulator

Interactive 2D animation of the MESI cache coherence protocol running across 4 CPU cores on a shared bus.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173

## What it demonstrates

9 step-by-step scenarios covering all key MESI transitions:

| Step | Operation | Protocol event |
|------|-----------|----------------|
| 1 | Core 0 READ 0xA0 | Miss → BusRead → **I→E** |
| 2 | Core 1 READ 0xA0 | Miss → BusRead → Core 0 **E→S**, Core 1 **I→S** |
| 3 | Core 2 READ 0xA0 | Miss → BusRead → 3-way **S** |
| 4 | Core 0 WRITE 0xA0 | Hit(S) → BusUpgr → Cores 1,2 **S→I**, Core 0 **S→M** |
| 5 | Core 3 READ 0xB0 | Miss → BusRead → **I→E** |
| 6 | Core 3 WRITE 0xB0 | Hit(E) → **silent E→M** (no bus!) |
| 7 | Core 1 READ 0xA0 | Miss(I) → BusRead → Core 0 **Flush M→S** |
| 8 | Core 2 WRITE 0xA0 | Miss(I) → BusReadX → Cores 0,1 **S→I**, Core 2 **I→M** |
| 9 | Core 0 READ 0xB0 | Miss(I) → BusRead → Core 3 **Flush M→S** |

## Controls

- **Play / Pause** — automatic step-by-step playback
- **Step** — advance one step manually
- **Reset** — restart from initial state
- **Speed** — 0.5× / 1× / 2× / 3× animation speed

## MESI states

| State | Meaning |
|-------|---------|
| **M** Modified | Dirty, exclusive. Must flush before others can read |
| **E** Exclusive | Clean, exclusive. Silent upgrade to M on write |
| **S** Shared | Clean, multiple cores may hold copies |
| **I** Invalid | Not present. Any access is a cache miss |
