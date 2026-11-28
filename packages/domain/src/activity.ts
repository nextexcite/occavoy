import { z } from "zod";

export const ianaTimeZoneSchema = z.string().refine((value) => {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "An IANA time zone is required when a zone is evidenced");

export const localizedTextSchema = z.strictObject({
  text: z.string().min(1).max(500),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
  script: z.string().min(1).max(40).optional(),
  kind: z.enum(["original", "official", "transliteration", "translation", "curated"]).optional(),
});

const timingOriginalSchema = z.string().min(1).max(500);
const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** One evidenced time point. A date-only value is never promoted to midnight. */
export const activityTimePointSchema = z.discriminatedUnion("precision", [
  z.strictObject({
    precision: z.literal("unknown"),
    reason: z.string().min(1).max(300),
    originalText: timingOriginalSchema.optional(),
  }),
  z.strictObject({
    precision: z.literal("date"),
    date: z.iso.date(),
    timeZone: ianaTimeZoneSchema.optional(),
    originalText: timingOriginalSchema,
  }),
  z.strictObject({
    precision: z.literal("local_datetime"),
    date: z.iso.date(),
    time: localTimeSchema,
    timeZone: ianaTimeZoneSchema.optional(),
    originalText: timingOriginalSchema,
  }),
  z.strictObject({
    precision: z.literal("instant"),
    instant: z.iso.datetime({ offset: true }),
    timeZone: ianaTimeZoneSchema.optional(),
    originalText: timingOriginalSchema,
  }),
]);

export type ActivityTimePoint = z.infer<typeof activityTimePointSchema>;

/** Recurring or occurrence-specific admission opening; distinct from the event start. */
export const openingWindowSchema = z.strictObject({
  opensAt: localTimeSchema.optional(),
  closesAt: localTimeSchema.optional(),
  timeZone: ianaTimeZoneSchema.optional(),
  originalText: timingOriginalSchema,
});

export const activitySessionSchema = z
  .strictObject({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(120).optional(),
    start: activityTimePointSchema,
    end: activityTimePointSchema.optional(),
    walkInOpening: openingWindowSchema.optional(),
    registrationDeadline: activityTimePointSchema.optional(),
    /** Exact reception/assembly/check-in time when stated; not a cutoff unless the source says so. */
    checkInTime: activityTimePointSchema.optional(),
    checkInDeadline: activityTimePointSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.end) return;
    if (
      value.start.precision === "instant" &&
      value.end.precision === "instant" &&
      Date.parse(value.end.instant) <= Date.parse(value.start.instant)
    ) {
      ctx.addIssue({ code: "custom", message: "Session end instant must follow start instant" });
    }
  });

export const activityScheduleSchema = z
  .strictObject({
    start: activityTimePointSchema,
    /** Inclusive source end boundary when published; date-only values remain dates. */
    end: activityTimePointSchema.optional(),
    walkInOpening: openingWindowSchema.optional(),
    registrationDeadline: activityTimePointSchema.optional(),
    /** Exact reception/assembly/check-in time when stated; not a cutoff unless the source says so. */
    checkInTime: activityTimePointSchema.optional(),
    checkInDeadline: activityTimePointSchema.optional(),
    sessions: z.array(activitySessionSchema).max(40).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.end) return;
    const { start, end } = value;
    if (
      start.precision === "instant" &&
      end.precision === "instant" &&
      Date.parse(end.instant) <= Date.parse(start.instant)
    ) {
      ctx.addIssue({ code: "custom", message: "End instant must follow start instant" });
    }
    if (start.precision === "date" && end.precision === "date" && end.date < start.date) {
      ctx.addIssue({ code: "custom", message: "End date must not precede start date" });
    }
  });

export const activityDestinationSchema = z.strictObject({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  city: z.string().min(1).max(120),
  timeZone: ianaTimeZoneSchema.optional(),
  mapping: z.literal("occavoy_curated"),
});

export const activityVenueSchema = z.strictObject({
  name: z.string().min(1).max(240),
  address: z.string().min(1).max(300).optional(),
});

export const activityPriceSchema = z.strictObject({
  label: z.string().min(1).max(160),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Captured minor-unit exponent; zero-decimal and three-decimal currencies are valid. */
  minorUnit: z.number().int().min(0).max(3),
  sourceText: z.string().min(1).max(300),
});

export const participationConditionsSchema = z.strictObject({
  registration: z.enum(["required", "partially_required", "not_required", "unknown"]),
  applicationStatus: z.enum(["accepting", "closed", "not_applicable", "unknown"]),
  eligibility: z.string().min(1).max(500).optional(),
  conditions: z.array(z.string().min(1).max(400)).max(12),
  accessRouteUrl: z.url().optional(),
  costText: z.string().min(1).max(500).optional(),
});

export const activityFieldEvidenceSchema = z.strictObject({
  field: z.enum([
    "title",
    "timing",
    "place",
    "status",
    "participation",
    "price",
    "opening",
    "registration_deadline",
    "check_in_time",
    "check_in_deadline",
  ]),
  locator: z.string().min(1).max(240),
  excerpt: z.string().min(1).max(500).optional(),
});

export const activityProvenanceSchema = z.strictObject({
  evidenceKind: z.enum(["source_observation", "synthetic_fixture"]),
  publisherId: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(160),
  nativeId: z.string().min(1).max(160),
  sourceUrl: z.url(),
  observedAt: z.iso.datetime({ offset: true }),
  retrievalMethod: z.enum([
    "manual_bounded_public_read",
    "eventsquare_projection_receipt",
    "checked_in_synthetic_fixture",
  ]),
  fieldEvidence: z.array(activityFieldEvidenceSchema).min(4).max(20),
  rightsNote: z.string().min(1).max(500),
  attribution: z.string().min(1).max(300).optional(),
  licenseUrl: z.url().optional(),
  adaptationNote: z.string().min(1).max(300).optional(),
});

/** Customer-facing activities are concrete editions or occurrences; series templates and permanent places are not seeds. */
export const activityLevelSchema = z.enum(["edition", "occurrence"]);

/** Discovery state is deliberately independent from event status and from any later supplier quote. */
export const activityBookabilitySchema = z.strictObject({
  state: z.enum(["not_assessed", "synthetic_only"]),
  inventory: z.literal("not_observed"),
  note: z.string().min(1).max(300),
});

export const activityOccurrenceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9:-]{2,120}$/),
  schemaVersion: z.literal("occavoy.activity/0.1.0"),
  level: activityLevelSchema,
  titles: z.array(localizedTextSchema).min(1).max(8),
  destination: activityDestinationSchema,
  venue: activityVenueSchema,
  schedule: activityScheduleSchema,
  eventStatus: z.enum(["scheduled", "cancelled", "postponed", "rescheduled", "unknown"]),
  sourceStatusText: z.array(z.string().min(1).max(80)).min(1).max(4),
  participation: participationConditionsSchema,
  prices: z.array(activityPriceSchema).max(12).default([]),
  bookability: activityBookabilitySchema,
  provenance: activityProvenanceSchema,
});

export type ActivityFieldEvidence = z.infer<typeof activityFieldEvidenceSchema>;
export type ActivityProvenance = z.infer<typeof activityProvenanceSchema>;
export type ActivityOccurrence = z.infer<typeof activityOccurrenceSchema>;

const requiredEvidenceFields = ["title", "timing", "place", "status"] as const;

/** Counting rule for OCA-9: a real seed is countable only when its core facts are evidenced. */
export function isCountableSourcedOccurrence(activity: ActivityOccurrence): boolean {
  if (activity.provenance.evidenceKind !== "source_observation") return false;
  if (activity.eventStatus === "unknown") return false;
  if (activity.schedule.start.precision === "unknown") return false;
  if (!activity.destination.countryCode || !activity.destination.city || !activity.venue.name) {
    return false;
  }
  const evidenced = new Set(activity.provenance.fieldEvidence.map((item) => item.field));
  return requiredEvidenceFields.every((field) => evidenced.has(field));
}

/** Narrow, versioned projection of Eventsquare runtime record 0.1.0. Extra record fields are ignored, not mirrored. */
export const eventsquareRuntimeRecord0_1_0Schema = z.object({
  id: z.string().min(1),
  revisionId: z.string().min(1),
  candidate: z.object({
    nativeId: z.string().min(1),
    level: z.enum(["series", "edition", "occurrence", "place"]),
    names: z.array(localizedTextSchema).min(1),
    timing: z.discriminatedUnion("precision", [
      z.strictObject({ precision: z.literal("unknown"), reason: z.string().min(1) }),
      z.strictObject({
        precision: z.literal("date"),
        start: z.iso.date(),
        endExclusive: z.iso.date(),
        timezone: z.string().optional(),
        original: z.string().min(1),
      }),
      z.strictObject({
        precision: z.literal("instant"),
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }).optional(),
        timezone: z.string().optional(),
        original: z.string().min(1),
      }),
    ]),
    status: z.enum(["scheduled", "cancelled", "postponed", "rescheduled", "unknown"]),
    url: z.url(),
    location: z.string().optional(),
    access: z
      .object({
        registration: z.enum(["required", "not_required", "unknown"]),
        eligibility: z.string().optional(),
        url: z.url().optional(),
      })
      .optional(),
    claims: z.array(
      z.object({
        field: z.string().min(1),
        state: z.string().min(1),
        evidence: z.object({
          observationId: z.string().min(1),
          locator: z.string().min(1),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      }),
    ),
  }),
  provenance: z.object({
    observedAt: z.iso.datetime({ offset: true }),
    sourceUrl: z.url(),
    publisherId: z.string().min(1),
    interfaceId: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export type EventsquareRuntimeRecord0_1_0 = z.infer<typeof eventsquareRuntimeRecord0_1_0Schema>;

function mapTimingPoint(
  timing: EventsquareRuntimeRecord0_1_0["candidate"]["timing"],
  boundary: "start" | "end",
): ActivityTimePoint {
  if (timing.precision === "unknown") {
    return { precision: "unknown", reason: timing.reason };
  }
  if (timing.precision === "date") {
    const date = boundary === "start" ? timing.start : timing.endExclusive;
    const inclusiveDate =
      boundary === "end"
        ? new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
        : date;
    return {
      precision: "date",
      date: inclusiveDate,
      ...(timing.timezone ? { timeZone: timing.timezone } : {}),
      originalText: timing.original,
    };
  }
  if (boundary === "end" && !timing.end) {
    return { precision: "unknown", reason: "Eventsquare record has no end instant" };
  }
  return {
    precision: "instant",
    instant: boundary === "start" ? timing.start : timing.end!,
    ...(timing.timezone ? { timeZone: timing.timezone } : {}),
    originalText: timing.original,
  };
}

/**
 * Maps the pinned Eventsquare runtime record shape without importing its runtime or mirroring its DB.
 * Occavoy-owned place resolution, participation review, prices and bookability are supplied by the caller.
 */
export function mapEventsquareOccurrence0_1_0(
  input: unknown,
  occavoy: Pick<
    ActivityOccurrence,
    "id" | "destination" | "venue" | "participation" | "bookability"
  > &
    Partial<Pick<ActivityOccurrence, "prices">>,
): ActivityOccurrence {
  const record = eventsquareRuntimeRecord0_1_0Schema.parse(input);
  if (record.candidate.level !== "occurrence") {
    throw new Error("Only individual Eventsquare occurrences can become Occavoy activity seeds");
  }
  const claimEvidence = record.candidate.claims.flatMap((claim) => {
    const field =
      claim.field === "names" ? "title" : claim.field === "location" ? "place" : claim.field;
    if (!activityFieldEvidenceSchema.shape.field.options.includes(field as never)) return [];
    return [
      {
        field: field as z.infer<typeof activityFieldEvidenceSchema>["field"],
        locator: `${claim.evidence.observationId}: ${claim.evidence.locator}`,
      },
    ];
  });
  const timing = record.candidate.timing;
  const end =
    timing.precision === "date" || (timing.precision === "instant" && timing.end)
      ? mapTimingPoint(timing, "end")
      : undefined;
  const access = record.candidate.access;
  return activityOccurrenceSchema.parse({
    ...occavoy,
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: record.candidate.names,
    schedule: {
      start: mapTimingPoint(timing, "start"),
      ...(end && end.precision !== "unknown" ? { end } : {}),
    },
    eventStatus: record.candidate.status,
    sourceStatusText: [record.candidate.status],
    participation: {
      ...occavoy.participation,
      registration: access?.registration ?? occavoy.participation.registration,
      ...(access?.eligibility ? { eligibility: access.eligibility } : {}),
      ...(access?.url ? { accessRouteUrl: access.url } : {}),
    },
    prices: occavoy.prices ?? [],
    provenance: {
      evidenceKind: "source_observation",
      publisherId: record.provenance.publisherId,
      sourceId: record.provenance.interfaceId,
      nativeId: record.candidate.nativeId,
      sourceUrl: record.candidate.url,
      observedAt: record.provenance.observedAt,
      retrievalMethod: "manual_bounded_public_read",
      fieldEvidence: claimEvidence,
      rightsNote:
        "Mapped narrow factual projection only; no Eventsquare runtime, database, raw source, images or long descriptions are imported.",
    },
  });
}
