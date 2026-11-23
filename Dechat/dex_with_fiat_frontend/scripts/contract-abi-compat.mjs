#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptsDir, '..');
const moduleUrl = new URL(
  '../src/contracts/abiCompatibility.ts',
  import.meta.url,
).href;
const {
  compareContractAbi,
  normalizeAbiSpec,
  parseBindingsSource,
  specFromWasm,
} = await import(moduleUrl);

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'check';

const options = {
  root: frontendRoot,
  wasm: undefined,
  spec: undefined,
  json: false,
  writeDiff: undefined,
  release: undefined,
  status: 'supported',
  output: undefined,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--') {
    continue;
  }
  if (arg === '--json') {
    options.json = true;
  } else if (arg === '--wasm') {
    options.wasm = args[++index];
  } else if (arg === '--spec') {
    options.spec = args[++index];
  } else if (arg === '--root') {
    options.root = args[++index];
  } else if (arg === '--write-diff') {
    options.writeDiff = args[++index];
  } else if (arg === '--release') {
    options.release = args[++index];
  } else if (arg === '--status') {
    options.status = args[++index];
  } else if (arg === '--output') {
    options.output = args[++index];
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(options.root, relativePath), 'utf8'),
  );
}

function requireValue(value, message) {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function capture() {
  const release = requireValue(
    options.release,
    '--release is required for capture',
  );
  const status = options.status;
  if (status !== 'current' && status !== 'supported') {
    throw new Error('--status must be current or supported');
  }
  const source = options.wasm
    ? specFromWasm(fs.readFileSync(options.wasm), release, status)
    : normalizeAbiSpec(
        options.spec
          ? JSON.parse(fs.readFileSync(path.resolve(options.spec), 'utf8'))
          : readJson('src/contracts/abi/fiat_bridge_abi.json'),
        release,
        status,
      );
  const raw = source;
  const output = requireValue(
    options.output,
    '--output is required for capture',
  );
  const target = path.resolve(options.root, output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ format: 'contract-abi-spec-v1', ...raw }, null, 2)}\n`,
  );
  console.log(`Wrote ${release} spec snapshot to ${target}`);
}

function check() {
  const manifest = readJson('src/contracts/abi/specs/manifest.json');
  const manifestDir = path.join(options.root, 'src/contracts/abi/specs');
  const releases = manifest.releases.map((entry) => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(manifestDir, entry.spec), 'utf8'),
    );
    if (options.wasm && entry.id === manifest.currentRelease) {
      return specFromWasm(
        fs.readFileSync(path.resolve(options.wasm)),
        entry.id,
        entry.status,
      );
    }
    if (raw.format === 'contract-abi-spec-v1') {
      return raw;
    }
    return normalizeAbiSpec(raw, entry.id, entry.status);
  });

  const bindings = parseBindingsSource(
    fs.readFileSync(path.join(options.root, 'src/contracts/types.ts'), 'utf8'),
  );
  const bindingsSpec = normalizeAbiSpec(
    readJson('src/contracts/abi/fiat_bridge_abi.json'),
    'committed-bindings',
    'current',
  );
  const report = compareContractAbi(bindings, bindingsSpec, releases);

  if (options.writeDiff) {
    fs.writeFileSync(
      path.resolve(options.root, options.writeDiff),
      `${report.diff}\n`,
    );
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          currentRelease: manifest.currentRelease,
          releases: releases.map((release) => ({
            id: release.release,
            status: release.status,
            methods: Object.keys(release.methods).length,
            errors: Object.keys(release.errors).length,
          })),
          drifts: report.drifts,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(report.diff);
  }

  process.exitCode = report.ok ? 0 : 1;
}

if (command === 'capture') {
  capture();
} else if (command === 'check') {
  check();
} else {
  throw new Error(`Unknown command: ${command}`);
}
