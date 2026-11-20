"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkPlus,
  BookOpen,
  Camera,
  Check,
  ChevronRight,
  Download,
  ImagePlus,
  Images,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Menu,
  PanelsTopLeft,
  Plus,
  Scan,
  ScanFace,
  Search,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { Brand, Dialog, FitForm, StudioMirror, Tile } from "./studio-parts";
import {
  baseModel,
  categoryLabels,
  initialFit,
  samples,
  studioModels,
} from "./catalog";
import {
  deleteGarment,
  deleteLook,
  fetchImageAsDataURL,
  listGarments,
  listLooks,
  prepareImage,
  putGarment,
  putLook,
} from "../lib/fitting/collections";
import BodyCalibration from "./BodyCalibration";
import { getCachedPose } from "../lib/fitting/pose";
import { getStudioPoints } from "./studio-models/data";
import { getAiCapability, generateStudioTryOn } from "../lib/fitting/studio-ai";
import FitTests from "./FitTests";
import { PhotoComparison } from "./PhotoComparison";
import CameraFitting from "./CameraFitting";
import GarmentSizeControl from "./GarmentSizeControl.jsx";
import SizeChartEditor from "./SizeChartEditor.jsx";
import { useGarmentSizing } from "./useGarmentSizing.js";

const pages = {
  room: { name: "Fitting room", icon: Scan },
  wardrobe: { name: "Wardrobe", icon: Shirt },
  looks: { name: "Saved looks", icon: Bookmark },
  tests: { name: "Fit tests", icon: Images },
};
const description = {
  room: "Try a garment from the web on your photo or in the live camera.",
  tests:
    "Inspect the person, the garment, and the generated result side by side.",
  wardrobe: "Your imported garments and the studio collection.",
  looks: "Your favorite fittings, saved on this device.",
};
function pageFromHash() {
  const key = window.location.hash.slice(1);
  return pages[key] ? key : "room";
}
function download(src, name) {
  const a = document.createElement("a");
  a.href = src;
  const type =
    src.match(/^data:image\/(webp|png|jpeg);/i)?.[1] ||
    src.match(/\.(webp|png)(?:[?#]|$)/i)?.[1];
  const extension =
    type && type.toLowerCase() !== "jpeg" ? type.toLowerCase() : "jpg";
  a.download =
    (name || "Drape look").replace(/[^a-z0-9 -]/gi, "").slice(0, 75) +
    "." +
    extension;
  a.click();
}
async function retainLook(source) {
  if (source.startsWith("data:image/")) return source;
  const response = await fetch(source, { credentials: "same-origin" });
  if (!response.ok) throw new Error("The source image could not be saved.");
  const blob = await response.blob();
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error("The image could not be saved on this device."));
    reader.readAsDataURL(blob);
  });
}
function inferCategory(name) {
  return /dress|jumpsuit|playsuit|overall/i.test(name)
    ? "dress"
    : /trouser|pants|skirt|jeans|shorts|leggings/i.test(name)
      ? "bottom"
      : "top";
}
function UploadArea({ label, hint, onPick, onDrop, compact = false }) {
  const [over, setOver] = useState(false);
  return (
    <button
      className={
        "upload-area " + (over ? "dragging " : "") + (compact ? "compact" : "")
      }
      onClick={onPick}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(e.dataTransfer.files?.[0]);
      }}
    >
      <span className="upload-round">
        <Upload size={17} />
      </span>
      <span>
        <b>{label}</b>
        <small>{hint}</small>
      </span>
    </button>
  );
}

export default function Studio() {
  const [page, setPage] = useState("room"),
    [mobile, setMobile] = useState(false),
    [person, setPerson] = useState(baseModel),
    [rawItem, setItem] = useState(samples.find((piece) => piece.id === "shirt")),
    [garments, setGarments] = useState([]),
    [looks, setLooks] = useState([]);
  const { item, size, selectSize, storeCustomChart, resetSelection } = useGarmentSizing(rawItem);
  const [chartReturn, setChartReturn] = useState("");
  const [original, setOriginal] = useState(false),
    [fit, setFit] = useState(initialFit),
    [calibration, setCalibration] = useState(null),
    [uploadedPhoto, setUploadedPhoto] = useState(null),
    [fitState, setFitState] = useState({
      alignment: "photo",
      pendingAlignment: false,
    }),
    [ready, setReady] = useState(false);
  const [tab, setTab] = useState("link"),
    [url, setUrl] = useState(""),
    [importing, setImporting] = useState(false),
    [linkError, setLinkError] = useState(""),
    [draft, setDraft] = useState(null);
  const [modal, setModal] = useState(""),
    [toast, setToast] = useState(""),
    [formError, setFormError] = useState(""),
    [saving, setSaving] = useState(false),
    [activeLook, setActiveLook] = useState(null),
    [deleteItem, setDeleteItem] = useState(null);
  const [loadingChoice, setLoadingChoice] = useState(false);
  const [returnToCamera, setReturnToCamera] = useState(false);
  const [cameraConfirmation, setCameraConfirmation] = useState(false);
  const [filter, setFilter] = useState("All pieces"),
    [query, setQuery] = useState(""),
    [aiResult, setAiResult] = useState(null),
    [photoType, setPhotoType] = useState("flat-lay"),
    [guideOverride, setUseGuide] = useState(null),
    [provider, setProvider] = useState(null),
    [aiStatus, setAiStatus] = useState(""),
    [aiError, setAiError] = useState(""),
    [snap, setSnap] = useState(""),
    [compare, setCompare] = useState(false),
    [lookName, setLookName] = useState("");
  const photoInput = useRef(null),
    garmentInput = useRef(null),
    canvas = useRef(null),
    smallCanvas = useRef(null),
    aiJob = useRef(null),
    importSequence = useRef(0),
    photoSequence = useRef(0),
    toastTimer = useRef(null);
  const modalRef = useRef(modal);
  useEffect(() => {
    modalRef.current = modal;
  }, [modal]);
  const useGuide = guideOverride ?? (size.step !== 0);
  const gradedFit = useMemo(() => ({ ...fit, sizeGrade: size.factors }), [fit, size.factors]);
  const selectedModel = studioModels.find((model) => model.src === person);
  const points = calibration || getStudioPoints(selectedModel?.key);
  const studioPair =
    selectedModel && item.hasStudioRender && item.category === "top"
      ? "/studio/ai/" +
        selectedModel.name.toLowerCase() +
        "-" +
        item.id +
        ".webp"
      : null;
  const isTrialSample =
    !!studioPair &&
    ((selectedModel.key === "male" && item.id === "shirt") ||
      (selectedModel.key === "female" && item.id === "knit"));
  const shownAi = useGuide ? null : aiResult || studioPair;
  const showingOriginal = original || (!useGuide && !shownAi);
  const resultLabel = aiResult
    ? "AI try-on"
    : isTrialSample
      ? "Saved AI try-on"
      : studioPair
        ? "Studio AI sample"
        : "AI try-on";
  useEffect(() => {
    if (modal !== "ai") return;
    const ctl = new AbortController();
    getAiCapability(ctl.signal)
      .then((result) => {
        if (!ctl.signal.aborted) setProvider(result);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setProvider({ configured: false });
      });
    return () => ctl.abort();
  }, [modal]);
  const notify = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4400);
  }, []);
  const updateSmallPreview = useCallback(() => {
    if (!canvas.current || !smallCanvas.current) return;
    const el = smallCanvas.current;
    const factor = Math.min(
      420 / canvas.current.width,
      540 / canvas.current.height,
      1,
    );
    el.width = Math.max(1, Math.round(canvas.current.width * factor));
    el.height = Math.max(1, Math.round(canvas.current.height * factor));
    el.getContext("2d").drawImage(canvas.current, 0, 0, el.width, el.height);
  }, []);
  const rendered = useCallback(
    (ok, result) => {
      setReady(ok);
      if (!ok || !result) return;
      setFitState({
        alignment: result.alignment,
        sleeveLength: result.sleeveLength,
        pendingAlignment: !!result.pendingAlignment,
      });
      updateSmallPreview();
      if (["preview", "save"].includes(modalRef.current) && canvas.current) {
        setSnap(
          showingOriginal
            ? person
            : shownAi || canvas.current.toDataURL("image/jpeg", 0.94),
        );
      }
    },
    [updateSmallPreview, showingOriginal, shownAi, person],
  );
  useEffect(() => {
    const sync = () => {
      importSequence.current++;
      setImporting(false);
      setLoadingChoice(false);
      aiJob.current?.abort();
      aiJob.current = null;
      setAiStatus("");
      setPage(pageFromHash());
      setMobile(false);
      setReturnToCamera(false);
      setModal(["", "#camera"].includes(window.location.hash) ? "camera" : "");
    };
    sync();
    window.addEventListener("hashchange", sync);
    let active = true;
    Promise.all([listGarments(), listLooks()])
      .then(([g, l]) => {
        if (active) {
          setGarments(g);
          setLooks(l);
        }
      })
      .catch((e) => {
        if (active) notify(e.message);
      });
    return () => {
      active = false;
      window.removeEventListener("hashchange", sync);
      aiJob.current?.abort();
      clearTimeout(toastTimer.current);
    };
  }, [notify]);
  useEffect(() => {
    if (modal === "adjust") updateSmallPreview();
  }, [modal, updateSmallPreview]);
  const nav = (key) => {
    if (page !== key) {
      window.location.assign("#" + key);
      setPage(key);
    }
    setMobile(false);
    setModal("");
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const resetAI = () => {
    aiJob.current?.abort();
    aiJob.current = null;
    setAiStatus("");
    setAiError("");
    setAiResult(null);
    setUseGuide(null);
  };
  const resetFitting = () => {
    resetAI();
    setFit({ ...initialFit });
    setOriginal(false);
    setReady(false);
  };
  const select = (item) => {
    setItem(item);
    resetFitting();
    if (page !== "room") nav("room");
  };
  const pickPerson = (src) => {
    if (src === person) return;
    photoSequence.current++;
    setPerson(src);
    setCalibration(null);
    resetFitting();
  };
  const openCamera = () => {
    setMobile(false);
    setFormError("");
    if (window.location.hash !== "#camera") window.location.assign("#camera");
    setModal("camera");
  };
  const leaveCamera = () => {
    if (["", "#camera"].includes(window.location.hash)) {
      window.history.replaceState(window.history.state, "", "#room");
    }
    setModal("");
  };
  const selectCameraPhoto = (src, generate = false) => {
    leaveCamera();
    photoSequence.current++;
    setPerson(src);
    setUploadedPhoto(src);
    setCalibration(null);
    resetFitting();
    setFormError("");
    if (generate) {
      setPhotoType("flat-lay");
      setCameraConfirmation(true);
      setProvider(null);
      setModal("ai");
    } else {
      setUseGuide(true);
      setModal("");
    }
  };
  const saveCameraLook = async (src, sizing) => {
    const saved = await putLook({ name: item.name + " · Camera fitting", src, sizing });
    setLooks((before) => [saved, ...before]);
  };
  const changePerson = async (file) => {
    if (!file) return;
    const seq = ++photoSequence.current;
    try {
      const src = await prepareImage(file);
      if (seq !== photoSequence.current) return;
      setPerson(src);
      setUploadedPhoto(src);
      setCalibration(null);
      resetFitting();
      notify("Your photo is ready.");
    } catch (e) {
      if (seq === photoSequence.current) notify(e.message);
    }
  };
  const switchTab = (value) => {
    importSequence.current++;
    setImporting(false);
    setTab(value);
    setLinkError("");
  };
  const openDraft = (data) => {
    setLoadingChoice(false);
    setFormError("");
    setDraft(data);
    setModal("garment");
  };
  const loadFile = async (file) => {
    if (!file) return;
    const seq = ++importSequence.current;
    setImporting(true);
    setLinkError("");
    try {
      const src = await prepareImage(file);
      if (seq !== importSequence.current) return;
      const name = (file.name || "My garment")
        .replace(/\.[^.]+$/, "")
        .replace(/[-_]+/g, " ");
      openDraft({
        src,
        name,
        brand: "Uploaded garment",
        category: inferCategory(name),
      });
    } catch (e) {
      if (seq === importSequence.current) setLinkError(e.message);
    } finally {
      if (seq === importSequence.current) setImporting(false);
    }
  };
  const importLink = async (e) => {
    e.preventDefault();
    setLinkError("");
    let address;
    try {
      const raw = url.trim();
      if (!raw) throw Error();
      address = new URL(raw.includes("://") ? raw : "https://" + raw);
      if (address.protocol !== "https:" || !address.hostname.includes("."))
        throw Error();
    } catch {
      setLinkError(
        "Enter a product page or image link, such as https://shop.com/product.",
      );
      return;
    }
    const seq = ++importSequence.current;
    setImporting(true);
    try {
      const response = await fetch(
        "/api/import?url=" + encodeURIComponent(address.href),
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.image)
        throw new Error(
          result.error ||
            "Could not read that shop. Upload its product photo instead.",
        );
      const options = result.images?.length ? result.images : [result.image];
      let src;
      let current;
      let imageError;
      for (const choice of options.slice(0, 3)) {
        if (seq !== importSequence.current) return;
        try {
          src = await fetchImageAsDataURL(choice);
          current = choice;
          break;
        } catch (e) {
          imageError = e;
        }
      }
      if (!src)
        throw (
          imageError || new Error("Upload a product photo to try this garment.")
        );
      if (seq !== importSequence.current) return;
      const changedPhoto = current !== options[0] && result.sizeChart;
      openDraft({
        name: result.name || "Imported garment",
        brand: result.brand || address.hostname,
        shopSizes: result.shopSizes,
        sizeChart: changedPhoto ? undefined : result.sizeChart,
        chartDraft: changedPhoto ? { ...result.sizeChart, reference: "" } : result.chartDraft,
        src,
        options,
        current,
        category: inferCategory(result.name || ""),
      });
    } catch (e) {
      if (seq === importSequence.current)
        setLinkError(e.message || "This product could not be imported.");
    } finally {
      if (seq === importSequence.current) setImporting(false);
    }
  };
  const choosePhoto = async (option) => {
    const seq = ++importSequence.current;
    setLoadingChoice(true);
    setFormError("");
    try {
      const src = await fetchImageAsDataURL(option);
      if (seq === importSequence.current)
        setDraft((old) => {
          if (!old) return old;
          const next = { ...old, src, current: option };
          if (old.sizeChart && old.current !== option) {
            next.chartDraft = { ...old.sizeChart, reference: "" };
            next.sizeChart = undefined;
          }
          return next;
        });
    } catch (e) {
      if (seq === importSequence.current) setFormError(e.message);
    } finally {
      if (seq === importSequence.current) setLoadingChoice(false);
    }
  };
  const addGarment = async (e) => {
    e.preventDefault();
    if (saving || !draft || loadingChoice) return;
    setSaving(true);
    setFormError("");
    try {
      const saved = await putGarment(draft);
      setGarments((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
      setUrl("");
      setModal("");
      select(saved);
      if (returnToCamera) {
        setReturnToCamera(false);
        openCamera();
      }
      notify("Garment added to your wardrobe.");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };
  function changeSize(step) {
    if (step !== size.step || showingOriginal || shownAi) setReady(false);
    selectSize(step);
    setOriginal(false);
    setUseGuide(true);
  }
  function openSizeChart() {
    setChartReturn(modal === "camera" ? "camera" : "");
    setFormError("");
    setModal("size-chart");
  }
  async function saveSizeChart(chart) {
    if (garments.some((piece) => piece.id === item.id)) {
      const saved = await putGarment({ ...item, sizeChart: chart, chartDraft: null });
      setGarments((old) => old.map((piece) => piece.id === saved.id ? saved : piece));
      setItem(saved);
      resetSelection();
    } else {
      storeCustomChart(chart);
    }
    setOriginal(false);
    setUseGuide(true);
    setModal(chartReturn);
  }
  const grab = () => {
    if (!ready || !canvas.current) return null;
    return showingOriginal
      ? person
      : shownAi || canvas.current.toDataURL("image/jpeg", 0.94);
  };
  const showPreview = () => {
    const src = grab();
    if (src) {
      setSnap(src);
      setCompare(false);
      setModal("preview");
    }
  };
  const openAI = () => {
    setCameraConfirmation(false);
    setFormError("");
    setAiError("");
    setPhotoType("flat-lay");
    setModal(aiJob.current ? "progress" : "ai");
  };
  const showLocalFit = () => {
    setOriginal(false);
    setUseGuide(true);
  };
  const startSave = () => {
    const src = grab();
    if (!src) return;
    setSnap(src);
    setLookName(showingOriginal ? "Original photo" : item.name);
    setFormError("");
    setModal("save");
  };
  const save = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const result = await putLook({
        name: lookName,
        src: await retainLook(snap),
        sizing: !showingOriginal && !shownAi
          ? { sizeStep: size.step, sizeLabel: size.label, sizeMode: size.mode } : undefined,
      });
      setLooks((prev) => [result, ...prev]);
      setModal("");
      notify("Look saved to Saved looks.");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };
  const ai = async () => {
    if (aiJob.current || !provider?.configured) return;
    const job = new AbortController();
    aiJob.current = job;
    setAiError("");
    setModal("progress");
    setAiStatus("Preparing your images…");
    try {
      const image = await generateStudioTryOn({
        providerId: provider.providerId,
        person,
        garment: item.src,
        category: item.category,
        garmentPhotoType: photoType,
        consent: true,
        signal: job.signal,
        onStatus: (v) => {
          if (aiJob.current === job) setAiStatus(v);
        },
      });
      if (aiJob.current !== job) return;
      setUseGuide(false);
      setAiResult(image);
      setOriginal(false);
      setModal("");
      notify("AI fitting is ready.");
    } catch (e) {
      if (aiJob.current === job && e.name !== "AbortError") {
        setAiError(e.message);
        setProvider(null);
        setModal("ai");
      }
    } finally {
      if (aiJob.current === job) {
        aiJob.current = null;
        setAiStatus("");
      }
    }
  };
  const close = () => {
    if (saving) return;
    if (modal === "garment") {
      importSequence.current++;
      setLoadingChoice(false);
    }
    if (modal === "progress") {
      aiJob.current?.abort();
      aiJob.current = null;
      setAiStatus("");
      notify("Stopped waiting for this render.");
    }
    setFormError("");
    setModal("");
  };
  const openTestPair = async (sample) => {
    try {
      const [personSrc, productSrc] = await Promise.all([
        fetchImageAsDataURL(sample.person),
        fetchImageAsDataURL(sample.garment),
      ]);
      photoSequence.current++;
      setPerson(personSrc);
      setUploadedPhoto(personSrc);
      setCalibration(null);
      setItem({
        id: "test-" + sample.id,
        name: sample.name,
        src: productSrc,
        category: sample.category || "top",
        brand: "Fit tests",
      });
      resetFitting();
      nav("room");
      notify(
        "Sample pair loaded. Try it on this device or choose Generate AI photo.",
      );
    } catch (error) {
      notify(error.message || "The photos could not load.");
    }
  };
  const askRemove = (type, obj) => {
    setDeleteItem({ type, obj });
    setFormError("");
    setModal("delete");
  };
  const remove = async () => {
    setSaving(true);
    try {
      if (deleteItem.type === "look") {
        await deleteLook(deleteItem.obj.id);
        setLooks((prev) => prev.filter((l) => l.id !== deleteItem.obj.id));
      } else {
        await deleteGarment(deleteItem.obj.id);
        setGarments((prev) => prev.filter((p) => p.id !== deleteItem.obj.id));
        if (item.id === deleteItem.obj.id) {
          setItem(samples[0]);
          resetFitting();
        }
      }
      setModal("");
      notify("Removed from this device.");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };
  const newGarment = () => {
    nav("room");
    setTimeout(() => {
      const node = document.getElementById("garment-source");
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.getElementById("product-link")?.focus({ preventScroll: true });
    }, 80);
  };
  const importForCamera = () => {
    leaveCamera();
    setReturnToCamera(true);
    switchTab("link");
    newGarment();
  };
  const selectedCategory = (v) => {
    setItem({ ...item, category: v });
    setAiResult(null);
  };
  const visibleWardrobe = [...garments, ...samples].filter(
    (p) =>
      (filter === "All pieces" ||
        (filter === "My imports" ? !p.studio : !!p.studio)) &&
      p.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const cameraWardrobe = useMemo(() => {
    const options = [...garments, ...samples];
    return options.some((piece) => piece.id === item.id)
      ? options
      : [item, ...options];
  }, [garments, item]);
  return (
    <div className="shell">
      {mobile && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        className={"sidebar " + (mobile ? "open" : "")}
        aria-label="Workspace navigation"
      >
        <a
          className="brand-link"
          href="#room"
          aria-label="Drape fitting room"
          onClick={() => nav("room")}
        >
          <Brand />
        </a>
        <div className="nav-section">
          <div className="nav-label">Workspace</div>
          <nav>
            {Object.entries(pages).map(([id, p]) => (
              <a
                key={id}
                href={"#" + id}
                aria-label={p.name}
                title={p.name}
                onClick={() => nav(id)}
                aria-current={page === id ? "page" : undefined}
                className={page === id ? "active" : ""}
              >
                <p.icon size={19} />
                <span>{p.name}</span>
                {id === "looks" && looks.length > 0 && (
                  <small>{looks.length}</small>
                )}
              </a>
            ))}
          </nav>
        </div>
        <div className="sidebar-bottom">
          <button
            onClick={() => {
              setMobile(false);
              setModal("guide");
            }}
          >
            <BookOpen size={17} />
            Studio guide
          </button>
          <div className="bottom-identity">
            <span className="workspace-icon">
              <UserRound size={17} />
            </span>
            <div>
              <strong>Personal workspace</strong>
              <small>Saved on this device</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            className="mobile-menu icon-btn"
            onClick={() => setMobile(true)}
            aria-label="Open navigation"
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            <PanelsTopLeft size={16} />
            <span>Studio</span>
            <span className="slash">/</span>
            <b>{pages[page].name}</b>
          </div>
          <button className="privacy" onClick={() => setModal("privacy")}>
            <LockKeyhole size={13} /> Private workspace
          </button>
          <span className="avatar" aria-hidden="true">
            D
          </span>
        </header>
        <main className="page">
          <div
            className={
              "page-heading" + (page === "room" ? " fitting-heading" : "")
            }
          >
            <div>
              <h1>{pages[page].name}</h1>
              <p>{description[page]}</p>
            </div>
            {page === "room" ? (
              <div className="fitting-actions">
                <button
                  type="button"
                  className="primary launch-camera"
                  onClick={openCamera}
                >
                  <Camera size={17} aria-hidden="true" /> Live camera
                </button>
                <button
                  className="secondary save-look"
                  onClick={startSave}
                  disabled={!ready}
                >
                  <BookmarkPlus size={16} />
                  Save look
                </button>
              </div>
            ) : page === "wardrobe" ? (
              <button className="primary" onClick={newGarment}>
                <Plus size={17} />
                Add garment
              </button>
            ) : null}
          </div>
          {page === "room" && (
            <>
              <div className="studio-layout">
                <StudioMirror
                  person={person}
                  item={item}
                  original={showingOriginal}
                  setOriginal={(next) => {
                    if (!next && !shownAi && !useGuide) showLocalFit();
                    else setOriginal(next);
                  }}
                  fit={gradedFit}
                  sizingControls={
                    <GarmentSizeControl key={item.id} garment={item} sizeStep={size.step}
                      onSizeStepChange={changeSize} onEditSizeChart={openSizeChart} />
                  }
                  aiResult={shownAi}
                  aiLabel={resultLabel}
                  guide={useGuide}
                  landmarks={points}
                  modelName={selectedModel?.name}
                  calibrated={!!calibration}
                  canvasRef={canvas}
                  onReady={rendered}
                  onError={notify}
                  onExpand={showPreview}
                  onAdjust={() => {
                    setOriginal(false);
                    setUseGuide(true);
                    setModal("adjust");
                  }}
                />
                <section className="config">
                  <div className="config-title">
                    <SlidersHorizontal size={18} />
                    <h2>Fitting setup</h2>
                  </div>
                  <div className="model-section">
                    <div className="field-heading">
                      <h3>Your model</h3>
                      {uploadedPhoto && (
                        <button
                          className="text-link"
                          onClick={() => photoInput.current?.click()}
                        >
                          Replace photo
                        </button>
                      )}
                    </div>
                    <div className="model-choices" aria-label="Choose a model">
                      {studioModels.map((model) => (
                        <button
                          type="button"
                          key={model.key}
                          className={
                            "model-choice " +
                            (person === model.src ? "selected" : "")
                          }
                          aria-label={"Use " + model.name + " studio model"}
                          aria-pressed={person === model.src}
                          onClick={() => pickPerson(model.src)}
                        >
                          <span className={"model-avatar " + model.key}>
                            <img src={model.src} alt="" />
                          </span>
                          <span>{model.name}</span>
                        </button>
                      ))}
                      <button
                        type="button"
                        className={
                          "model-choice personal " +
                          (uploadedPhoto && person === uploadedPhoto
                            ? "selected"
                            : "")
                        }
                        aria-label={
                          uploadedPhoto
                            ? "Use your uploaded photo"
                            : "Upload your photo"
                        }
                        aria-pressed={
                          !!uploadedPhoto && person === uploadedPhoto
                        }
                        onClick={() =>
                          uploadedPhoto
                            ? pickPerson(uploadedPhoto)
                            : photoInput.current?.click()
                        }
                      >
                        {uploadedPhoto ? (
                          <span className="model-avatar">
                            <img src={uploadedPhoto} alt="" />
                          </span>
                        ) : (
                          <Upload size={15} />
                        )}
                        <span>Your photo</span>
                      </button>
                    </div>
                    {!selectedModel &&
                      !fitState.pendingAlignment &&
                      fitState.alignment === "manual" &&
                      useGuide &&
                      !original && (
                        <button
                          type="button"
                          className="mark-points-shortcut"
                          onClick={() => setModal("align")}
                        >
                          Mark body points for a closer fit
                        </button>
                      )}
                  </div>
                  <div className="garment-source" id="garment-source">
                    <div className="field-heading">
                      <h3>Add a garment</h3>
                      {returnToCamera && (
                        <button className="text-link" onClick={openCamera}>
                          Back to camera
                        </button>
                      )}
                    </div>
                    <div className="source-tabs" aria-label="Garment source">
                      <button
                        className={tab === "link" ? "on" : ""}
                        aria-pressed={tab === "link"}
                        onClick={() => switchTab("link")}
                      >
                        <Link2 size={15} />
                        Product link
                      </button>
                      <button
                        className={tab === "upload" ? "on" : ""}
                        aria-pressed={tab === "upload"}
                        onClick={() => switchTab("upload")}
                      >
                        <ImagePlus size={15} />
                        Upload image
                      </button>
                    </div>
                    {tab === "link" ? (
                      <form onSubmit={importLink}>
                        <div className="url-field">
                          <Link2 size={15} />
                          <input
                            id="product-link"
                            type="text"
                            inputMode="url"
                            autoCapitalize="none"
                            spellCheck="false"
                            aria-label="Product link"
                            placeholder="Paste a product URL"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                          />
                          <button
                            aria-label="Import product link"
                            title="Import product link"
                            disabled={importing}
                            className="url-add"
                          >
                            {importing ? (
                              <LoaderCircle className="spin" size={15} />
                            ) : (
                              <Plus size={17} />
                            )}
                          </button>
                        </div>
                        <p className="field-help">
                          Use a product page or a direct image link.
                        </p>
                      </form>
                    ) : (
                      <UploadArea
                        label={
                          importing
                            ? "Reading image…"
                            : "Choose a product image"
                        }
                        hint="JPG, PNG or WebP · up to 10 MB"
                        onPick={() => garmentInput.current?.click()}
                        onDrop={loadFile}
                        compact
                      />
                    )}
                    {linkError && (
                      <div role="alert" className="inline-error">
                        {linkError}
                        {tab === "link" && (
                          <button onClick={() => switchTab("upload")}>
                            Upload product photo
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="current-item">
                    <img src={item.src} alt="" />
                    <div>
                      <small>Selected garment</small>
                      <strong>{item.name}</strong>
                    </div>
                    <span className="selected-circle">
                      <Check size={13} />
                    </span>
                  </div>
                  <button
                    className="generate"
                    disabled={!ready}
                    onClick={
                      useGuide && !original
                        ? () => setModal("adjust")
                        : showLocalFit
                    }
                  >
                    <SlidersHorizontal size={17} />
                    {useGuide && !original
                      ? "Adjust local fit"
                      : "Try on this device"}
                  </button>
                  <button
                    type="button"
                    className="text-link return-render"
                    onClick={openAI}
                  >
                    <Sparkles size={15} /> Generate AI photo
                  </button>
                  {useGuide && (aiResult || studioPair) && (
                    <button
                      className="text-link return-render"
                      onClick={() => {
                        setUseGuide(false);
                        setOriginal(false);
                      }}
                    >
                      Show previous AI result
                    </button>
                  )}
                  {studioPair && !aiResult && !useGuide && (
                    <p className="ai-sample-note">
                      {isTrialSample
                        ? "Previously rendered by WeShopAI from this exact photo and garment."
                        : "This studio pairing was rendered in advance with an image-editing model."}
                    </p>
                  )}
                </section>
              </div>
              <section className="rack">
                <div className="section-line">
                  <div>
                    <span className="section-icon">
                      <Shirt size={18} />
                    </span>
                    <h2>Studio wardrobe</h2>
                  </div>
                  <button className="view-link" onClick={() => nav("wardrobe")}>
                    View wardrobe <ChevronRight size={14} />
                  </button>
                </div>
                <div className="tiles">
                  {samples.map((p) => (
                    <Tile
                      key={p.id}
                      item={p}
                      selected={p.id === item.id}
                      onSelect={select}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
          {page === "wardrobe" && (
            <>
              <div className="collection-tools">
                <div className="filters">
                  {["All pieces", "My imports", "Studio collection"].map(
                    (f) => (
                      <button
                        key={f}
                        aria-pressed={f === filter}
                        className={f === filter ? "on" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                      </button>
                    ),
                  )}
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    placeholder="Search garments"
                    aria-label="Search garments"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              {visibleWardrobe.length ? (
                <div className="tiles collection-grid">
                  {visibleWardrobe.map((p) => (
                    <Tile
                      key={p.id}
                      item={p}
                      selected={p.id === item.id}
                      onSelect={select}
                      onRemove={
                        !p.studio ? () => askRemove("garment", p) : null
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <Shirt />
                  <h2>
                    {query
                      ? "No matching garments"
                      : "Your imports will appear here"}
                  </h2>
                  <p>
                    {query
                      ? "Try another search or collection."
                      : "Add a product link or upload a garment photo to start."}
                  </p>
                  <button
                    className="secondary"
                    onClick={
                      query
                        ? () => {
                            setQuery("");
                            setFilter("All pieces");
                          }
                        : newGarment
                    }
                  >
                    {query ? "Clear filters" : "Add a garment"}
                  </button>
                </div>
              )}
            </>
          )}
          {page === "tests" && <FitTests onUse={openTestPair} />}
          {page === "looks" &&
            (looks.length ? (
              <div className="tiles look-grid">
                {looks.map((l) => (
                  <article key={l.id} className="look-card">
                    <button
                      onClick={() => {
                        setActiveLook(l);
                        setModal("look");
                      }}
                    >
                      <img src={l.src} alt={l.name} />
                      <div>
                        <strong>{l.name}</strong>
                        <small>
                          {l.sizing ? l.sizing.sizeLabel + " · " : ""}
                          {new Date(l.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </small>
                      </div>
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                <Bookmark size={28} />
                <h2>Save your first look</h2>
                <p>
                  Choose a piece in the fitting room, then select Save look.
                </p>
                <button className="primary" onClick={() => nav("room")}>
                  Open fitting room
                </button>
              </div>
            ))}
        </main>
      </div>
      <input
        ref={photoInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          changePerson(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={garmentInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          loadFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {modal === "size-chart" && (
        <Dialog title="Garment size chart" onClose={() => setModal(chartReturn)} wide>
          <SizeChartEditor key={item.id} item={item} onSave={saveSizeChart} onCancel={() => setModal(chartReturn)} />
        </Dialog>
      )}
      {modal === "camera" && (
        <CameraFitting
          garment={item}
          garmentOptions={cameraWardrobe}
          sizeStep={size.step}
          onSizeStepChange={changeSize}
          onEditSizeChart={openSizeChart}
          onChooseGarment={(id) => {
            const next = cameraWardrobe.find((piece) => piece.id === id);
            if (next && next.id !== item.id) select(next);
          }}
          onChangeCategory={selectedCategory}
          onImport={importForCamera}
          onSaveLook={saveCameraLook}
          onCapture={(src) => selectCameraPhoto(src, true)}
          onUsePhoto={(src) => selectCameraPhoto(src)}
          onClose={leaveCamera}
        />
      )}
      {modal === "guide" && (
        <Dialog title="Studio guide" onClose={close}>
          <div className="guide-rows">
            <div>
              <ScanFace />
              <section>
                <h3>Choose your model</h3>
                <p>
                  Use the studio model or upload a front-facing photo with your
                  arms relaxed. Include your legs for trousers and dresses.
                </p>
              </section>
            </div>
            <div>
              <Shirt />
              <section>
                <h3>Bring a garment</h3>
                <p>
                  Paste a shop’s product link, upload its photo, or choose a
                  studio piece. A clear front view against a plain background
                  helps preserve the product details.
                </p>
              </section>
            </div>
            <div>
              <SlidersHorizontal />
              <section>
                <h3>Try it on</h3>
                <p>
                  Studio pairs have ready-made AI renders. For your own pair,
                  choose Try on this device for a pose-aligned preview. Generate
                  AI photo opens the optional image renderer.
                </p>
              </section>
            </div>
            <div>
              <Camera />
              <section>
                <h3>Use the live camera</h3>
                <p>
                  Start the camera, choose a piece, and step back until your
                  head and feet are visible. Turn on body points to see what the
                  garment follows. Save the live fitting directly to Saved looks
                  on this device.
                </p>
                <p><a className="local-kit-link" href="/camera/size-comparison.jpg" target="_blank" rel="noreferrer">Compare the same garment across three sizes</a></p>
                <p><a className="local-kit-link" href="/downloads/Drape-100-Size-Comparisons.zip" download>Download all 100 photo size comparisons</a></p>
                <a className="local-kit-link" href="/camera/waist-fit-comparison.jpg" target="_blank" rel="noreferrer">Compare shirt fit with hands at the waist</a>
              </section>
            </div>
            <div>
              <Download />
              <section>
                <h3>Run the model on your computer</h3>
                <p>
                  The local studio runs the open-weight FASHN model on your own
                  hardware. A compatible GPU is recommended.
                </p>
                <a
                  className="local-kit-link"
                  href="/downloads/Drape-Local-AI-Studio.zip"
                  download
                >
                  Download local AI studio
                </a>
              </section>
            </div>
            <div>
              <Bookmark />
              <section>
                <h3>Keep the look</h3>
                <p>
                  Save a look to this browser, then open it in Saved looks to
                  download a copy.
                </p>
              </section>
            </div>
          </div>
        </Dialog>
      )}
      {modal === "privacy" && (
        <Dialog title="Your workspace" onClose={close}>
          <p className="dialog-copy">
            Your live camera and body tracking run in this browser. Imported
            garments and saved looks stay on this device. Clearing browser data
            removes them.
          </p>
          <p className="dialog-copy">
            Product links are sent to the importer to fetch the shop’s image. AI
            fittings send your model and garment photos to the renderer named in
            the confirmation screen when you select Send and generate.
          </p>
          <button className="primary full" onClick={close}>
            Got it
          </button>
        </Dialog>
      )}
      {modal === "garment" && draft && (
        <Dialog title="Add to wardrobe" onClose={close}>
          <form onSubmit={addGarment}>
            <img
              className="draft-photo"
              src={draft.src}
              alt="Imported garment"
            />
            {draft.options?.length > 1 && (
              <div className="image-choices">
                <small>Choose a product photo</small>
                <div>
                  {draft.options.map((option, i) => (
                    <button
                      type="button"
                      key={option}
                      aria-label={"Use product photo " + (i + 1)}
                      aria-pressed={draft.current === option}
                      className={draft.current === option ? "active" : ""}
                      onClick={() => choosePhoto(option)}
                    >
                      <img src={option} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label className="field-label">
              Garment name
              <input
                required
                maxLength={90}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="field-label">
              Garment type
              <select
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value })
                }
              >
                {Object.entries(categoryLabels).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            <button className="primary full" disabled={saving || loadingChoice}>
              {loadingChoice
                ? "Loading photo…"
                : saving
                  ? "Adding…"
                  : "Add and try on"}
            </button>
          </form>
        </Dialog>
      )}
      {modal === "align" && (
        <Dialog
          title="Align your photo"
          onClose={() => setModal("adjust")}
          wide
        >
          <BodyCalibration
            key={person}
            person={person}
            initialPoints={points || getCachedPose(person)}
            onCancel={() => setModal("adjust")}
            onApply={(p) => {
              setCalibration(p);
              setFit({ ...initialFit });
              setOriginal(false);
              setAiResult(null);
              setModal("adjust");
            }}
          />
        </Dialog>
      )}
      {modal === "adjust" && (
        <Dialog title="Adjust fit" onClose={close} wide>
          <div className="adjust-layout">
            <canvas
              ref={smallCanvas}
              width="320"
              height="400"
              aria-label="Live fit adjustment preview"
            />
            <div>
              <FitForm
                item={item}
                changeCategory={selectedCategory}
                fit={fit}
                onChange={setFit}
                onAlign={() => setModal("align")}
                refined={["mesh", "estimated"].includes(fitState.alignment)}
                sleeved={fitState.sleeveLength !== "sleeveless"}
                customized={!!calibration}
                onAuto={
                  calibration
                    ? () => {
                        setCalibration(null);
                        setFit({ ...initialFit });
                      }
                    : null
                }
                onClose={close}
              />
            </div>
          </div>
        </Dialog>
      )}
      {modal === "preview" && (
        <Dialog title={item.name} onClose={close} wide={!!compare}>
          {shownAi && !showingOriginal && (
            <div className="filters comparison-toggle" aria-label="Image view">
              <button
                className={!compare ? "on" : ""}
                aria-pressed={!compare}
                onClick={() => setCompare(false)}
              >
                Result
              </button>
              <button
                className={compare ? "on" : ""}
                aria-pressed={compare}
                onClick={() => setCompare(true)}
              >
                Compare inputs
              </button>
            </div>
          )}
          {compare ? (
            <PhotoComparison person={person} garment={item.src} result={snap} />
          ) : (
            <img
              className="dialog-image"
              src={snap}
              alt={"Preview of " + item.name}
            />
          )}
          <button
            className="secondary full"
            onClick={() => download(snap, item.name)}
          >
            <Download size={16} />
            Download image
          </button>
        </Dialog>
      )}
      {modal === "save" && (
        <Dialog title="Save this look" onClose={close}>
          <form onSubmit={save}>
            <div className="save-preview">
              <img src={snap} alt="Look to save" />
              <span>
                {showingOriginal
                  ? "Original photo"
                  : shownAi
                    ? resultLabel
                    : "Instant fitting"}
              </span>
            </div>
            <label className="field-label">
              Look name
              <input
                maxLength={90}
                required
                value={lookName}
                onChange={(e) => setLookName(e.target.value)}
              />
            </label>
            {formError && (
              <p role="alert" className="inline-error">
                {formError}
              </p>
            )}
            <button className="primary full" disabled={saving}>
              <BookmarkPlus size={16} />
              {saving ? "Saving…" : "Save look"}
            </button>
          </form>
        </Dialog>
      )}
      {modal === "look" && activeLook && (
        <Dialog title={activeLook.name} onClose={close}>
          <img
            className="dialog-image"
            src={activeLook.src}
            alt={activeLook.name}
          />
          {activeLook.sizing && (
            <p className="field-help">{activeLook.sizing.sizeMode === "chart" ? "Chart size" : "Preview size"} · {activeLook.sizing.sizeLabel}</p>
          )}
          <div className="dialog-actions">
            <button
              className="secondary"
              onClick={() => askRemove("look", activeLook)}
            >
              <Trash2 size={16} />
              Remove
            </button>
            <button
              className="primary"
              onClick={() => download(activeLook.src, activeLook.name)}
            >
              <Download size={16} />
              Download
            </button>
          </div>
        </Dialog>
      )}
      {modal === "delete" && deleteItem && (
        <Dialog
          title={
            "Remove " + (deleteItem.type === "look" ? "look" : "garment") + "?"
          }
          onClose={close}
        >
          <p className="dialog-copy">
            “{deleteItem.obj.name}” will be removed from this device.
          </p>
          {formError && (
            <p className="inline-error" role="alert">
              {formError}
            </p>
          )}
          <div className="dialog-actions">
            <button className="secondary" onClick={close}>
              Cancel
            </button>
            <button className="primary" onClick={remove} disabled={saving}>
              Remove
            </button>
          </div>
        </Dialog>
      )}
      {modal === "ai" && (
        <Dialog title="Generate an AI try-on" onClose={close}>
          <div className="ai-pair">
            <img src={person} alt="Model to send" />
            <Plus size={18} />
            <img src={item.src} alt="Garment to send" />
          </div>
          {cameraConfirmation && (
            <button className="text-link" onClick={openCamera}>
              <Camera size={15} /> Retake camera photo
            </button>
          )}
          <p className="dialog-copy" aria-live="polite">
            {!provider
              ? "Checking the renderer…"
              : provider.configured
                ? "Send these two photos to " +
                  provider.provider +
                  " to generate the worn garment, including folds, shadows and sleeve shape."
                : provider.mode === "local-only"
                  ? "This studio uses on-device fitting. You can adjust the local fit and save a look."
                  : "The renderer is unavailable right now. You can use the fit guide on this device."}
          </p>
          {provider?.mode === "public-trial" && (
            <p className="field-help">
              Use a clear product photo. This shared trial may change framing or
              fine details.
            </p>
          )}
          {provider?.configured && provider.mode !== "public-trial" && (
            <label className="field-label">
              Garment photo
              <select
                value={photoType}
                onChange={(e) => setPhotoType(e.target.value)}
              >
                <option value="flat-lay">Product by itself</option>
                <option value="model">Worn by another model</option>
              </select>
            </label>
          )}
          {aiError && (
            <p className="inline-error" role="alert">
              {aiError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="secondary"
              onClick={() => {
                setUseGuide(true);
                setOriginal(false);
                setModal("adjust");
              }}
            >
              Use fit guide
            </button>
            <button
              className="primary"
              disabled={!provider?.configured}
              onClick={ai}
            >
              <Sparkles size={16} />
              Send and generate
            </button>
          </div>
        </Dialog>
      )}
      {modal === "progress" && (
        <Dialog title="Generating your try-on" onClose={close}>
          <div className="ai-progress">
            <LoaderCircle size={32} className="spin" />
            <p role="status">{aiStatus}</p>
          </div>
          <button className="secondary full" onClick={close}>
            Stop waiting
          </button>
        </Dialog>
      )}
    </div>
  );
}
