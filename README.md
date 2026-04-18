# custcli

[![CI](https://github.com/NVSRahul/custcli/actions/workflows/ci.yml/badge.svg)](https://github.com/NVSRahul/custcli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

`custcli` is a local orchestration CLI for paired coding workflows.

- `gemini` handles planning and review
- `opencode` handles execution and live editing
- `custcli` coordinates both and stores local artifacts under `.custcli/`

## Trust Model

`custcli` does not run its own OAuth flow.

- it does not host a third-party login page
- it does not proxy Gemini credentials through a custcli service
- it uses the Gemini CLI and OpenCode CLI that are already installed on your machine
- authentication stays with those tools

If `gemini` works in your terminal, `custcli` reuses that local setup.

## Install

Requirements:

- Node.js 20 or newer
- Gemini CLI installed and already authenticated
- OpenCode CLI installed and available on `PATH`

From a local checkout:

```bash
npm install -g .
```

From GitHub:

```bash
npm install -g git+https://github.com/NVSRahul/custcli.git
```

After install:

```bash
custcli --help
```

## Quick Start

Plan only:

```bash
custcli plan --cwd "/path/to/project" "review this codebase and produce a plan"
```

Plan and execute:

```bash
custcli run --cwd "/path/to/project" "implement the requested change"
```

Live TUI:

```bash
custcli live --new-session --planner-model auto
```

Strict live TUI:

```bash
custcli live --new-session --planner-model auto --planner-mode strict
```

Use `strict` only if you want Gemini enforced first on substantive turns. It is more structured, but it can use more context and call Gemini more often than the default `free` mode.

List live sessions:

```bash
custcli sessions
```

Prune old heavy artifacts:

```bash
custcli prune --keep-last 20
```

## Screenshots

- [Gemini running state](./screenshots/running.png)
- [Gemini completed state](./screenshots/done.png)

## Platform Notes

`custcli` is written in Node.js and uses direct process spawning plus Node path handling. It is designed to work on macOS, Linux, and Windows.

Practical notes:

- on Windows, use PowerShell or Windows Terminal
- make sure both `gemini` and `opencode` are installed and callable from the same shell
- the live TUI requires a normal interactive terminal

## Documentation

The full manual is in [HELP.md](./HELP.md).

License: [MIT](./LICENSE)
