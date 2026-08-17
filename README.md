# CC Idle

A terminal idle game that runs alongside [Claude Code](https://claude.com/claude-code).

When Claude Code works autonomously, CC Idle takes the stage: a tmux-driven game pane
fed by real Claude Code telemetry (hook events, tool calls, token usage). The moment
Claude Code needs you — permission prompt, question, turn complete — focus snaps back
to the Claude Code pane with a clear "you're needed" signal.

## Status

Infrastructure phase (event bridge, focus orchestration, TUI shell). Game mechanics
are a later phase.

## License

MIT
