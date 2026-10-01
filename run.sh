#!/usr/bin/env bash
# Local run helper. Create a .env file (copy .env.example) with your key, e.g.:
#   GROQ_API_KEY=gsk_your_key_here
# then: ./run.sh
set -a
[ -f .env ] && . ./.env
set +a
node server.js
