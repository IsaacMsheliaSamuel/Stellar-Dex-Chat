export const CRITICAL_MODULES = {
  amountParsing: ['src/lib/exactAmount.ts', 'src/lib/payout/minorUnits.ts'],
  payoutTransitions: ['src/lib/payout/payoutLifecycle.ts'],
  authorization: ['src/lib/auth/authorizationMatrix.ts'],
  contractClient: [
    'src/contracts/encoding.ts',
    'src/contracts/errorMapping.ts',
  ],
  reconciliation: [
    'src/lib/payout/liabilityParity.ts',
    'src/lib/transferStatusReconciler.ts',
  ],
};

export const CRITICAL_SOURCE_FILES = Object.values(CRITICAL_MODULES).flat();

export const CRITICAL_TEST_FILES = [
  'src/lib/exactAmount.test.ts',
  'src/lib/localeMoneyParser.test.ts',
  'src/lib/stellarFiatModalSchema.test.ts',
  'src/lib/payout/minorUnits.test.ts',
  'src/lib/payout/__tests__/payoutTransitionCoverage.test.ts',
  'src/lib/payout/liabilityParity.test.ts',
  'src/lib/auth/__tests__/authorizationCoverage.test.ts',
  'src/lib/__tests__/transferStatusReconciler.test.ts',
  'src/contracts/__tests__/*.test.ts',
];

export const COVERAGE_THRESHOLDS = {
  statements: 80,
  branches: 70,
  functions: 80,
  lines: 80,
};

export const MUTATION_THRESHOLD = 100;

export const COVERAGE_REPORT_DIR = 'coverage/critical';
