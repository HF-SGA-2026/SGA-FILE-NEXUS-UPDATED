const SYSTEM_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const PREVIEW_RENDER_LIMIT = 1000;
const REPORT_MIME = "text/csv;charset=utf-8";
const QUARANTINE_FOLDER = "SGA_FILE_NEXUS_QUARANTINE";
const BACKEND_URL_STORAGE_KEY = "sgaFileNexusBackendUrl";

const DEFAULT_PROTECTED_RULES = [
  "Archive",
  "Templates",
  "DO NOT DELETE",
  "_Active",
  "Client Root",
  QUARANTINE_FOLDER
].join("\n");

const PRESETS = {
  daily: {
    emptyDefinition: "ignored",
    ageFilter: "0",
    protectedRules: DEFAULT_PROTECTED_RULES
  },
  weekly: {
    emptyDefinition: "ignored",
    ageFilter: "30",
    protectedRules: DEFAULT_PROTECTED_RULES
  },
  archive: {
    emptyDefinition: "ignored",
    ageFilter: "90",
    protectedRules: ["DO NOT DELETE", "_Active", "Legal Hold", "Client Root", QUARANTINE_FOLDER].join("\n")
  },
  clientSafe: {
    emptyDefinition: "strict",
    ageFilter: "60",
    protectedRules: ["Archive", "Templates", "DO NOT DELETE", "_Active", "Legal Hold", "Client Root", QUARANTINE_FOLDER].join("\n")
  }
};

const state = {
  sourceKind: "",
  sourceLabel: "",
  mainFolderName: "",
  scannedFolders: 0,
  rootHandle: null,
  hasWriteAccess: false,
  directories: new Map(),
  files: [],
  parentFolders: new Map(),
  selectedParents: new Set(),
  allReviewRows: [],
  reviewRows: [],
  filteredRows: [],
  selectedFolders: new Set(),
  selectedPreviewPath: "",
  activeTab: "cleanup",
  hygieneRows: [],
  filteredHygieneRows: [],
  processedRows: new Set(),
  discardedRows: [],
  failures: [],
  reportBlob: null,
  reportUrl: "",
  reportName: "",
  backendRootPath: "",
  backendStats: null,
  backendAbortController: null,
  backendAvailable: false,
  backendPathReady: false,
  checkedBackendPath: "",
  processing: false,
  metrics: {
    total: 0,
    completed: 0,
    startTime: 0
  }
};

const els = {
  dropZone: document.getElementById("dropZone"),
  chooseFolderButton: document.getElementById("chooseFolderButton"),
  folderInput: document.getElementById("folderInput"),
  clearButton: document.getElementById("clearButton"),
  selectAllButton: document.getElementById("selectAllButton"),
  deselectAllButton: document.getElementById("deselectAllButton"),
  renameButton: document.getElementById("renameButton"),
  selectReadyButton: document.getElementById("selectReadyButton"),
  discardButton: document.getElementById("discardButton"),
  downloadButton: document.getElementById("downloadButton"),
  downloadWorkbookButton: document.getElementById("downloadWorkbookButton"),
  downloadPdfButton: document.getElementById("downloadPdfButton"),
  clearLogButton: document.getElementById("clearLogButton"),
  cleanupTabButton: document.getElementById("cleanupTabButton"),
  hygieneTabButton: document.getElementById("hygieneTabButton"),
  cleanupTabPanel: document.getElementById("cleanupTabPanel"),
  hygieneTabPanel: document.getElementById("hygieneTabPanel"),
  parentList: document.getElementById("parentList"),
  folderSummary: document.getElementById("folderSummary"),
  previewBody: document.getElementById("previewBody"),
  reviewSummaryStrip: document.getElementById("reviewSummaryStrip"),
  selectedActionCount: document.getElementById("selectedActionCount"),
  reviewBinCount: document.getElementById("reviewBinCount"),
  reviewBinSummary: document.getElementById("reviewBinSummary"),
  reviewBinList: document.getElementById("reviewBinList"),
  copySelectedPathsButton: document.getElementById("copySelectedPathsButton"),
  clearReviewBinButton: document.getElementById("clearReviewBinButton"),
  previewDetail: document.getElementById("previewDetail"),
  previewCount: document.getElementById("previewCount"),
  hygieneCount: document.getElementById("hygieneCount"),
  hygieneSummary: document.getElementById("hygieneSummary"),
  hygieneSummaryStrip: document.getElementById("hygieneSummaryStrip"),
  hygieneSearchInput: document.getElementById("hygieneSearchInput"),
  hygieneStatusFilter: document.getElementById("hygieneStatusFilter"),
  hygieneBody: document.getElementById("hygieneBody"),
  messageLog: document.getElementById("messageLog"),
  statusText: document.getElementById("statusText"),
  percentText: document.getElementById("percentText"),
  progressBar: document.getElementById("progressBar"),
  totalFiles: document.getElementById("totalFiles"),
  completedFiles: document.getElementById("completedFiles"),
  remainingFiles: document.getElementById("remainingFiles"),
  elapsedTime: document.getElementById("elapsedTime"),
  etaTime: document.getElementById("etaTime"),
  filesPerSecond: document.getElementById("filesPerSecond"),
  heicSpeed: document.getElementById("heicSpeed"),
  zipInfo: document.getElementById("zipInfo"),
  modeBanner: document.getElementById("modeBanner"),
  modeBannerLabel: document.getElementById("modeBannerLabel"),
  modeBannerText: document.getElementById("modeBannerText"),
  libraryStatus: document.getElementById("libraryStatus"),
  presetSelect: document.getElementById("presetSelect"),
  emptyDefinition: document.getElementById("emptyDefinition"),
  ageFilter: document.getElementById("ageFilter"),
  includeUnknownDates: document.getElementById("includeUnknownDates"),
  protectedRules: document.getElementById("protectedRules"),
  quarantineOption: document.getElementById("quarantineOption"),
  approvalCheck: document.getElementById("approvalCheck"),
  searchInput: document.getElementById("searchInput"),
  statusFilter: document.getElementById("statusFilter"),
  selectVisibleButton: document.getElementById("selectVisibleButton"),
  clearVisibleButton: document.getElementById("clearVisibleButton"),
  backendUrl: document.getElementById("backendUrl"),
  backendKey: document.getElementById("backendKey"),
  serverPathInput: document.getElementById("serverPathInput"),
  checkBackendButton: document.getElementById("checkBackendButton"),
  scanBackendButton: document.getElementById("scanBackendButton"),
  cancelBackendButton: document.getElementById("cancelBackendButton"),
  restoreBackendButton: document.getElementById("restoreBackendButton"),
  backendStatus: document.getElementById("backendStatus"),
  localModeStats: document.getElementById("localModeStats")
};

document.addEventListener("DOMContentLoaded", () => {
  initBackendFields();
  bindEvents();
  updateLibraryStatus();
  applyPreset("daily", false);
  resetUi();
  detectBackendAvailability();
  startEmbeddedSizing();
});

function startEmbeddedSizing() {
  if (window.parent === window || !new URLSearchParams(window.location.search).has("embedded")) return;

  const reportHeight = () => {
    window.parent.postMessage({
      type: "sga-folder-discarder-height",
      height: document.documentElement.scrollHeight
    }, window.location.origin);
  };

  reportHeight();
  if (window.ResizeObserver) {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  } else {
    window.addEventListener("resize", reportHeight);
  }
}

function bindEvents() {
  els.chooseFolderButton.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    if (state.processing) return;

    if (window.showDirectoryPicker) {
      await chooseServerFolder();
      return;
    }

    setStatus("Opening folder picker...", "loading");
    addLog("Opening upload fallback. This scan can miss truly empty folders because the browser only returns files.", "warn");
    els.folderInput.value = "";
    els.folderInput.click();
  });

  els.folderInput.addEventListener("change", event => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      setStatus("Folder selection canceled.", "neutral");
      addLog("Folder selection canceled. No folder was loaded.", "info");
      return;
    }
    loadFileList(files);
  });

  els.dropZone.addEventListener("dragover", event => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });

  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("dragging");
  });

  els.dropZone.addEventListener("drop", async event => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
    if (state.processing) return;
    const entries = entriesFromDrop(event.dataTransfer);
    if (entries.length) {
      await loadDroppedEntries(entries);
      return;
    }
    loadFileList(Array.from(event.dataTransfer.files || []));
  });

  els.clearButton.addEventListener("click", clearAll);
  els.selectAllButton.addEventListener("click", () => setAllParents(true));
  els.deselectAllButton.addEventListener("click", () => setAllParents(false));
  els.renameButton.addEventListener("click", applyScanRules);
  els.selectReadyButton.addEventListener("click", selectReadyOnly);
  els.discardButton.addEventListener("click", discardSelectedFolders);
  els.downloadButton.addEventListener("click", downloadReport);
  els.downloadWorkbookButton.addEventListener("click", downloadWorkbookReport);
  els.downloadPdfButton.addEventListener("click", downloadPdfReport);
  els.cleanupTabButton.addEventListener("click", () => switchTab("cleanup"));
  els.hygieneTabButton?.addEventListener("click", () => switchTab("hygiene"));
  els.checkBackendButton.addEventListener("click", checkBackendPath);
  els.scanBackendButton.addEventListener("click", () => scanBackendFolder(true));
  els.cancelBackendButton.addEventListener("click", cancelBackendOperation);
  els.restoreBackendButton.addEventListener("click", restoreLatestQuarantine);
  els.backendUrl.addEventListener("change", () => {
    localStorage.setItem(BACKEND_URL_STORAGE_KEY, els.backendUrl.value.trim());
  });
  els.serverPathInput.addEventListener("input", () => {
    state.backendPathReady = false;
    state.checkedBackendPath = "";
    if (state.backendAvailable) {
      els.backendStatus.textContent = "Path changed. Check Path before scanning.";
    }
    updateControls();
  });
  els.clearLogButton.addEventListener("click", () => {
    els.messageLog.innerHTML = "";
  });

  els.presetSelect.addEventListener("change", () => applyPreset(els.presetSelect.value, true));
  els.emptyDefinition.addEventListener("change", handleRuleChange);
  els.ageFilter.addEventListener("change", handleRuleChange);
  els.includeUnknownDates.addEventListener("change", handleRuleChange);
  els.protectedRules.addEventListener("change", event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    updateProtectedRuleStates();
    handleRuleChange();
  });
  els.quarantineOption.addEventListener("change", () => {
    renderPreview();
    updateControls();
  });
  els.approvalCheck.addEventListener("change", updateControls);
  els.searchInput.addEventListener("input", renderPreview);
  els.statusFilter.addEventListener("change", renderPreview);
  els.selectVisibleButton.addEventListener("click", () => setVisibleRowsSelected(true));
  els.clearVisibleButton.addEventListener("click", () => setVisibleRowsSelected(false));
  els.copySelectedPathsButton.addEventListener("click", copySelectedPaths);
  els.clearReviewBinButton.addEventListener("click", clearReviewBin);
  els.hygieneSearchInput.addEventListener("input", renderHygieneScan);
  els.hygieneStatusFilter.addEventListener("change", renderHygieneScan);
}

function initBackendFields() {
  const configuredUrl = window.SGA_FILE_NEXUS_CONFIG?.backendUrl || "";
  const savedUrl = localStorage.getItem(BACKEND_URL_STORAGE_KEY) || "";
  const sameOrigin = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  els.backendUrl.value = sameOrigin ? window.location.origin : (savedUrl || configuredUrl || "http://127.0.0.1:8787");
}

function updateLibraryStatus() {
  if (window.showDirectoryPicker && window.isSecureContext) {
    els.libraryStatus.textContent = "SERVER FOLDER ACCESS READY";
    els.libraryStatus.className = "library-status ok";
  } else {
    els.libraryStatus.textContent = "SCAN-ONLY FALLBACK READY";
    els.libraryStatus.className = "library-status warn";
  }
}

function switchTab(tabName) {
  state.activeTab = tabName;
  const showHygiene = tabName === "hygiene";
  els.cleanupTabButton.classList.toggle("active", !showHygiene);
  els.hygieneTabButton?.classList.toggle("active", showHygiene);
  els.cleanupTabButton.setAttribute("aria-selected", String(!showHygiene));
  els.hygieneTabButton?.setAttribute("aria-selected", String(showHygiene));
  els.cleanupTabPanel.hidden = showHygiene;
  els.hygieneTabPanel.hidden = !showHygiene;
  els.cleanupTabPanel.classList.toggle("active", !showHygiene);
  els.hygieneTabPanel.classList.toggle("active", showHygiene);
  if (showHygiene) renderHygieneScan();
}

async function detectBackendAvailability() {
  if (window.location.hostname.endsWith(".github.io")) {
    state.backendAvailable = false;
    state.backendPathReady = false;
    state.checkedBackendPath = "";
    updateModeBanner("preview");
    els.backendStatus.textContent = "Full Local Mode is unavailable on GitHub Pages. Browser Mode works independently; run the local backend to scan, quarantine, or restore server folders.";
    updateControls();
    return;
  }

  try {
    const health = await backendRequest("/api/health", { method: "GET" });
    state.backendAvailable = true;
    updateModeBanner("full");
    els.backendStatus.textContent = health.cleanupEnabled
      ? "Full Local Mode connected. Enter a folder path, then click Check Path."
      : "Server cleanup service is reachable, but no approved roots are configured.";
    els.localModeStats.textContent = health.quarantineFolder
      ? `Quarantine folder: ${health.quarantineFolder}.`
      : "Backend is reachable.";
    updateControls();
  } catch (error) {
    state.backendAvailable = false;
    state.backendPathReady = false;
    state.checkedBackendPath = "";
    updateModeBanner("preview");
    els.backendStatus.textContent = `Full Local Mode not connected: ${error.message}`;
    updateControls();
  }
}

async function checkBackendPath() {
  const rootPath = els.serverPathInput.value.trim();
  if (!rootPath) {
    setStatus("Enter a folder path first.", "warn");
    addLog("Enter a full local or network folder path before checking.", "warn");
    return;
  }

  state.processing = true;
  state.backendPathReady = false;
  state.checkedBackendPath = "";
  updateControls();
  setStatus("Checking folder path...", "loading");
  els.backendStatus.textContent = "Checking whether the backend can access this folder path...";
  addLog(`Checking path "${rootPath}"...`, "loading");

  try {
    const result = await backendRequest("/api/check-path", {
      method: "POST",
      body: { rootPath }
    });

    state.backendAvailable = true;
    state.backendPathReady = true;
    state.checkedBackendPath = pathKey(rootPath);
    state.backendRootPath = result.rootPath || rootPath;
    updateModeBanner("full");
    els.backendStatus.textContent = `Path checked: ${result.rootPath || rootPath}`;
    els.localModeStats.textContent = "Path is accessible. Scan Folder is ready.";
    setStatus("Path ready for scan.", "success");
    addLog(`Path accessible: ${result.rootPath || rootPath}`, "success");
  } catch (error) {
    state.backendPathReady = false;
    state.checkedBackendPath = "";
    if (looksLikeBackendUnavailable(error)) {
      state.backendAvailable = false;
      updateModeBanner("preview");
    }
    els.backendStatus.textContent = `Check Path failed: ${error.message}`;
    els.localModeStats.textContent = "Scan Folder is disabled until Check Path succeeds.";
    setStatus("Check Path failed.", "error");
    addLog(`Check Path failed: ${error.message}`, "error");
  } finally {
    state.processing = false;
    updateControls();
  }
}

async function scanBackendFolder(announceMissingPath) {
  const rootPath = els.serverPathInput.value.trim();
  if (!rootPath) {
    if (announceMissingPath) addLog("Enter an approved server folder path first.", "warn");
    return;
  }
  if (!isCurrentBackendPathReady()) {
    if (announceMissingPath) {
      addLog("Click Check Path and wait for it to pass before scanning this folder.", "warn");
      setStatus("Check Path required.", "warn");
    }
    updateControls();
    return;
  }

  state.processing = true;
  state.backendAbortController = new AbortController();
  updateControls();
  setProgressIndeterminate(true);
  setStatus("Scanning server backend...", "loading");
  els.backendStatus.textContent = "Scanning connected server path...";
  addLog(`Backend scanning "${rootPath}"...`, "loading");

  try {
    const scan = await backendRequest("/api/scan", {
      method: "POST",
      signal: state.backendAbortController.signal,
      body: {
        rootPath,
        settings: settingsPayload()
      }
    });
    loadBackendScan(scan);
    updateModeBanner("full");
    els.backendStatus.textContent = `Server scan complete. ${scan.scannedFolders} folders reviewed.`;
    updateLocalModeStats(scan.stats);
    if (scan.rows.length) {
      setStatus("Server scan loaded.", "success");
      addLog(`Backend scan loaded ${scan.rows.length} review row${scan.rows.length === 1 ? "" : "s"}.`, "success");
    } else {
      setStatus("Server scan finished: no empty folders.", "warn");
      addLog(emptyReviewMessage(), "info");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      els.backendStatus.textContent = "Server path scan canceled.";
      setStatus("Server path scan canceled.", "warn");
      addLog("Server path scan canceled.", "warn");
    } else {
      els.backendStatus.textContent = `Server path scan failed: ${error.message}`;
      setStatus("Server path scan failed.", "error");
      addLog(`Server path scan failed: ${error.message}`, "error");
    }
  } finally {
    state.processing = false;
    state.backendAbortController = null;
    setProgressIndeterminate(false);
    updateControls();
  }
}

function loadBackendScan(scan) {
  clearWorkingState();
  state.sourceKind = "backend";
  state.sourceLabel = scan.sourceLabel || "Firm server backend";
  state.mainFolderName = scan.mainFolderName || "Server Folder";
  state.scannedFolders = scan.scannedFolders || 0;
  state.backendStats = scan.stats || null;
  state.backendRootPath = scan.rootPath || els.serverPathInput.value.trim();
  state.hasWriteAccess = Boolean(scan.hasWriteAccess);
  state.directories = new Map([["backend", { path: "backend" }]]);
  state.parentFolders = new Map((scan.parentFolders || []).map(parent => [parent.name, parent]));
  state.selectedParents = new Set(state.parentFolders.keys());
  state.allReviewRows = (scan.rows || []).map(row => ({
    ...row,
    lastModified: row.lastModified || 0,
    canDiscard: row.status === "ready"
  }));
  state.reviewRows = state.allReviewRows.filter(row => state.selectedParents.has(row.parent));
  state.selectedFolders = new Set(state.reviewRows.filter(row => row.status === "ready").map(row => row.path));
  renderParentList();
  renderPreview();
  resetRunMetrics();
  buildReport();
  buildHygieneScan();
  renderHygieneScan();
  updateFolderSummary();
  setStatus("Finished");
}

function handleRuleChange() {
  if (state.sourceKind === "backend") {
    state.processedRows.clear();
    state.discardedRows = [];
    state.failures = [];
    setStatus("Scan rules changed.");
    addLog("Scan rules changed. Apply scan rules to refresh the server review list.");
    buildReport();
    updateControls();
    return;
  }
  applyScanRules();
}

function settingsPayload() {
  return {
    emptyDefinition: els.emptyDefinition.value,
    ageFilter: Number(els.ageFilter.value || 0),
    includeUnknownDates: els.includeUnknownDates.checked,
    protectedRules: protectedPatterns()
  };
}

function pathKey(value) {
  return String(value || "").trim().replace(/[\\/]+$/, "").toLowerCase();
}

function isCurrentBackendPathReady() {
  return Boolean(state.backendPathReady && state.checkedBackendPath && state.checkedBackendPath === pathKey(els.serverPathInput.value));
}

function looksLikeBackendUnavailable(error) {
  const message = String(error?.message || "");
  return /failed to fetch|networkerror|backend url is required|load failed/i.test(message);
}

async function backendRequest(pathname, options = {}) {
  const baseUrl = els.backendUrl.value.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("Backend URL is required.");
  }
  if (window.location.protocol === "https:" && baseUrl.startsWith("http://") && !baseUrl.startsWith("http://127.0.0.1") && !baseUrl.startsWith("http://localhost")) {
    throw new Error("GitHub Pages uses HTTPS, so the firm backend also needs an HTTPS URL.");
  }
  localStorage.setItem(BACKEND_URL_STORAGE_KEY, baseUrl);

  const headers = {
    "Content-Type": "application/json"
  };
  const backendKey = els.backendKey.value.trim();
  if (backendKey) {
    headers["X-SGA-Nexus-Key"] = backendKey;
  }

  const method = options.method || "POST";
  const requestRecord = {
    pathname,
    method,
    status: "pending",
    ok: false,
    startedAt: new Date().toISOString()
  };
  window.SGA_FILE_NEXUS_REQUESTS = window.SGA_FILE_NEXUS_REQUESTS || [];
  window.SGA_FILE_NEXUS_REQUESTS.push(requestRecord);

  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal
    });
    requestRecord.status = response.status;
    requestRecord.ok = response.ok;
  } catch (error) {
    requestRecord.status = "network_error";
    requestRecord.error = error.message;
    throw error;
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Backend request failed (${response.status})`);
  }

  return payload;
}

async function cancelBackendOperation() {
  if (!state.processing) return;
  if (state.backendAbortController) {
    state.backendAbortController.abort();
  }
  try {
    await backendRequest("/api/cancel", { method: "POST" });
    addLog("Cancel requested for the backend scan.", "warn");
  } catch (error) {
    addLog(`Cancel request could not reach the backend: ${error.message}`, "warn");
  }
}

async function restoreLatestQuarantine() {
  const rootPath = els.serverPathInput.value.trim() || state.backendRootPath;
  if (!rootPath) {
    addLog("Enter the server folder path before restoring quarantine.", "warn");
    return;
  }

  const confirmed = window.confirm("Restore the latest quarantine run for this server path?");
  if (!confirmed) {
    addLog("Restore canceled.", "warn");
    return;
  }

  state.processing = true;
  updateControls();
  setProgressIndeterminate(true);
  setStatus("Restoring quarantine...", "loading");
  addLog("Restoring latest quarantine run...", "loading");

  try {
    const result = await backendRequest("/api/restore", {
      method: "POST",
      body: { rootPath }
    });

    for (const restored of result.restored || []) {
      addLog(`Restored: ${restored.path}`, "success");
    }
    for (const failure of result.failures || []) {
      addLog(`Restore failed: ${failure.path} (${failure.message})`, "error");
    }

    els.backendStatus.textContent = result.message || "Restore finished.";
    els.zipInfo.textContent = result.quarantinePath
      ? `Latest restore checked quarantine path: ${result.quarantinePath}`
      : "Restore finished.";
    setStatus(result.failures?.length ? "Restore finished with failures." : "Restore finished.", result.failures?.length ? "warn" : "success");
    addLog(result.message || "Restore finished.", result.failures?.length ? "warn" : "success");
  } catch (error) {
    els.backendStatus.textContent = `Restore failed: ${error.message}`;
    setStatus("Restore failed.", "error");
    addLog(`Restore failed: ${error.message}`, "error");
  } finally {
    state.processing = false;
    setProgressIndeterminate(false);
    updateControls();
  }
}

function applyPreset(name, shouldApplyRules) {
  const preset = PRESETS[name] || PRESETS.daily;
  els.emptyDefinition.value = preset.emptyDefinition;
  els.ageFilter.value = preset.ageFilter;
  setProtectedRules(preset.protectedRules);
  if (shouldApplyRules) {
    applyScanRules();
    addLog(`${els.presetSelect.options[els.presetSelect.selectedIndex].text} preset applied.`);
  }
}

function setProtectedRules(ruleText) {
  const selectedRules = new Set(String(ruleText || "")
    .split(/[\n,]+/)
    .map(rule => rule.trim())
    .filter(Boolean)
    .map(rule => rule.toLowerCase()));

  els.protectedRules.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = selectedRules.has(input.value.toLowerCase());
  });
  updateProtectedRuleStates();
}

function updateProtectedRuleStates() {
  els.protectedRules.querySelectorAll(".protected-rule-toggle").forEach(label => {
    const input = label.querySelector('input[type="checkbox"]');
    label.classList.toggle("selected", Boolean(input?.checked));
  });
}

async function chooseServerFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    setStatus(`Folder selected: ${handle.name}. Checking access...`, "loading");
    addLog(`Folder selected: ${handle.name}. Starting scan...`, "loading");
    const permission = await requestFolderPermission(handle);
    await loadDirectoryHandle(handle, permission === "granted");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("Folder selection canceled.", "neutral");
      return;
    }
    setStatus("Folder access failed.", "error");
    addLog(`Folder access failed: ${error.message}`, "error");
  }
}

async function requestFolderPermission(handle) {
  if (!handle.queryPermission || !handle.requestPermission) {
    return "prompt";
  }

  const options = { mode: "readwrite" };
  try {
    const current = await handle.queryPermission(options);
    if (current === "granted") return current;
    return await handle.requestPermission(options);
  } catch {
    return "denied";
  }
}

async function loadDirectoryHandle(rootHandle, hasWriteAccess) {
  clearWorkingState();
  updateModeBanner("preview");
  state.sourceKind = "server";
  state.sourceLabel = hasWriteAccess ? "Server folder with cleanup access" : "Server folder scan only";
  state.mainFolderName = rootHandle.name || "Selected Server Folder";
  state.rootHandle = rootHandle;
  state.hasWriteAccess = hasWriteAccess;
  state.metrics.startTime = performance.now();

  setStatus("Scanning folders...", "loading");
  addLog(`Scanning "${state.mainFolderName}"...`, "loading");

  try {
    await scanDirectoryHandle(rootHandle, state.mainFolderName, "", null);
    finishScan();
    if (!hasWriteAccess) {
      addLog("Write access was not granted. The scan and report are available, but discard is disabled.", "warn");
    }
  } catch (error) {
    setStatus("Scan failed.", "error");
    addLog(`Scan failed: ${error.message}`, "error");
    updateControls();
  }
}

async function scanDirectoryHandle(dirHandle, currentPath, parentPath, parentHandle) {
  const directory = ensureDirectory(currentPath, { handle: dirHandle, parentPath, parentHandle });
  let scanned = 0;

  for await (const [name, handle] of dirHandle.entries()) {
    const childPath = pathJoin(currentPath, name);
    if (handle.kind === "directory") {
      directory.childDirs.add(childPath);
      await scanDirectoryHandle(handle, childPath, currentPath, dirHandle);
    } else if (handle.kind === "file") {
      const file = await handle.getFile();
      addScannedFile(file, childPath, { handle, parentHandle: dirHandle });
    }
    scanned += 1;
    if (scanned % 40 === 0) {
      setStatus(`Scanning folders... ${state.directories.size} folders`, "loading");
      await yieldToBrowser();
    }
  }
}

async function loadDroppedEntries(entries) {
  clearWorkingState();
  updateModeBanner("preview");
  state.sourceKind = "drop";
  state.sourceLabel = "Dropped folder scan only";
  state.metrics.startTime = performance.now();
  setStatus("Scanning folders...", "loading");
  addLog("Scanning dropped folder...", "loading");

  try {
    for (const entry of entries) {
      await readDroppedEntry(entry, "");
    }
    finishScan();
    addLog("Dropped folder loaded for review.", "info");
  } catch (error) {
    setStatus("Dropped folder scan failed.", "error");
    addLog(`Dropped folder scan failed: ${error.message}`, "error");
    updateControls();
  }
}

function entriesFromDrop(dataTransfer) {
  return Array.from(dataTransfer.items || [])
    .map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
    .filter(Boolean);
}

function readDroppedEntry(entry, prefix) {
  return new Promise(resolve => {
    const currentPath = normalizePath(pathJoin(prefix, entry.name));

    if (entry.isFile) {
      entry.file(file => {
        addScannedFile(file, currentPath);
        resolve();
      }, () => resolve());
      return;
    }

    if (entry.isDirectory) {
      const parentPath = normalizePath(prefix).replace(/\/$/, "");
      ensureDirectory(currentPath, { parentPath });
      if (parentPath) {
        ensureDirectory(parentPath).childDirs.add(currentPath);
      }

      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async children => {
          if (!children.length) {
            resolve();
            return;
          }
          for (const child of children) {
            await readDroppedEntry(child, currentPath);
          }
          readBatch();
        }, () => resolve());
      };
      readBatch();
      return;
    }

    resolve();
  });
}

function loadFileList(files) {
  clearWorkingState();
  updateModeBanner("preview");
  state.sourceKind = "file";
  state.sourceLabel = "Folder upload scan only";
  state.metrics.startTime = performance.now();
  setStatus("Scanning folders...", "loading");
  addLog("Scanning selected folder...", "loading");

  const normalized = files
    .map(file => ({ file, path: normalizePath(file.webkitRelativePath || file.relativePath || file.name) }))
    .filter(item => item.path);

  if (!normalized.length) {
    addLog("No usable files were found.", "warn");
    resetUi();
    setStatus("No usable files found.", "warn");
    return;
  }

  for (const item of normalized) {
    addScannedFile(item.file, item.path);
  }

  finishScan();
  addLog("Folder loaded for review.", "success");
}

function addScannedFile(file, filePath, options = {}) {
  const path = normalizePath(filePath);
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return;

  for (let index = 1; index < parts.length; index += 1) {
    const dirPath = parts.slice(0, index).join("/");
    const parentPath = index > 1 ? parts.slice(0, index - 1).join("/") : "";
    const directory = ensureDirectory(dirPath, { parentPath });
    if (parentPath) {
      ensureDirectory(parentPath).childDirs.add(dirPath);
    }
  }

  const parentPath = parts.slice(0, -1).join("/");
  const fileName = parts[parts.length - 1];
  const record = {
    file,
    handle: options.handle || null,
    parentHandle: options.parentHandle || null,
    path,
    parentPath,
    name: fileName,
    size: file.size || 0,
    lastModified: file.lastModified || 0,
    isSystem: isSystemFileName(fileName)
  };

  ensureDirectory(parentPath).files.push(record);
  state.files.push(record);
}

function ensureDirectory(path, options = {}) {
  const normalized = normalizePath(path);
  if (!normalized) {
    return null;
  }

  if (!state.directories.has(normalized)) {
    state.directories.set(normalized, {
      path: normalized,
      name: normalized.split("/").pop(),
      parentPath: options.parentPath || "",
      handle: options.handle || null,
      parentHandle: options.parentHandle || null,
      childDirs: new Set(),
      files: [],
      depth: normalized.split("/").filter(Boolean).length,
      subtreeFileCount: 0,
      subtreeSystemFileCount: 0,
      subtreeUsableFileCount: 0,
      subtreeDirectoryCount: 0,
      lastModified: 0
    });
  }

  const directory = state.directories.get(normalized);
  if (options.handle) directory.handle = options.handle;
  if (options.parentHandle) directory.parentHandle = options.parentHandle;
  if (options.parentPath) directory.parentPath = options.parentPath;
  return directory;
}

function finishScan() {
  const firstPath = [...state.directories.keys()][0] || state.files[0]?.path || "";
  state.mainFolderName = state.mainFolderName || commonMainFolder(firstPath) || "Selected Server Folder";
  state.scannedFolders = state.directories.size;
  rebuildParentFolders();
  state.selectedParents = new Set(state.parentFolders.keys());
  applyScanRules();

  updateFolderSummary();
  if (state.allReviewRows.length) {
    setStatus("Folder scan loaded.", "success");
    addLog(`Loaded "${state.mainFolderName}" with ${state.directories.size} folders scanned and ${state.allReviewRows.length} review row${state.allReviewRows.length === 1 ? "" : "s"}.`, "success");
  } else {
    setStatus("Scan finished: no review rows.", "warn");
    addLog(`Loaded "${state.mainFolderName}" with ${state.directories.size} folders scanned.`, "success");
    addLog(emptyReviewMessage(), state.sourceKind === "backend" ? "info" : "warn");
  }
}

function rebuildParentFolders() {
  state.parentFolders = new Map();

  for (const directory of state.directories.values()) {
    const parts = directory.path.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    const parent = parts[1];
    if (!state.parentFolders.has(parent)) {
      state.parentFolders.set(parent, {
        name: parent,
        folderCount: 0,
        emptyCount: 0,
        protectedCount: 0
      });
    }
    state.parentFolders.get(parent).folderCount += 1;
  }
}

function applyScanRules() {
  if (state.sourceKind === "backend") {
    scanBackendFolder(false);
    return;
  }

  if (!state.directories.size) {
    updateControls();
    return;
  }

  const previouslySelected = new Set(state.selectedFolders);
  computeDirectoryAggregates();
  state.allReviewRows = buildReviewRows();
  syncParentCounts();
  state.reviewRows = state.allReviewRows.filter(row => state.selectedParents.has(row.parent));

  const readyRows = state.reviewRows.filter(row => row.status === "ready");
  state.selectedFolders = new Set(
    readyRows
      .filter(row => !previouslySelected.size || previouslySelected.has(row.path))
      .map(row => row.path)
  );
  if (!previouslySelected.size) {
    state.selectedFolders = new Set(readyRows.map(row => row.path));
  }

  state.processedRows.clear();
  state.discardedRows = [];
  state.failures = [];
  renderParentList();
  renderPreview();
  resetRunMetrics();
  updateFolderSummary();
  buildReport();
  buildHygieneScan();
  renderHygieneScan();
  updateControls();
}

function computeDirectoryAggregates() {
  for (const directory of state.directories.values()) {
    directory.subtreeFileCount = directory.files.length;
    directory.subtreeSystemFileCount = directory.files.filter(file => file.isSystem).length;
    directory.subtreeUsableFileCount = directory.files.filter(file => !file.isSystem).length;
    directory.subtreeDirectoryCount = directory.childDirs.size;
    directory.lastModified = directory.files.reduce((latest, file) => Math.max(latest, file.lastModified || 0), 0);
  }

  const directories = [...state.directories.values()].sort((a, b) => b.depth - a.depth);
  for (const directory of directories) {
    const parent = directory.parentPath ? state.directories.get(directory.parentPath) : null;
    if (!parent) continue;
    parent.subtreeFileCount += directory.subtreeFileCount;
    parent.subtreeSystemFileCount += directory.subtreeSystemFileCount;
    parent.subtreeUsableFileCount += directory.subtreeUsableFileCount;
    parent.subtreeDirectoryCount += directory.subtreeDirectoryCount;
    parent.lastModified = Math.max(parent.lastModified, directory.lastModified);
  }
}

function buildReviewRows() {
  const rows = [];
  const patterns = protectedPatterns();
  const strictMode = els.emptyDefinition.value === "strict";
  const minAgeDays = Number(els.ageFilter.value || 0);
  const includeUnknownDates = els.includeUnknownDates.checked;

  for (const directory of state.directories.values()) {
    const parts = directory.path.split("/").filter(Boolean);
    if (parts.length < 2) continue;

    const parent = parts[1];
    const protectedReason = protectedReasonForPath(directory.path, patterns);
    const strictEmpty = directory.files.length === 0 && directory.childDirs.size === 0;
    const ignoredEmpty = directory.subtreeUsableFileCount === 0;
    const qualifies = strictMode ? strictEmpty : ignoredEmpty;
    if (!qualifies) continue;

    const age = ageStatus(directory.lastModified, minAgeDays, includeUnknownDates);
    const status = protectedReason || !age.ok ? "protected" : "ready";
    const reason = protectedReason || age.reason || emptyReason(directory, strictMode);

    rows.push({
      path: directory.path,
      name: directory.name,
      parent,
      secondary: parts[2] || "",
      depth: directory.depth,
      lastModified: directory.lastModified,
      status,
      reason,
      canDiscard: status === "ready",
      handle: directory.handle,
      parentHandle: directory.parentHandle,
      subtreeFileCount: directory.subtreeFileCount,
      subtreeSystemFileCount: directory.subtreeSystemFileCount,
      subtreeDirectoryCount: directory.subtreeDirectoryCount
    });
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
}

function syncParentCounts() {
  for (const parent of state.parentFolders.values()) {
    parent.emptyCount = 0;
    parent.protectedCount = 0;
  }

  for (const row of state.allReviewRows) {
    const parent = state.parentFolders.get(row.parent);
    if (!parent) continue;
    if (row.status === "ready") parent.emptyCount += 1;
    if (row.status === "protected") parent.protectedCount += 1;
  }
}

function renderParentList() {
  els.parentList.innerHTML = "";

  const visibleParents = [...state.parentFolders.values()]
    .filter(parent => parent.emptyCount || parent.protectedCount)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!visibleParents.length) {
    els.parentList.innerHTML = `<div class="empty-state">${escapeHtml(emptyReviewMessage("parent"))}</div>`;
    return;
  }

  for (const parent of visibleParents) {
    const id = `parent-${slug(parent.name)}`;
    const label = document.createElement("label");
    label.className = `parent-item${state.selectedParents.has(parent.name) ? " selected" : ""}`;
    label.title = "Select or clear every reviewed empty folder under this parent folder.";
    label.innerHTML = `
      <input type="checkbox" id="${id}" ${state.selectedParents.has(parent.name) ? "checked" : ""}>
      <span class="parent-name"></span>
      <span class="parent-meta">${parent.folderCount} folders, ${parent.emptyCount} ready, ${parent.protectedCount} protected</span>
    `;
    label.querySelector(".parent-name").textContent = parent.name;
    label.querySelector("input").addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedParents.add(parent.name);
      } else {
        state.selectedParents.delete(parent.name);
      }
      state.reviewRows = state.allReviewRows.filter(row => state.selectedParents.has(row.parent));
      state.selectedFolders = new Set(
        [...state.selectedFolders].filter(path => state.reviewRows.some(row => row.path === path))
      );
      renderPreview();
      resetRunMetrics();
      buildReport();
      updateControls();
    });
    els.parentList.appendChild(label);
  }
}

function renderPreview() {
  const search = els.searchInput.value.trim().toLowerCase();
  const statusFilter = els.statusFilter.value;
  state.filteredRows = state.reviewRows.filter(row => {
    const actualStatus = statusForRow(row);
    const matchesStatus = statusFilter === "all" || actualStatus === statusFilter;
    const matchesSearch = !search || `${row.parent} ${row.path} ${row.reason}`.toLowerCase().includes(search);
    return matchesStatus && matchesSearch;
  });

  els.previewCount.textContent = `${state.filteredRows.length} folders`;

  if (!state.reviewRows.length) {
    els.previewBody.innerHTML = state.discardedRows.length
      ? '<tr><td colspan="5" class="empty-state">No empty folders remain in the review list. Discarded folders are saved in the audit report.</td></tr>'
      : `<tr><td colspan="5" class="empty-state">${escapeHtml(emptyReviewMessage())}</td></tr>`;
    renderReviewSummary();
    renderReviewBin();
    renderPreviewDetail(null);
    updateControls();
    return;
  }

  if (!state.filteredRows.length) {
    els.previewBody.innerHTML = '<tr><td colspan="5" class="empty-state">No folders match the current search or status filter.</td></tr>';
    renderReviewSummary();
    renderReviewBin();
    renderPreviewDetail(null);
    updateControls();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of state.filteredRows.slice(0, PREVIEW_RENDER_LIMIT)) {
    const tr = document.createElement("tr");
    const actualStatus = statusForRow(row);
    tr.className = rowClassForRow(row, actualStatus);
    tr.addEventListener("click", event => {
      if (event.target.closest("button, input")) return;
      state.selectedPreviewPath = row.path;
      if (row.canDiscard && actualStatus === "ready" && !state.processing) {
        toggleRowSelection(row);
        resetRunMetrics();
        buildReport();
      }
      renderPreview();
    });
    const checkbox = document.createElement("input");
    checkbox.className = "table-check";
    checkbox.type = "checkbox";
    checkbox.dataset.path = row.path;
    checkbox.checked = state.selectedFolders.has(row.path) && row.canDiscard && actualStatus === "ready";
    checkbox.disabled = !row.canDiscard || actualStatus !== "ready" || state.processing;
    checkbox.addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedFolders.add(row.path);
      } else {
        state.selectedFolders.delete(row.path);
      }
      resetRunMetrics();
      buildReport();
      renderReviewSummary();
      renderReviewBin();
      updateControls();
      renderPreview();
    });

    const checkCell = document.createElement("td");
    checkCell.className = "review-square-cell";
    checkCell.appendChild(checkbox);
    const pathCell = folderPathCell(row);
    const displayStatus = statusDisplayForRow(row, actualStatus);
    tr.append(
      checkCell,
      cell(row.parent),
      pathCell,
      cell(formatDate(row.lastModified)),
      statusCell(displayStatus, row.reason)
    );
    fragment.appendChild(tr);
  }

  els.previewBody.innerHTML = "";
  els.previewBody.appendChild(fragment);

  if (state.filteredRows.length > PREVIEW_RENDER_LIMIT) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="empty-state">Preview limited to the first ${PREVIEW_RENDER_LIMIT} rows for speed. ${state.filteredRows.length} folders match the current filters.</td>`;
    els.previewBody.appendChild(tr);
  }

  const previewRow = state.filteredRows.find(row => row.path === state.selectedPreviewPath) || state.filteredRows[0];
  state.selectedPreviewPath = previewRow?.path || "";
  renderReviewSummary();
  renderReviewBin();
  renderPreviewDetail(previewRow || null);
  updateControls();
}

function rowClassForRow(row, status) {
  const classes = ["review-row", `row-${status}`];
  if (state.selectedFolders.has(row.path) && row.canDiscard && status === "ready") classes.push("row-selected");
  if (status === "protected" || status === "failed") classes.push("row-needs-attention");
  if (els.quarantineOption.checked && state.selectedFolders.has(row.path) && row.canDiscard) classes.push("row-backup-planned");
  if (row.path === state.selectedPreviewPath) classes.push("row-preview-active");
  return classes.join(" ");
}

function statusDisplayForRow(row, status) {
  if (status === "ready" && state.selectedFolders.has(row.path) && els.quarantineOption.checked) {
    return "backup planned";
  }
  if (status === "ready" && state.selectedFolders.has(row.path)) {
    return "selected";
  }
  return status;
}

function toggleRowSelection(row) {
  if (state.selectedFolders.has(row.path)) {
    state.selectedFolders.delete(row.path);
  } else {
    state.selectedFolders.add(row.path);
  }
}

function renderReviewSummary() {
  const ready = state.reviewRows.filter(row => statusForRow(row) === "ready").length;
  const selected = state.reviewRows.filter(row => state.selectedFolders.has(row.path) && row.canDiscard).length;
  const protectedCount = state.reviewRows.filter(row => statusForRow(row) === "protected").length;
  const failed = state.reviewRows.filter(row => statusForRow(row) === "failed").length;
  const backupPlanned = els.quarantineOption.checked ? selected : 0;
  els.reviewSummaryStrip.innerHTML = `
    <span><strong>${ready}</strong> Ready</span>
    <span class="summary-selected"><strong>${selected}</strong> Selected</span>
    <span><strong>${protectedCount}</strong> Protected</span>
    <span><strong>${failed}</strong> Failed</span>
    <span><strong>${backupPlanned}</strong> Backup planned</span>
  `;
  els.selectedActionCount.textContent = `${selected} selected`;
}

function renderReviewBin() {
  const selectedRows = state.reviewRows
    .filter(row => state.selectedFolders.has(row.path) && row.canDiscard && statusForRow(row) === "ready")
    .sort((a, b) => a.path.localeCompare(b.path));
  els.reviewBinCount.textContent = selectedRows.length;
  els.reviewBinSummary.textContent = selectedRows.length
    ? `${selectedRows.length} ready folder${selectedRows.length === 1 ? "" : "s"} staged for final review${els.quarantineOption.checked ? " with quarantine first" : ""}.`
    : "Selected ready folders appear here before cleanup.";

  if (!selectedRows.length) {
    els.reviewBinList.innerHTML = "";
    return;
  }

  const visibleRows = selectedRows.slice(0, 6);
  els.reviewBinList.innerHTML = visibleRows
    .map(row => `<button class="review-bin-item${els.quarantineOption.checked ? " backup-planned" : ""}" type="button" data-path="${escapeHtml(row.path)}">${escapeHtml(row.path)}</button>`)
    .join("");
  if (selectedRows.length > visibleRows.length) {
    els.reviewBinList.insertAdjacentHTML("beforeend", `<div class="review-bin-more">+${selectedRows.length - visibleRows.length} more selected</div>`);
  }
  els.reviewBinList.querySelectorAll(".review-bin-item").forEach(button => {
    button.addEventListener("click", () => {
      state.selectedPreviewPath = button.dataset.path;
      renderPreview();
    });
  });
}

function renderPreviewDetail(row) {
  if (!row) {
    els.previewDetail.className = "preview-detail muted";
    els.previewDetail.textContent = state.mainFolderName
      ? emptyReviewMessage("detail")
      : "Select a review row to preview folder details before cleanup.";
    return;
  }

  const status = statusForRow(row);
  const copyable = absolutePathForRow(row);
  els.previewDetail.className = `preview-detail detail-${status}`;
  els.previewDetail.innerHTML = `
    <div>
      <p class="eyebrow">Preview</p>
      <h3>${escapeHtml(row.name || row.path)}</h3>
    </div>
    <div class="detail-grid">
      <span><strong>Parent</strong>${escapeHtml(row.parent || "Unknown")}</span>
      <span><strong>Status</strong>${escapeHtml(status)}</span>
      <span><strong>Modified</strong>${escapeHtml(formatDate(row.lastModified))}</span>
      <span><strong>System files</strong>${row.subtreeSystemFileCount || 0}</span>
      <span><strong>Subfolders</strong>${row.subtreeDirectoryCount || 0}</span>
      <span><strong>Copyable path</strong>${escapeHtml(copyable)}</span>
    </div>
    <p><strong>Why:</strong> ${escapeHtml(row.reason || "Ready for review.")}</p>
  `;
}

function setAllParents(checked) {
  state.selectedParents = checked ? new Set(state.parentFolders.keys()) : new Set();
  state.reviewRows = state.allReviewRows.filter(row => state.selectedParents.has(row.parent));
  state.selectedFolders = checked
    ? new Set(state.reviewRows.filter(row => row.status === "ready").map(row => row.path))
    : new Set();
  renderParentList();
  renderPreview();
  resetRunMetrics();
  buildReport();
  updateControls();
}

function setVisibleRowsSelected(checked) {
  for (const row of state.filteredRows) {
    if (!row.canDiscard || statusForRow(row) !== "ready") continue;
    if (checked) {
      state.selectedFolders.add(row.path);
    } else {
      state.selectedFolders.delete(row.path);
    }
  }
  renderPreview();
  resetRunMetrics();
  buildReport();
  updateControls();
}

function selectReadyOnly() {
  state.selectedFolders = new Set(
    state.reviewRows
      .filter(row => row.canDiscard && statusForRow(row) === "ready")
      .map(row => row.path)
  );
  renderPreview();
  resetRunMetrics();
  buildReport();
  updateControls();
  addLog(`Selected ${state.selectedFolders.size} ready folder${state.selectedFolders.size === 1 ? "" : "s"} for review.`);
}

function clearReviewBin() {
  state.selectedFolders.clear();
  renderPreview();
  resetRunMetrics();
  buildReport();
  updateControls();
  addLog("Review Bin cleared.");
}

async function copySelectedPaths() {
  const selectedRows = state.reviewRows
    .filter(row => state.selectedFolders.has(row.path) && row.canDiscard && statusForRow(row) === "ready")
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!selectedRows.length) {
    addLog("No selected folder paths to copy.", "warn");
    return;
  }
  const text = selectedRows.map(row => absolutePathForRow(row)).join("\n");
  const copied = await copyTextToClipboard(text);
  addLog(copied
    ? `Copied ${selectedRows.length} selected folder path${selectedRows.length === 1 ? "" : "s"}.`
    : "Selected paths could not be copied automatically.",
    copied ? "info" : "warn");
}

function confirmCleanupReview(rows, options) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const listedRows = rows.slice(0, 8);
    const hiddenCount = Math.max(0, rows.length - listedRows.length);
    overlay.innerHTML = `
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmCleanupTitle">
        <p class="eyebrow">Final review</p>
        <h2 id="confirmCleanupTitle">${escapeHtml(options.action)} ${rows.length} folder${rows.length === 1 ? "" : "s"}</h2>
        <div class="confirm-summary">
          <span><strong>${rows.length}</strong> selected</span>
          <span><strong>${els.quarantineOption.checked ? "Yes" : "No"}</strong> quarantine first</span>
          <span><strong>${escapeHtml(options.source)}</strong> source</span>
        </div>
        <p class="confirm-copy">Review these paths one more time. Only ready folders in the Review Bin are included.</p>
        <div class="confirm-list">
          ${listedRows.map(row => `<div>${escapeHtml(absolutePathForRow(row))}</div>`).join("")}
          ${hiddenCount ? `<div>+${hiddenCount} more selected folders</div>` : ""}
        </div>
        <div class="button-row confirm-actions">
          <button class="button secondary" type="button" data-action="cancel">Cancel</button>
          <button class="button success" type="button" data-action="confirm">Confirm Cleanup</button>
        </div>
      </section>
    `;
    document.body.appendChild(overlay);

    const finish = value => {
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener("click", event => {
      if (event.target === overlay || event.target.dataset.action === "cancel") finish(false);
      if (event.target.dataset.action === "confirm") finish(true);
    });
    overlay.querySelector('[data-action="cancel"]').focus();
  });
}

async function discardSelectedFolders() {
  const selectedRows = state.reviewRows
    .filter(row => state.selectedFolders.has(row.path) && row.canDiscard && statusForRow(row) === "ready");

  if (!selectedRows.length) {
    addLog("Select at least one ready empty folder.", "warn");
    return;
  }

  if (!els.approvalCheck.checked) {
    addLog("Review approval is required before discarding folders.", "warn");
    return;
  }

  if (state.sourceKind === "backend") {
    await discardSelectedFoldersWithBackend(selectedRows);
    return;
  }

  if (!state.hasWriteAccess || !state.rootHandle) {
    addLog("This browser review is scan-only. Use the firm server backend for server cleanup.", "warn");
    return;
  }

  const action = els.quarantineOption.checked ? "quarantine and discard" : "discard";
  const compressedTargets = compressTargets(selectedRows);
  const confirmed = await confirmCleanupReview(compressedTargets, {
    action,
    source: "browser folder access"
  });
  if (!confirmed) {
    addLog("Cleanup canceled during confirmation.", "warn");
    return;
  }

  state.processing = true;
  state.metrics = {
    total: compressedTargets.length,
    completed: 0,
    startTime: performance.now()
  };
  updateMetrics();
  updateControls();
  setStatus(els.quarantineOption.checked ? "Quarantining folders..." : "Discarding folders...", "loading");
  addLog(`${els.quarantineOption.checked ? "Quarantine cleanup" : "Cleanup"} started for ${compressedTargets.length} folders.`, "loading");

  let quarantineHandle = null;
  if (els.quarantineOption.checked) {
    quarantineHandle = await createQuarantineHandle();
    addLog(`Quarantine folder created: ${QUARANTINE_FOLDER}.`);
  }

  for (const row of compressedTargets.sort((a, b) => b.depth - a.depth)) {
    try {
      if (!row.parentHandle || !row.handle) {
        throw new Error("Folder handle unavailable.");
      }
      const validation = await validateFolderStillDiscardable(row.handle, els.emptyDefinition.value);
      if (!validation.ok) {
        throw new Error(validation.reason);
      }
      if (quarantineHandle) {
        await mirrorFolderToQuarantine(row.handle, quarantineHandle, row.path.split("/").filter(Boolean));
      }
      await row.parentHandle.removeEntry(row.name, { recursive: true });
      markProcessed(row.path);
      addLog(`${quarantineHandle ? "Quarantined and discarded" : "Discarded"}: ${row.path}`);
    } catch (error) {
      state.failures.push({ path: row.path, message: error.message });
      addLog(`Failed: ${row.path} (${error.message})`, "error");
    } finally {
      state.metrics.completed += 1;
      updateMetrics();
      await yieldToBrowser();
    }
  }

  state.processing = false;
  setStatus(state.failures.length ? "Cleanup finished with failures." : "Cleanup finished.", state.failures.length ? "warn" : "success");
  updateMetrics(true);
  syncParentCounts();
  renderParentList();
  updateFolderSummary();
  buildReport();
  renderPreview();
  resetRunMetrics();
  updateControls();

  if (quarantineHandle) {
    els.zipInfo.textContent = "Report ready. Quarantined folders can be restored from the quarantine path before final deletion.";
  }
  addLog(`Cleanup finished with ${state.failures.length} failed folder${state.failures.length === 1 ? "" : "s"}.`, state.failures.length ? "warn" : "success");
}

async function discardSelectedFoldersWithBackend(selectedRows) {
  const action = els.quarantineOption.checked ? "quarantine and discard" : "discard";
  const confirmed = await confirmCleanupReview(selectedRows, {
    action,
    source: "firm server backend"
  });
  if (!confirmed) {
    addLog("Cleanup canceled during confirmation.", "warn");
    return;
  }

  state.processing = true;
  state.metrics = {
    total: selectedRows.length,
    completed: 0,
    startTime: performance.now()
  };
  updateMetrics();
  updateControls();
  setStatus(els.quarantineOption.checked ? "Backend quarantining..." : "Backend discarding...", "loading");
  addLog("Backend cleanup started.", "loading");

  try {
    const result = await backendRequest("/api/discard", {
      method: "POST",
      body: {
        rootPath: state.backendRootPath || els.serverPathInput.value.trim(),
        relativePaths: selectedRows.map(row => row.relativePath).filter(Boolean),
        settings: settingsPayload(),
        quarantine: els.quarantineOption.checked,
        approval: els.approvalCheck.checked
      }
    });

    for (const row of result.processed || []) {
      markProcessed(row.path);
      addLog(`${els.quarantineOption.checked ? "Backend quarantined" : "Backend discarded"}: ${row.path}`);
    }

    for (const failure of result.failures || []) {
      state.failures.push(failure);
      addLog(`Backend failed: ${failure.path} (${failure.message})`, "error");
    }

    state.metrics.completed = selectedRows.length;
    updateMetrics(true);
    setStatus(result.failures?.length ? "Backend cleanup finished with failures." : "Backend cleanup finished.", result.failures?.length ? "warn" : "success");
    if (result.quarantinePath) {
      els.zipInfo.textContent = `Report ready. Quarantine path: ${result.quarantinePath}`;
    }
    els.localModeStats.textContent = `${result.processed?.length || 0} reclaimed folder${result.processed?.length === 1 ? "" : "s"} this run. ${result.failures?.length || 0} failed.`;
    addLog(result.message || "Backend cleanup finished.", result.failures?.length ? "warn" : "success");
  } catch (error) {
    setStatus("Backend cleanup failed.", "error");
    addLog(`Backend cleanup failed: ${error.message}`, "error");
  } finally {
    state.processing = false;
    syncParentCounts();
    renderParentList();
    updateFolderSummary();
    buildReport();
    renderPreview();
    resetRunMetrics();
    updateControls();
  }
}

function compressTargets(rows) {
  const selectedPaths = new Set(rows.map(row => row.path));
  return rows.filter(row => {
    const parts = row.path.split("/").filter(Boolean);
    for (let index = parts.length - 1; index > 0; index -= 1) {
      const ancestor = parts.slice(0, index).join("/");
      if (selectedPaths.has(ancestor)) return false;
    }
    return true;
  });
}

async function createQuarantineHandle() {
  const quarantineRoot = await state.rootHandle.getDirectoryHandle(QUARANTINE_FOLDER, { create: true });
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "_",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
  return quarantineRoot.getDirectoryHandle(stamp, { create: true });
}

async function mirrorFolderToQuarantine(sourceHandle, quarantineHandle, pathParts) {
  let target = quarantineHandle;
  for (const part of pathParts) {
    target = await target.getDirectoryHandle(part, { create: true });
  }

  for await (const [name, childHandle] of sourceHandle.entries()) {
    if (childHandle.kind === "directory") {
      await mirrorFolderToQuarantine(childHandle, target, [name]);
    } else if (childHandle.kind === "file" && isSystemFileName(name)) {
      const sourceFile = await childHandle.getFile();
      const targetFile = await target.getFileHandle(name, { create: true });
      const writable = await targetFile.createWritable();
      await writable.write(sourceFile);
      await writable.close();
    }
  }
}

async function validateFolderStillDiscardable(folderHandle, mode) {
  for await (const [name, childHandle] of folderHandle.entries()) {
    if (childHandle.kind === "directory") {
      if (mode === "strict") {
        return { ok: false, reason: "Folder now contains a child folder." };
      }
      const childValidation = await validateFolderStillDiscardable(childHandle, mode);
      if (!childValidation.ok) {
        return childValidation;
      }
    } else if (childHandle.kind === "file") {
      if (mode === "strict" || !isSystemFileName(name)) {
        return { ok: false, reason: "Folder now contains a non-empty file." };
      }
    }
  }
  return { ok: true, reason: "" };
}

function markProcessed(path) {
  const matches = state.reviewRows.filter(row => isSameOrChildPath(row.path, path));
  if (!matches.length) return;

  const alreadyStored = new Set(state.discardedRows.map(row => row.path));
  for (const row of matches) {
    state.processedRows.add(row.path);
    state.selectedFolders.delete(row.path);
    if (!alreadyStored.has(row.path)) {
      state.discardedRows.push({
        ...row,
        reportStatus: els.quarantineOption.checked ? "backed_up_discarded" : "processed",
        canDiscard: false
      });
    }
  }

  state.allReviewRows = state.allReviewRows.filter(row => !isSameOrChildPath(row.path, path));
  state.reviewRows = state.reviewRows.filter(row => !isSameOrChildPath(row.path, path));
  state.filteredRows = state.filteredRows.filter(row => !isSameOrChildPath(row.path, path));
}

function isSameOrChildPath(candidatePath, selectedPath) {
  return candidatePath === selectedPath || candidatePath.startsWith(`${selectedPath}/`);
}

function buildReport() {
  revokeReportObjectUrl();
  if (!state.directories.size) {
    state.reportBlob = null;
    return;
  }

  const generatedAt = new Date().toISOString();
  const rows = [[
    "generated_at",
    "app",
    "source",
    "preset",
    "empty_definition",
    "age_filter_days",
    "quarantine_selected",
    "folder_path",
    "copyable_path",
    "parent_folder",
    "last_modified",
    "status",
    "selected",
    "reason"
  ]];

  const reportRows = [...state.reviewRows, ...state.discardedRows];
  for (const row of reportRows) {
    rows.push([
      generatedAt,
      "SGA FILE NEXUS",
      state.sourceLabel,
      els.presetSelect.options[els.presetSelect.selectedIndex].text,
      els.emptyDefinition.options[els.emptyDefinition.selectedIndex].text,
      els.ageFilter.value,
      els.quarantineOption.checked ? "yes" : "no",
      row.path,
      absolutePathForRow(row),
      row.parent,
      formatDate(row.lastModified),
      row.reportStatus || statusForRow(row),
      state.selectedFolders.has(row.path) ? "yes" : "no",
      failureForPath(row.path)?.message || row.reason
    ]);
  }

  const csv = rows.map(reportRow => reportRow.map(csvCell).join(",")).join("\n");
  state.reportBlob = new Blob([csv], { type: REPORT_MIME });
  state.reportName = `${safeFileName(state.mainFolderName || "SGA_FILE_NEXUS")}_empty_folder_audit.csv`;
  els.downloadButton.disabled = false;
  if (!els.quarantineOption.checked || !els.zipInfo.textContent.includes("Quarantined")) {
    els.zipInfo.textContent = reportRows.length
      ? `Audit report ready: ${reportRows.length} reviewed folders`
      : `Scan report ready: ${state.scannedFolders || 0} folders scanned, no empty-folder rows found.`;
  }
}

function downloadReport() {
  if (!state.reportBlob) {
    addLog("No report is ready yet. Scan a folder first.", "warn");
    return;
  }

  const url = ensureReportObjectUrl();
  const link = document.createElement("a");
  link.href = url;
  link.download = state.reportName || "SGA_FILE_NEXUS_empty_folder_audit.csv";
  link.style.display = "none";
  document.body.appendChild(link);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  link.remove();
  addLog("Audit report download started.");
}

function downloadWorkbookReport() {
  if (!state.reportBlob) {
    addLog("No workbook report is ready yet. Scan a folder first.", "warn");
    return;
  }

  const html = reportHtmlDocument("workbook");
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  triggerBlobDownload(blob, `${safeFileName(state.mainFolderName || "SGA_FILE_NEXUS")}_empty_folder_audit.xls`);
  addLog("Workbook report download started.");
}

function downloadPdfReport() {
  if (!state.reportBlob) {
    addLog("No PDF report is ready yet. Scan a folder first.", "warn");
    return;
  }

  const reportWindow = window.open("", "_blank", "noopener");
  if (!reportWindow) {
    addLog("PDF report window was blocked. Allow pop-ups, then try PDF again.", "warn");
    return;
  }

  reportWindow.document.open();
  reportWindow.document.write(reportHtmlDocument("pdf"));
  reportWindow.document.close();
  reportWindow.focus();
  window.setTimeout(() => {
    reportWindow.print();
  }, 250);
  addLog("PDF report opened. Choose Save as PDF in the print dialog.");
}

function reportHtmlDocument(mode) {
  const generatedAt = new Date().toLocaleString();
  const reportRows = [...state.reviewRows, ...state.discardedRows];
  const bodyRows = reportRows.map(row => {
    const status = row.reportStatus || statusForRow(row);
    const highlightClass = status === "processed" || status === "backed_up_discarded" ? "deleted-row" : status === "failed" ? "attention-row" : "";
    return `
      <tr class="${highlightClass}">
        <td>${escapeHtml(generatedAt)}</td>
        <td>${escapeHtml(state.sourceLabel)}</td>
        <td>${escapeHtml(row.parent || "")}</td>
        <td>${escapeHtml(row.path)}</td>
        <td>${escapeHtml(absolutePathForRow(row))}</td>
        <td>${escapeHtml(formatDate(row.lastModified))}</td>
        <td>${escapeHtml(status)}</td>
        <td>${state.selectedFolders.has(row.path) ? "yes" : "no"}</td>
        <td>${escapeHtml(failureForPath(row.path)?.message || row.reason || "")}</td>
      </tr>
    `;
  }).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>SGA FILE NEXUS Audit Report</title>
  <style>
    body { font-family: Arial, sans-serif; color: #050505; margin: 28px; }
    h1 { font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 8px; }
    p { color: #555; margin: 0 0 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #d8d8d8; padding: 7px; text-align: left; vertical-align: top; }
    th { background: #f2f2f2; text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; }
    .deleted-row td { background: #ffe8e5; color: #8d1f17; font-weight: 700; }
    .attention-row td { background: #fff5f3; }
    .note { margin-top: 12px; color: #8d1f17; font-size: 12px; }
    @media print { body { margin: 14px; } }
  </style>
</head>
<body>
  <h1>SGA FILE NEXUS Audit Report</h1>
  <p>${escapeHtml(state.mainFolderName || "Selected folder")} | ${escapeHtml(generatedAt)} | ${mode === "pdf" ? "Print-ready PDF report" : "Workbook report"}</p>
  <table>
    <thead>
      <tr>
        <th>Generated</th>
        <th>Source</th>
        <th>Parent</th>
        <th>Folder Path</th>
        <th>Copyable Path</th>
        <th>Last Modified</th>
        <th>Status</th>
        <th>Selected</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>${bodyRows || '<tr><td colspan="9">No report rows.</td></tr>'}</tbody>
  </table>
  <p class="note">Discarded or deleted rows are highlighted in red.</p>
</body>
</html>`;
}

function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetRunMetrics() {
  const selectedReady = state.reviewRows.filter(row => state.selectedFolders.has(row.path) && row.canDiscard).length;
  const protectedCount = state.reviewRows.filter(row => row.status === "protected").length;
  state.metrics = {
    total: selectedReady,
    completed: 0,
    startTime: performance.now()
  };
  els.totalFiles.textContent = state.scannedFolders || state.reviewRows.length;
  els.completedFiles.textContent = state.discardedRows.length;
  els.remainingFiles.textContent = selectedReady;
  els.elapsedTime.textContent = "00:00";
  els.etaTime.textContent = "--:--";
  els.filesPerSecond.textContent = "0.0";
  els.heicSpeed.textContent = protectedCount;
  setProgress(0);
}

function updateMetrics(done = false) {
  const elapsedSeconds = Math.max(0.001, (performance.now() - state.metrics.startTime) / 1000);
  const completed = state.metrics.completed;
  const remaining = Math.max(0, state.metrics.total - completed);
  const perSecond = completed / elapsedSeconds;
  const etaSeconds = perSecond > 0 ? remaining / perSecond : 0;

  els.totalFiles.textContent = state.scannedFolders || state.reviewRows.length;
  els.completedFiles.textContent = state.discardedRows.length || completed;
  els.remainingFiles.textContent = remaining;
  els.elapsedTime.textContent = formatDuration(elapsedSeconds);
  els.etaTime.textContent = done ? "00:00" : (completed ? formatDuration(etaSeconds) : "--:--");
  els.filesPerSecond.textContent = perSecond.toFixed(1);
  els.heicSpeed.textContent = state.reviewRows.filter(row => row.status === "protected").length;
  setProgress(state.metrics.total ? (completed / state.metrics.total) * 100 : 0);
}

function updateControls() {
  const hasParents = state.parentFolders.size > 0 && state.allReviewRows.length > 0;
  const hasRows = state.reviewRows.length > 0;
  const selectedReady = state.reviewRows.filter(row => state.selectedFolders.has(row.path) && row.canDiscard && statusForRow(row) === "ready").length;
  const canDiscard = selectedReady > 0 && els.approvalCheck.checked && state.hasWriteAccess && !state.processing;

  els.selectAllButton.disabled = !hasParents || state.processing;
  els.deselectAllButton.disabled = !hasParents || state.processing;
  els.renameButton.disabled = !state.directories.size || state.processing;
  els.selectReadyButton.disabled = !hasRows || state.processing || !state.reviewRows.some(row => row.canDiscard && statusForRow(row) === "ready");
  els.discardButton.disabled = !canDiscard;
  els.downloadButton.disabled = !state.reportBlob;
  els.downloadWorkbookButton.disabled = !state.reportBlob;
  els.downloadPdfButton.disabled = !state.reportBlob;
  els.selectVisibleButton.disabled = !state.filteredRows.length || state.processing;
  els.clearVisibleButton.disabled = !state.filteredRows.length || state.processing;
  els.copySelectedPathsButton.disabled = !selectedReady || state.processing;
  els.clearReviewBinButton.disabled = !selectedReady || state.processing;
  els.chooseFolderButton.disabled = state.processing;
  els.checkBackendButton.disabled = state.processing || !els.serverPathInput.value.trim();
  els.scanBackendButton.disabled = state.processing || !isCurrentBackendPathReady();
  els.cancelBackendButton.disabled = !state.processing;
  els.restoreBackendButton.disabled = state.processing || !els.serverPathInput.value.trim();

  if (!state.directories.size) {
    els.renameButton.textContent = "Apply Scan Rules";
    els.discardButton.textContent = "Discard Selected";
    els.downloadButton.textContent = "Download CSV Report";
    renderReviewSummary();
    renderReviewBin();
    return;
  }

  els.renameButton.textContent = "Apply Scan Rules";
  els.discardButton.textContent = selectedReady ? `Discard Selected (${selectedReady})` : "Discard Selected";
  els.downloadButton.textContent = "Download CSV Report";
  renderReviewBin();

  if (!state.hasWriteAccess && hasRows) {
    els.zipInfo.textContent = "Scan-only source: download the audit report for server cleanup.";
  }
}

function updateFolderSummary() {
  if (!state.mainFolderName) {
    els.folderSummary.textContent = "No folder loaded.";
    return;
  }

  const activeParentCount = [...state.parentFolders.values()]
    .filter(parent => parent.emptyCount || parent.protectedCount)
    .length;
  const readyCount = state.allReviewRows.filter(row => row.status === "ready").length;
  const protectedCount = state.allReviewRows.filter(row => row.status === "protected").length;
  const discardedText = state.discardedRows.length ? `, ${state.discardedRows.length} discarded` : "";

  if (!state.allReviewRows.length) {
    els.folderSummary.textContent = `${state.mainFolderName}: ${state.scannedFolders} folders scanned. ${emptyReviewMessage("summary")}`;
    return;
  }

  els.folderSummary.textContent = `${state.mainFolderName}: ${activeParentCount} parent folders, ${state.scannedFolders} folders scanned, ${readyCount} ready, ${protectedCount} protected${discardedText}.`;
}

function emptyReviewMessage(context = "table") {
  const scannedText = `${state.scannedFolders || 0} folder${state.scannedFolders === 1 ? "" : "s"} scanned`;

  if (!state.mainFolderName) {
    return "Load a folder to scan for empty folders.";
  }

  if (state.sourceKind === "backend") {
    return `Full Local Mode finished with ${scannedText}, but no empty folders matched the current rules. Try Any age, include unknown dates, or review protected rules if you expected results.`;
  }

  if (state.sourceKind === "file" || state.sourceKind === "drop") {
    if (context === "summary") {
      return "No empty-folder rows are visible in Preview Mode. Browser folder scans can miss truly empty folders because empty folders contain no files for the browser to send.";
    }
    if (context === "parent") {
      return "No parent folders have visible empty-folder rows. Use Full Local Mode for true empty-folder detection.";
    }
    if (context === "detail") {
      return "Preview Mode scanned what the browser exposed, but no empty-folder rows are available to preview. For a real test, run Full Local Mode and scan the same folder path.";
    }
    return `No empty-folder rows are visible from Preview Mode. The browser scanned ${state.scannedFolders || 0} folders it could see, but truly empty folders may not be exposed. Run Full Local Mode and scan the folder path for real empty-folder detection.`;
  }

  return `No empty folders matched the current scan rules after ${scannedText}.`;
}

function buildHygieneScan() {
  const rows = [];
  const patterns = protectedPatterns();
  const now = Date.now();
  const staleMs = 365 * 24 * 60 * 60 * 1000;

  for (const row of state.allReviewRows) {
    rows.push(hygieneRow({
      type: row.status === "protected" ? "Protected empty folder" : "Empty folder",
      item: row.path,
      status: row.status === "protected" ? "protected" : "review",
      recommendation: row.status === "protected" ? "Keep protected; review only if rules change." : "Review in the cleanup tab before any discard action.",
      details: row.reason,
      parent: row.parent
    }));
  }

  for (const directory of state.directories.values()) {
    if (!directory.path || directory.path === "backend") continue;
    const protectedReason = protectedReasonForPath(directory.path, patterns);
    const hasOnlySystemFiles = directory.subtreeFileCount > 0 && directory.subtreeUsableFileCount === 0;
    const stale = directory.lastModified && now - directory.lastModified > staleMs && directory.subtreeUsableFileCount > 0;
    const namingFlag = /\b(copy|old|backup|archive|final\s*final|temp|test)\b/i.test(directory.name || directory.path);

    if (hasOnlySystemFiles) {
      rows.push(hygieneRow({
        type: "System-only folder",
        item: directory.path,
        status: protectedReason ? "protected" : "review",
        recommendation: "Review as a low-risk cleanup candidate; no action is available from this tab.",
        details: `${directory.subtreeSystemFileCount} ignored system file${directory.subtreeSystemFileCount === 1 ? "" : "s"} found.`,
        parent: parentNameForPath(directory.path)
      }));
    }

    if (stale) {
      rows.push(hygieneRow({
        type: "Inactive folder",
        item: directory.path,
        status: protectedReason ? "protected" : "attention",
        recommendation: "Confirm whether this should stay active or be moved into archive review.",
        details: `Last modified ${formatDate(directory.lastModified)}.`,
        parent: parentNameForPath(directory.path)
      }));
    }

    if (namingFlag && directory.subtreeUsableFileCount > 0) {
      rows.push(hygieneRow({
        type: "Naming attention",
        item: directory.path,
        status: protectedReason ? "protected" : "review",
        recommendation: "Review folder naming for duplicates, old versions, or temporary work areas.",
        details: "Folder name contains copy, old, backup, archive, final final, temp, or test.",
        parent: parentNameForPath(directory.path)
      }));
    }
  }

  const duplicateNames = new Map();
  for (const directory of state.directories.values()) {
    if (!directory.name || directory.path === state.mainFolderName) continue;
    const key = directory.name.toLowerCase();
    if (!duplicateNames.has(key)) duplicateNames.set(key, []);
    duplicateNames.get(key).push(directory.path);
  }
  for (const paths of duplicateNames.values()) {
    if (paths.length < 2) continue;
    for (const path of paths.slice(0, 20)) {
      rows.push(hygieneRow({
        type: "Repeated folder name",
        item: path,
        status: "info",
        recommendation: "Compare similarly named folders before archiving or cleanup decisions.",
        details: `${paths.length} folders share this name.`,
        parent: parentNameForPath(path)
      }));
    }
  }

  for (const file of state.files) {
    const protectedReason = protectedReasonForPath(file.path, patterns);
    const extension = fileExtension(file.name);
    const large = file.size >= 250 * 1024 * 1024;
    const backupTemp = isBackupOrTempFile(file.name);
    const oldExport = isExportFile(extension) && file.lastModified && now - file.lastModified > staleMs;

    if (file.isSystem || backupTemp) {
      rows.push(hygieneRow({
        type: file.isSystem ? "System file" : "Backup/temp file",
        item: file.path,
        status: protectedReason ? "protected" : "review",
        recommendation: "Review as file hygiene only. This tab will not delete it.",
        details: `${formatBytes(file.size)} | Modified ${formatDate(file.lastModified)}.`,
        parent: parentNameForPath(file.path)
      }));
    }

    if (large) {
      rows.push(hygieneRow({
        type: "Large file",
        item: file.path,
        status: protectedReason ? "protected" : "attention",
        recommendation: "Confirm this large file is still needed in the active project area.",
        details: `${formatBytes(file.size)} | Modified ${formatDate(file.lastModified)}.`,
        parent: parentNameForPath(file.path)
      }));
    }

    if (oldExport) {
      rows.push(hygieneRow({
        type: "Old export",
        item: file.path,
        status: protectedReason ? "protected" : "review",
        recommendation: "Review whether this export belongs in archive or can remain as reference.",
        details: `${extension.toUpperCase()} export | Modified ${formatDate(file.lastModified)}.`,
        parent: parentNameForPath(file.path)
      }));
    }
  }

  state.hygieneRows = rows.slice(0, 1200);
}

function hygieneRow({ type, item, status, recommendation, details, parent }) {
  return {
    type,
    item,
    status,
    recommendation,
    details: details || "",
    parent: parent || parentNameForPath(item)
  };
}

function renderHygieneScan() {
  const search = els.hygieneSearchInput.value.trim().toLowerCase();
  const statusFilter = els.hygieneStatusFilter.value;
  state.filteredHygieneRows = state.hygieneRows.filter(row => {
    const matchesStatus = statusFilter === "all" || row.status === statusFilter;
    const matchesSearch = !search || `${row.type} ${row.item} ${row.recommendation} ${row.details} ${row.parent}`.toLowerCase().includes(search);
    return matchesStatus && matchesSearch;
  });

  const counts = {
    attention: state.hygieneRows.filter(row => row.status === "attention").length,
    review: state.hygieneRows.filter(row => row.status === "review").length,
    protected: state.hygieneRows.filter(row => row.status === "protected").length,
    info: state.hygieneRows.filter(row => row.status === "info").length
  };

  els.hygieneCount.textContent = `${state.filteredHygieneRows.length} flags`;
  els.hygieneSummary.textContent = state.mainFolderName
    ? `${state.mainFolderName}: ${state.hygieneRows.length} scan-only hygiene flags. No delete controls are available in this tab.`
    : "Load a folder to generate a general hygiene scan. This tab does not delete or discard anything.";
  els.hygieneSummaryStrip.innerHTML = `
    <span><strong>${counts.attention}</strong> Attention</span>
    <span><strong>${counts.review}</strong> Review</span>
    <span><strong>${counts.protected}</strong> Protected</span>
    <span><strong>${counts.info}</strong> Info</span>
  `;

  if (!state.hygieneRows.length) {
    els.hygieneBody.innerHTML = state.mainFolderName
      ? '<tr><td colspan="5" class="empty-state">No hygiene flags found in this scan.</td></tr>'
      : hygienePlaceholderRows();
    return;
  }

  if (!state.filteredHygieneRows.length) {
    els.hygieneBody.innerHTML = '<tr><td colspan="5" class="empty-state">No hygiene flags match the current filter.</td></tr>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of state.filteredHygieneRows.slice(0, PREVIEW_RENDER_LIMIT)) {
    const tr = document.createElement("tr");
    tr.className = `hygiene-row hygiene-${row.status}${row.status === "attention" ? " row-needs-attention" : ""}`;
    tr.append(
      cell(row.type),
      hygieneItemCell(row),
      cell(row.recommendation),
      statusCell(row.status, row.details),
      cell(row.details)
    );
    fragment.appendChild(tr);
  }
  els.hygieneBody.innerHTML = "";
  els.hygieneBody.appendChild(fragment);
}

function hygieneItemCell(row) {
  const td = document.createElement("td");
  td.className = "path-cell";
  const wrapper = document.createElement("div");
  wrapper.className = "path-cell-content";
  const path = document.createElement("span");
  path.className = "path-text";
  path.textContent = row.item;
  path.title = row.item;
  wrapper.appendChild(path);
  td.appendChild(wrapper);
  return td;
}

function hygienePlaceholderRows() {
  const rows = [
    {
      type: "System-only folder",
      item: "Example / Project / Empty Uploads",
      recommendation: "Review as a low-risk cleanup candidate in the cleanup tab.",
      status: "review",
      details: "Example only. Load a folder to generate real scan results."
    },
    {
      type: "Inactive folder",
      item: "Example / Project / Old Archive",
      recommendation: "Confirm whether this should stay active or be moved into archive review.",
      status: "attention",
      details: "Flags folders that have not changed in roughly a year."
    },
    {
      type: "Backup/temp file",
      item: "Example / Project / Model Backup.bak",
      recommendation: "Review as file hygiene only. This tab will not delete it.",
      status: "review",
      details: "Looks for .bak, .tmp, .skb, .dwl, autosave, and similar patterns."
    },
    {
      type: "Repeated folder name",
      item: "Example / Project / Renderings",
      recommendation: "Compare similarly named folders before archiving or cleanup decisions.",
      status: "info",
      details: "Shows repeated folder names across the selected folder tree."
    }
  ];

  return rows.map(row => `
    <tr class="hygiene-row hygiene-placeholder hygiene-${row.status}">
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.item)}</td>
      <td>${escapeHtml(row.recommendation)}</td>
      <td><span class="row-status ${statusClass(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.details)}</td>
    </tr>
  `).join("");
}

function parentNameForPath(path) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts[1] || parts[0] || "Root";
}

function fileExtension(fileName) {
  const index = String(fileName || "").lastIndexOf(".");
  return index >= 0 ? String(fileName).slice(index).toLowerCase() : "";
}

function isBackupOrTempFile(fileName) {
  const name = String(fileName || "").toLowerCase();
  return name.startsWith("~$")
    || /\.(bak|tmp|temp|old|skb|dwl|dwl2|sv\$)$/i.test(name)
    || /\.\d{4}\.rvt$/i.test(name);
}

function isExportFile(extension) {
  return [".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".zip"].includes(extension);
}

function setProgress(percent) {
  els.progressBar.classList.remove("indeterminate");
  const safe = Math.max(0, Math.min(100, percent));
  els.progressBar.style.width = `${safe}%`;
  els.percentText.textContent = `${Math.round(safe)}%`;
}

function setProgressIndeterminate(active) {
  els.progressBar.classList.toggle("indeterminate", Boolean(active));
  if (active) {
    els.percentText.textContent = "Working";
  } else if (!state.metrics.total) {
    setProgress(0);
  }
}

function setStatus(message, type = "neutral") {
  els.statusText.textContent = message;
  els.statusText.className = `status-chip status-${type}`;
}

function updateModeBanner(mode) {
  const full = mode === "full";
  els.modeBanner.className = `mode-banner ${full ? "full" : "preview"}`;
  els.modeBannerLabel.textContent = full ? "Full Local Mode" : "Preview Mode";
  els.modeBannerText.textContent = full
    ? "Full Local Mode: Backend connected. Real local and server folders can be scanned, quarantined, and restored."
    : "Preview Mode: Some filesystem features are unavailable. Run the local backend for full functionality.";
}

function updateLocalModeStats(stats) {
  if (!stats) {
    els.localModeStats.textContent = state.backendAvailable
      ? "Backend connected. Check a folder path to enable Scan Folder."
      : "Full Local Mode is available after the backend is running.";
    return;
  }

  const elapsed = stats.elapsedMs ? formatDuration(stats.elapsedMs / 1000) : "00:00";
  els.localModeStats.textContent = [
    `${stats.foldersScanned || 0} folders scanned`,
    `${stats.emptyFolderRows || 0} empty-folder rows`,
    `${stats.emptyFoldersFound || 0} ready`,
    `${stats.protectedFolders || 0} protected`,
    `${elapsed} elapsed`
  ].join(" | ");
}

function addLog(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  entry.innerHTML = `<span class="log-time">${time}</span>`;
  entry.append(document.createTextNode(message));
  els.messageLog.prepend(entry);
}

function clearAll() {
  els.folderInput.value = "";
  clearWorkingState();
  resetUi();
  addLog("Cleared current folder.");
}

function clearWorkingState() {
  state.sourceKind = "";
  state.sourceLabel = "";
  state.mainFolderName = "";
  state.scannedFolders = 0;
  state.rootHandle = null;
  state.hasWriteAccess = false;
  state.directories = new Map();
  state.files = [];
  state.parentFolders = new Map();
  state.selectedParents = new Set();
  state.allReviewRows = [];
  state.reviewRows = [];
  state.filteredRows = [];
  state.selectedFolders = new Set();
  state.selectedPreviewPath = "";
  state.hygieneRows = [];
  state.filteredHygieneRows = [];
  state.processedRows = new Set();
  state.discardedRows = [];
  state.failures = [];
  state.reportBlob = null;
  revokeReportObjectUrl();
  state.reportName = "";
  state.backendRootPath = "";
  state.backendStats = null;
  state.backendAbortController = null;
  state.processing = false;
}

function resetUi() {
  els.parentList.innerHTML = "";
  els.folderSummary.textContent = "No folder loaded.";
  els.previewBody.innerHTML = '<tr><td colspan="5" class="empty-state">Load a folder to scan for empty folders.</td></tr>';
  els.previewDetail.className = "preview-detail muted";
  els.previewDetail.textContent = "Select a review row to preview folder details before cleanup.";
  els.previewCount.textContent = "0 folders";
  els.zipInfo.textContent = "Audit report will be available after scanning.";
  els.reviewSummaryStrip.innerHTML = "<span><strong>0</strong> Ready</span><span><strong>0</strong> Selected</span><span><strong>0</strong> Protected</span><span><strong>0</strong> Failed</span><span><strong>0</strong> Backup planned</span>";
  els.selectedActionCount.textContent = "0 selected";
  els.reviewBinCount.textContent = "0";
  els.reviewBinSummary.textContent = "Selected ready folders appear here before cleanup.";
  els.reviewBinList.innerHTML = "";
  els.hygieneCount.textContent = "0 flags";
  els.hygieneSummary.textContent = "Load a folder to generate a general hygiene scan. This tab does not delete or discard anything.";
  els.hygieneSummaryStrip.innerHTML = "<span><strong>0</strong> Attention</span><span><strong>0</strong> Review</span><span><strong>0</strong> Protected</span><span><strong>0</strong> Info</span>";
  els.hygieneBody.innerHTML = hygienePlaceholderRows();
  els.hygieneSearchInput.value = "";
  els.hygieneStatusFilter.value = "all";
  els.searchInput.value = "";
  els.statusFilter.value = "all";
  els.approvalCheck.checked = false;
  els.quarantineOption.checked = true;
  els.backendStatus.textContent = state.backendAvailable
    ? "Full Local Mode connected. Enter a folder path, then click Check Path."
    : "Full Local Mode is checking for the local backend.";
  updateLocalModeStats(null);
  updateModeBanner(state.backendAvailable ? "full" : "preview");
  setStatus("Waiting for a folder.");
  setProgress(0);
  els.totalFiles.textContent = "0";
  els.completedFiles.textContent = "0";
  els.remainingFiles.textContent = "0";
  els.elapsedTime.textContent = "00:00";
  els.etaTime.textContent = "--:--";
  els.filesPerSecond.textContent = "0.0";
  els.heicSpeed.textContent = "0";
  updateControls();
}

function statusForRow(row) {
  if (state.processedRows.has(row.path)) return "processed";
  if (failureForPath(row.path)) return "failed";
  return row.status;
}

function failureForPath(path) {
  return state.failures.find(failure => failure.path === path);
}

function statusCell(status, reason) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = `row-status ${statusClass(status)}`;
  span.title = reason;
  span.textContent = status;
  td.appendChild(span);
  return td;
}

function statusClass(status) {
  return String(status || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function folderPathCell(row) {
  const td = document.createElement("td");
  td.className = "path-cell";

  const wrapper = document.createElement("div");
  wrapper.className = "path-cell-content";

  const pathText = document.createElement("span");
  pathText.className = "path-text";
  pathText.textContent = row.path;
  pathText.title = `Copyable path: ${absolutePathForRow(row)}`;

  const actions = document.createElement("div");
  actions.className = "path-actions";

  const copyButton = document.createElement("button");
  copyButton.className = "path-action";
  copyButton.type = "button";
  copyButton.textContent = "Copy";
  copyButton.title = "Copy this folder path so you can paste it into File Explorer or an email.";
  copyButton.addEventListener("click", () => copyPathForRow(row, copyButton));
  actions.appendChild(copyButton);

  if (canAttemptOpenPath(row)) {
    const openButton = document.createElement("button");
    openButton.className = "path-action";
    openButton.type = "button";
    openButton.textContent = "Open";
    openButton.title = "Try to open this folder in a new tab. Some browsers block local server folder links, so the path is copied too.";
    openButton.addEventListener("click", () => openPathForRow(row));
    actions.appendChild(openButton);
  }

  wrapper.append(pathText, actions);
  td.appendChild(wrapper);
  return td;
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

async function copyPathForRow(row, button) {
  const targetPath = absolutePathForRow(row);
  const copied = await copyTextToClipboard(targetPath);
  if (!copied) {
    addLog("Path could not be copied automatically. Select the folder path text and copy it manually.", "warn");
    return;
  }
  const original = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
  addLog(`Copied folder path: ${targetPath}`);
}

async function openPathForRow(row) {
  const targetPath = absolutePathForRow(row);
  await copyTextToClipboard(targetPath);
  const opened = window.open(fileUrlForPath(targetPath), "_blank", "noopener");
  addLog(opened
    ? `Opening folder path. If the browser blocks it, paste the copied path into File Explorer: ${targetPath}`
    : `Browser blocked direct folder opening. The path was copied so you can paste it into File Explorer: ${targetPath}`,
    opened ? "info" : "warn");
}

function absolutePathForRow(row) {
  if (state.sourceKind === "backend" && state.backendRootPath && row.relativePath) {
    const root = state.backendRootPath.replace(/[\\/]+$/, "");
    const separator = root.includes("\\") || /^[a-z]:/i.test(root) ? "\\" : "/";
    return `${root}${separator}${row.relativePath.replaceAll("/", separator)}`;
  }
  return row.path;
}

function canAttemptOpenPath(row) {
  return state.sourceKind === "backend" && Boolean(state.backendRootPath && row.relativePath);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

function fileUrlForPath(folderPath) {
  if (folderPath.startsWith("\\\\")) {
    return `file:${folderPath.replaceAll("\\", "/")}`;
  }
  if (/^[a-z]:/i.test(folderPath)) {
    return `file:///${folderPath.replaceAll("\\", "/")}`;
  }
  return `file://${folderPath.replaceAll("\\", "/")}`;
}

function emptyReason(directory, strictMode) {
  if (strictMode) return "No files or child folders.";
  if (directory.subtreeSystemFileCount) return "Only ignored system files and empty subfolders.";
  return "Empty folder tree.";
}

function ageStatus(lastModified, minAgeDays, includeUnknownDates) {
  if (!minAgeDays) {
    return { ok: true, reason: "" };
  }
  if (!lastModified) {
    return includeUnknownDates
      ? { ok: true, reason: "Folder date unknown." }
      : { ok: false, reason: "Unknown date excluded by age rule." };
  }
  const ageMs = Date.now() - lastModified;
  const minMs = minAgeDays * 24 * 60 * 60 * 1000;
  if (ageMs >= minMs) {
    return { ok: true, reason: "" };
  }
  return { ok: false, reason: `Newer than ${minAgeDays} days.` };
}

function protectedPatterns() {
  return Array.from(els.protectedRules.querySelectorAll('input[type="checkbox"]:checked'))
    .map(input => input.value.trim())
    .filter(Boolean);
}

function protectedReasonForPath(path, patterns) {
  const lowerPath = path.toLowerCase();
  const match = patterns.find(rule => lowerPath.includes(rule.toLowerCase()));
  return match ? `Protected rule: ${match}` : "";
}

function isSystemFileName(fileName) {
  const name = String(fileName || "").toLowerCase();
  return SYSTEM_FILE_NAMES.has(name) || name.startsWith("._");
}

function commonMainFolder(path) {
  const first = path.split("/").filter(Boolean)[0];
  return first || "";
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function pathJoin(...parts) {
  return parts.map(part => String(part).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function slug(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "-");
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatDate(timestamp) {
  if (!timestamp) return "Unknown";
  return new Date(timestamp).toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeFileName(value) {
  return String(value || "SGA_FILE_NEXUS").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "");
}

function ensureReportObjectUrl() {
  if (!state.reportUrl && state.reportBlob) {
    state.reportUrl = URL.createObjectURL(state.reportBlob);
  }
  return state.reportUrl;
}

function revokeReportObjectUrl() {
  if (state.reportUrl) {
    URL.revokeObjectURL(state.reportUrl);
    state.reportUrl = "";
  }
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function debounce(callback, delay) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}
