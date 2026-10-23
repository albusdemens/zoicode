<p align="center"><img src="art/logo.png" alt="Zoi Code" width="520"></p>
<p align="center"><b>A cozy coding agent for your terminal, powered by Raon.</b></p>

## Install

You need Node.js 22.12+ and a Raon API key.

```sh
npm install -g https://github.com/albusdemens/zoicode/archive/refs/heads/main.tar.gz
```

Then run `zoicode` in your project folder. The first time, it asks for your API key and saves it
to `~/.zoicode/.env`. You can also set `RAON_API_KEY` instead.

Maximize your terminal first: the opening scene needs 116×42.

<p align="center"><img src="docs/session.png" alt="Zoi Code editing a file, with the cat above the prompt" width="75%"></p>

## Use

Type what you want. Raon reads and edits code and runs commands, and asks before changing anything.

- `Shift+Tab` cycles the modes (default → auto-accept edits → plan) · `Esc` interrupts Raon · `Ctrl+C` twice quits
- `!cmd` runs a shell command · `#note` saves a note to `ZOICODE.md` · `@file` attaches a file · `/help` lists the commands
- `zoicode -c` continues the last session · `zoicode -p "…"` answers once and exits, for scripts

Everything else is in the [guide](docs/GUIDE.md).

## Develop

```sh
git clone https://github.com/albusdemens/zoicode.git && cd zoicode
npm install && npm run build && npm link    # puts zoicode on your PATH
npm test
```
