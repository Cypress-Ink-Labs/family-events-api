#!/usr/bin/env bash
# Copy family-events/family-events-api/ from the hm-dotfiles transfer branch
# onto this repo root. Fails closed if the source repo is unreadable.
set -euo pipefail

SRC_REPO="${SRC_REPO:-https://github.com/HexSleeves/hm-dotfiles.git}"
SRC_OWNER="${SRC_OWNER:-HexSleeves}"
SRC_NAME="${SRC_NAME:-hm-dotfiles}"
SRC_PR="${SRC_PR:-8}"
SRC_SUBDIR="${SRC_SUBDIR:-family-events/family-events-api}"
DEST_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fe-api-import.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

resolve_ref() {
  if [[ -n "${TRANSFER_REF:-}" ]]; then
    printf '%s\n' "$TRANSFER_REF"
    return
  fi
  if command -v gh >/dev/null 2>&1; then
    local head
    head="$(gh pr view "$SRC_PR" --repo "${SRC_OWNER}/${SRC_NAME}" --json headRefName --jq '.headRefName' 2>/dev/null || true)"
    if [[ -n "$head" && "$head" != "null" ]]; then
      printf '%s\n' "$head"
      return
    fi
  fi
  printf '%s\n' "cursor/family-events-api-transfer"
}

REF="$(resolve_ref)"
echo "Fetching ${SRC_REPO} ref ${REF} (PR #${SRC_PR})"

if ! git ls-remote --exit-code "$SRC_REPO" "$REF" >/dev/null 2>&1; then
  cat <<EOF >&2
Cannot read ${SRC_OWNER}/${SRC_NAME} ref '${REF}'.

This repo's Cloud Agent token is scoped to Cypress-Ink-Labs/family-events-api.
Anonymous and scoped-token reads of the private transfer repo both 404.

Fix one of:
  1. Make ${SRC_OWNER}/${SRC_NAME} (or this ref) publicly fetchable, then rerun.
  2. Copy ${SRC_SUBDIR}/ from that branch into this repo from a machine that can see it.
  3. Add github.com/${SRC_OWNER}/${SRC_NAME} to .cursor/environment.json
     repositoryDependencies and start a new agent run.

Override the ref with TRANSFER_REF=... if PR #${SRC_PR} is not the transfer.
EOF
  exit 1
fi

git clone --depth 1 --branch "$REF" --single-branch "$SRC_REPO" "$WORK/src"
SRC_DIR="$WORK/src/${SRC_SUBDIR}"
if [[ ! -d "$SRC_DIR" ]]; then
  echo "Missing ${SRC_SUBDIR}/ on ${REF}." >&2
  echo "Top-level entries:" >&2
  ls -la "$WORK/src" >&2
  exit 1
fi

# Keep this bootstrap; replace everything else with the extracted tree.
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.cursor/environment.json' \
  --exclude 'scripts/import-transfer-branch.sh' \
  "$SRC_DIR"/ "$DEST_ROOT"/

echo "Imported ${SRC_SUBDIR}/ from ${SRC_OWNER}/${SRC_NAME}@${REF} into ${DEST_ROOT}"
