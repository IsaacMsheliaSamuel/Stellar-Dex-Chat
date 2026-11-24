# Issue #290 — Transaction Confirmation WCAG 2.2 AA Evidence

## Scope

This record covers the frontend amount → quote → recipient → wallet-confirmation path in `Dechat/dex_with_fiat_frontend/src/components/StellarFiatModal.tsx` and the shared focus-trap hook `src/hooks/useAccessibleModal.ts`.

No Soroban contract, API route, or signing/broadcast logic was changed. The existing 2FA rule (at least four characters) and all simulation, stale-context, pending-recovery, idempotency, and network/contract identity checks remain in force.

## Remediation

| Area | Change |
| :--- | :--- |
| Labels and relationships | Associated the amount, optional note, large-amount phrase, and admin recipient controls with real `<label for>` elements and hint/error ids. Added a visually hidden amount-format hint. |
| Quote and review announcements | The fiat estimate, stale-rate warning, and pre-sign review-ready message use `role="status"`, `aria-live="polite"`, and `aria-atomic="true"`. The pre-sign summary is a named `region`. |
| Keyboard / nested dialog | The high-value challenge is now a real nested `role="dialog"` with `aria-modal`, an accessible name/description, initial focus, Tab containment, and Escape-to-cancel. A new `suspended` option pauses the parent trap while the child owns focus. |
| Focus order | After a valid challenge, focus moves to the now-available `Confirm & Sign` action instead of remaining on a stale submit control. Cancel/Escape returns focus to the opener through the existing hook behavior. |
| Error recovery | Invalid challenge input stays inline in the nested dialog, sets `aria-invalid`, and extends `aria-describedby`. Correcting the input clears the message. The parent `ErrorSummary` also has a classified fallback so a raw message is never lost. |
| Contrast | Confirm actions use `bg-blue-600` with white text (5.17:1) in both themes rather than the token button whose dark-theme foreground was 2.54:1. Themed body text tokens remain at or above 4.5:1. |
| Reflow / zoom | Parent and nested dialogs use `w-full max-w-md mx-4`; action rows use flexible buttons. At a 320 CSS px viewport (equivalent to 400% zoom on a 1280 px display) the dialogs stay within the viewport without a two-dimensional scroll region. |
| RTL | Both dialogs inherit the active locale direction from `useRtlDirection`. |

### Intentional behavior change

Previously, a valid high-value challenge closed and a later click on `Confirm & Sign` could open the challenge again. It now closes once and sets a `hasPassedTwoFactor` gate for that review. The gate resets when:

- the amount, preset, or recipient changes;
- the dialog is closed by any path (including parent/Escape close) and reopened;
- wallet account, network, or connection context changes.

The 2FA validation rule itself was not loosened. This removes a redundant prompt without allowing a changed transaction to reuse an earlier challenge.

## Automated evidence

Focused regression tests:

```bash
pnpm exec vitest run \
  src/components/__tests__/StellarFiatModal.a11y.test.tsx \
  src/hooks/__tests__/useAccessibleModal.suspended.test.tsx
```

Result: **2 files passed, 6 tests passed**.

Covered cases:

1. amount/note/phrase/recipient names, descriptions, and polite quote announcement;
2. nested-dialog role, accessible name, initial focus, focus containment, and Escape-only dismissal;
3. inline invalid-challenge feedback, `aria-invalid`/`aria-describedby`, focus handoff, and review-ready announcement;
4. no challenge re-open when review confirmation is clicked;
5. challenge required again after the dialog is closed and reopened;
6. parent keyboard handling pauses and resumes with the `suspended` option.

A before/after comparison of the pre-existing `StellarFiatModal` and `useAccessibleModal` suites gave the same counts with and without this patch: **5 files failed, 1 passed; 21 tests failed, 22 passed**. Those failures come from the baseline checkout (missing translation provider and incomplete module mocks) and are not introduced here.

Targeted ESLint on the four touched TypeScript/TSX files: **clean**.

Fixture privacy: the new tests use only synthetic public Stellar identifiers (`GAAAA…`, `CAAAA…`) and no credentials or real user data.

## Contrast calculations

Computed from `src/app/globals.css` with the WCAG relative-luminance formula:

| Token pair | Ratio |
| :--- | ---: |
| Light primary text `#111827` on `#ffffff` | 17.74:1 |
| Light secondary text `#475569` on `#ffffff` | 7.58:1 |
| Light muted text `#64748b` on `#ffffff` | 4.76:1 |
| Dark primary text `#f8fafc` on `#0f172a` | 17.06:1 |
| Dark secondary text `#cbd5e1` on `#0f172a` | 12.02:1 |
| Dark muted text `#94a3b8` on `#0f172a` | 6.96:1 |
| Confirm action white on `#2563eb` (both themes) | 5.17:1 |

All listed text combinations meet WCAG 2.2 AA (4.5:1 for normal text). Focus indicators use the existing 2 px `var(--color-primary)` outline.

## Repository-wide check status at this baseline

The checked-out upstream `main` commit (`647cda6c`) contains committed merge-conflict markers and a missing test fixture module. Full-repository checks therefore fail before this branch's changes are considered:

- `pnpm typecheck` — syntax errors / conflict markers in `src/app/api/admin/auth/nonce/route.ts`, `src/app/api/transfer-status/route.ts`, `src/contexts/StellarWalletContext.tsx`, `src/lib/payout/providers/paystackProvider.ts`, `src/lib/payout/reconciliation.ts`, and `src/lib/payout/webhookSignature.ts`.
- `pnpm lint` — parsing error in `src/lib/payout/webhookSignature.ts` plus unrelated existing lint errors in payout/rate-limit/security files.
- `pnpm test:unit` — all suites stop at setup because `@/test-utils/keyRotationFixtures` is absent.
- `pnpm build` — fails while parsing the same committed conflict markers and unresolved imports.

These baseline defects are outside issue #290 and were left untouched to avoid colliding with parallel work. The focused tests, regression comparison, targeted lint, and fixture-privacy check above are the verification evidence for this change.

## WCAG 2.2 AA mapping

| Criterion | Evidence |
| :--- | :--- |
| 1.3.1 Info and Relationships | Programmatic labels, descriptions, dialog roles, and named summary region. |
| 1.4.3 Contrast (Minimum) | Token and button ratios above. |
| 1.4.10 Reflow | Full-width dialogs and flexible action rows at 320 CSS px. |
| 2.1.1 Keyboard | Dialog controls are native buttons/inputs; focus handoff is automated. |
| 2.1.2 No Keyboard Trap | Nested trap has Escape-to-cancel; parent trap suspends and resumes. |
| 2.4.3 Focus Order | Initial focus in the challenge, then explicit review action. |
| 2.4.6 Headings and Labels | Visible and programmatically associated labels; named dialogs. |
| 2.4.7 Focus Visible | Existing 2 px primary-color focus outline. |
| 2.4.11 Focus Not Obscured (Minimum) | Nested dialog is above the parent (`z-[60]`), with a single active trap. |
| 3.3.1 Error Identification | Inline alert plus `aria-invalid` and described-by association. |
| 3.3.2 Labels or Instructions | Amount hint, phrase hint, and challenge label. |
| 3.3.3 Error Suggestion | Classified error summary with recovery action text. |
| 4.1.2 Name, Role, Value | Native controls and explicit dialog/region roles. |
| 4.1.3 Status Messages | Polite, atomic quote and review announcements. |
