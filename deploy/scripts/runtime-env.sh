#!/bin/bash
# Shared deployment helpers for rendering runtime env files and systemd units.

set -euo pipefail

readonly DEPLOY_PLACEHOLDER_REPO_DIR="__REPO_DIR__"

runtime_env_keys() {
  cat <<'EOF'
CONTROL_PLANE_PORT
SLACK_RELAY_PORT
DATABASE_URL
DATA_DIR
HOST_DATA_DIR
DATA_MOUNT
TENANT_IMAGE
TEMPLATES_DIR
OPENCLAW_CONFIG_TEMPLATE
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
CONTROL_PLANE_URL
SCHEDULER_INTERVAL_MS
IDLE_STOP_HOURS
LOG_LEVEL
NODE_ENV
MAX_ACTIVE_TENANTS
ACTIVE_TENANTS_OVERFLOW_POLICY
CONTAINER_NETWORK
S3_BUCKET
EOF
}

read_env_value() {
  local env_file="$1" key="$2"
  [ -f "${env_file}" ] || return 0
  if [ -r "${env_file}" ]; then
    sed -n "s/^${key}=//p" "${env_file}" | tail -n 1
  elif command -v sudo >/dev/null 2>&1; then
    sudo sed -n "s/^${key}=//p" "${env_file}" | tail -n 1
  fi
}

set_env_value() {
  local env_file="$1" key="$2" value="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  if [ -f "${env_file}" ]; then
    grep -v "^${key}=" "${env_file}" > "${tmp_file}" || true
  fi
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp_file}"
  cat "${tmp_file}" > "${env_file}"
  rm -f "${tmp_file}"
}

render_repo_placeholders() {
  local src="$1" dest="$2" repo_dir="$3"
  local escaped_repo_dir
  escaped_repo_dir="$(printf '%s' "${repo_dir}" | sed 's/[&|]/\\&/g')"
  sed "s|${DEPLOY_PLACEHOLDER_REPO_DIR}|${escaped_repo_dir}|g" "${src}" > "${dest}"
}

sync_runtime_env_from_source() {
  local source_env="$1" target_env="$2"
  [ -f "${source_env}" ] || return 0
  while IFS= read -r key; do
    [ -n "${key}" ] || continue
    local value
    value="$(read_env_value "${source_env}" "${key}")"
    if [ -n "${value}" ]; then
      set_env_value "${target_env}" "${key}" "${value}"
    fi
  done < <(runtime_env_keys)
}

render_runtime_env_file() {
  local template_file="$1" source_env="$2" output_env="$3" repo_dir="$4"
  render_repo_placeholders "${template_file}" "${output_env}" "${repo_dir}"
  sync_runtime_env_from_source "${source_env}" "${output_env}"
}

render_systemd_unit_file() {
  local template_file="$1" output_file="$2" repo_dir="$3"
  render_repo_placeholders "${template_file}" "${output_file}" "${repo_dir}"
}
