# Kids-hit continuity contract

Opt-in path only (`--kids-hit` / `--loop-fill`). Classic pipeline unchanged.

## North star

Every beat is a **consequence of the previous one**, under **one objective**, with **motivated cuts** and **motion that continues across cuts**.

A preschooler should answer from picture alone:

1. What is Adam trying to do?
2. What happened first / next / last?
3. Why did we leave this room?
4. Did any cut feel like a teleport?

## Rules

| Rule | Meaning |
|------|---------|
| **1 objective** | Whole song = one goal (find teddy, march inside because rain, wash then eat, …) |
| **1 chain** | Each beat answers “what happens because of that?” (`cause` → `effect`) |
| **1 journey** | Rooms change only when Adam **goes** there (exit → **bridge** → enter) |
| **1 energy curve** | Quiet problem → discovery → fun → peak → calm celebration |
| **Cut motivation** | look / point / exit / object / match_action |
| **Motion bridge** | Prefer continue-action over reset-pose on cut (`actionPhase` + match_action) |

## Beat fields (kids-hit)

- `objective` (song-level, also on plan root)
- `storyBeat`: `problem` \| `discovery` \| `fun` \| `celebration`
- `cause`, `effect` (short strings)
- `exitDir`, `enterDir`: `left` \| `right` \| `center` \| `toward_cam` \| `away`
- `cutMotivation`: `look` \| `point` \| `exit` \| `object` \| `match_action` \| `energy`
- `actionPhase`: `anticipate` \| `action` \| `followthrough`
- `bridge`: `true` when beat is a doorway/hallway transition still

## Forbidden

- Teleport kitchen → lawn with no door/walk beat
- Pose salad with no shared cause
- Flat energy (all “fun” / all happy clap)
- Isolated L/C/R placement for variety alone

## Bridge locations

- `doorway` — interior door / threshold
- `hallway` — short connector between rooms

## Golden example

See `batches/_templates/continuity-golden-rainy-march.json`.
