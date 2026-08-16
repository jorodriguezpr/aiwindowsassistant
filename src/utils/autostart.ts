/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { config } from '../config';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'AiWindowsAssistant';

/** Hidden launcher so node runs without a console window at login. */
function vbsPath(): string {
  return path.join(config.projectRoot, 'scripts', 'start-hidden.vbs');
}

export function writeHiddenLauncher(): string {
  const vbs = vbsPath();
  const nodeExe = process.execPath.replace(/\\/g, '\\\\');
  const entry = path.join(config.projectRoot, 'dist', 'index.js').replace(/\\/g, '\\\\');
  const workDir = config.projectRoot.replace(/\\/g, '\\\\');
  const content =
    `' AiWindowsAssistant hidden launcher\n` +
    `Set sh = CreateObject("WScript.Shell")\n` +
    `sh.CurrentDirectory = "${workDir}"\n` +
    `sh.Run """${nodeExe}"" ""${entry}"""", 0, False\n`;
  fs.mkdirSync(path.dirname(vbs), { recursive: true });
  fs.writeFileSync(vbs, content, 'ascii');
  return vbs;
}

export function addAutostart(): void {
  const vbs = writeHiddenLauncher();
  execSync(`reg add "${RUN_KEY}" /v ${VALUE_NAME} /t REG_SZ /d "wscript.exe \\"${vbs}\\"" /f`, {
    stdio: 'pipe',
  });
}

export function removeAutostart(): void {
  try {
    execSync(`reg delete "${RUN_KEY}" /v ${VALUE_NAME} /f`, { stdio: 'pipe' });
  } catch {
    // value didn't exist — fine
  }
}

export function isAutostartEnabled(): boolean {
  try {
    const out = execSync(`reg query "${RUN_KEY}" /v ${VALUE_NAME}`, { stdio: 'pipe' }).toString();
    return out.includes(VALUE_NAME);
  } catch {
    return false;
  }
}
