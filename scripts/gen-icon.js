#!/usr/bin/env node
/**
 * Generate ASRP app icon PNG from SVG concept.
 * Uses: rsvg-convert (brew install librsvg) OR Puppeteer-free approach with sharp overlay.
 * Fallback: render SVG via sharp's built-in SVG support (no text).
 *
 * Strategy: Since sharp can render SVG but may not handle <text> with custom fonts,
 * we convert the α to an SVG <path> instead.
 */
const fs = require('fs');
const path = require('path');

// The α character as an SVG path (Georgia Bold approximation, hand-traced)
// This avoids font dependency — the path IS the glyph.
const alphaSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3A7D5C"/>
      <stop offset="100%" style="stop-color:#24503A"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <!-- Orbital rings -->
  <ellipse cx="256" cy="256" rx="190" ry="72" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="7" transform="rotate(-35 256 256)"/>
  <ellipse cx="256" cy="256" rx="190" ry="72" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="7" transform="rotate(35 256 256)"/>
  <ellipse cx="256" cy="256" rx="190" ry="72" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="7" transform="rotate(90 256 256)"/>
  <!-- α as text — sharp renders system fonts -->
  <text x="256" y="295" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="155" font-weight="bold" fill="white">α</text>
  <!-- Orbital nodes — RGB -->
  <circle cx="122" cy="120" r="17" fill="#FF4444"/>
  <circle cx="390" cy="120" r="17" fill="#FFD234"/>
  <circle cx="256" cy="430" r="17" fill="#4488FF"/>
</svg>`;

async function main() {
  const sharp = require('sharp');
  const buildDir = path.join(__dirname, '..', 'build');

  // Generate 1024x1024 PNG from SVG
  const buf1024 = await sharp(Buffer.from(alphaSvg))
    .resize(1024, 1024)
    .png()
    .toBuffer();

  // Save main icon
  fs.writeFileSync(path.join(buildDir, 'icon.png'), buf1024);
  console.log('Created build/icon.png (1024x1024)');

  // Also save the SVG source
  fs.writeFileSync(path.join(buildDir, 'icon.svg'), alphaSvg);
  console.log('Created build/icon.svg');

  // Generate macOS iconset sizes
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  const iconsetDir = path.join(buildDir, 'icon.iconset');
  if (!fs.existsSync(iconsetDir)) fs.mkdirSync(iconsetDir, { recursive: true });

  for (const s of sizes) {
    const buf = await sharp(Buffer.from(alphaSvg)).resize(s, s).png().toBuffer();
    fs.writeFileSync(path.join(iconsetDir, `icon_${s}x${s}.png`), buf);
    // @2x variants
    if (s <= 512) {
      const buf2x = await sharp(Buffer.from(alphaSvg)).resize(s * 2, s * 2).png().toBuffer();
      fs.writeFileSync(path.join(iconsetDir, `icon_${s}x${s}@2x.png`), buf2x);
    }
  }
  console.log('Created icon.iconset/ PNGs');

  console.log('Done! Run: iconutil -c icns build/icon.iconset -o build/icon.icns');
}

main().catch(err => { console.error(err); process.exit(1); });
