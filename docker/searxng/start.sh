#!/bin/sh
# SearXNG (granian) on localhost:8081, token-checking proxy on $PORT.
export GRANIAN_HOST=127.0.0.1 GRANIAN_PORT=8081
/usr/local/searxng/entrypoint.sh &
exec python3 /app/auth-proxy.py
