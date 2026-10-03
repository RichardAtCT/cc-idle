# cc-idle demo. Run through record.sh, which builds ~/shop and resets the save.
Output "out/demo.mp4"
Require claude

Set Shell zsh
Set FontSize 18
Set Width 1920
Set Height 1080
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

# Launch outside view. Strip the parent session's env. Load the mod from this
# repo (its own store) with the marketplace copy off. Accept the trust prompt
# if it shows; on a trusted folder, Down and Enter on an empty prompt do nothing.
Hide
Type `cd ~/shop && clear && env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID -u CLAUDE_EFFORT claude --plugin-dir "$PLUGIN_DIR" --settings '{"enabledPlugins":{"cc-idle@cc-idle":false}}' --model sonnet --permission-mode default --allowedTools "Bash(node --test:*)" "Bash(grep:*)"`
Enter
Wait+Screen@30s /trust this folder|WELCOME TO CC-IDLE/
Sleep 2s
Down
Enter
Wait+Screen@30s /WELCOME TO CC-IDLE/
Show

# 1. First run: the pane opens beside the transcript with a welcome.
Sleep 6s
Screenshot "out/01-welcome.png"

# 2. Take the keyboard, dismiss the welcome, hand it back.
Type "/idle"
Sleep 500ms
Enter
Sleep 1s
Type "i"
Wait+Screen@10s /Ask Claude anything/
Sleep 2s
Escape
Sleep 1s

# 3. Give Claude real work.
Type "The cart test fails. Find the bug in cart.js, fix it, then run node --test."
Sleep 800ms
Enter
Sleep 3s

# 5. Claude needs permission: the pane says so.
Wait+Screen@120s /needs your permission/
Sleep 3s
Screenshot "out/02-needs-you.png"
Enter

# 6. Turn ends: milestone shipped, completion bonus paid.
Wait+Screen@120s /finished/
Sleep 2s
Type "/idle"
Sleep 500ms
Enter
Sleep 3500ms
Type "g"
Sleep 4s
Screenshot "out/03-after-turn.png"

# 7. Hand the keyboard back; the status line keeps score.
Escape
Sleep 4s
Hide
Ctrl+C
Ctrl+C
