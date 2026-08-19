#!/usr/bin/env node
/**
 * A dependency-advisory gate that can stay green without being useless.
 *
 * `npm audit --audit-level=high` in CI has one failure mode, and it is not
 * false negatives: it goes red on day one for an advisory somebody has already
 * looked at and accepted, stays red, and within a week the build being red is
 * the normal state of the world. At that point the gate is worse than nothing,
 * because a genuinely new advisory arrives into a build that is already
 * failing and nobody looks twice.
 *
 * So this gate fails on advisories that are **new**, not on advisories that
 * exist. Everything currently accepted is written down in
 * `.audit-allowlist.json` with the reason it was accepted and the date somebody
 * decided that, and anything not on that list fails the build. Two consequences
 * are the point of the design:
 *
 *  - An advisory can only be silenced by a commit that says why, reviewable
 *    like any other. There is no `--force` and no environment variable.
 *  - An allowlist entry for an advisory that no longer appears is reported and
 *    fails too. A stale exemption is how a real finding gets pre-approved years
 *    later when a package name is reused, and it also means the list stops
 *    describing the tree.
 *
 * The exposure analysis behind each entry lives in
 * `docs/SecurityThreatModel.md` under "Dependency advisories"; this file holds
 * the ids so the check is mechanical.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = join(root, '.audit-allowlist.json');

/** Severities that fail the build when unlisted. Anything lower is reported only. */
const BLOCKING = new Set(['critical', 'high', 'moderate']);

function runAudit() {
  try {
    // `npm audit` exits non-zero whenever it finds anything, which is most of
    // the time, so the exit code carries no information this script wants —
    // only the JSON does.
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim() !== '') return error.stdout;
    throw error;
  }
}

/** Every advisory in the tree, flattened out of npm's per-package nesting. */
function advisoriesFrom(report) {
  const found = new Map();
  for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      // A string `via` is a transitive pointer at another package's entry, not
      // an advisory of its own — counting it would double-report the same
      // finding under every package that pulls the vulnerable one in.
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      if (!found.has(id)) {
        found.set(id, {
          id,
          package: via.name ?? entry.name,
          severity: via.severity ?? entry.severity ?? 'unknown',
          title: via.title ?? '(no title)',
          url: via.url,
        });
      }
    }
  }
  return [...found.values()];
}

function loadAllowlist() {
  try {
    const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    return new Map((parsed.accepted ?? []).map((entry) => [entry.id, entry]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

const report = JSON.parse(runAudit());
const advisories = advisoriesFrom(report);
const allowed = loadAllowlist();

const unlisted = advisories.filter((item) => !allowed.has(item.id));
const blocking = unlisted.filter((item) => BLOCKING.has(item.severity));
const informational = unlisted.filter((item) => !BLOCKING.has(item.severity));
const stale = [...allowed.values()].filter(
  (entry) => !advisories.some((item) => item.id === entry.id),
);

console.log(`Advisories in the production tree: ${advisories.length}`);
console.log(`Accepted and recorded:             ${advisories.length - unlisted.length}`);

for (const item of informational) {
  console.log(`  note  ${item.id}  ${item.severity.padEnd(8)} ${item.package} — ${item.title}`);
}

if (stale.length > 0) {
  console.error('\nAllowlist entries for advisories that are no longer present:');
  for (const entry of stale) {
    console.error(
      `  ${entry.id}  ${entry.package ?? ''} — accepted ${entry.accepted ?? 'unknown'}`,
    );
  }
  console.error('\nRemove them from .audit-allowlist.json. A stale exemption pre-approves a');
  console.error('finding nobody has looked at.');
}

if (blocking.length > 0) {
  console.error(`\n${blocking.length} advisory/advisories are not accepted anywhere:`);
  for (const item of blocking) {
    console.error(`  ${item.id}  ${item.severity.padEnd(8)} ${item.package} — ${item.title}`);
    console.error(`      ${item.url}`);
  }
  console.error('\nEither fix it, or add it to .audit-allowlist.json with the reason and the');
  console.error('exposure analysis in docs/SecurityThreatModel.md. There is no override flag.');
}

process.exit(blocking.length > 0 || stale.length > 0 ? 1 : 0);
