const { useEffect, useRef, useState } = React;

const QC_MOUNT = window.location.pathname.startsWith("/qc/") ? "/qc" : "";
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, options) => nativeFetch(
  QC_MOUNT && typeof input === "string" && input.startsWith("/api/")
    ? `${QC_MOUNT}${input}`
    : input,
  options
);
const qcPath = value => QC_MOUNT && typeof value === "string" && value.startsWith("/")
  ? `${QC_MOUNT}${value}`
  : value;

const DEFAULT_SPELL_DICTIONARY = [
  "soffit", "gypsum", "millwork", "storefront", "egress", "parapet",
  "cladding", "firestopping", "waterproofing", "flashing", "substrate",
  "CMU", "EIFS", "LVL", "ACT", "VCT"
];
const SPELL_DICTIONARY_STORAGE_KEY = "sgaSpellCheckDictionary";
const PROJECT_HISTORY_META_STORAGE_KEY = "sgaProjectHistoryMeta";
const SHEET_ZOOM_MIN = 0.75;
const SHEET_ZOOM_MAX = 3;

function App() {
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("sheets");
  const [message, setMessage] = useState("");
  const [scanProgress, setScanProgress] = useState(null);
  const [uploadFileName, setUploadFileName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [spellResults, setSpellResults] = useState([]);
  const [spellBusy, setSpellBusy] = useState(false);
  const [dictionaryInput, setDictionaryInput] = useState("");
  const [customDictionary, setCustomDictionary] = useState(loadSpellDictionary);
  const [history, setHistory] = useState([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState("active");
  const [historySort, setHistorySort] = useState("last-opened");
  const [historyMeta, setHistoryMeta] = useState(loadProjectHistoryMeta);
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState(window.location.search);

  useEffect(() => {
    function syncLocationSearch() {
      setLocationSearch(window.location.search);
    }
    window.addEventListener("popstate", syncLocationSearch);
    const interval = window.setInterval(syncLocationSearch, 500);
    return () => {
      window.removeEventListener("popstate", syncLocationSearch);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const urlRunId = new URLSearchParams(locationSearch).get("run");
    if (!urlRunId) {
      resetToFreshRun();
      return;
    }
    let active = true;
    setMessage("Opening saved analysis.");
    fetch(`/api/runs/${urlRunId}`)
      .then((response) => {
        if (!response.ok) throw new Error("Saved run is no longer available.");
        return response.json();
      })
      .then((payload) => {
        if (!active) return;
        setRun(payload);
        setMessage("");
      })
      .catch(() => {
        if (active) setMessage("");
      });
    return () => {
      active = false;
    };
  }, [locationSearch]);

  useEffect(() => {
    const urlRunId = new URLSearchParams(window.location.search).get("run");
    if (urlRunId && run?.run_id && run.run_id !== urlRunId) {
      setLocationSearch(window.location.search);
    }
  }, [run?.run_id]);

  function resetToFreshRun() {
    setRun(null);
    setTab("sheets");
    setMessage("");
    setScanProgress(null);
    setSpellResults([]);
  }

  async function upload(event) {
    const file = event.target.files[0];
    if (!file) return;
    await startUpload(file);
    event.target.value = "";
  }

  async function startUpload(file) {
    const form = new FormData();
    form.append("file", file);
    setUploadFileName(file.name);
    setBusy(true);
    setRun(null);
    setScanProgress({ percent: 0, status: "Uploading", message: "Uploading document." });
    setMessage("Uploading document.");
    try {
      const response = await fetch("/api/upload", { method: "POST", body: form });
      if (!response.ok) throw new Error(await uploadErrorMessage(response));
      const queued = await response.json();
      const nextSearch = `?run=${encodeURIComponent(queued.run_id)}&fresh=${Date.now()}`;
      window.history.replaceState({}, "", `${window.location.pathname}${nextSearch}`);
      setLocationSearch(nextSearch);
      setScanProgress(queued);
      const payload = await pollScanUntilComplete(queued.run_id, setScanProgress);
      setRun(payload);
      setTab("report");
      setMessage("");
      await autoRunSpellCheck(payload.run_id);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
      setScanProgress(null);
      setDragActive(false);
    }
  }

  async function handleUploadDrop(event) {
    event.preventDefault();
    setDragActive(false);
    if (busy) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    await startUpload(file);
  }

  function handleUploadDrag(event) {
    event.preventDefault();
    if (!busy) setDragActive(true);
  }

  function handleUploadDragLeave(event) {
    event.preventDefault();
    setDragActive(false);
  }

  async function saveAndRunQc() {
    if (!run) return;
    setBusy(true);
    setMessage("Saving manual corrections and rerunning QC.");
    try {
      await fetch(`/api/runs/${run.run_id}/extractions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: run.pages, sheet_index: run.sheet_index })
      });
      const response = await fetch(`/api/runs/${run.run_id}/qc`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setRun(payload);
      setTab("report");
      setMessage("");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function openHistoryViewport() {
    setTopMenuOpen(false);
    setTab("history");
    await refreshHistory();
  }

  function openDictionaryViewport() {
    setTopMenuOpen(false);
    setTab("dictionary");
  }

  function returnHomeViewport() {
    setTab("sheets");
    setMessage("");
  }

  function backToTabTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshHistory() {
    setHistoryBusy(true);
    try {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setHistory(payload.runs || []);
    } catch (error) {
      setMessage(`History failed: ${error.message}`);
    } finally {
      setHistoryBusy(false);
    }
  }

  async function openHistoryRun(runId) {
    setBusy(true);
    setMessage("Opening upload history item.");
    try {
      const response = await fetch(`/api/runs/${runId}`);
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setRun(payload);
      setTab("sheets");
      setMessage("");
      window.history.replaceState({}, "", window.location.pathname);
      saveProjectHistoryMeta({
        ...historyMeta,
        [payload.run_id]: {
          ...(historyMeta[payload.run_id] || {}),
          last_opened: Date.now(),
        },
      });
    } catch (error) {
      setMessage(`History item failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function saveProjectHistoryMeta(nextMeta) {
    setHistoryMeta(nextMeta);
    localStorage.setItem(PROJECT_HISTORY_META_STORAGE_KEY, JSON.stringify(nextMeta));
  }

  function updateProjectMeta(runId, values) {
    saveProjectHistoryMeta({
      ...historyMeta,
      [runId]: {
        ...(historyMeta[runId] || {}),
        ...values,
      },
    });
  }

  function archiveHistoryRun(runId, archived) {
    updateProjectMeta(runId, { archived });
  }

  function deleteHistoryRun(runId) {
    updateProjectMeta(runId, { hidden: true });
  }

  async function openExport(format) {
    if (!run) return;
    try {
      const response = await fetch(`/api/runs/${run.run_id}/export.${format}/show`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setMessage(payload.message || "Export saved to Downloads.");
    } catch (error) {
      setMessage(`Export failed: ${error.message}`);
    }
  }

  function updatePage(pageNumber, field, value) {
    setRun({
      ...run,
      pages: run.pages.map((page) => page.page_number === pageNumber ? { ...page, [field]: value, manually_corrected: true } : page)
    });
  }

  function updateIndex(position, field, value) {
    const entries = [...(run.sheet_index?.entries || [])];
    entries[position] = { ...entries[position], [field]: value, source: "manual" };
    setRun({ ...run, sheet_index: { ...run.sheet_index, entries } });
  }

  function addIndexEntry() {
    const entries = [...(run.sheet_index?.entries || [])];
    entries.push({ sheet_number: "", sheet_name: "", index_position: entries.length + 1, page_number: null, confidence: 100, source: "manual" });
    setRun({ ...run, sheet_index: { ...run.sheet_index, entries } });
  }

  function saveDictionary(words) {
    const cleaned = normalizeDictionary(words);
    setCustomDictionary(cleaned);
    localStorage.setItem(SPELL_DICTIONARY_STORAGE_KEY, JSON.stringify(cleaned));
    return cleaned;
  }

  function addDictionaryWord(word) {
    const nextWord = (word || dictionaryInput).trim();
    if (!nextWord) return;
    saveDictionary([...customDictionary, nextWord]);
    setDictionaryInput("");
  }

  function removeDictionaryWord(word) {
    saveDictionary(customDictionary.filter((item) => item.toLowerCase() !== word.toLowerCase()));
  }

  async function runCurrentSpellCheck() {
    if (!run) return;
    await autoRunSpellCheck(run.run_id);
  }

  async function autoRunSpellCheck(runId) {
    setSpellBusy(true);
    setMessage("Running spell check.");
    try {
      const payload = await runSpellCheck(runId, customDictionary);
      setSpellResults(payload.findings || []);
      setMessage("");
    } catch (error) {
      setMessage(`Spell check failed: ${error.message}`);
    } finally {
      setSpellBusy(false);
    }
  }

  function ignoreSpellFinding(index) {
    setSpellResults(spellResults.map((item, position) =>
      position === index ? { ...item, status: "Ignored" } : item
    ));
  }

  function openSpellFinding(pageNumber) {
    const targetPage = Number(pageNumber);
    if (!Number.isFinite(targetPage)) return;
    setTab("sheets");
    window.setTimeout(() => {
      const target = document.getElementById(`sheet-page-${targetPage}`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("sheet-card-focus");
      window.requestAnimationFrame(() => target.classList.add("sheet-card-focus"));
    }, 0);
  }

  const result = run?.qc_result;
  const summary = displayValue(result?.executive_summary);
  const overallFailed = summary?.overall_status === "Fail";
  const overallPassed = summary?.overall_status === "Pass";
  const summaryMetricState = overallFailed ? "fail" : (overallPassed ? "pass" : "");
  const currentDocumentName = run?.filename || uploadFileName || "";

  return React.createElement("main", { className: "app-shell" },
    React.createElement("header", { className: "topbar" },
      React.createElement("div", { className: "brand-lockup" },
        React.createElement("div", { className: "brand-logo", "aria-label": "Sam Garcia Architect" },
          React.createElement("img", { src: qcPath("/static/sga-mark.png"), alt: "" })
        ),
        React.createElement("div", null,
          React.createElement("div", { className: "eyebrow" }, "Sam Garcia Architect"),
          React.createElement("h1", null, "Quality Assurance Check"),
          React.createElement("p", { className: "subtitle" }, "Upload a drawing-set document, correct extracted sheet data, run QC, and export the report.")
        )
      ),
      React.createElement("div", { className: "actions" },
        run && React.createElement("button", { onClick: () => openExport("csv") }, "Export CSV"),
        run && React.createElement("button", { onClick: () => openExport("pdf") }, "Export PDF"),
        React.createElement("div", { className: "top-menu" },
          React.createElement("button", {
            className: `primary ${["dictionary", "history"].includes(tab) ? "active-command" : ""}`,
            onClick: () => setTopMenuOpen(!topMenuOpen),
            "aria-expanded": topMenuOpen ? "true" : "false"
          }, "Menu"),
          topMenuOpen && React.createElement("div", { className: "top-menu-panel" },
            React.createElement("button", {
              className: tab === "dictionary" ? "active" : "",
              onClick: openDictionaryViewport
            }, "Dictionary"),
            React.createElement("button", {
              className: tab === "history" ? "active" : "",
              onClick: openHistoryViewport,
              disabled: historyBusy
            }, historyBusy ? "Loading History" : "History")
          )
        )
      )
    ),
    !["history", "dictionary"].includes(tab) && React.createElement("section", {
      className: `upload-panel ${dragActive ? "drag-active" : ""} ${busy ? "is-busy" : ""}`,
      onDragEnter: handleUploadDrag,
      onDragOver: handleUploadDrag,
      onDragLeave: handleUploadDragLeave,
      onDrop: handleUploadDrop
    },
      React.createElement("input", {
        id: "document-upload-input",
        type: "file",
        accept: "application/pdf,image/jpeg,image/png,.jpg,.jpeg,.png",
        onChange: upload,
        disabled: busy
      }),
      React.createElement("label", { className: "upload-dropzone", htmlFor: "document-upload-input" },
        React.createElement("span", { className: "upload-kicker" }, busy ? "Processing" : "Document upload"),
        React.createElement("span", { className: "upload-title" }, busy ? (uploadFileName || "Working on document") : "Choose or drop a document"),
        React.createElement("span", { className: "upload-meta" }, busy ? "Quality checks are running in sequence." : "PDF, JPG, JPEG, or PNG"),
        React.createElement("span", { className: "upload-button" }, busy ? "Working" : "Choose file")
      ),
      React.createElement("div", { className: "scan-status" },
        busy && scanProgress && React.createElement(ScanProgress, { progress: scanProgress })
      ),
      message && React.createElement("span", { className: "notice" }, message)
    ),
    tab === "history" ? React.createElement(ProjectsViewport, {
      history,
      historyBusy,
      historyMeta,
      historyQuery,
      setHistoryQuery,
      historyFilter,
      setHistoryFilter,
      historySort,
      setHistorySort,
      currentRunId: run?.run_id,
      returnHomeViewport,
      openHistoryRun,
      refreshHistory,
      updateProjectMeta,
      archiveHistoryRun,
      deleteHistoryRun
    }) : tab === "dictionary" ? React.createElement(DictionaryViewport, {
      dictionary: customDictionary,
      dictionaryInput,
      setDictionaryInput,
      addDictionaryWord,
      removeDictionaryWord,
      returnHomeViewport
    }) : run ? React.createElement(React.Fragment, null,
      React.createElement("section", { className: "current-document-bar", "aria-label": "Current document" },
        React.createElement("span", null, "Current document"),
        React.createElement("strong", { title: currentDocumentName }, currentDocumentName || "Untitled document")
      ),
      React.createElement("div", { className: "run-actions" },
        React.createElement("button", { className: "primary", onClick: saveAndRunQc, disabled: !run || busy },
          busy ? "Running QC" : "Run QC"
        )
      ),
      React.createElement("section", { className: "status-grid" },
        Metric("Pages", run.page_count),
        Metric("Overall", summary?.overall_status || "Not run", summaryMetricState),
        Metric("Failed Items", summary?.failed_items ?? 0, summaryMetricState)
      ),
      React.createElement("nav", { className: "tabs" }, ["report", "sheets", "index", "cover", "seals", "scale", "viewport", "spell"].map((name) =>
        React.createElement("button", { key: name, className: `tab ${tab === name ? "active" : ""}`, onClick: () => setTab(name) }, label(name))
      )),
      React.createElement("div", { className: "report-nav-strip tab-nav-strip" },
        React.createElement("button", { type: "button", onClick: backToTabTop }, "Back to Top")
      ),
      React.createElement("section", { className: "panel" },
        tab === "sheets" && React.createElement(SheetsTab, { run, updatePage }),
        tab === "index" && React.createElement(IndexTab, { run, result, updateIndex, addIndexEntry }),
        tab === "cover" && React.createElement(CoverTab, { result }),
        tab === "seals" && React.createElement(SealCheckTab, { result }),
        tab === "scale" && React.createElement(ScaleCheckTab, { result }),
        tab === "viewport" && React.createElement(ViewportTab, { result }),
        tab === "spell" && React.createElement(SpellCheckTab, {
          run,
          results: spellResults,
          busy: spellBusy,
          dictionary: customDictionary,
          dictionaryInput,
          setDictionaryInput,
          runCurrentSpellCheck,
          ignoreSpellFinding,
          openSpellFinding,
          addDictionaryWord,
          removeDictionaryWord
        }),
        tab === "report" && React.createElement(ReportTab, { result })
      )
    ) : React.createElement("p", { className: "notice" }, "No document uploaded yet."));
}

async function pollScanUntilComplete(runId, onProgress) {
  while (true) {
    await wait(700);
    const response = await fetch(`/api/runs/${runId}/status`);
    if (!response.ok) throw new Error(await response.text());
    const status = await response.json();
    onProgress(status);
    if (status.status === "Failed") {
      throw new Error(status.message || "Scan failed.");
    }
    if (status.status === "Complete") {
      const runResponse = await fetch(`/api/runs/${runId}`);
      if (!runResponse.ok) throw new Error(await runResponse.text());
      return await runResponse.json();
    }
  }
}

async function uploadErrorMessage(response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    return parsed.detail || body || "Upload failed.";
  } catch {
    return body || "Upload failed.";
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ScanProgress({ progress }) {
  const value = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
  return React.createElement("div", { className: "scan-progress", "aria-label": "Scan progress" },
    React.createElement("div", { className: "scan-progress-label" },
      React.createElement("span", null, progress.status || "Scanning"),
      React.createElement("strong", null, `${value}%`)
    ),
    React.createElement("div", { className: "scan-progress-track" },
      React.createElement("div", { className: "scan-progress-fill", style: { width: `${value}%` } })
    ),
    progress.message && React.createElement("div", { className: "scan-progress-message" }, progress.message)
  );
}

function Metric(label, value, state = "") {
  return React.createElement("div", { className: `metric ${state ? `metric-${state}` : ""}` },
    React.createElement("div", { className: "metric-label" }, label),
    React.createElement("div", { className: "metric-value" }, displayValue(value))
  );
}

function ProjectsViewport({
  history,
  historyBusy,
  historyMeta,
  historyQuery,
  setHistoryQuery,
  historyFilter,
  setHistoryFilter,
  historySort,
  setHistorySort,
  currentRunId,
  returnHomeViewport,
  openHistoryRun,
  refreshHistory,
  updateProjectMeta,
  archiveHistoryRun,
  deleteHistoryRun
}) {
  const visibleProjects = sortProjects(
    history
      .map((item) => ({ ...item, meta: historyMeta[item.run_id] || {} }))
      .filter((item) => !item.meta.hidden)
      .filter((item) => historyFilter === "archived" ? item.meta.archived : !item.meta.archived)
      .filter((item) => {
        const query = historyQuery.trim().toLowerCase();
        if (!query) return true;
        return [
          item.filename,
          item.meta.project_name,
          item.meta.description,
          item.overall_status,
          item.run_id,
        ].some((value) => String(value || "").toLowerCase().includes(query));
      }),
    historySort
  );
  return React.createElement("section", { className: "projects-viewport" },
    React.createElement("div", { className: "history-home-row" },
      React.createElement("button", { className: "history-home-button", onClick: returnHomeViewport }, "Home")
    ),
    React.createElement("div", { className: "projects-hero" },
      React.createElement("div", { className: "module-kicker" }, "00 - Primary Module"),
      React.createElement("h2", null, "Projects"),
      React.createElement("p", { className: "subtitle" },
        "Open previous checks, restore selected drawing sets, and return to quality assurance reports without reprocessing the document."
      ),
      React.createElement("div", { className: "projects-search" },
        React.createElement("input", {
          value: historyQuery,
          placeholder: "Search projects",
          onChange: (event) => setHistoryQuery(event.target.value)
        }),
        React.createElement("button", { onClick: refreshHistory, disabled: historyBusy },
          historyBusy ? "Refreshing" : "Refresh"
        )
      )
    ),
    React.createElement("div", { className: "projects-toolbar" },
      React.createElement("div", { className: "segmented" },
        ["active", "archived"].map((name) =>
          React.createElement("button", {
            key: name,
            className: historyFilter === name ? "active" : "",
            onClick: () => setHistoryFilter(name)
          }, name)
        )
      ),
      React.createElement("div", { className: "segmented" },
        [
          ["last-opened", "Last Opened"],
          ["date-created", "Date Created"],
          ["project-name", "Project Name"],
        ].map(([value, label]) =>
          React.createElement("button", {
            key: value,
            className: historySort === value ? "active" : "",
            onClick: () => setHistorySort(value)
          }, label)
        )
      )
    ),
    React.createElement("div", { className: "projects-section-heading" },
      React.createElement("span", null, `${historyFilter} projects`),
      React.createElement("em", null, `${visibleProjects.length} saved`)
    ),
    visibleProjects.length ? React.createElement("div", { className: "projects-list" },
      visibleProjects.map((item) => React.createElement(ProjectRow, {
        key: item.run_id,
        item,
        isCurrent: item.run_id === currentRunId,
        openHistoryRun,
        updateProjectMeta,
        archiveHistoryRun,
        deleteHistoryRun
      }))
    ) : React.createElement("p", { className: "notice" }, "No projects match this view.")
  );
}

function DictionaryViewport({
  dictionary,
  dictionaryInput,
  setDictionaryInput,
  addDictionaryWord,
  removeDictionaryWord,
  returnHomeViewport
}) {
  return React.createElement("section", { className: "dictionary-viewport" },
    React.createElement("div", { className: "history-home-row" },
      React.createElement("button", { className: "history-home-button", onClick: returnHomeViewport }, "Home")
    ),
    React.createElement("div", { className: "projects-hero dictionary-hero" },
      React.createElement("div", { className: "module-kicker" }, "Dictionary"),
      React.createElement("h2", null, "Custom Dictionary"),
      React.createElement("p", { className: "subtitle" }, `${dictionary.length} saved words`)
    ),
    React.createElement("div", { className: "dictionary-viewport-grid" },
      React.createElement(DictionaryEditor, {
        dictionary,
        dictionaryInput,
        setDictionaryInput,
        addDictionaryWord,
        removeDictionaryWord
      })
    )
  );
}

function ProjectRow({ item, isCurrent, openHistoryRun, updateProjectMeta, archiveHistoryRun, deleteHistoryRun }) {
  const title = item.meta.project_name || projectNameFromFilename(item.filename);
  return React.createElement("article", { className: `project-row ${isCurrent ? "current" : ""}` },
    React.createElement("img", { src: qcPath(item.thumbnail_url), alt: `${title} thumbnail` }),
    React.createElement("div", { className: "project-fields" },
      React.createElement("div", { className: "project-state" }, isCurrent ? `Current · ${item.filename}` : item.filename),
      React.createElement("input", {
        value: title,
        onChange: (event) => updateProjectMeta(item.run_id, { project_name: event.target.value })
      }),
      React.createElement("textarea", {
        value: item.meta.description || "",
        placeholder: "Optional project description",
        onChange: (event) => updateProjectMeta(item.run_id, { description: event.target.value })
      }),
      React.createElement("div", { className: "project-stats" },
        React.createElement("span", null, `Created ${formatHistoryDate(item.created_time)}`),
        React.createElement("span", null, `Last opened ${formatHistoryDate(item.meta.last_opened || item.modified_time)}`),
        React.createElement("span", null, `${item.page_count || 0} drawings`),
        React.createElement("span", null, `${item.overall_status || "Not run"} · ${item.failed_items || 0} failed`)
      )
    ),
    React.createElement("div", { className: "project-actions" },
      React.createElement("button", { className: "primary", onClick: () => openHistoryRun(item.run_id) }, "Open"),
      React.createElement("button", { onClick: () => updateProjectMeta(item.run_id, { project_name: title, description: item.meta.description || "" }) }, "Save"),
      React.createElement("button", { onClick: () => archiveHistoryRun(item.run_id, !item.meta.archived) },
        item.meta.archived ? "Unarchive" : "Archive"
      ),
      React.createElement("button", { className: "ghost-danger", onClick: () => deleteHistoryRun(item.run_id) }, "Delete")
    )
  );
}

function SheetsTab({ run, updatePage }) {
  const [expandedPage, setExpandedPage] = useState(null);
  const [sheetZoom, setSheetZoom] = useState(1);
  const [sheetPanning, setSheetPanning] = useState(false);
  const sheetPanRef = useRef(null);
  const sheetStageRef = useRef(null);

  useEffect(() => {
    if (!expandedPage) return;
    function closeOnEscape(event) {
      if (event.key === "Escape") setExpandedPage(null);
      if (event.key === "+" || event.key === "=") zoomSheetFromCenter(0.25);
      if (event.key === "-" || event.key === "_") zoomSheetFromCenter(-0.25);
      if (event.key === "0") setSheetZoom(1);
    }
    setSheetZoom(1);
    document.body.classList.add("lightbox-open");
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("lightbox-open");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expandedPage]);

  useEffect(() => {
    if (!expandedPage) return;
    window.requestAnimationFrame(() => {
      const stage = sheetStageRef.current;
      if (!stage) return;
      stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
      stage.scrollTop = 0;
    });
  }, [expandedPage]);

  useEffect(() => {
    if (!expandedPage) return;
    const stage = sheetStageRef.current;
    if (!stage) return;
    function zoomOnWheel(event) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      setSheetZoomAroundPoint((value) => value + (direction * 0.15), event.clientX, event.clientY);
    }
    stage.addEventListener("wheel", zoomOnWheel, { passive: false });
    return () => stage.removeEventListener("wheel", zoomOnWheel);
  }, [expandedPage]);

  function openExpandedPage(page) {
    setSheetZoom(1);
    setSheetPanning(false);
    setExpandedPage(page);
  }

  function setSheetZoomAroundPoint(nextZoom, clientX, clientY) {
    const stage = sheetStageRef.current;
    if (!stage) {
      setSheetZoom(nextZoom);
      return;
    }
    const rect = stage.getBoundingClientRect();
    const anchorX = clientX - rect.left;
    const anchorY = clientY - rect.top;
    const ratioX = stage.scrollWidth ? (stage.scrollLeft + anchorX) / stage.scrollWidth : 0;
    const ratioY = stage.scrollHeight ? (stage.scrollTop + anchorY) / stage.scrollHeight : 0;
    setSheetZoom((currentZoom) => {
      const resolvedZoom = typeof nextZoom === "function" ? nextZoom(currentZoom) : nextZoom;
      const clampedZoom = Math.max(SHEET_ZOOM_MIN, Math.min(SHEET_ZOOM_MAX, resolvedZoom));
      if (clampedZoom === currentZoom) return currentZoom;
      window.requestAnimationFrame(() => {
        const nextStage = sheetStageRef.current;
        if (!nextStage) return;
        nextStage.scrollLeft = Math.max(0, (ratioX * nextStage.scrollWidth) - anchorX);
        nextStage.scrollTop = Math.max(0, (ratioY * nextStage.scrollHeight) - anchorY);
      });
      return clampedZoom;
    });
  }

  function zoomSheetFromCenter(delta) {
    const stage = sheetStageRef.current;
    if (!stage) {
      setSheetZoom((value) => Math.max(SHEET_ZOOM_MIN, Math.min(SHEET_ZOOM_MAX, value + delta)));
      return;
    }
    const rect = stage.getBoundingClientRect();
    setSheetZoomAroundPoint((value) => value + delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function startSheetPan(event) {
    if (event.button !== 0) return;
    const stage = event.currentTarget;
    sheetPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: stage.scrollLeft,
      scrollTop: stage.scrollTop,
    };
    stage.setPointerCapture?.(event.pointerId);
    setSheetPanning(true);
  }

  function moveSheetPan(event) {
    const pan = sheetPanRef.current;
    if (!pan) return;
    const stage = event.currentTarget;
    stage.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    stage.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  }

  function stopSheetPan(event) {
    if (sheetPanRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    sheetPanRef.current = null;
    setSheetPanning(false);
  }

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "sheet-grid" }, run.pages.map((page) =>
      React.createElement("article", {
        id: `sheet-page-${page.page_number}`,
        className: `sheet-card ${page.missing_sheet_number ? "missing-sheet-number" : ""}`,
        key: page.page_number
      },
        React.createElement("button", {
          className: "sheet-thumbnail-button",
          type: "button",
          onClick: () => openExpandedPage(page),
          "aria-label": `Open page ${page.page_number} full screen`
        },
          React.createElement("img", { src: qcPath(page.thumbnail_url), alt: `Page ${page.page_number}` }),
          React.createElement("span", { className: "sheet-thumbnail-overlay" }, "View full screen")
        ),
        React.createElement("div", { className: "sheet-fields" },
          React.createElement("strong", null, `Document page ${page.page_number}`),
          page.is_cover_sheet && React.createElement("span", { className: "sheet-cover-label" },
            page.cover_type === "primary" ? "Primary cover" : "Secondary cover"
          ),
          page.ignored_for_sheet_index && React.createElement("span", { className: "sheet-index-note" }, "Excluded from sheet index"),
          page.missing_sheet_number && React.createElement("span", { className: "sheet-alert" }, "Missing sheet number"),
          React.createElement("label", null, "Sheet number", React.createElement("input", { value: page.sheet_number || "", onChange: (event) => updatePage(page.page_number, "sheet_number", event.target.value) })),
          React.createElement("label", null, "Sheet name", React.createElement("input", { value: page.sheet_name || "", onChange: (event) => updatePage(page.page_number, "sheet_name", event.target.value) }))
        )
      )
    )),
    expandedPage && React.createElement("div", {
      className: "sheet-lightbox",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `Document page ${expandedPage.page_number} full screen`,
      onClick: () => setExpandedPage(null)
    },
      React.createElement("div", { className: "sheet-lightbox-frame", onClick: (event) => event.stopPropagation() },
        React.createElement("div", { className: "sheet-lightbox-header" },
          React.createElement("div", null,
            React.createElement("span", { className: "sheet-lightbox-kicker" }, `Document page ${expandedPage.page_number}`),
            React.createElement("strong", null, expandedPage.sheet_number || "Unnumbered sheet"),
            expandedPage.sheet_name && React.createElement("span", null, expandedPage.sheet_name)
          ),
          React.createElement("div", { className: "sheet-lightbox-controls" },
            React.createElement("button", {
              type: "button",
              onClick: () => zoomSheetFromCenter(-0.25),
              disabled: sheetZoom <= SHEET_ZOOM_MIN,
              "aria-label": "Zoom out"
            }, "Zoom Out"),
            React.createElement("span", { className: "sheet-zoom-value" }, `${Math.round(sheetZoom * 100)}%`),
            React.createElement("button", {
              type: "button",
              onClick: () => zoomSheetFromCenter(0.25),
              disabled: sheetZoom >= SHEET_ZOOM_MAX,
              "aria-label": "Zoom in"
            }, "Zoom In"),
            React.createElement("button", { type: "button", onClick: () => setSheetZoom(1), disabled: sheetZoom === 1 }, "Reset"),
            React.createElement("button", { type: "button", onClick: () => setExpandedPage(null), "aria-label": "Close full screen page" }, "Close")
          )
        ),
        React.createElement("div", {
          className: `sheet-lightbox-stage ${sheetPanning ? "is-panning" : ""}`,
          ref: sheetStageRef,
          onPointerDown: startSheetPan,
          onPointerMove: moveSheetPan,
          onPointerUp: stopSheetPan,
          onPointerCancel: stopSheetPan,
          onPointerLeave: stopSheetPan
        },
          React.createElement("div", { className: "sheet-lightbox-content", style: { width: `${sheetZoom * 100}%` } },
            React.createElement("img", {
              src: qcPath(expandedPage.preview_url || expandedPage.thumbnail_url),
              alt: `Page ${expandedPage.page_number} full screen`,
              draggable: false
            })
          )
        )
      )
    )
  );
}

function IndexTab({ run, result, updateIndex, addIndexEntry }) {
  const entries = run.sheet_index?.entries || [];
  const physicalPageBySheet = new Map((run.physical_sheets || [])
    .map((sheet) => [normalizeSheetNumber(sheet.sheet_number), sheet.page_number])
    .filter(([sheetNumber]) => sheetNumber));
  const missingSheets = new Set(
    (result?.index_integrity_check?.missing_page_identification?.missing_from_pdf || [])
      .map((item) => normalizeSheetNumber(item.sheet_number))
  );
  const outOfSequenceRows = new Map(
    (result?.index_integrity_check?.sequence_compliance?.out_of_sequence || [])
      .map((item) => [normalizeSheetNumber(item.sheet_number), item])
  );
  const extraRows = result?.index_integrity_check?.missing_page_identification?.extra_in_pdf || [];
  const duplicateRows = result?.index_integrity_check?.missing_page_identification?.duplicate_in_pdf || [];
  const tableRows = entries.map((entry, index) => ({
    kind: "index",
    entry,
    index,
    physicalPage: physicalPageBySheet.get(normalizeSheetNumber(entry.sheet_number)) || null,
  }));
  [...extraRows, ...duplicateRows.map((row) => ({ ...row, duplicate: true }))]
    .sort((left, right) => (left.physical_page_number || 0) - (right.physical_page_number || 0))
    .forEach((row) => {
      const physicalPage = row.physical_page_number || 0;
      const insertAt = tableRows.findIndex((item) =>
        item.kind === "index" && item.physicalPage && item.physicalPage > physicalPage
      );
      const item = { kind: "extra", row, physicalPage };
      if (insertAt === -1) tableRows.push(item);
      else tableRows.splice(insertAt, 0, item);
    });
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "actions" }, React.createElement("button", { onClick: addIndexEntry }, "Add index row")),
    React.createElement("table", null,
      React.createElement("thead", null, React.createElement("tr", null, ["Position", "Sheet Number", "Document Status", "Source"].map((head) => React.createElement("th", { key: head }, head)))),
      React.createElement("tbody", null,
        tableRows.map((item) => {
          if (item.kind === "extra") {
            const row = item.row;
            return React.createElement("tr", { key: `extra-${row.sheet_number}-${row.physical_page_number}`, className: "missing-from-index-sheet" },
            React.createElement("td", null, `Document page ${row.physical_page_number || "?"}`),
            React.createElement("td", null, React.createElement("input", {
              value: row.sheet_number || "Unknown sheet",
              readOnly: true,
              title: row.sheet_name || "Detected in document, not listed in the sheet index"
            })),
            React.createElement("td", null, React.createElement("span", { className: "status Fail" }, row.duplicate ? "Duplicate in document" : "Missing from index")),
            React.createElement("td", null, row.sheet_name || "Detected document sheet")
            );
          }
          const entry = item.entry;
          const index = item.index;
          const normalizedSheet = normalizeSheetNumber(entry.sheet_number);
          const missingFromPdf = missingSheets.has(normalizedSheet);
          const outOfSequence = outOfSequenceRows.get(normalizedSheet);
          const rowClass = missingFromPdf || outOfSequence ? "missing-index-sheet" : "";
          return React.createElement("tr", { key: index, className: rowClass },
            React.createElement("td", null, index + 1),
            React.createElement("td", null, React.createElement("input", { value: entry.sheet_number || "", onChange: (event) => updateIndex(index, "sheet_number", event.target.value) })),
            React.createElement("td", null,
              missingFromPdf
                ? React.createElement("span", { className: "status Fail" }, "Missing from document")
                : outOfSequence
                  ? React.createElement("span", { className: "status Fail" }, `Out of order - document page ${outOfSequence.physical_page_number || "?"}`)
                : React.createElement("span", { className: "status Pass" }, "Present")
            ),
            React.createElement("td", null, displayValue(entry.source || ""))
          );
        })
      )
    )
  );
}

function CoverTab({ result }) {
  const cover = result?.cover_sheet_checklist;
  if (!cover) return React.createElement("p", { className: "notice" }, "Run QC to see cover sheet results.");
  return React.createElement("table", null,
    React.createElement("thead", null, React.createElement("tr", null, ["Item", "Status"].map((head) => React.createElement("th", { key: head }, head)))),
    React.createElement("tbody", null, cover.checklist.map((item) =>
      React.createElement("tr", { key: item.item },
        React.createElement("td", null, item.item),
        React.createElement("td", { className: statusClass(item.status) }, displayValue(item.status))
      )
    ))
  );
}

function SealCheckTab({ result }) {
  const rows = result?.sheet_seal_compliance || [];
  const stats = result?.seal_statistics || {};
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "status-grid" },
      Metric("Sheets Checked", stats.reviewed_sheet_count ?? 0),
      Metric("Seals Present", stats.passed_sheet_count ?? 0),
      Metric("Missing Seals", stats.failed_sheet_count ?? 0, stats.failed_sheet_count ? "fail" : "pass"),
      Metric("Not Required", stats.not_applicable_count ?? 0)
    ),
    React.createElement("h2", null, "Right-Side Professional Seal Check"),
    rows.length ? React.createElement("table", null,
      React.createElement("thead", null, React.createElement("tr", null,
        ["Sheet", "Page", "Status", "Finding"].map((head) => React.createElement("th", { key: head }, head))
      )),
      React.createElement("tbody", null, rows.map((row) =>
        React.createElement("tr", { key: `${row.page_number}-${row.sheet_number}` },
          React.createElement("td", null, row.sheet_number || "Unnumbered"),
          React.createElement("td", null, row.page_number),
          React.createElement("td", { className: statusClass(row.status) }, row.status),
          React.createElement("td", null, row.evidence || row.comments)
        )
      ))
    ) : React.createElement("p", { className: "notice" }, "No seal findings are available.")
  );
}

function ViewportTab({ result }) {
  const rows = result?.viewport_keynote_compliance || [];
  const sheetRows = result?.sheet_keynote_compliance || [];
  const stats = result?.keynote_statistics || {};
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "status-grid" },
      Metric("Reviewed Sheets", stats.reviewed_sheet_count ?? 0),
      Metric("Passed Sheets", stats.passed_sheet_count ?? 0),
      Metric("Failed Sheets", stats.failed_sheet_count ?? 0),
      Metric("Compliance", stats.compliance_percent == null ? "n/a" : `${stats.compliance_percent}%`)
    ),
    React.createElement("h2", null, "Sheet Keynote Status"),
    sheetRows.length ? React.createElement("table", null,
      React.createElement("thead", null, React.createElement("tr", null, ["Sheet", "Page", "Has SHEET KEYNOTES", "Status", "Comment"].map((head) => React.createElement("th", { key: head }, head)))),
      React.createElement("tbody", null, sheetRows.map((row, index) =>
        React.createElement("tr", { key: index },
          React.createElement("td", null, row.sheetNumber),
          React.createElement("td", null, row.pageNumber),
          React.createElement("td", null, row.hasSheetKeynotes ? "true" : "false"),
          React.createElement("td", { className: statusClass(row.keynoteCheckStatus) }, displayValue(row.keynoteCheckStatus)),
          React.createElement("td", null, displayValue(row.comment))
        )
      ))
    ) : React.createElement("p", { className: "notice" }, "No sheets with SHEET KEYNOTES were detected."),
    React.createElement("h2", null, "Viewport Keynote Findings"),
    rows.length ? React.createElement("table", null,
      React.createElement("thead", null, React.createElement("tr", null, ["Sheet", "Detail", "Label", "Scale", "Status"].map((head) => React.createElement("th", { key: head }, head)))),
      React.createElement("tbody", null, rows.map((row, index) =>
        React.createElement("tr", { key: index },
          React.createElement("td", null, row.sheet_number),
          React.createElement("td", null, row.detail_number),
          React.createElement("td", null, row.view_label),
          React.createElement("td", null, row.scale),
          React.createElement("td", { className: statusClass(row.status) }, displayValue(row.status))
        )
      ))
    ) : React.createElement("p", { className: "notice" }, "No viewport keynote findings.")
  );
}

function ScaleCheckTab({ result }) {
  const rows = result?.missing_scale_check || [];
  const stats = result?.missing_scale_statistics || {};
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "status-grid" },
      Metric("Views Checked", stats.reviewed_view_count ?? 0),
      Metric("Scaled / NTS", stats.passed_view_count ?? 0),
      Metric("Warnings", stats.warning_count ?? 0)
    ),
    React.createElement("h2", null, "Missing Scale Check"),
    rows.length ? React.createElement("table", null,
      React.createElement("thead", null, React.createElement("tr", null, ["Sheet", "Page", "Detail", "View Title", "Scale", "Status"].map((head) => React.createElement("th", { key: head }, head)))),
      React.createElement("tbody", null, rows.map((row, index) =>
        React.createElement("tr", { key: index },
          React.createElement("td", null, row.sheet_number),
          React.createElement("td", null, row.page_number),
          React.createElement("td", null, row.detail_number),
          React.createElement("td", null, row.view_label),
          React.createElement("td", null, row.scale || "Missing"),
          React.createElement("td", { className: statusClass(row.status) }, displayValue(row.status))
        )
      ))
    ) : React.createElement("p", { className: "notice" }, "No numbered view titles were detected.")
  );
}

function SpellCheckTab({
  run,
  results,
  busy,
  dictionary,
  dictionaryInput,
  setDictionaryInput,
  runCurrentSpellCheck,
  ignoreSpellFinding,
  openSpellFinding,
  addDictionaryWord,
  removeDictionaryWord
}) {
  if (!run) return React.createElement("p", { className: "notice" }, "Upload a document before running spell check.");
  return React.createElement("div", { className: "spell-layout" },
    React.createElement("section", { className: "spell-main" },
      React.createElement("div", { className: "section-header" },
        React.createElement("div", null,
          React.createElement("h2", null, "Spell Check"),
          React.createElement("p", { className: "subtitle" }, `Selected document: ${run.filename || run.run_id}`)
        ),
        React.createElement("button", { className: "primary", onClick: runCurrentSpellCheck, disabled: busy },
          busy ? "Checking" : "Run Spell Check"
        )
      ),
      results.length ? React.createElement("table", { className: "spell-table" },
        React.createElement("thead", null,
          React.createElement("tr", null, ["Sheet/Page", "Word", "Suggested Correction", "Context", "Status", "Actions"].map((head) =>
            React.createElement("th", { key: head }, head)
          ))
        ),
        React.createElement("tbody", null, results.map((item, index) =>
          React.createElement("tr", { key: `${item.sheet}-${item.page}-${item.word}-${index}` },
            React.createElement("td", null, `${item.sheet || "Sheet"} / ${item.page || ""}`),
            React.createElement("td", null, item.word),
            React.createElement("td", null, item.suggested_correction || ""),
            React.createElement("td", null, item.context || ""),
            React.createElement("td", null,
              item.status && item.status !== "Open"
                ? React.createElement("span", { className: statusClass(item.status) }, displayValue(item.status))
                : ""
            ),
            React.createElement("td", null,
              React.createElement("div", { className: "row-actions" },
                React.createElement("button", {
                  className: "open-finding",
                  onClick: () => openSpellFinding(item.page),
                  disabled: item.page == null
                }, "Open Page"),
                React.createElement("button", { onClick: () => ignoreSpellFinding(index), disabled: item.status === "Ignored" }, "Ignore"),
                React.createElement("button", { onClick: () => addDictionaryWord(item.word) }, "Add to Dictionary")
              )
            )
          )
        ))
      ) : React.createElement("p", { className: "notice" }, "No spell-check results yet. Run spell check to scan extracted document text.")
    ),
    React.createElement(DictionaryEditor, {
      dictionary,
      dictionaryInput,
      setDictionaryInput,
      addDictionaryWord,
      removeDictionaryWord
    })
  );
}

function DictionaryEditor({
  dictionary,
  dictionaryInput,
  setDictionaryInput,
  addDictionaryWord,
  removeDictionaryWord
}) {
  return React.createElement("aside", { className: "dictionary-panel" },
      React.createElement("h2", null, "Custom Dictionary"),
      React.createElement("div", { className: "dictionary-form" },
        React.createElement("input", {
          value: dictionaryInput,
          placeholder: "Add word",
          onChange: (event) => setDictionaryInput(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") addDictionaryWord();
          }
        }),
        React.createElement("button", { onClick: () => addDictionaryWord() }, "Add")
      ),
      React.createElement("div", { className: "dictionary-list" }, dictionary.map((word) =>
        React.createElement("span", { className: "dictionary-chip", key: word },
          word,
          React.createElement("button", { onClick: () => removeDictionaryWord(word), title: `Remove ${word}` }, "x")
        )
      ))
  );
}

function ReportTab({ result }) {
  if (!result) return React.createElement("p", { className: "notice" }, "Run QC to generate the report.");
  const failedKeynotes = (result.sheet_keynote_compliance || [])
    .filter((row) => row.keynoteCheckStatus !== "Pass");
  const keynoteStats = result.keynote_statistics || {};
  const coverItems = result.cover_sheet_checklist?.checklist || [];
  const failedCoverItems = coverItems.filter((item) => item.status !== "Pass");
  const coverPassed = coverItems.length - failedCoverItems.length;
  const sealStats = result.seal_statistics || {};
  const failedSeals = (result.sheet_seal_compliance || [])
    .filter((row) => row.status === "Fail");
  const scaleStats = result.missing_scale_statistics || {};
  const warningScales = (result.missing_scale_check || [])
    .filter((row) => row.status !== "Pass");
  const missingIndexRows = result.index_integrity_check?.missing_page_identification?.missing_from_pdf || [];
  const extraIndexRows = result.index_integrity_check?.missing_page_identification?.extra_in_pdf || [];
  const duplicateIndexRows = result.index_integrity_check?.missing_page_identification?.duplicate_in_pdf || [];
  const missingSheetNumberRows = result.index_integrity_check?.missing_page_identification?.missing_sheet_number_pages || [];
  const sequenceIndexRows = result.index_integrity_check?.sequence_compliance?.out_of_sequence || [];
  const indexIssueCount = missingIndexRows.length + extraIndexRows.length + duplicateIndexRows.length + missingSheetNumberRows.length + sequenceIndexRows.length;
  const summary = result.executive_summary || {};
  const highPriority = summary.high_priority_corrections || [];
  function jumpToReportSection(section) {
    const target = document.getElementById(reportSectionId(section));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const overallStatus = displayValue(summary.overall_status || "Not run");
  const overallTone = overallStatus === "Fail" ? "fail" : (overallStatus === "Pass" ? "pass" : "review");
  const reportCards = [
    {
      label: "Index",
      target: "Index Integrity",
      status: indexIssueCount ? "Fail" : "Pass",
      detail: indexIssueCount ? `${indexIssueCount} issue(s)` : "No presence issues",
      meta: `Sequence ${displayValue(result.index_integrity_check?.sequence_compliance?.status || "")}`,
    },
    {
      label: "Cover",
      target: "Cover Checklist",
      status: failedCoverItems.length ? "Fail" : "Pass",
      detail: `${coverPassed} / ${coverItems.length || 0} passed`,
      meta: failedCoverItems.length ? `${failedCoverItems.length} item(s) need review` : "Checklist complete",
    },
    {
      label: "Seals",
      target: "Seal Check",
      status: failedSeals.length ? "Fail" : "Pass",
      detail: sealStats.reviewed_sheet_count ? `${sealStats.passed_sheet_count || 0} / ${sealStats.reviewed_sheet_count || 0} passed` : "No seal review",
      meta: `${sealStats.not_applicable_count || 0} not required`,
    },
    {
      label: "Scales",
      target: "Scale Check",
      status: warningScales.length ? "Warning" : "Pass",
      detail: `${scaleStats.passed_view_count || 0} / ${scaleStats.reviewed_view_count || 0} views passed`,
      meta: warningScales.length ? `${warningScales.length} missing scale warning(s)` : "No missing scales",
    },
    {
      label: "Keynotes",
      target: "Keynotes",
      status: failedKeynotes.length ? "Fail" : "Pass",
      detail: `${keynoteStats.passed_sheet_count || 0} / ${keynoteStats.reviewed_sheet_count || 0} sheets passed`,
      meta: failedKeynotes.length ? `${failedKeynotes.length} sheet issue(s)` : "No keynote failures",
    },
  ];
  const indexRows = [
    ...missingIndexRows.map((row) => ({
      key: `missing-${row.sheet_number}`,
      item: row.sheet_number || "Unknown sheet",
      location: "Sheet index",
      status: "Fail",
      finding: "Listed in the index but missing from the document.",
    })),
    ...extraIndexRows.map((row) => ({
      key: `extra-${row.sheet_number}-${row.physical_page_number}`,
      item: row.sheet_number || "Unknown sheet",
      location: `Document page ${row.physical_page_number || "?"}`,
      status: "Fail",
      finding: "Found in the document but missing from the sheet index.",
    })),
    ...duplicateIndexRows.map((row) => ({
      key: `duplicate-${row.sheet_number}-${row.physical_page_number}`,
      item: row.sheet_number || "Unknown sheet",
      location: `Document page ${row.physical_page_number || "?"}`,
      status: "Fail",
      finding: "This sheet number appears more than once in the document.",
    })),
    ...missingSheetNumberRows.map((row) => ({
      key: `number-${row.physical_page_number || row.page_number}`,
      item: `Page ${row.physical_page_number || row.page_number || "?"}`,
      location: "Extracted sheets",
      status: "Fail",
      finding: "Missing a valid sheet number.",
    })),
    ...sequenceIndexRows.map((row, index) => ({
      key: `sequence-${row.sheet_number}-${row.physical_page_number}-${index}`,
      item: row.sheet_number || "Unknown sheet",
      location: `Document page ${row.physical_page_number || "?"}`,
      status: "Fail",
      finding: `Out of sequence. Expected index position ${row.index_position || "?"}.`,
    })),
  ];
  const coverRows = failedCoverItems.map((item) => ({
    key: item.item,
    item: item.item,
    location: "Cover sheet",
    status: item.status,
    finding: item.comments || item.evidence || "Required cover-sheet item was not confirmed.",
  }));
  const sealRows = failedSeals.map((row) => ({
    key: `${row.sheet_number}-${row.page_number}`,
    item: row.sheet_number || "Unknown sheet",
    location: `Page ${row.page_number || "?"}`,
    status: row.status,
    finding: row.evidence || row.comments || "Professional seal was not detected.",
  }));
  const scaleRows = warningScales.map((row, index) => ({
    key: `${row.sheet_number}-${row.page_number}-${row.detail_number}-${index}`,
    item: row.sheet_number || "Unknown sheet",
    location: [row.detail_number, row.view_label].filter(Boolean).join(" ") || `Page ${row.page_number || "?"}`,
    status: row.status,
    finding: row.scale ? `Scale detected: ${row.scale}` : "Missing scale or NTS designation.",
  }));
  const keynoteRows = failedKeynotes.map((row) => ({
    key: `${row.sheetNumber}-${row.pageNumber}`,
    item: row.sheetNumber || "Unknown sheet",
    location: `Page ${row.pageNumber || "?"}`,
    status: row.keynoteCheckStatus,
    finding: row.comment || "Required keynote symbols were not confirmed.",
  }));
  return React.createElement("div", { className: "report-dashboard" },
    React.createElement("section", {
      id: reportSectionId("Executive Summary"),
      className: `report-hero report-${overallTone}`,
      "data-report-section": "Executive Summary"
    },
      React.createElement("div", null,
        React.createElement("span", { className: "report-kicker" }, "QC Report"),
        React.createElement("h2", null, overallStatus),
        React.createElement("p", null,
          Number(summary.failed_items || 0)
            ? `${summary.failed_items} failed item(s) require correction before closeout.`
            : "No failed QC items were detected in the reviewed categories."
        )
      ),
      React.createElement("div", { className: "report-hero-stat" },
        React.createElement("span", null, summary.failed_items ?? 0),
        React.createElement("strong", null, "Failed Items")
      )
    ),
    React.createElement("section", { className: "report-card-grid" }, reportCards.map((card) =>
      React.createElement("button", {
        type: "button",
        className: `report-card report-card-${statusTone(card.status)}`,
        key: card.label,
        onClick: () => jumpToReportSection(card.target),
      },
        React.createElement("div", { className: "report-card-top" },
          React.createElement("span", null, card.label),
          React.createElement("span", { className: statusClass(card.status) }, displayValue(card.status))
        ),
        React.createElement("strong", null, card.detail),
        React.createElement("p", null, card.meta)
      )
    )),
    React.createElement("section", {
      id: reportSectionId("Priority Corrections"),
      className: "report-priority",
      "data-report-section": "Priority Corrections"
    },
      React.createElement("div", { className: "report-section-heading" },
        React.createElement("h2", null, "Priority Corrections"),
        React.createElement("span", null, highPriority.length ? `${highPriority.length} item(s)` : "Clear")
      ),
      highPriority.length
        ? React.createElement("ol", null, highPriority.map((item) => React.createElement("li", { key: item }, displayValue(item))))
        : React.createElement("p", null, "No high-priority corrections were generated.")
    ),
    React.createElement("div", { className: "report-detail-grid" },
      ReportFindingSection("Index Integrity", indexRows, "No index presence issues detected."),
      ReportFindingSection("Cover Checklist", coverRows, "No failed cover checklist items detected."),
      ReportFindingSection("Seal Check", sealRows, "No missing required seals detected."),
      ReportFindingSection("Scale Check", scaleRows, "No missing scale warnings detected."),
      ReportFindingSection("Keynotes", keynoteRows, "No failed keynote sheets detected.")
    )
  );
}

function ReportFindingSection(title, rows, emptyText) {
  return React.createElement("section", {
    id: reportSectionId(title),
    className: "report-detail-section",
    "data-report-section": title
  },
    React.createElement("div", { className: "report-section-heading" },
      React.createElement("h2", null, title),
      React.createElement("span", null, rows.length ? `${rows.length} finding(s)` : "Clear")
    ),
    rows.length
      ? React.createElement("table", { className: "report-finding-table" },
        React.createElement("thead", null, React.createElement("tr", null,
          ["Item", "Location", "Status", "Finding"].map((head) => React.createElement("th", { key: head }, head))
        )),
        React.createElement("tbody", null, rows.map((row) =>
          React.createElement("tr", { key: row.key },
            React.createElement("td", null, row.item),
            React.createElement("td", null, row.location),
            React.createElement("td", null, React.createElement("span", { className: statusClass(row.status) }, displayValue(row.status))),
            React.createElement("td", null, displayValue(row.finding))
          )
        ))
      )
      : React.createElement("p", { className: "report-empty" }, emptyText)
  );
}

function reportSectionId(title) {
  return `report-${String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function statusTone(status) {
  const value = displayValue(status || "");
  if (value === "Fail") return "fail";
  if (value === "Warning") return "review";
  return "pass";
}

function statusClass(status) {
  return `status ${displayValue(status || "").replace(" ", "")}`;
}

function label(name) {
  return { sheets: "Extracted Sheets", index: "Sheet Index", cover: "Cover Checklist", seals: "Seal Check", scale: "Scale Check", viewport: "Viewport Keynotes", spell: "Spell Check", report: "Report" }[name];
}

function displayValue(value) {
  if (value === "Needs Review") return "Pass";
  if (typeof value === "string") return value.replaceAll("Needs Review", "Pass");
  return value;
}

function sortProjects(projects, sortMode) {
  const items = [...projects];
  if (sortMode === "project-name") {
    return items.sort((a, b) =>
      projectNameFromFilename(a.meta.project_name || a.filename)
        .localeCompare(projectNameFromFilename(b.meta.project_name || b.filename))
    );
  }
  if (sortMode === "date-created") {
    return items.sort((a, b) => Number(b.created_time || 0) - Number(a.created_time || 0));
  }
  return items.sort((a, b) =>
    historyTimestamp(b.meta.last_opened || b.modified_time) - historyTimestamp(a.meta.last_opened || a.modified_time)
  );
}

function projectNameFromFilename(filename) {
  return String(filename || "Untitled Project")
    .replace(/\.pdf$/i, "")
    .replace(/[-_]+/g, " ")
    .trim() || "Untitled Project";
}

function historyTimestamp(value) {
  const number = Number(value || 0);
  return number < 100000000000 ? number * 1000 : number;
}

function formatHistoryDate(value) {
  if (!value) return "n/a";
  return new Date(historyTimestamp(value)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function normalizeSheetNumber(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
}

function loadSpellDictionary() {
  try {
    const saved = JSON.parse(localStorage.getItem(SPELL_DICTIONARY_STORAGE_KEY) || "[]");
    return normalizeDictionary([...DEFAULT_SPELL_DICTIONARY, ...saved]);
  } catch {
    return normalizeDictionary(DEFAULT_SPELL_DICTIONARY);
  }
}

function loadProjectHistoryMeta() {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_HISTORY_META_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function normalizeDictionary(words) {
  const seen = new Set();
  return words
    .map((word) => String(word || "").trim())
    .filter(Boolean)
    .filter((word) => {
      const key = word.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.localeCompare(b));
}

async function runSpellCheck(fileOrDocumentId, customDictionary) {
  const response = await fetch(`/api/runs/${fileOrDocumentId}/spell-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom_dictionary: customDictionary })
  });
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
