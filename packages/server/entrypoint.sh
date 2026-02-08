#!/bin/sh
set -e
# Ensure cache dir exists and is writable by nodejs (volume may be root-owned)
mkdir -p /home/nodejs/.paparats/cache
chown -R nodejs:nodejs /home/nodejs/.paparats
exec su-exec nodejs "$@"
