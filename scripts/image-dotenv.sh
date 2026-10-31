#!/usr/bin/env bash
# Checks that the image ignores dotenv files, also ones mounted into /app.
# Usage: bash scripts/image-dotenv.sh <image>
# Runs every case in its own child process (so set -e holds in each case),
# prints one ok/FAIL line per case and exits 0 only when all pass.
set -euo pipefail

marker="dotenv-marker-556"
expected_cmd='["bun","--no-env-file","src/index.ts"]'
expected_health='["CMD","bun","--no-env-file","-e"]'

make_fixture_dir() {
  local dir
  dir="$(mktemp -d)"
  chmod 0755 "$dir"
  mkdir -m 0755 "$dir/config"
  printf '%s\n' '{"channels":[{"id":"log","type":"file","path":"/data/incidents.jsonl"}]}' >"$dir/config/notify.json"
  printf 'PULSE_LOG_LEVEL=%s\n' "$marker" >"$dir/dotenv"
  chmod 0644 "$dir/config/notify.json" "$dir/dotenv"
  printf '%s' "$dir"
}

fixture_args() {
  local dir="$1"
  printf '%s\n' -v "$dir/config:/config:ro" \
    -e PULSE_NOTIFY_CONFIG=/config/notify.json \
    -e PULSE_API_URL=http://127.0.0.1:9 \
    -e PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS=1000
}

case_control() {
  local image="$1" out code
  dir="$(make_fixture_dir)"
  trap 'rm -rf "$dir"' EXIT
  local -a fixture
  mapfile -t fixture < <(fixture_args "$dir")
  code=0
  out="$(timeout 30 docker run --rm --name "dotenv-control-$$" "${fixture[@]}" \
    -e "PULSE_LOG_LEVEL=$marker" "$image" 2>&1)" || code=$?
  if [ "$code" -ne 2 ]; then
    fail "control run exited $code, expected 2"
  fi
  if ! grep -q PULSE_LOG_LEVEL <<<"$out"; then
    fail "control run output does not name PULSE_LOG_LEVEL"
  fi
}

# Records the reason for the parent's FAIL line and stops the case.
fail() {
  printf '%s' "$1" >"$IMAGE_DOTENV_REASON"
  exit 1
}

show_container() {
  local name="$1"
  echo "exit code: $(docker inspect --format '{{.State.ExitCode}}' "$name")" >&2
  docker logs --tail 20 "$name" >&2 2>&1 || true
}

case_dotenv() {
  local image="$1" file="$2" deadline
  dir="$(make_fixture_dir)"
  name="dotenv-${file#.}-$$"
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
  local -a fixture health
  mapfile -t fixture < <(fixture_args "$dir")
  mapfile -t health < <(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "$image" | jq -r '.[1:][]')
  docker run -d --name "$name" "${fixture[@]}" -v "$dir/dotenv:/app/$file:ro" "$image" >/dev/null
  deadline=$((SECONDS + 30))
  while :; do
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]; then
      show_container "$name"
      fail "container exited $(docker inspect --format '{{.State.ExitCode}}' "$name")"
    fi
    if docker exec "$name" "${health[@]}" >/dev/null 2>&1; then
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      show_container "$name"
      fail "healthcheck did not pass within 30 s"
    fi
    sleep 0.5
  done
  docker exec "$name" sh -c "test -r /app/$file && test -s /app/$file" || fail "/app/$file is missing or unreadable"
  if docker logs "$name" 2>&1 | grep -q "$marker"; then
    fail "logs contain the marker"
  fi
  docker stop -t 10 "$name" >/dev/null
  local code
  code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
  if [ "$code" -ne 0 ]; then
    fail "exit code after stop $code, expected 0"
  fi
}

case_image_config() {
  local image="$1" config
  config="$(docker image inspect --format '{{json .Config}}' "$image")"
  jq -e --argjson cmd "$expected_cmd" '.Cmd == $cmd' <<<"$config" >/dev/null ||
    fail "Cmd is $(jq -c .Cmd <<<"$config"), expected $expected_cmd"
  jq -e --argjson hc "$expected_health" '.Healthcheck.Test[0:4] == $hc' <<<"$config" >/dev/null ||
    fail "Healthcheck.Test starts with $(jq -c '.Healthcheck.Test[0:4]' <<<"$config"), expected $expected_health"
}

if [ "${1:-}" = "--case" ]; then
  test_case="$2"
  image="$3"
  case "$test_case" in
  control) case_control "$image" ;;
  .env | .env.production | .env.local) case_dotenv "$image" "$test_case" ;;
  image-config) case_image_config "$image" ;;
  *)
    echo "unknown case: $test_case" >&2
    exit 64
    ;;
  esac
  exit 0
fi

if [ $# -ne 1 ]; then
  echo "usage: bash scripts/image-dotenv.sh <image>" >&2
  exit 64
fi
image="$1"
failed=0
reason_file="$(mktemp)"
trap 'rm -f "$reason_file"' EXIT
for test_case in control .env .env.production .env.local image-config; do
  : >"$reason_file"
  code=0
  IMAGE_DOTENV_REASON="$reason_file" bash "$0" --case "$test_case" "$image" || code=$?
  if [ "$code" -eq 0 ]; then
    echo "ok: $test_case"
  else
    reason="$(cat "$reason_file")"
    [ -n "$reason" ] || reason="case exited $code"
    echo "FAIL: $test_case: $reason"
    failed=1
  fi
done
exit "$failed"
