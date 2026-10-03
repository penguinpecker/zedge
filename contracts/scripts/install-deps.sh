#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --ignore-scripts
forge install foundry-rs/forge-std@f3dae6e6ee381f25eb6a246f7da9b85c91a68219 --no-git
