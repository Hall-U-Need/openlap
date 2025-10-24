#!/bin/bash

# Script to generate all icon sizes from SVG for HUN RACE app

SVG_FILE="hun-race-icon.svg"
ICON_DIR="src/assets/icons"

# Create icons directory if it doesn't exist
mkdir -p "$ICON_DIR"

# Array of sizes needed for PWA
sizes=(72 96 128 144 152 192 384 512)

echo "Generating PNG icons from $SVG_FILE..."

for size in "${sizes[@]}"; do
    output_file="$ICON_DIR/icon-${size}x${size}.png"
    echo "  Creating ${size}x${size}..."
    inkscape "$SVG_FILE" \
        --export-type=png \
        --export-filename="$output_file" \
        --export-width=$size \
        --export-height=$size \
        2>/dev/null
done

# Generate Android adaptive icon (foreground only - 432x432 with padding)
echo "  Creating Android adaptive icon (432x432)..."
inkscape "$SVG_FILE" \
    --export-type=png \
    --export-filename="res/icon.png" \
    --export-width=432 \
    --export-height=432 \
    2>/dev/null

# Generate iOS icon (1024x1024)
echo "  Creating iOS icon (1024x1024)..."
mkdir -p "res/ios/icon"
inkscape "$SVG_FILE" \
    --export-type=png \
    --export-filename="res/ios/icon/icon-1024.png" \
    --export-width=1024 \
    --export-height=1024 \
    2>/dev/null

echo "✅ All icons generated successfully!"
echo ""
echo "Generated files:"
echo "  - PWA icons: $ICON_DIR/icon-*.png"
echo "  - Android: res/icon.png"
echo "  - iOS: res/ios/icon/icon-1024.png"
