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
  // --fallback-to-source: files V8 can't precompile (pdfkit's brotli) ship as plain source instead of being left out
  execSync('npx pkg . --fallback-to-source --output pkg-dist/AiWindowsAssistant.exe', { cwd: ROOT, stdio: 'inherit' });

  // Loose files next to the exe. Since 1.5.0 the Claude Code hooks, scheduled tasks and the MCP
  // server run through the exe itself (src/main.ts), so no .js scripts — and no Node.js — are
  // needed on the target PC. config.ts resolves assets/.env/data/logs against the exe's folder.
  fs.mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.ico'), path.join(OUT_DIR, 'assets', 'icon.ico'));
  fs.copyFileSync(path.join(ROOT, 'installer', 'AiWindowsAssistant.vbs'), path.join(OUT_DIR, 'AiWindowsAssistant.vbs'));
  // the SysAiBrain avatar ships ONLY as this binary pack (scripts/avatar-pack.js), never as source
  const avatarPack = path.join(ROOT, 'assets', 'sysaibrain', 'avatar.bin');
  if (fs.existsSync(avatarPack)) {
    fs.mkdirSync(path.join(OUT_DIR, 'assets', 'sysaibrain'), { recursive: true });
    fs.copyFileSync(avatarPack, path.join(OUT_DIR, 'assets', 'sysaibrain', 'avatar.bin'));
  } else {
    console.log('note: no SysAiBrain avatar pack — this build has no avatar in the chat window');
  }
  for (const f of ['.env.example', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'SYSAIBRAIN-AVATAR-LICENSE.txt']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, f));
  }

  console.log(`\npkg-dist/ ready at ${OUT_DIR}`);
  console.log('Contents: AiWindowsAssistant.exe, AiWindowsAssistant.vbs (hidden start), assets/icon.ico, .env.example, README.md, LICENSE');
  console.log('Next: npm run installer (Windows Setup), or copy .env.example to .env next to the exe and start AiWindowsAssistant.vbs.');
}

main();
