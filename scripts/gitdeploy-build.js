#!/usr/bin/env node
/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */
/**
 * Builds gitdeploy/ — a curated copy of exactly what ships to GitHub.
 *
 * This is deliberately an ALLOWLIST, not a raw directory copy: never replace
 * this with a blanket copy of the project root. A raw copy has bitten this
 * exact pattern before in a different project — it silently defeated
 * intentional filtering and nearly shipped a credential-bearing file. Here,
 * the equivalent risk is .env (live secrets), data/ (runtime state including
 * a machine-specific absolute path in claude-hooks-settings.json and usage
 * logs), and logs/ (application/chat logs) — none of those may ever appear
 * in gitdeploy/, and this script only ever copies what's explicitly listed
 * below, never "everything except X".
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'gitdeploy');

// Directories copied in full (source only — no build output, no runtime state).
const DIRS = ['src', 'scripts'];
// Individual files copied as-is.
const FILES = ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.env.example', 'README.md', 'LICENSE'];

function clean(dir) {
  // Never touch .git — this runs on every rebuild and must not destroy repo
  // history/remote config/staged index each time gitdeploy/ is refreshed.
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function main() {
  clean(OUT);

  for (const d of DIRS) {
    fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true });
  }
  for (const f of FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) {
      console.warn(`skip (not found): ${f}`);
      continue;
    }
    fs.copyFileSync(src, path.join(OUT, f));
  }

  console.log(`gitdeploy/ built at ${OUT}`);
  console.log('Included: ' + [...DIRS, ...FILES].join(', '));
  console.log('Never copied: .env, data/, logs/, node_modules/, dist/, assets/ (all generated or secret-bearing)');
}

main();
