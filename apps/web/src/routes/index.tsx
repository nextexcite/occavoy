import { type ActivityOccurrence, japanActivitySeeds } from "@occavoy/domain";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Discover });

const featuredSeedIds = [
  "jp-tcd-680-national-university-print-exhibition",
  "jp-tcd-650-nutcracker-full-length",
  "jp-ln-khalid-tokyo-2026-12-03",
];

const featuredActivities = featuredSeedIds
  .map((id) => japanActivitySeeds.find((seed) => seed.id === id))
  .filter((seed): seed is ActivityOccurrence => seed !== undefined);

function seedTitle(seed: ActivityOccurrence): string {
  return (
    seed.titles.find((title) => title.kind === "original")?.text ?? seed.titles[0]?.text ?? seed.id
  );
}

function seedWhen(seed: ActivityOccurrence): string {
  const { start, end } = seed.schedule;
  if (start.precision === "date") {
    const endText = end?.precision === "date" ? ` → ${end.date}` : "";
    return `${start.date}${endText} · source date precision`;
  }
  if (start.precision === "local_datetime") {
    return `${start.date} · ${start.time} local source time`;
  }
  if (start.precision === "instant") return `${start.instant} · source instant`;
  return "Timing unknown in checked source";
}

function Discover() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">A reason to go. A service that follows through.</p>
        <h1>
          Make room for
          <br />
          <span>the experience.</span>
        </h1>
        <p className="lede">
          Find something worth travelling for. Bring your preferences, and shape the journey around
          it.
        </p>
        <Link to="/case" className="button">
          Start a service request <span>↗</span>
        </Link>
      </section>
      <section className="section-heading">
        <h2>Sourced activity seeds</h2>
        <p>
          Twenty real Japanese listings are checked in with source, retrieval time, timing, place
          and status. These are discovery facts, not inventory or offers.
        </p>
      </section>
      <div className="cards">
        {featuredActivities.map((activity, index) => (
          <article className={`event-card palette-${index}`} key={activity.id}>
            <div className="card-art" aria-hidden="true">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <i />
            </div>
            <div className="card-body">
              <span className="eyebrow">
                {activity.destination.city} · {activity.destination.countryCode}
              </span>
              <h3>{seedTitle(activity)}</h3>
              <p>{seedWhen(activity)}</p>
              <p className="source-badge">Real public source · not bookable inventory</p>
              <p className="source-meta">
                {activity.provenance.publisherId} · observed {activity.provenance.observedAt}
              </p>
              <Link to="/case">
                Start from this activity <span>↗</span>
              </Link>
            </div>
          </article>
        ))}
      </div>
      <section className="strip">
        <h2>Real records and test fixtures stay distinct.</h2>
        <p>
          Non-Japan, daylight-saving and multi-currency examples are checked in only as synthetic
          portability fixtures. They are never presented as real inventory.
        </p>
      </section>
    </>
  );
}
