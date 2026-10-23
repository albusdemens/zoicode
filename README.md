<p align="center"><img src="art/logo.png" alt="Zoi Code" width="520"></p>
<p align="center"><b>A cozy coding agent for your terminal, powered by <a href="https://raon-mini.krafton.ai/en">Raon</a>.</b></p>

## Install

You need Linux, macOS or WSL, Node.js 22.12+, and a Raon API key (apply on the
[Raon site](https://raon-mini.krafton.ai/en), then create one in the Raon console).

```sh
npm install -g --no-fund https://github.com/albusdemens/zoicode/archive/refs/heads/main.tar.gz
```

npm ends with a line like `added 98 packages in 6s`. Run it again to update. (If it fails with
`EACCES`, install Node with [nvm](https://github.com/nvm-sh/nvm) or Homebrew, so global installs don't need sudo.)

Then run `zoicode` in your project folder. The first time, it asks for your API key and saves it
to `~/.zoicode/.env`. You can also set `RAON_API_KEY` instead.

Maximize your terminal first: the opening scene needs 116×42. On macOS, iTerm2, Ghostty or WezTerm
show the colors best.

<p align="center"><img src="docs/session.png" alt="Zoi Code showing an edit for approval, with the cat above the prompt" width="75%"></p>

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
