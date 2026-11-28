import { z } from "zod";

export const CUSTOMER_MARKET = "HK" as const;
export const DESTINATION_SCOPE = "global" as const;

export const moneySchema = z.object({
  amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const intakeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const caseIntakeSchema = z.strictObject({
  activate: z.literal(true),
  commandId: intakeId,
  eventId: intakeId,
  budget: z.strictObject(moneySchema.shape),
});

export const destinationSchema = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  city: z.string().min(1),
  timeZone: z
    .string()
    .refine((value) => {
      // Intl also accepts fixed offsets, which do not carry IANA daylight-saving rules.
      if (/^[+-]/.test(value)) return false;
      try {
        new Intl.DateTimeFormat("en", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    }, "An IANA time zone is required when one is recorded")
    .optional(),
});

export const eventSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    destination: destinationSchema,
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    sourceUrl: z.url(),
    observedAt: z.iso.datetime({ offset: true }),
    evidenceKind: z.enum(["official", "partner", "fixture"]),
  })
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
    message: "Event end must follow its start",
  });

export const briefSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  customerMarket: z.literal(CUSTOMER_MARKET),
  origin: z.string().min(1),
  destination: destinationSchema,
  adults: z.number().int().min(1).max(20),
  budget: moneySchema,
  locale: z.enum(["en-HK", "zh-Hant-HK"]),
});

export interface QuoteVersion {
  id: string;
  version: number;
  tenantId: string;
  caseId: string;
  total: z.infer<typeof moneySchema>;
  validUntil: string;
  availability: "observed" | "quoted" | "held";
}

export interface Approval {
  tenantId: string;
  caseId: string;
  quoteId: string;
  quoteVersion: number;
  approvedAt: string;
}

/** Pure preflight only: transaction-time CAS and supplier revalidation are still required. */
export function checkApproval(
  quote: QuoteVersion,
  approval: Approval,
  now: Date,
):
  | { ok: true }
  | {
      ok: false;
      reason:
        | "scope_mismatch"
        | "stale_approval"
        | "invalid_time"
        | "expired_quote"
        | "unverified_price";
    } {
  if (quote.tenantId !== approval.tenantId || quote.caseId !== approval.caseId) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (quote.id !== approval.quoteId || quote.version !== approval.quoteVersion) {
    return { ok: false, reason: "stale_approval" };
  }
  const expires = Date.parse(quote.validUntil);
  const approved = Date.parse(approval.approvedAt);
  if (
    !Number.isFinite(expires) ||
    !Number.isFinite(approved) ||
    !Number.isFinite(now.getTime()) ||
    approved > now.getTime()
  ) {
    return { ok: false, reason: "invalid_time" };
  }
  if (expires <= now.getTime() || approved >= expires) {
    return { ok: false, reason: "expired_quote" };
  }
  if (quote.availability === "observed") {
    return { ok: false, reason: "unverified_price" };
  }
  return { ok: true };
}

export type EventRecord = z.infer<typeof eventSchema>;
export type ServiceBrief = z.infer<typeof briefSchema>;

// Synthetic UI fixtures. These are not collected events, live inventory or bookable offers.
export const demoEvents: EventRecord[] = [
  {
    id: "fixture-tokyo",
    title: "An art weekend in Tokyo",
    destination: { countryCode: "JP", city: "Tokyo", timeZone: "Asia/Tokyo" },
    startsAt: "2027-02-06T10:00:00+09:00",
    endsAt: "2027-02-06T18:00:00+09:00",
    sourceUrl: "https://example.com/fixtures/tokyo",
    observedAt: "2026-11-27T00:00:00Z",
    evidenceKind: "fixture",
  },
  {
    id: "fixture-london",
    title: "A performance weekend in London",
    destination: { countryCode: "GB", city: "London", timeZone: "Europe/London" },
    startsAt: "2027-03-27T19:00:00+00:00",
    endsAt: "2027-03-27T22:00:00+00:00",
    sourceUrl: "https://example.com/fixtures/london",
    observedAt: "2026-11-27T00:00:00Z",
    evidenceKind: "fixture",
  },
  {
    id: "fixture-singapore",
    title: "A city break in Singapore",
    destination: { countryCode: "SG", city: "Singapore", timeZone: "Asia/Singapore" },
    startsAt: "2027-02-13T10:00:00+08:00",
    endsAt: "2027-02-13T18:00:00+08:00",
    sourceUrl: "https://example.com/fixtures/singapore",
    observedAt: "2026-11-27T00:00:00Z",
    evidenceKind: "fixture",
  },
];

export * from "./activity";
export * from "./activity-seeds";
