const SYSTEM_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const SCAN_BATCH_SIZE = 250;
const DETECTION_BATCH_SIZE = 500;
const LARGE_FOLDER_BYTES = 900 * 1024 * 1024;
const LARGE_FOLDER_FILES = 5000;
const UNDO_SECONDS = 12;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "tif", "tiff", "webp"]);
const BROWSER_THUMBNAIL_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "rtf"]);
const DESIGN_EXTENSIONS = new Set(["3dm", "dwg", "dxf", "skp", "rvt", "obj", "fbx"]);
const VIDEO_EXTENSIONS = new Set(["mov", "mp4"]);
const TEXT_PREVIEW_EXTENSIONS = new Set(["txt", "csv", "tsv", "json", "xml", "md", "log"]);
const COMMON_ORIGINAL_EXTENSIONS = new Set(["dwg", "skp", "pdf", "doc", "docx", "xls", "xlsx", "rtf", "3dm", "dxf", "rvt", "jpg", "jpeg", "png", "tif", "tiff", "webp", "mp4", "mov"]);
const FILE_TYPE_LABELS = {
  "3dm": "Rhino",
  dwg: "AutoCAD",
  dxf: "DXF",
  skp: "SketchUp",
  rvt: "Revit",
  obj: "OBJ",
  fbx: "FBX",
  pdf: "PDF",
  doc: "DOC",
  docx: "DOCX",
  xls: "XLS",
  xlsx: "XLSX",
  rtf: "RTF",
  mov: "MOV",
  mp4: "MP4",
  heic: "HEIC",
  tif: "TIFF",
  tiff: "TIFF",
  jpg: "JPG",
  jpeg: "JPEG",
  png: "PNG",
  webp: "WEBP",
  bak: "BAK",
  tmp: "TMP",
  autosave: "AUTOSAVE",
  backup: "BACKUP",
  rhl: "RHL",
  "3dmbak": "3DMBAK",
  "sv$": "SV$",
  "$v$": "$V$",
  "ac$": "AC$",
  rws: "RWS",
  rhk: "RHK",
  skb: "SKB"
};

const DETECTION_TYPES = ["Exact Duplicate", "Backup / Autosave", "Older Version", "Naming Duplicate"];
const BACKUP_EXTENSION_PATTERNS = [
  { suffix: ".dwg.bak", primaryExtension: "dwg", detail: "AutoCAD .bak file related to DWG" },
  { suffix: ".3dmbak", primaryExtension: "3dm", detail: "Rhino backup/autosave file related to 3DM" },
  { suffix: ".bak", primaryExtension: "", detail: "Backup file related to primary source" },
  { suffix: ".tmp", primaryExtension: "", detail: "Temporary/recovery file related to primary source" },
  { suffix: ".autosave", primaryExtension: "", detail: "Autosave file related to primary source" },
  { suffix: ".backup", primaryExtension: "", detail: "Backup file related to primary source" },
  { suffix: ".recovered", primaryExtension: "", detail: "Recovered file related to primary source" },
  { suffix: ".rhl", primaryExtension: "3dm", detail: "Rhino lock/recovery file related to 3DM" },
  { suffix: ".sv$", primaryExtension: "dwg", detail: "AutoCAD autosave file related to DWG" },
  { suffix: ".$v$", primaryExtension: "dwg", detail: "AutoCAD autosave file related to DWG" },
  { suffix: ".ac$", primaryExtension: "dwg", detail: "AutoCAD temporary file related to DWG" },
  { suffix: ".rws", primaryExtension: "3dm", detail: "Rhino workspace/recovery file related to 3DM" },
  { suffix: ".rhk", primaryExtension: "3dm", detail: "Rhino backup/recovery file related to 3DM" },
  { suffix: ".skb", primaryExtension: "skp", detail: "SketchUp .skb backup file related to SKP" }
];
const BACKUP_FOLDER_PATTERN = /\b(backup|backups|autosave|auto-save|recovery|recover|temp|temporary|archive)\b/i;
const VERSION_NAME_PATTERN = /(?:^|[_\s-])(?:v(?:ersion)?\s*\d+|rev(?:ision)?\s*\d+|old|older|previous|final|draft)(?:$|[_\s-]|\d)/i;
const COPY_NAME_PATTERN = /(?:\s-\scopy\b|[_\s-](?:copy|duplicate|dupe)\b|\(\d+\)\s*$)/i;
const API_BASE = `${window.location.origin}/api`;

const state = {
  mainFolderName: "",
  allFiles: [],
  lastScannedFiles: [],
  fileRecords: [],
  parentFolders: new Map(),
  selectedParents: new Set(),
  flaggedRows: [],
  selectedFlagged: new Set(),
  discardedIds: new Set(),
  permanentlyDeletedIds: new Set(),
  groupedBackupIds: new Set(),
  workflowTimestamps: new Map(),
  discardHistory: [],
  failures: [],
  reportBlob: null,
  reportUrl: "",
  reportName: "",
  previewUrls: new Map(),
  processing: false,
  scanDate: "",
  undoTimer: 0,
  reviewSearch: "",
  reviewSort: "group",
  reviewTypeFilter: "all",
  reviewFileTypeFilter: "all",
  reviewFolderFilter: "all",
  folderTreeExpanded: new Set(),
  confirmAction: "review-bin",
  confirmRowId: "",
  collapsedGroups: new Set(),
  largestGroupKeys: new Set(),
  backend: {
    connected: false,
    rootConfigured: false,
    rootPath: "",
    message: ""
  },
  metrics: {
    total: 0,
    completed: 0,
    startTime: 0,
    mode: "idle"
  }
};

const els = {
  dropZone: document.getElementById("dropZone"),
  chooseFolderButton: document.getElementById("chooseFolderButton"),
  folderInput: document.getElementById("folderInput"),
  fileInput: document.getElementById("fileInput"),
  clearButton: document.getElementById("clearButton"),
  refreshScanButton: document.getElementById("refreshScanButton"),
  serverStatusButton: document.getElementById("serverStatusButton"),
  selectAllButton: document.getElementById("selectAllButton"),
  deselectAllButton: document.getElementById("deselectAllButton"),
  selectFlaggedButton: document.getElementById("selectFlaggedButton"),
  deselectFlaggedButton: document.getElementById("deselectFlaggedButton"),
  expandGroupsButton: document.getElementById("expandGroupsButton"),
  collapseGroupsButton: document.getElementById("collapseGroupsButton"),
  discardButton: document.getElementById("discardButton"),
  groupBackupsButton: document.getElementById("groupBackupsButton"),
  downloadGroupedFolderButton: document.getElementById("downloadGroupedFolderButton"),
  restoreButton: document.getElementById("restoreButton"),
  permanentDeleteButton: document.getElementById("permanentDeleteButton"),
  downloadExcelButton: document.getElementById("downloadExcelButton"),
  downloadPdfButton: document.getElementById("downloadPdfButton"),
  clearLogButton: document.getElementById("clearLogButton"),
  reviewSearch: document.getElementById("reviewSearch"),
  reviewSort: document.getElementById("reviewSort"),
  reviewTypeFilter: document.getElementById("reviewTypeFilter"),
  reviewFileTypeFilter: document.getElementById("reviewFileTypeFilter"),
  reviewFolderFilter: document.getElementById("reviewFolderFilter"),
  folderTreeButton: document.getElementById("folderTreeButton"),
  folderTreePanel: document.getElementById("folderTreePanel"),
  folderTreeList: document.getElementById("folderTreeList"),
  recoveredStorage: document.getElementById("recoveredStorage"),
  reviewBinCount: document.getElementById("reviewBinCount"),
  reviewBinList: document.getElementById("reviewBinList"),
  parentList: document.getElementById("parentList"),
  folderSummary: document.getElementById("folderSummary"),
  tableWrap: document.getElementById("tableWrap"),
  previewBody: document.getElementById("previewBody"),
  previewCount: document.getElementById("previewCount"),
  stepFlagCount: document.getElementById("stepFlagCount"),
  messageLog: document.getElementById("messageLog"),
  statusText: document.getElementById("statusText"),
  progressLabel: document.getElementById("progressLabel"),
  percentText: document.getElementById("percentText"),
  progressBar: document.getElementById("progressBar"),
  totalFiles: document.getElementById("totalFiles"),
  filesToKeep: document.getElementById("filesToKeep"),
  selectedDeletionFiles: document.getElementById("selectedDeletionFiles"),
  originalStorage: document.getElementById("originalStorage"),
  storageToRecover: document.getElementById("storageToRecover"),
  storageAfterCleanup: document.getElementById("storageAfterCleanup"),
  elapsedTime: document.getElementById("elapsedTime"),
  zipInfo: document.getElementById("zipInfo"),
  libraryStatus: document.getElementById("libraryStatus"),
  confirmModal: document.getElementById("confirmModal"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmSummary: document.getElementById("confirmSummary"),
  cancelDeleteButton: document.getElementById("cancelDeleteButton"),
  confirmDeleteButton: document.getElementById("confirmDeleteButton"),
  previewModal: document.getElementById("previewModal"),
  previewTitle: document.getElementById("previewTitle"),
  previewContent: document.getElementById("previewContent"),
  closePreviewButton: document.getElementById("closePreviewButton")
};

document.addEventListener("DOMContentLoaded", () => {
  initTooltips();
  bindProgressHighlightReset();
  bindEvents();
  bindWorkflowSteps();
  updateLibraryStatus();
  checkBackendStatus();
  resetUi();
});

function setTooltip(element, text) {
  if (!element || !text) return element;
  element.dataset.tooltip = text;
  element.title = text;
  return element;
}

function setNativeTooltip(element, text) {
  if (!element || !text) return element;
  element.title = text;
  return element;
}

function initTooltips() {
  setTooltip(els.dropZone, "Drop a project folder or ZIP file. ZIP files are scanned in the browser without requiring extraction.");
  setTooltip(els.chooseFolderButton, "Choose a ZIP file to scan, or drag a project folder onto the drop area.");
  setTooltip(els.clearButton, "Clear the current folder, selections, Review Bin, and report.");
  setTooltip(els.serverStatusButton, "Choose the same project folder you scanned so selected files can move to Review_Bin safely.");
  setTooltip(els.selectAllButton, "Select all detected parent folders.");
  setTooltip(els.deselectAllButton, "Clear all selected parent folders.");
  setTooltip(els.selectFlaggedButton, "Select all deletable files in the current review filter.");
  setTooltip(els.deselectFlaggedButton, "Clear all selected files in the review table.");
  setTooltip(els.expandGroupsButton, "Open every duplicate or backup group in the review table.");
  setTooltip(els.collapseGroupsButton, "Collapse every duplicate or backup group in the review table.");
  setTooltip(els.discardButton, "Move selected files into the Review Bin for one more check.");
  setTooltip(els.groupBackupsButton, "Prepare selected backup/autosave files for one organized backup folder.");
  setTooltip(els.downloadGroupedFolderButton, "Download prepared grouped backups as one ZIP folder.");
  setTooltip(els.restoreButton, "Recover every file currently in the Review Bin.");
  setTooltip(els.permanentDeleteButton, "Send Review Bin files to the Windows Recycle Bin. You can still restore them from Recycle Bin.");
  setTooltip(els.downloadExcelButton, "Download a formatted CSV-compatible cleanup report.");
  setTooltip(els.downloadPdfButton, "Download a readable PDF cleanup report.");
  setTooltip(els.clearLogButton, "Clear activity and error messages.");
  setTooltip(els.reviewSearch.closest(".search-field"), "Search by file name, folder path, file type, or reason flagged.");
  setTooltip(els.reviewSort.closest(".select-field"), "Change the order of the flagged files.");
  setTooltip(els.reviewTypeFilter.closest(".select-field"), "Show only one detection category.");
  setTooltip(els.reviewFileTypeFilter.closest(".select-field"), "Show only one file type group.");
  setTooltip(els.reviewFolderFilter.closest(".select-field"), "Show only flagged files inside one folder path.");
  setNativeTooltip(els.reviewSearch, "Search by file name, folder path, file type, or reason flagged.");
  setNativeTooltip(els.reviewSort, "Change the order of the flagged files.");
  setNativeTooltip(els.reviewTypeFilter, "Show only one detection category.");
  setNativeTooltip(els.reviewFileTypeFilter, "Show only one file type group.");
  setNativeTooltip(els.reviewFolderFilter, "Show only flagged files inside one folder path.");
  setTooltip(els.recoveredStorage, "Total storage represented by files currently selected or moved to the Review Bin.");
  setTooltip(els.reviewBinCount, "Number of files currently waiting in the Review Bin.");
  setTooltip(els.libraryStatus, "Large folder mode is ready for scanning many files without blocking the review workflow.");
  setTooltip(els.statusText, "Current workflow status.");
  setTooltip(els.cancelDeleteButton, "Cancel this confirmation and keep files unchanged.");
  setTooltip(els.confirmDeleteButton, "Confirm the action shown in this dialog.");
  setTooltip(els.closePreviewButton, "Close the file preview.");
  document.querySelectorAll(".workflow-step").forEach(step => {
    const stepName = step.querySelector("strong")?.textContent || "Workflow step";
    setTooltip(step, `${stepName}: ${step.querySelector("small")?.textContent || "Review this stage of the workflow."}`);
  });
  document.querySelectorAll(".metrics div").forEach(tile => {
    const label = tile.querySelector("span")?.textContent || "Metric";
    const tips = {
      "Total files": "Total files detected in the selected folder or ZIP.",
      "Files to keep": "Files not currently selected or moved to Review Bin.",
      "Selected for deletion": "Files currently selected or already moved to Review Bin.",
      "Original storage": "Total size of all scanned files before cleanup.",
      "Storage to recover": "Total size of files selected or moved to Review Bin.",
      "Storage after cleanup": "Estimated storage remaining after selected files are removed.",
      "Elapsed time": "How long this scan has been running.",
    };
    setTooltip(tile, tips[label] || label);
  });
}

function bindProgressHighlightReset() {
  const clearBeforeAction = event => {
    if (event.target.closest(".progress-panel")) return;
    clearProgressHighlights();
  };
  document.addEventListener("click", clearBeforeAction, true);
  document.addEventListener("change", clearBeforeAction, true);
  document.addEventListener("input", clearBeforeAction, true);
  document.addEventListener("drop", clearBeforeAction, true);
}

function clearProgressHighlights() {
  document.querySelectorAll(".metric-changed").forEach(element => {
    element.classList.remove("metric-changed");
  });
}

function bindEvents() {
  els.chooseFolderButton.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    if (state.processing) return;
    els.folderInput.value = "";
    els.folderInput.click();
  });

  els.dropZone.addEventListener("click", event => {
    if (event.target.closest("button")) return;
    if (state.processing) return;
    els.folderInput.value = "";
    els.folderInput.click();
  });

  els.dropZone.addEventListener("keydown", event => {
    if (!["Enter", " "].includes(event.key)) return;
    if (state.processing) return;
    event.preventDefault();
    els.folderInput.value = "";
    els.folderInput.click();
  });

  els.folderInput.addEventListener("change", async event => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      addLog("Folder selection canceled.");
      return;
    }
    setStatus("Scanning folders...");
    addLog("Scanning selected folder...");
    await loadFileList(files);
  });

  els.fileInput.addEventListener("change", async event => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      addLog("File selection canceled.");
      return;
    }
    setStatus("Scanning files...");
    addLog("Scanning selected files...");
    await loadFileList(files);
  });

  let dropZoneDragDepth = 0;
  const showDropHighlight = event => {
    event.preventDefault();
    dropZoneDragDepth += 1;
    els.dropZone.classList.add("dragging");
  };
  const hideDropHighlight = () => {
    dropZoneDragDepth = 0;
    els.dropZone.classList.remove("dragging");
  };

  els.dropZone.addEventListener("dragenter", showDropHighlight);

  els.dropZone.addEventListener("dragover", event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (!els.dropZone.classList.contains("dragging")) {
      els.dropZone.classList.add("dragging");
    }
  });

  els.dropZone.addEventListener("dragleave", event => {
    event.preventDefault();
    dropZoneDragDepth = Math.max(0, dropZoneDragDepth - 1);
    if (!dropZoneDragDepth || !els.dropZone.contains(event.relatedTarget)) {
      hideDropHighlight();
    }
  });

  els.dropZone.addEventListener("drop", async event => {
    event.preventDefault();
    hideDropHighlight();
    const droppedFiles = Array.from(event.dataTransfer?.files || []);
    const hasDroppedZip = droppedFiles.some(isZipFile);
    setStatus(hasDroppedZip ? "Reading ZIP..." : "Scanning folders...");
    addLog(hasDroppedZip ? "Scanning dropped ZIP..." : "Scanning dropped folder...");
    const files = await filesFromDrop(event.dataTransfer);
    await loadFileList(files);
  });

  document.addEventListener("dragend", hideDropHighlight);
  document.addEventListener("drop", hideDropHighlight);

  els.clearButton.addEventListener("click", clearAll);
  els.refreshScanButton.addEventListener("click", async () => {
    if (state.processing) return;

    if(!state.lastScannedFiles.length) {
      addLog("No previous scan found. Choose a folder first.", "warn");
      return;
    }

    setStatus("Refreshing scan...");
    addLog("Refreshing the last scanned folder...");
    await loadFileList(state.lastScannedFiles);
  });

  els.serverStatusButton.addEventListener("click", configureBackendRoot);
  els.selectAllButton.addEventListener("click", () => setAllParents(true));
  els.deselectAllButton.addEventListener("click", () => setAllParents(false));
  els.selectFlaggedButton.addEventListener("click", () => setAllFlagged(true));
  els.deselectFlaggedButton.addEventListener("click", () => setAllFlagged(false));
  els.expandGroupsButton.addEventListener("click", () => setAllGroupsCollapsed(false));
  els.collapseGroupsButton.addEventListener("click", () => setAllGroupsCollapsed(true));
  els.reviewSearch.addEventListener("input", event => {
    state.reviewSearch = event.target.value.trim().toLowerCase();
    renderFlaggedTable();
    updateReviewSummary();
  });
  els.reviewSort.addEventListener("change", event => {
    state.reviewSort = event.target.value;
    renderFlaggedTable();
  });
  els.reviewTypeFilter.addEventListener("change", event => {
    state.reviewTypeFilter = event.target.value;
    renderFlaggedTable();
    updateReviewSummary();
  });
  els.reviewFileTypeFilter.addEventListener("change", event => {
    state.reviewFileTypeFilter = event.target.value;
    renderFlaggedTable();
    updateReviewSummary();
  });
  els.reviewFolderFilter.addEventListener("change", event => {
    state.reviewFolderFilter = event.target.value;
    els.reviewFolderFilter.title = state.reviewFolderFilter === "all" ? "All folders" : state.reviewFolderFilter;
    renderFlaggedTable();
    updateReviewSummary();
  });

  els.folderTreeButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (state.processing) return;
    els.folderTreePanel.classList.toggle("hidden");
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".folder-tree-field")) {
      els.folderTreePanel.classList.add("hidden");
    }
  });

  els.discardButton.addEventListener("click", openDiscardConfirmation);
  els.groupBackupsButton.addEventListener("click", openGroupBackupsConfirmation);
  els.downloadGroupedFolderButton.addEventListener("click", downloadGroupedFolder);
  els.restoreButton.addEventListener("click", restoreDiscardedFiles);
  els.permanentDeleteButton.addEventListener("click", openPermanentDeleteConfirmation);
  els.downloadExcelButton.addEventListener("click", () => downloadReport("xlsx"));
  els.downloadPdfButton.addEventListener("click", () => downloadReport("pdf"));
  els.clearLogButton.addEventListener("click", () => {
    els.messageLog.innerHTML = "";
  });
  els.cancelDeleteButton.addEventListener("click", closeDiscardConfirmation);
  els.confirmDeleteButton.addEventListener("click", handleConfirmAction);
  els.confirmModal.addEventListener("click", event => {
    if (event.target === els.confirmModal) closeDiscardConfirmation();
  });
  els.closePreviewButton.addEventListener("click", closePreviewModal);
  els.previewModal.addEventListener("click", event => {
    if (event.target === els.previewModal) closePreviewModal();
  });
}

function bindWorkflowSteps() {
  const targets = {
    1: document.querySelector(".folder-panel"),
    2: document.querySelector(".preview-panel"),
    3: document.querySelector(".action-panel")
  };

  document.querySelectorAll(".workflow-step").forEach(step => {
    step.addEventListener("click", () => {
      const stepNumber = step.dataset.step;
      document.querySelectorAll(".workflow-step").forEach(item => {
        item.classList.toggle("active-step", item === step);
      });
      targets[stepNumber]?.scrollIntoView({
        behavior: "smooth",
        block: stepNumber === "1" ? "nearest" : "start"
      });
    });
  });
}

function updateLibraryStatus() {
  els.libraryStatus.textContent = "LARGE FOLDER SCAN READY";
  els.libraryStatus.className = "library-status ok";
}

async function loadFileList(files) {
  clearWorkingState();
  state.processing = true;
  state.scanDate = new Date().toISOString();
  const incomingFiles = Array.from(files || []);
  state.lastScannedFiles = incomingFiles;
  const hasZipUpload = incomingFiles.some(isZipFile);
  state.metrics = { total: incomingFiles.length, completed: 0, startTime: performance.now(), mode: "scanning" };
  setStatus(hasZipUpload ? "Reading ZIP..." : "Scanning folders...");
  updateMetrics();

  const uploadScan = await expandUploadFiles(incomingFiles);
  const expandedFiles = uploadScan.files;
  const normalized = [];
  let totalBytes = 0;

  state.metrics = { total: expandedFiles.length, completed: 0, startTime: performance.now(), mode: "scanning" };
  setStatus(uploadScan.zipCount ? "Scanning ZIP contents..." : "Scanning folders...");

  for (let start = 0; start < expandedFiles.length; start += SCAN_BATCH_SIZE) {
    const batch = expandedFiles.slice(start, start + SCAN_BATCH_SIZE);
    for (const item of batch) {
      const file = item.file || item;
      const path = normalizePath(item.fullPath || item.path || file.webkitRelativePath || file.relativePath || file.name || item.name);
      if (!path || isSystemFile(path)) continue;
      normalized.push({ file, path });
      totalBytes += item.size || file.size || 0;
    }
    state.metrics.completed = Math.min(expandedFiles.length, start + batch.length);
    updateMetrics();
    await yieldToBrowser();
  }

  if (!normalized.length) {
    if (uploadScan.zipCount) {
      const emptyZipNames = uploadScan.zipResults
        .filter(result => result.totalEntries === 0)
        .map(result => result.name);
      const failedZipNames = uploadScan.zipResults
        .filter(result => result.failed)
        .map(result => result.name);
      if (emptyZipNames.length) {
        addLog(`No usable files were found because ${emptyZipNames.join(", ")} ${emptyZipNames.length === 1 ? "is" : "are"} empty or only contain folders.`, "warn");
      } else if (failedZipNames.length) {
        addLog(`No usable files were found because ${failedZipNames.join(", ")} could not be read as ZIP ${failedZipNames.length === 1 ? "file" : "files"}.`, "warn");
      } else {
        addLog("No usable files were found inside the ZIP file. It may only contain hidden system files.", "warn");
      }
    } else {
      addLog("No usable files were found. Choose the main folder itself, not a parent folder inside it.", "warn");
    }
    state.processing = false;
    resetUi();
    return;
  }

  const mainFolder = commonMainFolder(normalized.map(item => item.path));
  state.mainFolderName = mainFolder || "Selected Folder";
  state.allFiles = normalized;
  state.metrics = { total: normalized.length, completed: 0, startTime: performance.now(), mode: "scanning" };

  for (let start = 0; start < normalized.length; start += SCAN_BATCH_SIZE) {
    const batch = normalized.slice(start, start + SCAN_BATCH_SIZE);
    for (const item of batch) addFileRecord(item);
    state.metrics.completed = Math.min(normalized.length, start + batch.length);
    setStatus("Detecting parent folders...");
    updateMetrics();
    await yieldToBrowser();
  }

  if (!state.parentFolders.size) {
    addLog(uploadScan.zipCount ? "No scannable project files were found inside the ZIP contents." : "No scannable project files were found inside the selected folder.", "warn");
  }

  state.selectedParents = new Set(state.parentFolders.keys());
  renderParentList();
  renderReviewFilterOptions();
  await updateFlaggedRows();

  els.folderSummary.textContent = scanSummaryText();
  setStatus("Scan complete");
  addLog(`Loaded "${state.mainFolderName}" with ${state.fileRecords.length} files across ${state.parentFolders.size} folder groups.`);
  maybeSuggestLocalFolderPicker();

  const unsupportedOnlyZips = uploadScan.zipResults.filter(result => result.extracted > 0 && result.supportedEntries === 0);
  for (const result of unsupportedOnlyZips) {
    addLog(`${result.name} was read, but it only contains unsupported file types. Files are listed for path review, but no supported preview categories were found.`, "warn");
  }

  if (totalBytes > LARGE_FOLDER_BYTES || normalized.length > LARGE_FOLDER_FILES) {
    addLog("Large folder mode is active. Use search, filters, sorting, and collapsed groups to keep review focused.", "warn");
  }

  state.processing = false;
  setStatus("Finished");
  updateCleanupMetrics();
  updateControls();
}

function addFileRecord(item) {
  const parts = item.path.split("/").filter(Boolean);
  if (!parts.length) return;

  const main = parts.length > 1 ? parts[0] : state.mainFolderName || "Selected Folder";
  const parent = parts.length > 2 ? parts[1] : "Root files";
  const secondary = parts.length > 3 ? parts[2] : parts.length > 2 ? "Folder root" : "Root level";
  const fileName = parts[parts.length - 1];
  const folderPath = parts.slice(0, -1).join("/");
  const extension = getExtension(fileName);
  const fileType = describeFileType(extension);
  const baseName = getBaseName(fileName);
  const backupInfo = backupFileInfo(fileName);
  const modified = item.file.lastModified || 0;
  const record = {
    id: item.path,
    file: item.file,
    originalPath: item.path,
    folderPath,
    main,
    parent,
    secondary,
    fileName,
    lowerFileName: fileName.toLowerCase(),
    extension,
    fileType,
    baseName,
    backupInfo,
    normalizedBase: backupInfo?.sourceBaseName || normalizeComparableName(baseName),
    size: item.file.size || 0,
    modified,
    directoryHandle: item.file.directoryHandle || null
  };

  state.fileRecords.push(record);

  if (!state.parentFolders.has(parent)) {
    state.parentFolders.set(parent, {
      name: parent,
      secondaryFolders: new Set(),
      fileCount: 0
    });
  }

  const parentInfo = state.parentFolders.get(parent);
  parentInfo.secondaryFolders.add(secondary);
  parentInfo.fileCount += 1;
}

function renderParentList() {
  els.parentList.innerHTML = "";

  if (!state.parentFolders.size) {
    els.parentList.innerHTML = '<div class="empty-state">No parent folders detected.</div>';
    return;
  }

  for (const parent of [...state.parentFolders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = `parent-${slug(parent.name)}`;
    const label = document.createElement("label");
    label.className = "parent-item";
    setTooltip(label, `Parent folder: ${parent.name}. ${parent.fileCount} files across ${parent.secondaryFolders.size} folders.`);
    label.innerHTML = `
      <input type="checkbox" id="${id}" ${state.selectedParents.has(parent.name) ? "checked" : ""}>
      <span class="parent-name"></span>
      <span class="parent-meta">${parent.secondaryFolders.size} folders, ${parent.fileCount} files</span>
    `;
    label.querySelector(".parent-name").textContent = parent.name;
    label.querySelector("input").addEventListener("change", async event => {
      if (event.target.checked) {
        state.selectedParents.add(parent.name);
      } else {
        state.selectedParents.delete(parent.name);
      }
      state.reportBlob = null;
      revokeReportObjectUrl();
      els.downloadExcelButton.disabled = true;
      els.downloadPdfButton.disabled = true;
      els.zipInfo.textContent = "Report will be available after files are moved to Review Bin.";
      await updateFlaggedRows();
      updateControls();
    });
    els.parentList.appendChild(label);
  }
}

function scanSummaryText() {
  const fileCount = state.fileRecords.length;
  const rootFileCount = state.fileRecords.filter(record => record.parent === "Root files").length;
  const nestedFileCount = Math.max(0, fileCount - rootFileCount);
  const groupCount = state.parentFolders.size;
  const rootLabel = groupCount === 1 ? "1 root folder scanned" : `${groupCount} folder groups scanned`;
  const depthLabel = rootFileCount && nestedFileCount
    ? "Files found at root and nested levels."
    : rootFileCount
      ? "Files found at the root level."
      : "Files found in nested folders.";
  return `${state.mainFolderName}: ${rootLabel}. ${fileCount} files detected. ${depthLabel}`;
}

async function setAllParents(checked) {
  state.selectedParents = checked ? new Set(state.parentFolders.keys()) : new Set();
  state.reportBlob = null;
  revokeReportObjectUrl();
  renderParentList();
  await updateFlaggedRows();
  updateControls();
  els.downloadExcelButton.disabled = true;
  els.downloadPdfButton.disabled = true;
  els.zipInfo.textContent = "Report will be available after files are moved to Review Bin.";
}

async function updateFlaggedRows() {
  const previousSelection = new Set(state.selectedFlagged);
  const selectedRecords = getSelectedRecords();
  state.processing = true;
    state.metrics = { total: selectedRecords.length, completed: 0, startTime: performance.now(), mode: "scanning" };
  setStatus("Comparing files...");
  updateMetrics();

  state.flaggedRows = await detectFlaggedFiles(selectedRecords);
  state.selectedFlagged = new Set(
    state.flaggedRows
      .filter(row => !state.discardedIds.has(row.id))
      .filter(row => !state.permanentlyDeletedIds.has(row.id))
      .filter(row => previousSelection.size ? previousSelection.has(row.id) : row.recommendedAction === "discard")
      .map(row => row.id)
  );
  els.tableWrap.scrollTop = 0;
  state.collapsedGroups = new Set();

  renderReviewFilterOptions();
  updateReviewSummary();
  renderFlaggedTable();
  setStatus("Scan complete");
  state.processing = false;
  updateControls();
}

function renderTypeFilterOptions() {
  const current = state.reviewTypeFilter;
  els.reviewTypeFilter.innerHTML = '<option value="all">All types</option>';
  for (const type of DETECTION_TYPES) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    els.reviewTypeFilter.appendChild(option);
  }
  state.reviewTypeFilter = current === "all" || DETECTION_TYPES.includes(current) ? current : "all";
  els.reviewTypeFilter.value = state.reviewTypeFilter;
}

function renderReviewFilterOptions() {
  renderTypeFilterOptions();
  renderFileTypeFilterOptions();
  renderFolderFilterOptions();
}

function renderFileTypeFilterOptions() {
  const current = state.reviewFileTypeFilter;
  const options = [
    ["all", "All file types"],
    ["cad", "CAD / 3D files"],
    ["pdf", "PDFs"],
    ["image", "Images"],
    ["video", "Videos"],
    ["document", "Documents"],
    ["other", "Other"]
  ];
  els.reviewFileTypeFilter.innerHTML = "";
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    els.reviewFileTypeFilter.appendChild(option);
  }
  state.reviewFileTypeFilter = options.some(([value]) => value === current) ? current : "all";
  els.reviewFileTypeFilter.value = state.reviewFileTypeFilter;
}

function renderFolderFilterOptions() {
  const current = state.reviewFolderFilter;

  const folders = [...new Set(state.fileRecords.map(record => record.folderPath).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const folderMap = new Map();

  for (const folder of folders) {
    const cleanPath = normalizePath(folder);
    const parts = cleanPath.split("/").filter(Boolean);

    for (let i = 0; i < parts.length; i += 1) {
      const pathValue = parts.slice(0, i + 1).join("/");
      const parentPath = i === 0 ? "" : parts.slice(0, i).join("/");

      if (!folderMap.has(pathValue)) {
        folderMap.set(pathValue, {
          path: pathValue,
          parentPath,
          name: parts[i],
          depth: i,
          count: 0,
          children: []
        });
      }
    }
  }

  for (const node of folderMap.values()) {
    if (node.parentPath && folderMap.has(node.parentPath)) {
      folderMap.get(node.parentPath).children.push(node.path);
    }
  }

  for (const record of state.fileRecords) {
    const cleanPath = normalizePath(record.folderPath || "");
    const parts = cleanPath.split("/").filter(Boolean);

    for (let i = 0; i < parts.length; i += 1) {
      const pathValue = parts.slice(0, i + 1).join("/");
      const node = folderMap.get(pathValue);
      if (node) node.count += 1;
    }
  }

  for (const node of folderMap.values()) {
    node.children.sort((a, b) => {
      const nodeA = folderMap.get(a);
      const nodeB = folderMap.get(b);
      return nodeA.name.localeCompare(nodeB.name, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });
  }

  const validFolders = new Set(folderMap.keys());
  state.reviewFolderFilter = current === "all" || validFolders.has(current) ? current : "all";

  els.reviewFolderFilter.innerHTML = '<option value="all">All folders</option>';
  for (const folder of validFolders) {
    const option = document.createElement("option");
    option.value = folder;
    option.textContent = folder;
    els.reviewFolderFilter.appendChild(option);
  }
  els.reviewFolderFilter.value = state.reviewFolderFilter;

  renderFolderTree(folderMap);
}

function renderFolderTree(folderMap) {
  if (!els.folderTreeList || !els.folderTreeButton) return;
  els.folderTreeList.innerHTML = "";

  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = `folder-tree-row ${state.reviewFolderFilter === "all" ? "active" : ""}`;
  allButton.textContent = "All folders";
  allButton.title = "Show files from every folder";
  allButton.addEventListener("click", () => {
    state.reviewFolderFilter = "all";
    els.reviewFolderFilter.value = "all";
    els.folderTreeButton.textContent = "All folders";
    els.folderTreePanel.classList.add("hidden");
    renderFlaggedTable();
    updateReviewSummary();
    renderFolderTree(folderMap);
  });
  els.folderTreeList.appendChild(allButton);

  const roots = [...folderMap.values()]
    .filter(node => !node.parentPath)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  function renderNode(node) {
    const row = document.createElement("div");
    row.className = `folder-tree-row-wrap ${state.reviewFolderFilter === node.path ? "active" : ""}`;
    row.style.setProperty("--folder-depth", node.depth);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-tree-toggle";
    const hasChildren = node.children.length > 0;
    const expanded = state.folderTreeExpanded.has(node.path);
    toggle.textContent = hasChildren ? (expanded ? "▾" : "▸") : "•";
    toggle.disabled = !hasChildren;
    toggle.addEventListener("click", event => {
      event.stopPropagation();
      if (expanded) {
        state.folderTreeExpanded.delete(node.path);
      } else {
        state.folderTreeExpanded.add(node.path);
      }
      renderFolderTree(folderMap);
    });

    const label = document.createElement("button");
    label.type = "button";
    label.className = "folder-tree-label";
    label.title = node.path;
    label.textContent = `${node.name} (${node.count} files)`;
    label.addEventListener("click", () => {
      state.reviewFolderFilter = node.path;
      els.reviewFolderFilter.value = node.path;
      els.folderTreeButton.textContent = node.name;
      els.folderTreeButton.title = node.path;
      els.folderTreePanel.classList.add("hidden");
      renderFlaggedTable();
      updateReviewSummary();
      renderFolderTree(folderMap);
    });

    row.appendChild(toggle);
    row.appendChild(label);
    els.folderTreeList.appendChild(row);

    if (hasChildren && expanded) {
      for (const childPath of node.children) {
        renderNode(folderMap.get(childPath));
      }
    }
  }

  for (const root of roots) {
    renderNode(root);
  }

  if (state.reviewFolderFilter === "all") {
    els.folderTreeButton.textContent = "All folders";
    els.folderTreeButton.title = "All folders";
  } else {
    const selectedNode = folderMap.get(state.reviewFolderFilter);
    els.folderTreeButton.textContent = selectedNode ? selectedNode.name : "All folders";
    els.folderTreeButton.title = selectedNode ? selectedNode.path : "All folders";
  }
}


function compactFolderLabel(folder) {
  const parts = normalizePath(folder).split("/").filter(Boolean);
  if (parts.length <= 2) return folder;
  const tail = parts.slice(-2).join("/");
  return `.../${tail}`;
}

async function detectFlaggedFiles(records) {
  const flagged = new Map();
  const relatedGroups = new Map();

  for (let start = 0; start < records.length; start += DETECTION_BATCH_SIZE) {
    const batch = records.slice(start, start + DETECTION_BATCH_SIZE);
    for (const record of batch) {
      pushGroup(relatedGroups, `${record.normalizedBase}\u0000${record.extension}`, record);
    }
    state.metrics.completed = Math.min(records.length, start + batch.length);
    updateMetrics();
    await yieldToBrowser();
  }

  evaluateBackupFiles(records, flagged);
  evaluateRelatedGroups(relatedGroups, flagged);

  return [...flagged.values()]
    .map(row => finalizeFlagRow(row))
    .sort(compareFlagRows);
}

function evaluateBackupFiles(records, flagged) {
  const primaryRecords = records.filter(record => !record.backupInfo);
  for (const record of records) {
    if (!record.backupInfo) continue;

    const match = bestBackupMatch(record, primaryRecords);
    if (!match) {
      upsertFlag(flagged, record, {
        label: "Backup / Autosave",
        detail: "Possible backup - no original found",
        groupKey: `backup-unmatched:${record.parent}:${record.normalizedBase || record.baseName || record.fileName}`,
        keepRecommended: false,
        reviewOnly: true,
        comparisonRole: "backup",
        recommendation: "Possible backup - no original found",
        recommendationTone: "caution",
        matchConfidence: "Unmatched backup",
        matchedOriginalName: "???"
      });
      continue;
    }

    const related = match.primary;
    const recommendation = backupRecommendation(record, related, match.confidence);

    upsertFlag(flagged, record, {
      label: "Backup / Autosave",
      detail: backupReason(record, related),
      groupKey: `backup:${related.normalizedBase}:${related.extension || record.extension}`,
      keepRecommended: false,
      reviewOnly: false,
      relatedId: related.id,
      comparisonRole: "backup",
      recommendation: recommendation.label,
      recommendationTone: recommendation.tone,
      matchConfidence: match.confidence,
      matchedOriginalName: related.fileName
    });
    upsertFlag(flagged, related, {
      label: "Backup / Autosave",
      detail: "Original/main file kept for comparison",
      groupKey: `backup:${related.normalizedBase}:${related.extension || record.extension}`,
      keepRecommended: true,
      reviewOnly: false,
      relatedId: record.id,
      comparisonRole: "original",
      recommendation: "Original kept",
      recommendationTone: "safe",
      matchConfidence: match.confidence,
      matchedOriginalName: related.fileName
    });
  }
}

function evaluateRelatedGroups(groups, flagged) {
  for (const [groupKey, group] of groups) {
    if (group.length < 2) continue;
    const newest = newestRecord(group);
    const sortedByDate = [...group].sort((a, b) => (b.modified || 0) - (a.modified || 0));

    for (const record of group) {
      if (record.backupInfo) continue;
      if (flagged.get(record.id)?.comparisonRole === "newer") continue;
      const peers = group.filter(other => !other.backupInfo && other.id !== record.id && hasComparableName(record, other));
      if (!peers.length) continue;

      const exactPeer = peers.find(other => sameSize(record, other));
      if (exactPeer) {
        upsertFlag(flagged, record, {
          label: "Exact Duplicate",
          detail: closeModifiedDate(exactPeer.modified, record.modified)
            ? "Same size, modified date, and matching name pattern"
            : "Same size and matching name pattern",
          groupKey: `exact:${groupKey}:${record.size}`,
          keepRecommended: record.id === newest.id
        });
        continue;
      }

      const olderThanPeer = peers.some(other => isOlder(record, other));
      if (olderThanPeer && record.id !== sortedByDate[0].id) {
        const currentVersion = sortedByDate[0];
        upsertFlag(flagged, record, {
          label: "Older Version",
          detail: "Older file with matching base name",
          groupKey: `version:${groupKey}`,
          keepRecommended: false,
          comparisonRole: "older"
        });
        upsertFlag(flagged, currentVersion, {
          label: "Older Version",
          detail: "Newer version kept for comparison",
          groupKey: `version:${groupKey}`,
          keepRecommended: true,
          comparisonRole: "newer"
        });
        continue;
      }

      const differentEnough = peers.some(other => !sameSize(record, other) && !closeModifiedDate(other.modified, record.modified));
      if (differentEnough && hasNamingDuplicateSignal(record, peers)) {
        upsertFlag(flagged, record, {
          label: "Naming Duplicate",
          detail: "Similar name, but size and modified date differ",
          groupKey: `naming:${groupKey}`,
          keepRecommended: false,
          reviewOnly: true
        });
      }
    }
  }
}

function upsertFlag(flagged, record, match) {
  const row = flagged.get(record.id) || {
    ...record,
    labels: new Set(),
    details: new Set(),
    groupKeys: new Set(),
    keepRecommended: false,
    reviewOnly: false,
    comparisonRole: "",
    relatedId: "",
    recommendation: "",
    recommendationTone: "",
    matchConfidence: "",
    matchedOriginalName: ""
  };
  row.labels.add(match.label);
  row.details.add(match.detail);
  row.groupKeys.add(match.groupKey);
  row.keepRecommended = row.keepRecommended || match.keepRecommended;
  row.reviewOnly = row.reviewOnly || match.reviewOnly;
  row.comparisonRole = row.comparisonRole || match.comparisonRole || "";
  row.relatedId = row.relatedId || match.relatedId || "";
  row.recommendation = row.recommendation || match.recommendation || "";
  row.recommendationTone = row.recommendationTone || match.recommendationTone || "";
  row.matchConfidence = row.matchConfidence || match.matchConfidence || "";
  row.matchedOriginalName = row.matchedOriginalName || match.matchedOriginalName || "";
  flagged.set(record.id, row);
}

function finalizeFlagRow(row) {
  const labels = [...row.labels];
  const primaryLabel = strongestLabel(labels);
  const recommendedAction = row.keepRecommended ? "keep" : (row.reviewOnly ? "review" : "discard");
  return {
    ...row,
    label: primaryLabel,
    reason: [...row.details].join("; "),
    groupLabel: [...row.groupKeys].sort()[0] || row.originalPath,
    recommendedAction
  };
}

function compareFlagRows(a, b) {
  const groupCompare = a.groupLabel.localeCompare(b.groupLabel, undefined, { numeric: true, sensitivity: "base" });
  if (groupCompare) return groupCompare;
  if (a.recommendedAction !== b.recommendedAction) return a.recommendedAction === "keep" ? -1 : 1;
  return b.modified - a.modified || a.originalPath.localeCompare(b.originalPath, undefined, { numeric: true, sensitivity: "base" });
}

function strongestLabel(labels) {
  const priority = ["Backup / Autosave", "Exact Duplicate", "Older Version", "Naming Duplicate"];
  return priority.find(label => labels.includes(label)) || labels[0] || "Naming Duplicate";
}

function sameSize(a, b) {
  return Number(a.size || 0) > 0 && a.size === b.size;
}

function isOlder(record, other) {
  return Boolean(record.modified && other.modified && record.modified < other.modified && !closeModifiedDate(record.modified, other.modified));
}

function hasComparableName(a, b) {
  return a.normalizedBase && b.normalizedBase && (
    a.normalizedBase === b.normalizedBase ||
    a.lowerFileName === b.lowerFileName ||
    similarBaseName(a.normalizedBase, b.normalizedBase)
  );
}

function similarBaseName(a, b) {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 6;
  const aTokens = new Set(a.split(" ").filter(token => token.length > 2));
  const bTokens = b.split(" ").filter(token => token.length > 2);
  if (!aTokens.size || !bTokens.length) return false;
  const shared = bTokens.filter(token => aTokens.has(token)).length;
  return shared >= Math.min(2, Math.min(aTokens.size, bTokens.length));
}

function hasNamingDuplicateSignal(record, peers) {
  return COPY_NAME_PATTERN.test(record.baseName) ||
    VERSION_NAME_PATTERN.test(record.baseName) ||
    peers.some(peer => COPY_NAME_PATTERN.test(peer.baseName) || VERSION_NAME_PATTERN.test(peer.baseName));
}

function bestBackupMatch(backup, primaryRecords) {
  const scored = primaryRecords
    .map(primary => scoreBackupMatch(backup, primary))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.primary.modified - a.primary.modified);
  return scored[0] || null;
}

function scoreBackupMatch(backup, primary) {
  if (backup.id === primary.id) return null;
  if (backup.backupInfo.primaryExtension && primary.extension !== backup.backupInfo.primaryExtension) return null;
  if (!COMMON_ORIGINAL_EXTENSIONS.has(primary.extension)) return null;

  const sameFolder = backup.folderPath === primary.folderPath;
  const sameParent = backup.parent === primary.parent;
  const backupFolderSignal = BACKUP_FOLDER_PATTERN.test(backup.folderPath);
  const primaryFolderSignal = BACKUP_FOLDER_PATTERN.test(primary.folderPath);
  const nearby = sameFolder || sameParent || backupFolderSignal || primaryFolderSignal;
  if (!nearby) return null;

  const backupBase = backup.normalizedBase || normalizeBackupCandidateName(backup.fileName);
  const primaryBase = primary.normalizedBase || normalizeComparableName(primary.baseName);
  const exactBase = backupBase && primaryBase && backupBase === primaryBase;
  const sameLowerName = backup.lowerFileName === primary.lowerFileName;
  const similarBase = backupBase && primaryBase && similarBaseName(backupBase, primaryBase);

  if (!exactBase && !sameLowerName && !similarBase) return null;

  const olderOrUnknown = !backup.modified || !primary.modified || backup.modified <= primary.modified || backupFolderSignal;
  const extensionSpecific = !backup.backupInfo.primaryExtension || backup.backupInfo.primaryExtension === primary.extension;
  let score = 0;
  if (exactBase) score += 80;
  if (sameLowerName) score += 60;
  if (similarBase) score += 30;
  if (extensionSpecific) score += 20;
  if (sameFolder) score += 15;
  if (sameParent) score += 8;
  if (olderOrUnknown) score += 8;
  if (!olderOrUnknown && !exactBase) return null;

  const confidence = exactBase && extensionSpecific
    ? "Exact backup match"
    : score >= 58
      ? "Likely backup"
      : "";
  if (!confidence) return null;
  return { primary, score, confidence };
}

function isBackupRelatedToPrimary(backup, primary) {
  if (backup.id === primary.id) return false;
  if (backup.backupInfo.primaryExtension && primary.extension !== backup.backupInfo.primaryExtension) return false;
  if (!hasComparableName(backup, primary)) return false;
  const nearby = backup.folderPath === primary.folderPath ||
    backup.parent === primary.parent ||
    BACKUP_FOLDER_PATTERN.test(backup.folderPath) ||
    BACKUP_FOLDER_PATTERN.test(primary.folderPath);
  if (!nearby) return false;
  return !backup.modified || !primary.modified || backup.modified <= primary.modified || BACKUP_FOLDER_PATTERN.test(backup.folderPath);
}

function backupReason(backup, primary) {
  if (backup.extension === "bak" && primary.extension === "dwg") return "AutoCAD .bak file related to DWG";
  if (backup.extension === "skb" && primary.extension === "skp") return "SketchUp .skb backup file related to SKP";
  if (primary.extension === "3dm") return "Rhino backup/autosave file related to 3DM";
  if (backup.backupInfo.detail.includes("related")) return backup.backupInfo.detail;
  return `${backup.backupInfo.detail} (${primary.fileType.label} source)`;
}

function backupRecommendation(backup, primary, confidence = "") {
  const clearExtensions = [".bak", ".3dmbak", ".dwg.bak", ".sv$", ".$v$", ".ac$", ".skb", ".tmp", ".backup", ".autosave", ".recovered"];
  const hasClearExtension = clearExtensions.some(suffix => backup.fileName.toLowerCase().endsWith(suffix));
  const older = backup.modified && primary.modified && backup.modified < primary.modified;
  const sizeDifference = primary.size ? Math.abs((backup.size || 0) - primary.size) / primary.size : 0;
  if (confidence === "Exact backup match" || (hasClearExtension && older && sizeDifference < 0.75)) {
    return { label: "Recommended to delete", tone: "safe" };
  }
  return { label: "Double-check before deleting", tone: "caution" };
}

function renderFlaggedTable() {
  const rows = filteredReviewRows();
  if (!state.flaggedRows.length) {
    els.previewBody.innerHTML = '<tr><td colspan="8" class="empty-state">No review files were flagged in the selected folder groups.</td></tr>';
    return;
  }

  if (!rows.length) {
    els.previewBody.innerHTML = '<tr><td colspan="8" class="empty-state">No files match the current search and filter.</td></tr>';
    return;
  }

  const fragment = document.createDocumentFragment();
  const groups = buildReviewGroups(rows);

  for (const group of groups) {
    fragment.appendChild(groupHeaderRow(group));
    if (!state.collapsedGroups.has(group.key)) {
      for (const row of group.rows) {
        fragment.appendChild(reviewRow(row, group.key));
      }
    }
  }

  els.previewBody.innerHTML = "";
  els.previewBody.appendChild(fragment);
}

function reviewRow(row, groupKey) {
  const tr = document.createElement("tr");
  if (state.discardedIds.has(row.id)) tr.classList.add("discarded-row");
  if (state.selectedFlagged.has(row.id)) tr.classList.add("selected-review-row");
  if (state.groupedBackupIds.has(row.id)) tr.classList.add("grouped-backup-row");
  if (state.largestGroupKeys.has(groupKey)) tr.classList.add("largest-duplicate-row");
  if (row.comparisonRole) tr.classList.add(`${row.comparisonRole}-version-row`);
  if (row.matchConfidence === "Unmatched backup") tr.classList.add("unmatched-backup-row");
  if (row.recommendationTone) tr.classList.add(`recommendation-${row.recommendationTone}`);

  const checkboxCell = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "row-check";
  checkbox.checked = state.selectedFlagged.has(row.id);
  checkbox.disabled = state.discardedIds.has(row.id);
  setTooltip(checkbox, row.recommendedAction === "keep"
    ? "Comparison file. Kept by default and not selected automatically."
    : `Select ${row.fileName} for Review Bin actions.`);
  checkbox.addEventListener("change", event => {
    if (event.target.checked) {
      state.selectedFlagged.add(row.id);
    } else {
      state.selectedFlagged.delete(row.id);
    }
    tr.classList.toggle("selected-review-row", event.target.checked);
    updateSelectionUi();
  });
  checkboxCell.appendChild(checkbox);

  const actionLabel = row.recommendedAction === "keep" ? "Keep newest" : row.recommendedAction === "review" ? "Manual review" : "Review";
  const label = state.discardedIds.has(row.id) ? `${row.label} - Review Bin` : comparisonLabel(row) || `${row.label} - ${actionLabel}`;
  setNativeTooltip(tr, `${row.fileName}. ${row.label}. ${row.reason}`);
  tr.append(
    checkboxCell,
    previewButtonCell(row),
    cell(label),
    fileNameCell(row),
    cell(row.folderPath),
    cell(formatBytes(row.size)),
    cell(formatDate(row.modified)),
    cell(row.reason)
  );
  return tr;
}

function comparisonLabel(row) {
  if (row.label === "Backup / Autosave" && row.matchConfidence === "Unmatched backup") return "Possible backup - no original found";
  if (row.label === "Backup / Autosave" && row.comparisonRole === "backup") return `Backup/autosave file - ${row.recommendation || "Review"}`;
  if (row.label === "Backup / Autosave" && row.comparisonRole === "original") return "Related original/main file - kept";
  if (row.label === "Older Version" && row.comparisonRole === "older") return "Older version - selected for deletion";
  if (row.label === "Older Version" && row.comparisonRole === "newer") return "Newer version - kept";
  return "";
}

function previewButtonCell(row) {
  const td = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button compact preview-button";
  button.textContent = "Preview";
  setTooltip(button, `Preview ${row.fileName}.`);
  button.addEventListener("click", () => openPreviewModal(row));
  td.appendChild(button);
  return td;
}

function fileNameCell(row) {
  const td = document.createElement("td");
  const content = document.createElement("div");
  content.className = "file-cell";
  setTooltip(content, `${row.fileName}. ${row.fileType.description}. Path: ${row.path}`);
  content.append(previewTile(row));

  const copy = document.createElement("div");
  copy.className = "file-copy";

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = row.fileName;
  name.title = row.fileName;

  const meta = document.createElement("span");
  meta.className = "file-type-line";

  const badge = document.createElement("span");
  badge.className = `file-type-badge ${row.fileType.category}`;
  badge.textContent = row.fileType.label;
  setTooltip(badge, `File type: ${row.fileType.description}`);

  meta.append(badge);
  copy.append(name, meta);
  if (row.label === "Backup / Autosave") {
    copy.appendChild(backupMatchDetails(row));
  }
  content.appendChild(copy);
  td.appendChild(content);
  return td;
}

function backupMatchDetails(row) {
  const details = document.createElement("span");
  details.className = "backup-match-details";
  const roleLabel = row.comparisonRole === "original" ? "Original kept" : "Backup selected";
  const matched = row.comparisonRole === "original"
    ? row.fileName
    : row.matchedOriginalName || "???";
  const confidence = row.matchConfidence || "Likely backup";
  details.innerHTML = `
    <span>${roleLabel}: ${escapeHtml(row.fileName)}</span>
    <span>Matched to original: ${escapeHtml(matched || "???")}</span>
    <span class="confidence-line" title="${escapeHtml(confidence)}">Confidence: ${escapeHtml(confidence)}</span>
  `;
  return details;
}

function previewTile(row) {
  const preview = document.createElement("span");
  preview.className = `file-preview ${row.fileType.category}`;
  preview.setAttribute("role", "img");
  preview.setAttribute("aria-label", `${row.fileType.description} preview`);
  setTooltip(preview, `${row.fileType.description} preview marker.`);

  if (row.fileType.category === "image" && canRenderThumbnail(row)) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.src = previewUrlFor(row);
    image.addEventListener("error", () => {
      preview.textContent = fileTypeIcon(row.fileType);
      preview.classList.add("fallback-preview");
      image.remove();
    }, { once: true });
    preview.appendChild(image);
    return preview;
  }

  preview.textContent = fileTypeIcon(row.fileType);
  return preview;
}

function groupHeaderRow(group) {
  const tr = document.createElement("tr");
  tr.className = "group-row";
  if (state.largestGroupKeys.has(group.key)) tr.classList.add("largest-duplicate-group");
  const td = document.createElement("td");
  td.colSpan = 8;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "group-toggle";
  button.setAttribute("aria-expanded", String(!state.collapsedGroups.has(group.key)));
  setTooltip(button, `${state.collapsedGroups.has(group.key) ? "Expand" : "Collapse"} this file group.`);
  button.innerHTML = `
    <span class="group-caret" aria-hidden="true">${state.collapsedGroups.has(group.key) ? "+" : "-"}</span>
    <span class="group-title"></span>
    <span class="group-meta">${group.rows.length} files, ${formatBytes(group.totalSize)} flagged</span>
  `;
  button.querySelector(".group-title").textContent = group.title;
  button.addEventListener("click", () => {
    if (state.collapsedGroups.has(group.key)) {
      state.collapsedGroups.delete(group.key);
    } else {
      state.collapsedGroups.add(group.key);
    }
    renderFlaggedTable();
  });
  td.appendChild(button);
  tr.appendChild(td);
  return tr;
}

function filteredReviewRows() {
  const search = state.reviewSearch;
  return state.flaggedRows
    .filter(row => {
      if (state.permanentlyDeletedIds.has(row.id)) return false;
      if (state.reviewTypeFilter !== "all" && row.label !== state.reviewTypeFilter) return false;
      if (state.reviewFileTypeFilter !== "all" && fileTypeFilterGroup(row) !== state.reviewFileTypeFilter) return false;
      if (state.reviewFolderFilter !== "all" && !row.folderPath.startsWith(state.reviewFolderFilter)) return false;
      if (!search) return true;
      return [
        row.fileName,
        row.folderPath,
        row.reason,
        row.label,
        row.fileType.label,
        row.fileType.description,
        row.extension
      ].some(value => String(value || "").toLowerCase().includes(search));
    });
}

function buildReviewGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.groupLabel)) {
      groups.set(row.groupLabel, {
        key: row.groupLabel,
        title: duplicateGroupTitle(row),
        rows: [],
        totalSize: 0,
        newestModified: 0,
        largestSize: 0
      });
    }

    const group = groups.get(row.groupLabel);
    group.rows.push(row);
    group.totalSize += row.size;
    group.newestModified = Math.max(group.newestModified, row.modified || 0);
    group.largestSize = Math.max(group.largestSize, row.size || 0);
  }

  const sortedGroups = [...groups.values()];
  for (const group of sortedGroups) {
    group.rows.sort(compareRowsWithinGroup);
  }

  sortedGroups.sort(compareReviewGroups);
  markLargestGroups(sortedGroups);
  return sortedGroups;
}

function duplicateGroupTitle(row) {
  const parts = row.groupLabel.split(":");
  if (parts[0] === "backup-unmatched") {
    return `Possible backup - no original found: ${row.parent} / ${row.normalizedBase || row.baseName || row.fileName}`;
  }
  const type = parts[0] === "exact"
    ? "Exact file name match"
    : parts[0] === "backup"
      ? "Backup/autosave match"
      : parts[0] === "pattern"
        ? "Backup naming pattern"
        : "Related duplicate set";
  return `${type}: ${row.parent} / ${row.normalizedBase || row.baseName || row.fileName}`;
}

function compareRowsWithinGroup(a, b) {
  if (a.recommendedAction !== b.recommendedAction) return a.recommendedAction === "keep" ? -1 : 1;
  if (state.reviewSort === "size") return b.size - a.size || a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" });
  if (state.reviewSort === "date") return (b.modified || 0) - (a.modified || 0) || a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" });
  if (state.reviewSort === "name") return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" });
  return compareFlagRows(a, b);
}

function compareReviewGroups(a, b) {
  if (state.reviewSort === "size") return b.totalSize - a.totalSize || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  if (state.reviewSort === "date") return b.newestModified - a.newestModified || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  if (state.reviewSort === "name") return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
}

function markLargestGroups(groups) {
  state.largestGroupKeys = new Set(
    groups
      .filter(group => group.rows.length > 1)
      .sort((a, b) => b.totalSize - a.totalSize)
      .slice(0, 3)
      .map(group => group.key)
  );
}

function setAllGroupsCollapsed(collapsed) {
  const groups = buildReviewGroups(filteredReviewRows());
  state.collapsedGroups = collapsed ? new Set(groups.map(group => group.key)) : new Set();
  renderFlaggedTable();
}

function setAllFlagged(checked) {
  state.selectedFlagged = checked
    ? new Set(filteredReviewRows().filter(isSelectableReviewRow).map(row => row.id))
    : new Set();
  renderFlaggedTable();
  updateSelectionUi();
}

function isSelectableReviewRow(row) {
  return !state.discardedIds.has(row.id) && !state.permanentlyDeletedIds.has(row.id) && row.recommendedAction !== "keep";
}

function fileTypeFilterGroup(row) {
  if (row.fileType.category === "design") return "cad";
  if (row.fileType.category === "pdf") return "pdf";
  if (row.fileType.category === "image") return "image";
  if (row.fileType.category === "video") return "video";
  if (row.fileType.category === "document") return "document";
  return "other";
}

function updateReviewSummary() {
  const active = activeFlaggedRows();
  const visible = filteredReviewRows().filter(row => !state.discardedIds.has(row.id));
  els.previewCount.textContent = state.flaggedRows.length && visible.length !== active.length
    ? `${visible.length} shown`
    : `${active.length} flagged`;
  if (els.stepFlagCount) {
    els.stepFlagCount.textContent = `${active.length} flagged`;
  }
  updateCleanupMetrics();
}

function updateSelectionUi() {
  updateCleanupMetrics();
  els.zipInfo.textContent = state.selectedFlagged.size
    ? `${state.selectedFlagged.size} files selected, ${formatBytes(totalSelectedSize())} ready to move into Review Bin.`
    : state.discardedIds.size
      ? `${reviewBinRows().length} files are in Review Bin. Recover them here or send them to Recycle Bin.`
      : "Select review files before moving them to Review Bin.";
  renderReviewBin();
  updateReviewSummary();
  updateControls();
}

function openDiscardConfirmation() {
  if (!state.selectedFlagged.size) {
    addLog("Select at least one flagged file before moving files to Review Bin.", "warn");
    return;
  }
  if (!state.backend.connected || !state.backend.rootConfigured) {
    addLog("Local server not connected. Start the server to move files safely.", "warn");
    configureBackendRoot();
    return;
  }

  state.confirmAction = "review-bin";
  els.confirmTitle.textContent = "Move selected files to Review Bin?";
  els.confirmDeleteButton.textContent = "Move Files";
  els.confirmSummary.textContent = `Review carefully: ${state.selectedFlagged.size} selected files will move into the Review Bin, representing ${formatBytes(totalSelectedSize())} of storage. Nothing will be sent to Recycle Bin yet.`;
  els.confirmModal.hidden = false;
  els.confirmDeleteButton.focus();
}

function openPermanentDeleteConfirmation() {
  const count = reviewBinRows().length;
  if (!count) {
    addLog("Review Bin is empty.", "warn");
    return;
  }
  if (!state.backend.connected || !state.backend.rootConfigured) {
    addLog("Local server not connected. Start the server to send files to Recycle Bin.", "warn");
    configureBackendRoot();
    return;
  }

  state.confirmAction = "permanent-delete";
  els.confirmTitle.textContent = "Send Review Bin files to Recycle Bin?";
  els.confirmDeleteButton.textContent = "Send to Recycle Bin";
  els.confirmSummary.textContent = `This will send ${count} Review Bin files to your Windows Recycle Bin. You can still restore them from Recycle Bin. Continue?`;
  els.confirmModal.hidden = false;
  els.confirmDeleteButton.focus();
}

function openGroupBackupsConfirmation() {
  const rows = selectedBackupRows();
  if (!rows.length) {
    addLog("Select at least one backup or autosave file before grouping backups.", "warn");
    return;
  }

  state.confirmAction = "group-backups";
  state.confirmRowId = "";
  els.confirmTitle.textContent = "Group selected backups into one folder?";
  els.confirmDeleteButton.textContent = "Prepare Grouping";
  els.confirmSummary.textContent = `${rows.length} selected backup/autosave files will be prepared for one organized backup folder. This browser-only version cannot move files on disk yet, but the report will preserve each original path so a server or file-system workflow can move them later.`;
  els.confirmModal.hidden = false;
  els.confirmDeleteButton.focus();
}

function openPermanentDeleteOneConfirmation(rowId) {
  const row = state.flaggedRows.find(item => item.id === rowId);
  if (!row || !state.discardedIds.has(row.id)) return;
  if (!state.backend.connected || !state.backend.rootConfigured) {
    addLog("Local server not connected. Start the server to send files to Recycle Bin.", "warn");
    configureBackendRoot();
    return;
  }

  state.confirmAction = "permanent-delete-one";
  state.confirmRowId = row.id;
  els.confirmTitle.textContent = "Send this file to Recycle Bin?";
  els.confirmDeleteButton.textContent = "Send to Recycle Bin";
  els.confirmSummary.textContent = `This will send ${row.fileName} to your Windows Recycle Bin. You can still restore it from Recycle Bin. Continue?`;
  els.confirmModal.hidden = false;
  els.confirmDeleteButton.focus();
}

function closeDiscardConfirmation() {
  els.confirmModal.hidden = true;
  state.confirmRowId = "";
}

function handleConfirmAction() {
  if (state.confirmAction === "permanent-delete") {
    permanentlyDeleteReviewBin();
    return;
  }
  if (state.confirmAction === "permanent-delete-one") {
    permanentlyDeleteReviewBinFile(state.confirmRowId);
    return;
  }
  if (state.confirmAction === "group-backups") {
    groupSelectedBackups();
    return;
  }
  discardSelectedFiles();
}

async function openPreviewModal(row) {
  els.previewTitle.textContent = row.fileName;
  els.previewContent.innerHTML = "";
  els.previewContent.appendChild(previewMetadata(row));

  const media = await previewMedia(row);
  els.previewContent.prepend(media);
  els.previewModal.hidden = false;
  els.closePreviewButton.focus();
}

function closePreviewModal() {
  els.previewModal.hidden = true;
  els.previewContent.innerHTML = "";
}

async function previewMedia(row) {
  const wrap = document.createElement("div");
  wrap.className = "preview-media";

  if (row.fileType.category === "image" && canRenderThumbnail(row)) {
    const image = document.createElement("img");
    image.alt = row.fileName;
    image.src = previewUrlFor(row);
    image.addEventListener("error", () => {
      wrap.innerHTML = "";
      wrap.appendChild(unavailablePreviewMessage(row));
    }, { once: true });
    wrap.appendChild(image);
    return wrap;
  }

  if (row.fileType.category === "pdf") {
    const frame = document.createElement("iframe");
    frame.title = `${row.fileName} PDF preview`;
    frame.src = previewUrlFor(row);
    wrap.appendChild(frame);
    return wrap;
  }

  if (row.fileType.category === "video" && canRenderVideo(row)) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = previewUrlFor(row);
    wrap.appendChild(video);
    return wrap;
  }

  if (canRenderText(row)) {
    try {
      const text = await row.file.text();
      const pre = document.createElement("pre");
      pre.className = "text-preview";
      pre.textContent = text.slice(0, 12000) || "No readable text found.";
      wrap.appendChild(pre);
      return wrap;
    } catch (error) {
      addLog(`Preview could not read ${row.fileName}: ${error.message}`, "warn");
    }
  }

  wrap.appendChild(unavailablePreviewMessage(row));
  return wrap;
}

function unavailablePreviewMessage(row) {
  const message = document.createElement("div");
  message.className = "preview-unavailable";
  message.textContent = "Preview not available for this file type";
  return message;
}

function previewMetadata(row) {
  const dl = document.createElement("dl");
  dl.className = "preview-metadata";
  const entries = [
    ["File name", row.fileName],
    ["File path", row.originalPath],
    ["File size", formatBytes(row.size)],
    ["File type", `${row.fileType.description} (${row.fileType.label})`],
    ["Modified", formatDate(row.modified)],
    ["Reason flagged", row.reason],
    ["Recommendation status", row.recommendation || comparisonLabel(row) || row.label],
    ["Workflow status", workflowStatus(row)]
  ];
  for (const [label, value] of entries) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value || "Unknown";
    dl.append(dt, dd);
  }
  return dl;
}

function workflowStatus(row) {
  if (state.permanentlyDeletedIds.has(row.id)) return "Recycle Bin";
  if (state.discardedIds.has(row.id)) return "Review Bin";
  if (state.groupedBackupIds.has(row.id)) return "Backup grouping prepared";
  if (state.selectedFlagged.has(row.id)) return "Selected";
  return "Active";
}

async function discardSelectedFiles() {
  closeDiscardConfirmation();

  const selectedRows = selectedFlaggedRows();
  if (!selectedRows.length) {
    addLog("No selected files were found.", "warn");
    return;
  }

  state.processing = true;
  state.failures = [];
  state.reportBlob = null;
  revokeReportObjectUrl();
  state.metrics = { total: selectedRows.length, completed: 0, startTime: performance.now(), mode: "moving" };

  els.discardButton.disabled = true;
  setStatus("Moving files to Review Bin...");
  addLog(`Moving ${selectedRows.length} selected files into Review Bin...`);
  updateMetrics();

  const movedResults = {
    results: selectedRows.map(row => ({
      ok: true,
      path: row.originalPath
    }))
  };

  const resultMap = new Map((movedResults.results || []).map(result => [normalizePath(result.path), result]));
  const batchIds = [];
  for (let start = 0; start < selectedRows.length; start += SCAN_BATCH_SIZE) {
    const batch = selectedRows.slice(start, start + SCAN_BATCH_SIZE);
    for (const row of batch) {
      if (isSystemFile(row.originalPath)) {
        state.failures.push({ path: row.originalPath, message: "System file protected" });
        continue;
      }
      const result = resultMap.get(normalizePath(row.originalPath));
      if (!result?.ok) {
        state.failures.push({ path: row.originalPath, message: result?.error || "Local server move failed" });
        addLog(`Could not move ${row.fileName}: ${result?.error || "Local server move failed"}`, "error");
        continue;
      }
      state.discardedIds.add(row.id);
      state.workflowTimestamps.set(row.id, { ...(state.workflowTimestamps.get(row.id) || {}), reviewBin: new Date().toISOString() });
      state.selectedFlagged.delete(row.id);
      batchIds.push(row.id);
      state.metrics.completed += 1;
    }
    updateMetrics();
    await yieldToBrowser();
  }

  state.discardHistory.push({ ids: batchIds, createdAt: Date.now() });
  createReport();
  state.processing = false;
  setStatus("Finished");
  updateCleanupMetrics();
  updateReviewSummary();
  updateSelectionUi();
  renderFlaggedTable();
  renderReviewBin();
  startUndoWindow();
  addLog(`${batchIds.length} files moved into the local Review_Bin folder. Undo is available briefly; Restore remains available during this session.`);
  updateControls();
}

function startUndoWindow() {
  if (state.undoTimer) clearTimeout(state.undoTimer);
  const lastBatch = state.discardHistory[state.discardHistory.length - 1];
  els.zipInfo.innerHTML = `${lastBatch.ids.length} files moved to Review Bin. <button id="undoDiscardButton" class="inline-log-action" type="button">Undo</button> available for ${UNDO_SECONDS} seconds.`;
  document.getElementById("undoDiscardButton").addEventListener("click", undoLastDiscard);
  state.undoTimer = setTimeout(() => {
    state.undoTimer = 0;
    updateSelectionUi();
  }, UNDO_SECONDS * 1000);
}

async function undoLastDiscard() {
  const lastBatch = state.discardHistory.pop();
  if (!lastBatch) return;
  const rows = state.flaggedRows.filter(row => lastBatch.ids.includes(row.id));
  const recovered = await recoverRowsFromBackend(rows);
  for (const id of recovered.map(row => row.id)) {
    state.discardedIds.delete(id);
    state.workflowTimestamps.delete(id);
  }
  createReport();
  updateReviewSummary();
  updateSelectionUi();
  renderFlaggedTable();
  renderReviewBin();
  addLog(`Restored ${recovered.length} files from the last Review Bin action.`);
  updateControls();
}

async function restoreDiscardedFiles() {
  const count = state.discardedIds.size;
  if (!count) return;
  const rows = reviewBinRows();
  const recovered = await recoverRowsFromBackend(rows);
  for (const row of recovered) {
    state.workflowTimestamps.delete(row.id);
    state.discardedIds.delete(row.id);
  }
  state.discardHistory = [];
  if (state.undoTimer) clearTimeout(state.undoTimer);
  state.undoTimer = 0;
  createReport();
  updateReviewSummary();
  updateSelectionUi();
  renderFlaggedTable();
  renderReviewBin();
  addLog(`Restored ${recovered.length} files from Review Bin.`);
  updateControls();
}

async function restoreReviewBinFile(rowId) {
  const row = state.flaggedRows.find(item => item.id === rowId);
  if (!row || !state.discardedIds.has(row.id)) return;
  const recovered = await recoverRowsFromBackend([row]);
  if (!recovered.length) return;
  state.discardedIds.delete(row.id);
  state.workflowTimestamps.delete(row.id);
  state.discardHistory = state.discardHistory
    .map(batch => ({ ...batch, ids: batch.ids.filter(id => id !== row.id) }))
    .filter(batch => batch.ids.length);
  createReport();
  updateReviewSummary();
  updateSelectionUi();
  renderFlaggedTable();
  renderReviewBin();
  addLog(`Recovered ${row.fileName} from Review Bin.`);
  updateControls();
}

async function recoverRowsFromBackend(rows) {
  if (!rows.length) return [];

  //Review Bin is website-only now.
  //Recover simply returns the selected area so they can
  //be moved back into Review Files by the existing UI logic.
  return rows; 
}

async function permanentlyDeleteReviewBin() {
  closeDiscardConfirmation();
  const rows = reviewBinRows();
  const recycled = await recycleRowsFromBackend(rows);
  for (const row of recycled) {
    state.permanentlyDeletedIds.add(row.id);
    state.discardedIds.delete(row.id);
    state.selectedFlagged.delete(row.id);
    state.workflowTimestamps.set(row.id, { ...(state.workflowTimestamps.get(row.id) || {}), deleted: new Date().toISOString() });
  }
  state.discardHistory = [];
  createReport();
  updateReviewSummary();
  updateSelectionUi();
  renderFlaggedTable();
  renderReviewBin();
  addLog(`Moved ${recycled.length} files to Recycle Bin.${rows.length - recycled.length ? ` Failed to move ${rows.length - recycled.length} files.` : ""}`);
  updateControls();
}

async function permanentlyDeleteReviewBinFile(rowId) {
  closeDiscardConfirmation();
  const row = state.flaggedRows.find(item => item.id === rowId);
  if (!row || !state.discardedIds.has(row.id)) return;
  const recycled = await recycleRowsFromBackend([row]);
  if (!recycled.length) return;
  state.permanentlyDeletedIds.add(row.id);
  state.discardedIds.delete(row.id);
  state.selectedFlagged.delete(row.id);
  state.workflowTimestamps.set(row.id, { ...(state.workflowTimestamps.get(row.id) || {}), deleted: new Date().toISOString() });
  state.discardHistory = state.discardHistory
    .map(batch => ({ ...batch, ids: batch.ids.filter(id => id !== row.id) }))
    .filter(batch => batch.ids.length);
  createReport();
  updateReviewSummary();
  updateSelectionUi();
  renderFlaggedTable();
  renderReviewBin();
  addLog(`Moved ${row.fileName} to Recycle Bin.`);
  updateControls();
}

async function recycleRowsFromBackend(rows) {
  if (!rows.length) return [];
  if (!state.backend.connected || !state.backend.rootConfigured) {
    addLog("Local server not connected. Start the server to send files to Recycle Bin.", "warn");
    return [];
  }

  try {
    const data = await apiRequest("/delete-permanently", {
      files: rows.map(row => row.originalPath)
    });
    const resultMap = new Map((data.results || []).map(result => [normalizePath(result.path), result]));
    const recycled = [];
    let failed = 0;
    for (const row of rows) {
      const result = resultMap.get(normalizePath(row.originalPath));
      if (result?.ok) {
        recycled.push(row);
      } else {
        failed += 1;
        const message = result?.error || "Local server recycle failed";
        state.failures.push({ path: row.originalPath, message });
        addLog(`Could not move ${row.fileName} to Recycle Bin: ${message}`, "error");
      }
    }
    if (failed) addLog(`Failed to move ${failed} files to Recycle Bin.`, "error");
    return recycled;
  } catch (error) {
    addLog(`Recycle Bin move failed: ${error.message}`, "error");
    return [];
  }
}

function groupSelectedBackups() {
  closeDiscardConfirmation();
  const rows = selectedBackupRows();
  if (!rows.length) {
    addLog("No selected backup/autosave files were available to group.", "warn");
    return;
  }
  for (const row of rows) state.groupedBackupIds.add(row.id);
  createReport();
  renderFlaggedTable();
  updateSelectionUi();
  updateControls();
  els.zipInfo.textContent = `${state.groupedBackupIds.size} backup/autosave files prepared. Download Grouped Folder is now available.`;
  addLog(`${rows.length} backup/autosave files prepared for grouped folder download. Original paths are preserved in the report.`);
}

function reviewBinRows() {
  return state.flaggedRows.filter(row => state.discardedIds.has(row.id) && !state.permanentlyDeletedIds.has(row.id));
}

function renderReviewBin() {
  const rows = reviewBinRows();
  els.reviewBinCount.textContent = `${rows.length} ${rows.length === 1 ? "file" : "files"}`;
  if (!rows.length) {
    els.reviewBinList.textContent = "No files in Review Bin.";
    return;
  }
  els.reviewBinList.innerHTML = "";
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "review-bin-item";
    setTooltip(item, `Review Bin file: ${row.fileName}. ${row.recommendation || row.label}.`);

    const info = document.createElement("div");
    info.className = "review-bin-file";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "review-bin-link";
    name.textContent = row.fileName;
    setTooltip(name, `Open a preview for ${row.fileName}.`);
    name.addEventListener("click", () => openPreviewModal(row));

    const meta = document.createElement("span");
    meta.className = "review-bin-meta";
    meta.textContent = `${formatBytes(row.size)} - ${row.recommendation || row.label}`;
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "review-bin-actions";
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "button compact";
    previewButton.textContent = "Preview";
    setTooltip(previewButton, `Preview ${row.fileName}.`);
    previewButton.addEventListener("click", () => openPreviewModal(row));

    const recoverButton = document.createElement("button");
    recoverButton.type = "button";
    recoverButton.className = "button compact secondary";
    recoverButton.textContent = "Recover";
    setTooltip(recoverButton, `Recover ${row.fileName} from the Review Bin.`);
    recoverButton.addEventListener("click", () => restoreReviewBinFile(row.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "button compact primary";
    deleteButton.textContent = "Delete";
    setTooltip(deleteButton, `Send ${row.fileName} to the Windows Recycle Bin after confirmation.`);
    deleteButton.addEventListener("click", () => openPermanentDeleteOneConfirmation(row.id));

    actions.append(previewButton, recoverButton, deleteButton);
    item.append(info, actions);
    els.reviewBinList.appendChild(item);
  }
}

function createReport() {
  state.reportBlob = createCsvReportBlob();
  state.reportName = reportFileName("csv");
}

async function downloadReport(format = "csv") {
  try {
    const blob = format === "pdf"
      ? await createPdfReportBlob()
      : format === "xlsx"
        ? await createXlsxReportBlob()
        : createCsvReportBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = reportFileName(format);
    link.style.display = "none";
    document.body.appendChild(link);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addLog(`${format.toUpperCase()} cleanup report download started.`);
  } catch (error) {
    addLog(`Report download could not start: ${error.message}.`, "error");
  }
}

function createCsvReportBlob() {
  const headers = reportHeaders();
  const rows = deletionReportRows().map(row => headers.map(header => row[header] ?? ""));
  const csv = [headers, ...rows].map(row => row.map(csvValue).join(",")).join("\r\n");
  return new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
}

function reportHeaders() {
  return [
    "Report Date",
    "Main Folder",
    "Category",
    "File Name",
    "File Path",
    "File Type",
    "File Size",
    "Modified Date",
    "Reason Flagged",
    "Selection Status",
    "Deletion Status",
    "Recycle Timestamp",
    "Grouping Status",
    "Proposed Backup Folder",
    "Related File Name",
    "Related File Path",
    "Error Message"
  ];
}

function allReportRows() {
  const reportDate = formatReportDateTime();
  const mainFolder = state.mainFolderName || "Selected Folder";
  const rows = state.flaggedRows.map(row => {
    const related = relatedReportFile(row);
    const timestamps = state.workflowTimestamps.get(row.id) || {};
    return {
      "Report Date": reportDate,
      "Main Folder": mainFolder,
      "Category": row.label,
      "File Name": row.fileName,
      "File Path": row.originalPath,
      "File Type": `${row.fileType.description} (${row.fileType.label})`,
      "File Size": formatBytes(row.size),
      "Modified Date": formatDate(row.modified),
      "Reason Flagged": row.reason,
      "Selection Status": state.selectedFlagged.has(row.id) ? "Selected" : "Not selected",
      "Deletion Status": reportWorkflowStatus(row),
      "Recycle Timestamp": formatReportTimestamp(timestamps.deleted || timestamps.reviewBin),
      "Grouping Status": state.groupedBackupIds.has(row.id) ? "Prepared for grouped backup folder" : "",
      "Proposed Backup Folder": state.groupedBackupIds.has(row.id) ? proposedBackupFolder(row) : "",
      "Related File Name": related?.fileName || "",
      "Related File Path": related?.originalPath || "",
      "Error Message": failureForPath(row.originalPath)
    };
  });

  for (const failure of state.failures) {
    rows.push({
      "Report Date": reportDate,
      "Main Folder": mainFolder,
      "Category": "Error",
      "File Name": failure.path.split("/").pop() || failure.path,
      "File Path": failure.path,
      "File Type": "",
      "File Size": "",
      "Modified Date": "",
      "Reason Flagged": "",
      "Selection Status": "",
      "Deletion Status": "Error",
      "Recycle Timestamp": "",
      "Grouping Status": "",
      "Proposed Backup Folder": "",
      "Related File Name": "",
      "Related File Path": "",
      "Error Message": failure.message
    });
  }

  return rows;
}

function deletionReportRows() {
  return allReportRows().filter(row => ["Review Bin", "Recycled", "Error"].includes(row["Deletion Status"]));
}

function deletedFileRows() {
  return allReportRows().filter(row => ["Review Bin", "Recycled"].includes(row["Deletion Status"]));
}

async function createXlsxReportBlob() {
  const Zip = window.JSZip || globalThis.JSZip;
  if (!Zip) throw new Error("Excel export library is not loaded");
  const rows = deletionReportRows();
  const headers = reportHeaders();
  const summary = reportSummary();
  const zip = new Zip();
  zip.file("[Content_Types].xml", xlsxContentTypes());
  zip.folder("_rels").file(".rels", xlsxRootRels());
  zip.folder("xl").file("workbook.xml", xlsxWorkbook());
  zip.folder("xl").folder("_rels").file("workbook.xml.rels", xlsxWorkbookRels());
  zip.folder("xl").file("styles.xml", xlsxStyles());
  zip.folder("xl").folder("worksheets").file("sheet1.xml", xlsxWorksheet(summary, headers, rows));
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

function reportSummary() {
  const discardedRows = reviewBinRows();
  const deletedRows = state.flaggedRows.filter(row => state.permanentlyDeletedIds.has(row.id));
  const deletedAndDiscarded = [...discardedRows, ...deletedRows];
  return {
    title: "SGA File Nexus Cleanup Report",
    mainFolder: state.mainFolderName || "Selected Folder",
    date: formatReportDate(),
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    totalFlagged: state.flaggedRows.length,
    movedToReviewBin: discardedRows.length,
    permanentlyDeleted: deletedRows.length,
    totalDiscardedSize: formatBytes(deletedAndDiscarded.reduce((sum, row) => sum + row.size, 0)),
    errors: state.failures.length
  };
}

function xlsxWorksheet(summary, headers, rows) {
  const worksheetRows = [];
  worksheetRows.push(xlsxRow(1, [{ value: summary.title, style: 1 }]));
  worksheetRows.push(xlsxRow(2, [{ value: "Main Folder", style: 2 }, { value: summary.mainFolder, style: 3 }]));
  worksheetRows.push(xlsxRow(3, [{ value: "Date", style: 2 }, { value: summary.date, style: 3 }, { value: "Time", style: 2 }, { value: summary.time, style: 3 }]));
  worksheetRows.push(xlsxRow(4, [{ value: "Total Flagged Files", style: 2 }, { value: summary.totalFlagged, style: 3 }, { value: "Moved to Review Bin", style: 2 }, { value: summary.movedToReviewBin, style: 3 }]));
  worksheetRows.push(xlsxRow(5, [{ value: "Recycled", style: 2 }, { value: summary.permanentlyDeleted, style: 3 }, { value: "Storage Discarded", style: 2 }, { value: summary.totalDiscardedSize, style: 3 }, { value: "Errors", style: 2 }, { value: summary.errors, style: 3 }]));
  worksheetRows.push(xlsxRow(6, []));
  worksheetRows.push(xlsxRow(7, headers.map(header => ({ value: header, style: 4 }))));
  rows.forEach((row, index) => {
    const style = row["Deletion Status"] === "Error" ? 8 : row["Deletion Status"] === "Recycled" ? 7 : 6;
    worksheetRows.push(xlsxRow(index + 8, headers.map(header => ({
      value: row[header] ?? "",
      style: header === "File Name" ? 5 : style
    }))));
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="7" topLeftCell="A8" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${xlsxCols()}</cols>
  <sheetData>${worksheetRows.join("")}</sheetData>
  <mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>
</worksheet>`;
}

function xlsxRow(index, cells) {
  const xmlCells = cells.map((cell, columnIndex) => xlsxCell(index, columnIndex + 1, cell.value, cell.style)).join("");
  return `<row r="${index}">${xmlCells}</row>`;
}

function xlsxCell(rowIndex, columnIndex, value, style = 0) {
  const ref = `${xlsxColumnName(columnIndex)}${rowIndex}`;
  const numeric = typeof value === "number";
  if (numeric) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function xlsxColumnName(index) {
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function xlsxCols() {
  const widths = [18, 24, 22, 34, 56, 18, 15, 22, 42, 18, 20, 22, 28, 28, 28, 56, 32];
  return widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
}

function xlsxStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="16"/><color rgb="FFEA3D31"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>
  <fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF1EF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF111111"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFAFAFA"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E2E2"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0"/><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function xlsxContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
}

function xlsxRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function xlsxWorkbook() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Cleanup Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function xlsxWorkbookRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function relatedReportFile(row) {
  if (row.relatedId) {
    return state.flaggedRows.find(other => other.id === row.relatedId) ||
      state.fileRecords.find(record => record.id === row.relatedId) ||
      null;
  }
  const candidates = state.flaggedRows.filter(other => other.id !== row.id && other.groupLabel === row.groupLabel);
  if (!candidates.length) return null;
  if (row.comparisonRole === "older") return candidates.find(other => other.comparisonRole === "newer") || candidates[0];
  if (row.comparisonRole === "newer") return candidates.find(other => other.comparisonRole === "older") || candidates[0];
  if (row.label === "Backup / Autosave") return candidates.find(other => other.recommendedAction === "keep") || candidates[0];
  return candidates[0];
}

function reportWorkflowStatus(row) {
  if (state.permanentlyDeletedIds.has(row.id)) return "Recycled";
  if (state.discardedIds.has(row.id)) return "Review Bin";
  if (state.groupedBackupIds.has(row.id)) return "Backup Grouping Prepared";
  return "Active";
}

function proposedBackupFolder(row) {
  const root = sanitizeFileName(state.mainFolderName || "Selected_Folder");
  const parent = sanitizeFileName(row.parent || "Root_files");
  return `${root}_Organized_Backups/${parent}`;
}

function failureForPath(path) {
  return state.failures.find(failure => failure.path === path)?.message || "";
}

function reportFileName(format) {
  const folder = sanitizeFileName(state.mainFolderName || "Selected_Folder");
  return `${folder}_cleanup-report_${formatReportDate()}.${format}`;
}

function sanitizeFileName(value) {
  return String(value || "Selected_Folder")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "Selected_Folder";
}

function formatReportDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatReportDateTime() {
  return new Date().toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatReportTimestamp(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function createPdfReportBlob() {
  const rows = deletedFileRows();
  const errors = state.failures;
  const summary = reportSummary();
  const lines = [
    "SGA",
    "SGA File Nexus Cleanup Report",
    "Backup & Duplicate Discarder",
    `Main folder: ${summary.mainFolder}`,
    `Date: ${summary.date}    Time: ${summary.time}`,
    `Total flagged files: ${summary.totalFlagged}`,
    `Moved to Review Bin: ${summary.movedToReviewBin}`,
    `Moved to Recycle Bin: ${summary.permanentlyDeleted}`,
    `Total storage discarded: ${summary.totalDiscardedSize}`,
    `Errors: ${summary.errors || "none"}`,
    "",
    "Review Bin / Recycled Files"
  ];

  for (const row of rows) {
    lines.push(`${row["File Name"]} | ${row["Category"]} | ${row["File Type"]} | ${row["File Size"]}`);
    lines.push(`Reason: ${row["Reason Flagged"] || row["Error Message"] || "None"}`);
    lines.push(`Path: ${row["File Path"]}`);
    lines.push(`Status: ${row["Deletion Status"]} | Timestamp: ${row["Recycle Timestamp"] || "N/A"}`);
    lines.push("");
  }

  if (errors.length) {
    lines.push("Errors");
    for (const error of errors) {
      lines.push(`${error.path}: ${error.message}`);
    }
  }

  return new Blob([simplePdfBytes(lines)], { type: "application/pdf" });
}

function simplePdfBytes(lines) {
  const pages = [];
  const linesPerPage = 38;
  for (let start = 0; start < lines.length; start += linesPerPage) {
    pages.push(lines.slice(start, start + linesPerPage));
  }

  const objects = [];
  const addObject = content => {
    objects.push(content);
    return objects.length;
  };

  const catalogId = addObject("");
  const pagesId = addObject("");
  const pageIds = [];
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  for (const pageLines of pages) {
    const content = pdfPageContent(pageLines);
    const contentId = addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function pdfPageContent(lines) {
  const commands = ["BT", "50 748 Td"];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index === 0) {
      commands.push("/F1 22 Tf", `(${escapePdfText(line).slice(0, 120)}) Tj`, "0 -28 Td");
    } else if (index === 1) {
      commands.push("/F1 16 Tf", `(${escapePdfText(line).slice(0, 120)}) Tj`, "0 -20 Td");
    } else if (index < 10) {
      commands.push("/F1 11 Tf", `(${escapePdfText(line).slice(0, 120)}) Tj`, "0 -15 Td");
    } else {
      commands.push("/F1 9 Tf", `(${escapePdfText(line).slice(0, 140)}) Tj`, "0 -12 Td");
    }
  }
  commands.push("ET");
  return commands.join("\n");
}

function escapePdfText(value) {
  return String(value ?? "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function getSelectedRecords() {
  return state.fileRecords
    .filter(record => state.selectedParents.has(record.parent))
    .sort((a, b) => a.originalPath.localeCompare(b.originalPath, undefined, { numeric: true, sensitivity: "base" }));
}

function activeFlaggedRows() {
  return state.flaggedRows.filter(row => !state.discardedIds.has(row.id) && !state.permanentlyDeletedIds.has(row.id));
}

function selectedFlaggedRows() {
  return state.flaggedRows.filter(row => state.selectedFlagged.has(row.id) && !state.discardedIds.has(row.id) && !state.permanentlyDeletedIds.has(row.id));
}

function selectedBackupRows() {
  return selectedFlaggedRows().filter(isBackupOrAutosaveRow);
}

function isBackupOrAutosaveRow(row) {
  return row.label === "Backup / Autosave" && row.comparisonRole !== "original" && row.recommendedAction !== "keep";
}

function totalSelectedSize() {
  return selectedFlaggedRows().reduce((sum, row) => sum + row.size, 0);
}

function cleanupSelectionIds() {
  return new Set([
    ...state.selectedFlagged,
    ...state.discardedIds,
    ...state.groupedBackupIds,
    ...state.permanentlyDeletedIds
  ]);
}

function committedCleanupIds() {
  return new Set([
    ...state.discardedIds,
    ...state.groupedBackupIds,
    ...state.permanentlyDeletedIds
  ]);
}

function cleanupStats() {
  const selectedIds = cleanupSelectionIds();
  const committedIds = committedCleanupIds();
  const totalFiles = state.fileRecords.length;
  const originalStorage = state.fileRecords.reduce((sum, row) => sum + (row.size || 0), 0);
  let selectedDeletionFiles = 0;
  let selectedDeletionSize = 0;
  let committedCleanupSize = 0;

  for (const record of state.fileRecords) {
    if (selectedIds.has(record.id)) {
      selectedDeletionFiles += 1;
      selectedDeletionSize += record.size || 0;
    }
    if (committedIds.has(record.id)) {
      committedCleanupSize += record.size || 0;
    }
  }

  const filesToKeep = Math.max(0, totalFiles - selectedDeletionFiles);
  const storageAfterCleanup = Math.max(0, originalStorage - selectedDeletionSize);
  const cleanupPercent = originalStorage ? (committedCleanupSize / originalStorage) * 100 : 0;
  return {
    totalFiles,
    filesToKeep,
    selectedDeletionFiles,
    originalStorage,
    selectedDeletionSize,
    committedCleanupSize,
    storageAfterCleanup,
    cleanupPercent
  };
}

function updateCleanupMetrics() {
  const stats = cleanupStats();
  updateProgressValue(els.progressLabel, "Cleanup impact");
  updateProgressValue(els.totalFiles, stats.totalFiles);
  updateProgressValue(els.filesToKeep, stats.filesToKeep);
  updateProgressValue(els.selectedDeletionFiles, stats.selectedDeletionFiles);
  updateProgressValue(els.originalStorage, formatBytes(stats.originalStorage));
  updateProgressValue(els.storageToRecover, formatBytes(stats.selectedDeletionSize));
  updateProgressValue(els.storageAfterCleanup, formatBytes(stats.storageAfterCleanup));
  updateProgressValue(els.elapsedTime, state.scanDate ? formatDuration((Date.now() - Date.parse(state.scanDate)) / 1000) : "00:00");
  setProgress(stats.cleanupPercent);
}

function updateControls() {
  const hasParents = state.parentFolders.size > 0;
  const hasFlagged = activeFlaggedRows().length > 0;
  const hasReviewRows = state.flaggedRows.length > 0;
  const hasReviewBin = reviewBinRows().length > 0;
  const hasSelectedBackups = selectedBackupRows().length > 0;
  const realFileActionsReady = state.backend.connected && state.backend.rootConfigured;
  els.refreshScanButton.disabled = state.processing || !state.fileRecords.length;
  els.selectAllButton.disabled = !hasParents || state.processing;
  els.deselectAllButton.disabled = !hasParents || state.processing;
  els.selectFlaggedButton.disabled = !hasFlagged || state.processing;
  els.deselectFlaggedButton.disabled = !hasFlagged || state.processing;
  els.expandGroupsButton.disabled = !hasReviewRows || state.processing;
  els.collapseGroupsButton.disabled = !hasReviewRows || state.processing;
  els.reviewSearch.disabled = !hasReviewRows || state.processing;
  els.reviewSort.disabled = !hasReviewRows || state.processing;
  els.reviewTypeFilter.disabled = !hasReviewRows || state.processing;
  els.reviewFileTypeFilter.disabled = !hasReviewRows || state.processing;
  els.reviewFolderFilter.disabled = !hasReviewRows || state.processing;
  els.discardButton.disabled = state.processing || !state.selectedFlagged.size;
  els.groupBackupsButton.disabled = state.processing || !hasSelectedBackups;
  els.downloadGroupedFolderButton.disabled = state.processing || !state.groupedBackupIds.size;
  els.restoreButton.disabled = state.processing || !hasReviewBin || !realFileActionsReady;
  els.permanentDeleteButton.disabled = state.processing || !hasReviewBin || !realFileActionsReady;
  els.downloadExcelButton.disabled = state.processing || !state.flaggedRows.length;
  els.downloadPdfButton.disabled = state.processing || !state.flaggedRows.length;
  els.discardButton.textContent = "Move to Review Bin";
  els.groupBackupsButton.textContent = "Group Backups Into One Folder";
  els.downloadGroupedFolderButton.textContent = "Download Grouped Folder";
  els.restoreButton.textContent = "Recover All";
  els.permanentDeleteButton.textContent = "Delete All";
  els.downloadExcelButton.textContent = "Download CSV Report";
  els.downloadPdfButton.textContent = "Download PDF Report";
}

function updateMetrics(done = false) {
  const elapsedSeconds = Math.max(0.001, (performance.now() - state.metrics.startTime) / 1000);
  const completed = state.metrics.completed;
  const remaining = Math.max(0, state.metrics.total - completed);

  if (!state.processing && done) {
    updateCleanupMetrics();
    return;
  }

  updateProgressValue(els.progressLabel, state.metrics.mode === "moving" ? "Action progress" : "Scan progress");
  updateProgressValue(els.totalFiles, state.fileRecords.length || state.metrics.total);
  updateProgressValue(els.filesToKeep, Math.max(0, state.metrics.total - completed));
  updateProgressValue(els.selectedDeletionFiles, completed);
  updateProgressValue(els.originalStorage, state.metrics.mode === "moving" ? formatBytes(cleanupStats().originalStorage) : `${completed} / ${state.metrics.total}`);
  updateProgressValue(els.storageToRecover, formatBytes(totalSelectedSize()));
  updateProgressValue(els.storageAfterCleanup, remaining);
  updateProgressValue(els.elapsedTime, formatDuration(elapsedSeconds));
  setProgress(state.metrics.total ? (completed / state.metrics.total) * 100 : 0);
}

function setProgress(percent) {
  const safe = Math.max(0, Math.min(100, percent));
  els.progressBar.style.width = `${safe}%`;
  updateProgressValue(els.percentText, `${Math.round(safe)}%`);
}

function setStatus(message) {
  updateProgressValue(els.statusText, message);
}

async function checkBackendStatus() {
  if (!isLocalHttpApp()) {
    setBackendStatus(false, "Open http://localhost:3000 for real file moves.");
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/status`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.backend.rootConfigured = Boolean(data.rootPath);
    state.backend.rootPath = data.rootPath || "";
    setBackendStatus(true, data.rootPath ? `Local server connected: ${data.rootPath}` : "Browser security prevents automatic folder path detection. Click Choose Local Folder and select the same folder you scanned.");
  } catch (error) {
    state.backend.rootConfigured = false;
    state.backend.rootPath = "";
    setBackendStatus(false, "Local server not connected. Start the server to move files safely.");
  }
  updateControls();
}

function isLocalHttpApp() {
  return location.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
}

function setBackendStatus(connected, message) {
  state.backend.connected = connected;
  state.backend.message = message;
  els.serverStatusButton.textContent = connected
    ? (state.backend.rootConfigured ? "Local server connected" : "Choose Local Folder for File Moves")
    : "Local server disconnected";
  els.serverStatusButton.classList.toggle("connected", connected);
  els.serverStatusButton.classList.toggle("disconnected", !connected);
  els.serverStatusButton.title = message;
}

async function configureBackendRoot() {
  if (!isLocalHttpApp()) {
    addLog("Local server not connected. Start the server and open http://localhost:3000 to move files safely.", "warn");
    return;
  }

  try {
    setBackendStatus(true, "Opening folder picker...");
    const data = await apiRequest("/choose-folder");
    state.backend.rootConfigured = true;
    state.backend.rootPath = data.rootPath || "";
    setBackendStatus(true, `Local server connected: ${state.backend.rootPath}`);
    addLog(`Local backend root set to ${state.backend.rootPath}.`);
  } catch (error) {
    state.backend.rootConfigured = false;
    setBackendStatus(true, "Browser security prevents automatic folder path detection. Click Choose Local Folder and select the same folder you scanned.");
    addLog(`Folder picker was not completed: ${error.message}`, "warn");
  }
  updateControls();
}

function maybeSuggestLocalFolderPicker() {
  if (!isLocalHttpApp() || !state.backend.connected || state.backend.rootConfigured) return;
  addLog("Browser security prevents automatic folder path detection. Click Choose Local Folder and select the same folder you scanned.", "warn");
  setBackendStatus(true, "Browser security prevents automatic folder path detection. Click Choose Local Folder and select the same folder you scanned.");
}

async function apiRequest(path, payload = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function updateProgressValue(element, value) {
  if (!element) return;
  const next = String(value);
  if (element.textContent === next) return;
  element.textContent = next;
  pulseProgressArea(element);
}

function pulseProgressArea(element) {
  const target = element.closest(".metrics div") ||
    element.closest(".recovery-summary") ||
    element.closest(".status-chip") ||
    element.closest(".status-line");
  if (!target) return;
  target.classList.remove("metric-changed");
  void target.offsetWidth;
  target.classList.add("metric-changed");
}

function addLog(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.title = message;
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
  state.mainFolderName = "";
  state.allFiles = [];
  state.fileRecords = [];
  state.parentFolders = new Map();
  state.selectedParents = new Set();
  state.flaggedRows = [];
  state.selectedFlagged = new Set();
  state.discardedIds = new Set();
  state.permanentlyDeletedIds = new Set();
  state.groupedBackupIds = new Set();
  state.workflowTimestamps = new Map();
  state.discardHistory = [];
  state.failures = [];
  state.reportBlob = null;
  revokeReportObjectUrl();
  revokePreviewObjectUrls();
  state.reportName = "";
  state.processing = false;
  state.scanDate = "";
  state.reviewSearch = "";
  state.reviewSort = "group";
  state.reviewTypeFilter = "all";
  state.reviewFileTypeFilter = "all";
  state.reviewFolderFilter = "all";
  state.confirmAction = "review-bin";
  state.confirmRowId = "";
  state.collapsedGroups = new Set();
  state.largestGroupKeys = new Set();
  if (state.undoTimer) clearTimeout(state.undoTimer);
  state.undoTimer = 0;
}

function resetUi() {
  els.parentList.innerHTML = "";
  els.previewBody.innerHTML = '<tr><td colspan="8" class="empty-state">Load a folder or ZIP to review files.</td></tr>';
  els.folderSummary.textContent = "No folder loaded.";
  els.previewCount.textContent = "0 flagged";
  els.zipInfo.textContent = "Report will be available after files are moved to Review Bin.";
  setStatus("Waiting for a folder.");
  setProgress(0);
  els.recoveredStorage.textContent = "0 B";
  updateCleanupMetrics();
  els.reviewSearch.value = "";
  els.reviewSort.value = "group";
  renderReviewFilterOptions();
  els.downloadExcelButton.disabled = true;
  els.downloadPdfButton.disabled = true;
  els.discardButton.textContent = "Move to Review Bin";
  els.groupBackupsButton.textContent = "Group Backups Into One Folder";
  els.downloadGroupedFolderButton.textContent = "Download Grouped Folder";
  els.restoreButton.textContent = "Recover All";
  els.permanentDeleteButton.textContent = "Delete All";
  renderReviewBin();
  els.downloadExcelButton.textContent = "Download CSV Report";
  els.downloadPdfButton.textContent = "Download PDF Report";
  closeDiscardConfirmation();
  updateControls();
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

function previewUrlFor(row) {
  if (!state.previewUrls.has(row.id)) {
    state.previewUrls.set(row.id, URL.createObjectURL(row.file));
  }
  return state.previewUrls.get(row.id);
}

function revokePreviewObjectUrls() {
  for (const url of state.previewUrls.values()) {
    URL.revokeObjectURL(url);
  }
  state.previewUrls = new Map();
}

async function filesFromDirectoryHandle(rootHandle) {
  const files = [];
  await readDirectoryHandle(rootHandle, rootHandle.name, files, { count: 0 });
  return files;
}

async function readDirectoryHandle(directoryHandle, prefix, files, counter) {
  for await (const [name, handle] of directoryHandle.entries()) {
    const relativePath = normalizePath(`${prefix}/${name}`);
    if (isSystemFile(relativePath)) continue;

    if (handle.kind === "file") {
      const file = await handle.getFile();
      file.relativePath = relativePath;
      files.push(file);
      counter.count += 1;
    } else if (handle.kind === "directory") {
      await readDirectoryHandle(handle, relativePath, files, counter);
    }

    if (counter.count && counter.count % SCAN_BATCH_SIZE === 0) {
      setStatus(`Reading folders: ${counter.count} files...`);
      await yieldToBrowser();
    }
  }
}

async function filesFromDrop(dataTransfer) {
  const droppedFiles = Array.from(dataTransfer.files || []);
  if (droppedFiles.some(isZipFile)) {
    return droppedFiles;
  }

  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
    .filter(Boolean);

  if (entries.length) {
    const files = [];
    for (const entry of entries) {
      await readEntry(entry, "", files);
      await yieldToBrowser();
    }
    return files;
  }

  return droppedFiles;
}

async function expandUploadFiles(files) {
  const zipResults = [];
  const expanded = [];
  for (const file of Array.from(files || [])) {
    if (isZipFile(file)) {
      const zipResult = await filesFromZip(file);
      zipResults.push(zipResult);
      expanded.push(...zipResult.files);
      continue;
    }
    expanded.push(file);
  }
  return {
    files: expanded,
    zipCount: zipResults.length,
    zipResults
  };
}

function isZipFile(file) {
  const type = String(file.type || "").toLowerCase();
  return /\.zip$/i.test(file.name || "") || type === "application/zip" || type === "application/x-zip-compressed";
}

async function filesFromZip(file) {
  const Zip = window.JSZip || globalThis.JSZip;
  const result = {
    name: file.name || "ZIP file",
    files: [],
    totalEntries: 0,
    extracted: 0,
    supportedEntries: 0,
    failed: false
  };

  if (!Zip) {
    addLog(`ZIP support is unavailable, so ${file.name} could not be extracted.`, "warn");
    result.failed = true;
    return result;
  }

  try {
    setStatus("Reading ZIP...");
    addLog(`Reading ZIP: ${result.name}...`);
    const zip = await Zip.loadAsync(file);
    const zipRoot = sanitizeFileName(getBaseName(file.name) || "ZIP_Upload");
    const entries = Object.values(zip.files).filter(entry => !entry.dir);
    result.totalEntries = entries.length;

    if (!entries.length) {
      addLog(`${result.name} is empty or only contains folders.`, "warn");
      return result;
    }

    setStatus("Scanning ZIP contents...");
    for (let start = 0; start < entries.length; start += SCAN_BATCH_SIZE) {
      const batch = entries.slice(start, start + SCAN_BATCH_SIZE);
      for (const entry of batch) {
        const entryPath = normalizePath(entry.name);
        if (!entryPath || isSystemFile(entryPath)) continue;
        const blob = await entry.async("blob");
        const name = entryPath.split("/").pop() || file.name || "ZIP entry";
        const lastModified = entry.date instanceof Date
          ? entry.date.getTime()
          : file.lastModified || Date.now();
        const extractedFile = new File([blob], entryPath.split("/").pop() || file.name, {
          type: blob.type || "",
          lastModified
        });
        const fullPath = normalizePath(`${zipRoot}/${entryPath}`);
        extractedFile.relativePath = fullPath;
        result.files.push({
          file: extractedFile,
          name,
          path: fullPath,
          fullPath,
          size: blob.size || entry._data?.uncompressedSize || 0,
          extension: getExtension(name),
          lastModified
        });
        result.extracted += 1;
        if (describeFileType(getExtension(name)).category !== "unsupported") {
          result.supportedEntries += 1;
        }
      }
      setStatus(`Scanning ZIP contents: ${Math.min(entries.length, start + batch.length)} files...`);
      await yieldToBrowser();
    }

    if (!result.extracted) {
      addLog(`${result.name} did not contain usable files after hidden system files were ignored.`, "warn");
    } else {
      setStatus(`Found ${result.extracted} files in ZIP.`);
      addLog(`Found ${result.extracted} files in ZIP.`);
    }
    return result;
  } catch (error) {
    addLog(`Could not extract ${file.name}: ${error.message}.`, "error");
    result.failed = true;
    return result;
  }
}

async function downloadGroupedFolder() {
  const Zip = window.JSZip || globalThis.JSZip;
  if (!Zip) {
    addLog("Grouped folder download needs JSZip, but ZIP support is unavailable.", "error");
    return;
  }

  const rows = state.flaggedRows.filter(row => state.groupedBackupIds.has(row.id) && !state.permanentlyDeletedIds.has(row.id));
  if (!rows.length) {
    addLog("Prepare backup grouping before downloading the grouped folder.", "warn");
    updateControls();
    return;
  }

  try {
    els.downloadGroupedFolderButton.disabled = true;
    els.downloadGroupedFolderButton.textContent = "Preparing Download...";
    const folderName = groupedBackupFolderName();
    const zip = new Zip();
    const usedNames = new Set();

    for (const row of rows) {
      const fileName = uniqueGroupedFileName(row, usedNames);
      zip.file(`${folderName}/${fileName}`, row.file);
    }

    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    downloadBlob(blob, `${folderName}.zip`);
    addLog(`Grouped backup folder download started with ${rows.length} files.`);
    els.zipInfo.textContent = `Downloaded grouped backup folder with ${rows.length} files.`;
  } catch (error) {
    addLog(`Grouped backup folder could not be downloaded: ${error.message}.`, "error");
  } finally {
    els.downloadGroupedFolderButton.textContent = "Download Grouped Folder";
    updateControls();
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function groupedBackupFolderName() {
  return `${sanitizeFileName(state.mainFolderName || "Selected_Folder")}_Grouped_Backups`;
}

function uniqueGroupedFileName(row, usedNames) {
  const cleanName = sanitizeFileName(row.fileName || row.file?.name || "backup-file");
  const dot = cleanName.lastIndexOf(".");
  const base = dot > 0 ? cleanName.slice(0, dot) : cleanName;
  const ext = dot > 0 ? cleanName.slice(dot) : "";
  let candidate = cleanName;
  let index = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}_${index}${ext}`;
    index += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function readEntry(entry, prefix, files) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(file => {
        file.relativePath = normalizePath(`${prefix}${file.name}`);
        files.push(file);
        resolve();
      }, () => resolve());
      return;
    }

    if (entry.isDirectory) {
      const reader = entry.createReader();
      const directoryPrefix = `${prefix}${entry.name}/`;
      const readBatch = () => {
        reader.readEntries(async entries => {
          if (!entries.length) {
            resolve();
            return;
          }
          for (const child of entries) {
            await readEntry(child, directoryPrefix, files);
          }
          await yieldToBrowser();
          readBatch();
        }, () => resolve());
      };
      readBatch();
      return;
    }

    resolve();
  });
}

function pushGroup(groups, key, record) {
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
}

function newestRecord(records) {
  return [...records].sort((a, b) => b.modified - a.modified || a.originalPath.localeCompare(b.originalPath))[0];
}

function closeModifiedDate(a, b) {
  return Math.abs((a || 0) - (b || 0)) <= 2000;
}

function commonMainFolder(paths) {
  const splitPaths = paths.map(path => path.split("/").filter(Boolean)).filter(parts => parts.length);
  if (!splitPaths.length) return "";
  const first = splitPaths[0][0];
  const hasSharedFolder = splitPaths.every(parts => parts.length > 1 && parts[0] === first);
  return hasSharedFolder ? first : "";
}

function isSystemFile(path) {
  const name = path.split("/").pop().toLowerCase();
  return SYSTEM_FILE_NAMES.has(name) || name.startsWith("._");
}

function getExtension(fileName) {
  const last = fileName.split(".").pop();
  return last && last !== fileName ? last.toLowerCase() : "";
}

function backupFileInfo(fileName) {
  const lower = fileName.toLowerCase();
  for (const pattern of BACKUP_EXTENSION_PATTERNS) {
    if (lower.endsWith(pattern.suffix)) {
      return {
        ...pattern,
        sourceBaseName: backupSourceBaseName(fileName, pattern.suffix)
      };
    }
  }

  const revitMatch = lower.match(/^(.*)\.\d{3,4}\.rvt$/);
  if (revitMatch) {
    return {
      suffix: ".####.rvt",
      primaryExtension: "rvt",
      detail: "Revit numbered backup file related to RVT",
      sourceBaseName: revitMatch[1]
    };
  }

  const adobeTemp = lower.match(/^(.*?)(?:[_\s-]+recovered|[_\s-]+recovery|[_\s-]+temp)$/);
  if (adobeTemp) {
    return {
      suffix: "recovery",
      primaryExtension: "",
      detail: "Adobe temp/recovery file related to primary source",
      sourceBaseName: adobeTemp[1]
    };
  }

  const baseName = getBaseName(fileName);
  const namedBackup = baseName.toLowerCase().match(/^(.*?)(?:[_\s-]+(?:autosave|auto-save|backup|back up|recovered|recovery|temp|temporary))$/);
  if (namedBackup && namedBackup[1]) {
    return {
      suffix: "backup-name",
      primaryExtension: "",
      detail: "Backup/autosave file related to primary source",
      sourceBaseName: normalizeComparableName(namedBackup[1])
    };
  }

  return null;
}

function backupSourceBaseName(fileName, suffix) {
  const withoutSuffix = fileName.slice(0, fileName.length - suffix.length);
  return normalizeBackupCandidateName(getBaseName(withoutSuffix) || withoutSuffix);
}

function normalizeBackupCandidateName(fileName) {
  return normalizeComparableName(fileName)
    .replace(/\b(?:autosave|auto save|backup|back up|recovered|recovery|temp|temporary)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function describeFileType(extension) {
  const label = FILE_TYPE_LABELS[extension] || (extension ? extension.toUpperCase() : "FILE");
  if (IMAGE_EXTENSIONS.has(extension)) return { category: "image", label, description: "Image" };
  if (extension === "pdf") return { category: "pdf", label, description: "PDF document" };
  if (DOCUMENT_EXTENSIONS.has(extension)) return { category: "document", label, description: "Document" };
  if (DESIGN_EXTENSIONS.has(extension)) return { category: "design", label, description: "CAD / design" };
  if (VIDEO_EXTENSIONS.has(extension)) return { category: "video", label, description: "Video" };
  return { category: "unsupported", label, description: "Unsupported format" };
}

function canRenderThumbnail(row) {
  return BROWSER_THUMBNAIL_EXTENSIONS.has(row.extension);
}

function canRenderVideo(row) {
  return row.extension === "mp4" || row.extension === "mov";
}

function canRenderText(row) {
  return row.file.type.startsWith("text/") || TEXT_PREVIEW_EXTENSIONS.has(row.extension);
}

function fileTypeIcon(fileType) {
  if (fileType.category === "image") return "IMG";
  if (fileType.category === "pdf") return "PDF";
  if (fileType.category === "document") return "DOC";
  if (fileType.category === "design") return "CAD";
  if (fileType.category === "video") return "VID";
  return "FILE";
}

function getBaseName(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function normalizeComparableName(baseName) {
  return String(baseName)
    .toLowerCase()
    .replace(/\s-\scopy\b/g, "")
    .replace(/[_\s-]+(copy|backup|old|duplicate|final copy|revised copy|back up)\b/g, "")
    .replace(/[_\s-]+(?:v(?:ersion)?\s*\d+|rev(?:ision)?\s*\d+|draft|previous|recovered|recovery|temp)\b/g, "")
    .replace(/\s*\(\d+\)\s*$/g, "")
    .replace(/[_\s-]+/g, " ")
    .trim();
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function slug(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "-");
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(timestamp) {
  if (!timestamp) return "Unknown";
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
