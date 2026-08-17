# PRD — "CC Idle" Game Mechanics

**Status:** Draft v1
**Depends on:** [docs/PRD.md](PRD.md) (infrastructure) Phases 1–2 complete. Mechanics consume ONLY the Phase 2 telemetry API, save-file abstraction, and replay tool.
**Interface:** TUI (Ink) is the sole interactive surface. Web renderer, if built, is read-only ambient display (see §8).

---

## 1. Design Philosophy (binding constraints)

1. **Productivity mirror, not a game for its own sake.** The game is a reflection of real delegated work happening in Claude Code. It must never compete with the work for attention or incentivise wasteful behaviour.
2. **Near-zero passive income.** When no CC session is working, the economy essentially stops (a token trickle at most, for warm-up feel). Real delegation is the engine. Offline progress: none.
3. **Legible causality.** The player should always be able to answer "why did that number go up?" Every resource maps to a visible real event.
4. **Interruptible by design.** Focus can be yanked at any moment. Every interaction is a 5–30 second decision. No timers that expire, no combos, no action that is lost or punished by walking away mid-way. Anything pending simply waits.
5. **No perverse incentives.** Tokens cost real money. The optimal play must never be "burn more tokens." Enforced via diminishing returns and productive-signal weighting (§5).

## 2. Fantasy & Theme

You are building a **hyperscaler** and the **frontier lab** it powers. Two intertwined tracks:

- **Hyperscaler track (infrastructure):** convert raw compute into capacity — GPUs → racks → datacenters → regions. Infrastructure grants passive *multipliers* on incoming telemetry (not passive income — it amplifies real work, never replaces it).
- **Frontier lab track (research):** consume capacity to hire researchers, run experiments, and train models. This is where progression and prestige live.

**Prestige mechanic — Model Generations.** Shipping a model generation (Gen-1, Gen-2, …) resets infrastructure and lab staff but banks permanent **Breakthroughs** (prestige currency) that buy persistent upgrades (better conversion rates, new building tiers, automation). The generation ladder is the long arc.

## 3. Resources

| Resource | Source | Role |
|---|---|---|
| **Compute (FLOPS)** | Output tokens (weighted, §5) | Primary currency; buys infrastructure |
| **Engineering** | Successful Edit/Write/Bash tool calls | Buys/upgrades lab facilities, unlocks automation |
| **Research Data** | WebSearch/WebFetch/Read calls | Fuels experiments; gates training runs |
| **Reputation** | Clean `Stop` events (completed turns), shipped milestones | Soft-gates hiring tier; decays slowly |
| **Breakthroughs** | Prestige (shipping a generation) | Permanent meta-upgrades |

Session regions: each concurrent CC session is a **region** (named after its project folder). Regions contribute telemetry independently and each carries its own infrastructure multiplier — parallel real work literally scales the economy.

## 4. Telemetry → Game Event Mapping

| Telemetry (Phase 2 API) | Game event |
|---|---|
| `TokenUsage` delta (output tokens) | Compute generated in that region |
| PostToolUse success (Edit/Write/Bash) | +Engineering |
| PostToolUse success (Search/Fetch/Read) | +Research Data |
| PostToolUse **failure** | **Incident** in that region (§6) |
| `SubagentStop` | **Training run completes** — burst payout scaled by subagent duration |
| `Stop` (turn complete) | Milestone shipped: +Reputation, small all-region bonus |
| `UserPromptSubmit` | Region goes hot (visual state; no direct income) |
| New session appears | New region founded (naming moment, small ceremony) |
| Session STALE/dead | Region goes dark; multipliers suspended |

## 5. Anti-Perverse-Incentive System (non-negotiable)

- **Diminishing returns per hour:** compute conversion rate decays within a rolling window (e.g. full rate for the first N tokens/hour/region, then log-scaled). Grinding tokens yields visibly less.
- **Productive-signal weighting:** failed tool calls generate nothing (they generate incidents). Turns ending in `Stop` retroactively grant a completion multiplier on that turn's accrual — finished work is worth more than churn.
- **No purchasable resources.** Nothing in-game can be bought with anything but in-game resources derived from real work.
- **Balance telemetry:** the game logs its own economy stats so tuning is data-driven via `ccidle replay` runs against recorded real sessions.

## 6. Incidents (failure as content)

A failed tool call spawns a small incident in that region ("GPU thermal event", "eval regression", "on-call page"). Incidents:
- Never block income; they apply a mild regional debuff until acknowledged (single keypress) — respecting §1.4.
- Acknowledging grants a sliver of Engineering ("post-mortem"). Failure becomes flavour, not punishment.
- Frequency-capped per region to avoid noisy sessions turning into alert fatigue.

## 7. Progression Skeleton

- **Minutes 0–30 (first session):** buy first GPU, first hire, first training run off a real subagent completion. Tutorial is implicit — the UI narrates the telemetry mapping as it happens.
- **Days 1–7:** fill out a region, discover multipliers, first prestige (Gen-1) reachable within roughly a week of normal CC usage. Tune from replay data, not guesses.
- **Long arc:** generation ladder with escalating requirements; Breakthrough tree emphasising automation (auto-acknowledge incidents, auto-buy tiers) so the game demands *less* interaction as you progress — an idle game that politely gets out of your way is on-theme.
- Numbers deliberately unspecified here: initial constants live in a single `balance.ts`, tuned via replay.

## 8. Interfaces

- **TUI (interactive, v1):** main stage renders the focused region (ASCII rack diagram filling up, braille sparklines for token flow), session strip doubles as region list. All decisions are single-keypress or short menu. NOC-dashboard aesthetic.
- **Web observatory (read-only, stretch):** three.js ambient visualisation (datacenter growing) subscribed to the Phase 2 WebSocket. No inputs, no focus role, no game state of its own. Explicitly out of scope until the TUI game is fun.

## 9. Mechanics Phases

- **M1 — Core economy (numbers only):** resources accruing from live + replayed telemetry, buy menu for infrastructure, diminishing-returns curve active. No prestige, no incidents. *Done when a week of replayed real sessions produces a sane, legible economy.*
- **M2 — Lab & prestige:** hires, training runs, generation shipping, Breakthrough tree v1.
- **M3 — Incidents & polish:** incident system, region ceremonies, narration, sound/bell etiquette.
- **M4 — Observatory (optional):** web ambient renderer.

## 10. Open Questions

1. Should Reputation decay at all, or is decay anti-§1.1 (punishing time off)? (Lean: no decay; it's a mirror, not a treadmill.)
2. Naming: real-world-adjacent flavour (H100s, RLHF) vs invented terms? Legal/taste call.
3. Do regions persist across CC session restarts in the same folder (cwd-keyed) or die with the session? (Lean: cwd-keyed persistence — projects are the durable thing, sessions aren't.)
4. Multiplayer/shared leaderboard across your own machines — worth a Phase 5 thought or never?
