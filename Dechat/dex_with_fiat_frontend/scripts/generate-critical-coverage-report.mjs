#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COVERAGE_REPORT_DIR,
  COVERAGE_THRESHOLDS,
} from './critical-coverage-modules.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');
const reportDir = path.join(root, COVERAGE_REPORT_DIR);

function readJson(name) {
  const filePath = path.join(reportDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${path.relative(root, filePath)}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const summary = readJson('coverage-summary.json');
const mutation = readJson('mutation-report.json');
const changedLines = readJson('changed-lines-report.json');

const report = {
  pr_number: Number(process.env.PR_NUMBER) || null,
  head_sha: process.env.HEAD_SHA ?? null,
  generated: true,
  targets: COVERAGE_THRESHOLDS,
  mutationTarget: mutation.threshold,
  critical: summary.total,
  mutation: {
    score: mutation.score,
    killed: mutation.killed,
    total: mutation.total,
    ok: mutation.ok,
  },
  changedLines: {
    changedLineCount: changedLines.changedLineCount,
    coveredChangedLines: changedLines.coveredChangedLines,
    uncoveredChangedLines: changedLines.uncoveredChangedLines.length,
    ok: changedLines.ok,
  },
};

const outputPath = path.join(root, 'critical-coverage-report.json');
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outputPath)}`);
