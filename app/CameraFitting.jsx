"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Check,
  ChevronDown,
  FlipHorizontal2,
  ImagePlus,
  Link2,
  LoaderCircle,
  ScanLine,
  SwitchCamera,
  Timer,
  Bookmark,
  Sparkles,
  PersonStanding,
  Video,
} from "lucide-react";
import { GarmentSizeControl } from "./GarmentSizeControl";
import { getGarmentSize } from "../lib/fitting/garment-size.js";
import { prepareImage } from "../lib/fitting/collections.js";
import { createLivePoseTracker } from "../lib/fitting/live-pose.js";
import {
  createLiveGarmentRenderer,
  prepareLiveGarment,
} from "../lib/fitting/live-garment.js";
import { createLiveMotion } from "../lib/fitting/live-motion.js";
import {
  drawLiveSkeleton,
  clearLiveSkeleton,
} from "../lib/fitting/live-skeleton.js";
import { Dialog } from "./studio-parts";
import "./camera-fitting.css";

const GUIDANCE = {
  warming: "Starting body tracking…",
  searching: "Step back until your head and feet are visible.",
  missing: "Face the camera with your head and feet in frame.",
  partial: "Step back a little so both feet are visible.",
  multiple: "One person at a time. Clear the space around you.",
  full: "Whole body in frame",
  unavailable:
    "Body tracking is unavailable. Try another browser or use a photo.",
};
const SAMPLE_VIDEO = "/camera/studio-motion.mp4";

function accessMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access is blocked. Allow camera access in your browser’s site settings, or open this page in Safari or Chrome.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "This camera could not be found. Try another camera or choose a photo.";
    case "NotReadableError":
      return "Another app may be using the camera. Close it and try again.";
    default:
      return (
        error?.message ||
        "The camera could not start. Try again or choose a photo."
      );
  }
}

function CameraGuide() {
  return (
    <svg
      className="cf-body-guide"
      width="174"
      height="286"
      viewBox="0 0 174 286"
      aria-hidden="true"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path
          className="cf-guide-center"
          d="M87 5v268M31 146h112"
          strokeDasharray="2 7"
        />
        <path
          className="cf-guide-figure"
          d="M87 13c-11 0-18 8-18 19 0 8 4 15 10 19l-1 7c-7 4-14 5-21 8-6 3-9 9-11 16L33 124l-11 23c-3 7-3 11 0 12 2 1 4-1 6-4l3-5c-1 3-1 6 1 6s5-5 6-10l10-19 12-31 2 25-2 20c-2 11-3 26-1 41l3 34-2 34-4 12c-3 3-5 5-5 8 3 3 14 2 20 0l3-10 4-44 4-29 5-28 5 28 4 29 4 44 3 10c6 2 17 3 20 0 0-3-2-5-5-8l-4-12-2-34 3-34c2-15 1-30-1-41l-2-20 2-25 12 31 10 19c1 5 4 10 6 10s2-3 1-6l3 5c2 3 4 5 6 4 3-1 3-5 0-12l-11-23-13-42c-2-7-5-13-11-16-7-3-14-4-21-8l-1-7c6-4 10-11 10-19 0-11-7-19-18-19Z"
        />
        <path
          className="cf-guide-bounds"
          d="M14 31V13h18m110 0h18v18M14 247v18h18m110 0h18v-18"
        />
      </g>
    </svg>
  );
}

function stopSession(session, video) {
  if (!session) return;
  session.abort.abort();
  window.clearTimeout(session.next);
  window.cancelAnimationFrame(session.raf);
  window.clearTimeout(session.saveExpiry);
  session.motion?.reset();
  if (session.skeleton) clearLiveSkeleton(session.skeleton);
  window.clearInterval(session.watch);
  session.tracker?.close();
  session.renderer?.dispose();
  session.stream?.getTracks().forEach((track) => track.stop());
  if (video) {
    video.pause();
    video.srcObject = null;
    if (session.demo) {
      video.removeAttribute("src");
      video.load();
    }
  }
}

function mirroredCopy(canvas) {
  const mirrored = document.createElement("canvas");
  mirrored.width = canvas.width;
  mirrored.height = canvas.height;
  const ctx = mirrored.getContext("2d");
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, 0, 0);
  return mirrored;
}

function photoFrame(video, mirrored = false) {
  if (video.readyState < 2 || !video.videoWidth)
    throw new Error("Wait until the camera picture appears.");
  const scale = Math.min(
    1,
    1920 / Math.max(video.videoWidth, video.videoHeight),
  );
  const photo = document.createElement("canvas");
  photo.width = Math.round(video.videoWidth * scale);
  photo.height = Math.round(video.videoHeight * scale);
  const ctx = photo.getContext("2d");
  if (!ctx) throw new Error("This browser could not capture the photo.");
  if (mirrored) {
    ctx.translate(photo.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, photo.width, photo.height);
  return photo;
}

export default function CameraFitting({
  garment,
  garmentOptions = [],
  onChooseGarment,
  onCapture,
  onSaveLook,
  onUsePhoto,
  onClose,
  onImport,
  onChangeCategory,
  sizeStep = 0,
  onSizeStepChange,
  onEditSizeChart,
  demoSrc,
}) {
  const { id, src, name, category, studio } = garment || {};
  const garmentImage = useMemo(
    () => ({ id, src, name, category, studio }),
    [id, src, name, category, studio],
  );
  const size = useMemo(() => getGarmentSize(garment, sizeStep), [garment, sizeStep]);
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const skeletonRef = useRef(null);
  const traceRef = useRef(false);
  const fileRef = useRef(null);
  const sessionRef = useRef(null);
  const preparedRef = useRef(null);
  const fullRef = useRef(false);
  const lastPoseRef = useRef(0);
  const staleAfterRef = useRef(550);
  const timerRef = useRef(null);
  const mounted = useRef(false);
  const [phase, setPhase] = useState("idle");
  const [tracking, setTracking] = useState("searching");
  const [upperInFrame, setUpperInFrame] = useState(false);
  const [needsHips, setNeedsHips] = useState(false);
  const [message, setMessage] = useState("");
  const [garmentCheck, setGarmentCheck] = useState(null);
  const [canSave, setCanSave] = useState(false);
  const [savingLook, setSavingLook] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const [facing, setFacing] = useState("user");
  const [mirror, setMirror] = useState(true);
  const [switchable, setSwitchable] = useState(true);
  const [demo, setDemo] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [sessionNumber, setSessionNumber] = useState(0);
  const [choosingPhoto, setChoosingPhoto] = useState(false);
  const active = phase === "live";
  const starting = phase === "starting";
  const garmentStatus =
    !active || !garment?.src
      ? ""
      : garmentCheck?.garment === garmentImage &&
          garmentCheck?.session === sessionNumber
        ? garmentCheck.message
        : "Preparing garment…";

  const cancelTimer = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (mounted.current) setCountdown(null);
  }, []);

  const stop = useCallback(
    (reason = "") => {
      const session = sessionRef.current;
      sessionRef.current = null;
      stopSession(session, videoRef.current);
      cancelTimer();
      fullRef.current = false;
      lastPoseRef.current = 0;
      staleAfterRef.current = 550;
      if (mounted.current) {
        setPhase("idle");
        setTracking("searching");
        setUpperInFrame(false);
        setCanSave(false);
        setSavingLook(false);
        setMessage(reason);
        setDemo(false);
      }
    },
    [cancelTimer],
  );

  useEffect(() => {
    mounted.current = true;
    const onHide = () => {
      if (sessionRef.current)
        stop("Camera fitting paused. Start it again when you’re ready.");
    };
    const visibility = () => {
      if (document.hidden) onHide();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", onHide);
    };
  }, [stop]);

  useEffect(() => {
    preparedRef.current = null;
    sessionRef.current?.renderer?.clear();
    if (!active || !garmentImage.src) return;
    let cancelled = false;
    const update = (message) =>
      setGarmentCheck({ garment: garmentImage, session: sessionNumber, message });
    prepareLiveGarment(garmentImage)
      .then((prepared) => {
        if (!cancelled) {
          preparedRef.current = prepared;
          update("");
        }
      })
      .catch((error) => {
        if (!cancelled)
          update(
            error?.message ||
              "Choose a clear garment-only product photo for the live fitting.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [active, garmentImage, sessionNumber]);

  const begin = async (
    requestedFacing,
    playDemo = false,
    switching = false,
  ) => {
    const previousDevice = sessionRef.current?.stream
      ?.getVideoTracks()[0]
      ?.getSettings?.().deviceId;
    stop();
    const video = videoRef.current;
    const session = { abort: new AbortController(), demo: playDemo };
    const valid = () =>
      sessionRef.current === session && !session.abort.signal.aborted;
    sessionRef.current = session;
    setPhase("starting");
    setSessionNumber((n) => n + 1);
    setDemo(playDemo);
    setTracking("warming");
    setNeedsHips(false);
    setMessage("");
    try {
      if (playDemo) {
        video.loop = true;
        video.src = playDemo === "waist" ? "/camera/waist-poses.mp4" : demoSrc || SAMPLE_VIDEO;
        setMirror(false);
      } else {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "Open the secure site in Safari or Chrome to use your camera, or choose a photo below.",
          );
        const constraints = {
          facingMode: { ideal: requestedFacing },
          width: { ideal: 1280 },
          height: { ideal: 960 },
          frameRate: { ideal: 24, max: 30 },
        };
        let otherDevice;
        if (switching && previousDevice) {
          const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
            (d) => d.kind === "videoinput",
          );
          if (!valid()) return;
          otherDevice = cams.find(
            (d) => d.deviceId && d.deviceId !== previousDevice,
          );
          if (cams.length === 2 && otherDevice)
            constraints.deviceId = { exact: otherDevice.deviceId };
          else constraints.facingMode = { exact: requestedFacing };
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: constraints,
        });
        if (!valid()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        session.stream = stream;
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("No camera picture is available.");
        track.addEventListener(
          "ended",
          () => {
            if (valid())
              stop("The camera disconnected. Reconnect it and try again.");
          },
          { once: true },
        );
        const actual = track.getSettings?.().facingMode || requestedFacing;
        setFacing(actual === "environment" ? "environment" : "user");
        setMirror(actual !== "environment");
        video.loop = false;
        video.srcObject = stream;
        navigator.mediaDevices
          .enumerateDevices?.()
          .then((devices) => {
            if (valid())
              setSwitchable(
                devices.filter((d) => d.kind === "videoinput").length > 1,
              );
          })
          .catch(() => {});
      }
      await video.play();
      if (!valid()) return;
      setPhase("live");
      setTracking("warming");
      const canvas = canvasRef.current;
      session.renderer = createLiveGarmentRenderer(canvas);
      const tracker = await createLivePoseTracker({
        signal: session.abort.signal,
      });
      if (!valid()) {
        tracker.close();
        return;
      }
      session.tracker = tracker;
      const motion = createLiveMotion();
      session.motion = motion;
      const skeleton = skeletonRef.current;
      session.skeleton = skeleton;
      let lastPoints, lastGarment, lastSize, lastTrace, lastSourceTime;
      let lastPaint = -Infinity;
      const paint = () => {
        if (!valid()) return;
        const now = performance.now();
        const points = motion.sample(now);
        const garment = preparedRef.current;
        const selectedSize = sizeRef.current;
        const refreshFrame = points && now - lastPaint >= 160 && video.currentTime !== lastSourceTime;
        const repaint = points !== lastPoints || garment !== lastGarment ||
          selectedSize !== lastSize || refreshFrame;
        if (repaint) {
          lastSourceTime = video.currentTime;
          lastPaint = now;
          const drawn =
            points && garment
              ? session.renderer.draw(garment, points, {
                  frame: video,
                  measured: true,
                  timestamp: now,
                  backend: tracker.backend,
                  sizeGrade: selectedSize.factors,
                })
              : false;
          if (!points || !garment) session.renderer.clear({ keepPose: Boolean(points) });
          setCanSave(Boolean(drawn));
        }
        if (traceRef.current !== lastTrace || repaint) {
          if (traceRef.current && points) drawLiveSkeleton(skeleton, points, session.renderer.getAnchors());
          else clearLiveSkeleton(skeleton);
        }
        lastPoints = points;
        lastGarment = garment;
        lastSize = selectedSize;
        lastTrace = traceRef.current;
        session.raf = window.requestAnimationFrame(paint);
      };
      session.raf = window.requestAnimationFrame(paint);
      let previousTime = -1;
      const fitFrame = async () => {
        if (!valid()) return;
        const started = performance.now();
        if (
          video.readyState >= 2 &&
          video.videoWidth > 0 &&
          video.currentTime !== previousTime
        ) {
          previousTime = video.currentTime;
          const scale = Math.min(
            1,
            900 / Math.max(video.videoWidth, video.videoHeight),
          );
          const w = Math.max(1, Math.round(video.videoWidth * scale));
          const h = Math.max(1, Math.round(video.videoHeight * scale));
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = skeleton.width = w;
            canvas.height = skeleton.height = h;
            motion.reset();
            lastPoints = undefined;
          }
          try {
            const request = session.saveRequest;
            // Acquire the requested camera frame in the same JS task as pose inference.
            // Only a shutter press copies a frame at the original camera resolution.
            const original = request
              ? photoFrame(video)
              : null;
            const stamp = performance.now();
            const pose = await tracker.detect(video, stamp);
            if (!valid()) return;
            const now = performance.now();
            const elapsed = now - stamp;
            const onCpu = tracker.backend !== "mediapipe";
            staleAfterRef.current = onCpu
              ? Math.min(2100, Math.max(650, (elapsed + 90) * 1.7))
              : 550;
            const fresh = elapsed < (onCpu ? 2200 : 650);
            const points = fresh ? pose?.points : null;
            fullRef.current = Boolean(points && pose.fullBody);
            setUpperInFrame(
              Boolean(
                points &&
                  [0, 11, 12].every((i) => {
                    const p = points[i];
                    return (
                      p &&
                      p.confidence >= 0.45 &&
                      p.x > 0.015 &&
                      p.x < 0.985 &&
                      p.y > 0.015 &&
                      p.y < 0.985
                    );
                  }),
              ),
            );
            lastPoseRef.current = points ? now : 0;
            setTracking(fresh ? pose?.status || "missing" : "searching");
            const waistProfile = session.renderer.measurePose(points, stamp);
            setNeedsHips(Boolean(points && !waistProfile));
            motion.push(points, stamp, now, staleAfterRef.current);
            if (request && request === session.saveRequest && original) {
              const product = preparedRef.current;
              const validFrame =
                product === request.product &&
                points &&
                (!request.fullOnly || fullRef.current);
              if (validFrame && session.renderer.draw(product, points, {
                frame: original,
                exact: true,
                waistProfile,
                timestamp: stamp,
                backend: tracker.backend,
                sizeGrade: request.size.factors,
              })) {
                session.saveRequest = null;
                window.clearTimeout(session.saveExpiry);
                const context = original.getContext("2d");
                context.drawImage(
                  canvas,
                  0,
                  0,
                  original.width,
                  original.height,
                );
                const savedFrame = request.mirrored ? mirroredCopy(original) : original;
                const image = savedFrame.toDataURL("image/jpeg", 0.94);
                request
                  .persist(image)
                  .then(() => {
                    if (valid()) setMessage("Look saved on this device.");
                  })
                  .catch((error) => {
                    if (valid())
                      setMessage(
                        error?.message ||
                          "Could not save this look on your device.",
                      );
                  })
                  .finally(() => {
                    if (valid()) setSavingLook(false);
                  });
                lastPoints = undefined;
              }
            }
          } catch {
            if (valid()) {
              fullRef.current = false;
              lastPoseRef.current = 0;
              motion.reset();
              session.renderer.clear();
              clearLiveSkeleton(skeleton);
              setCanSave(false);
              setTracking("unavailable");
              session.tracker?.close();
              session.tracker = null;
            }
            return;
          }
        }
        if (valid())
          session.next = window.setTimeout(
            fitFrame,
            Math.max(8, motion.interval() - (performance.now() - started)),
          );
      };
      session.watch = window.setInterval(() => {
        if (
          valid() &&
          lastPoseRef.current &&
          performance.now() - lastPoseRef.current > staleAfterRef.current
        ) {
          fullRef.current = false;
          lastPoseRef.current = 0;
          motion.reset();
          session.renderer.clear();
          clearLiveSkeleton(skeleton);
          setCanSave(false);
          setTracking("searching");
        }
      }, 160);
      void fitFrame();
    } catch (error) {
      if (!valid()) return;
      if ((session.stream || playDemo) && video.readyState >= 2) {
        setTracking("unavailable");
        setPhase("live");
      } else {
        stop(
          playDemo
            ? "The sample video could not open. Try your camera or choose a photo."
            : accessMessage(error),
        );
      }
    }
  };

  const save = (fullOnly = false) => {
    cancelTimer();
    const session = sessionRef.current;
    const product = preparedRef.current;
    if (!session || !product || !onSaveLook || session.saveRequest) return;
    setMessage("");
    setSavingLook(true);
    const selectedSize = sizeRef.current;
    session.saveRequest = {
      product,
      size: selectedSize,
      fullOnly,
      mirrored: mirror,
      persist: async (image) => onSaveLook(image, {
        sizeStep: selectedSize.step,
        sizeLabel: selectedSize.label,
        sizeMode: selectedSize.mode,
      }),
    };
    window.clearTimeout(session.saveExpiry);
    session.saveExpiry = window.setTimeout(() => {
      if (sessionRef.current === session && session.saveRequest) {
        session.saveRequest = null;
        setSavingLook(false);
        setMessage(
          "Hold still with the garment visible, then try saving again.",
        );
      }
    }, 4500);
  };

  const captureAIPhoto = () => {
    try {
      const photo = photoFrame(videoRef.current).toDataURL("image/jpeg", 0.94);
      stop();
      onCapture(photo);
    } catch (error) {
      cancelTimer();
      setMessage(error.message);
    }
  };
  const timerCapture = () => {
    if (timerRef.current) {
      cancelTimer();
      return;
    }
    const end = performance.now() + 5000;
    setCountdown(5);
    setMessage("");
    let stableSince = 0;
    const session = sessionRef.current;
    timerRef.current = window.setInterval(() => {
      if (sessionRef.current !== session) {
        cancelTimer();
        return;
      }
      const now = performance.now();
      if (now < end) {
        setCountdown(Math.ceil((end - now) / 1000));
        return;
      }
      setCountdown(0);
      if (
        fullRef.current &&
        now - lastPoseRef.current < staleAfterRef.current
      ) {
        if (!stableSince) stableSince = now;
        if (now - stableSince >= 450 && preparedRef.current) save(true);
      } else stableSince = 0;
      if (now > end + 20000) {
        cancelTimer();
        setMessage(
          "Your whole body was outside the frame. Step back and try the timer again.",
        );
      }
    }, 125);
  };
  const photoFallback = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setChoosingPhoto(true);
    try {
      const photo = await prepareImage(file);
      if (mounted.current) {
        stop();
        onUsePhoto?.(photo);
      }
    } catch (error) {
      if (mounted.current)
        setMessage(error.message || "This photo could not open.");
    } finally {
      if (mounted.current) setChoosingPhoto(false);
    }
  };
  const close = () => {
    stop();
    onClose();
  };
  const options =
    garment && !garmentOptions.some((g) => g.id === garment.id)
      ? [garment, ...garmentOptions]
      : garmentOptions;
  const choose = (id) => {
    preparedRef.current = null;
    sessionRef.current?.renderer?.clear();
    setCanSave(false);
    onChooseGarment?.(id);
  };
  const liveMessage =
    countdown === 0
      ? "Hold still with your full body in frame"
      : needsHips && garment?.category === "top" && ["partial", "full"].includes(tracking)
        ? "Face forward and step back until both hips are visible."
        : GUIDANCE[tracking];
  return (
    <Dialog title="Camera fitting" onClose={close} wide>
      <div className="cf-root">
        <div
          className={"cf-stage" + (active ? " cf-stage-live" : "")}
          data-phase={phase}
        >
          <div
            className="cf-stage-image"
            style={mirror ? { transform: "scaleX(-1)" } : undefined}
          >
            <video
              autoPlay
              muted
              playsInline
              ref={videoRef}
              aria-label={demo ? "Sample video" : "Your camera"}
            />
            <canvas
              ref={canvasRef}
              aria-hidden="true"
            />
            <canvas ref={skeletonRef} aria-hidden="true" />
          </div>
          <div className="cf-stage-tag">
            <Video size={14} />
            {demo === "waist"
              ? "Four sample poses"
              : demo
              ? "Animated studio model"
              : active
                ? "Live camera"
                : "Camera preview"}
          </div>
          {(active || starting) && (
            <button
              type="button"
              className="cf-stage-stop"
              onClick={() => stop()}
            >
              <CameraOff size={15} /> {starting ? "Cancel" : "Stop"}
            </button>
          )}
          {!active && (
            <div className="cf-idle">
              <CameraGuide />
              <div className="cf-idle-caption">
                <strong>Fit from head to toe</strong>
                <p>Stand back so the camera can see your whole body.</p>
                <button
                  type="button"
                  className="cf-start"
                  disabled={starting}
                  onClick={() => begin(facing)}
                >
                  {starting ? (
                    <LoaderCircle size={18} className="cf-spin" />
                  ) : (
                    <Camera size={18} />
                  )}{" "}
                  {starting ? "Starting…" : "Start camera"}
                </button>
                {!starting && (
                  <div className="cf-samples">
                    <button type="button" className="cf-demo" onClick={() => begin(facing, true)}>
                      Try sample video
                    </button>
                    <button type="button" className="cf-demo" onClick={() => begin(facing, "waist")}>
                      Test hands at waist
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          {active && (
            <>
              {countdown > 0 && (
                <div className="cf-count" aria-hidden="true">
                  {countdown}
                </div>
              )}
              <div className="cf-guidance" role="status">
                {tracking === "full" && countdown !== 0 ? (
                  <Check size={16} />
                ) : (
                  <ScanLine size={16} />
                )}{" "}
                {liveMessage}
              </div>
            </>
          )}
        </div>
        {message && (
          <p role="status" className="cf-message">
            {message}
          </p>
        )}
        <div className="cf-product">
          {garment?.src && <img src={garment.src} alt="" />}
          <label className="cf-pick">
            <span>Selected garment</span>
            <span className="cf-select-wrap">
              <select
                aria-label="Choose garment for camera fitting"
                value={garment?.id || ""}
                disabled={savingLook || countdown !== null}
                onChange={(e) => choose(e.target.value)}
              >
                {!garment && <option value="">Choose a garment</option>}
                {options.map((g) => (
                  <option value={g.id} key={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </span>
          </label>
          {onImport && (
            <button
              type="button"
              className="cf-add"
              onClick={() => {
                stop();
                onImport();
              }}
            >
              <Link2 size={16} /> Add garment
            </button>
          )}
        </div>
        {onChangeCategory && garment && !garment.studio && (
          <label className="cf-category">
            Garment type
            <select
              disabled={savingLook || countdown !== null}
              value={garment.category || "top"}
              onChange={(event) => onChangeCategory(event.target.value)}
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="dress">One-piece</option>
            </select>
          </label>
        )}
        <GarmentSizeControl
          garment={garment}
          sizeStep={sizeStep}
          onSizeStepChange={onSizeStepChange}
          onEditSizeChart={onEditSizeChart && (() => {
            stop();
            onEditSizeChart();
          })}
          disabled={savingLook || countdown !== null}
        />
        {active && garmentStatus && (
          <p role="status" className="cf-message">
            {garmentStatus}
          </p>
        )}
        {active && (
          <div className="cf-tools">
            <button
              type="button"
              className="cf-primary"
              onClick={() => save()}
              disabled={
                !onSaveLook ||
                !canSave ||
                savingLook ||
                countdown !== null ||
                !(
                  tracking === "full" ||
                  (tracking === "partial" &&
                    garment?.category === "top" &&
                    upperInFrame)
                )
              }
            >
              <Bookmark size={17} />
              {savingLook ? "Saving…" : "Save look"}
            </button>
            <button
              type="button"
              className="cf-tool"
              onClick={timerCapture}
              disabled={
                savingLook ||
                !onSaveLook ||
                !garment ||
                ["warming", "unavailable"].includes(tracking) ||
                Boolean(garmentStatus)
              }
            >
              <Timer size={17} />
              {countdown !== null ? "Cancel timer" : "Save in 5s"}
            </button>
            <button
              type="button"
              className="cf-tool"
              aria-pressed={showPoints}
              onClick={() => {
                traceRef.current = !traceRef.current;
                setShowPoints(traceRef.current);
                if (!traceRef.current && skeletonRef.current)
                  clearLiveSkeleton(skeletonRef.current);
              }}
            >
              <PersonStanding size={17} />
              {showPoints ? "Hide body points" : "Show body points"}
            </button>
            {!demo && switchable && (
              <button
                type="button"
                className="cf-tool"
                onClick={() =>
                  begin(facing === "user" ? "environment" : "user", false, true)
                }
              >
                <SwitchCamera size={17} /> Switch
              </button>
            )}
            <button
              type="button"
              className="cf-tool"
              aria-pressed={mirror}
              disabled={savingLook || countdown !== null}
              onClick={() => setMirror(!mirror)}
            >
              <FlipHorizontal2 size={17} /> Mirror
            </button>
          </div>
        )}
        {active && showPoints && canSave && garment?.category === "top" && (
          <p className="cf-fit-legend"><i aria-hidden="true" /> Shirt waist <i aria-hidden="true" /> Hem</p>
        )}
        <div className="cf-footer">
          <p>Live tracking and saved looks stay on your device.</p>
          {active && onCapture && garment && (
            <button
              type="button"
              className="cf-ai-photo"
              onClick={captureAIPhoto}
              disabled={savingLook || countdown !== null}
            >
              <Sparkles size={14} /> AI photo try-on
            </button>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={choosingPhoto || !garment || !onUsePhoto}
          >
            <ImagePlus size={15} /> {choosingPhoto ? "Opening…" : "Use a photo"}
          </button>
        </div>
        <input
          hidden
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={photoFallback}
        />
      </div>
    </Dialog>
  );
}
