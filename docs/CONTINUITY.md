# Kids-hit continuity + living-story contract

Opt-in path only (`--kids-hit` / `--loop-fill`). Classic pipeline unchanged.

Applies to **every new theme / song / cast** on the kids-hit path (repair is cast-agnostic: toddler lead + optional helper).

## North star

Every beat is a **consequence of the previous one**, under **one objective**, with **motivated cuts** and **motion that continues across cuts**.

Characters should feel like they are **living through something** (notice → act → react → settle), not standing in different places.

A preschooler should answer from picture alone:

1. What is the toddler trying to do?
2. What happened first / next / last?
3. Why did we leave this room?
4. Did any cut feel like a teleport?
5. Who is reacting to whom?

## Rules

| Rule | Meaning |
|------|---------|
| **1 objective** | Whole song = one goal (find teddy, march inside because rain, morning stretch with Mom, …) |
| **1 chain** | Each beat answers “what happens because of that?” (`cause` → `effect` + `interaction`) |
| **1 journey** | Rooms change only when the lead **goes** there (exit → **bridge** → enter); no room backtrack |
| **1 energy curve** | Quiet problem → discovery → fun → **peak** → celebration |
| **No physical contact** | Kids-safe: never hug / kiss / embrace / hold / wrap arms. Near-space play only (look, wave, kneel nearby, clap, dance beside) |
| **Cut motivation** | look / point / exit / object / match_action / energy |
| **Motion bridge** | Wind-up + settle (`actionPhase` / `beatRole`); prefer continue-action over reset-pose |
| **Interaction** | Prefer notice → kneel nearby → look up → wave → stretch → dance beside over stand → wave → stand |
| **Reaction shots** | Helper acts → toddler notice/feel/respond (`beatRole: react`, camera push-in) |
| **Idle business** | Never frozen: toddler bounce/rock; helper weight-shift/nod (motion prompts) |
| **Emotion graph** | Progresses via `emotionIntensity` 1–5 + expressions (curious → surprised → happy → excited) |
| **Camera joins** | `cameraMotion`: lower / track / push_in / pull_back / hold_wide |
| **Visual rhythm** | Timing weights: short react, longer action, peak payoff — not flat chops |
| **Screen continuity** | Same room keeps placement; dual-cast uses mid_left/mid_right with a **visible gap** (no body overlap) |
| **Exit ↔ enter** | When room changes, `enterDir` = opposite of previous `exitDir` |
| **Facing** | Stable in-room; angle only when walking out / entering |
| **Indoor lock** | If objective is indoor / raining, never destination `lawn` |

## Repair pipeline order

1. Spread / dedupe lyric hints (unique lines when lyrics.txt available)
2. Location / pose / arc repair (progressive journey, indoor palette, optional Mom)
3. Clamp beat count (never merge bridges or cross rooms)
4. Insert bridge beats
5. `applyContinuityFields` + `enforceScreenContinuity`
6. Scrub stale geography text; rebuild cause→effect from real rooms
7. **`enforceLivingStory`** — interaction, anti-stand-spam, phases, emotion, camera, walk-to-door
8. Stamp `endPlacement` (Wan must finish where the next still begins)
9. Re-enforce screen slots so next still matches prior `endPlacement`
10. Weighted `assignBeatTimings` by `beatRole` (bridges short, react short, peak long)
11. `validateContinuity` (placement jumps, exit↔enter, backtracks, repeated hints)

## Beat fields (kids-hit)

- `objective` (song-level, also on plan root)
- `storyBeat`: `problem` \| `discovery` \| `fun` \| `celebration`
- `cause`, `effect`, `interaction` (short strings)
- `exitDir`, `enterDir`: `left` \| `right` \| `center` \| `toward_cam` \| `away`
- `cutMotivation`: `look` \| `point` \| `exit` \| `object` \| `match_action` \| `energy`
- `actionPhase` / `beatRole`: `setup` \| `anticipate` \| `action` \| `react` \| `followthrough` \| `peak`
- `cameraMotion`: `none` \| `push_in` \| `track` \| `lower` \| `hold_wide` \| `pull_back`
- `emotionIntensity`: `1`–`5`
- `bridge`: `true` when beat is a doorway/hallway transition still
- `placement.Adam`: `left` \| `center` \| `right` (still **start**; inherited same-room unless walk/exit)
- `endPlacement.Adam`: where Wan should finish (matches next still start)

## Golden example

See `batches/_templates/continuity-golden-rainy-march.json`.
