#!/bin/sh
set -e

echo "==> Running prisma migrate deploy..."
./node_modules/.bin/prisma migrate deploy

echo "==> Starting application..."
exec "$@"
