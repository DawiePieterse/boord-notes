#!/bin/sh
# Rebuilds frontend/shared/tailwind.css from the classes index.html and
# app.js use. Run after adding a Tailwind class the app didn't use before,
# and commit the result: the phones are tailnet-only and the farm server has
# no Node, so the built file is what gets served. Needs Node and npx.
set -e
cd "$(dirname "$0")/../frontend"
npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.src.css -o shared/tailwind.css --minify
