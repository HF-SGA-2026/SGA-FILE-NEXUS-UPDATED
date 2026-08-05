const crypto = require("crypto");

const ISSUE_CATEGORIES = [
  "Missing mechanical drawings",
  "Missing electrical drawings",
  "No file found on server",
  "Incomplete consultant set",
  "No equipment schedule",
  "Square footage not shown",
  "Consultant not identified",
  "Equipment values incomplete",
  "Ductwork not measurable",
  "Conflicting values",
  "Unusual or custom system",
  "Project intentionally excluded from analysis",
  "Staff note requiring follow-up",
  "Imported spreadsheet note",
  "Other"
];

function meaningful(value) {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    value !== "Unknown"
  );
}

function numericValue(...values) {
  for (const value of values) {
    const number = Number(value);

    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }

  return null;
}

function textValue(...values) {
  for (const value of values) {
    const result = String(value ?? "").trim();

    if (
      result &&
      result.toLowerCase() !== "unknown"
    ) {
      return result;
    }
  }

  return null;
}

/*
 * These helpers produce the same effective values that
 * the architect-facing project pages should use.
 */
function effectiveSquareFeet(project) {
  return numericValue(
    project.squareFeetResolution?.selectedValue,
    project.squareFeet,
    project.mechanical?.squareFeet,
    project.electrical?.squareFeet
  );
}

function effectiveConsultant(project) {
  return textValue(
    project.consultant,
    project.mechanical?.consultant,
    project.electrical?.consultant
  );
}

function mechanicalUnitCount(project) {
  const mechanical = project.mechanical || {};
  const units = mechanical.units || [];

  if (units.length) {
    return units.reduce(
      (total, unit) =>
        total +
        Math.max(
          1,
          Number(unit.quantity) || 1
        ),
      0
    );
  }

  return numericValue(
    mechanical.unitCount,
    mechanical.totals?.unitCount?.chosen,
    mechanical.totals?.unitCount?.stated,
    mechanical.totals?.unitCount?.calculated
  );
}

function mechanicalTonnage(project) {
  const mechanical = project.mechanical || {};

  return numericValue(
    mechanical.totalTonnage,
    mechanical.totals?.tonnage?.chosen,
    mechanical.totals?.tonnage?.stated,
    mechanical.totals?.tonnage?.calculated
  );
}

function electricalPanelCount(project) {
  const electrical = project.electrical || {};
  const panels = electrical.panels || [];

  if (panels.length) {
    return panels.reduce(
      (total, panel) =>
        total +
        Math.max(
          1,
          Number(
            panel.quantity ??
            panel.count
          ) || 1
        ),
      0
    );
  }

  return numericValue(
    electrical.panelCount,
    electrical.totals?.panelCount?.chosen,
    electrical.totals?.panelCount?.stated,
    electrical.totals?.panelCount?.calculated
  );
}

function usefulMepFields(project) {
  const mechanical = project.mechanical || {};
  const electrical = project.electrical || {};

  const unitValues = (
    mechanical.units || []
  ).flatMap(unit => [
    unit.tonnage,
    unit.type,
    unit.normalizedType,
    unit.manufacturer,
    unit.model
  ]);

  const panelValues = (
    electrical.panels || []
  ).flatMap(panel => [
    panel.name,
    panel.panelName,
    panel.type,
    panel.panelAmps,
    panel.panelLoadKva,
    panel.disconnectName,
    panel.disconnectAmps,
    panel.manufacturer,
    panel.model
  ]);

  const noteSuggestions = (
    project.importedNotes || []
  )
    .flatMap(
      note =>
        note.suggestedInterpretations || []
    )
    .filter(
      item =>
        [
          "equipmentType",
          "systemType",
          "unitCount"
        ].includes(item.field) &&
        item.confidence !== "Low"
    );

  return [
    mechanicalTonnage(project),
    mechanicalUnitCount(project),
    mechanical.primarySystemType,
    mechanical.manufacturer,
    mechanical.model,
    mechanical.totalDuctFeet,

    electricalPanelCount(project),
    electrical.serviceInfo,
    electrical.notes,

    ...unitValues,
    ...panelValues,
    ...noteSuggestions
  ].filter(meaningful).length;
}

function makeIssue(project, fields) {
  const timestamp =
    new Date().toISOString();

  return {
    id: crypto.randomUUID(),

    projectId:
      project.id,

    projectNumber:
      project.projectNumber,

    projectName:
      project.projectName,

    consultant:
      effectiveConsultant(project) ||
      "Unknown",

    squareFeet:
      effectiveSquareFeet(project),

    discipline: "General",
    category: "Other",
    message: "",
    detailedNote: null,

    severity: "Warning",
    status: "Unresolved",

    createdAt: timestamp,
    updatedAt: timestamp,

    recordedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    resolutionHistory: [],

    source: "Application",
    autoDetected: false,

    originalRow: null,
    sourceWorkbook: null,

    ...fields
  };
}

function detectProjectIssues(project) {
  const detected = [];

  const mechanical =
    project.mechanical || {};

  const electrical =
    project.electrical || {};

  const squareFeet =
    effectiveSquareFeet(project);

  const consultant =
    effectiveConsultant(project);

  const tonnage =
    mechanicalTonnage(project);

  const unitCount =
    mechanicalUnitCount(project);

  const panelCount =
    electricalPanelCount(project);

  const mechanicalUnits =
    mechanical.units || [];

  const electricalPanels =
    electrical.panels || [];

  if (project.analysisReviewRequired) {
    detected.push(
      makeIssue(project, {
        discipline: "Mechanical",
        category: "Conflicting values",
        message:
          "Recorded project total and listed equipment sum require staff review.",
        severity: "Warning",
        autoDetected: true
      })
    );
  }

  if (!Number.isFinite(squareFeet)) {
    detected.push(
      makeIssue(project, {
        discipline: "General",
        category:
          "Square footage not shown",
        message:
          "Project square footage is not recorded.",
        severity: "Warning",
        autoDetected: true
      })
    );
  }

  if (!usefulMepFields(project)) {
    detected.push(
      makeIssue(project, {
        discipline: "General",
        category:
          "Equipment values incomplete",
        message:
          "No usable mechanical or electrical values are recorded.",
        severity: "Blocking",
        autoDetected: true
      })
    );
  }

  const noteHasMechanicalSuggestions = (
    project.importedNotes || []
  ).some(
    note =>
      (
        note.suggestedInterpretations ||
        []
      ).length
  );

  if (
    !mechanicalUnits.length &&
    !Number.isFinite(tonnage) &&
    noteHasMechanicalSuggestions
  ) {
    detected.push(
      makeIssue(project, {
        discipline: "Mechanical",
        category:
          "Equipment values incomplete",
        message:
          "Mechanical conditions are described in notes, but detailed equipment values are incomplete.",
        severity: "Warning",
        autoDetected: true
      })
    );
  }

  if (!consultant) {
    detected.push(
      makeIssue(project, {
        discipline: "General",
        category:
          "Consultant not identified",
        message:
          "MEP consultant is not identified.",
        severity: "Warning",
        autoDetected: true
      })
    );
  }

  const hasMechanical =
    Number.isFinite(tonnage) ||
    Number.isFinite(unitCount) ||
    meaningful(
      mechanical.primarySystemType
    ) ||
    mechanicalUnits.length > 0;

  const hasManufacturer =
    meaningful(mechanical.manufacturer) ||
    mechanicalUnits.some(
      unit =>
        meaningful(unit.manufacturer)
    );

  const hasModel =
    meaningful(mechanical.model) ||
    mechanicalUnits.some(
      unit =>
        meaningful(unit.model)
    );

  if (
    hasMechanical &&
    !hasManufacturer
  ) {
    detected.push(
      makeIssue(project, {
        discipline: "Mechanical",
        category:
          "Equipment values incomplete",
        message:
          "Primary equipment manufacturer is not recorded.",
        severity: "Note",
        autoDetected: true
      })
    );
  }

  if (
    hasMechanical &&
    !hasModel
  ) {
    detected.push(
      makeIssue(project, {
        discipline: "Mechanical",
        category:
          "Equipment values incomplete",
        message:
          "Primary equipment model is not recorded.",
        severity: "Note",
        autoDetected: true
      })
    );
  }

  const hasElectrical =
    Number.isFinite(panelCount) ||
    electricalPanels.length > 0 ||
    meaningful(
      electrical.serviceInfo
    );

  /*
   * Only report missing electrical panel data when
   * the project actually has some electrical data.
   * This avoids flagging every mechanical-only project.
   */
  if (
    hasElectrical &&
    !Number.isFinite(panelCount) &&
    !electricalPanels.length
  ) {
    detected.push(
      makeIssue(project, {
        discipline: "Electrical",
        category:
          "Equipment values incomplete",
        message:
          "Electrical panel information is not recorded.",
        severity: "Warning",
        autoDetected: true
      })
    );
  }

  if (project.excludedFromAnalysis) {
    detected.push(
      makeIssue(project, {
        discipline: "General",
        category:
          "Project intentionally excluded from analysis",
        message:
          "Project is excluded from estimator and consultant statistics.",
        severity: "Blocking",
        autoDetected: true
      })
    );
  }

  return detected;
}

function issueKey(issue) {
  return [
    issue.projectId ||
      issue.projectNumber ||
      issue.projectName,
    issue.discipline,
    issue.category,
    issue.message
  ]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function noteTokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(
        token => token.length > 2
      )
  );
}

function similarNote(a, b) {
  const left = noteTokens(a);
  const right = noteTokens(b);

  if (!left.size || !right.size) {
    return false;
  }

  let shared = 0;

  left.forEach(token => {
    if (right.has(token)) {
      shared += 1;
    }
  });

  return (
    shared /
      Math.max(
        left.size,
        right.size
      ) >=
    0.65
  );
}

function likelyDuplicateIssue(a, b) {
  const sameProject =
    (
      a.projectId &&
      b.projectId &&
      String(a.projectId) ===
        String(b.projectId)
    ) ||
    (
      a.projectNumber &&
      b.projectNumber &&
      String(a.projectNumber)
        .toLowerCase() ===
        String(b.projectNumber)
          .toLowerCase()
    );

  return (
    sameProject &&
    a.discipline === b.discipline &&
    (
      issueKey(a) === issueKey(b) ||
      similarNote(
        a.message || a.detailedNote,
        b.message || b.detailedNote
      )
    )
  );
}

function projectQualityStatus(
  project,
  issues
) {
  if (project.excludedFromAnalysis) {
    return "Excluded";
  }

  const related = issues.filter(
    issue =>
      issue.projectId === project.id ||
      (
        issue.projectNumber &&
        issue.projectNumber ===
          project.projectNumber
      )
  );

  const unresolved = related.filter(
    issue =>
      issue.status !== "Resolved"
  );

  if (
    unresolved.some(
      issue =>
        issue.severity === "Blocking"
    )
  ) {
    return "Blocked";
  }

  if (
    unresolved.some(
      issue =>
        issue.severity === "Warning"
    )
  ) {
    return "Warning";
  }

  if (
    related.length &&
    !unresolved.length
  ) {
    return "Resolved";
  }

  return "Complete";
}

function excludedFromAnalysis(
  project,
  issues
) {
  return require("./quality")
    .projectAvailability(
      project,
      issues
    )
    .globallyExcluded;
}

module.exports = {
  ISSUE_CATEGORIES,
  meaningful,
  effectiveSquareFeet,
  effectiveConsultant,
  mechanicalTonnage,
  mechanicalUnitCount,
  electricalPanelCount,
  usefulMepFields,
  makeIssue,
  detectProjectIssues,
  issueKey,
  similarNote,
  likelyDuplicateIssue,
  projectQualityStatus,
  excludedFromAnalysis
};