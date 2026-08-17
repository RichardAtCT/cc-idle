#!/bin/sh
# ccidle-hook.sh — shared shim invoked by every per-event wrapper script
# (on-session-start.sh, on-pre-tool-use.sh, ...). See docs/PRD.md §3.1, §7.
#
# Usage: ccidle-hook.sh <EventName>        (hook JSON is read from stdin)
#
# Contract (do not weaken):
#   - NEVER write anything to stdout (Claude Code may interpret stdout as a
#     hook decision) — everything below is redirected to /dev/null.
#   - NEVER exit non-zero, NEVER block. Every step is best-effort; failures
#     fall through to a minimal-but-valid envelope rather than losing the
#     event entirely (PRD §7: unknown/malformed input is still logged).
#   - No Node in this path. Budget: <10ms wall time.

event_name="${1:-Unknown}"

{
  ccidle_home="${CCIDLE_HOME:-$HOME/.ccidle}"
  events_dir="$ccidle_home/events"
  mkdir -p "$events_dir" 2>/dev/null

  input="$(cat 2>/dev/null)"

  # ISO 8601 UTC timestamp, millisecond precision when the platform's `date`
  # supports %3N (GNU date); fall back to second precision otherwise (e.g.
  # BSD/macOS date, which leaves a literal "N" or errors on %3N).
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null)"
  case "$ts" in
    *N|"") ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" ;;
  esac
  [ -n "$ts" ] || ts="1970-01-01T00:00:00Z"

  pane="${TMUX_PANE:-}"

  # session_id is extracted the same way regardless of jq availability, so
  # the on-disk filename always matches the envelope's session_id field even
  # when the jq path below fails partway through.
  session_id="$(printf '%s\n' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' 2>/dev/null | head -n 1)"
  [ -n "$session_id" ] || session_id="unknown"

  # Redaction is applied to the payload's JSON text before it is embedded,
  # never after (so a secret never touches disk even transiently).
  redacted_input="$input"
  redact_sed="$ccidle_home/redact.sed"
  if [ -f "$redact_sed" ]; then
    tmp_redacted="$(printf '%s' "$input" | sed -E -f "$redact_sed" 2>/dev/null)"
    [ -n "$tmp_redacted" ] && redacted_input="$tmp_redacted"
  fi

  line=""
  if command -v jq >/dev/null 2>&1; then
    line="$(printf '%s' "$redacted_input" | jq -c \
      --arg ts "$ts" --arg event "$event_name" --arg pane "$pane" --arg sid "$session_id" '
      (try (if type == "object" then . else {} end) catch {}) as $data
      | (if ($data.tool_name | type) == "string" then $data.tool_name else "" end) as $tool
      | (if ($data.cwd | type) == "string" then $data.cwd else "" end) as $cwd
      | ($data | tojson) as $raw
      | (if ($raw | length) > 4096
          then ({truncated: true} + (if $tool == "" then {} else {tool_name: $tool} end))
          else $data
        end) as $payload
      | {v: 1, ts: $ts, session_id: $sid, event: $event}
        + (if $tool == "" then {} else {tool: $tool} end)
        + (if $cwd == "" then {} else {cwd: $cwd} end)
        + (if $pane == "" then {} else {pane: $pane} end)
        + {payload: $payload}
      ' 2>/dev/null)"
  fi

  if [ -z "$line" ]; then
    # No jq, or the jq pipeline above failed for any reason (malformed JSON,
    # non-object input, etc.) — shell-only fallback so the event is still
    # recorded rather than dropped.
    line="{\"v\":1,\"ts\":\"$ts\",\"session_id\":\"$session_id\",\"event\":\"$event_name\",\"payload\":{\"raw_unavailable\":true}}"
  fi

  safe_session_id="$(printf '%s' "$session_id" | tr '/\\' '__')"
  [ -n "$safe_session_id" ] || safe_session_id="unknown"

  printf '%s\n' "$line" >> "$events_dir/$safe_session_id.jsonl" 2>/dev/null
} >/dev/null 2>&1

exit 0
