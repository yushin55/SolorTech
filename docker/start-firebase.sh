#!/bin/sh
set -eu
if [ -f /data/export/firebase-export-metadata.json ]; then
  exec firebase emulators:start --only firestore --project "${FIREBASE_PROJECT_ID:-demo-solar-local}" --import=/data/export --export-on-exit=/data/export
else
  exec firebase emulators:start --only firestore --project "${FIREBASE_PROJECT_ID:-demo-solar-local}" --export-on-exit=/data/export
fi
