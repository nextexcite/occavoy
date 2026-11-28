import { describe, expect, it } from "vitest";
import { signCaseAccessGrant, verifyCaseAccessGrant } from "./runtime-access";

const secret = "local-test-signing-secret-with-at-least-32-characters";
const payload = {
  version: 1 as const,
  grantId: "grant-1",
  tenantId: "tenant-1",
  caseId: "case-1",
  actorId: "actor-1",
  permissions: ["case.read" as const],
  validUntil: "2027-01-01T00:00:00.000Z",
};
const now = new Date("2026-11-28T00:00:00.000Z");

describe("server-signed case access grants", () => {
  it("accepts a grant for its exact case and permission", async () => {
    const token = await signCaseAccessGrant(payload, secret);
    await expect(
      verifyCaseAccessGrant(token, secret, { caseId: "case-1", permission: "case.read", now }),
    ).resolves.toMatchObject({ ok: true, grant: { caseId: "case-1", tenantId: "tenant-1" } });
  });

  it("rejects a changed signature without revealing the secret", async () => {
    const token = await signCaseAccessGrant(payload, secret);
    const other = await signCaseAccessGrant(payload, `${secret}-different`);
    const signature = other.split(".")[1];
    await expect(
      verifyCaseAccessGrant(`${token.split(".")[0]}.${signature}`, secret, {
        caseId: "case-1",
        permission: "case.read",
        now,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("rejects expiry, another case, and a missing permission", async () => {
    const token = await signCaseAccessGrant(payload, secret);
    await expect(
      verifyCaseAccessGrant(token, secret, {
        caseId: "case-1",
        permission: "case.read",
        now: new Date("2027-01-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "expired" });
    await expect(
      verifyCaseAccessGrant(token, secret, { caseId: "case-2", permission: "case.read", now }),
    ).resolves.toMatchObject({ ok: false, reason: "case_mismatch" });

    const noReadPermission = await signCaseAccessGrant(
      { ...payload, permissions: ["case.edit"], grantId: "grant-2" },
      secret,
    );
    await expect(
      verifyCaseAccessGrant(noReadPermission, secret, {
        caseId: "case-1",
        permission: "case.read",
        now,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "permission_missing" });
  });

  it("rejects malformed tokens and short signing secrets", async () => {
    await expect(
      verifyCaseAccessGrant("not-a-grant", secret, {
        caseId: "case-1",
        permission: "case.read",
        now,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "malformed" });
    await expect(signCaseAccessGrant(payload, "too-short")).rejects.toThrow(/32 characters/);
  });
});
