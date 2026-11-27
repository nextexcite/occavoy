import { demoEvents } from "@occavoy/domain";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Discover });

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
        <h2>Where could it take you?</h2>
        <p>Three sample journeys. A worldwide starting point.</p>
      </section>
      <div className="cards">
        {demoEvents.map((event, index) => (
          <article className={`event-card palette-${index}`} key={event.id}>
            <div className="card-art" aria-hidden="true">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <i />
            </div>
            <div className="card-body">
              <span className="eyebrow">
                {event.destination.city} · {event.destination.countryCode}
              </span>
              <h3>{event.title}</h3>
              <p>
                Explore an experience, then assemble the practical details with a service partner.
              </p>
              <Link to="/case">
                Explore this sample <span>↗</span>
              </Link>
            </div>
          </article>
        ))}
      </div>
      <section className="strip">
        <h2>Your interests stay with you.</h2>
        <p>One place to keep the occasion, the brief, the options and what happens next.</p>
      </section>
    </>
  );
}
