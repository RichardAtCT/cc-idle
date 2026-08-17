#!/bin/sh
# Thin wrapper: forwards to the shared shim with the event name fixed.
exec "$(dirname "$0")/ccidle-hook.sh" PreToolUse
