# Records docs/demo/walkthrough.mp4 with VHS (https://github.com/charmbracelet/vhs); docs/demo/README.md turns it into the GIF.
Output docs/demo/walkthrough.mp4

Set Shell bash
Set FontSize 13
Set Width 1280
Set Height 820
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WaitPattern /^\$/
Set WaitTimeout 300s

# Work on a container-local copy: bind mounts from Docker Desktop are slow to load node_modules from
Hide
Type `export PS1='$ ' && rm -rf /work && cp -r /repo /work && cd /work && node -e "import('./dist/server.js')" && clear`
Enter
Wait
Show

Sleep 600ms
Type "node docs/demo/walkthrough.mjs"
Sleep 400ms
Enter
# The walkthrough takes about 60s and then holds its last screen for 5s
Sleep 70s
