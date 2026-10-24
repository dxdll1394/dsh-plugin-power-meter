#!/bin/sh
# Build the native SMC reader. Run this once after a fresh clone; the result is
# gitignored because it is a build artefact, not source.
set -eu
cd "$(dirname "$0")"
cc -O2 -o native/smc-read native/smc.c -framework IOKit
echo "built native/smc-read"
