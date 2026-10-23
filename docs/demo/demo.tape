# Renders docs/demo/demo.gif with VHS (https://github.com/charmbracelet/vhs). See docs/demo/README.md.
Output docs/demo/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1240
Set Height 760
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
Type "node docs/demo/demo.mjs"
Sleep 400ms
Enter
Sleep 32s
