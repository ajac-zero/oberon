#!/bin/sh
# Volumes mount root-owned. Prepare /data, then run Oberon as the unprivileged `node` user.
# HOME lives on the volume so the Amp CLI's own config and cache survive restarts too.
set -eu
mkdir -p "$OBERON_DATA_DIR" "$HOME"
chown -R node:node /data
exec setpriv --reuid=node --regid=node --init-groups node /app/src/main.ts
