#!/usr/bin/env bash
# scripts/parity-check.sh
#
# Structural parity smoke between `bun run src/cli/index.tsx chat` and
# `dist/juno chat` for a single canned prompt.
#
# What this DOES verify:
#   - both invocations start, exit 0, and write a parseable JSONL session
#   - the sequence of event `type`s in both sessions matches (and, for
#     tool_call / tool_result events, the tool names match)
#
# What this does NOT verify:
#   - byte-for-byte parity of model output (LLM output is non-deterministic)
#   - timestamps, session ids, request ids (intentionally stripped)
#
# Requires:
#   - bun on PATH
#   - jq on PATH
#   - Working auth: either OPENAI_API_KEY in the environment, or a stored
#     credential at $JUNO_HOME/auth.json (default ~/.juno/auth.json). The
#     stored credential is copied into both isolated temp dirs.
#
# Exit codes:
#   0  structural parity matches
#   1  any failure (missing prereq, run failure, sequence mismatch)
#
# This is a manual smoke. It is not wired into CI by design.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="${JUNO_PARITY_PROMPT:-What is 2 + 2? Answer in one word.}"

JUNO_HOME_A=""
JUNO_HOME_B=""
cleanup() {
  if [[ -n "$JUNO_HOME_A" && -d "$JUNO_HOME_A" ]]; then rm -rf "$JUNO_HOME_A"; fi
  if [[ -n "$JUNO_HOME_B" && -d "$JUNO_HOME_B" ]]; then rm -rf "$JUNO_HOME_B"; fi
}
trap cleanup EXIT

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
dim()    { printf '\033[2m%s\033[0m\n' "$*"; }
banner() {
  echo
  printf '=== %s ===\n' "$*"
}

banner "juno parity check (structural)"
dim "comparing event-type sequences from \`bun run\` and \`dist/juno\`"
dim "non-deterministic fields (text, timestamps, ids) are ignored"

if ! command -v bun >/dev/null 2>&1; then
  red "missing dependency: bun"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  red "missing dependency: jq"
  exit 1
fi
REAL_JUNO_HOME="${JUNO_HOME:-$HOME/.juno}"
STORED_AUTH="$REAL_JUNO_HOME/auth.json"
USE_STORED_AUTH=0
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  if [[ -f "$STORED_AUTH" ]]; then
    USE_STORED_AUTH=1
    dim "no OPENAI_API_KEY in env; will reuse stored credential at $STORED_AUTH"
  else
    red "no auth available: OPENAI_API_KEY is unset and $STORED_AUTH does not exist"
    red "either export OPENAI_API_KEY=... or run \`juno login\` first"
    exit 1
  fi
fi

BIN="$REPO_ROOT/dist/juno"
if [[ ! -x "$BIN" ]]; then
  banner "building dist/juno (missing)"
  (cd "$REPO_ROOT" && bun run build:compile)
fi
if [[ ! -x "$BIN" ]]; then
  red "build:compile did not produce $BIN"
  exit 1
fi

JUNO_HOME_A="$(mktemp -d -t juno-parity-bun-XXXXXX)"
JUNO_HOME_B="$(mktemp -d -t juno-parity-bin-XXXXXX)"

if [[ $USE_STORED_AUTH -eq 1 ]]; then
  cp "$STORED_AUTH" "$JUNO_HOME_A/auth.json"
  cp "$STORED_AUTH" "$JUNO_HOME_B/auth.json"
  chmod 600 "$JUNO_HOME_A/auth.json" "$JUNO_HOME_B/auth.json"
fi

OUT_A="$JUNO_HOME_A/run.stdout"
OUT_B="$JUNO_HOME_B/run.stdout"
ERR_A="$JUNO_HOME_A/run.stderr"
ERR_B="$JUNO_HOME_B/run.stderr"

banner "run 1: bun run src/cli/index.tsx chat"
dim "JUNO_HOME=$JUNO_HOME_A"
set +e
JUNO_HOME="$JUNO_HOME_A" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  bun run "$REPO_ROOT/src/cli/index.tsx" chat "$PROMPT" \
  >"$OUT_A" 2>"$ERR_A"
RC_A=$?
set -e
if [[ $RC_A -ne 0 ]]; then
  red "bun run exited $RC_A"
  echo "--- stderr ---"; cat "$ERR_A"
  echo "--- stdout ---"; cat "$OUT_A"
  exit 1
fi

banner "run 2: dist/juno chat"
dim "JUNO_HOME=$JUNO_HOME_B"
set +e
JUNO_HOME="$JUNO_HOME_B" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  "$BIN" chat "$PROMPT" \
  >"$OUT_B" 2>"$ERR_B"
RC_B=$?
set -e
if [[ $RC_B -ne 0 ]]; then
  red "dist/juno exited $RC_B"
  echo "--- stderr ---"; cat "$ERR_B"
  echo "--- stdout ---"; cat "$OUT_B"
  exit 1
fi

SID_A="$(grep -E '^session: ' "$OUT_A" | head -n1 | sed 's/^session: //')"
SID_B="$(grep -E '^session: ' "$OUT_B" | head -n1 | sed 's/^session: //')"
if [[ -z "$SID_A" || -z "$SID_B" ]]; then
  red "could not parse session id from stdout"
  echo "out_a:"; cat "$OUT_A"
  echo "out_b:"; cat "$OUT_B"
  exit 1
fi

JSONL_A="$JUNO_HOME_A/sessions/$SID_A.jsonl"
JSONL_B="$JUNO_HOME_B/sessions/$SID_B.jsonl"
if [[ ! -s "$JSONL_A" || ! -s "$JSONL_B" ]]; then
  red "expected jsonl missing or empty"
  ls -la "$JUNO_HOME_A/sessions" "$JUNO_HOME_B/sessions" || true
  exit 1
fi

# Normalize: one line per event, in the form
#   <type>           for plain events
#   tool_call:<name> for tool_call
#   tool_result:<name> for tool_result
# That way both the event ordering AND the tool identity get compared without
# pulling in any non-deterministic fields.
normalize() {
  jq -r '
    if .type == "tool_call" then "tool_call:\(.call.toolName)"
    elif .type == "tool_result" then "tool_result:\(.result.toolName)"
    else .type
    end
  ' "$1"
}

SEQ_A_FILE="$JUNO_HOME_A/seq"
SEQ_B_FILE="$JUNO_HOME_B/seq"
normalize "$JSONL_A" > "$SEQ_A_FILE"
normalize "$JSONL_B" > "$SEQ_B_FILE"

banner "event-type sequence: bun run"
cat "$SEQ_A_FILE"

banner "event-type sequence: dist/juno"
cat "$SEQ_B_FILE"

banner "diff"
if diff -u "$SEQ_A_FILE" "$SEQ_B_FILE"; then
  green "PASS: structural parity (event types match)"
  exit 0
else
  red "FAIL: structural parity mismatch"
  echo
  dim "note: model output text is not compared here; only event shapes."
  dim "if only the model called/skipped a tool differently, that is a known"
  dim "limitation of this manual smoke (no --no-tools flag exists). re-run"
  dim "with a prompt less likely to provoke tool use, or build a stub-model"
  dim "transport for a stronger comparison."
  exit 1
fi
