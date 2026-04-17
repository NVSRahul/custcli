# HELP

## Overview

`custcli` is a local CLI for paired coding workflows.

- `gemini` is used as the planner and reviewer
- `opencode` is used as the executor and live coding interface
- `custcli` coordinates the loop, stores artifacts, and keeps continuity data

It supports:

- headless planning
- headless plan -> execute -> review workflows
- live OpenCode sessions with Gemini planning and review tools
- local artifact retention and pruning

## Security and Auth

`custcli` does not implement its own third-party OAuth flow.

What that means:

- there is no custcli-hosted login page
- there is no custcli account system
- there is no custcli cloud service that receives your Gemini login
- Gemini authentication stays inside the Gemini CLI you already installed
- OpenCode authentication stays inside OpenCode

`custcli` launches those local CLIs from your machine and works with the results they return.

## Supported Platforms

`custcli` is designed for:

- macOS
- Linux
- Windows

Why it is cross-platform:

- it is written in Node.js
- it uses `child_process.spawn`, not shell-specific command chaining
- it uses Node `path` utilities for filesystem paths

Practical requirements:

- Node.js 20 or newer
- a working `gemini` command on `PATH`
- a working `opencode` command on `PATH`
- a normal interactive terminal for live mode and the sessions picker

Windows notes:

- use PowerShell or Windows Terminal
- quote paths with spaces
- install `gemini` and `opencode` in the same shell environment you will use for `custcli`

Repository note:

- a GitHub Actions workflow is included for macOS, Linux, and Windows Node test runs
- that validates the Node-side CLI code path across platforms
- it does not replace real end-to-end Gemini/OpenCode checks on your target machine

## Installation

### Global install from a local checkout

From the repository root:

```bash
npm install -g .
```

Then from any directory:

```bash
custcli --help
```

### Global install from GitHub

```bash
npm install -g git+https://github.com/NVSRahul/custcli.git
```

### Local development usage

If you do not want a global install:

```bash
npm start -- --help
```

That runs the local CLI entrypoint from this repository only.

## Run From Any Directory

After global install, `custcli` works from whatever directory you are currently in.

Examples:

```bash
cd "/path/to/project"
custcli live --planner-model auto
```

```bash
cd "/path/to/project"
custcli run "fix the failing tests"
```

```bash
cd "/path/to/project"
custcli plan "review the architecture and give me the safest migration plan"
```

If you want to target a different directory than your current one, use `--cwd`.

Example:

```bash
custcli run --cwd "/path/to/project" "implement the requested change"
```

## Command Summary

Top-level commands:

```text
run [prompt...]        Plan with Gemini, then execute with OpenCode
plan [prompt...]       Plan with Gemini only
live [prompt...]       Open a live OpenCode TUI session with Gemini planning/review tools
sessions               List known custcli live sessions
prune                  Prune old raw artifacts and stale live metadata
gemini -- [args...]    Pass arguments directly to the configured Gemini CLI
opencode -- [args...]  Pass arguments directly to the configured OpenCode CLI
help                   Show help
```

If you omit the command, `custcli` defaults to `run`.

## Core Commands

### `custcli run`

Headless plan -> execute -> review.

Example:

```bash
custcli run --cwd "/path/to/project" "implement the requested feature"
```

What it does:

1. loads relevant local execution history
2. asks Gemini for a plan
3. executes the plan with OpenCode
4. asks Gemini to review the result
5. if review is not satisfied, runs one correction loop
6. writes artifacts under `.custcli/sessions/<run-id>/`

### `custcli plan`

Headless planning only.

Example:

```bash
custcli plan --cwd "/path/to/project" "analyze this codebase and propose a safe plan"
```

### `custcli live`

Starts a live OpenCode session with Gemini planning and review tools available inside the TUI.

Example:

```bash
custcli live --cwd "/path/to/project" --planner-model auto
```

Strict Gemini-first mode:

```bash
custcli live --cwd "/path/to/project" --planner-model auto --planner-mode strict
```

### `custcli sessions`

Lists known live sessions for the current artifact root.

Example:

```bash
custcli sessions
```

Other useful forms:

```bash
custcli sessions --json
custcli sessions --plain
custcli sessions --all
```

### `custcli prune`

Prunes older heavy artifacts while preserving small continuity files.

Examples:

```bash
custcli prune
custcli prune --keep-last 20
custcli prune --raw-only
custcli prune --older-than 7d
custcli prune --json
```

## Flag Reference

### `--cwd <path>`

Target workspace directory.

Use this when the current shell directory is not the workspace you want.

### `--planner-model <id>`

Gemini model override.

Special value:

```text
auto
```

`auto` means no explicit Gemini model pin.

### `--planner-mode <free|strict>`

Live-session policy.

- `free`: Gemini is used when genuinely needed
- `strict`: Gemini planning is enforced first for substantive turns

### `--planner-session <id>`

Resume a prior Gemini planning session in headless `run` or `plan`.

### `--worker-model <id>`

OpenCode model override.

### `--worker-agent <name>`

OpenCode agent override.

### `--worker-variant <name>`

OpenCode variant override for headless worker execution.

### `--planner-approval-mode <mode>`

Approval mode forwarded to Gemini planning and review calls.

Default:

```text
plan
```

### `--artifact-root <path>`

Override where `custcli` stores `.custcli` data.

Use this if you want artifacts outside the repo.

### `--open-ui`

Treat `run` like live mode and open the OpenCode TUI.

### `--continue`

Continue the last compatible live session.

### `--session <id>`

Continue a specific live session by ID.

### `--new-session`

Force a fresh live session.

### `--fork`

Fork a continued live session instead of continuing it directly.

### `--skip-worker`

Stop after planning.

Supported in:

- `run`
- `plan`

Not supported in:

- `live`

### `--manual-approve`

Disable automatic OpenCode permission approval in headless `run`.

### `--json`

Return machine-readable output.

Supported in:

- `run`
- `plan`
- `sessions`
- `prune`

### `--quiet`

Suppress headless progress logs on stderr.

### `--all`

For `sessions`, include stale local live metadata even if the OpenCode session is already gone.

### `--tui`

Force the interactive sessions picker.

### `--plain`

Force plain-text sessions output instead of the picker.

### `--keep-last <n>`

For `prune`, keep the newest `n` histories fully intact.

Default:

```text
20
```

### `--raw-only`

For `prune`, remove only raw/heavy files and keep full structured plan/review files.

### `--older-than <age>`

For `prune`, only prune entries older than a given age.

Supported units:

- `ms`
- `s`
- `m`
- `h`
- `d`
- `w`

Examples:

```bash
custcli prune --older-than 12h
custcli prune --older-than 7d
custcli prune --older-than 2w
```

## Gemini CLI Coverage

There are two ways Gemini is used.

### Structured planner and reviewer flow

`custcli` uses Gemini in a controlled way for:

- planning
- review
- correction loops

That path is intentionally opinionated.

### Raw passthrough

If you need direct Gemini CLI behavior:

```bash
custcli gemini -- --output-format json -p "Reply with exactly OK"
```

This forwards arguments directly to your configured Gemini CLI.

Important limitation:

- live-mode Gemini tools intentionally restrict unsafe workspace-escaping flags such as manual worktree control
- headless planner/reviewer flow also injects workspace scoping and sandbox settings

That is intentional. It is there to keep `custcli` safe and workspace-local.

## Artifact Layout

Default artifact root:

```text
<cwd>/.custcli
```

This is runtime state, not source code. The repository ignores it through `.gitignore`.

### Headless run directory

```text
.custcli/sessions/<run-id>/
```

Typical files:

- `request.json`
- `planner-prompt.txt`
- `planner-stdout.json`
- `planner-stderr.log`
- `planner-envelope.json`
- `plan.json`
- `plan-compact.json`
- `worker-prompt.txt`
- `worker-stdout.jsonl`
- `worker-stderr.log`
- `worker-events.json`
- `review.json`
- `review-compact.json`
- `review-history.json`
- `contradictions.json`
- `summary.json`

If a correction loop runs, pass-specific files are added, such as:

- `plan-pass-2.json`
- `plan-compact-pass-2.json`
- `review-pass-2.json`
- `review-compact-pass-2.json`

### Live-mode continuity files

- `.custcli/live/state/*.json`
- `.custcli/live/status/*.json`
- `.custcli/live/last-launch.json`
- `.custcli/live/sessions/...`
- `.custcli/opencode-live/`

### Local execution memory

```text
.custcli/knowledge/executions.jsonl
```

## Retention and Cleanup

`custcli prune` is designed to keep continuity while shrinking disk usage.

Preserved by default:

- live state files
- live status files
- `last-launch.json`
- `knowledge/executions.jsonl`
- `opencode-live/`
- compact plan/review artifacts

Pruned by default:

- older raw stdout/stderr/prompt/envelope files
- older full `plan.json` / `review.json` files outside the keep window
- older live call artifact directories
- confirmed stale live-session metadata

## Notes Before Publishing

This repository is now structured so users can:

- install it globally with npm
- run it from any directory
- keep repo noise low with `.gitignore`
- understand the trust model clearly

Before publishing to npm, you should still decide:

- the final package license
- whether you want a stable npm package name or GitHub-only distribution

Repository:

- [github.com/NVSRahul/custcli](https://github.com/NVSRahul/custcli)
