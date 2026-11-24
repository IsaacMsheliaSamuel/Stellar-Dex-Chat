#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COVERAGE_REPORT_DIR,
  CRITICAL_SOURCE_FILES,
} from './critical-coverage-modules.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');
const baseRef = process.env.BASE_REF ?? 'upstream/main';
const coverageFile = path.join(
  root,
  COVERAGE_REPORT_DIR,
  'coverage-final.json',
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeRepoPath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function addedLinesByFile(diff) {
  const result = new Map();
  let currentFile = null;
  let line = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      currentFile = raw.slice(6);
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      line = match ? Number(match[1]) : 0;
      continue;
    }
    if (!currentFile || !line) continue;

    if (raw.startsWith('+')) {
      if (!raw.startsWith('+++')) {
        if (!result.has(currentFile)) result.set(currentFile, new Set());
        result.get(currentFile).add(line);
      }
      line += 1;
    } else if (raw.startsWith('-')) {
      continue;
    } else if (raw.startsWith(' ')) {
      line += 1;
    }
  }

  return result;
}

function main() {
  if (!fs.existsSync(coverageFile)) {
    fail(
      'Missing coverage/critical/coverage-final.json. Run pnpm coverage:critical first.',
    );
  }

  const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
  const coverageByFile = new Map();
  for (const entry of Object.values(coverage)) {
    const filePath = normalizeRepoPath(
      path.relative(root, entry.path ?? entry.meta?.path ?? ''),
    );
    const covered = new Set();
    for (const [id, count] of Object.entries(entry.s ?? {})) {
      if (count > 0) {
        const location = entry.statementMap?.[id]?.start;
        if (location) covered.add(location.line);
      }
    }
    coverageByFile.set(filePath, covered);
  }

  const diff = spawnSync(
    'git',
    ['diff', '--unified=0', baseRef, '--', ...CRITICAL_SOURCE_FILES],
    { cwd: root, encoding: 'utf8' },
  );
  if (diff.status !== 0) {
    fail(`git diff failed: ${diff.stderr?.trim() || 'unknown error'}`);
  }

  const changed = addedLinesByFile(diff.stdout ?? '');
  const uncovered = [];
  let changedLineCount = 0;

  for (const [file, lines] of changed) {
    const coveredLines = coverageByFile.get(file) ?? new Set();
    for (const line of lines) {
      changedLineCount += 1;
      if (!coveredLines.has(line)) uncovered.push({ file, line });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseRef,
    changedLineCount,
    coveredChangedLines: changedLineCount - uncovered.length,
    uncoveredChangedLines: uncovered,
    ok: uncovered.length === 0,
  };

  const reportDir = path.join(root, COVERAGE_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 'changed-lines-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (uncovered.length === 0) {
    console.log(`All ${changedLineCount} changed critical lines are covered.`);
    return;
  }

  console.error(`Uncovered changed lines vs ${baseRef}:`);
  for (const item of uncovered) console.error(`  ${item.file}:${item.line}`);
  process.exit(1);
}

main();
