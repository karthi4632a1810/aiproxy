#!/usr/bin/env bash
# AI Proxy Startup Script for Cline
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "====================================================="
echo "⚡ Starting FreeModels AI Proxy for Cline..."
echo "====================================================="

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Error: Node.js is not installed."
    exit 1
fi

# Check dependencies
if [ ! -d "node_modules" ]; then
    echo "📦 Installing npm dependencies..."
    npm install
fi

# Run proxy server
node server.js
