import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/case")({ component: CasePreview });

function CasePreview() {
  const [destination, setDestination] = useState("London");
  const [interests, setInterests] = useState(
    "An evening performance, a comfortable hotel and time to explore.",
  );
  const [submitted, setSubmitted] = useState(false);
  return (
    <section className="page-section">
      <p className="eyebrow">Your experience</p>
      <h1>
        A clear brief.
        <br />A considered next step.
      </h1>
      <div className="split">
        <form
          className="panel"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
          }}
        >
          <h2>Tell us what matters</h2>
          <label htmlFor="destination">Destination</label>
          <input
            id="destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            required
          />
          <label htmlFor="interests">What would make this trip worthwhile?</label>
          <textarea
            id="interests"
            rows={4}
            value={interests}
            onChange={(event) => setInterests(event.target.value)}
            required
          />
          <label htmlFor="travellers">Travellers</label>
          <select id="travellers">
            <option>2 adults</option>
            <option>1 adult</option>
            <option>Family or small group</option>
          </select>
          <button className="button" type="submit">
            Preview my request <span>→</span>
          </button>
          <p className="note">
            This form previews the flow locally. The request is not saved or sent.
          </p>
        </form>
        <aside className="panel timeline">
          <h2>Service progress</h2>
          <ol>
            <li className="complete">
              <span>01</span>
              <div>
                <h3>Find the occasion</h3>
                <p>An experience worth building a trip around.</p>
              </div>
            </li>
            <li className={submitted ? "complete" : ""}>
              <span>02</span>
              <div>
                <h3>Clarify your brief</h3>
                <p>
                  {submitted
                    ? `Sample request for ${destination}: ${interests}`
                    : "Dates, preferences, budget and the people travelling."}
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Review partner options</h3>
                <p>Check what is available, what it costs and when the quote expires.</p>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <h3>Confirm and stay informed</h3>
                <p>Approve a specific offer and follow the service through.</p>
              </div>
            </li>
          </ol>
          <p role="status" className="note">
            {submitted
              ? "Preview ready. This is not a submitted service request."
              : "No live case has been created."}
          </p>
        </aside>
      </div>
    </section>
  );
}
