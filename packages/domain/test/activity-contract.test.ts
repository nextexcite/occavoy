import { describe, expect, it } from "vitest";
import {
  activityDestinationSchema,
  activityOccurrenceSchema,
  activityPortabilityFixtures,
  isCountableSourcedOccurrence,
  japanActivitySeeds,
  mapEventsquareOccurrence0_1_0,
} from "../src/index";

const hash = "a".repeat(64);

function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

function occavoyOverlay() {
  return {
    id: "mapped-eventsquare-occurrence",
    destination: { countryCode: "JP" as const, city: "Tokyo", mapping: "occavoy_curated" as const },
    venue: { name: "Mapped Venue" },
    participation: {
      registration: "unknown" as const,
      applicationStatus: "unknown" as const,
      conditions: ["Mapped projection test only"],
    },
    bookability: {
      state: "not_assessed" as const,
      inventory: "not_observed" as const,
      note: "Mapping test; no inventory claim.",
    },
  };
}

function eventsquareRecord(timing: unknown, level = "occurrence") {
  return {
    id: "es-record-1",
    revisionId: "rev-1",
    observationId: "obs-1",
    sourceId: "eventsquare-test-source",
    evidenceKind: "source_observation",
    publishedAt: "2026-11-28T16:31:00Z",
    decisions: ["decision-1"],
    candidate: {
      nativeId: "native-1",
      level,
      regionIds: ["jp-tokyo"],
      names: [{ text: "イベント", language: "ja", script: "Jpan", kind: "original" }],
      themes: ["workshop"],
      timing,
      status: "scheduled",
      url: "https://source.example/events/1",
      location: "Source venue text",
      participationLanguage: ["ja"],
      access: { registration: "unknown" },
      claims: [
        {
          field: "names",
          value: [{ text: "イベント", language: "ja", script: "Jpan", kind: "original" }],
          state: "known",
          evidence: { observationId: "obs-1", locator: "h1", contentHash: hash },
        },
        {
          field: "timing",
          value: timing,
          state: "known",
          evidence: { observationId: "obs-1", locator: "date table", contentHash: hash },
        },
        {
          field: "location",
          value: "Source venue text",
          state: "known",
          evidence: { observationId: "obs-1", locator: "venue table", contentHash: hash },
        },
        {
          field: "status",
          value: "scheduled",
          state: "known",
          evidence: { observationId: "obs-1", locator: "detail badge", contentHash: hash },
        },
      ],
    },
    provenance: {
      observedAt: "2026-11-28T16:30:00Z",
      originObservedAt: null,
      sourceUrl: "https://source.example/events/1",
      publisherId: "eventsquare-test-publisher",
      interfaceId: "eventsquare-test-source",
      contentHash: hash,
      rights: {
        status: "unassessed",
        reference: "mapping test fixture",
        retainEvidence: false,
        modelInput: false,
        index: false,
      },
      lineage: "eventsquare runtime record 0.1.0 compatibility fixture",
      representation: "minimal_factual_projection",
      sourceModifiedAt: null,
      reportedCacheAgeSeconds: null,
      freshness: { status: "unknown", reason: "mapping test" },
    },
  };
}

describe("sourced activity occurrence contract", () => {
  it("contains exactly twenty countable real Japan occurrence seeds", () => {
    expect(japanActivitySeeds).toHaveLength(20);
    for (const seed of japanActivitySeeds) {
      expect(activityOccurrenceSchema.safeParse(seed).success).toBe(true);
      expect(isCountableSourcedOccurrence(seed)).toBe(true);
      expect(seed.provenance.evidenceKind).toBe("source_observation");
      expect(seed.provenance.nativeId.length).toBeGreaterThan(0);
      expect(seed.provenance.sourceUrl).toMatch(/^https:\/\//);
      expect(seed.provenance.observedAt).toMatch(/^2026-11-28T/);
      expect(seed.venue.name.length).toBeGreaterThan(0);
      expect(seed.eventStatus).not.toBe("unknown");
      expect(seed.schedule.start.precision).not.toBe("unknown");
      expect(seed.bookability).toMatchObject({ state: "not_assessed", inventory: "not_observed" });
      for (const session of seed.schedule.sessions)
        expect(session.start.precision).not.toBe("unknown");
    }
  });

  it("uses three independent first-party source families and preserves source status separately", () => {
    expect(new Set(japanActivitySeeds.map((seed) => seed.provenance.publisherId))).toEqual(
      new Set(["tokyo-culture-debut", "live-nation-hip-japan", "city-of-tsukuba"]),
    );
    const sourceRecords = japanActivitySeeds.map(
      (seed) => `${seed.provenance.publisherId}/${seed.provenance.nativeId}`,
    );
    expect(new Set(sourceRecords).size).toBe(20);
    expect(new Set(japanActivitySeeds.map((seed) => seed.level))).toEqual(
      new Set(["edition", "occurrence"]),
    );
    expect(japanActivitySeeds.some((seed) => (seed.level as string) === "series")).toBe(false);
    const closedRegistration = japanActivitySeeds.find(
      (seed) => seed.id === "jp-tcd-2645-building-explorers",
    );
    expect(closedRegistration?.eventStatus).toBe("scheduled");
    expect(closedRegistration?.sourceStatusText).toContain("募集終了");
    expect(closedRegistration?.participation.applicationStatus).toBe("closed");
    expect(closedRegistration?.bookability.state).toBe("not_assessed");
  });

  it("keeps event start, walk-in opening, registration deadline and check-in deadline distinct", () => {
    const workshop = japanActivitySeeds.find(
      (seed) => seed.id === "jp-tcd-2682-tokyo-atlas-ito-no-toi",
    );
    expect(workshop?.schedule.start).toMatchObject({ precision: "local_datetime", time: "10:00" });
    expect(workshop?.schedule.registrationDeadline).toMatchObject({
      date: "2026-12-05",
      time: "17:00",
    });
    expect(workshop?.schedule.checkInDeadline).toMatchObject({ date: "2026-12-06", time: "09:45" });
    const concert = japanActivitySeeds.find((seed) => seed.id === "jp-ln-khalid-tokyo-2026-12-03");
    expect(concert?.schedule.start).toMatchObject({ time: "19:00" });
    expect(concert?.schedule.walkInOpening).toMatchObject({ opensAt: "18:00" });
  });

  it("does not require or default a destination timezone, JST, or JPY", () => {
    expect(
      activityDestinationSchema.safeParse({
        countryCode: "JP",
        city: "Tokyo",
        mapping: "occavoy_curated",
      }).success,
    ).toBe(true);
    for (const seed of japanActivitySeeds) {
      expect(seed.destination.timeZone).toBeUndefined();
      for (const price of seed.prices) expect(price.currency).toBe("JPY");
    }
  });

  it("keeps multiple sessions inside one activity instead of counting them as separate activities", () => {
    const tsukuba = japanActivitySeeds.find(
      (seed) => seed.id === "jp-tsukuba-wakudoki-safety-festa-2026",
    );
    expect(tsukuba?.schedule.sessions).toHaveLength(4);
    expect(tsukuba?.schedule.sessions.map((session) => session.start)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-12-05", time: "10:00" }),
        expect.objectContaining({ date: "2026-12-06", time: "13:30" }),
      ]),
    );
    expect(tsukuba?.schedule.start).not.toHaveProperty("timeZone");
    expect(tsukuba?.provenance.licenseUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(tsukuba?.provenance.attribution).toBe("City of Tsukuba");
    const postal = japanActivitySeeds.find(
      (seed) => seed.id === "jp-tcd-2739-postal-museum-clay-class",
    );
    expect(postal?.schedule.sessions).toHaveLength(4);
  });

  it("keeps real source observations visibly distinct from synthetic fixtures", () => {
    expect(
      japanActivitySeeds.every((seed) => seed.provenance.evidenceKind === "source_observation"),
    ).toBe(true);
    expect(
      activityPortabilityFixtures.every(
        (seed) => seed.provenance.evidenceKind === "synthetic_fixture",
      ),
    ).toBe(true);
    expect(
      activityPortabilityFixtures.every((seed) => seed.bookability.state === "synthetic_only"),
    ).toBe(true);
  });
});

describe("global portability fixtures", () => {
  it("passes a non-Japan timezone and currency fixture through the same contract", () => {
    const london = activityPortabilityFixtures.find(
      (fixture) => fixture.id === "fixture-gb-london-dst-transition",
    );
    expect(london).toBeDefined();
    expect(activityOccurrenceSchema.safeParse(london).success).toBe(true);
    expect(london?.destination.countryCode).toBe("GB");
    expect(london?.destination.timeZone).toBe("Europe/London");
    expect(london?.prices[0]?.currency).toBe("GBP");
    expect(london?.provenance.evidenceKind).toBe("synthetic_fixture");
  });

  it("represents the London daylight-saving boundary without a fixed offset", () => {
    const london = activityPortabilityFixtures.find(
      (fixture) => fixture.id === "fixture-gb-london-dst-transition",
    );
    expect(london?.schedule.start).toMatchObject({
      precision: "instant",
      instant: "2027-03-28T00:30:00+00:00",
    });
    expect(london?.schedule.end).toMatchObject({
      precision: "instant",
      instant: "2027-03-28T03:30:00+01:00",
    });
    if (
      london?.schedule.start.precision === "instant" &&
      london.schedule.end?.precision === "instant"
    ) {
      expect(Date.parse(london.schedule.end.instant)).toBeGreaterThan(
        Date.parse(london.schedule.start.instant),
      );
    }
  });

  it("accepts a fractional-offset IANA timezone without normalizing it away", () => {
    const kathmandu = activityPortabilityFixtures.find(
      (fixture) => fixture.id === "fixture-np-kathmandu-fractional-offset",
    );
    expect(kathmandu?.schedule.start).toMatchObject({
      precision: "local_datetime",
      timeZone: "Asia/Kathmandu",
      date: "2027-04-15",
      time: "09:15",
    });
    expect(() =>
      new Intl.DateTimeFormat("en", { timeZone: "Asia/Kathmandu" }).format(new Date()),
    ).not.toThrow();
  });

  it("does not promote date-only timing to a midnight instant", () => {
    const hk = activityPortabilityFixtures.find(
      (fixture) => fixture.id === "fixture-hk-mixed-currency-date-only",
    );
    expect(hk?.schedule.start.precision).toBe("date");
    expect(hk?.schedule.start).not.toHaveProperty("instant");
    expect(hk?.schedule.start).not.toHaveProperty("time");
    expect(hk?.schedule.start.originalText).toContain("date-only");
  });

  it("preserves mixed-currency components separately and validates currency minor units", () => {
    const hk = activityPortabilityFixtures.find(
      (fixture) => fixture.id === "fixture-hk-mixed-currency-date-only",
    );
    expect(hk?.prices.map((price) => price.currency)).toEqual(["HKD", "EUR"]);
    expect(hk).not.toHaveProperty("total");
    for (const fixture of activityPortabilityFixtures) {
      for (const price of fixture.prices)
        expect(price.minorUnit).toBe(currencyDigits(price.currency));
    }
    const threeDecimal = activityPortabilityFixtures
      .flatMap((fixture) => fixture.prices)
      .find((price) => price.currency === "BHD");
    expect(threeDecimal?.minorUnit).toBe(3);
    expect(currencyDigits("BHD")).toBe(3);
    expect(currencyDigits("JPY")).toBe(0);
  });
});

describe("thin Eventsquare mapping", () => {
  it("maps a timed occurrence while leaving unknown timezone and bookability unknown", () => {
    const mapped = mapEventsquareOccurrence0_1_0(
      eventsquareRecord({
        precision: "instant",
        start: "2026-12-06T10:00:00+09:00",
        end: "2026-12-06T12:00:00+09:00",
        original: "2026年12月6日 10:00-12:00",
      }),
      occavoyOverlay(),
    );
    expect(mapped.titles[0]?.text).toBe("イベント");
    expect(mapped.schedule.start).toMatchObject({
      precision: "instant",
      instant: "2026-12-06T10:00:00+09:00",
    });
    expect(mapped.schedule.start).not.toHaveProperty("timeZone");
    expect(mapped.level).toBe("occurrence");
    expect(mapped.eventStatus).toBe("scheduled");
    expect(mapped.bookability.state).toBe("not_assessed");
    expect(mapped.provenance.nativeId).toBe("native-1");
    expect(mapped.provenance.fieldEvidence.length).toBeGreaterThanOrEqual(4);
  });

  it("maps a date-only occurrence without inventing midnight", () => {
    const mapped = mapEventsquareOccurrence0_1_0(
      eventsquareRecord({
        precision: "date",
        start: "2026-10-21",
        endExclusive: "2026-12-21",
        timezone: "Asia/Tokyo",
        original: "2026年10月21日～12月20日",
      }),
      occavoyOverlay(),
    );
    expect(mapped.schedule.start).toMatchObject({
      precision: "date",
      date: "2026-10-21",
      timeZone: "Asia/Tokyo",
    });
    expect(mapped.schedule.start).not.toHaveProperty("instant");
    expect(mapped.schedule.end).toMatchObject({ precision: "date", date: "2026-12-20" });
  });

  it("rejects editions or series as individual occurrence seeds", () => {
    expect(() =>
      mapEventsquareOccurrence0_1_0(
        eventsquareRecord({ precision: "unknown", reason: "not published" }, "edition"),
        occavoyOverlay(),
      ),
    ).toThrow(/individual Eventsquare occurrences/);
  });
});
