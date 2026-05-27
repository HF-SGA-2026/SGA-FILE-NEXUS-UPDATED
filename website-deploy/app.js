const SYSTEM_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const SUPPORTED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "mov", "pdf"]);
const JPG_EXTENSIONS = new Set(["jpg", "jpeg", "heic", "heif"]);
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);
const BATCH_SIZE = 12;
const LARGE_FOLDER_BYTES = 900 * 1024 * 1024;
const LARGE_FOLDER_FILES = 5000;
const PREVIEW_RENDER_LIMIT = 1000;
const AUTH_STORAGE_KEY = "sgaDataHygieneUser";
const RESET_PASSWORD_STORAGE_KEY = "sgaDataHygienePassword";
const TUTORIAL_RETURN_STORAGE_KEY = "sgaDataHygieneTutorialReturn";
const DEMO_USERS = new Map([
  ["hf@samgarciaarchitect.com", { password: "WarEagle" }],
  ["ag@samgarciaarchitect.com", { password: "HookemHorns" }],
  ["nk@samgarciaarchitect.com", { password: "RollTide" }],
  ["el@samgarciaarchitect.com", { password: "Gig'Em" }]
]);

const state = {
  mainFolderName: "",
  rawFiles: [],
  allFiles: [],
  folderPaths: new Set(),
  canDetectEmptyFolders: false,
  fileRecords: [],
  parentFolders: new Map(),
  folderAnalysis: new Map(),
  emptyFolders: [],
  duplicateFolders: [],
  duplicateFiles: [],
  identicalParentFolders: [],
  fileHashGroups: new Map(),
  selectedEmptyFolderRemovals: new Set(),
  selectedDuplicateRemovals: new Set(),
  selectedDuplicateFileRemovals: new Set(),
  selectedParentDuplicateRemovals: new Set(),
  skipAlreadyProcessed: true,
  emptyFolderMode: "exact",
  duplicateMode: "exact",
  duplicateFileMode: "exact",
  parentDuplicateMode: "exact",
  authUser: null,
  resetCode: "",
  resetCodeEmail: "",
  activeTool: "home",
  activeWorkflow: "photos",
  selectedParents: new Set(),
  previewRows: [],
  failures: [],
  exportComplete: false,
  currentZipBlob: null,
  currentZipUrl: "",
  currentZipName: "",
  currentOutputPath: "",
  serverScanId: "",
  serverFolderMode: false,
  processing: false,
  metrics: {
    total: 0,
    completed: 0,
    heicCompleted: 0,
    startTime: 0
  }
};

const els = {
  loginScreen: document.getElementById("loginScreen"),
  loginForm: document.getElementById("loginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  googleLoginButton: document.getElementById("googleLoginButton"),
  forgotPasswordButton: document.getElementById("forgotPasswordButton"),
  resetPasswordScreen: document.getElementById("resetPasswordScreen"),
  resetPasswordForm: document.getElementById("resetPasswordForm"),
  resetEmail: document.getElementById("resetEmail"),
  sendResetCodeButton: document.getElementById("sendResetCodeButton"),
  resetCode: document.getElementById("resetCode"),
  resetPassword: document.getElementById("resetPassword"),
  backToLoginButton: document.getElementById("backToLoginButton"),
  resetMessage: document.getElementById("resetMessage"),
  loginError: document.getElementById("loginError"),
  quickLogoutButton: document.getElementById("quickLogoutButton"),
  dropZone: document.getElementById("dropZone"),
  chooseFolderButton: document.getElementById("chooseFolderButton"),
  folderInput: document.getElementById("folderInput"),
  serverFolderPathInput: document.getElementById("serverFolderPathInput"),
  serverScanButton: document.getElementById("serverScanButton"),
  clearButton: document.getElementById("clearButton"),
  photosModeButton: document.getElementById("photosModeButton"),
  pdfsModeButton: document.getElementById("pdfsModeButton"),
  homeButton: document.getElementById("homeButton"),
  folderDiscarderButton: document.getElementById("folderDiscarderButton"),
  blankDuplicateDiscarderButton: document.getElementById("blankDuplicateDiscarderButton"),
  firmToolsButton: document.getElementById("firmToolsButton"),
  constructionToolsButton: document.getElementById("constructionToolsButton"),
  renamingSystemsButton: document.getElementById("renamingSystemsButton"),
  settingsButton: document.getElementById("settingsButton"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  settingsCloseButton: document.getElementById("settingsCloseButton"),
  accountName: document.getElementById("accountName"),
  logoutButton: document.getElementById("logoutButton"),
  selectAllButton: document.getElementById("selectAllButton"),
  deselectAllButton: document.getElementById("deselectAllButton"),
  renameButton: document.getElementById("renameButton"),
  downloadButton: document.getElementById("downloadButton"),
  reportButton: document.getElementById("reportButton"),
  clearLogButton: document.getElementById("clearLogButton"),
  skipProcessedInput: document.getElementById("skipProcessedInput"),
  parentList: document.getElementById("parentList"),
  folderSummary: document.getElementById("folderSummary"),
  previewBody: document.getElementById("previewBody"),
  previewCount: document.getElementById("previewCount"),
  messageLog: document.getElementById("messageLog"),
  summaryParentFolders: document.getElementById("summaryParentFolders"),
  summaryDuplicateParents: document.getElementById("summaryDuplicateParents"),
  summaryFolders: document.getElementById("summaryFolders"),
  summaryFilesScanned: document.getElementById("summaryFilesScanned"),
  summaryEmptyParents: document.getElementById("summaryEmptyParents"),
  summaryEmpty: document.getElementById("summaryEmpty"),
  summaryDuplicateFolders: document.getElementById("summaryDuplicateFolders"),
  summaryDuplicateFiles: document.getElementById("summaryDuplicateFiles"),
  summarySecondaryNeeds: document.getElementById("summarySecondaryNeeds"),
  summarySecondaryProcessed: document.getElementById("summarySecondaryProcessed"),
  summaryNeeds: document.getElementById("summaryNeeds"),
  summaryProcessed: document.getElementById("summaryProcessed"),
  emptyFolderList: document.getElementById("emptyFolderList"),
  emptyFolderReview: document.getElementById("emptyFolderReview"),
  duplicateFolderList: document.getElementById("duplicateFolderList"),
  duplicateFolderReview: document.getElementById("duplicateFolderReview"),
  duplicateFileList: document.getElementById("duplicateFileList"),
  duplicateFileReview: document.getElementById("duplicateFileReview"),
  identicalParentReview: document.getElementById("identicalParentReview"),
  identicalParentList: document.getElementById("identicalParentList"),
  emptyFolderTitle: document.querySelector("#emptyFolderReview h3"),
  duplicateFolderTitle: document.querySelector("#duplicateFolderReview h3"),
  duplicateFileTitle: document.querySelector("#duplicateFileReview h3"),
  identicalParentTitle: document.querySelector("#identicalParentReview h3"),
  brandText: document.getElementById("brandText"),
  workflowSubtitle: document.getElementById("workflowSubtitle"),
  headerCopy: document.getElementById("headerCopy"),
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
  libraryStatus: document.getElementById("libraryStatus"),
  tutorialPageButton: document.querySelector(".tutorial-page-button")
};

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  initializeAuth();
  initializeTooltips();
  updateToolMode();
  updateWorkflowMode();
  updateLibraryStatus();
  resetUi();
});

function bindEvents() {
  els.loginForm.addEventListener("submit", event => {
    event.preventDefault();
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value.trim();
    if (!email) {
      els.loginError.textContent = "Enter an email address to sign in.";
      return;
    }
    if (!password) {
      els.loginError.textContent = "Enter your password to sign in.";
      return;
    }
    if (!isValidLogin(email, password)) {
      els.loginError.textContent = "The email or password is incorrect.";
      return;
    }
    signIn({ name: email.split("@")[0] || "SGA User", email, provider: "Email" });
  });

  els.googleLoginButton.addEventListener("click", () => {
    signIn({ name: "Google User", email: "google.user@sga.local", provider: "Google" });
  });

  els.forgotPasswordButton.addEventListener("click", () => setAuthView("reset"));
  els.backToLoginButton.addEventListener("click", () => setAuthView("login"));
  els.sendResetCodeButton.addEventListener("click", sendResetCode);
  document.querySelectorAll("[data-toggle-password]").forEach(button => {
    button.addEventListener("click", () => togglePasswordVisibility(button));
  });
  els.resetPasswordForm.addEventListener("submit", event => {
    event.preventDefault();
    const email = els.resetEmail.value.trim();
    const code = els.resetCode.value.trim();
    const password = els.resetPassword.value.trim();
    if (!email || !code || !password) {
      els.resetMessage.textContent = "Enter your email, verification code, and new password.";
      return;
    }
    if (!isAuthorizedEmail(email)) {
      els.resetMessage.textContent = "That email is not authorized for this site.";
      return;
    }
    if (!state.resetCode || email.toLowerCase() !== state.resetCodeEmail || code !== state.resetCode) {
      els.resetMessage.textContent = "The verification code is incorrect or expired.";
      return;
    }
    setActiveLoginPassword(email, password);
    state.resetCode = "";
    state.resetCodeEmail = "";
    els.resetMessage.textContent = "Password reset verified. You can sign in with the new password.";
    els.loginEmail.value = email;
    els.loginPassword.value = "";
    setTimeout(() => setAuthView("login"), 1100);
  });

  els.quickLogoutButton.addEventListener("click", signOut);
  els.logoutButton.addEventListener("click", signOut);

  els.chooseFolderButton.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    if (state.processing) return;
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

  els.serverScanButton.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    await scanServerFolder();
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
    setStatus("Scanning folders...");
    addLog("Scanning dropped folder...");
    const dropData = await filesFromDrop(event.dataTransfer);
    await loadFileList(dropData.files, dropData.folderPaths, true);
  });

  els.clearButton.addEventListener("click", clearAll);
  els.homeButton.addEventListener("click", () => setToolMode("home"));
  els.folderDiscarderButton.addEventListener("click", () => setToolMode("folder-discarder"));
  els.blankDuplicateDiscarderButton.addEventListener("click", () => setToolMode("blank-duplicate"));
  els.firmToolsButton.addEventListener("click", () => setToolMode("firm"));
  els.constructionToolsButton.addEventListener("click", () => setToolMode("construction"));
  els.renamingSystemsButton.addEventListener("click", () => setToolMode("sga"));
  els.settingsButton.addEventListener("click", openSettings);
  els.settingsCloseButton.addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", event => {
    if (event.target.matches("[data-close-settings]")) closeSettings();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeSettings();
  });
  els.photosModeButton.addEventListener("click", () => setWorkflowMode("photos"));
  els.pdfsModeButton.addEventListener("click", () => setWorkflowMode("pdfs"));
  els.tutorialPageButton.addEventListener("click", rememberTutorialReturn);
  els.selectAllButton.addEventListener("click", () => setAllParents(true));
  els.deselectAllButton.addEventListener("click", () => setAllParents(false));
  els.renameButton.addEventListener("click", processFolder);
  els.downloadButton.addEventListener("click", downloadZip);
  els.reportButton.addEventListener("click", downloadReport);
  els.skipProcessedInput.addEventListener("change", event => {
    state.skipAlreadyProcessed = event.target.checked;
    invalidateZip();
    updateControlStates();
    updatePreview();
    updateControls();
  });
  document.querySelectorAll('input[name="emptyFolderMode"]').forEach(input => {
    input.addEventListener("change", () => {
      state.emptyFolderMode = input.value;
      invalidateZip();
      updateControlStates();
      renderEmptyFolderList();
      updatePreview();
      updateSummary();
      updateControls();
    });
  });
  document.querySelectorAll('input[name="duplicateMode"]').forEach(input => {
    input.addEventListener("change", () => {
      state.duplicateMode = input.value;
      invalidateZip();
      updateControlStates();
      renderDuplicateFolderList();
      updatePreview();
      updateSummary();
      updateControls();
    });
  });
  document.querySelectorAll('input[name="duplicateFileMode"]').forEach(input => {
    input.addEventListener("change", () => {
      state.duplicateFileMode = input.value;
      invalidateZip();
      updateControlStates();
      renderDuplicateFileList();
      updatePreview();
      updateSummary();
      updateControls();
    });
  });
  document.querySelectorAll('input[name="parentDuplicateMode"]').forEach(input => {
    input.addEventListener("change", () => {
      state.parentDuplicateMode = input.value;
      invalidateZip();
      updateControlStates();
      renderIdenticalParentList();
      updatePreview();
      updateSummary();
      updateControls();
    });
  });
  els.downloadButton.addEventListener("dragstart", event => {
    if (!state.currentZipBlob && !state.currentZipUrl) return;
    const url = ensureZipObjectUrl();
    const fileName = state.currentZipName || "SGA FILE NEXUS.zip";
    event.dataTransfer.setData("DownloadURL", `application/zip:${fileName}:${url}`);
    event.dataTransfer.setData("text/uri-list", url);
    event.dataTransfer.effectAllowed = "copy";
  });
  els.clearLogButton.addEventListener("click", () => {
    els.messageLog.innerHTML = "";
  });
}

function initializeAuth() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
    if (saved?.email) {
      state.authUser = saved;
      restoreTutorialReturn();
      updateAuthUi();
      return;
    }
  } catch (error) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  updateAuthUi();
}

function rememberTutorialReturn() {
  sessionStorage.setItem(TUTORIAL_RETURN_STORAGE_KEY, JSON.stringify({
    activeTool: state.activeTool,
    activeWorkflow: state.activeWorkflow
  }));
}

function restoreTutorialReturn() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TUTORIAL_RETURN_STORAGE_KEY) || "null");
    sessionStorage.removeItem(TUTORIAL_RETURN_STORAGE_KEY);
    if (saved?.activeTool) {
      state.activeTool = saved.activeTool;
      state.activeWorkflow = saved.activeWorkflow || "photos";
    }
  } catch (error) {
    sessionStorage.removeItem(TUTORIAL_RETURN_STORAGE_KEY);
  }
}

function setAuthView(view) {
  document.body.dataset.authView = view;
  els.loginError.textContent = "";
  els.resetMessage.textContent = "";
  if (view === "reset") {
    state.resetCode = "";
    state.resetCodeEmail = "";
    els.resetCode.value = "";
    els.resetPassword.value = "";
  }
  const focusTarget = view === "reset" ? els.resetEmail : els.loginEmail;
  setTimeout(() => focusTarget?.focus(), 0);
}

function sendResetCode() {
  const email = els.resetEmail.value.trim().toLowerCase();
  if (!email) {
    els.resetMessage.textContent = "Enter your email before requesting a verification code.";
    return;
  }
  if (!isAuthorizedEmail(email)) {
    els.resetMessage.textContent = "That email is not authorized for this site.";
    return;
  }
  state.resetCode = String(Math.floor(100000 + Math.random() * 900000));
  state.resetCodeEmail = email;
  els.resetMessage.textContent = `Verification code sent. Local demo code: ${state.resetCode}`;
  els.resetCode.focus();
}

function togglePasswordVisibility(button) {
  const input = document.getElementById(button.dataset.togglePassword);
  if (!input) return;
  const shouldShow = input.type === "password";
  input.type = shouldShow ? "text" : "password";
  button.textContent = shouldShow ? "Hide" : "Show";
  button.setAttribute("aria-pressed", String(shouldShow));
}

function getResetPasswordKey(email) {
  return `${RESET_PASSWORD_STORAGE_KEY}:${String(email || "").trim().toLowerCase()}`;
}

function getDemoUser(email) {
  return DEMO_USERS.get(String(email || "").trim().toLowerCase()) || null;
}

function isAuthorizedEmail(email) {
  return Boolean(getDemoUser(email));
}

function getActiveLoginPassword(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return localStorage.getItem(getResetPasswordKey(normalized)) || getDemoUser(normalized)?.password || "";
}

function setActiveLoginPassword(email, password) {
  localStorage.setItem(getResetPasswordKey(email), password);
}

function isValidLogin(email, password) {
  return isAuthorizedEmail(email) && password === getActiveLoginPassword(email);
}

function signIn(user) {
  state.authUser = user;
  state.activeTool = "home";
  state.activeWorkflow = "photos";
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
  els.loginError.textContent = "";
  updateToolMode();
  updateWorkflowMode();
  updateAuthUi();
  addLog(`Signed in with ${user.provider}.`);
}

function signOut() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  state.authUser = null;
  closeSettings();
  updateAuthUi();
}

function updateAuthUi() {
  const signedIn = Boolean(state.authUser?.email);
  document.body.dataset.auth = signedIn ? "logged-in" : "logged-out";
  if (els.accountName) {
    els.accountName.textContent = signedIn
      ? `${state.authUser.name || state.authUser.email} (${state.authUser.provider})`
      : "Not signed in";
  }
  if (!signedIn) {
    setAuthView("login");
    els.loginEmail.value = "";
    els.loginPassword.value = "";
    setTimeout(() => els.loginEmail?.focus(), 0);
  }
}

function setToolMode(mode) {
  if (state.processing || state.activeTool === mode) return;
  closeSettings();
  state.activeTool = mode;
  if (mode === "sga") {
    state.activeWorkflow = "photos";
  }
  updateToolMode();
  updateWorkflowMode();
}

function openSettings() {
  els.settingsOverlay.classList.add("open");
  els.settingsOverlay.setAttribute("aria-hidden", "false");
  els.settingsCloseButton.focus();
}

function closeSettings() {
  if (!els.settingsOverlay?.classList.contains("open")) return;
  els.settingsOverlay.classList.remove("open");
  els.settingsOverlay.setAttribute("aria-hidden", "true");
}

function updateToolMode() {
  const isHome = state.activeTool === "home";
  const isFirm = state.activeTool === "firm";
  document.body.dataset.tool = state.activeTool;
  els.brandText.textContent = "SGA FILE NEXUS";
  if (isHome) {
    els.workflowSubtitle.textContent = "Tool Hub";
    els.headerCopy.textContent = "Choose a hygiene tool to review, clean, rename, or package folders with a clear preview before anything is exported.";
  } else if (isFirm) {
    els.workflowSubtitle.textContent = "SGA Specific Tools";
    els.headerCopy.textContent = "Choose a firm-specific tool group.";
  } else if (state.activeTool === "folder-discarder") {
    els.workflowSubtitle.textContent = "SGA Empty Folder Discarder";
    els.headerCopy.textContent = "Folder discard tools are coming soon.";
  } else if (state.activeTool === "blank-duplicate") {
    els.workflowSubtitle.textContent = "SGA Backup Discarder";
    els.headerCopy.textContent = "SGA backup discard tools are coming soon.";
  } else if (state.activeTool === "construction") {
    els.workflowSubtitle.textContent = "Construction Document Tools";
    els.headerCopy.textContent = "Construction document cleanup and review tools are coming soon.";
  }
}

function setWorkflowMode(mode) {
  if (state.processing || state.activeWorkflow === mode) return;
  state.activeWorkflow = mode;
  updateWorkflowMode();
}

function updateWorkflowMode() {
  const isPhotos = state.activeWorkflow === "photos";
  const isPdfs = state.activeWorkflow === "pdfs";
  document.body.dataset.workflow = state.activeWorkflow;
  if (state.activeTool === "construction") {
    els.photosModeButton.textContent = "Check";
    els.pdfsModeButton.textContent = "Render";
    els.photosModeButton.title = "Use the construction document check workflow.";
    els.pdfsModeButton.title = "Use the construction document render workflow.";
    els.workflowSubtitle.textContent = isPhotos ? "SGA Integrity Check" : "SGA Render Studio";
    els.headerCopy.textContent = "Construction document cleanup and review tools are coming soon.";
  } else {
    els.photosModeButton.textContent = "Photos";
    els.pdfsModeButton.textContent = "PDFs";
    els.photosModeButton.title = "Use the photo renaming workflow.";
    els.pdfsModeButton.title = "Switch to the PDF renaming workflow.";
  }
  if (state.activeTool === "sga") {
    els.workflowSubtitle.textContent = isPhotos ? "Photo Renamer" : "PDF Renamer";
    els.headerCopy.textContent = "Drop or choose a main folder, select parent folders, review the rename list, then download the updated folder as a ZIP.";
  }
  els.photosModeButton.classList.toggle("active", isPhotos);
  els.pdfsModeButton.classList.toggle("active", isPdfs);
  els.photosModeButton.setAttribute("aria-pressed", String(isPhotos));
  els.pdfsModeButton.setAttribute("aria-pressed", String(isPdfs));
}

function initializeTooltips() {
  const tooltipMap = new Map([
    [els.chooseFolderButton, "Choose the main folder that contains your parent folders."],
    [els.homeButton, "Return to the main data hygiene tool page."],
    [els.folderDiscarderButton, "Open SGA Empty Folder Discarder."],
    [els.blankDuplicateDiscarderButton, "Open SGA Backup Discarder."],
    [els.firmToolsButton, "Open firm-specific SGA tools."],
    [els.constructionToolsButton, "Open Construction Document Tools."],
    [els.renamingSystemsButton, "Open the current SGA File Nexus renaming website."],
    [els.settingsButton, "Open shared settings for the data hygiene tools."],
    [els.serverScanButton, "Scan a folder path from the local server for very large jobs."],
    [els.clearButton, "Clear the current folder and reset the page."],
    [els.selectAllButton, "Select every parent folder for analysis and export."],
    [els.deselectAllButton, "Deselect every parent folder."],
    [els.renameButton, "Create the ZIP using the current preview and settings."],
    [els.downloadButton, "Save the generated ZIP after export is complete."],
    [els.reportButton, "Download an Excel workbook report with the summary, review sections, and planned renames."],
    [els.clearLogButton, "Clear the activity log messages."]
  ]);
  for (const [element, title] of tooltipMap) {
    if (element) element.title = title;
  }
  document.querySelectorAll(".control-group label").forEach(label => {
    const text = label.textContent.trim();
    if (!label.title) label.title = explainCommand(text);
  });
  initializeBoxTooltips();
}

function initializeBoxTooltips() {
  const boxTips = [
    [".folder-panel", "Step 1: choose which parent folders should be analyzed, renamed, and included in the export."],
    [".controls-panel", "Settings: choose how already processed folders, empty folders, duplicates, and identical parent folders should be handled."],
    [".summary-panel", "Processing Summary: shows the counts from the selected parent folders and highlights items that need attention."],
    [".analysis-panel", "Folder and File Review: previews empty folders, duplicate folders, duplicate files, and identical parent folders before export."],
    [".preview-panel", "Review Planned Renames: shows each original file name, the planned exported name, and its processing status."],
    [".action-panel", "Create ZIP: export the ZIP, download it, or download a workbook report."],
    [".progress-panel", "Progress: shows export progress, speed, completion, and estimated time remaining."],
    [".log-panel", "Log: records activity, warnings, and errors while you use the app."],
    ["#emptyFolderReview", "Empty Secondary Folders: folders with no files that can be kept or removed from the generated ZIP."],
    ["#duplicateFolderReview", "Duplicate Folders: folders inside the same parent with matching names or matching contents."],
    ["#duplicateFileReview", "Duplicate Files: exact file duplicates found by content hash."],
    ["#identicalParentReview", "Identical Parent Folders: parent folders whose file structures appear identical."]
  ];
  for (const [selector, title] of boxTips) {
    document.querySelector(selector)?.setAttribute("title", title);
  }
  document.querySelectorAll(".summary-grid > div").forEach(card => {
    const label = card.querySelector("span")?.textContent?.trim();
    if (label) card.title = `${label}: ${card.querySelector("strong")?.textContent || "0"}`;
  });
}

function explainCommand(text) {
  const lower = text.toLowerCase();
  if (lower.includes("skip already")) return "Leaves folders that already match the naming format unchanged.";
  if (lower.includes("keep empty")) return "Keeps empty secondary folders in the generated ZIP.";
  if (lower.includes("remove selected empty")) return "Only removes the empty folders you check below from the generated ZIP.";
  if (lower.includes("auto-remove all empty")) return "Automatically removes every detected empty secondary folder from the generated ZIP.";
  if (lower.includes("keep all duplicate folders")) return "Keeps every duplicate folder in the generated ZIP.";
  if (lower.includes("remove selected duplicate folders")) return "Only removes the duplicate folders you check below from the generated ZIP.";
  if (lower.includes("auto-remove exact duplicate folders")) return "Automatically removes exact duplicate folders while keeping the first copy.";
  if (lower.includes("keep all duplicate files")) return "Keeps every duplicate file in the generated ZIP.";
  if (lower.includes("remove only the duplicate files")) return "Only removes duplicate files you check below from the generated ZIP.";
  if (lower.includes("auto-remove exact duplicate files")) return "Automatically removes exact duplicate files while keeping the first copy.";
  if (lower.includes("keep all identical parent")) return "Keeps all identical parent folders in the generated ZIP.";
  if (lower.includes("remove selected identical parent")) return "Only removes identical parent folders you check below from the generated ZIP.";
  if (lower.includes("auto-remove identical parent")) return "Automatically removes identical parent folders while keeping the first copy.";
  return "Change how this item is handled in the generated ZIP.";
}

function updateLibraryStatus() {
  const hasZip = Boolean(window.JSZip);
  const hasHeic = Boolean(window.heic2any);
  if (hasZip && hasHeic) {
    els.libraryStatus.textContent = "JSZIP AND HEIC CONVERTER READY";
    els.libraryStatus.className = "library-status ok";
  } else if (hasZip) {
    els.libraryStatus.textContent = "JSZIP READY; HEIC CONVERTER UNAVAILABLE";
    els.libraryStatus.className = "library-status warn";
  } else {
    els.libraryStatus.textContent = "JSZIP UNAVAILABLE";
    els.libraryStatus.className = "library-status warn";
  }
}

async function loadFileList(files, discoveredFolderPaths = [], canDetectEmptyFolders = false) {
  clearWorkingState();
  setStatus("Scanning folders...");
  state.exportComplete = false;
  state.serverFolderMode = false;
  state.serverScanId = "";

  const rawItems = files
    .map(file => ({ file, path: normalizePath(file.webkitRelativePath || file.relativePath || file.name), hash: file.hash || "" }))
    .filter(item => item.path);
  const normalized = rawItems.filter(item => !isSystemFile(item.path));

  state.canDetectEmptyFolders = canDetectEmptyFolders;
  state.folderPaths = new Set([...discoveredFolderPaths].map(normalizePath).filter(Boolean));
  for (const item of rawItems) {
    addParentPaths(item.path, state.folderPaths);
  }

  if (!rawItems.length && !state.folderPaths.size) {
    addLog("No usable files were found. Choose the main folder itself, not a parent folder inside it.", "warn");
    resetUi();
    return;
  }

  const mainFolder = commonMainFolder(rawItems.length ? rawItems.map(item => item.path) : [...state.folderPaths]);
  state.mainFolderName = mainFolder || "Updated Folder";
  state.rawFiles = rawItems;
  state.allFiles = normalized;

  seedParentFoldersFromPaths();

  for (const item of normalized) {
    const parts = item.path.split("/").filter(Boolean);
    if (parts.length < 2) {
      continue;
    }

    const [main, parent, secondary] = parts;
    const fileName = parts[parts.length - 1];
    const extension = getExtension(fileName);
    const originalExtension = getOriginalExtension(fileName);
    const isSupported = SUPPORTED_EXTENSIONS.has(extension);
    const isHeic = HEIC_EXTENSIONS.has(extension);
    const record = {
      file: item.file,
      originalPath: item.path,
      main,
      parent,
      secondary,
      fileName,
      extension,
      originalExtension,
      isSupported,
      isHeic
    };

    ensureParentInfo(parent);
    const parentInfo = state.parentFolders.get(parent);
    parentInfo.fileCount += 1;
    if (isSupported) parentInfo.supportedCount += 1;
    if (isHeic) parentInfo.heicCount += 1;

    if (parts.length < 4) {
      continue;
    }

    state.fileRecords.push(record);
    parentInfo.secondaryFolders.add(secondary);
  }

  analyzeFolders();
  analyzeIdenticalParentFolders();
  await analyzeDuplicateFiles();

  if (!state.parentFolders.size) {
    addLog("No parent folders with secondary folders were found. Expected Main Folder / Parent Folder / Secondary Folder / files.", "warn");
  }

  state.selectedParents = new Set(state.parentFolders.keys());
  renderParentList();
  renderEmptyFolderList();
  renderDuplicateFolderList();
  renderDuplicateFileList();
  renderIdenticalParentList();
  updateControlStates();
  updatePreview();
  updateSummary();
  updateControls();

  const totalBytes = normalized.reduce((sum, item) => sum + (item.file.size || 0), 0);
  const loadedCounts = getLoadedScanCounts();
  els.folderSummary.textContent = `${state.mainFolderName}: ${loadedCounts.parentFolders} parent folders, ${loadedCounts.secondaryFolders} secondary folders, ${loadedCounts.files} files scanned.`;
  setStatus("Finished");
  addLog(`Loaded "${state.mainFolderName}" with ${state.parentFolders.size} parent folders.`);
  if (!state.canDetectEmptyFolders) {
    addLog("Empty-folder detection is limited with the folder picker. Drag and drop the folder for the best empty-folder scan.", "warn");
  }

  if (totalBytes > LARGE_FOLDER_BYTES || normalized.length > LARGE_FOLDER_FILES) {
    addLog("Large folder detected. The local server export will be used when possible.", "warn");
  }
}

async function scanServerFolder() {
  const folderPath = els.serverFolderPathInput.value.trim();
  if (!folderPath) {
    addLog("Enter a server folder path first.", "warn");
    return;
  }

  const serverStatus = await getServerStatus();
  if (!serverStatus?.serverExport) {
    window.alert("Server folder scanning needs the Node server. Stop the current localhost server, then run npm start from the SGA-FILE-RENAME folder.");
    addLog("Start the local server with npm start before scanning a server folder.", "error");
    return;
  }

  clearWorkingState();
  setStatus("Server scanning folder...");
  addLog("Server scanning folder. Large folders can take a while...");
  updateControls();

  try {
    const response = await fetch("/api/scan-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Server folder scan failed.");

    state.serverFolderMode = true;
    state.serverScanId = data.scanId;
    const files = data.files.map(file => ({
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      relativePath: file.path,
      hash: file.hash,
      serverFile: true
    }));

    await loadFileList(files, data.folderPaths, true);
    state.serverFolderMode = true;
    state.serverScanId = data.scanId;
    addLog(`Server scan ready: ${data.files.length} files from ${data.rootPath}.`);
  } catch (error) {
    addLog(`Server scan failed: ${error.message}`, "error");
    resetUi();
  }
}

function seedParentFoldersFromPaths() {
  for (const folderPath of state.folderPaths) {
    const parts = folderPath.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    const parent = parts[1];
    ensureParentInfo(parent);
    if (parts.length >= 3) {
      state.parentFolders.get(parent).secondaryFolders.add(parts[2]);
    }
  }
}

function ensureParentInfo(parent) {
  if (!state.parentFolders.has(parent)) {
    state.parentFolders.set(parent, {
      name: parent,
      secondaryFolders: new Set(),
      fileCount: 0,
      supportedCount: 0,
      heicCount: 0
    });
  }
}

function analyzeFolders() {
  state.folderAnalysis = new Map();
  state.emptyFolders = [];
  state.duplicateFolders = [];
  state.identicalParentFolders = [];
  state.selectedEmptyFolderRemovals = new Set();
  state.selectedDuplicateRemovals = new Set();
  state.selectedParentDuplicateRemovals = new Set();

  for (const folderPath of state.folderPaths) {
    const parts = folderPath.split("/").filter(Boolean);
    if (!parts.length) continue;
    state.folderAnalysis.set(folderPath, {
      path: folderPath,
      name: parts[parts.length - 1],
      parent: parts[1] || "",
      level: getFolderLevel(parts),
      directFiles: [],
      descendantFiles: [],
      childFolderPaths: [],
      supportedDescendantCount: 0,
      supportedCount: 0,
      alreadyProcessedCount: 0,
      unsupportedCount: 0,
      status: "Needs Processing",
      contentSignature: ""
    });
  }

  for (const item of state.rawFiles) {
    const parts = item.path.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const folderPath = parts.slice(0, index).join("/");
      const info = state.folderAnalysis.get(folderPath);
      if (info) {
        info.descendantFiles.push(item);
        if (!isSystemFile(item.path) && SUPPORTED_EXTENSIONS.has(getExtension(parts[parts.length - 1]))) {
          info.supportedDescendantCount += 1;
        }
      }
    }
    const directFolder = parts.slice(0, -1).join("/");
    const directInfo = state.folderAnalysis.get(directFolder);
    if (directInfo) {
      directInfo.directFiles.push(item);
    }
  }

  for (const info of state.folderAnalysis.values()) {
    const childPrefix = `${info.path}/`;
    info.childFolderPaths = [...state.folderAnalysis.keys()].filter(path => {
      if (!path.startsWith(childPrefix)) return false;
      return path.slice(childPrefix.length).split("/").filter(Boolean).length === 1;
    });
  }

  for (const record of state.fileRecords) {
    const secondaryPath = pathJoin(record.main, record.parent, record.secondary);
    const info = state.folderAnalysis.get(secondaryPath);
    if (!info) continue;
    if (!record.isSupported) {
      info.unsupportedCount += 1;
      continue;
    }
    info.supportedCount += 1;
    if (isAlreadyProcessed(record)) {
      info.alreadyProcessedCount += 1;
    }
  }

  for (const info of state.folderAnalysis.values()) {
    info.contentSignature = folderContentSignature(info);
    if (isEmptyFolderForReview(info)) {
      state.emptyFolders.push(info);
    }
    if (info.supportedCount) {
      if (info.alreadyProcessedCount === info.supportedCount) {
        info.status = "Already Processed";
      } else if (info.alreadyProcessedCount > 0) {
        info.status = "Partially Processed";
      }
    }
  }

  const duplicateRows = new Map();
  addDuplicateGroups(duplicateRows, "name", [...state.folderAnalysis.values()].filter(info => info.level === "Secondary Folder" && info.descendantFiles.length), info => `${info.parent.toLowerCase()}\u0000${info.name.toLowerCase()}`);
  addDuplicateGroups(duplicateRows, "exact", [...state.folderAnalysis.values()].filter(info => info.level === "Secondary Folder" && info.contentSignature), info => `${info.parent.toLowerCase()}\u0000${info.contentSignature}`);

  state.duplicateFolders = [...duplicateRows.values()]
    .sort((a, b) => a.folder.path.localeCompare(b.folder.path, undefined, { numeric: true, sensitivity: "base" }));
}

function analyzeIdenticalParentFolders() {
  state.identicalParentFolders = [];
  const parentRows = [...state.parentFolders.keys()].map(parent => {
    const signature = state.rawFiles
      .filter(item => item.path.split("/").filter(Boolean)[1] === parent)
      .map(item => {
        const parts = item.path.split("/").filter(Boolean);
        const relativePath = parts.slice(2).join("/").toLowerCase();
        return `${relativePath}:${item.file.size || 0}`;
      })
      .sort()
      .join("|");
    return { parent, signature };
  }).filter(row => row.signature);

  const groups = new Map();
  for (const row of parentRows) {
    if (!groups.has(row.signature)) groups.set(row.signature, []);
    groups.get(row.signature).push(row.parent);
  }

  let groupNumber = 1;
  for (const parents of groups.values()) {
    if (parents.length < 2) continue;
    const sortedParents = parents.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    sortedParents.forEach((parent, index) => {
      const parentInfo = state.parentFolders.get(parent);
      state.identicalParentFolders.push({
        parent,
        path: pathJoin(state.mainFolderName, parent),
        groupNumber,
        keepByDefault: index === 0,
        fileCount: parentInfo?.fileCount || 0,
        secondaryCount: parentInfo?.secondaryFolders.size || 0
      });
    });
    groupNumber += 1;
  }
}

async function analyzeDuplicateFiles() {
  state.duplicateFiles = [];
  state.fileHashGroups = new Map();
  state.selectedDuplicateFileRemovals = new Set();

  if (!window.crypto?.subtle) {
    addLog("Duplicate-file hashing is unavailable in this browser.", "warn");
    return;
  }

  setStatus("Analyzing duplicate files...");
  addLog("Analyzing duplicate files...");

  let hashed = 0;
  for (const item of state.allFiles) {
    try {
      const parent = item.path.split("/").filter(Boolean)[1] || "";
      const hash = item.hash || await hashFile(item.file);
      const groupKey = `${parent.toLowerCase()}\u0000${hash}`;
      if (!state.fileHashGroups.has(groupKey)) state.fileHashGroups.set(groupKey, []);
      state.fileHashGroups.get(groupKey).push(item);
    } catch (error) {
      addLog(`Could not hash ${item.path}: ${error.message}`, "warn");
    }
    hashed += 1;
    if (hashed % 25 === 0) await yieldToBrowser();
  }

  let groupNumber = 1;
  for (const group of state.fileHashGroups.values()) {
    if (group.length < 2) continue;
    group
      .sort(compareDuplicateFileKeepOrder)
      .forEach((item, index) => {
        state.duplicateFiles.push({
          item,
          groupNumber,
          keepByDefault: index === 0
        });
      });
    groupNumber += 1;
  }
}

function compareDuplicateFileKeepOrder(a, b) {
  const aCopyScore = getCopyPathScore(a.path);
  const bCopyScore = getCopyPathScore(b.path);
  if (aCopyScore !== bCopyScore) return aCopyScore - bCopyScore;
  return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" });
}

function getCopyPathScore(path) {
  const folderParts = normalizePath(path).split("/").filter(Boolean).slice(1, -1);
  return folderParts.some(part => isCopyFolderName(part)) ? 1 : 0;
}

function isCopyFolderName(name) {
  return /(?:^|[\s._-])copy(?:[\s._-]|\d|$)/i.test(String(name || ""));
}

function addDuplicateGroups(rows, matchType, folders, keyFn) {
  const groups = new Map();
  for (const folder of folders) {
    const key = keyFn(folder);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(folder);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
      .forEach((folder, index) => {
      const id = folder.path;
      const existing = rows.get(id);
      if (existing) {
        if (matchType === "exact") {
          existing.match = "Contents appear identical";
          existing.exactKeepByDefault = index === 0;
        }
        existing.exactDuplicate = existing.exactDuplicate || matchType === "exact";
      } else {
        rows.set(id, {
          folder,
          match: matchType === "exact" ? "Contents appear identical" : "Folder name matches",
          exactDuplicate: matchType === "exact",
          exactKeepByDefault: matchType === "exact" ? index === 0 : true,
          keepByDefault: index === 0
        });
      }
    });
  }
}

function folderContentSignature(info) {
  if (!info.descendantFiles.length) return "";
  return info.descendantFiles
    .map(item => {
      const relativePath = item.path.slice(info.path.length + 1).toLowerCase();
      return `${relativePath}:${item.file.size || 0}`;
    })
    .sort()
    .join("|");
}

function isAlreadyProcessed(record) {
  if (!record.isSupported) return false;
  if (secondaryFolderNeedsProcessing(record.secondary)) return false;
  const newExt = getExportExtension(record);
  const escapedSecondary = escapeRegExp(getExportSecondaryName(record.secondary));
  const pattern = new RegExp(`^${escapedSecondary}_\\d{3}\\.${escapeRegExp(newExt)}$`, "i");
  return pattern.test(record.fileName);
}

function secondaryFolderNeedsProcessing(folderName) {
  return !isCleanDateSecondaryName(folderName) || folderName !== getExportSecondaryName(folderName);
}

function isCleanDateSecondaryName(folderName) {
  const value = String(folderName || "").trim();
  return /^\d{4}\.\d{2}\.\d{2}$/.test(value) && normalizeDateFolderName(value) === value;
}

function isSecondaryFolderAlreadyProcessed(folder) {
  if (!folder || folder.level !== "Secondary Folder") return false;
  if (!hasNonSystemDescendantFiles(folder)) return false;
  if (secondaryFolderNeedsProcessing(folder.name)) return false;
  if (!folder.supportedCount) return false;
  return folder.alreadyProcessedCount === folder.supportedCount;
}

function getFolderInfoForRecord(record) {
  return state.folderAnalysis.get(pathJoin(record.main, record.parent, record.secondary));
}

function getRecordStatus(record) {
  if (!state.selectedParents.has(record.parent)) {
    return "Skipped";
  }
  if (isPathExcludedFromZip(record.originalPath)) return "Will Be Removed";
  if (!record.isSupported) return "Skipped";
  const folderInfo = getFolderInfoForRecord(record);
  if (isAlreadyProcessed(record)) return "Already Processed";
  if (secondaryFolderNeedsProcessing(record.secondary)) return "Needs Processing";
  if (state.exportComplete && !shouldSkipRecordForProcessing(record, folderInfo) && !isAlreadyProcessed(record)) {
    return "Process Complete";
  }
  if (shouldSkipRecordForProcessing(record, folderInfo)) return "Skipped";
  return folderInfo?.status || "Needs Processing";
}

function shouldSkipRecordForProcessing(record, folderInfo = getFolderInfoForRecord(record)) {
  if (!record.isSupported) return true;
  if (!folderInfo) return false;
  return state.skipAlreadyProcessed && (folderInfo.status === "Already Processed" || isAlreadyProcessed(record));
}

function isFolderRemovedFromZip(folderPath) {
  const path = normalizePath(folderPath);
  if (!path) return false;
  if (isParentFolderRemovedFromZip(path)) return true;
  if (isEmptyFolderRemovedFromZip(path)) {
    return true;
  }
  if (state.duplicateMode === "selected" && [...state.selectedDuplicateRemovals].some(folder => path === folder || path.startsWith(`${folder}/`))) {
    return true;
  }
  if (state.duplicateMode === "exact" && getSelectedDuplicateFolders().some(row => isDuplicateFolderAutoRemoved(row) && (path === row.folder.path || path.startsWith(`${row.folder.path}/`)))) {
    return true;
  }
  return false;
}

function isParentFolderRemovedFromZip(folderPath) {
  const parts = normalizePath(folderPath).split("/").filter(Boolean);
  if (parts.length < 2) return false;
  const parentPath = parts.slice(0, 2).join("/");
  if (state.parentDuplicateMode === "selected") {
    return getRemovedParentDuplicatePaths().has(parentPath);
  }
  if (state.parentDuplicateMode === "exact") {
    return getRemovedParentDuplicatePaths().has(parentPath);
  }
  return false;
}

function isEmptyFolderRemovedFromZip(folderPath) {
  const path = normalizePath(folderPath);
  return [...getRemovedEmptyFolderPaths()].some(folder => path === folder || path.startsWith(`${folder}/`));
}

function getRemovedEmptyFolderPaths() {
  if (state.emptyFolderMode === "selected") {
    return new Set([...state.selectedEmptyFolderRemovals].filter(path => isPathInSelectedParent(path)));
  }
  if (state.emptyFolderMode === "exact") {
    return new Set(getSelectedEmptyFolders().map(folder => folder.path));
  }
  return new Set();
}

function getRemovedDuplicateFilePaths() {
  const selectedDuplicateFiles = getSelectedDuplicateFiles();
  if (state.duplicateFileMode === "selected") {
    return new Set([...state.selectedDuplicateFileRemovals].filter(path => isPathInSelectedParent(path)));
  }
  if (state.duplicateFileMode === "exact") {
    return new Set(selectedDuplicateFiles.filter(row => !row.keepByDefault).map(row => row.item.path));
  }
  return new Set();
}

function isDuplicateFolderAutoRemoved(row) {
  return Boolean(row?.exactDuplicate && row.exactKeepByDefault === false);
}

function getRemovedParentDuplicatePaths() {
  if (state.parentDuplicateMode === "selected") {
    return new Set([...state.selectedParentDuplicateRemovals].filter(path => isPathInSelectedParent(path)));
  }
  if (state.parentDuplicateMode === "exact") {
    return new Set(getSelectedIdenticalParentFolders().filter(row => !row.keepByDefault).map(row => row.path));
  }
  return new Set();
}

function isPathExcludedFromZip(path) {
  const normalized = normalizePath(path);
  const folderPath = normalized.split("/").slice(0, -1).join("/");
  if (isFolderRemovedFromZip(folderPath)) return true;
  if (getRemovedDuplicateFilePaths().has(normalized)) return true;
  return false;
}

function isPathInSelectedParent(path) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.length >= 2 && state.selectedParents.has(parts[1]);
}

function getSelectedFolderAnalysis() {
  return [...state.folderAnalysis.values()].filter(folder => isPathInSelectedParent(folder.path));
}

function getSelectedSecondaryFolderAnalysis() {
  const selected = [];
  for (const parent of state.selectedParents) {
    const parentInfo = state.parentFolders.get(parent);
    if (!parentInfo) continue;
    for (const secondary of parentInfo.secondaryFolders) {
      const folder = state.folderAnalysis.get(pathJoin(state.mainFolderName, parent, secondary));
      if (folder) selected.push(folder);
    }
  }
  return selected;
}

function getSelectedEmptyFolders() {
  return state.emptyFolders.filter(folder => isPathInSelectedParent(folder.path));
}

function isEmptyFolderForReview(folder) {
  if (folder.level === "Parent Folder" || folder.level === "Secondary Folder") {
    return !hasNonSystemDescendantFiles(folder);
  }
  return false;
}

function hasNonSystemDescendantFiles(folder) {
  return folder.descendantFiles.some(item => !isSystemFile(item.path));
}

function getSelectedEmptyParentFolders() {
  return getSelectedEmptyFolders().filter(folder => folder.level === "Parent Folder");
}

function getSelectedEmptySecondaryFolders() {
  return getSelectedEmptyFolders().filter(folder => folder.level === "Secondary Folder");
}

function getSelectedDuplicateFolders() {
  return state.duplicateFolders.filter(row => isPathInSelectedParent(row.folder.path));
}

function getSelectedDuplicateFiles() {
  return state.duplicateFiles.filter(row => isPathInSelectedParent(row.item.path));
}

function getSelectedIdenticalParentFolders() {
  const groups = new Map();
  for (const row of state.identicalParentFolders) {
    if (!state.selectedParents.has(row.parent)) continue;
    if (!groups.has(row.groupNumber)) groups.set(row.groupNumber, []);
    groups.get(row.groupNumber).push(row);
  }
  return [...groups.values()].filter(group => group.length > 1).flat();
}

function getParentProcessingStatus(parentName) {
  const supportedRecords = state.fileRecords.filter(record => record.parent === parentName && record.isSupported);
  if (!supportedRecords.length) return "Skipped";
  const processedCount = supportedRecords.filter(isAlreadyProcessed).length;
  if (processedCount === supportedRecords.length) return "Already Processed";
  if (processedCount > 0) return "Partially Processed";
  return "Needs Processing";
}

function renderParentList() {
  els.parentList.innerHTML = "";

  if (!state.parentFolders.size) {
    els.parentList.innerHTML = '<div class="empty-state">No parent folders detected.</div>';
    return;
  }

  for (const parent of [...state.parentFolders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = `parent-${slug(parent.name)}`;
    const status = getParentProcessingStatus(parent.name);
    const label = document.createElement("label");
    label.className = `parent-item ${status === "Needs Processing" || status === "Partially Processed" ? "needs-processing" : ""}`;
    label.innerHTML = `
      <input type="checkbox" id="${id}" ${state.selectedParents.has(parent.name) ? "checked" : ""}>
      <span class="parent-name"></span>
      <span class="parent-meta">${parent.secondaryFolders.size} secondary folders, ${parent.fileCount} files</span>
      <span class="parent-status"></span>
    `;
    label.querySelector(".parent-name").textContent = parent.name;
    label.querySelector(".parent-status").textContent = status;
    label.querySelector("input").addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedParents.add(parent.name);
      } else {
        state.selectedParents.delete(parent.name);
      }
      invalidateZip();
    renderEmptyFolderList();
    renderDuplicateFolderList();
    renderDuplicateFileList();
    renderIdenticalParentList();
    updateControlStates();
    updatePreview();
    updateSummary();
      updateControls();
    });
    els.parentList.appendChild(label);
  }
}

function setAllParents(checked) {
  state.selectedParents = checked ? new Set(state.parentFolders.keys()) : new Set();
  invalidateZip();
  renderParentList();
  renderEmptyFolderList();
  renderDuplicateFolderList();
  renderDuplicateFileList();
  renderIdenticalParentList();
  updateControlStates();
  updatePreview();
  updateSummary();
  updateControls();
}

function renderEmptyFolderList() {
  const emptyFolders = getSelectedEmptyFolders();
  updateReviewSectionCounts();
  if (!state.folderAnalysis.size) {
    els.emptyFolderList.className = "analysis-list muted";
    els.emptyFolderList.textContent = "No folder loaded.";
    return;
  }

  if (!state.selectedParents.size) {
    els.emptyFolderList.className = "analysis-list muted";
    els.emptyFolderList.textContent = "Select a parent folder in Step 1 to analyze it.";
    return;
  }

  if (!emptyFolders.length) {
    els.emptyFolderList.className = "analysis-list muted";
    els.emptyFolderList.textContent = state.canDetectEmptyFolders
      ? "No empty parent or secondary folders found in selected parent folders."
      : "No empty folders were exposed by the browser folder picker. Drag and drop the main folder to detect truly empty folders more reliably.";
    return;
  }

  els.emptyFolderList.className = "analysis-list";
  els.emptyFolderList.innerHTML = "";
  for (const folder of emptyFolders.slice(0, 80)) {
    const item = document.createElement("label");
    const autoRemoved = state.emptyFolderMode === "exact";
    const checked = state.selectedEmptyFolderRemovals.has(folder.path);
    const markedRemoved = state.emptyFolderMode === "selected" && checked;
    item.className = `analysis-item duplicate-item ${autoRemoved ? "auto-removed" : ""} ${markedRemoved ? "marked-removed" : ""}`;
    const checkboxDisabled = state.emptyFolderMode !== "selected";
    item.innerHTML = `
      <input type="checkbox" ${markedRemoved ? "checked" : ""} ${checkboxDisabled ? "disabled" : ""}>
      <span class="remove-check" aria-hidden="true">✓</span>
      <span>
        <strong></strong>
        <span class="analysis-meta"></span>
      </span>
    `;
    setCopyableReviewName(item.querySelector("strong"), folder.name, folder.path);
    item.querySelector(".analysis-meta").textContent = `${folder.path} | ${folder.level} | ${autoRemoved || markedRemoved ? "Remove from ZIP" : "Keep in ZIP"}`;
    item.querySelector("input").addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedEmptyFolderRemovals.add(folder.path);
      } else {
        state.selectedEmptyFolderRemovals.delete(folder.path);
      }
      invalidateZip();
      renderEmptyFolderList();
      updatePreview();
      updateSummary();
      updateControls();
    });
    els.emptyFolderList.appendChild(item);
  }
}

function renderDuplicateFolderList() {
  const duplicateFolders = getSelectedDuplicateFolders();
  updateReviewSectionCounts();
  if (!state.folderAnalysis.size) {
    els.duplicateFolderList.className = "analysis-list muted";
    els.duplicateFolderList.textContent = "No folder loaded.";
    return;
  }

  if (!state.selectedParents.size) {
    els.duplicateFolderList.className = "analysis-list muted";
    els.duplicateFolderList.textContent = "Select a parent folder in Step 1 to analyze it.";
    return;
  }

  if (!duplicateFolders.length) {
    els.duplicateFolderList.className = "analysis-list muted";
    els.duplicateFolderList.textContent = "No duplicate folders found in selected parent folders.";
    return;
  }

  els.duplicateFolderList.className = "analysis-list";
  els.duplicateFolderList.innerHTML = "";
  for (const row of duplicateFolders.slice(0, 120)) {
    const item = document.createElement("label");
    const autoRemoved = state.duplicateMode === "exact" && isDuplicateFolderAutoRemoved(row);
    const checked = state.selectedDuplicateRemovals.has(row.folder.path);
    const markedRemoved = state.duplicateMode === "selected" && checked;
    item.className = `analysis-item duplicate-item ${autoRemoved ? "auto-removed" : ""} ${markedRemoved ? "marked-removed" : ""}`;
    const checkboxDisabled = state.duplicateMode !== "selected";
    item.innerHTML = `
      <input type="checkbox" ${markedRemoved ? "checked" : ""} ${checkboxDisabled ? "disabled" : ""}>
      <span class="remove-check" aria-hidden="true">✓</span>
      <span>
        <strong></strong>
        <span class="analysis-meta"></span>
      </span>
    `;
    setCopyableReviewName(item.querySelector("strong"), row.folder.name, row.folder.path);
    item.querySelector(".analysis-meta").textContent = `${row.folder.path} | ${row.folder.descendantFiles.length} files | ${row.match}`;
    item.querySelector("input").addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedDuplicateRemovals.add(row.folder.path);
      } else {
        state.selectedDuplicateRemovals.delete(row.folder.path);
      }
      invalidateZip();
      renderDuplicateFolderList();
      updatePreview();
      updateSummary();
      updateControls();
    });
    els.duplicateFolderList.appendChild(item);
  }
}

function renderDuplicateFileList() {
  const duplicateFiles = getSelectedDuplicateFiles();
  updateReviewSectionCounts();
  if (!state.folderAnalysis.size) {
    els.duplicateFileList.className = "analysis-list muted";
    els.duplicateFileList.textContent = "No folder loaded.";
    return;
  }

  if (!state.selectedParents.size) {
    els.duplicateFileList.className = "analysis-list muted";
    els.duplicateFileList.textContent = "Select a parent folder in Step 1 to analyze it.";
    return;
  }

  if (!duplicateFiles.length) {
    els.duplicateFileList.className = "analysis-list muted";
    els.duplicateFileList.textContent = "No duplicate files found in selected parent folders.";
    return;
  }

  els.duplicateFileList.className = "analysis-list";
  els.duplicateFileList.innerHTML = "";
  for (const row of duplicateFiles.slice(0, 160)) {
    const item = document.createElement("label");
    const autoRemoved = state.duplicateFileMode === "exact" && !row.keepByDefault;
    const checked = state.selectedDuplicateFileRemovals.has(row.item.path);
    const markedRemoved = state.duplicateFileMode === "selected" && checked;
    item.className = `analysis-item duplicate-item ${autoRemoved ? "auto-removed" : ""} ${markedRemoved ? "marked-removed" : ""}`;
    const checkboxDisabled = state.duplicateFileMode !== "selected";
    item.innerHTML = `
      <input type="checkbox" ${markedRemoved ? "checked" : ""} ${checkboxDisabled ? "disabled" : ""}>
      <span class="remove-check" aria-hidden="true">✓</span>
      <span>
        <strong></strong>
        <span class="analysis-meta"></span>
      </span>
    `;
    setCopyableReviewName(item.querySelector("strong"), row.item.path.split("/").pop(), row.item.path);
    item.querySelector(".analysis-meta").textContent = `${row.item.path} | ${formatBytes(row.item.file.size || 0)} | Group ${row.groupNumber}`;
    item.querySelector("input").addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedDuplicateFileRemovals.add(row.item.path);
      } else {
        state.selectedDuplicateFileRemovals.delete(row.item.path);
      }
      invalidateZip();
      renderDuplicateFileList();
      updatePreview();
      updateSummary();
      updateControls();
    });
    els.duplicateFileList.appendChild(item);
  }
}

function renderIdenticalParentList() {
  updateReviewSectionCounts();
  if (!state.folderAnalysis.size) {
    els.identicalParentList.className = "analysis-list muted";
    els.identicalParentList.textContent = "No folder loaded.";
    return;
  }

  const rows = getSelectedIdenticalParentFolders();
  if (!state.selectedParents.size) {
    els.identicalParentList.className = "analysis-list muted";
    els.identicalParentList.textContent = "Select a parent folder in Step 1 to analyze it.";
    return;
  }

  if (!rows.length) {
    els.identicalParentList.className = "analysis-list muted";
    els.identicalParentList.textContent = "No identical parent folders found in selected parent folders.";
    return;
  }

  els.identicalParentList.className = "analysis-list";
  els.identicalParentList.innerHTML = "";
  for (const row of rows.slice(0, 120)) {
    const autoRemoved = state.parentDuplicateMode === "exact" && !row.keepByDefault;
    const checked = state.selectedParentDuplicateRemovals.has(row.path);
    const item = document.createElement("label");
    const markedRemoved = state.parentDuplicateMode === "selected" && checked;
    item.className = `analysis-item duplicate-item ${autoRemoved ? "auto-removed" : ""} ${markedRemoved ? "marked-removed" : ""}`;
    const checkboxDisabled = state.parentDuplicateMode !== "selected";
    item.innerHTML = `
      <input type="checkbox" ${markedRemoved ? "checked" : ""} ${checkboxDisabled ? "disabled" : ""}>
      <span class="remove-check" aria-hidden="true">✓</span>
      <span>
        <strong></strong>
        <span class="analysis-meta"></span>
      </span>
    `;
    setCopyableReviewName(item.querySelector("strong"), row.parent, row.path);
    item.querySelector(".analysis-meta").textContent = `${row.secondaryCount} secondary folders | ${row.fileCount} files | Group ${row.groupNumber}`;
    item.querySelector("input").addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedParentDuplicateRemovals.add(row.path);
      } else {
        state.selectedParentDuplicateRemovals.delete(row.path);
      }
      invalidateZip();
      renderIdenticalParentList();
      updatePreview();
      updateSummary();
      updateControls();
    });
    els.identicalParentList.appendChild(item);
  }
}

function getLoadedScanCounts() {
  return {
    parentFolders: state.parentFolders.size,
    secondaryFolders: [...state.parentFolders.values()].reduce((sum, parent) => sum + parent.secondaryFolders.size, 0),
    files: state.allFiles.length
  };
}

function getSelectedScanCounts() {
  const selectedSecondaryFolders = getSelectedSecondaryFolderAnalysis();
  const selectedFiles = state.allFiles.filter(item => isPathInSelectedParent(item.path));
  return {
    parentFolders: state.selectedParents.size,
    secondaryFolders: selectedSecondaryFolders.length,
    files: selectedFiles.length,
    selectedSecondaryFolders,
    selectedFiles
  };
}

function updateSummary() {
  const selectedRecords = state.fileRecords.filter(record => state.selectedParents.has(record.parent));
  const removedDuplicateCount = state.duplicateMode === "selected"
    ? [...state.selectedDuplicateRemovals].filter(isPathInSelectedParent).length
    : state.duplicateMode === "exact"
      ? getSelectedDuplicateFolders().filter(isDuplicateFolderAutoRemoved).length
      : 0;
  const removedDuplicateFileCount = getRemovedDuplicateFilePaths().size;
  const removedParentDuplicateCount = getRemovedParentDuplicatePaths().size;
  const selectedCounts = getSelectedScanCounts();
  const selectedSecondaryFolders = selectedCounts.selectedSecondaryFolders;
  const selectedEmptyFolders = getSelectedEmptyFolders();
  const selectedEmptyParentFolders = getSelectedEmptyParentFolders();
  const selectedEmptySecondaryFolders = getSelectedEmptySecondaryFolders();
  const selectedDuplicateFolders = getSelectedDuplicateFolders();
  const selectedDuplicateFiles = getSelectedDuplicateFiles();
  const selectedDuplicateParents = getSelectedIdenticalParentFolders();
  const secondaryNeedsCount = selectedSecondaryFolders.filter(folder => secondaryFolderNeedsProcessing(folder.name)).length;
  const secondaryProcessedCount = selectedSecondaryFolders.filter(isSecondaryFolderAlreadyProcessed).length;
  const filesThatNeedRename = state.previewRows.filter(row => row.wouldRename || row.wouldNormalize);
  const needsCount = filesThatNeedRename.length;
  const processedCount = selectedRecords.filter(record => record.isSupported && isAlreadyProcessed(record)).length;
  const removedEmptyParentCount = selectedEmptyParentFolders.filter(folder => isFolderRemovedFromZip(folder.path)).length;
  const removedEmptySecondaryCount = selectedEmptySecondaryFolders.filter(folder => isFolderRemovedFromZip(folder.path)).length;
  const removedSecondaryNeedsCount = selectedSecondaryFolders.filter(folder => secondaryFolderNeedsProcessing(folder.name) && isFolderRemovedFromZip(folder.path)).length;
  const removedSecondaryProcessedCount = selectedSecondaryFolders.filter(folder => isSecondaryFolderAlreadyProcessed(folder) && isFolderRemovedFromZip(folder.path)).length;
  const removedDuplicateFilePaths = getRemovedDuplicateFilePaths();
  const removedFilesByFolder = filesThatNeedRename.filter(row => isFolderRemovedFromZip(pathJoin(row.main, row.parent, row.secondary)));
  const removedFilesByDuplicateFile = filesThatNeedRename.filter(row => removedDuplicateFilePaths.has(row.originalPath));
  const removedNeedsPaths = new Set([...removedFilesByFolder, ...removedFilesByDuplicateFile].map(row => row.originalPath));
  const removedNeedsCount = removedNeedsPaths.size;
  const removedNeedsByFolderCount = removedFilesByFolder.length;
  const removedNeedsByFileCount = removedFilesByDuplicateFile.length;
  const removedNeedsOverlapCount = removedFilesByFolder.filter(row => removedDuplicateFilePaths.has(row.originalPath)).length;
  const removedProcessedCount = selectedRecords.filter(record => record.isSupported && isAlreadyProcessed(record) && isPathExcludedFromZip(record.originalPath)).length;
  els.summaryParentFolders.textContent = selectedCounts.parentFolders;
  els.summaryDuplicateParents.textContent = formatSummaryCount(selectedDuplicateParents.length, removedParentDuplicateCount);
  els.summaryFolders.textContent = selectedCounts.secondaryFolders;
  els.summaryFilesScanned.textContent = selectedCounts.files;
  els.summaryEmptyParents.textContent = formatSummaryCount(selectedEmptyParentFolders.length, removedEmptyParentCount);
  els.summaryEmpty.textContent = formatSummaryCount(selectedEmptySecondaryFolders.length, removedEmptySecondaryCount);
  els.summaryDuplicateFolders.textContent = formatSummaryCount(selectedDuplicateFolders.length, removedDuplicateCount);
  els.summaryDuplicateFiles.textContent = formatSummaryCount(selectedDuplicateFiles.length, removedDuplicateFileCount);
  els.summarySecondaryNeeds.textContent = formatSummaryCount(secondaryNeedsCount, removedSecondaryNeedsCount);
  els.summarySecondaryProcessed.textContent = formatSummaryCount(secondaryProcessedCount, removedSecondaryProcessedCount);
  els.summaryNeeds.textContent = formatSummaryCount(needsCount, removedNeedsCount);
  els.summaryProcessed.textContent = formatSummaryCount(processedCount, removedProcessedCount);
  updateAlertStats({
    summaryDuplicateParents: selectedDuplicateParents.length,
    summaryEmptyParents: selectedEmptyParentFolders.length,
    summaryEmpty: selectedEmptySecondaryFolders.length,
    summaryDuplicateFolders: selectedDuplicateFolders.length,
    summaryDuplicateFiles: selectedDuplicateFiles.length,
    summarySecondaryNeeds: secondaryNeedsCount,
    summarySecondaryProcessed: secondaryProcessedCount,
    summaryNeeds: needsCount,
    summaryProcessed: processedCount
  });
  initializeBoxTooltips();
  setSummaryTooltip("summaryNeeds", `Files to rename: ${needsCount}. Unique files removed from ZIP: ${removedNeedsCount}. Folder removals affect ${removedNeedsByFolderCount}; duplicate-file removals affect ${removedNeedsByFileCount}; overlap: ${removedNeedsOverlapCount}.`);
}

function formatSummaryCount(total, removed = 0) {
  return removed > 0 ? `${total} (${removed} removed)` : String(total);
}

function setSummaryTooltip(id, text) {
  const card = document.getElementById(id)?.closest(".alert-stat, .scan-stat");
  if (card) card.title = text;
}

function updateAlertStats(values = {}) {
  document.querySelectorAll(".summary-grid .alert-stat").forEach(card => {
    const id = card.querySelector("strong")?.id || "";
    const value = values[id] ?? parseInt(card.querySelector("strong")?.textContent || "0", 10);
    card.classList.toggle("lit-stat", value > 0);
  });
}

function updateControlStates() {
  const hasLoadedSelection = state.folderAnalysis.size > 0 && state.selectedParents.size > 0;
  els.emptyFolderReview.classList.toggle("active-review", hasLoadedSelection && state.emptyFolderMode !== "keep" && getSelectedEmptyFolders().length > 0);
  els.duplicateFolderReview.classList.toggle("active-review", hasLoadedSelection && state.duplicateMode !== "keep" && getSelectedDuplicateFolders().length > 0);
  els.duplicateFileReview.classList.toggle("active-review", hasLoadedSelection && state.duplicateFileMode !== "keep" && getSelectedDuplicateFiles().length > 0);
  els.identicalParentReview.classList.toggle("active-review", hasLoadedSelection && state.parentDuplicateMode !== "keep" && getSelectedIdenticalParentFolders().length > 0);
}

function updateReviewSectionCounts() {
  const emptyFolders = getSelectedEmptyFolders();
  const duplicateFolders = getSelectedDuplicateFolders();
  const duplicateFiles = getSelectedDuplicateFiles();
  const identicalParents = getSelectedIdenticalParentFolders();
  setReviewTitle(els.emptyFolderTitle, "Empty Folders", `${emptyFolders.length} folders`);
  setReviewTitle(els.duplicateFolderTitle, "Duplicate Folders", `${duplicateFolders.length} folders`);
  setReviewTitle(els.duplicateFileTitle, "Duplicate Files", `${duplicateFiles.length} files`);
  setReviewTitle(els.identicalParentTitle, "Identical Parent Folders", `${identicalParents.length} folders`);
}

function updateServerEstimate() {
  if (!state.serverFolderMode || !state.allFiles.length) return;
  const selectedFiles = state.allFiles.filter(item => isPathInSelectedParent(item.path) && !isPathExcludedFromZip(item.path));
  const totalBytes = selectedFiles.reduce((sum, item) => sum + (item.file.size || 0), 0);
  els.zipInfo.textContent = `Server estimate: ${selectedFiles.length} files, ${formatBytes(totalBytes)}, about ${estimateServerDuration(selectedFiles.length, totalBytes)} to prepare and download.`;
}

function estimateServerDuration(fileCount, totalBytes) {
  const scanSeconds = Math.ceil(fileCount / 250);
  const transferSeconds = Math.ceil(totalBytes / (45 * 1024 * 1024));
  return formatDuration(Math.max(5, scanSeconds + transferSeconds));
}

function setReviewTitle(element, label, countText) {
  if (!element) return;
  element.textContent = `${label} (${countText})`;
}

function updatePreview() {
  const selectedRecords = getSelectedRecordsForPreview();
  const counters = new Map();
  const usedOutputPaths = new Set();
  state.previewRows = selectedRecords.map(record => {
    const exportSecondary = getExportSecondaryName(record.secondary);
    const key = `${record.parent}\u0000${exportSecondary}`;
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    const newExt = getExportExtension(record);
    const status = getRecordStatus(record);
    const isExcluded = isPathExcludedFromZip(record.originalPath);
    const canPlanRename = record.isSupported && !shouldSkipRecordForProcessing(record);
    const wouldRename = canPlanRename;
    const shouldRename = wouldRename && !isExcluded;
    const normalizedFileName = normalizeExportFileName(record.fileName, record);
    const baseFileName = canPlanRename ? `${exportSecondary}_${String(next).padStart(3, "0")}.${newExt}` : normalizedFileName;
    const basePath = pathJoin(record.main, record.parent, exportSecondary, baseFileName);
    const newPath = ensureUniquePath(basePath, usedOutputPaths);
    usedOutputPaths.add(newPath.toLowerCase());
    const wouldNormalize = record.isSupported && newPath !== record.originalPath;
    const shouldNormalize = wouldNormalize && !isExcluded;
    return { ...record, exportSecondary, newFileName: newPath.split("/").pop(), newPath, status, wouldRename, wouldNormalize, shouldRename, shouldNormalize };
  });
  initializeBoxTooltips();

  const processCount = state.previewRows.filter(row => row.shouldRename || row.shouldNormalize).length;
  els.previewCount.textContent = `${processCount} files`;
  els.totalFiles.textContent = processCount;
  els.remainingFiles.textContent = processCount;
  els.completedFiles.textContent = "0";
  els.filesPerSecond.textContent = "0.0";
  els.heicSpeed.textContent = "0.0";
  els.elapsedTime.textContent = "00:00";
  els.etaTime.textContent = "--:--";
  setProgress(0);
  updateSummary();
  updateServerEstimate();

  if (!state.previewRows.length) {
    els.previewBody.innerHTML = '<tr><td colspan="7" class="empty-state">No selected files to preview.</td></tr>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [index, row] of state.previewRows.slice(0, PREVIEW_RENDER_LIMIT).entries()) {
    const tr = document.createElement("tr");
    const parentRemoved = isParentFolderRemovedFromZip(pathJoin(row.main, row.parent));
    const secondaryRemoved = isFolderRemovedFromZip(pathJoin(row.main, row.parent, row.secondary));
    tr.append(
      cell(index + 1),
      flaggedCell(row.parent, parentRemoved),
      flaggedCell(row.secondary, secondaryRemoved),
      flaggedCell(row.exportSecondary, secondaryRemoved),
      copyNameCell(row.fileName),
      cell(row.newFileName),
      statusCell(row.status)
    );
    fragment.appendChild(tr);
  }

  els.previewBody.innerHTML = "";
  els.previewBody.appendChild(fragment);

  if (state.previewRows.length > PREVIEW_RENDER_LIMIT) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7" class="empty-state">Preview limited to the first ${PREVIEW_RENDER_LIMIT} rows for speed. ${state.previewRows.length} files are included in the review.</td>`;
    els.previewBody.appendChild(tr);
  }
}

function markPreviewComplete() {
  state.previewRows = state.previewRows.map(row => {
    if (row.status === "Needs Processing" && (row.shouldRename || row.shouldNormalize)) {
      return { ...row, status: "Process Complete" };
    }
    return row;
  });
  els.previewBody.querySelectorAll(".status-badge.needs-processing").forEach(badge => {
    badge.className = "status-badge process-complete";
    badge.textContent = "Process Complete";
  });
}

async function processFolder() {
  updateLibraryStatus();

  if (!window.JSZip) {
    addLog("JSZip is not available. Open the website with internet access or add the local JSZip vendor file.", "error");
    return;
  }

  const rowsToExportAsPlanned = state.previewRows.filter(row => row.shouldRename || row.shouldNormalize);
  if (!state.previewRows.length && !state.folderAnalysis.size) {
    addLog("Load a folder before creating a ZIP.", "warn");
    return;
  }

  const removedEmptyCount = getRemovedEmptyFolderPaths().size;
  const removedDuplicateCount = state.duplicateMode === "selected"
    ? [...state.selectedDuplicateRemovals].filter(isPathInSelectedParent).length
    : state.duplicateMode === "exact"
      ? getSelectedDuplicateFolders().filter(isDuplicateFolderAutoRemoved).length
      : 0;
  const removedDuplicateFileCount = getRemovedDuplicateFilePaths().size;
  const removedParentDuplicateCount = getRemovedParentDuplicatePaths().size;
  const confirmed = window.confirm(
    `Create ZIP preview?\n\nFiles to rename or normalize: ${rowsToExportAsPlanned.length}\nEmpty folders removed from ZIP: ${removedEmptyCount}\nDuplicate folders removed from ZIP: ${removedDuplicateCount}\nDuplicate files removed from ZIP: ${removedDuplicateFileCount}\nIdentical parent folders removed from ZIP: ${removedParentDuplicateCount}\n\nOriginal files and folders on your computer will not be changed.`
  );
  if (!confirmed) {
    addLog("Export canceled before ZIP creation.");
    return;
  }

  state.processing = true;
  state.failures = [];
  state.exportComplete = false;
  state.currentZipBlob = null;
  revokeZipObjectUrl();
  state.currentZipName = ensureZipFileName(`${state.mainFolderName || "SGA_File_Nexus_Export"}.zip`);
  state.currentOutputPath = "";
  state.metrics = {
    total: rowsToExportAsPlanned.length,
    completed: 0,
    heicCompleted: 0,
    startTime: performance.now()
  };

  els.renameButton.disabled = true;
  els.downloadButton.disabled = true;
  els.downloadButton.draggable = false;
  setStatus("Renaming files...");
  addLog("Renaming files and preparing ZIP...");
  updateMetrics();

  if (state.serverFolderMode) {
    await processServerScannedFolder(rowsToExportAsPlanned);
    state.processing = false;
    updateControls();
    return;
  }

  if (await processFolderOnServer(rowsToExportAsPlanned)) {
    state.processing = false;
    updateControls();
    return;
  }

  const zip = new JSZip();
  const renamedByOriginalPath = new Map(rowsToExportAsPlanned.map(row => [row.originalPath, row]));
  const usedZipPaths = new Set();

  addLog("Using browser ZIP creation.");
  try {
    addEmptyFoldersToZip(zip);
    for (let start = 0; start < state.allFiles.length; start += BATCH_SIZE) {
      const batch = state.allFiles.slice(start, start + BATCH_SIZE);
      await Promise.all(batch.map(item => addFileToZip(zip, item, renamedByOriginalPath, usedZipPaths)));
      updateMetrics();
      await yieldToBrowser();
    }

    setStatus("Creating ZIP...");
    addLog("Creating ZIP...");

    const generatedBlob = await zip.generateAsync(
      {
        type: "blob",
        compression: "STORE",
        streamFiles: true,
        platform: "UNIX"
      },
      metadata => {
        const zipPercent = Math.min(100, Math.round(metadata.percent || 0));
        els.zipInfo.textContent = `ZIP creation ${zipPercent}% complete`;
      }
    );
    state.currentZipBlob = new Blob([generatedBlob], { type: "application/zip" });
    state.exportComplete = true;

    setProgress(100);
    setStatus("Complete");
    updateMetrics(true);
    markPreviewComplete();
    updateSummary();
    els.downloadButton.disabled = false;
    els.downloadButton.draggable = true;
    els.zipInfo.textContent = `ZIP ready: ${formatBytes(state.currentZipBlob.size)}`;
    addLog(`Finished. ZIP ready with ${state.failures.length} failed file${state.failures.length === 1 ? "" : "s"}. Use Download ZIP to save it.`);
  } catch (error) {
    addLog(`ZIP creation failed: ${error.message}`, "error");
    setStatus("Finished");
  } finally {
    state.processing = false;
    updateControls();
  }
}

async function processFolderOnServer(rowsToExportAsPlanned) {
  if (!window.fetch || window.location.protocol === "file:") return false;

  const serverStatus = await getServerStatus();
  if (!serverStatus?.serverExport) return false;

  const heicRows = rowsToExportAsPlanned.filter(row => row.isHeic);
  if (heicRows.length) {
    addLog("Server export skipped because selected HEIC/HEIF files need browser conversion to JPG.", "warn");
    return false;
  }

  setStatus("Uploading to server...");
  addLog("Using local server ZIP creation...");
  els.zipInfo.textContent = "Uploading files to local server...";

  try {
    const manifest = buildServerExportManifest(rowsToExportAsPlanned);
    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));

    for (const item of state.allFiles) {
      if (isSystemFile(item.path) || isPathExcludedFromZip(item.path)) continue;
      formData.append(`file:${encodeURIComponent(item.path)}`, item.file, item.file.name);
    }

    const response = await fetch("/api/export-zip", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Server export failed with status ${response.status}.`);
    }

    const generatedBlob = await response.blob();
    state.currentZipBlob = new Blob([generatedBlob], { type: "application/zip" });
    state.exportComplete = true;
    setProgress(100);
    setStatus("Complete");
    state.metrics.completed = state.metrics.total;
    updateMetrics(true);
    markPreviewComplete();
    updateSummary();
    els.downloadButton.disabled = false;
    els.downloadButton.draggable = true;
    els.zipInfo.textContent = `ZIP ready from server: ${formatBytes(state.currentZipBlob.size)}`;
    addLog("Finished. ZIP was created by the local server. Use Download ZIP to save it.");
    return true;
  } catch (error) {
    addLog(`Server export unavailable: ${error.message}. Using browser ZIP creation instead.`, "warn");
    return false;
  }
}

async function processServerScannedFolder(rowsToExportAsPlanned) {
  const heicRows = rowsToExportAsPlanned.filter(row => row.isHeic);
  if (heicRows.length) {
    addLog("Server folder export cannot convert HEIC/HEIF yet. Use the normal folder picker for HEIC conversion, or convert those files before using server-folder mode.", "error");
    setStatus("Finished");
    return false;
  }

  setStatus("Server creating ZIP...");
  addLog("Server creating ZIP directly from disk...");
  els.zipInfo.textContent = "Server creating ZIP from disk...";

  try {
    const manifest = buildServerExportManifest(rowsToExportAsPlanned);
    manifest.scanId = state.serverScanId;
    const response = await fetch("/api/prepare-server-folder-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Server export failed with status ${response.status}.`);
    }

    state.currentZipBlob = null;
    state.currentZipUrl = data.downloadUrl;
    state.currentZipName = data.zipName || state.currentZipName;
    state.exportComplete = true;
    setProgress(100);
    setStatus("Complete");
    state.metrics.completed = state.metrics.total;
    updateMetrics(true);
    markPreviewComplete();
    updateSummary();
    els.downloadButton.disabled = false;
    els.downloadButton.draggable = true;
    els.zipInfo.textContent = "Server ZIP stream is ready. Use Download ZIP to save it.";
    addLog("Finished. Server disk export is ready. Download ZIP will stream it directly from the server.");
    return true;
  } catch (error) {
    addLog(`Server disk export failed: ${error.message}`, "error");
    setStatus("Finished");
    return false;
  }
}

async function getServerStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

function buildServerExportManifest(rowsToExportAsPlanned) {
  const renamedByOriginalPath = new Map(rowsToExportAsPlanned.map(row => [row.originalPath, row]));
  const usedZipPaths = new Set();
  const files = [];

  for (const item of state.allFiles) {
    if (isSystemFile(item.path) || isPathExcludedFromZip(item.path)) continue;
    const renameRow = renamedByOriginalPath.get(item.path);
    const outputPath = renameRow
      ? ensureUniquePath(renameRow.newPath, usedZipPaths)
      : ensureUniquePath(getNormalizedCopyPath(item.path), usedZipPaths);
    usedZipPaths.add(outputPath.toLowerCase());
    files.push({
      originalPath: item.path,
      outputPath,
      lastModified: item.file.lastModified || 0
    });
  }

  return {
    app: "SGA FILE NEXUS",
    zipName: state.currentZipName || "SGA_File_Nexus_Export.zip",
    emptyFolders: state.emptyFolders
      .filter(folder => !isFolderRemovedFromZip(folder.path))
      .map(folder => folder.path),
    files
  };
}

async function addFileToZip(zip, item, renamedByOriginalPath, usedZipPaths) {
  if (isSystemFile(item.path)) return;
  if (isPathExcludedFromZip(item.path)) return;

  const renameRow = renamedByOriginalPath.get(item.path);
  if (!renameRow) {
    const copyPath = ensureUniquePath(getNormalizedCopyPath(item.path), usedZipPaths);
    usedZipPaths.add(copyPath.toLowerCase());
    zip.file(copyPath, item.file, {
      binary: true,
      compression: "STORE",
      date: item.file.lastModified ? new Date(item.file.lastModified) : undefined
    });
    return;
  }

  try {
    let zipFile = renameRow.file;
    let status = "Renaming files...";

    if (renameRow.isHeic) {
      status = "Converting HEIC files...";
      setStatus(status);
      if (!window.heic2any) {
        throw new Error("HEIC converter is unavailable.");
      }
      const converted = await window.heic2any({
        blob: renameRow.file,
        toType: "image/jpeg",
        quality: 0.92
      });
      zipFile = Array.isArray(converted) ? converted[0] : converted;
      state.metrics.heicCompleted += 1;
    }

    const outputPath = ensureUniquePath(renameRow.newPath, usedZipPaths);
    usedZipPaths.add(outputPath.toLowerCase());
    zip.file(outputPath, zipFile, {
      binary: true,
      compression: "STORE",
      date: renameRow.file.lastModified ? new Date(renameRow.file.lastModified) : undefined
    });
  } catch (error) {
    state.failures.push({ path: item.path, message: error.message });
    addLog(`Failed: ${item.path} (${error.message})`, "error");
    const fallbackPath = ensureUniquePath(getNormalizedCopyPath(item.path), usedZipPaths);
    usedZipPaths.add(fallbackPath.toLowerCase());
    zip.file(fallbackPath, item.file, {
      binary: true,
      compression: "STORE",
      date: item.file.lastModified ? new Date(item.file.lastModified) : undefined
    });
  } finally {
    state.metrics.completed += 1;
    updateMetrics();
  }
}

function getSelectedSupportedRecords() {
  return state.fileRecords
    .filter(record => state.selectedParents.has(record.parent) && record.isSupported)
    .sort((a, b) => a.originalPath.localeCompare(b.originalPath, undefined, { numeric: true, sensitivity: "base" }));
}

function getSelectedRecordsForPreview() {
  return state.fileRecords
    .filter(record => state.selectedParents.has(record.parent))
    .sort((a, b) => a.originalPath.localeCompare(b.originalPath, undefined, { numeric: true, sensitivity: "base" }));
}

function addEmptyFoldersToZip(zip) {
  for (const folder of state.emptyFolders) {
    if (!isFolderRemovedFromZip(folder.path)) {
      zip.folder(folder.path);
    }
  }
}

async function downloadZip() {
  if (!state.currentZipBlob && !state.currentZipUrl) {
    addLog("No ZIP is ready yet. Click Export ZIP first.", "warn");
    return;
  }

  if (window.showSaveFilePicker && state.currentZipBlob) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: ensureZipFileName(state.currentZipName || "SGA_File_Nexus_Export.zip"),
        types: [{
          description: "ZIP archive",
          accept: { "application/zip": [".zip"] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(state.currentZipBlob);
      await writable.close();
      addLog("ZIP saved to the location you chose.");
      return;
    } catch (error) {
      if (error.name === "AbortError") {
        addLog("Save canceled. Trying normal browser download instead.", "warn");
      } else {
        addLog(`Save dialog failed: ${error.message}. Trying normal browser download instead.`, "warn");
      }
    }
  }

  try {
    const url = ensureZipObjectUrl();
    const link = document.createElement("a");
    link.href = url;
    link.download = ensureZipFileName(state.currentZipName || "SGA_File_Nexus_Export.zip");
    link.style.display = "none";
    document.body.appendChild(link);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    link.remove();
    addLog("Download started.");
  } catch (error) {
    addLog(`Download could not start: ${error.message}. Open the website in a regular browser and try again.`, "error");
    setStatus("Finished");
  }
}

async function downloadReport() {
  if (!state.folderAnalysis.size && !state.previewRows.length) {
    addLog("Load a folder before downloading a report.", "warn");
    return;
  }

  if (!window.JSZip) {
    addLog("JSZip is not available, so the workbook report cannot be created.", "error");
    return;
  }

  const blob = await buildReportWorkbook();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = ensureReportFileName(`${state.mainFolderName || "SGA_File_Nexus"}_Report.xlsx`);
  link.style.display = "none";
  document.body.appendChild(link);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  addLog("Workbook report download started.");
}

function buildReportSheets() {
  const selectedRecords = state.fileRecords.filter(record => state.selectedParents.has(record.parent));
  const selectedFolders = getSelectedFolderAnalysis();
  const selectedCounts = getSelectedScanCounts();
  const selectedSecondaryFolders = selectedCounts.selectedSecondaryFolders;
  const selectedEmptyFolders = getSelectedEmptyFolders();
  const selectedEmptyParentFolders = getSelectedEmptyParentFolders();
  const selectedEmptySecondaryFolders = getSelectedEmptySecondaryFolders();
  const selectedDuplicateFolders = getSelectedDuplicateFolders();
  const selectedDuplicateFiles = getSelectedDuplicateFiles();
  const selectedDuplicateParents = getSelectedIdenticalParentFolders();
  const filesToRename = state.previewRows.filter(row => row.wouldRename || row.wouldNormalize).length;
  const filesAlreadyProcessed = selectedRecords.filter(record => record.isSupported && isAlreadyProcessed(record)).length;
  const removedEmptyFolders = getRemovedEmptyFolderPaths();
  const removedDuplicateFolders = getRemovedDuplicateFolderPaths();
  const removedDuplicateFiles = getRemovedDuplicateFilePaths();
  const removedParentFolders = getRemovedParentDuplicatePaths();
  const previewByPath = new Map(state.previewRows.map(row => [row.originalPath, row]));
  const parentRows = [...state.parentFolders.values()]
    .filter(parent => state.selectedParents.has(parent.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
    .map(parent => [
      parent.name,
      parent.secondaryFolders.size,
      parent.fileCount,
      parent.supportedCount,
      parent.heicCount,
      getParentProcessingStatus(parent.name),
      describeParentChanges(parent)
    ]);
  const folderStatusRows = selectedFolders
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
    .map(folder => [
      folder.path,
      folder.name,
      folder.level,
      folder.directFiles.length,
      folder.descendantFiles.length,
      folder.supportedCount,
      folder.alreadyProcessedCount,
      folder.unsupportedCount,
      folder.status,
      isFolderRemovedFromZip(folder.path) ? "Remove from ZIP" : "Keep in ZIP",
      describeFolderChanges(folder)
    ]);
  const fileDetailRows = selectedRecords
    .sort((a, b) => a.originalPath.localeCompare(b.originalPath, undefined, { numeric: true, sensitivity: "base" }))
    .map(record => {
      const preview = previewByPath.get(record.originalPath);
      return [
        record.originalPath,
        record.parent,
        record.secondary,
        preview?.exportSecondary || getExportSecondaryName(record.secondary),
        record.fileName,
        record.extension,
        formatBytes(record.file.size || 0),
        record.isSupported ? "Yes" : "No",
        record.isHeic ? "Yes" : "No",
        isAlreadyProcessed(record) ? "Yes" : "No",
        preview?.newPath || "",
        preview?.newFileName || "",
        preview?.status || getRecordStatus(record),
        isPathExcludedFromZip(record.originalPath) ? "Remove from ZIP" : "Keep in ZIP",
        preview?.shouldRename ? "Yes" : "No",
        preview?.shouldNormalize ? "Yes" : "No",
        describeRecordChanges(record, preview)
      ];
    });
  const completeProcessRows = state.rawFiles
    .filter(item => isPathInSelectedParent(item.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
    .map(item => {
      const record = state.fileRecords.find(candidate => candidate.originalPath === item.path);
      const preview = previewByPath.get(item.path);
      const originalName = item.path.split("/").pop() || "";
      const copyPath = getNormalizedCopyPath(item.path);
      const exportAction = isSystemFile(item.path)
        ? "Ignored system file"
        : isPathExcludedFromZip(item.path)
          ? "Removed from ZIP"
          : "Included in ZIP";
      const namingAction = preview?.shouldRename
        ? "Renamed"
        : preview?.shouldNormalize
          ? "Extension/name normalized"
          : copyPath !== item.path
            ? "Folder/name normalized"
          : "Unnamed / copied unchanged";
      const reason = preview
        ? preview.status
        : record
          ? getRecordStatus(record)
          : isSystemFile(item.path)
            ? "System file ignored"
            : "No planned rename row";
      return [
        item.path,
        originalName,
        record?.parent || item.path.split("/").filter(Boolean)[1] || "",
        record?.secondary || item.path.split("/").filter(Boolean)[2] || "",
        preview?.exportSecondary || getExportSecondaryName(record?.secondary || item.path.split("/").filter(Boolean)[2] || ""),
        preview?.newPath || copyPath,
        preview?.newFileName || originalName,
        namingAction,
        exportAction,
        reason,
        formatBytes(item.file.size || 0),
        record?.extension || getExtension(originalName),
        record?.isSupported ? "Yes" : "No",
        record?.isHeic ? "Yes" : "No",
        record && isAlreadyProcessed(record) ? "Yes" : "No",
        describeProcessChanges(item, record, preview, namingAction, exportAction, reason)
      ];
    });
  const generatedAt = new Date().toISOString();
  const auditRows = [
    ["generated_at", "app", "source", "preset", "empty_definition", "age_filter_days", "selected_folder_path", "copyable_path", "parent_folder", "secondary_folder", "item_type", "original_name", "final_name", "last_modified", "status", "selected", "reason", "changes_made"]
  ];
  const addAuditRow = ({
    path = "",
    parent = "",
    secondary = "",
    itemType = "",
    originalName = "",
    finalName = "",
    lastModified = "Unknown",
    status = "",
    selected = "yes",
    reason = "",
    changes = ""
  }) => {
    auditRows.push([
      generatedAt,
      "SGA FILE NEXUS",
      "Browser folder upload",
      "SGA File Nexus export",
      "No files in secondary folder",
      "n/a",
      path,
      path,
      parent,
      secondary,
      itemType,
      originalName,
      finalName,
      lastModified,
      status,
      selected,
      reason,
      changes
    ]);
  };

  selectedEmptyFolders.forEach(folder => {
    const action = removedEmptyFolders.has(folder.path) ? "remove_from_zip" : "keep_in_zip";
    addAuditRow({
      path: folder.path,
      parent: getPathPart(folder.path, 1),
      secondary: getPathPart(folder.path, 2),
      itemType: "empty_secondary_folder",
      originalName: folder.name,
      finalName: folder.name,
      status: action,
      reason: folder.level,
      changes: describeEmptyFolderChanges(folder, removedEmptyFolders)
    });
  });

  selectedDuplicateFolders.forEach(row => {
    const action = removedDuplicateFolders.has(row.folder.path) ? "remove_from_zip" : "keep_in_zip";
    addAuditRow({
      path: row.folder.path,
      parent: getPathPart(row.folder.path, 1),
      secondary: getPathPart(row.folder.path, 2),
      itemType: "duplicate_folder",
      originalName: row.folder.name,
      finalName: row.folder.name,
      status: action,
      reason: row.match,
      changes: describeDuplicateFolderChanges(row, removedDuplicateFolders)
    });
  });

  selectedDuplicateFiles.forEach(row => {
    const fileName = getPathFileName(row.item.path);
    const action = removedDuplicateFiles.has(row.item.path) ? "remove_from_zip" : "keep_in_zip";
    addAuditRow({
      path: row.item.path,
      parent: getPathPart(row.item.path, 1),
      secondary: getPathPart(row.item.path, 2),
      itemType: "duplicate_file",
      originalName: fileName,
      finalName: fileName,
      lastModified: getFileModifiedAt(row.item.file),
      status: action,
      reason: `Group ${row.groupNumber}; ${formatBytes(row.item.file.size || 0)}`,
      changes: describeDuplicateFileChanges(row, removedDuplicateFiles)
    });
  });

  selectedDuplicateParents.forEach(row => {
    const action = removedParentFolders.has(row.path) ? "remove_from_zip" : "keep_in_zip";
    addAuditRow({
      path: row.path,
      parent: row.parent,
      itemType: "identical_parent_folder",
      originalName: row.parent,
      finalName: row.parent,
      status: action,
      reason: `Group ${row.groupNumber}; ${row.secondaryCount} secondary folders; ${row.fileCount} files`,
      changes: describeIdenticalParentChanges(row, removedParentFolders)
    });
  });

  state.rawFiles
    .filter(item => isPathInSelectedParent(item.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
    .forEach(item => {
      const record = state.fileRecords.find(candidate => candidate.originalPath === item.path);
      const preview = previewByPath.get(item.path);
      const originalName = getPathFileName(item.path);
      const finalName = preview?.newFileName || originalName;
      const finalPath = preview?.newPath || getNormalizedCopyPath(item.path);
      const exportAction = isSystemFile(item.path)
        ? "ignored_system_file"
        : isPathExcludedFromZip(item.path)
          ? "remove_from_zip"
          : "include_in_zip";
      const reason = preview
        ? preview.status
        : record
          ? getRecordStatus(record)
          : isSystemFile(item.path)
            ? "System file ignored"
            : "No planned rename row";
      const namingAction = preview?.shouldRename
        ? "renamed"
        : preview?.shouldNormalize
          ? "normalized"
          : "copied_unchanged";
      addAuditRow({
        path: item.path,
        parent: record?.parent || getPathPart(item.path, 1),
        secondary: preview?.exportSecondary || getExportSecondaryName(record?.secondary || getPathPart(item.path, 2)),
        itemType: "file",
        originalName,
        finalName,
        lastModified: getFileModifiedAt(item.file),
        status: exportAction,
        reason: `${reason}; ${namingAction}; final path: ${finalPath}`,
        changes: describeProcessChanges(item, record, preview, namingAction, exportAction === "remove_from_zip" ? "Removed from ZIP" : "Included in ZIP", reason)
      });
    });

  return [
    {
      name: "Audit Log",
      rows: auditRows
    },
    {
      name: "Summary",
      rows: [
        ["SGA FILE NEXUS REPORT", ""],
        ["Generated", new Date().toLocaleString()],
        ["Main folder", state.mainFolderName || "None loaded"],
        ["", ""],
        ["Parent folders scanned", selectedCounts.parentFolders],
        ["Secondary folders scanned", selectedCounts.secondaryFolders],
        ["Files scanned", selectedCounts.files],
        ["Duplicate parent folders found", selectedDuplicateParents.length],
        ["Empty parent folders found", selectedEmptyParentFolders.length],
        ["Empty secondary folders found", selectedEmptySecondaryFolders.length],
        ["Duplicate folders found", selectedDuplicateFolders.length],
        ["Duplicate files found", selectedDuplicateFiles.length],
        ["Files to rename or normalize", filesToRename],
        ["Files already processed", filesAlreadyProcessed],
        ["", ""],
        ["Already processed folders", state.skipAlreadyProcessed ? "Skip already processed folders" : "Include already processed folders"],
        ["Empty folders", describeMode(state.emptyFolderMode, "empty folders")],
        ["Duplicate folders", describeMode(state.duplicateMode, "duplicate folders")],
        ["Duplicate files", describeMode(state.duplicateFileMode, "duplicate files")],
        ["Identical parent folders", describeMode(state.parentDuplicateMode, "identical parent folders")],
        ["", ""],
        ["Safety note", "Original files and folders on the computer were not changed. Removals only apply to the generated ZIP/export."]
      ]
    },
    {
      name: "Selected Parents",
      rows: [["Parent Folder", "Secondary Folder Count", "File Count", "Supported File Count", "HEIC/HEIF Count", "Processing Status", "Changes Made"], ...parentRows]
    },
    {
      name: "Folder Status",
      rows: [["Folder Path", "Folder Name", "Folder Level", "Direct File Count", "Descendant File Count", "Supported Count", "Already Processed Count", "Unsupported Count", "Status", "Export Action", "Changes Made"], ...folderStatusRows]
    },
    {
      name: "Empty Folders",
      rows: [["Folder Path", "Folder Level", "Export Action", "Changes Made"], ...selectedEmptyFolders.map(folder => [
        folder.path,
        folder.level,
        removedEmptyFolders.has(folder.path) ? "Remove from ZIP" : "Keep in ZIP",
        describeEmptyFolderChanges(folder, removedEmptyFolders)
      ])]
    },
    {
      name: "Duplicate Folders",
      rows: [["Folder Path", "File Count", "Match Type", "Export Action", "Changes Made"], ...selectedDuplicateFolders.map(row => [
        row.folder.path,
        row.folder.descendantFiles.length,
        row.match,
        removedDuplicateFolders.has(row.folder.path) ? "Remove from ZIP" : "Keep in ZIP",
        describeDuplicateFolderChanges(row, removedDuplicateFolders)
      ])]
    },
    {
      name: "Duplicate Files",
      rows: [["File Path", "File Size", "Duplicate Group", "Export Action", "Changes Made"], ...selectedDuplicateFiles.map(row => [
        row.item.path,
        formatBytes(row.item.file.size || 0),
        `Group ${row.groupNumber}`,
        removedDuplicateFiles.has(row.item.path) ? "Remove from ZIP" : "Keep in ZIP",
        describeDuplicateFileChanges(row, removedDuplicateFiles)
      ])]
    },
    {
      name: "Parent Folders",
      rows: [["Parent Folder Path", "Secondary Folder Count", "File Count", "Duplicate Group", "Export Action", "Changes Made"], ...selectedDuplicateParents.map(row => [
        row.path,
        row.secondaryCount,
        row.fileCount,
        `Group ${row.groupNumber}`,
        removedParentFolders.has(row.path) ? "Remove from ZIP" : "Keep in ZIP",
        describeIdenticalParentChanges(row, removedParentFolders)
      ])]
    },
    {
      name: "File Details",
      rows: [["Original Path", "Parent Folder", "Original Secondary Folder", "Export Secondary Folder", "Original File Name", "Extension", "File Size", "Supported", "HEIC/HEIF", "Already Processed", "Planned Export Path", "Planned File Name", "Preview Status", "Export Action", "Will Rename", "Will Normalize", "Changes Made"], ...fileDetailRows]
    },
    {
      name: "Complete Process",
      rows: [["Original Path", "Original File Name", "Parent Folder", "Original Secondary Folder", "Export Secondary Folder", "Final Export Path", "Final File Name", "Naming Action", "ZIP Action", "Reason/Status", "File Size", "Extension", "Supported", "HEIC/HEIF", "Already Processed", "Changes Made"], ...completeProcessRows]
    },
    {
      name: "Planned Renames",
      rows: [["Parent Folder", "Original Secondary Folder", "New Secondary Folder", "Original Path", "Original File Name", "New Export Path", "New File Name", "Status", "Will Rename", "Will Normalize", "Changes Made"], ...state.previewRows.map(row => [
        row.parent,
        row.secondary,
        row.exportSecondary,
        row.originalPath,
        row.fileName,
        row.newPath,
        row.newFileName,
        row.status,
        row.shouldRename ? "Yes" : "No",
        row.shouldNormalize ? "Yes" : "No",
        describePreviewRowChanges(row)
      ])]
    },
    {
      name: "Export Failures",
      rows: [["File Path", "Failure Message"], ...state.failures.map(failure => [
        failure.path,
        failure.message
      ])]
    }
  ];
}

function getRemovedDuplicateFolderPaths() {
  if (state.duplicateMode === "selected") {
    return new Set([...state.selectedDuplicateRemovals].filter(isPathInSelectedParent));
  }
  if (state.duplicateMode === "exact") {
    return new Set(getSelectedDuplicateFolders().filter(isDuplicateFolderAutoRemoved).map(row => row.folder.path));
  }
  return new Set();
}

function describeMode(mode, label) {
  if (mode === "selected") return `Remove selected ${label} from ZIP`;
  if (mode === "exact") return `Auto-remove ${label} from ZIP`;
  return `Keep all ${label}`;
}

function getPathPart(path, index) {
  return normalizePath(path).split("/").filter(Boolean)[index] || "";
}

function getPathFileName(path) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function getFileModifiedAt(file) {
  return file?.lastModified ? new Date(file.lastModified).toISOString() : "Unknown";
}

function describeParentChanges(parent) {
  const status = getParentProcessingStatus(parent.name);
  if (getRemovedParentDuplicatePaths().has(pathJoin(state.mainFolderName, parent.name))) {
    return "Identical parent folder removed from the generated ZIP. Original folder was not changed.";
  }
  if (status === "Already Processed") return "Parent folder already followed the naming format; files were skipped unless settings changed.";
  if (status === "Partially Processed") return "Parent folder had a mix of already processed files and files needing rename.";
  if (status === "Skipped") return "Parent folder had no supported files to rename; contents are copied unchanged if included.";
  return "Parent folder selected for processing; eligible files are renamed in the generated ZIP.";
}

function describeFolderChanges(folder) {
  if (isFolderRemovedFromZip(folder.path)) return "Folder removed from the generated ZIP only. Original folder was not changed.";
  if ((folder.level === "Parent Folder" || folder.level === "Secondary Folder") && !hasNonSystemDescendantFiles(folder)) return `Empty ${folder.level.toLowerCase()} kept in the generated ZIP.`;
  if (folder.status === "Already Processed") return "Folder already followed the naming format; files are skipped unless settings change.";
  if (folder.status === "Partially Processed") return "Some files already matched the naming format; remaining eligible files are planned for rename.";
  if (!folder.supportedCount && folder.descendantFiles.length) return "Folder has no supported rename targets; files are copied unchanged if included.";
  return "Folder kept in the generated ZIP; eligible files inside are processed according to preview.";
}

function describeEmptyFolderChanges(folder, removedEmptyFolders) {
  const label = folder.level.toLowerCase();
  if (removedEmptyFolders.has(folder.path)) return `Empty ${label} removed from generated ZIP only.`;
  return `Empty ${label} kept in generated ZIP.`;
}

function describeDuplicateFolderChanges(row, removedDuplicateFolders) {
  if (removedDuplicateFolders.has(row.folder.path)) return `${row.match}; folder removed from generated ZIP only.`;
  if (state.duplicateMode === "exact" && isDuplicateFolderAutoRemoved(row)) return "Exact duplicate detected and auto-selected for removal from the generated ZIP.";
  return `${row.match}; folder kept in generated ZIP.`;
}

function describeDuplicateFileChanges(row, removedDuplicateFiles) {
  if (removedDuplicateFiles.has(row.item.path)) return `Exact duplicate file in Group ${row.groupNumber}; removed from generated ZIP only.`;
  return `Exact duplicate file in Group ${row.groupNumber}; kept in generated ZIP.`;
}

function describeIdenticalParentChanges(row, removedParentFolders) {
  if (removedParentFolders.has(row.path)) return `Identical parent folder in Group ${row.groupNumber}; removed from generated ZIP only.`;
  return `Identical parent folder in Group ${row.groupNumber}; kept in generated ZIP.`;
}

function describeRecordChanges(record, preview) {
  if (isPathExcludedFromZip(record.originalPath)) return "File removed from generated ZIP only.";
  if (!record.isSupported) return "Unsupported for renaming; copied unchanged into generated ZIP.";
  if (preview?.shouldRename) {
    const folderChange = preview.exportSecondary && preview.exportSecondary !== record.secondary
      ? ` Secondary folder changed from ${record.secondary} to ${preview.exportSecondary}.`
      : "";
    return `Renamed from ${record.fileName} to ${preview.newFileName}.${folderChange}`;
  }
  if (preview?.shouldNormalize) {
    const folderChange = preview.exportSecondary && preview.exportSecondary !== record.secondary
      ? ` Secondary folder changed from ${record.secondary} to ${preview.exportSecondary}.`
      : "";
    return `Name, extension, or folder normalized from ${record.fileName} to ${preview.newFileName}.${folderChange}`;
  }
  if (isAlreadyProcessed(record)) return "Already processed; skipped by current settings.";
  if (preview?.status === "Skipped") return "Skipped by current settings and copied unchanged if included.";
  return "No rename performed; copied unchanged if included.";
}

function describeProcessChanges(item, record, preview, namingAction, exportAction, reason) {
  if (isSystemFile(item.path)) return "Ignored system file; not added to generated ZIP.";
  if (exportAction === "Removed from ZIP") return "Removed from generated ZIP only. Original file was not changed.";
  if (!record) return `No secondary-folder rename record found; ${namingAction.toLowerCase()}.`;
  if (preview?.shouldRename) {
    const folderChange = preview.exportSecondary && preview.exportSecondary !== record.secondary
      ? ` Secondary folder changed from ${record.secondary} to ${preview.exportSecondary}.`
      : "";
    return `Renamed from ${record.fileName} to ${preview.newFileName} in the generated ZIP.${folderChange}`;
  }
  if (preview?.shouldNormalize) {
    const folderChange = preview.exportSecondary && preview.exportSecondary !== record.secondary
      ? ` Secondary folder changed from ${record.secondary} to ${preview.exportSecondary}.`
      : "";
    return `Normalized from ${record.fileName} to ${preview.newFileName} in the generated ZIP.${folderChange}`;
  }
  if (!record.isSupported) return "Unsupported for renaming; copied unchanged into generated ZIP.";
  if (isAlreadyProcessed(record)) return "Already processed; skipped and kept/copied according to settings.";
  if (reason === "Skipped") return "Skipped by current settings; copied unchanged if included.";
  return "No new name assigned; file was copied unchanged if included.";
}

function describePreviewRowChanges(row) {
  if (row.status === "Will Be Removed") return "Will be removed from the generated ZIP only. Original file is not changed.";
  if (row.status === "Skipped") return "Skipped by current settings.";
  if (row.shouldRename) {
    const folderChange = row.exportSecondary && row.exportSecondary !== row.secondary
      ? ` Secondary folder changed from ${row.secondary} to ${row.exportSecondary}.`
      : "";
    return `Renamed from ${row.fileName} to ${row.newFileName}.${folderChange}`;
  }
  if (row.shouldNormalize) {
    const folderChange = row.exportSecondary && row.exportSecondary !== row.secondary
      ? ` Secondary folder changed from ${row.secondary} to ${row.exportSecondary}.`
      : "";
    return `Normalized from ${row.fileName} to ${row.newFileName}.${folderChange}`;
  }
  if (row.status === "Already Processed") return "Already processed; no rename needed.";
  if (row.status === "Process Complete") return `Processing completed using final file name ${row.newFileName}.`;
  return "No change made.";
}

async function buildReportWorkbook() {
  const sheets = buildReportSheets();
  const zip = new JSZip();
  zip.file("[Content_Types].xml", workbookContentTypes(sheets.length));
  zip.folder("_rels").file(".rels", workbookRootRels());
  const xl = zip.folder("xl");
  xl.file("workbook.xml", workbookXml(sheets));
  xl.file("styles.xml", workbookStylesXml());
  xl.folder("_rels").file("workbook.xml.rels", workbookRels(sheets.length));
  const worksheets = xl.folder("worksheets");
  sheets.forEach((sheet, index) => {
    worksheets.file(`sheet${index + 1}.xml`, worksheetXml(sheet.rows));
  });
  const workbookBlob = await zip.generateAsync({
    type: "blob",
    compression: "STORE"
  });
  return new Blob([workbookBlob], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function workbookContentTypes(sheetCount) {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`;
}

function workbookRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function workbookXml(sheets) {
  const sheetXml = sheets.map((sheet, index) => `<sheet name="${xmlEscape(safeSheetName(sheet.name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml}</sheets></workbook>`;
}

function workbookRels(sheetCount) {
  const sheetRels = Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function workbookStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;
}

function worksheetXml(rows) {
  const xmlRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => cellXml(value, columnName(columnIndex), rowIndex + 1)).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`;
}

function cellXml(value, column, row) {
  return `<c r="${column}${row}" t="inlineStr"><is><t>${xmlEscape(String(value ?? ""))}</t></is></c>`;
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function safeSheetName(name) {
  return String(name).replace(/[\[\]*?:/\\]/g, " ").slice(0, 31) || "Sheet";
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, character => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  })[character]);
}

function updateControls() {
  const hasParents = state.parentFolders.size > 0;
  els.selectAllButton.disabled = !hasParents || state.processing;
  els.deselectAllButton.disabled = !hasParents || state.processing;
  els.serverScanButton.disabled = state.processing;
  els.renameButton.disabled = state.processing || (!state.previewRows.length && !state.folderAnalysis.size);
  els.downloadButton.disabled = state.processing || (!state.currentZipBlob && !state.currentZipUrl);
  els.reportButton.disabled = state.processing || (!state.previewRows.length && !state.folderAnalysis.size);
  els.downloadButton.draggable = !els.downloadButton.disabled;
  els.renameButton.textContent = "Export ZIP";
  els.downloadButton.textContent = "Download ZIP";
  els.reportButton.textContent = "Download Report";
}

function updateMetrics(done = false) {
  const elapsedSeconds = Math.max(0.001, (performance.now() - state.metrics.startTime) / 1000);
  const completed = state.metrics.completed;
  const remaining = Math.max(0, state.metrics.total - completed);
  const perSecond = completed / elapsedSeconds;
  const heicPerSecond = state.metrics.heicCompleted / elapsedSeconds;
  const etaSeconds = perSecond > 0 ? remaining / perSecond : 0;

  els.totalFiles.textContent = state.metrics.total;
  els.completedFiles.textContent = completed;
  els.remainingFiles.textContent = remaining;
  els.elapsedTime.textContent = formatDuration(elapsedSeconds);
  els.etaTime.textContent = done ? "00:00" : (completed ? formatDuration(etaSeconds) : "--:--");
  els.filesPerSecond.textContent = perSecond.toFixed(1);
  els.heicSpeed.textContent = heicPerSecond.toFixed(1);
  setProgress(state.metrics.total ? (completed / state.metrics.total) * 100 : 0);
}

function setProgress(percent) {
  const safe = Math.max(0, Math.min(100, percent));
  els.progressBar.style.width = `${safe}%`;
  els.percentText.textContent = `${Math.round(safe)}%`;
}

function setStatus(message) {
  els.statusText.textContent = message;
  els.statusText.classList.toggle("complete", message === "Complete");
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
  els.serverFolderPathInput.value = "";
  clearWorkingState();
  resetUi();
  addLog("Cleared current folder.");
}

function clearWorkingState() {
  state.mainFolderName = "";
  state.rawFiles = [];
  state.allFiles = [];
  state.folderPaths = new Set();
  state.canDetectEmptyFolders = false;
  state.fileRecords = [];
  state.parentFolders = new Map();
  state.folderAnalysis = new Map();
  state.emptyFolders = [];
  state.duplicateFolders = [];
  state.duplicateFiles = [];
  state.identicalParentFolders = [];
  state.fileHashGroups = new Map();
  state.selectedEmptyFolderRemovals = new Set();
  state.selectedDuplicateRemovals = new Set();
  state.selectedDuplicateFileRemovals = new Set();
  state.selectedParentDuplicateRemovals = new Set();
  state.selectedParents = new Set();
  state.previewRows = [];
  state.failures = [];
  state.currentZipBlob = null;
  revokeZipObjectUrl();
  state.currentZipName = "";
  state.currentOutputPath = "";
  state.serverScanId = "";
  state.serverFolderMode = false;
  state.processing = false;
}

function resetUi() {
  els.parentList.innerHTML = "";
  els.folderSummary.textContent = "No folder loaded.";
  els.previewBody.innerHTML = '<tr><td colspan="7" class="empty-state">Load a folder to preview renames.</td></tr>';
  els.previewCount.textContent = "0 files";
  els.summaryParentFolders.textContent = "0";
  els.summaryDuplicateParents.textContent = "0";
  els.summaryFolders.textContent = "0";
  els.summaryFilesScanned.textContent = "0";
  els.summaryEmptyParents.textContent = "0";
  els.summaryEmpty.textContent = "0";
  els.summaryDuplicateFolders.textContent = "0";
  els.summaryDuplicateFiles.textContent = "0";
  els.summarySecondaryNeeds.textContent = "0";
  els.summarySecondaryProcessed.textContent = "0";
  els.summaryNeeds.textContent = "0";
  els.summaryProcessed.textContent = "0";
  updateAlertStats();
  els.emptyFolderList.className = "analysis-list muted";
  els.emptyFolderList.textContent = "No folder loaded.";
  els.duplicateFolderList.className = "analysis-list muted";
  els.duplicateFolderList.textContent = "No folder loaded.";
  els.duplicateFileList.className = "analysis-list muted";
  els.duplicateFileList.textContent = "No folder loaded.";
  els.identicalParentList.className = "analysis-list muted";
  els.identicalParentList.textContent = "No folder loaded.";
  updateReviewSectionCounts();
  els.zipInfo.textContent = "ZIP will be available after processing.";
  setStatus("Waiting for a folder.");
  setProgress(0);
  els.totalFiles.textContent = "0";
  els.completedFiles.textContent = "0";
  els.remainingFiles.textContent = "0";
  els.elapsedTime.textContent = "00:00";
  els.etaTime.textContent = "--:--";
  els.filesPerSecond.textContent = "0.0";
  els.heicSpeed.textContent = "0.0";
  els.downloadButton.disabled = true;
  els.reportButton.disabled = true;
  els.downloadButton.draggable = false;
  els.renameButton.textContent = "Export ZIP";
  els.downloadButton.textContent = "Download ZIP";
  els.reportButton.textContent = "Download Report";
  updateControlStates();
  updateControls();
}

function ensureZipObjectUrl() {
  if (!state.currentZipUrl && state.currentZipBlob) {
    state.currentZipUrl = URL.createObjectURL(state.currentZipBlob);
  }
  return state.currentZipUrl;
}

function revokeZipObjectUrl() {
  if (state.currentZipUrl) {
    if (state.currentZipUrl.startsWith("blob:")) URL.revokeObjectURL(state.currentZipUrl);
    state.currentZipUrl = "";
  }
}

async function filesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
    .filter(Boolean);

  if (entries.length) {
    const files = [];
    const folderPaths = new Set();
    for (const entry of entries) {
      await readEntry(entry, "", files, folderPaths);
    }
    return { files, folderPaths: [...folderPaths] };
  }

  return { files: Array.from(dataTransfer.files || []), folderPaths: [] };
}

function readEntry(entry, prefix, files, folderPaths) {
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
      folderPaths.add(normalizePath(directoryPrefix));
      const readBatch = () => {
        reader.readEntries(async entries => {
          if (!entries.length) {
            resolve();
            return;
          }
          for (const child of entries) {
            await readEntry(child, directoryPrefix, files, folderPaths);
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

function commonMainFolder(paths) {
  const first = paths[0]?.split("/").filter(Boolean)[0];
  return first || "";
}

function isSystemFile(path) {
  const name = path.split("/").pop().toLowerCase();
  return SYSTEM_FILE_NAMES.has(name) || name.startsWith("._");
}

function getExtension(fileName) {
  const last = fileName.split(".").pop();
  return last && last !== fileName ? last.toLowerCase() : "";
}

function getOriginalExtension(fileName) {
  const last = fileName.split(".").pop();
  return last && last !== fileName ? last : "";
}

function getExportExtension(record) {
  if (JPG_EXTENSIONS.has(record.extension)) return "jpg";
  return record.extension.toLowerCase();
}

function getExportSecondaryName(folderName) {
  const normalized = normalizeDateFolderName(folderName);
  return normalized || folderName;
}

function normalizeDateFolderName(folderName) {
  const value = String(folderName || "").trim();
  const match = value.match(/^(\d{1,4})[\s._-]+(\d{1,2})[\s._-]+(\d{1,4})$/);
  if (!match) return "";

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  const firstLength = match[1].length;
  const thirdLength = match[3].length;
  let year = 0;
  let month = 0;
  let day = 0;

  if (firstLength === 4) {
    year = first;
    month = second;
    day = third;
  } else if (thirdLength === 4) {
    year = third;
    month = first;
    day = second;
  } else if (first > 12) {
    year = expandTwoDigitYear(first);
    month = second;
    day = third;
  } else if (third > 12) {
    year = expandTwoDigitYear(third);
    month = first;
    day = second;
  } else {
    return "";
  }

  if (!isValidFolderDate(year, month, day)) return "";
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

function expandTwoDigitYear(value) {
  return value >= 70 ? 1900 + value : 2000 + value;
}

function isValidFolderDate(year, month, day) {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function normalizeExportFileName(fileName, record) {
  const exportExtension = getExportExtension(record);
  if (!exportExtension) return fileName;
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}.${exportExtension}`;
}

function getNormalizedCopyPath(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  const fileName = parts.pop();
  if (parts.length >= 3) {
    parts[2] = getExportSecondaryName(parts[2]);
  }
  const extension = getExtension(fileName);
  if (!SUPPORTED_EXTENSIONS.has(extension)) return pathJoin(...parts, fileName);
  if (HEIC_EXTENSIONS.has(extension)) {
    const dotIndex = fileName.lastIndexOf(".");
    const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
    return pathJoin(...parts, `${baseName}.${extension}`);
  }
  const recordLike = { extension };
  const normalizedFileName = normalizeExportFileName(fileName, recordLike);
  return pathJoin(...parts, normalizedFileName);
}

function ensureZipFileName(fileName) {
  const safeName = String(fileName || "SGA_File_Nexus_Export.zip").trim() || "SGA_File_Nexus_Export.zip";
  return safeName.toLowerCase().endsWith(".zip") ? safeName : `${safeName.replace(/\.[^/.]+$/, "")}.zip`;
}

function ensureReportFileName(fileName) {
  const safeName = String(fileName || "SGA_File_Nexus_Report.xlsx").trim() || "SGA_File_Nexus_Report.xlsx";
  return safeName.toLowerCase().endsWith(".xlsx") ? safeName : `${safeName.replace(/\.[^/.]+$/, "")}.xlsx`;
}

function ensureUniquePath(path, usedPaths) {
  const normalized = normalizePath(path);
  if (!usedPaths.has(normalized.toLowerCase())) return normalized;

  const parts = normalized.split("/");
  const fileName = parts.pop();
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
  let index = 2;
  let candidate = "";
  do {
    candidate = pathJoin(...parts, `${baseName}_duplicate-${index}${extension}`);
    index += 1;
  } while (usedPaths.has(candidate.toLowerCase()));
  return candidate;
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function addParentPaths(filePath, folders) {
  const parts = normalizePath(filePath).split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    folders.add(parts.slice(0, index).join("/"));
  }
}

function getFolderLevel(parts) {
  if (parts.length <= 1) return "Main Folder";
  if (parts.length === 2) return "Parent Folder";
  if (parts.length === 3) return "Secondary Folder";
  return "Nested Folder";
}

async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function pathJoin(...parts) {
  return parts.map(part => String(part).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function slug(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "-");
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function flaggedCell(text, isRemoved) {
  const td = cell(text);
  if (isRemoved) {
    td.className = "removed-folder-cell";
    td.title = "This folder is marked to be removed from the generated ZIP.";
  }
  return td;
}

function copyNameCell(fileName) {
  const td = document.createElement("td");
  const wrapper = document.createElement("div");
  const name = document.createElement("span");
  const button = document.createElement("button");
  wrapper.className = "copy-name-cell";
  name.textContent = fileName;
  button.className = "copy-name-button";
  button.type = "button";
  button.textContent = "Copy";
  button.title = "Copy the original file name.";
  button.addEventListener("click", async event => {
    event.stopPropagation();
    await copyTextToClipboard(fileName);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  });
  wrapper.append(name, button);
  td.appendChild(wrapper);
  return td;
}

function setCopyableReviewName(strong, label, copyValue) {
  strong.textContent = "";
  const text = document.createElement("span");
  const button = document.createElement("button");
  text.textContent = label;
  button.className = "copy-name-button";
  button.type = "button";
  button.textContent = "Copy";
  button.title = "Copy this review item name/path.";
  button.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    await copyTextToClipboard(copyValue);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  });
  strong.append(button, " ", text);
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    addLog(`Copied original file name: ${text}`);
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    addLog(`Copied original file name: ${text}`);
  }
}

function statusCell(status) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = `status-badge ${slug(status).toLowerCase()}`;
  span.textContent = status;
  td.appendChild(span);
  return td;
}

function invalidateZip() {
  state.currentZipBlob = null;
  revokeZipObjectUrl();
  state.exportComplete = false;
  state.currentOutputPath = "";
  els.downloadButton.disabled = true;
  els.reportButton.disabled = !state.folderAnalysis.size && !state.previewRows.length;
  els.downloadButton.draggable = false;
  els.zipInfo.textContent = "ZIP will be available after processing.";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
