#!/usr/bin/env bash
# stub-credentials.sh — sourceable helper for generating stub auth files.
# No code executes on source — functions only.

# Write stub auth-profiles.json at <path> if the file is missing or empty.
# Never overwrites a non-empty file.
make_stub_auth_profiles() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  if [ ! -s "$path" ]; then
    cat > "$path" <<'STUB'
{
  "_stub": "local-test-only — not real credentials",
  "profiles": {
    "anthropic:default": {
      "provider": "anthropic",
      "type": "token",
      "token": "stub-token-do-not-use"
    }
  }
}
STUB
    chmod 0644 "$path"
  fi
}

# Write stub .credentials.json at <path> if the file is missing or empty.
# Never overwrites a non-empty file.
make_stub_credentials() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  if [ ! -s "$path" ]; then
    cat > "$path" <<'STUB'
{
  "_stub": "local-test-only — not real credentials",
  "claudeAiOauth": {
    "accessToken": "stub-access-token",
    "refreshToken": "stub-refresh-token",
    "expiresAt": 9999999999999,
    "scopes": ["user:inference"]
  }
}
STUB
    chmod 0644 "$path"
  fi
}

# ensure_credentials <auth_path> <creds_path> <mode>
# mode: stub  — always write stubs (skip non-empty)
#       real  — require both files exist and be non-empty; exit 1 if missing
#       auto  — use stubs for any missing/empty file; keep real files as-is
ensure_credentials() {
  local auth_path="$1"
  local creds_path="$2"
  local mode="${3:-auto}"

  case "$mode" in
    stub)
      make_stub_auth_profiles "$auth_path"
      make_stub_credentials "$creds_path"
      ;;
    real)
      if [ ! -s "$auth_path" ]; then
        echo "ERROR: real mode requires auth-profiles.json at $auth_path" >&2
        return 1
      fi
      if [ ! -s "$creds_path" ]; then
        echo "ERROR: real mode requires .credentials.json at $creds_path" >&2
        return 1
      fi
      ;;
    auto)
      make_stub_auth_profiles "$auth_path"
      make_stub_credentials "$creds_path"
      ;;
    *)
      echo "ERROR: ensure_credentials: unknown mode '$mode' (use: stub, real, auto)" >&2
      return 1
      ;;
  esac
}
