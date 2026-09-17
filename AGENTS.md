# pi-pty-shell — plán/cíl

## Cíl
Rozšíření pro pi (pi-coding-agent) umožňující spouštět **plně interaktivní binárky/skripty**
(vim, htop, nano, git rebase -i, ssh, tmux…) s plnou TTY podporou.

## Architektura (portováno z gemini-cli)
- **Detekce interaktivních příkazů** — seznam ~60 vzorů + env override (INTERACTIVE_COMMANDS / INTERACTIVE_EXCLUDE)
- **user_bash intercept** — `!vim`, `!htop`, `!i <cmd>` → suspend TUI → spawnSync se stdio:inherit → restore TUI
- **pty_exec tool** — LLM agent může sám spustit interaktivní příkaz
- **/pty command** — rychlý přístup pro uživatele
- **@lydell/node-pty** — skutečný PTY spawn (aarch64 prebuild součástí deps)

## Instalace
```
pi install git:github.com/zombiegirlcz/pi-pty-shell
```

## Stav
- [x] package.json + index.ts
- [x] npm install OK (node-pty spawn: function)
- [x] pi -e ./index.ts -p "řekni jen OK" → OK (ext se načte)
- [ ] git push na origin
- [ ] pi install git:… ověření
- [ ] interaktivní test (!htop, !vim) v TUI
