#!/bin/sh
# Double-click this file in Finder to start ROOT-A-TRON 3000.
# It only opens a Terminal window and runs ./start, which does the real work.
# Closing the window, or pressing Ctrl-C, stops the server.
cd "$(dirname "$0")" || exit 1
exec /bin/sh ./start "$@"
