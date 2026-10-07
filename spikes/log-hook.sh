#!/bin/bash
# Spike hook: append one JSON line per event with the payload and selected env vars.
payload=$(cat)
t=$(perl -MTime::HiRes=time -e 'printf q(%.3f), time')
line=$(printf '%s' "$payload" | jq -c --arg ev "$1" --arg d "${CS_DISPATCH:-}" --arg t "$t" \
  '{ev:$ev, cs_dispatch:$d, t:$t, session_id, reason, error, tool_name, stop_hook_active, agent_id}')
printf '%s\n' "$line" >> "${SPIKE_LOG:-/tmp/spike.log}"
exit 0
