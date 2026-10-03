# cc-idle board demo. Run through record.sh board, which builds ~/shop and resets the save.
Output "out/board.mp4"
Require claude

Set Shell zsh
Set FontSize 18
Set Width 1920
Set Height 1080
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

# Off camera: launch as in demo.tape, dismiss the welcome, and run one turn.
# That turn founds the region, and the board reacts. Its unasked lines are
# limited to one a minute, so wait the minute out before filming.
Hide
Type `cd ~/shop && clear && env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID -u CLAUDE_EFFORT claude --plugin-dir "$PLUGIN_DIR" --settings '{"enabledPlugins":{"cc-idle@cc-idle":false}}' --model sonnet --permission-mode default --allowedTools "Bash(cat:*)" "Bash(ls:*)"`
Enter
Wait+Screen@30s /trust this folder|WELCOME TO CC-IDLE/
Sleep 2s
Down
Enter
Wait+Screen@30s /WELCOME TO CC-IDLE/
Sleep 1s
Type "/idle"
Sleep 500ms
Enter
Sleep 1s
Type "i"
Sleep 1s
Escape
Sleep 1s
Type "Reply with one word: ready."
Enter
Wait+Screen@60s /finished/
Wait+Screen@30s /☞ board/
Sleep 65s
Type "/clear"
Sleep 500ms
Enter
Sleep 2s
Show

# 1. Claude hits a failing command: an incident. The board explains it, unasked.
Sleep 1500ms
Type "Run cat notes.md and tell me what it says."
Sleep 800ms
Enter
Wait+Screen@90s /finished/
Sleep 3s
Screenshot "out/board-01-incident.png"

# 2. Open the board: the explanation in full.
Type "/idle"
Sleep 500ms
Enter
Sleep 1s
Type "c"
Wait+Screen@10s /THE BOARD/
Sleep 5s

# 3. It knows the real rules.
Type "how do I get to Gen-2?"
Sleep 600ms
Enter
Wait+Screen@30s /(?s)get to Gen-2\?.*☞/
Sleep 6s
Screenshot "out/board-02-rules.png"

# 4. And it has opinions.
Type "should we just buy a datacenter?"
Sleep 600ms
Enter
Wait+Screen@30s /(?s)buy a datacenter\?.*☞/
Sleep 6s
Screenshot "out/board-03-banter.png"

# 5. Back to the game.
Enter
Sleep 3s
Hide
Ctrl+C
Ctrl+C
