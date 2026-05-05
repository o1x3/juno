# Juno

Juno is a Codex-first local coding agent. It runs as a Bun + TypeScript CLI with an Ink TUI, drives an OpenAI model through a manual AI SDK tool loop, and persists every turn as a JSONL session file on disk.

This README only documents behavior that is implemented and verified in this repository. Anything missing here is not yet built — see `docs/TODO.md` for the full delta.

## Status

Local MVP. Usable, not feature-complete.

What works today:
- Bun + TypeScript CLI with six subcommands (`chat`, `login`, `logout`, `resume`, `sessions`, `auth status`)
- Ink-based chat UI with streaming assistant text and inline tool activity
- Manual agent loop on top of `streamText` (`@ai-sdk/openai`)
- Built-in tools: `Read`, `Write`, `Edit`, `Bash`, `Grep`
- Project-instruction loading (`AGENTS.md`, `CLAUDE.md`) walking from `cwd` to the git root
- JSONL session storage with append-only events and resume support
- API-key login, plus scaffolded browser OAuth and device auth flows
- `config.json` loading with strict validation
- Compile-to-binary via `bun build --compile`

Known limitations (do not assume parity with Codex/Claude Code):
- Browser OAuth and device auth are implemented but **not verified end-to-end** against live OpenAI auth.
- Refresh-token behavior after expiry is **not verified**.
- The OAuth → API-key token exchange can silently return no API key; the CLI warns when this happens.
- No approvals/permission prompts, no undo, no MCP, no repo map, no sub-agents, no slash commands.
- No `Glob`, `LS`, `MultiEdit`, `TodoWrite`, `WebSearch`, `WebFetch` tools.
- No path-traversal hardening beyond `resolveInside` (do not run against untrusted inputs).
- Compiled binary parity with `bun run` is **not verified**.

## Requirements

- [Bun](https://bun.sh) ≥ 1.x (the project uses Bun-only APIs: `Bun.spawn`, `Bun.write`, `Bun.sleep`).
- An OpenAI API key, **or** OpenAI OAuth credentials (browser/device flow).
- `rg` (ripgrep) on `PATH` for the `Grep` tool.
- macOS or Linux. Not tested on Windows.

## Install

### From a release (recommended)

The fastest way to install the latest tagged build:

```sh
curl -sSfL https://raw.githubusercontent.com/o1x3/juno/main/scripts/install.sh | sh
```

The script detects your OS/arch (macOS or Linux, x64 or arm64), downloads the matching tarball from the latest GitHub release, verifies its SHA-256 against `checksums.txt`, and drops the binary at `/usr/local/bin/juno`. macOS users have the Gatekeeper quarantine attribute stripped automatically.

If you prefer a manual install: grab `juno-<version>-<os>-<arch>.tar.gz` plus `checksums.txt` from the [releases page](https://github.com/o1x3/juno/releases), verify the checksum, extract, `chmod +x juno`, and move it to `/usr/local/bin/juno`. On macOS you may need `xattr -dr com.apple.quarantine /usr/local/bin/juno`.

### From source

Clone, install dependencies, and either run from source or compile a single binary.

```sh
git clone https://github.com/o1x3/juno.git
cd juno
bun install

# run from source
bun run dev -- chat "hello"

# or compile a standalone binary
bun run build:compile
./dist/juno chat "hello"
```

The `bin` entry in `package.json` maps `juno` to `src/cli/index.tsx`, so `bun link` will also expose a `juno` command in your shell.

## CLI

All subcommands are implemented in [src/cli/index.tsx](src/cli/index.tsx). `juno --help` prints the top-level usage; `juno --version` prints the version (the `package.json` value in source/local builds, the release tag in published binaries via a `--define` injection in [`.github/workflows/release.yml`](.github/workflows/release.yml)).

### `juno chat [prompt]`

Start a chat session.

- With a positional `prompt`: runs a **single non-interactive turn**, prints the assistant text and the new session id to stdout, then exits.
- Without a prompt: launches the Ink TUI and starts a fresh session.

Flags:
- `--model <name>` — override the configured model for this invocation.

Examples:
```sh
juno chat                                  # interactive Ink UI
juno chat "summarize src/core/agent-loop.ts"
juno chat --model gpt-5.4 "..."
```

### `juno login`

Stores Codex credentials at `${JUNO_HOME}/auth.json` with file mode `0o600`.

Flags (mutually exclusive — first match wins):
- `--with-api-key` *(default if no flag is given)* — reads `OPENAI_API_KEY` from the environment, or prompts on stdin via Bun's global `prompt()`. Stores it as an `api-key` credential.
- `--browser` — starts a localhost OAuth listener on port `1455`, prints the authorize URL, and waits for the callback. Does **not** auto-open the browser.
- `--device-auth` — requests a device code from `https://auth.openai.com/api/accounts`, prints the verification URL and user code, then polls until you complete it.

After OAuth/device flows, Juno also tries to exchange the `id_token` for an OpenAI API key via the token-exchange grant. If that exchange fails the CLI prints:

> `API-key exchange unavailable. Calls will route via the ChatGPT Codex backend using your OAuth credential.`

OAuth-only credentials are then routed to `https://chatgpt.com/backend-api/codex/responses` using the `access_token` as a Bearer header (and `chatgpt-account-id` extracted from the JWT). The configured model is checked against a dynamic registry pulled from `https://models.dev/api.json` (`openai` provider, `family: "gpt-codex"`, `tool_call: true`); if it isn't a Codex-backend model, the cheapest known one is used and the UI shows `model=<chosen> (was <original>)`. Override the chosen model with `JUNO_CODEX_MODEL` or `codexModel` in `config.json`.

Token refresh runs on every chat turn when the stored `expiresAt` is within 5 minutes, posting `grant_type=refresh_token` to `https://auth.openai.com/oauth/token` and persisting the new tuple back to `auth.json`.

### `juno logout`

Removes the auth file (`${JUNO_HOME}/auth.json`). No confirmation prompt.

### `juno resume <session-id>`

Opens the Ink UI with an existing session. The session id is the file name (without `.jsonl`) under the sessions directory — use `juno sessions` to list them.

### `juno auth status`

Prints a concise, user-facing snapshot of the current auth and routing state. Read-only — does not mutate `auth.json`. It does invoke the same routing path the chat code uses, so if the stored OAuth token is within the 5-minute refresh window it can trigger a token refresh against `https://auth.openai.com/oauth/token` (the same call `juno chat` would make on its next turn).

Fields:
- `auth` — `none` | `api-key` | `oauth-api-key` | `oauth-codex`.
- `provider` — `codex` (or `none` when no credential is available).
- `source` — `env (OPENAI_API_KEY)` if the env var resolves over storage, `stored (<authFile>)` if a credential was loaded from disk.
- `account` — `present (…<last4>)` for OAuth credentials. Only the last four characters of the ChatGPT account id are shown; the full id is never printed.
- `expires` — for OAuth credentials, the raw `expiresAt` ISO timestamp plus a relative window (`in 58m`, `expired 3m ago`) and a `refresh-due-soon: yes|no` flag that tracks the same 5-minute window the runtime uses for auto-refresh.
- `model` — the model that would be sent to the backend on the next turn.
- `fallback` — only present when the configured model was rewritten (e.g. ChatGPT-account routing forced a safe-allowlist model).

When no credential is available the output collapses to:

```
auth: none
hint: Run `juno login` or set OPENAI_API_KEY.
```

### `juno sessions`

Prints one line per session, tab-separated:

```
<sessionId>	<lastEventTimestamp>	<eventCount>
```

Sorted by most-recent `updatedAt` first. Reads every session file to compute the count, so it is O(n) in total events on disk.

## Configuration

Resolution lives in [src/core/config.ts](src/core/config.ts).

### Precedence (highest first)

1. CLI overrides (currently only `--model` on `chat`).
2. Environment variables.
3. `config.json`.
4. Built-in defaults.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | API key. **Resolves over any stored credential.** | — |
| `OPENAI_BASE_URL` | Override OpenAI base URL. | — |
| `OPENAI_MODEL` | Default model (lower priority than `JUNO_MODEL`). | — |
| `JUNO_HOME` | Juno home directory. | `~/.juno` |
| `JUNO_CONFIG` | Path to `config.json`. | `${JUNO_HOME}/config.json` |
| `JUNO_MODEL` | Default model. | `gpt-5.4-mini` |
| `JUNO_MAX_STEPS` | Max tool-loop steps per turn. Positive integer. | `12` |
| `JUNO_TOOL_OUTPUT_LIMIT` | Max bytes per tool output. Positive integer. | `12000` |
| `JUNO_READ_LINE_LIMIT` | Default `Read` window in lines. Positive integer. | `400` |
| `JUNO_BASH_TIMEOUT_MS` | `Bash` timeout in ms. Positive integer. | `15000` |
| `JUNO_OPENAI_CLIENT_ID` | Override OAuth client id. | Codex CLI default |
| `JUNO_OPENAI_AUTHORIZE_URL` | Override OAuth authorize URL. | `https://auth.openai.com/oauth/authorize` |
| `JUNO_OPENAI_TOKEN_URL` | Override OAuth token URL. | `https://auth.openai.com/oauth/token` |
| `JUNO_OPENAI_DEVICE_ACCOUNTS_URL` | Override device-auth base URL. | `https://auth.openai.com/api/accounts` |
| `JUNO_CODEX_BASE_URL` | Override the ChatGPT Codex backend base URL used for OAuth-only credentials. | `https://chatgpt.com/backend-api` |
| `JUNO_CODEX_MODEL` | Pin the model used on the Codex backend (OAuth-only path). Bypasses the dynamic registry. | discovered cheapest |

Integer-valued env vars are validated. A non-positive-integer value (e.g. `JUNO_MAX_STEPS=foo`) raises:

> `Invalid environment variable JUNO_MAX_STEPS: expected a positive integer`

### `config.json`

Loaded from `${JUNO_CONFIG}` if set, otherwise `${JUNO_HOME}/config.json`. Optional — if the file does not exist, defaults are used.

The schema is **strict** (unknown keys are rejected). Supported keys:

| Key | Type | Notes |
| --- | --- | --- |
| `model` | string | Default model. |
| `baseUrl` | string | OpenAI base URL. |
| `maxSteps` | positive int | Same semantics as `JUNO_MAX_STEPS`. |
| `toolOutputLimit` | positive int | Same as `JUNO_TOOL_OUTPUT_LIMIT`. |
| `readLineLimit` | positive int | Same as `JUNO_READ_LINE_LIMIT`. |
| `bashTimeoutMs` | positive int | Same as `JUNO_BASH_TIMEOUT_MS`. |
| `codexBackendUrl` | string | Same as `JUNO_CODEX_BASE_URL`. |
| `codexModel` | string | Same as `JUNO_CODEX_MODEL`. |

Example `~/.juno/config.json`:

```json
{
  "model": "gpt-5.4-mini",
  "maxSteps": 16,
  "bashTimeoutMs": 30000
}
```

#### Failure behavior

- Unparseable JSON → `Invalid config at <path>: <reason>`.
- Schema violation (unknown key, wrong type, non-positive int) → `Invalid config at <path>: <field> <message>`.

In both cases `resolveConfig()` throws and the CLI exits with a non-zero status. There is no silent fallback to defaults on a malformed config — fix the file or remove it.

## Storage layout

Everything is under `${JUNO_HOME}` (default `~/.juno`):

```
~/.juno/
├── auth.json         # credential record, mode 0o600
├── config.json       # optional
└── sessions/
    └── 2026-05-05T13-37-00.000Z.jsonl
```

Session file names are derived from the creation timestamp (colons replaced with dashes). Each line is one event: `user_message`, `assistant_message`, `tool_call`, `tool_result`, or `status_meta`.

## Project instructions

When a chat starts, Juno walks from `cwd` upward to the git root (or the filesystem root if there is no `.git`), and at each directory loads `CLAUDE.md` and `AGENTS.md` if they exist. All discovered files are merged into the system prompt, in walk order. See [src/core/instructions.ts](src/core/instructions.ts).

## Development

```sh
bun install
bun run dev          # bun run src/cli/index.tsx
bun run check        # biome check
bun run typecheck    # tsc --noEmit
bun test             # bun's test runner
bun run build        # bundle to dist/juno.js
bun run build:compile # standalone binary at dist/juno
```

The end-of-turn checklist in [AGENTS.md](AGENTS.md) requires updating `docs/TODO.md`, running tests, running lint/typecheck on material code changes, and rebuilding `dist/juno` if the runtime changed.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every pull request targeting `main`. It uses [`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun) on `ubuntu-latest` and runs, in order:

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck
bun test
```

## Cutting a release

Releases are tag-driven. Pushing a tag matching `v*` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which cross-compiles four binaries from a single Linux runner using `bun build --compile --target=...` (`darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`), packages each as `juno-<version>-<os>-<arch>.tar.gz` (with the inner binary named plain `juno`), generates a `checksums.txt`, smoke-tests the Linux x64 build with `--help` and asserts `--version` matches the tag, and uploads everything to the GitHub release.

To cut a release:

```sh
bun run release patch    # or: minor, major, or an explicit tag like v1.2.3
# equivalent: ./scripts/release.sh patch
```

The script refuses to run unless the working tree is clean, you are on `main`, and `HEAD` matches `origin/main`. It computes the next semver from the most recent reachable `v*` tag (bootstrapping from `v0.1.0` if no tags exist), prompts for confirmation, then `git tag` + `git push origin <tag>`. Tags are unsigned for now.

After the workflow finishes, users can install with the one-liner from [Install from a release](#from-a-release-recommended).

## Troubleshooting

**`Missing API credential. Set OPENAI_API_KEY or run \`juno login --with-api-key\`.`**
The model client could not find an API key. Either:
- export `OPENAI_API_KEY`, or
- run `juno login` (or `juno login --with-api-key`).

If you logged in with `--browser` or `--device-auth` and still see this error, you likely have **no** stored credential at all (e.g. you ran `juno logout` or `auth.json` was removed). Re-run `juno login` with the desired flow. OAuth-only credentials no longer require an `OPENAI_API_KEY` fallback — calls automatically route via the ChatGPT Codex backend (`https://chatgpt.com/backend-api/codex/responses`) using the stored `access_token`. If the original `id_token` → API-key exchange failed during login, the CLI surfaces `API-key exchange unavailable. Calls will route via the ChatGPT Codex backend using your OAuth credential.` and continues working.

**`Invalid config at <path>: ...`**
Your `config.json` is malformed or contains an unsupported key. The error message names the offending field. The supported key list is exhaustive — Juno rejects unknown keys on purpose. Fix the file or delete it to fall back to defaults.

**`Invalid environment variable JUNO_<X>: expected a positive integer`**
A `JUNO_*` integer env var was set to something that is not a positive integer. Unset it or correct the value.

**OAuth callback never returns / port 1455 in use**
The browser flow opens an HTTP listener on `127.0.0.1:1455`. There is currently no fallback or override for this port, and there is no manual-paste fallback if the callback fails. Free the port and retry.

**`juno chat` hangs after a tool call**
Long multi-turn sessions and resume-after-tool-heavy sessions are not yet verified — see *In Progress / Unproven* in `docs/TODO.md`. If you hit this, kill the process and start a new session; the JSONL on disk up to the last completed event is preserved.

**`Grep` returns nothing useful**
The tool shells out to `rg`. Make sure ripgrep is installed and on `PATH`.

**`Codex backend error 400: ... not supported when using Codex with a ChatGPT account.`**
The ChatGPT-account Codex backend rejects some model slugs (e.g. `gpt-5.1-codex-mini`). For OAuth-only credentials, Juno auto-selects from a strict known-safe allowlist: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`. If you've pinned a slug via `JUNO_CODEX_MODEL`, that override is honored verbatim — unset it to let Juno pick a safe default, or set it to one of the slugs above. New upstream models are not auto-trusted; the allowlist is refreshed deliberately.

## Pointers

- Roadmap and ledger: `docs/TODO.md` (untracked, local).
- Agent operating rules: [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md).
- Design context (untracked): `docs/context.md`, `docs/coding-agent-build-guide.md`, `docs/steal.md`.
