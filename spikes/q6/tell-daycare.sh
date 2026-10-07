#!/bin/bash
# Q6 spike: what the ⌃⌥T Shortcut will run. Saves a region screenshot to the inbox.
# `daycare drop` doesn't exist yet, so this only notifies instead of creating an item.
inbox="$HOME/.daycare/inbox"; mkdir -p "$inbox"
f="$inbox/$(date +%Y%m%d-%H%M%S).png"
if screencapture -i -x "$f" && [ -s "$f" ]; then
  osascript -e "display notification \"$(basename "$f")\" with title \"Daycare got it\""
fi
exit 0
