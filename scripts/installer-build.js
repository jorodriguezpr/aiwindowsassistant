#!/usr/bin/env node
/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */
/**
 * Builds the Windows installer (pkg-dist/AiWindowsAssistant-Setup-<version>.exe) from
 * installer/AiWindowsAssistant.iss with Inno Setup 6. Needs `npm run pkg-build` first (it packs
 * pkg-dist/AiWindowsAssistant.exe). Inno Setup: `winget install JRSoftware.InnoSetup`.
 * Everything at once: `npm run release` (build, test, pkg-build, installer).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function findIscc() {
  const candidates = [
    process.env.ISCC,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c));
}

function main() {
  const exe = path.join(ROOT, 'pkg-dist', 'AiWindowsAssistant.exe');
  if (!fs.existsSync(exe)) {
    console.error('pkg-dist/AiWindowsAssistant.exe not found — run "npm run pkg-build" first.');
    process.exit(1);
  }
  const iscc = findIscc();
  if (!iscc) {
    console.error('Inno Setup 6 not found — install it with: winget install JRSoftware.InnoSetup (or set ISCC=<path to ISCC.exe>)');
    process.exit(1);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  execFileSync(iscc, ['/Q', `/DMyAppVersion=${version}`, path.join(ROOT, 'installer', 'AiWindowsAssistant.iss')], { stdio: 'inherit' });
  const out = path.join(ROOT, 'pkg-dist', `AiWindowsAssistant-Setup-${version}.exe`);
  console.log(`\nInstaller ready: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}

main();
