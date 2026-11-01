/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Protected locations: credentials, keys and this app's own secrets. A command or tool call that
 * names one is DENIED outright — no Approve button — because a convincing-looking request (or a
 * prompt injected into a web page the AI read) is exactly how such files get leaked, and one
 * mistaken tap would be enough. Extra locations: SENSITIVE_PATHS in .env (comma-separated
 * folders or file names, e.g. "C:\Users\me\.sysaibrain-android,secrets.txt").
 */

import { config } from '../config';

const norm = (s: string) => s.replace(/\\+/g, '/').toLowerCase();

/** [pattern over the normalized text, label shown to the owner] */
const BUILT_IN: [RegExp, string][] = [
  [/\.ssh(\/|$|[\s'"`;|,)])/, 'SSH keys (~/.ssh)'],
  [/\bid_(rsa|dsa|ecdsa|ed25519)\b/, 'SSH private key'],
  [/\.aws\//, 'AWS credentials (~/.aws)'],
  [/\.azure\//, 'Azure credentials (~/.azure)'],
  [/\.kube\/config\b/, 'Kubernetes credentials'],
  [/\.docker\/config\.json\b/, 'Docker registry credentials'],
  [/\.git-credentials\b/, 'Git saved passwords'],
  [/\.config\/gh\/hosts\.yml\b/, 'GitHub CLI token'],
  [/(^|[\/\s'"])_?\.netrc\b/, '.netrc passwords'],
  [/\.npmrc\b/, 'npm token (.npmrc)'],
  [/\.pypirc\b/, 'PyPI token (.pypirc)'],
  [/\.claude\/\.credentials\.json\b/, 'Claude Code login'],
  [/(chrome|edge|brave-browser|brave|chromium|opera[^\/]*)\/user data\/[^'"`\s]*?(login data|cookies|local state|web data)\b/, 'browser saved passwords / cookies'],
  [/firefox\/profiles\/[^'"`\s]*?(logins\.json|key[34]\.db|cookies\.sqlite)\b/, 'Firefox saved passwords / cookies'],
  [/windows\/system32\/config\/(sam|security|system)\b/, 'Windows password database'],
  [/\b(hklm|hkey_local_machine)\/(sam|security)\b/, 'Windows password database (registry)'],
  [/windows\/ntds\//, 'Active Directory database'],
  [/microsoft\/(credentials|protect|vault)\//, 'Windows Credential Manager / DPAPI keys'],
  [/\.(kdbx|pfx|p12|keystore|jks)\b/, 'password vault / certificate key file'],
];

function ownSecrets(): [RegExp, string][] {
  const root = norm(config.projectRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    [new RegExp(`${root}/\\.env\\b`), "this assistant's own secrets (.env)"],
    [new RegExp(`${root}/data(/|$|[\\s'"])`), "this assistant's own database and secrets (data/)"],
  ];
}

function extra(): [RegExp, string][] {
  return config.security.sensitivePaths.map((p) => {
    const n = norm(p.trim()).replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [new RegExp(n), `protected by SENSITIVE_PATHS (${p.trim()})`] as [RegExp, string];
  });
}

/** The label of the first protected location named in `text` (a command or a path), or null. */
export function sensitivePathIn(text: string): string | null {
  if (!text) return null;
  const t = norm(text);
  for (const [re, label] of [...BUILT_IN, ...ownSecrets(), ...extra()]) if (re.test(t)) return label;
  return null;
}
