#!/usr/bin/env node
// Generates TEST_MANIFEST.json (P2-PROVENANCE, external remediation
// request section 34): a single authoritative record of what was tested,
// against what environment, with what dependency state -- rather than
// scattered test-count claims across multiple milestone documents with
// no way to verify which one is current or what commit/dependency state
// it was measured against.
//
// This is a script, not a hand-typed JSON file, on purpose: every value
// below is computed from the actual repository state at run time. Run it
// yourself (`node tools/generate-test-manifest.mjs`) to verify these
// numbers rather than trusting a checked-in snapshot -- the whole point
// of a provenance manifest is that it is reproducible, not that it is
// asserted.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Deterministic, order-independent digest over every tracked source file
// (everything git would track if this were a git repo: not
// node_modules, not this generated manifest itself). This stands in for
// a commit hash, which isn't available here since this checkout has no
// .git directory -- the archive itself is the unit of provenance.
function sourceArchiveDigest(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'TEST_MANIFEST.json') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(relative(root, f));
    hash.update('\0');
    hash.update(readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function run(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

const testOutput = run('npm test 2>&1');
// Node's default test reporter changed its summary prefix from `#` to the
// information glyph (`ℹ`) in newer releases.  Keep accepting the original
// TAP-style form too: the manifest is provenance data, so silently writing
// null counts after a supported Node upgrade is worse than failing loudly.
function readTestCount(label) {
  const match = testOutput?.match(new RegExp(`^(?:#|ℹ)\\s+${label}\\s+(\\d+)\\s*$`, 'm'));
  if (!match) throw new Error(`npm test completed but did not report a ${label} count`);
  return Number(match[1]);
}
const testTotal = readTestCount('tests');
const testPassed = readTestCount('pass');
const testFailed = readTestCount('fail');

const manifest = {
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  npmVersion: run('npm --version'),
  platform: `${process.platform}-${process.arch}`,
  packageLockSha256: sha256File(join(ROOT, 'package-lock.json')),
  sourceArchiveSha256: sourceArchiveDigest(ROOT),
  test: {
    total: testTotal,
    pass: testPassed,
    fail: testFailed,
    command: 'npm test',
  },
  // No commit hash: this checkout has no .git directory. sourceArchiveSha256
  // above is the substitute unit of provenance -- it changes if and only if
  // any tracked file's content or presence changes, same guarantee a commit
  // hash gives for a git-tracked checkout.
  commit: null,
};

writeFileSync(join(ROOT, 'TEST_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
