import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ admin: false }));
const transferStoreState = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@/app/api/admin/_utils/requireAdminAuth', () => ({
  requireAdminAuth: () =>
    authState.admin ? null : new Response('Unauthorized', { status: 403 }),
}));

vi.mock('@/lib/transferStore', () => ({
  transferStore: transferStoreState.records,
  getTransferStatus: (reference: string) =>
    transferStoreState.records.get(reference),
  setTransferStatus: (record: Record<string, unknown>) => {
    transferStoreState.records.set(String(record.reference), record);
    return record;
  },
  clearTransferStore: () => transferStoreState.records.clear(),
}));

import { clearTransferStore, setTransferStatus } from '@/lib/transferStore';

import {
  ADMIN_MUTATION_ROUTES,
  ROUTE_AUTHORIZATION_MATRIX,
  authorizeTransferAccess,
  extractCallerSessionId,
  getAuthorizationRule,
} from '../authorizationMatrix';

const ownerSession = 'synthetic_session_owner';
const otherSession = 'synthetic_session_other';
const reference = 'synthetic_ref_auth_coverage';

function seededRequest(sessionId?: string): Request {
  const headers = new Headers();
  if (sessionId) {
    headers.set('x-client-session-id', sessionId);
  }
  return new Request('http://localhost/api/transfer-status', { headers });
}

describe('critical authorization coverage', () => {
  beforeEach(() => {
    authState.admin = false;
    clearTransferStore();
    setTransferStatus({
      reference,
      status: 'pending',
      amount: 1000,
      amountMinor: 100000n,
      currency: 'NGN',
      updatedAt: '2026-01-01T00:00:00.000Z',
      clientSessionId: ownerSession,
    });
  });

  it('requires wallet signatures and admin identity on every admin route', () => {
    const adminRules = ROUTE_AUTHORIZATION_MATRIX.filter(
      (rule) => rule.requiredIdentity === 'admin',
    );

    expect(adminRules.length).toBeGreaterThan(0);
    for (const rule of adminRules) {
      expect(rule.allowedRoles.length).toBeGreaterThan(0);
      expect(
        rule.allowedRoles.every(
          (role) => role === 'admin' || role === 'super_admin',
        ),
      ).toBe(true);
      expect(rule.requiresWalletSignature).toBe(true);
      expect(rule.ownershipRule).toBe('admin');
    }

    for (const route of ADMIN_MUTATION_ROUTES) {
      const rule = getAuthorizationRule(route.path, route.method);
      expect(
        rule,
        `${route.method} ${route.path} missing from matrix`,
      ).toBeDefined();
      if (route.path === '/api/admin/auth/nonce') {
        expect(rule?.requiredIdentity).toBe('public');
      } else {
        expect(rule?.requiredIdentity).toBe('admin');
        expect(rule?.requiresWalletSignature).toBe(true);
      }
    }
  });

  it('keeps user-owned routes out of the admin authorization tier', () => {
    const userRules = ROUTE_AUTHORIZATION_MATRIX.filter(
      (rule) => rule.requiredIdentity === 'user',
    );

    expect(userRules.length).toBeGreaterThan(0);
    for (const rule of userRules) {
      expect(rule.ownershipRule).toBe('caller');
      expect(rule.allowedRoles).toEqual([]);
      expect(rule.requiresWalletSignature).toBe(false);
    }
  });

  it('extracts caller session IDs by priority without trusting unrelated headers', () => {
    expect(
      extractCallerSessionId(
        new Request(
          'http://localhost/api/transfer-status?sessionId=query_session',
          {
            headers: {
              'x-client-session-id': 'header_session',
              cookie: 'stellar_client_session_id=cookie_session',
            },
          },
        ),
      ),
    ).toBe('header_session');

    expect(
      extractCallerSessionId(
        new Request(
          'http://localhost/api/transfer-status?clientSessionId=query_session',
        ),
      ),
    ).toBe('query_session');

    expect(
      extractCallerSessionId(
        new Request('http://localhost/api/transfer-status', {
          headers: {
            cookie: 'other=1; stellar_client_session_id=cookie_session',
          },
        }),
      ),
    ).toBe('cookie_session');

    expect(
      extractCallerSessionId(
        new Request('http://localhost/api/transfer-status', {
          headers: { 'x-forwarded-user': 'spoofed' },
        }),
      ),
    ).toBeUndefined();
  });

  it('denies cross-user access without revealing the record', () => {
    const result = authorizeTransferAccess(
      seededRequest(otherSession),
      reference,
    );

    expect(result.authorized).toBe(false);
    expect(result.isAdmin).toBe(false);
    expect(result.record).toBeUndefined();
  });

  it('allows the owner to access their own transfer', () => {
    const result = authorizeTransferAccess(
      seededRequest(ownerSession),
      reference,
    );

    expect(result.authorized).toBe(true);
    expect(result.isAdmin).toBe(false);
    expect(result.record?.reference).toBe(reference);
  });

  it('allows an authenticated admin to access any transfer', () => {
    authState.admin = true;

    const result = authorizeTransferAccess(seededRequest(), reference);

    expect(result.authorized).toBe(true);
    expect(result.isAdmin).toBe(true);
    expect(result.record?.reference).toBe(reference);
  });

  it('denies non-existent records to non-admin callers', () => {
    const result = authorizeTransferAccess(
      seededRequest(ownerSession),
      'synthetic_ref_missing',
    );

    expect(result.authorized).toBe(false);
    expect(result.record).toBeUndefined();
  });
});
