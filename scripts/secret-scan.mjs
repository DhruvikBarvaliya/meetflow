#!/usr/bin/env node
/**
 * Pre-commit secret scan.
 *
 * Intentionally small and dependency-free so it can run in the commit hook on
 * any machine. It scans git-tracked text files for high-signal credential
 * patterns and for real `.env` files accidentally staged.
 *
 *   node scripts/secret-scan.mjs            # scan tracked + staged files
 *   node scripts/secret-scan.mjs --staged   # scan staged changes only
 *
 * Exit code 1 means "do not commit".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const stagedOnly = process.argv.includes('--staged');
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Files we never scan: lockfiles, binaries, build output, this scanner. */
const SKIP_PATH = [
  /(^|[/\\])node_modules[/\\]/,
  /(^|[/\\])(dist|build|coverage|playwright-report|test-results)[/\\]/,
  /package-lock\.json$/,
  /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|lock)$/i,
  /scripts[/\\]secret-scan\.mjs$/,
];

/**
 * Patterns chosen for precision over recall — a noisy scanner gets bypassed
 * with --no-verify, which is worse than a narrow one.
 */
const RULES = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/i },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe secret key', re: /\bsk_live_[0-9a-zA-Z]{20,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    name: 'JSON Web Token literal',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'Hard-coded database URL with password',
    // postgres://user:secret@host — allow the documented local dev credentials.
    re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^\s:@/]+:(?!meetflow@|@)[^\s:@/]{6,}@/,
  },
  {
    name: 'Assigned secret literal',
    // SOMETHING_SECRET = "…" / api_key: '…' with a long opaque value.
    re: /\b(?:[A-Za-z0-9_]*(?:secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key))\b\s*[=:]\s*['"][^'"\s${}]{16,}['"]/i,
  },
];

/** Values that are documented placeholders, not leaks. */
const ALLOWLIST = [
  /change_me/i,
  /dev_only/i,
  /REPLACE_/,
  /placeholder/i,
  /example\.com/i,
  /meetflow\.local/i,
  /your[_-]?(secret|token|key)/i,
  /\bxxx+\b/i,
  /MeetFlow!Demo123/,
  /test_(access|refresh)_secret/,
  /process\.env\./,
  // A credential that is a variable reference is not a credential: the whole
  // point of `postgres://user:$DB_PASSWORD@host` is that the value lives
  // elsewhere. Covers shell ($VAR, ${VAR}), compose and CI interpolation.
  /:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?@/,
  /:\{\{\s*[\w.]+\s*\}\}@/,
];

function listFiles() {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files'];
  const tracked = execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  return [...new Set(tracked)];
}

const findings = [];
const files = listFiles();

for (const relative of files) {
  if (SKIP_PATH.some((re) => re.test(relative))) continue;

  const base = path.basename(relative);
  // A real .env must never be tracked; only *.example templates may be.
  if (/^\.env(\.|$)/.test(base) && !base.endsWith('.example')) {
    findings.push({ file: relative, line: 0, rule: 'Committed .env file', excerpt: base });
    continue;
  }

  const absolute = path.join(repoRoot, relative);
  let content;
  try {
    if (statSync(absolute).size > 2_000_000) continue;
    content = readFileSync(absolute, 'utf8');
  } catch {
    continue; // deleted between listing and reading, or unreadable/binary
  }
  if (content.includes('\u0000')) continue; // binary

  content.split(/\r?\n/).forEach((line, index) => {
    if (line.includes('secret-scan:allow')) return;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      if (ALLOWLIST.some((allow) => allow.test(line))) continue;
      findings.push({
        file: relative,
        line: index + 1,
        rule: rule.name,
        excerpt: line.trim().slice(0, 120),
      });
      break;
    }
  });
}

if (findings.length > 0) {
  console.error(`\n✖ Secret scan failed — ${findings.length} potential secret(s) found:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]`);
    console.error(`    ${f.excerpt}`);
  }
  console.error(
    `\nRemove the value and load it from the environment instead.\n` +
      `If this is a false positive, append the comment marker "secret-scan:allow" to that line.\n`,
  );
  process.exit(1);
}

console.log(`✔ Secret scan clean (${files.length} tracked file(s) inspected).`);
