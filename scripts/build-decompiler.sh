#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REVELA_DIR="$PROJECT_DIR/revela_sui"
BIN_DIR="$PROJECT_DIR/bin"

echo "=== Sui Move Decompiler Builder ==="
echo ""

# Check for Rust toolchain
if ! command -v cargo &>/dev/null; then
  echo "Error: Rust toolchain not found. Install from https://rustup.rs/"
  exit 1
fi

# Clone if needed
if [ ! -d "$REVELA_DIR" ]; then
  echo "Cloning revela_sui..."
  git clone --depth 1 https://github.com/verichains/revela_sui.git "$REVELA_DIR"
else
  echo "Using existing revela_sui at $REVELA_DIR"
fi

# Build
echo "Building move-decompiler (this may take a few minutes)..."
cd "$REVELA_DIR/external-crates/move"
cargo build --release --bin move-decompiler

# Copy binary to project bin/
mkdir -p "$BIN_DIR"
cp "$REVELA_DIR/external-crates/move/target/release/move-decompiler" "$BIN_DIR/move-decompiler"

echo ""
echo "Done! Binary installed to: $BIN_DIR/move-decompiler"
echo ""
echo "Set SUI_DECOMPILER_PATH in your MCP config:"
echo "  \"env\": { \"SUI_DECOMPILER_PATH\": \"$BIN_DIR/move-decompiler\" }"
