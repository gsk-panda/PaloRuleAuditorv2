#!/bin/bash

echo "Killing processes on ports 3000 and 3001..."

for port in 3000 3001; do
  pid=$(lsof -ti:$port 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "Killing process $pid on port $port"
    kill -9 $pid 2>/dev/null || sudo kill -9 $pid 2>/dev/null
  else
    echo "No process found on port $port"
  fi
done

echo "Done."
