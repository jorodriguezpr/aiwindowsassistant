#!/usr/bin/env node
/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */
/**
 * Builds the standalone Windows .exe via @yao-pkg/pkg and assembles a release-ready
 * folder alongside it. Requires `npm run build` to have already produced a fresh
 * dist/ and assets/icon.ico — this script doesn't rebuild those itself, to keep
 * "did the compile succeed" and "did the packaging succeed" as separate, checkable
 * steps rather than one opaque command.
 *
 * Why loose files are copied next to the exe rather than everything being bundled
 * inside it: pkg's bundled assets live in a read-only virtual snapshot filesystem
 * that only the packaged process itself can read (via pkg's patched fs). Anything
 * a *separate* external process needs to open as a real file — specifically
 * scripts/claude-approval-hook.js, which Claude Code's own CLI invokes directly via
 * `node "<path>"` as a PreToolUse hook — has to exist as an actual file on real
 * disk, not just inside the exe. config.ts resolves paths against
 * path.dirname(process.execPath) when running packaged for exactly this reason.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'pkg-dist');

function main() {
  const distIndex = path.join(ROOT, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    console.error('dist/index.js not found — run "npm run build" first.');
    process.exit(1);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Running pkg...');
  execSync('npx pkg . --output pkg-dist/AiWindowsAssistant.exe', { cwd: ROOT, stdio: 'inherit' });

  // Loose files that must exist as real files next to the exe, not just inside it —
  // config.ts resolves projectRoot/dataDir/logDir/assetsDir against the real exe
  // directory when packaged, so anything looked up through those paths (the hook
  // script, the tray icon) needs to actually be there, not just pkg-bundled.
  const looseFiles = ['.env.example', 'README.md', 'LICENSE'];
  fs.mkdirSync(path.join(OUT_DIR, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'claude-approval-hook.js'), path.join(OUT_DIR, 'scripts', 'claude-approval-hook.js'));
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.ico'), path.join(OUT_DIR, 'assets', 'icon.ico'));
  for (const f of looseFiles) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, f));
  }

  console.log(`\npkg-dist/ ready at ${OUT_DIR}`);
  console.log('Contents: AiWindowsAssistant.exe, scripts/claude-approval-hook.js, .env.example, README.md, LICENSE');
  console.log('To run: copy .env.example to .env next to the exe, edit it, then run AiWindowsAssistant.exe.');
}

main();
