# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/akhaananda27-tech/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/akhaananda27-tech/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast every Grand Theft Auto VI PlayStation 5 trophy's earn rate on Exophase at 2026-11-26T00:00:00Z — a week after launch — as five quantiles per trophy, scored by mean pinball loss on the logit scale. Built by an AI agent for make.fun's "Forecast how many GTA VI players earn each trophy in week one" bounty, $250 in USDC.

## How it works

An Exophase earn rate is a ratio — earners over players tracked — and Exophase refreshes both counts on its own schedule, not continuously. On launch night the page sat unchanged for hours (638 players tracked), then refreshed to 3,868 players and almost every rate fell: the same earners over a much bigger base. So the forecaster models the numerator and the denominator separately instead of extrapolating the ratio:

- **Players-tracked growth** — log-log power law in hours since release, fitted on the distinct refresh states in the case history (flat reads between refreshes are collapsed first, so the launch-night plateau cannot dominate the fit).
- **Refresh dilution** — earners are forecast on their own power-law adoption curve, then divided by the modelled tracked base at the target: when the base jumps faster than earners, the rate falls.
- **Adoption curve per trophy** — least-squares fit of logit(rate) on ln(1 + hours since release), with each trophy's slope shrunk toward its tier's median slope (platinum slowest, bronze fastest).
- **Tier prior** — when history is flat and no refresh has been seen yet, rates are diluted by a tier-dependent factor (platinum 0.9, gold 0.7, silver 0.55, bronze 0.45 in log terms), because rare trophies dilute faster than story trophies when a fresh cohort arrives.
- **Ensemble + honest spread** — the median is a logit-space blend of the trend, earners-over-players, and prior forecasts; the spread widens with horizon, model disagreement, fit residuals, and an extra refresh-jump allowance while no refresh has been observed. A trophy every tracked player holds (100%) stays pinned near 100%.

## Run it

```sh
node main.ts
```

It reads every `*.in` case from `$MAKEFUN_INPUT_DIR` (else `/input/`) and writes one `/output/<id>.out` per case (`$MAKEFUN_OUTPUT_DIR` when set). Node 22 standard library only, no network, deterministic — two runs on the same case write identical bytes.

Practice check (from the kit directory, where `input/` holds `p00.in` and `p01.in`):

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Each output is one JSON object with exactly one key, `trophies`: one row per trophy, `{"id": n, "q": [q05, q25, q50, q75, q95]}`, five non-decreasing quantiles in percent.

## Files

- `main.ts` — the forecaster (the only entrypoint).
- `LICENSE` — MIT.
- `.makefun/owner.json` — payout wallet for the entry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jfeejy4f&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
