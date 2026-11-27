import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/partners")({ component: PartnerPreview });

function PartnerPreview() {
  return (
    <section className="page-section">
      <p className="eyebrow">Partner desk</p>
      <h1>
        Serve the relationship.
        <br />
        <span>Make the details manageable.</span>
      </h1>
      <p className="lede">
        A shared service record for the customer, the referring partner and the people delivering
        the experience.
      </p>
      <div className="cards partner-cards">
        <article className="panel">
          <span className="eyebrow">Channel partner</span>
          <h2>Bring the customer context</h2>
          <p>
            Record the occasion, service expectations and the customer’s permission to share the
            brief.
          </p>
        </article>
        <article className="panel">
          <span className="eyebrow">Service operator</span>
          <h2>Keep the case moving</h2>
          <p>Request missing details, compare partner options and keep the customer informed.</p>
        </article>
        <article className="panel">
          <span className="eyebrow">Supply partner</span>
          <h2>Give a usable quote</h2>
          <p>Provide price, availability, validity and fulfilment terms in a consistent format.</p>
        </article>
      </div>
      <div className="strip">
        <div>
          <h2>Start with one well-served request.</h2>
          <p>
            The partner desk is an illustrative screen. Authentication and live partner workflows
            are scheduled in the first delivery milestones.
          </p>
        </div>
        <Link to="/case" className="button">
          View the service flow ↗
        </Link>
      </div>
    </section>
  );
}
