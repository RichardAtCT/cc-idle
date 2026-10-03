# CC Idle backtest report

Generated on 2026-08-17 from real Claude Code history on Richard's machine.

Source: `~/.ccidle/corpus-raw/2026-08-17` (826 files, 279,465,147 bytes), a
frozen snapshot of `~/.claude/projects`. The importer read the snapshot, not the
live tree, so the run is repeatable — the live tree changes while it runs.

Commands:

```
ccidle corpus snapshot
ccidle import --claude-dir <snapshot-root>
ccidle backtest --md-out docs/corpus-report-2026-08-17.md
```

Acceptance checks on this machine:

| # | Check | Result |
|---|---|---|
| 1 | Import full history, malformed count reported, zero writes under `~/.claude` | 129 sessions, 0 malformed lines; only this session's own transcript changed, by Claude Code appending to it |
| 2 | Re-run is a manifest-hit no-op in <2s | 0 imported, 129 unchanged, 0.344s |
| 3 | `ccidle replay` plays an imported session in the live TUI | Confirmed — session row, region, resources, incidents and narration all render (see "TUI note" below) |
| 4 | Backtest run twice ⇒ byte-identical JSON | `cmp` clean on both JSON and markdown |
| 5 | Token totals reconciled against raw transcript ±0 | Exact on all four counters for 3 sampled sessions |
| 6 | Doctor retention warning fires | Fired: `cleanupPeriodDays` is not set |
| 7 | Corpus report committed | This file |

TUI note: the imported session renders correctly, but the TUI re-emits its top
block once per second, so the view scrolls. The defect is pre-existing, affects
live sessions the same way, and is unrelated to import.

## Corpus

- Event files replayed: 129
- Sessions: 129
- Events: 53735
- Span: 2026-07-12T08:49:20.913Z → 2026-08-17T13:15:04.388Z (37 day(s))

## Totals

- Turns (UserPromptSubmit): 1091
- Tool calls: 17639 — 17014 ok / 625 failed (96.5% ok)
- Subagent completions: 249
- Tokens: in 159,793 · out 6,197,763 · cache-r 2,071,822,079 · cache-w 64,603,163

| Model | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|
| claude-fable-5 | 55,289 | 3,023,632 | 605,731,634 | 23,317,744 |
| claude-haiku-4-5-20251001 | 1,240 | 49,044 | 2,880,669 | 286,829 |
| claude-opus-4-8 | 10,006 | 814,435 | 430,114,645 | 11,639,121 |
| claude-opus-5 | 31,783 | 1,773,902 | 492,472,777 | 11,195,901 |
| claude-sonnet-5 | 61,475 | 536,750 | 540,622,354 | 18,163,568 |

## Projects (regions)

| Project | Sessions | Turns | Tool calls | Failures | Subagents | Output tokens |
|---|---:|---:|---:|---:|---:|---:|
| scratchpad (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad`) | 1 | 1 | 0 | 0 | 0 | 4 |
| opus (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/01-bugfix/opus`) | 1 | 1 | 11 | 0 | 0 | 2,855 |
| sonnet (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/01-bugfix/sonnet`) | 1 | 1 | 11 | 0 | 0 | 2,895 |
| opus (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/02-feature/opus`) | 1 | 1 | 6 | 0 | 0 | 2,354 |
| sonnet (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/02-feature/sonnet`) | 1 | 1 | 5 | 0 | 0 | 1,968 |
| opus (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/03-refactor/opus`) | 1 | 1 | 6 | 0 | 0 | 10,377 |
| sonnet (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/03-refactor/sonnet`) | 1 | 1 | 19 | 3 | 0 | 18,094 |
| opus (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/04-algorithmic/opus`) | 1 | 1 | 6 | 0 | 0 | 4,363 |
| sonnet (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/02991335-3436-401e-8997-b672ebc1ffac/scratchpad/benchmark/runs/04-algorithmic/sonnet`) | 1 | 1 | 7 | 0 | 0 | 6,599 |
| fable (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/01-bugfix/fable`) | 1 | 1 | 13 | 1 | 0 | 3,956 |
| haiku (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/01-bugfix/haiku`) | 1 | 1 | 14 | 0 | 0 | 4,729 |
| opus5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/01-bugfix/opus5`) | 1 | 1 | 12 | 0 | 0 | 4,335 |
| sonnet5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/01-bugfix/sonnet5`) | 1 | 1 | 12 | 0 | 0 | 3,821 |
| fable (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/02-feature/fable`) | 1 | 1 | 8 | 0 | 0 | 4,447 |
| haiku (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/02-feature/haiku`) | 1 | 1 | 5 | 0 | 0 | 3,145 |
| opus5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/02-feature/opus5`) | 1 | 1 | 8 | 1 | 0 | 5,028 |
| sonnet5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/02-feature/sonnet5`) | 1 | 1 | 6 | 0 | 0 | 1,756 |
| fable (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/03-refactor/fable`) | 4 | 4 | 41 | 5 | 0 | 61,617 |
| haiku (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/03-refactor/haiku`) | 3 | 3 | 42 | 11 | 0 | 24,904 |
| opus5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/03-refactor/opus5`) | 3 | 3 | 66 | 7 | 0 | 93,572 |
| sonnet5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/03-refactor/sonnet5`) | 3 | 3 | 59 | 5 | 0 | 69,350 |
| fable (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/04-algorithmic/fable`) | 2 | 2 | 12 | 0 | 0 | 8,694 |
| haiku (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/04-algorithmic/haiku`) | 2 | 2 | 11 | 0 | 0 | 16,230 |
| opus5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/04-algorithmic/opus5`) | 3 | 3 | 28 | 2 | 0 | 30,323 |
| sonnet5 (`/private/tmp/claude-501/-Users-richardatkinson-projects-willz/e0edc8ac-8462-4fa3-999a-d6e0aa717275/scratchpad/agent-routing-skills/benchmark/harness/runs/04-algorithmic/sonnet5`) | 2 | 2 | 11 | 1 | 0 | 8,536 |
| richardatkinson (`/Users/richardatkinson`) | 4 | 33 | 93 | 6 | 0 | 89,188 |
| projects (`/Users/richardatkinson/projects`) | 11 | 117 | 2343 | 53 | 16 | 1,047,762 |
| africahostingguide (`/Users/richardatkinson/projects/africahostingguide`) | 1 | 7 | 46 | 8 | 0 | 28,698 |
| bas-reveal (`/Users/richardatkinson/projects/bas-reveal`) | 3 | 17 | 92 | 2 | 0 | 29,224 |
| cc-idle (`/Users/richardatkinson/projects/cc-idle`) | 1 | 7 | 102 | 2 | 0 | 79,514 |
| Dialinn (`/Users/richardatkinson/projects/Dialinn`) | 1 | 12 | 150 | 1 | 0 | 136,165 |
| git-purge (`/Users/richardatkinson/projects/git-purge`) | 1 | 17 | 304 | 14 | 7 | 101,975 |
| lagarb (`/Users/richardatkinson/projects/lagarb`) | 1 | 7 | 19 | 0 | 0 | 23,710 |
| portfolio (`/Users/richardatkinson/projects/portfolio`) | 1 | 10 | 83 | 7 | 0 | 46,670 |
| willz (`/Users/richardatkinson/projects/willz`) | 66 | 825 | 13988 | 496 | 226 | 4,220,905 |

### Tool calls by type

| Tool | Calls |
|---|---:|
| Bash | 8941 |
| Edit | 3072 |
| Read | 2678 |
| Write | 899 |
| mcp__claude-in-chrome__computer | 364 |
| ToolSearch | 260 |
| WebFetch | 191 |
| WebSearch | 188 |
| Agent | 185 |
| mcp__claude-in-chrome__javascript_tool | 89 |
| mcp__claude-in-chrome__navigate | 75 |
| SendMessage | 66 |
| mcp__claude-in-chrome__browser_batch | 61 |
| StructuredOutput | 59 |
| mcp__memory__store_memory | 47 |
| mcp__seo__seo_run_report | 46 |
| TaskStop | 44 |
| AskUserQuestion | 37 |
| TaskUpdate | 37 |
| Monitor | 30 |
| DesignSync | 26 |
| mcp__memory__recall_memory | 21 |
| Skill | 21 |
| TaskCreate | 20 |
| Grep | 19 |
| Artifact | 17 |
| mcp__claude-in-chrome__resize_window | 16 |
| mcp__claude-in-chrome__form_input | 15 |
| mcp__claude-in-chrome__tabs_context_mcp | 14 |
| ExitPlanMode | 9 |
| mcp__claude-in-chrome__read_console_messages | 8 |
| mcp__claude-in-chrome__read_page | 8 |
| Glob | 6 |
| mcp__claude-in-chrome__find | 6 |
| mcp__memory__update_memory | 6 |
| mcp__github__actions_list | 5 |
| mcp__plugin_stripe_stripe__stripe_api_search | 5 |
| TaskList | 5 |
| mcp__claude-in-chrome__tabs_close_mcp | 4 |
| TaskOutput | 4 |
| EnterWorktree | 4 |
| RemoteTrigger | 4 |
| SendUserFile | 4 |
| EnterPlanMode | 3 |
| mcp__claude-in-chrome__read_network_requests | 3 |
| mcp__claude-in-chrome__tabs_create_mcp | 3 |
| Workflow | 3 |
| mcp__seo__seo_describe_report | 2 |
| mcp__claude_ai_Google_Drive__read_file_content | 1 |
| ListAgents | 1 |
| mcp__claude-in-chrome__get_page_text | 1 |
| mcp__github__list_pull_requests | 1 |
| mcp__plugin_stripe_stripe__authenticate | 1 |
| mcp__plugin_stripe_stripe__get_stripe_account_info | 1 |
| mcp__plugin_stripe_stripe__stripe_api_details | 1 |
| mcp__plugin_stripe_stripe__stripe_api_write | 1 |
| mcp__seo__seo_list_reports | 1 |

## Activity histograms

### Events by hour of day (UTC)

```
00:00   2555 █████████████
01:00   1120 ██████
02:00   1421 ███████
03:00   3568 ██████████████████
04:00   2741 ██████████████
05:00   2561 █████████████
06:00   3255 ████████████████
07:00   3450 █████████████████
08:00   4430 ██████████████████████
09:00   3746 ███████████████████
10:00   1677 ████████
11:00   3379 █████████████████
12:00   7968 ████████████████████████████████████████
13:00   5367 ███████████████████████████
14:00    302 ██
15:00   3430 █████████████████
16:00    773 ████
17:00    168 █
18:00      0 
19:00      0 
20:00      0 
21:00      0 
22:00    181 █
23:00   1643 ████████
```

### Tokens by day

| Day | Input | Output |
|---|---:|---:|
| 2026-07-12 | 263 | 57,711 |
| 2026-07-15 | 903 | 79,983 |
| 2026-07-16 | 11,059 | 397,622 |
| 2026-07-17 | 1,915 | 359,585 |
| 2026-07-18 | 12,328 | 240,005 |
| 2026-07-19 | 218 | 60,108 |
| 2026-07-20 | 1,568 | 236,587 |
| 2026-07-21 | 7,829 | 145,510 |
| 2026-07-22 | 9,095 | 786,684 |
| 2026-07-23 | 17,290 | 181,644 |
| 2026-07-24 | 2,946 | 218,282 |
| 2026-07-25 | 4 | 3,790 |
| 2026-07-26 | 121 | 30,578 |
| 2026-07-27 | 11,306 | 502,066 |
| 2026-07-28 | 4,721 | 286,995 |
| 2026-07-30 | 521 | 42,879 |
| 2026-07-31 | 218 | 62,242 |
| 2026-08-01 | 4,289 | 230,221 |
| 2026-08-02 | 1,156 | 294,188 |
| 2026-08-03 | 254 | 108,601 |
| 2026-08-05 | 1,673 | 101,938 |
| 2026-08-06 | 34,443 | 358,785 |
| 2026-08-07 | 93 | 51,653 |
| 2026-08-08 | 4,770 | 64,593 |
| 2026-08-10 | 5,554 | 305,582 |
| 2026-08-11 | 20,997 | 347,599 |
| 2026-08-13 | 3,052 | 227,423 |
| 2026-08-15 | 1,068 | 335,395 |
| 2026-08-17 | 139 | 79,514 |

## Top 5 heaviest sessions (by output tokens)

| Session | Project | Events | Turns | Tool calls | Output tokens | Total tokens |
|---|---|---:|---:|---:|---:|---:|
| `8c13be88-2320-4aec-a940-210bc6dd0f74` | /Users/richardatkinson/projects/willz | 4419 | 72 | 1440 | 302,343 | 209,466,223 |
| `22161114-ba47-4cd3-9666-9861a2813e2a` | /Users/richardatkinson/projects | 3547 | 39 | 1194 | 286,629 | 138,811,079 |
| `cf6f0ae3-220c-4a5b-95d6-c2b3bbcb9863` | /Users/richardatkinson/projects | 1003 | 14 | 321 | 229,845 | 85,596,495 |
| `5a31a264-ac0d-4419-b129-6acde3f97c88` | /Users/richardatkinson/projects/willz | 3306 | 56 | 1066 | 214,774 | 180,106,153 |
| `126ea35b-7949-4d49-a9b8-aa1222eba881` | /Users/richardatkinson/projects/willz | 2245 | 23 | 735 | 186,564 | 110,615,796 |

## Economy (game engine replay)

```json
{
  "eventsProcessed": 53735,
  "outputTokensSeen": 6197763,
  "computeFromTokens": 4599939.999871194,
  "computeFromCompletionBonus": 718617.1069165404,
  "computeFromStopBonus": 736750,
  "computeFromTraining": 163992.87574000005,
  "computeSpent": 0,
  "engineeringFromTools": 24774,
  "engineeringFromPostMortems": 0,
  "engineeringSpent": 0,
  "researchFromTools": 3028,
  "researchSpent": 2487,
  "reputationEarned": 917,
  "toolSuccesses": 17014,
  "toolFailures": 625,
  "incidentsSpawned": 174,
  "incidentsAcked": 0,
  "trainingRuns": 249,
  "experiments": 0,
  "generationsShipped": 0,
  "breakthroughsEarned": 0,
  "breakthroughsSpent": 0
}
```

## Known gaps in imported data

- Notification events (permission prompts / idle alerts) leave no transcript trace and are not reconstructed — no HUMAN_ACTIVE signal exists in imported data.
- tmux pane fields are runtime-only and absent from imported envelopes.
- Stop timing is approximated by the last assistant message of each turn.
- Estimated cost is omitted: the repo has no model price table.
