#!/bin/bash
# Spike hook: deny any write to locked.txt, log every attempt.
payload=$(cat)
path=$(jq -r '.tool_input.file_path // empty' <<<"$payload")
echo "{\"ev\":\"PreToolUse\",\"tool\":$(jq -c .tool_name <<<"$payload"),\"path\":\"$path\"}" >> "${SPIKE_LOG}"
case "$path" in
  */locked.txt)
    cat <<'J'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"locked.txt is locked by worker auth-refactor (claude, 12m). Work on other files or stop."}}
J
    ;;
esac
exit 0
