import { describe, expect, it } from "vitest";
import {
  type Approval,
  briefSchema,
  checkApproval,
  demoEvents,
  eventSchema,
  type QuoteVersion,
} from "../src/index";

const quote: QuoteVersion = {
  id: "q-1",
  version: 2,
  tenantId: "a",
  caseId: "case-1",
  total: { amountMinor: 123456, currency: "GBP" },
  validUntil: "2026-12-01T10:00:00Z",
  availability: "quoted",
};
const approval: Approval = {
  tenantId: "a",
  caseId: "case-1",
  quoteId: "q-1",
  quoteVersion: 2,
  approvedAt: "2026-12-01T09:00:00Z",
};

describe("global destinations and HK customer scope", () => {
  it("accepts fixtures across three countries without a Japan-only contract", () => {
    for (const event of demoEvents) expect(eventSchema.safeParse(event).success).toBe(true);
    expect(new Set(demoEvents.map((e) => e.destination.countryCode)).size).toBe(3);
    expect(
      briefSchema.parse({
        id: "brief-1",
        tenantId: "a",
        customerMarket: "HK",
        origin: "HKG",
        destination: { countryCode: "GB", city: "London", timeZone: "Europe/London" },
        adults: 2,
        budget: { amountMinor: 1000000, currency: "HKD" },
        locale: "en-HK",
      }).destination.countryCode,
    ).toBe("GB");
  });
  it("rejects unknown time zones and reversed dates", () => {
    const event = demoEvents[0];
    expect(event).toBeDefined();
    expect(
      eventSchema.safeParse({
        ...event,
        destination: { countryCode: "GB", city: "London", timeZone: "Mars/London" },
      }).success,
    ).toBe(false);
    expect(
      eventSchema.safeParse({
        ...event,
        destination: { countryCode: "GB", city: "London", timeZone: "+01:00" },
      }).success,
    ).toBe(false);
    expect(eventSchema.safeParse({ ...event, endsAt: "2020-01-01T00:00:00Z" }).success).toBe(false);
  });
});

describe("version-bound approval preflight", () => {
  it("accepts the exact current scoped quote before expiry", () => {
    expect(checkApproval(quote, approval, new Date("2026-12-01T09:30:00Z"))).toEqual({ ok: true });
  });
  it("rejects cross-tenant and stale approvals", () => {
    expect(
      checkApproval(quote, { ...approval, tenantId: "b" }, new Date("2026-12-01T09:30:00Z")),
    ).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(
      checkApproval(quote, { ...approval, quoteVersion: 1 }, new Date("2026-12-01T09:30:00Z")),
    ).toEqual({ ok: false, reason: "stale_approval" });
  });
  it("rejects at the exact expiry boundary, observed prices, and invalid clocks", () => {
    expect(checkApproval(quote, approval, new Date(quote.validUntil))).toEqual({
      ok: false,
      reason: "expired_quote",
    });
    expect(
      checkApproval(
        { ...quote, availability: "observed" },
        approval,
        new Date("2026-12-01T09:30:00Z"),
      ),
    ).toEqual({ ok: false, reason: "unverified_price" });
    expect(checkApproval(quote, approval, new Date("invalid"))).toEqual({
      ok: false,
      reason: "invalid_time",
    });
  });
});
