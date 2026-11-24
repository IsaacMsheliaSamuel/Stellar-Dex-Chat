import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { xdr } from '@stellar/stellar-sdk';
import {
  compareContractAbi,
  normalizeAbiSpec,
  normalizeSpecEntries,
  parseBindingsSource,
  type Bindings,
  type NormalizedSpec,
} from '../abiCompatibility';

const contractsDir = path.resolve(__dirname, '..');
const bindings = parseBindingsSource(
  fs.readFileSync(path.join(contractsDir, 'types.ts'), 'utf8'),
);
const bindingsSpec = normalizeAbiSpec(
  JSON.parse(
    fs.readFileSync(
      path.join(contractsDir, 'abi/fiat_bridge_abi.json'),
      'utf8',
    ),
  ),
  'committed-bindings',
  'current',
);

function loadSpec(
  file: string,
  release: string,
  status: NormalizedSpec['status'],
): NormalizedSpec {
  const raw = JSON.parse(
    fs.readFileSync(path.join(contractsDir, file), 'utf8'),
  );
  if (raw.format === 'contract-abi-spec-v1') {
    return raw;
  }
  return normalizeAbiSpec(raw, release, status);
}

const currentSpec = loadSpec('abi/specs/current.json', 'current', 'current');
const baselineSpec = loadSpec(
  'abi/specs/v1-baseline.json',
  'v1-baseline',
  'supported',
);

function cloneBindings(): Bindings {
  return {
    methods: [...bindings.methods],
    errors: { ...bindings.errors },
    typeFields: Object.fromEntries(
      Object.entries(bindings.typeFields).map(([type, fields]) => [
        type,
        { ...fields },
      ]),
    ),
  };
}

describe('cross-version contract ABI compatibility (#272)', () => {
  it('extracts methods, error codes, and DTO fields from committed TypeScript', () => {
    expect(bindings.methods).toContain('get_receipt_audit_views');
    expect(bindings.errors['501']).toBe('RequestNotFound');
    expect(bindings.typeFields.WithdrawRequest.queuedAtLedger).toBe('number');
    expect(bindings.typeFields.ReceiptAuditPage.nextCursor).toBe(
      'number | null',
    );
    expect(bindings.typeFields.ReceiptAuditView.receiptId).toBe('string');
  });

  it('passes the committed bindings against current and supported specs', () => {
    const report = compareContractAbi(bindings, bindingsSpec, [
      currentSpec,
      baselineSpec,
    ]);
    expect(report.ok).toBe(true);
    expect(report.drifts).toEqual([]);
    expect(report.diff).toContain('No contract ABI drift detected');
  });

  it('reports stale methods, signatures, errors, and fields with a reviewable diff', () => {
    const stale = cloneBindings();
    stale.methods = stale.methods.filter((method) => method !== 'deposit');
    stale.methods.push('legacy_deposit');
    stale.errors['501'] = 'RequestMissing';
    stale.typeFields.WithdrawRequest.queuedAtLedger = 'string';
    delete stale.typeFields.ReceiptAuditView.receiptId;

    const staleBindingsSpec = normalizeAbiSpec(
      {
        ...bindingsSpec,
        methods: [
          ...Object.entries(bindingsSpec.methods).map(([name, method]) => ({
            name,
            inputs: method.inputs,
            outputs: [method.output],
          })),
        ],
        errors: bindingsSpec.errors,
        types: bindingsSpec.types,
      },
      'stale-bindings',
      'current',
    );
    staleBindingsSpec.methods.deposit = {
      inputs: ['Address'],
      output: 'Result<(), Error>',
    };

    const report = compareContractAbi(stale, staleBindingsSpec, [currentSpec]);
    const kinds = new Set(report.drifts.map((drift) => drift.kind));

    expect(report.ok).toBe(false);
    expect(kinds).toContain('missing-method');
    expect(kinds).toContain('extra-method');
    expect(kinds).toContain('signature-mismatch');
    expect(kinds).toContain('error-mismatch');
    expect(kinds).toContain('field-type-mismatch');
    expect(kinds).toContain('missing-field');
    expect(report.diff).toContain('--- expected: Soroban contract spec');
    expect(report.diff).toContain(
      '+++ actual: committed TypeScript client bindings',
    );
    expect(report.diff).toContain(
      '@@ current (current) method deposit signature-mismatch @@',
    );
  });

  it('allows additive supported-release changes but flags removed baseline methods', () => {
    const additiveBindings = cloneBindings();
    additiveBindings.methods.push('future_method');
    additiveBindings.typeFields.ReceiptAuditPage.futureField = 'string';

    const additiveReport = compareContractAbi(additiveBindings, bindingsSpec, [
      baselineSpec,
    ]);
    expect(additiveReport.ok).toBe(true);

    const breakingBaseline: NormalizedSpec = {
      ...baselineSpec,
      methods: {
        ...baselineSpec.methods,
        legacy_required_method: { inputs: [], output: 'void' },
      },
    };
    const breakingReport = compareContractAbi(bindings, bindingsSpec, [
      breakingBaseline,
    ]);
    expect(breakingReport.ok).toBe(false);
    expect(breakingReport.drifts).toEqual([
      expect.objectContaining({
        kind: 'missing-method',
        release: 'v1-baseline',
        scope: 'method legacy_required_method',
      }),
    ]);
  });

  it('normalizes Soroban WASM spec entries including nested types', () => {
    const u64 = xdr.ScSpecTypeDef.scSpecTypeU64();
    const address = xdr.ScSpecTypeDef.scSpecTypeAddress();
    const option = xdr.ScSpecTypeDef.scSpecTypeOption(
      new xdr.ScSpecTypeOption({ valueType: u64 }),
    );
    const vector = xdr.ScSpecTypeDef.scSpecTypeVec(
      new xdr.ScSpecTypeVec({ elementType: address }),
    );
    const page = xdr.ScSpecTypeDef.scSpecTypeUdt(
      new xdr.ScSpecTypeUdt({ name: 'ReceiptAuditPage' }),
    );

    const functionEntry = xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({
        doc: '',
        name: 'get_receipt_audit_page',
        inputs: [
          new xdr.ScSpecFunctionInputV0({
            doc: '',
            name: 'cursor',
            type: option,
          }),
          new xdr.ScSpecFunctionInputV0({
            doc: '',
            name: 'receipts',
            type: vector,
          }),
        ],
        outputs: [page],
      }),
    );
    const structEntry = xdr.ScSpecEntry.scSpecEntryUdtStructV0(
      new xdr.ScSpecUdtStructV0({
        doc: '',
        lib: '',
        name: 'ReceiptAuditPage',
        fields: [
          new xdr.ScSpecUdtStructFieldV0({
            doc: '',
            name: 'next_cursor',
            type: option,
          }),
        ],
      }),
    );
    const errorEntry = xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
      new xdr.ScSpecUdtErrorEnumV0({
        doc: '',
        lib: '',
        name: 'Error',
        cases: [
          new xdr.ScSpecUdtErrorEnumCaseV0({
            doc: '',
            name: 'RequestNotFound',
            value: 501,
          }),
        ],
      }),
    );

    const spec = normalizeSpecEntries(
      [functionEntry, structEntry, errorEntry],
      'wasm-current',
      'current',
    );

    expect(spec.methods.get_receipt_audit_page).toEqual({
      inputs: ['Option<u64>', 'Vec<Address>'],
      output: 'ReceiptAuditPage',
    });
    expect(spec.types.ReceiptAuditPage.fields).toEqual([
      { name: 'next_cursor', type: 'Option<u64>' },
    ]);
    expect(spec.errors).toEqual({ '501': 'RequestNotFound' });
  });
});
