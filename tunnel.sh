#!/usr/bin/env bash
# A public address for the maze, without a deploy.
#
# **cloudflared does not work on every network and it fails confusingly.** It discovers Cloudflare's
# edge over a DNS SRV lookup, and Go cannot parse the compressed SRV records some routers return
# (golang/go#27546). On a network whose only resolver is the router — and where 1.1.1.1 is
# unreachable, so there is nothing to fall back to — every quick tunnel dies with
# "cannot unmarshal DNS message" and serves a 530 that looks like the origin is down. It is not.
#
# ngrok reaches a known endpoint over HTTPS and needs no SRV lookup, so it works where that fails.
# Hence the default. Pass cloudflared as $1 to use the other one.
#
# Either way the hostname dies with this process, which is why `main.ts` refuses to write reputation
# from a tunnel host: a permanent record must not quote a URL that will not resolve tomorrow.
set -euo pipefail

: "${SELLER_ADDRESS:?set SELLER_ADDRESS to the address payments should go to}"
PORT="${PORT:-8790}"
KIND="${1:-ngrok}"
LOG=/tmp/arc-maze-tunnel.log

case "${KIND}" in
  ngrok)
    ngrok http "${PORT}" --log stdout --log-format json > "${LOG}" 2>&1 &
    PATTERN='https://[a-z0-9-]+\.ngrok[a-z.-]*\.(app|io)'
    ;;
  cloudflared)
    cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate > "${LOG}" 2>&1 &
    PATTERN='https://[a-z0-9-]+\.trycloudflare\.com'
    ;;
  *) echo "usage: $0 [ngrok|cloudflared]"; exit 2 ;;
esac
TUNNEL=$!
trap 'kill "${TUNNEL}" 2>/dev/null || true' EXIT

echo "waiting for a hostname…"
for _ in $(seq 1 40); do
  URL=$(grep -oE "${PATTERN}" "${LOG}" | head -1 || true)
  [ -n "${URL}" ] && break
  sleep 1
done
if [ -z "${URL:-}" ]; then
  echo "no hostname appeared. Last lines of ${LOG}:" >&2
  tail -5 "${LOG}" >&2
  exit 1
fi

echo "public: ${URL}"
PUBLIC_URL="${URL}" exec bun run src/main.ts
