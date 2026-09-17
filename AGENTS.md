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
- [x] git push na origin (commit 8731c36)
- [x] pi install git:github.com/zombiegirlcz/pi-pty-shell → OK (node-pty OK, spawn: function)
- [x] Tool pty_exec dostupný v pi session (ověřeno přes pi -p)
- [ ] Interaktivní test (!htop, !vim) v TUI — vyžaduje ruční test uživatelem

## Instalace
```bash
pi install git:github.com/zombiegirlcz/pi-pty-shell
```

## Použití
- `!vim file.txt` — auto-detekce interaktivního příkazu
- `!i any-command` — vynutit interaktivní režim
- `!htop`, `!nano`, `!git rebase -i HEAD~3`
- `/pty <command>` — příkaz pro rychlý přístup
- LLM agent může volat tool `pty_exec`
