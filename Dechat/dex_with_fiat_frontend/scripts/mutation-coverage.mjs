#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COVERAGE_REPORT_DIR,
  MUTATION_THRESHOLD,
} from './critical-coverage-modules.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');

const MUTANTS = [
  {
    id: 'M01',
    category: 'amount parsing',
    description:
      'overflow guard no longer rejects amounts above the asset maximum',
    file: 'src/lib/exactAmount.ts',
    find: '  if (stroops > maxAmount) {',
    replace: '  if (false) {',
    test: 'src/lib/exactAmount.test.ts',
    name: 'rejects overflow beyond maximum bounded limits',
  },
  {
    id: 'M02',
    category: 'amount parsing',
    description: 'precision guard no longer rejects excess fractional digits',
    file: 'src/lib/exactAmount.ts',
    find: '  if (fracStr.length > decimals) {',
    replace: '  if (false) {',
    test: 'src/lib/exactAmount.test.ts',
    name: 'rejects excess fractional digits with field-level precision feedback',
  },
  {
    id: 'M03',
    category: 'payout transitions',
    description: 'terminal payout states can transition to any status',
    file: 'src/lib/payout/payoutLifecycle.ts',
    find: '  return allowed ? allowed.includes(targetStatus) : false;',
    replace: '  return true;',
    test: 'src/lib/payout/__tests__/payoutTransitionCoverage.test.ts',
    name: 'keeps terminal states immutable',
  },
  {
    id: 'M04',
    category: 'authorization',
    description: 'cross-user transfer access is allowed',
    file: 'src/lib/auth/authorizationMatrix.ts',
    find: '    if (!callerSessionId || callerSessionId !== record.clientSessionId) {',
    replace: '    if (false) {',
    test: 'src/lib/auth/__tests__/authorizationCoverage.test.ts',
    name: 'denies cross-user access without revealing the record',
  },
  {
    id: 'M05',
    category: 'contract client',
    description: 'invalid receipt payloads are no longer rejected',
    file: 'src/contracts/encoding.ts',
    find: '  if (!r.depositor && !r._0) return null;',
    replace: '  if (false) return null;',
    test: 'src/contracts/__tests__/client.test.ts',
    name: 'returns null for empty or invalid receipt raw value',
  },
  {
    id: 'M06',
    category: 'contract client',
    description: 'HostError strings no longer yield a contract error code',
    file: 'src/contracts/errorMapping.ts',
    find: '    return parseInt(contractMatch[1], 10);',
    replace: '    return null;',
    test: 'src/contracts/__tests__/client.test.ts',
    name: 'extracts error code from HostError strings',
  },
  {
    id: 'M07',
    category: 'reconciliation',
    description: 'terminal-state detection always returns false',
    file: 'src/lib/transferStatusReconciler.ts',
    find: `  return stage === 'on_chain'
    ? isOnChainTerminal(status)
    : isProviderTerminal(status);`,
    replace: '  return false;',
    test: 'src/lib/__tests__/transferStatusReconciler.test.ts',
    name: 'enforces monotonic reconciliation: delayed pending updates do not revert terminal success',
  },
  {
    id: 'M08',
    category: 'reconciliation',
    description: 'optimistic provider responses can declare payout success',
    file: 'src/lib/transferStatusReconciler.ts',
    find: '    if (!isAuthoritativeSource) {',
    replace: '    if (false) {',
    test: 'src/lib/__tests__/transferStatusReconciler.test.ts',
    name: 'does NOT transition provider to success before authoritative confirmation',
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateMutants(originals) {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.file);
    const occurrences = original.split(mutant.find).length - 1;
    if (occurrences !== 1) {
      fail(
        `${mutant.id}: expected exactly one source match, found ${occurrences}`,
      );
    }
    if (mutant.find === mutant.replace) {
      fail(`${mutant.id}: mutation is a no-op`);
    }
  }
}

let activeOriginal = null;
let activeFile = null;

function restore() {
  if (activeFile && activeOriginal !== null) {
    fs.writeFileSync(activeFile, activeOriginal);
    activeFile = null;
    activeOriginal = null;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore();
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  });
}

function runFocusedTest(mutant) {
  return spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.coverage.config.ts',
      '--no-coverage',
      mutant.test,
      '-t',
      mutant.name,
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

function classify(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (
    /Transform failed|SyntaxError|error TS\d+|Failed to resolve import/.test(
      output,
    )
  ) {
    return 'COMPILE ERROR';
  }
  if (result.status === 0) {
    return 'SURVIVED';
  }
  return 'KILLED';
}

function main() {
  const originals = new Map(
    MUTANTS.map((mutant) => [
      mutant.file,
      fs.readFileSync(path.join(root, mutant.file), 'utf8'),
    ]),
  );
  validateMutants(originals);

  const results = [];
  for (const mutant of MUTANTS) {
    const filePath = path.join(root, mutant.file);
    activeFile = filePath;
    activeOriginal = originals.get(mutant.file);
    fs.writeFileSync(
      filePath,
      activeOriginal.toString('utf8').replace(mutant.find, mutant.replace),
    );

    let result;
    try {
      result = runFocusedTest(mutant);
    } finally {
      restore();
    }

    const status = classify(result);
    results.push({
      id: mutant.id,
      category: mutant.category,
      description: mutant.description,
      file: mutant.file,
      test: mutant.test,
      killingTest: mutant.name,
      status,
    });
    console.log(`${mutant.id} ${status.padEnd(13)} ${mutant.description}`);
    if (status === 'COMPILE ERROR') {
      console.error(result.stdout ?? '');
      console.error(result.stderr ?? '');
    }
  }

  const killed = results.filter((result) => result.status === 'KILLED').length;
  const score = Math.round((killed / results.length) * 1000) / 10;
  const report = {
    generatedAt: new Date().toISOString(),
    threshold: MUTATION_THRESHOLD,
    score,
    killed,
    total: results.length,
    ok: score >= MUTATION_THRESHOLD,
    results,
  };

  const reportDir = path.join(root, COVERAGE_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 'mutation-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log(`\nMutation score: ${score}% (${killed}/${results.length})`);
  if (!report.ok) {
    fail(`Mutation score ${score}% is below the ${MUTATION_THRESHOLD}% floor.`);
  }
}

try {
  main();
} finally {
  restore();
}
