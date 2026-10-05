#!/bin/sh
cd "$(dirname "$0")/backend" && exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8008}"
