import ts from 'typescript';
import { contract, xdr } from '@stellar/stellar-sdk';

export type ReleaseStatus = 'current' | 'supported';

export interface NormalizedMethod {
  inputs: string[];
  output: string;
}

export interface NormalizedType {
  fields: Array<{ name: string; type: string }>;
}

export interface NormalizedSpec {
  release: string;
  status: ReleaseStatus;
  contractName: string;
  methods: Record<string, NormalizedMethod>;
  types: Record<string, NormalizedType>;
  errors: Record<string, string>;
}

export interface Bindings {
  methods: string[];
  errors: Record<string, string>;
  typeFields: Record<string, Record<string, string>>;
}

export interface Drift {
  release: string;
  status: ReleaseStatus;
  kind:
    | 'missing-method'
    | 'extra-method'
    | 'signature-mismatch'
    | 'error-mismatch'
    | 'missing-field'
    | 'extra-field'
    | 'field-type-mismatch';
  scope: string;
  expected: string;
  actual: string;
}

export interface ComparisonReport {
  ok: boolean;
  drifts: Drift[];
  diff: string;
}

const TS_INTERFACE_BY_SPEC_TYPE: Record<string, string> = {
  Receipt: 'ContractReceipt',
  WithdrawRequest: 'ContractWithdrawRequest',
  ReceiptAuditView: 'ContractReceiptAuditView',
  ReceiptAuditPage: 'ContractReceiptAuditPage',
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseField(
  value: unknown,
  label: string,
): { name: string; type: string } {
  if (typeof value === 'string') {
    const separator = value.indexOf(':');
    if (separator < 1) {
      return { name: '', type: compact(value) };
    }
    return {
      name: value.slice(0, separator).trim(),
      type: compact(value.slice(separator + 1)),
    };
  }
  const record = asRecord(value, label);
  const name = record.name ?? '';
  return {
    name: typeof name === 'string' ? name : asString(name, `${label}.name`),
    type: asString(record.type, `${label}.type`),
  };
}

export function normalizeAbiSpec(
  raw: unknown,
  release: string,
  status: ReleaseStatus,
): NormalizedSpec {
  const source = asRecord(raw, `spec ${release}`);
  const methods: Record<string, NormalizedMethod> = {};

  for (const entry of asArray(source.methods, `spec ${release}.methods`)) {
    const method = asRecord(entry, `spec ${release}.method`);
    const name = asString(method.name, `spec ${release}.method.name`);
    const inputs = asArray(method.inputs, `spec ${release}.${name}.inputs`).map(
      (input, index) =>
        parseField(input, `spec ${release}.${name}.inputs[${index}]`).type,
    );
    const rawOutputs =
      method.outputs ??
      (typeof method.output === 'string' ? [method.output] : []);
    const outputs = asArray(rawOutputs, `spec ${release}.${name}.outputs`).map(
      (output, index) =>
        parseField(output, `spec ${release}.${name}.outputs[${index}]`).type,
    );
    methods[name] = {
      inputs,
      output:
        outputs.length === 0
          ? 'void'
          : outputs.length === 1
            ? outputs[0]
            : `(${outputs.join(', ')})`,
    };
  }

  const types: Record<string, NormalizedType> = {};
  for (const [typeName, entry] of Object.entries(
    asRecord(source.types ?? {}, `spec ${release}.types`),
  )) {
    const type = asRecord(entry, `spec ${release}.types.${typeName}`);
    types[typeName] = {
      fields: asArray(
        type.fields ?? [],
        `spec ${release}.types.${typeName}.fields`,
      ).map((field, index) =>
        parseField(field, `spec ${release}.types.${typeName}.fields[${index}]`),
      ),
    };
  }

  const errors: Record<string, string> = {};
  for (const [code, entry] of Object.entries(
    asRecord(source.errors ?? {}, `spec ${release}.errors`),
  )) {
    errors[code] =
      typeof entry === 'string'
        ? entry
        : asString(
            asRecord(entry, `spec ${release}.errors.${code}`).name,
            `spec ${release}.errors.${code}.name`,
          );
  }

  return {
    release,
    status,
    contractName: asString(
      source.contractName ?? 'FiatBridgeContract',
      'contractName',
    ),
    methods,
    types,
    errors,
  };
}

function getNodeText(node: ts.Node, source: ts.SourceFile): string {
  return compact(node.getText(source));
}

export function parseBindingsSource(sourceText: string): Bindings {
  const source = ts.createSourceFile(
    'types.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const methods: string[] = [];
  const errors: Record<string, string> = {};
  const interfaces = new Map<string, Map<string, string>>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'FIAT_BRIDGE_METHODS' &&
      node.initializer
    ) {
      const expression = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.initializer)
          ) {
            methods.push(property.initializer.text);
          }
        }
      }
    }

    if (
      ts.isEnumDeclaration(node) &&
      node.name.text === 'FiatBridgeErrorCode'
    ) {
      for (const member of node.members) {
        const name = ts.isIdentifier(member.name)
          ? member.name.text
          : ts.isStringLiteral(member.name)
            ? member.name.text
            : getNodeText(member.name, source);
        if (member.initializer && ts.isNumericLiteral(member.initializer)) {
          errors[member.initializer.text] = name;
        }
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      const fields = new Map<string, string>();
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.type) {
          fields.set(
            getNodeText(member.name, source),
            getNodeText(member.type, source),
          );
        }
      }
      interfaces.set(node.name.text, fields);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  const typeFields: Record<string, Record<string, string>> = {};
  for (const [specType, interfaceName] of Object.entries(
    TS_INTERFACE_BY_SPEC_TYPE,
  )) {
    const fields = interfaces.get(interfaceName);
    if (fields) {
      typeFields[specType] = Object.fromEntries(fields.entries());
    }
  }

  return { methods, errors, typeFields };
}

function unionMembers(value: string): string[] {
  return value
    .split('|')
    .map((member) => compact(member).replace(/;$/, ''))
    .filter((member) => member.length > 0);
}

function expectedTsTypes(specType: string): string[] {
  const type = compact(specType);
  if (/^(u64|i64|u128|i128|u256|i256)$/.test(type)) {
    return ['bigint', 'number'];
  }
  if (type === 'bool') {
    return ['boolean'];
  }
  if (/^(u32|i32|u8|i8|u16|i16)$/.test(type)) {
    return ['number'];
  }
  if (
    /^(Address|Symbol|String|Bytes|BytesM)$/.test(type) ||
    /^BytesN<\d+>$/.test(type)
  ) {
    return ['string'];
  }
  if (type === 'ReceiptAuditStatus') {
    return ['ContractReceiptAuditStatus'];
  }
  if (TS_INTERFACE_BY_SPEC_TYPE[type]) {
    return [TS_INTERFACE_BY_SPEC_TYPE[type]];
  }
  const option = /^Option<(.+)>$/.exec(type);
  if (option) {
    return expectedTsTypes(option[1]).flatMap((candidate) => [
      `${candidate} | null`,
      `${candidate} | undefined`,
    ]);
  }
  const vector = /^Vec<(.+)>$/.exec(type);
  if (vector) {
    return expectedTsTypes(vector[1]).flatMap((candidate) => [
      `${candidate}[]`,
      `Array<${candidate}>`,
    ]);
  }
  return [type];
}

function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase(),
  );
}

function findBindingField(
  fields: Record<string, string>,
  specName: string,
): string | undefined {
  const camelName = camelCase(specName);
  if (fields[specName] !== undefined) {
    return specName;
  }
  if (fields[camelName] !== undefined) {
    return camelName;
  }
  return undefined;
}

function typesCompatible(expected: string, actual: string): boolean {
  const actualMembers = unionMembers(actual);
  return expectedTsTypes(expected).some((candidate) =>
    unionMembers(candidate).every((member) => actualMembers.includes(member)),
  );
}

function methodSignature(method: NormalizedMethod): string {
  return `${method.inputs.join(', ')} -> ${method.output}`;
}

export function compareContractAbi(
  bindings: Bindings,
  bindingsSpec: NormalizedSpec,
  releases: NormalizedSpec[],
): ComparisonReport {
  const drifts: Drift[] = [];
  const methodNames = new Set(bindings.methods);

  for (const release of releases) {
    const isCurrent = release.status === 'current';
    const specMethodNames = Object.keys(release.methods);

    for (const name of specMethodNames) {
      if (!methodNames.has(name)) {
        drifts.push({
          release: release.release,
          status: release.status,
          kind: 'missing-method',
          scope: `method ${name}`,
          expected: `binding for ${name}`,
          actual: 'missing from FIAT_BRIDGE_METHODS',
        });
      }
    }

    if (isCurrent) {
      for (const name of bindings.methods) {
        if (!release.methods[name]) {
          drifts.push({
            release: release.release,
            status: release.status,
            kind: 'extra-method',
            scope: `method ${name}`,
            expected: 'method present in current Soroban spec',
            actual: 'stale binding with no spec entry',
          });
        }
      }
    }

    for (const name of specMethodNames) {
      const specMethod = release.methods[name];
      const bindingMethod = bindingsSpec.methods[name];
      if (!bindingMethod) {
        continue;
      }
      const expected = methodSignature(specMethod);
      const actual = methodSignature(bindingMethod);
      if (expected !== actual) {
        drifts.push({
          release: release.release,
          status: release.status,
          kind: 'signature-mismatch',
          scope: `method ${name}`,
          expected,
          actual,
        });
      }
    }

    for (const [code, name] of Object.entries(release.errors)) {
      if (bindings.errors[code] !== name) {
        drifts.push({
          release: release.release,
          status: release.status,
          kind: 'error-mismatch',
          scope: `error ${code}`,
          expected: name,
          actual: bindings.errors[code] ?? 'missing from FiatBridgeErrorCode',
        });
      }
    }

    if (isCurrent) {
      for (const [code, name] of Object.entries(bindings.errors)) {
        if (release.errors[code] !== name) {
          drifts.push({
            release: release.release,
            status: release.status,
            kind: 'error-mismatch',
            scope: `error ${code}`,
            expected:
              release.errors[code] ?? 'no error in current Soroban spec',
            actual: name,
          });
        }
      }
    }

    for (const [typeName, specType] of Object.entries(release.types)) {
      const fields = bindings.typeFields[typeName] ?? {};
      for (const field of specType.fields) {
        const bindingField = findBindingField(fields, field.name);
        const actual = bindingField ? fields[bindingField] : undefined;
        if (actual === undefined) {
          drifts.push({
            release: release.release,
            status: release.status,
            kind: 'missing-field',
            scope: `type ${typeName}.${field.name}`,
            expected: field.type,
            actual: 'missing from TypeScript binding',
          });
        } else if (!typesCompatible(field.type, actual)) {
          drifts.push({
            release: release.release,
            status: release.status,
            kind: 'field-type-mismatch',
            scope: `type ${typeName}.${field.name}`,
            expected: field.type,
            actual,
          });
        }
      }

      if (isCurrent) {
        const expectedNames = new Set(
          specType.fields.flatMap((field) => [
            field.name,
            camelCase(field.name),
          ]),
        );
        for (const name of Object.keys(fields)) {
          if (!expectedNames.has(name)) {
            drifts.push({
              release: release.release,
              status: release.status,
              kind: 'extra-field',
              scope: `type ${typeName}.${name}`,
              expected: 'field present in current Soroban spec',
              actual: 'stale TypeScript field',
            });
          }
        }
      }
    }
  }

  return {
    ok: drifts.length === 0,
    drifts,
    diff: formatComparisonReport(drifts),
  };
}

export function formatComparisonReport(drifts: Drift[]): string {
  if (drifts.length === 0) {
    return 'No contract ABI drift detected across current and supported releases.';
  }

  const lines = [
    '--- expected: Soroban contract spec',
    '+++ actual: committed TypeScript client bindings',
    '',
  ];
  for (const drift of drifts) {
    lines.push(
      `@@ ${drift.release} (${drift.status}) ${drift.scope} ${drift.kind} @@`,
      `- ${drift.expected}`,
      `+ ${drift.actual}`,
      '',
    );
  }
  lines.push(`${drifts.length} ABI drift(s) detected.`);
  return lines.join('\n');
}

function armName(type: xdr.ScSpecTypeDef): string {
  return type.switch().name;
}

function typeNameFromSpecDef(type: xdr.ScSpecTypeDef): string {
  const arm = armName(type);
  const primitives: Record<string, string> = {
    scSpecTypeVal: 'Val',
    scSpecTypeBool: 'bool',
    scSpecTypeVoid: 'void',
    scSpecTypeError: 'Error',
    scSpecTypeU32: 'u32',
    scSpecTypeI32: 'i32',
    scSpecTypeU64: 'u64',
    scSpecTypeI64: 'i64',
    scSpecTypeTimepoint: 'Timepoint',
    scSpecTypeDuration: 'Duration',
    scSpecTypeU128: 'u128',
    scSpecTypeI128: 'i128',
    scSpecTypeU256: 'u256',
    scSpecTypeI256: 'i256',
    scSpecTypeBytes: 'Bytes',
    scSpecTypeString: 'String',
    scSpecTypeSymbol: 'Symbol',
    scSpecTypeAddress: 'Address',
    scSpecTypeMuxedAddress: 'MuxedAddress',
  };
  if (primitives[arm]) {
    return primitives[arm];
  }
  switch (arm) {
    case 'scSpecTypeOption':
      return `Option<${typeNameFromSpecDef(type.option().valueType())}>`;
    case 'scSpecTypeResult':
      return `Result<${typeNameFromSpecDef(type.result().okType())}, ${typeNameFromSpecDef(type.result().errorType())}>`;
    case 'scSpecTypeVec':
      return `Vec<${typeNameFromSpecDef(type.vec().elementType())}>`;
    case 'scSpecTypeMap':
      return `Map<${typeNameFromSpecDef(type.map().keyType())}, ${typeNameFromSpecDef(type.map().valueType())}>`;
    case 'scSpecTypeTuple':
      return `Tuple<${type.tuple().valueTypes().map(typeNameFromSpecDef).join(', ')}>`;
    case 'scSpecTypeBytesN':
      return `BytesN<${type.bytesN().n()}>`;
    case 'scSpecTypeUdt':
      return type.udt().name().toString();
    default:
      throw new Error(`Unsupported Soroban spec type: ${arm}`);
  }
}

export function normalizeSpecEntries(
  entries: xdr.ScSpecEntry[],
  release: string,
  status: ReleaseStatus,
): NormalizedSpec {
  const methods: Record<string, NormalizedMethod> = {};
  const types: Record<string, NormalizedType> = {};
  const errors: Record<string, string> = {};

  for (const entry of entries) {
    const arm = entry.switch().name;
    if (arm === 'scSpecEntryFunctionV0') {
      const fn = entry.value() as xdr.ScSpecFunctionV0;
      const name = fn.name().toString();
      methods[name] = {
        inputs: fn.inputs().map((input) => typeNameFromSpecDef(input.type())),
        output: fn.outputs().map(typeNameFromSpecDef).join(', ') || 'void',
      };
    } else if (arm === 'scSpecEntryUdtErrorEnumV0') {
      const errorEnum = entry.value() as xdr.ScSpecUdtErrorEnumV0;
      for (const errorCase of errorEnum.cases()) {
        errors[String(errorCase.value())] = errorCase.name().toString();
      }
    } else if (arm === 'scSpecEntryUdtStructV0') {
      const struct = entry.value() as xdr.ScSpecUdtStructV0;
      types[struct.name().toString()] = {
        fields: struct.fields().map((field) => ({
          name: field.name().toString(),
          type: typeNameFromSpecDef(field.type()),
        })),
      };
    }
  }

  return {
    release,
    status,
    contractName: 'FiatBridgeContract',
    methods,
    types,
    errors,
  };
}

export function specFromWasm(
  wasm: Uint8Array,
  release: string,
  status: ReleaseStatus,
): NormalizedSpec {
  const spec = contract.Spec.fromWasm(Buffer.from(wasm));
  return normalizeSpecEntries(spec.entries, release, status);
}
