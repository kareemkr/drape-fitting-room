"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Images } from "lucide-react";
import { Dialog } from "./studio-parts";
import "./test-gallery.css";

import { PhotoComparison } from "./PhotoComparison";

const methods = [
  { id: "local", label: "On-device fit" },
  { id: "ai", label: "AI photo" },
];

function ResultSelector({ method, onChange }) {
  return (
    <div
      className="filters result-selector"
      role="group"
      aria-label="Result to display"
    >
      {methods.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={method === id ? "on" : ""}
          aria-pressed={method === id}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function FitTests({ onUse }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [method, setMethod] = useState("local");
  const [cohort, setCohort] = useState("All");
  const [chosen, setChosen] = useState(null);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const job = new AbortController();
    const read = async (path) => {
      const response = await fetch(path, { signal: job.signal });
      if (!response.ok) throw new Error("Test results unavailable");
      return response.json();
    };
    Promise.all([
      read("/fit-tests/index.json"),
      read("/fit-tests/local/index.json"),
    ])
      .then(([result, local]) => {
        const fits = new Map(local.map((fit) => [fit.id, fit]));
        const cases = result.cases.map((item) => {
          const fit = fits.get(item.id);
          if (!fit) throw new Error("Missing local sample");
          return {
            ...item,
            alignment: fit.alignment,
            localResult: "/fit-tests/local/" + fit.id + ".jpg",
          };
        });
        if (!job.signal.aborted) setData({ ...result, cases });
      })
      .catch(() => {
        if (!job.signal.aborted) setError(true);
      });
    return () => job.abort();
  }, [attempt]);
  if (error)
    return (
      <div className="empty">
        <p>The samples could not load.</p>
        <button
          className="secondary"
          onClick={() => {
            setError(false);
            setAttempt(attempt + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  if (!data)
    return (
      <p role="status" className="field-help">
        Loading fit tests…
      </p>
    );
  const local = method === "local";
  const entries = data.cases.filter(
    (item) =>
      (cohort === "All" || item.cohort === cohort) &&
      (local || !issuesOnly || item.review === "review"),
  );
  const current = entries.findIndex((entry) => entry.id === chosen);
  const sample = entries[current];
  const count = (group) =>
    data.cases.filter((entry) => entry.cohort === group).length;
  function selectMethod(next) {
    if (method === next) return;
    if (sample && next === "ai" && sample.review !== "review")
      setIssuesOnly(false);
    setMethod(next);
    setLimit(20);
  }
  const measured = data.cases.filter(
    (item) => item.alignment === "mesh",
  ).length;
  return (
    <section className="fit-tests">
      <div className="tests-overview">
        <Images size={23} />
        <div>
          <h2>{data.cases.length} virtual try-ons</h2>
          <p>
            {count("Men")} men’s cases and {count("Women")} women’s cases. Each
            pairs a synthetic person with a different garment.
          </p>
        </div>
      </div>
      <div className="result-picker">
        <span>Show results</span>
        <ResultSelector method={method} onChange={selectMethod} />
      </div>
      <details className="test-method">
        <summary>How the samples were tested</summary>
        {local ? (
          <>
            <p>
              The on-device photo renderer fitted each product image to the
              person’s pose. Shoulders and hips positioned the garment in{" "}
              {measured} cases. In {data.cases.length - measured}, the renderer
              estimated the waist from the shoulders because the hips were
              cropped or uncertain.
            </p>
            <p>
              Open a sample to inspect the original photo, garment and fit or
              switch to the AI photo for the same pair.
            </p>
          </>
        ) : (
          <>
            <p>
              A generative image editor created these AI photos from the same
              people and garments in batches of ten pairs. Review findings
              describe the AI photos.
            </p>
            {data.reviewSummary && <p>{data.reviewSummary}</p>}
            {data.benchmarkSummary && <p>{data.benchmarkSummary}</p>}
            <p>
              <a href="/downloads/Drape-100-AI-Tryon-Samples.zip" download>
                <Download size={15} /> Download all 100 sample sets
              </a>
            </p>
            <p>
              Four additional full-body checks cover trousers, a skirt, a
              jumpsuit and a dress. The dress comparison includes a fresh result
              from the live fitting room.
            </p>
            <p>
              <a
                href="/fit-tests/full-body-comparison.webp"
                target="_blank"
                rel="noreferrer"
              >
                See the four full-body checks
              </a>
            </p>
            <p>
              <a
                href="/fit-tests/dress-production-comparison.webp"
                target="_blank"
                rel="noreferrer"
              >
                Compare the two dress renders
              </a>
            </p>
            {data.report && (
              <a href={data.report} download>
                <Download size={15} /> Download the research benchmark
              </a>
            )}
          </>
        )}
      </details>
      <div className="test-toolbar">
        <div className="filters" aria-label="Filter tests">
          {["All", "Men", "Women"].map((g) => (
            <button
              key={g}
              className={g === cohort ? "on" : ""}
              aria-pressed={g === cohort}
              onClick={() => {
                setCohort(g);
                setLimit(20);
                setChosen(null);
              }}
            >
              {g}
            </button>
          ))}
        </div>
        {!local && (
          <label className="issue-filter">
            <input
              type="checkbox"
              checked={issuesOnly}
              onChange={(e) => {
                setIssuesOnly(e.target.checked);
                setLimit(20);
                setChosen(null);
              }}
            />{" "}
            Needs review
          </label>
        )}
        <span aria-live="polite">{entries.length} samples</span>
      </div>
      <div className="test-grid">
        {entries.slice(0, limit).map((sample) => (
          <button
            className="test-card"
            key={sample.id}
            onClick={() => setChosen(sample.id)}
            aria-label={"Inspect " + sample.id + ", " + sample.name}
          >
            <div className="test-image">
              <img
                src={local ? sample.localResult : sample.result}
                loading="lazy"
                alt=""
              />
              <img
                className="test-inset"
                src={sample.garment}
                alt=""
                loading="lazy"
              />
            </div>
            <small>
              {sample.id} · {sample.cohort}
            </small>
            <strong>{sample.name}</strong>
          </button>
        ))}
      </div>
      {entries.length > limit && (
        <div className="test-more">
          <button className="secondary" onClick={() => setLimit(limit + 20)}>
            Show more samples
          </button>
        </div>
      )}
      {sample && (
        <Dialog wide title={sample.name} onClose={() => setChosen(null)}>
          <ResultSelector method={method} onChange={selectMethod} />
          <PhotoComparison
            person={sample.person}
            garment={sample.garment}
            result={local ? sample.localResult : sample.result}
            resultLabel={local ? "On-device fit" : "AI photo"}
          />
          {local && (
            <p className="test-note">
              {sample.alignment === "estimated"
                ? "Estimated waist. The shoulders guided the fit because both hips could not be located reliably."
                : "Measured pose. The renderer placed the waist between the detected shoulders and hips."}
            </p>
          )}
          {!local && sample.note && (
            <p className="test-note">
              <strong>
                {sample.review === "review"
                  ? "Review finding. "
                  : "Visual check. "}
              </strong>
              {sample.note}
            </p>
          )}
          <button
            className="primary use-sample"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await onUse(sample);
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading
              ? "Opening fitting room…"
              : "Use this pair in the fitting room"}
          </button>
          <div className="test-pager">
            <button
              className="secondary"
              disabled={current <= 0}
              onClick={() => setChosen(entries[current - 1].id)}
            >
              <ChevronLeft size={16} /> Previous
            </button>
            <small>
              {sample.id} · {current + 1} of {entries.length}
            </small>
            <button
              className="secondary"
              disabled={current === entries.length - 1}
              onClick={() => setChosen(entries[current + 1].id)}
            >
              Next <ChevronRight size={16} />
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
