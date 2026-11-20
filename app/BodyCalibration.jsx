"use client";

import { useRef, useState } from "react";
import "./extra-fit.css";

const STEPS = [
  {
    label: "Left-side shoulder",
    hint: "On the left of the photo, tap the joint where the upper arm meets the shoulder.",
    guess: [0.34, 0.28],
  },
  {
    label: "Right-side shoulder",
    hint: "On the right of the photo, tap the joint where the upper arm meets the shoulder.",
    guess: [0.66, 0.28],
  },
  {
    label: "First wrist",
    hint: "Follow the arm from marker 1. Tap the wrist crease, or skip if it is out of view.",
    guess: [0.28, 0.59],
    optional: true,
  },
  {
    label: "Second wrist",
    hint: "Follow the arm from marker 2. Tap the wrist crease, or skip if it is out of view.",
    guess: [0.72, 0.59],
    optional: true,
  },
  {
    label: "Waist center",
    hint: "Tap the middle of the waistband, or where a waistband would sit.",
    guess: [0.5, 0.54],
  },
];
const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const point = (x, y) => ({ x: clamp(x), y: clamp(y) });
const mid = (a, b) => point((a.x + b.x) / 2, (a.y + b.y) / 2);
const usable = (p) =>
  p &&
  Number.isFinite(p.x) &&
  Number.isFinite(p.y) &&
  p.x >= 0 &&
  p.x <= 1 &&
  p.y >= 0 &&
  p.y <= 1 &&
  (p.confidence ?? p.visibility ?? p.presence ?? 1) >= 0.55;
const record = (p, score) => ({
  ...p,
  z: p.z ?? 0,
  confidence: score,
  visibility: score,
  presence: score,
});
const distance = (a, b, ratio) => Math.hypot((a.x - b.x) * ratio, a.y - b.y);

function sideIndices(original) {
  if (
    usable(original?.[11]) &&
    usable(original?.[12]) &&
    original[11].x < original[12].x
  )
    return [11, 12];
  return [12, 11];
}

function initialMarks(original) {
  const indices = sideIndices(original);
  const get = (i) =>
    usable(original?.[i]) ? point(original[i].x, original[i].y) : null;
  const marks = [
    get(indices[0]),
    get(indices[1]),
    get(indices[0] + 4),
    get(indices[1] + 4),
    null,
  ];
  if (marks[0] && marks[1] && get(23) && get(24)) {
    const shoulders = mid(marks[0], marks[1]),
      hips = mid(get(23), get(24));
    marks[4] = point(
      shoulders.x + (hips.x - shoulders.x) / 1.18,
      shoulders.y + (hips.y - shoulders.y) / 1.18,
    );
  }
  return marks;
}

function elbowFor(shoulder, wrist, side, ratio, original, index) {
  const oldShoulder = original?.[index],
    oldElbow = original?.[index + 2],
    oldWrist = original?.[index + 4];
  // Reuse the detected bend in shoulder–wrist coordinates after the user moves either endpoint.
  let fraction = 0.52,
    bend = side * 0.035;
  if (usable(oldShoulder) && usable(oldElbow) && usable(oldWrist)) {
    const ax = (oldWrist.x - oldShoulder.x) * ratio,
      ay = oldWrist.y - oldShoulder.y;
    const bx = (oldElbow.x - oldShoulder.x) * ratio,
      by = oldElbow.y - oldShoulder.y;
    const norm = ax * ax + ay * ay;
    if (norm > 0.0025) {
      fraction = clamp((ax * bx + ay * by) / norm, 0.28, 0.74);
      bend = clamp((ay * bx - ax * by) / norm, -0.72, 0.72);
    }
  }
  const dx = (wrist.x - shoulder.x) * ratio,
    dy = wrist.y - shoulder.y;
  return point(
    shoulder.x + (fraction * dx + bend * dy) / ratio,
    shoulder.y + fraction * dy - bend * dx,
  );
}

export function buildCalibratedPose(marks, original, imageRatio = 1) {
  if (!marks[0] || !marks[1] || !marks[4]) return null;
  const left = marks[0],
    right = marks[1],
    waist = marks[4],
    shoulders = mid(left, right);
  const ratio = Math.max(0.05, imageRatio);
  const shoulderSpan = distance(left, right, ratio);
  const indices = sideIndices(original);
  const output = Array.from({ length: 33 }, (_, i) =>
    original?.[i] ? { ...original[i] } : record({ x: 0, y: 0 }, 0),
  );
  const hips = point(
    waist.x + (waist.x - shoulders.x) * 0.18,
    waist.y + (waist.y - shoulders.y) * 0.18,
  );
  let hipRatio = 0.7,
    hipTilt = Math.atan2(right.y - left.y, (right.x - left.x) * ratio) * 0.35;
  if ([11, 12, 23, 24].every((i) => usable(original?.[i]))) {
    const a = original[indices[0] + 12],
      b = original[indices[1] + 12];
    const originalSpan = distance(original[11], original[12], ratio);
    if (originalSpan > 0.025) {
      hipRatio = clamp(distance(a, b, ratio) / originalSpan, 0.5, 0.95);
      hipTilt = clamp(
        Math.atan2(b.y - a.y, Math.abs((b.x - a.x) * ratio)),
        -0.3,
        0.3,
      );
    }
  }
  indices.forEach((index, n) => {
    const side = n === 0 ? -1 : 1,
      shoulder = marks[n],
      wrist = marks[n + 2];
    output[index] = record(shoulder, 1);
    if (wrist) {
      output[index + 4] = record(wrist, 1);
      output[index + 2] = record(
        elbowFor(shoulder, wrist, side, ratio, original, index),
        0.75,
      );
    } else {
      output[index + 4] = record({ x: 0, y: 0 }, 0);
      output[index + 2] = record({ x: 0, y: 0 }, 0);
    }
    output[index + 12] = record(
      point(
        hips.x +
          (side * Math.cos(hipTilt) * shoulderSpan * hipRatio) / (2 * ratio),
        hips.y + (side * Math.sin(hipTilt) * shoulderSpan * hipRatio) / 2,
      ),
      0.85,
    );
  });
  return output;
}

function CalibrationEditor({ person, initialPoints, onApply, onCancel }) {
  const [state, setState] = useState(() => {
    const marks = initialMarks(initialPoints);
    const start = marks.findIndex((m) => !m);
    return { marks, step: start < 0 ? 5 : start };
  });
  const [active, setActive] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(null);
  const history = useRef([]),
    drag = useRef(null),
    photo = useRef(null);
  const { marks, step } = state,
    complete = step === STEPS.length;
  const editing = active !== null ? active : complete ? null : step;

  function remember(prior = state) {
    history.current = [...history.current.slice(-19), prior];
  }
  function coordinates(e) {
    const b = photo.current.getBoundingClientRect();
    return point(
      (e.clientX - b.left) / b.width,
      (e.clientY - b.top) / b.height,
    );
  }
  function validate(index, p) {
    if (index === 0 && marks[1] && p.x >= marks[1].x - 0.025)
      return "Place marker 1 to the left of marker 2.";
    if (index === 1 && marks[0] && p.x <= marks[0].x + 0.025)
      return "Place marker 2 to the right of marker 1.";
    if (
      index === 4 &&
      marks[0] &&
      marks[1] &&
      p.y <= mid(marks[0], marks[1]).y + 0.025
    )
      return "Place the waist below the shoulders.";
    return "";
  }
  function commit(index, p, prior = state, advance = true) {
    const issue = p && validate(index, p);
    if (issue) {
      setState(prior);
      setError(issue);
      return;
    }
    remember(prior);
    const next = [...prior.marks];
    next[index] = p;
    setState({
      marks: next,
      step: advance && index === prior.step ? prior.step + 1 : prior.step,
    });
    setCursor(null);
    setActive(null);
    setError("");
  }
  function restore(previous) {
    setState(previous);
    setCursor(null);
    setActive(null);
    setError("");
  }
  function startPointer(e, index, isHandle) {
    if (!ratio || index === null || drag.current || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    photo.current.focus({ preventScroll: true });
    const p = coordinates(e);
    drag.current = {
      index,
      id: e.pointerId,
      prior: state,
      isHandle,
      offsetX: isHandle ? marks[index].x - p.x : 0,
      offsetY: isHandle ? marks[index].y - p.y : 0,
    };
    photo.current.setPointerCapture(e.pointerId);
    setActive(index);
    setCursor(isHandle ? marks[index] : p);
    setError("");
  }
  function finishPointer(e) {
    if (drag.current?.id !== e.pointerId) return;
    const session = drag.current;
    drag.current = null;
    const raw = coordinates(e);
    const p = point(raw.x + session.offsetX, raw.y + session.offsetY);
    if (
      session.isHandle &&
      distance(p, session.prior.marks[session.index], ratio) < 0.001
    ) {
      setCursor(null);
      setActive(null);
      return;
    }
    commit(session.index, p, session.prior, !session.isHandle);
  }
  function keyAdjust(e, index, location, isHandle = false) {
    if (!ratio || index === null) return;
    if (isHandle && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const delta = e.shiftKey ? 0.025 : 0.005;
    const moves = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    if (moves[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      const [dx, dy] = moves[e.key],
        p = point(location.x + dx, location.y + dy);
      if (isHandle) {
        const issue = validate(index, p);
        if (issue) {
          setError(issue);
          return;
        }
        if (!e.repeat) remember();
        const next = [...marks];
        next[index] = p;
        setState({ ...state, marks: next });
        setError("");
      } else {
        setCursor(p);
        setActive(index);
      }
    } else if (!isHandle && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      commit(index, location);
    }
  }
  const fallback = editing === null ? null : point(...STEPS[editing].guess);
  const position =
    cursor ?? (editing === null ? null : marks[editing]) ?? fallback;
  return (
    <section className="body-cal">
      <div className="body-cal__status" aria-live="polite">
        <small>{complete ? "Review markers" : `Point ${step + 1} of 5`}</small>
        <h3>{complete ? "Check your alignment" : STEPS[step].label}</h3>
        <p>
          {complete
            ? "Drag any marker to refine it, then apply the fit."
            : STEPS[step].hint}
        </p>
      </div>
      <div className="body-cal__frame">
        <div
          ref={photo}
          className="body-cal__photo"
          role="group"
          tabIndex={0}
          aria-label="Alignment photo. Use the arrow keys to position a new point and Enter to place it. Tab to existing markers to adjust them."
          style={{ "--body-cal-ratio": ratio || 0.75 }}
          onPointerDown={(e) => startPointer(e, complete ? null : step, false)}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d?.id === e.pointerId) {
              const raw = coordinates(e);
              setCursor(point(raw.x + d.offsetX, raw.y + d.offsetY));
            }
          }}
          onPointerUp={finishPointer}
          onPointerCancel={() => {
            drag.current = null;
            setActive(null);
            setCursor(null);
          }}
          onKeyDown={(e) => keyAdjust(e, editing, position)}
        >
          <img
            src={person}
            alt="Your full photo for body alignment"
            draggable="false"
            onLoad={(e) => {
              setFailed(false);
              setRatio(
                e.currentTarget.naturalWidth / e.currentTarget.naturalHeight,
              );
            }}
            onError={() => {
              setFailed(true);
              setRatio(null);
            }}
          />
          {ratio &&
            marks.map(
              (m, i) =>
                m && (
                  <button
                    type="button"
                    key={i}
                    className={
                      "body-cal__marker" + (active === i ? " is-active" : "")
                    }
                    style={{
                      left: `${(active === i && cursor ? cursor.x : m.x) * 100}%`,
                      top: `${(active === i && cursor ? cursor.y : m.y) * 100}%`,
                    }}
                    onPointerDown={(e) => startPointer(e, i, true)}
                    onKeyDown={(e) => keyAdjust(e, i, m, true)}
                    aria-label={`Adjust marker ${i + 1}, ${STEPS[i].label}. Use the arrow keys.`}
                  >
                    <span>{i + 1}</span>
                  </button>
                ),
            )}
          {ratio && !complete && editing !== null && !marks[editing] && (
            <span
              aria-hidden="true"
              className={"body-cal__cursor" + (cursor ? " is-visible" : "")}
              style={{
                left: `${position.x * 100}%`,
                top: `${position.y * 100}%`,
              }}
            >
              +
            </span>
          )}
        </div>
      </div>
      {failed && (
        <p className="body-cal__error" role="alert">
          This photo could not be opened. Choose another photo in the fitting
          room.
        </p>
      )}
      {error && (
        <p className="body-cal__error" role="alert">
          {error}
        </p>
      )}
      <div className="body-cal__tools">
        <button
          type="button"
          disabled={!history.current.length}
          onClick={() => restore(history.current.pop())}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!marks.some(Boolean)}
          onClick={() => {
            remember();
            restore({ marks: Array(5).fill(null), step: 0 });
          }}
        >
          Start over
        </button>
        {!complete && STEPS[step].optional && (
          <button
            type="button"
            className="body-cal__skip"
            onClick={() => commit(step, null)}
          >
            Skip this wrist
          </button>
        )}
      </div>
      <div className="body-cal__actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!complete || failed || !ratio}
          onClick={() => {
            const span = distance(marks[0], marks[1], ratio);
            if (
              marks[1].x - marks[0].x < 0.025 ||
              marks[4].y - mid(marks[0], marks[1]).y < 0.4 * span
            ) {
              setError(
                "Space the two shoulder markers across the upper arms and place the waist at the waistband.",
              );
              return;
            }
            const result = buildCalibratedPose(marks, initialPoints, ratio);
            if (result) onApply(result);
          }}
        >
          Apply alignment
        </button>
      </div>
    </section>
  );
}
export default function BodyCalibration(props) {
  return <CalibrationEditor key={props.person} {...props} />;
}
