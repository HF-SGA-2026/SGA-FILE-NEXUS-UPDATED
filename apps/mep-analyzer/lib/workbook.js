const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { excludedFromAnalysis } = require('./issues');
const { METADATA_SHEET, metadataRows } = require('./master-import');

const ERROR_HEADERS = ['Severity','Status','Discipline','Project Number','Project Name','Consultant','Overall SF','Issue Category','Error / Note','Detailed Notes','Date Recorded','Last Updated','Recorded By','Resolved Date','Resolved By','Resolution Note','Excluded From Analysis','Source'];
const COLORS = { Blocking:'F4CCCC', Warning:'FCE5CD', Note:'D9EAD3' };

function valueOrBlank(value) { return value === null || value === undefined ? '' : value; }
function unitCount(project) { const m=project.mechanical||{};return Number.isFinite(m.unitCount)?m.unitCount:(m.units||[]).length||'' }
function median(values){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return'';const mid=(sorted.length-1)/2,lo=Math.floor(mid),hi=Math.ceil(mid);return lo===hi?sorted[lo]:(sorted[lo]+sorted[hi])/2}
function total(project,discipline,metric){return project?.[discipline]?.totals?.[metric]||{}}
function sourceLabel(source){return String(source||'').replace(/-/g,' ').replace(/^./,value=>value.toUpperCase())}
function traceValue(trace,field){const item=Array.isArray(trace)?trace[0]:trace;return valueOrBlank(item?.[field])}
function numericValue(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function effectiveSquareFeet(project) {
  return numericValue(
    project.squareFeetResolution?.selectedValue,
    project.squareFeet,
    project.mechanical?.squareFeet,
    project.electrical?.squareFeet
  );
}

function effectiveConsultant(project) {
  const values = [
    project.consultant,
    project.mechanical?.consultant,
    project.electrical?.consultant
  ];

  return (
    values.find(value => {
      const cleaned =
        String(value || "").trim();

      return (
        cleaned &&
        cleaned.toLowerCase() !== "unknown"
      );
    }) || null
  );
}

function calculatedEquipmentTonnage(project) {
  const units =
    project.mechanical?.units || [];

  const total = units.reduce(
    (sum, unit) => {
      const tons =
        Number(unit.tonnage);

      const quantity =
        Math.max(
          1,
          Number(unit.quantity) || 1
        );

      if (!Number.isFinite(tons)) {
        return sum;
      }

      return sum + tons * quantity;
    },
    0
  );

  return total > 0
    ? total
    : null;
}

function safeMechanicalTotals(project) {
  const mechanical =
    project.mechanical || {};

  const squareFeet =
    effectiveSquareFeet(project);

  const calculated =
    numericValue(
      mechanical.totals?.tonnage?.calculated,
      calculatedEquipmentTonnage(project)
    );

  let stated =
    numericValue(
      mechanical.totals?.tonnage?.stated
    );

  let chosen =
    numericValue(
      mechanical.totals?.tonnage?.chosen,
      mechanical.totalTonnage
    );

  const equalsSquareFeet = value =>
    Number.isFinite(value) &&
    Number.isFinite(squareFeet) &&
    Math.abs(value - squareFeet) < 0.001;

  /*
   * Prevent a square-footage value from being
   * exported as HVAC tonnage.
   */
  if (equalsSquareFeet(stated)) {
    stated = null;
  }

  if (equalsSquareFeet(chosen)) {
    chosen = null;
  }

  /*
   * Reject an obviously corrupted chosen value
   * when equipment totals are available.
   */
  if (
    Number.isFinite(chosen) &&
    Number.isFinite(calculated) &&
    calculated > 0 &&
    chosen > calculated * 20
  ) {
    chosen = null;
  }

  if (!Number.isFinite(chosen)) {
    chosen =
      calculated ??
      stated ??
      null;
  }

  let source =
    mechanical.totals?.tonnage?.source ||
    null;

  let verificationStatus =
    mechanical.totals?.tonnage
      ?.verificationStatus ||
    null;

  if (
    Number.isFinite(calculated) &&
    chosen === calculated
  ) {
    source =
      "calculated-equipment";

    verificationStatus =
      "Calculated";
  }

  return {
    chosen,
    stated,
    calculated,
    source,
    verificationStatus
  };
}

function currentProjectForIssue(data, issue) {
  return (data.projects || []).find(
    project =>
      String(project.id || "") ===
        String(issue.projectId || "") ||
      (
        issue.projectNumber &&
        project.projectNumber ===
          issue.projectNumber
      ) ||
      (
        issue.projectName &&
        project.projectName ===
          issue.projectName
      )
  );
}

function issueStillApplies(data, issue) {
  if (!issue.autoDetected) {
    return true;
  }

  const project =
    currentProjectForIssue(data, issue);

  if (!project) {
    return false;
  }

  const issueText = `
    ${issue.category || ""}
    ${issue.message || ""}
  `.toLowerCase();

  if (
    issueText.includes("square footage")
  ) {
    return !Number.isFinite(
      effectiveSquareFeet(project)
    );
  }

  if (
    issueText.includes("consultant")
  ) {
    return !effectiveConsultant(project);
  }

  if (
    issueText.includes("manufacturer")
  ) {
    const mechanical =
      project.mechanical || {};

    return !(
      mechanical.manufacturer ||
      (mechanical.units || []).some(
        unit => unit.manufacturer
      )
    );
  }

  if (
    issueText.includes("model")
  ) {
    const mechanical =
      project.mechanical || {};

    return !(
      mechanical.model ||
      (mechanical.units || []).some(
        unit => unit.model
      )
    );
  }

  if (
    issueText.includes(
      "no usable mechanical or electrical"
    )
  ) {
    const mechanical =
      project.mechanical || {};

    const electrical =
      project.electrical || {};

    const hasMechanical = Boolean(
      mechanical.totalTonnage ||
      mechanical.unitCount ||
      mechanical.primarySystemType ||
      (mechanical.units || []).length
    );

    const hasElectrical = Boolean(
      electrical.panelCount ||
      electrical.serviceInfo ||
      (electrical.panels || []).length
    );

    return !(
      hasMechanical ||
      hasElectrical
    );
  }

  return true;
}

function exportableIssues(data) {
  return (data.issues || []).filter(
    issue => {
      const projectName =
        String(
          issue.projectName || ""
        ).trim();

      if (
        /^total\s*:?\s*$/i.test(
          projectName
        )
      ) {
        return false;
      }

      if (
        issue.status === "Resolved"
      ) {
        return true;
      }

      return issueStillApplies(
        data,
        issue
      );
    }
  );
}


function addSheet(workbook, name, rows, widths, options = {}) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = widths.map(width => ({ wch: width }));
  sheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(rows[0].length-1)}${Math.max(1,rows.length)}` };
  sheet['!freeze'] = { xSplit:0, ySplit:1, topLeftCell:'A2', activePane:'bottomLeft', state:'frozen' };
  sheet['!rows'] = [{ hpt: 24 }];
  for(let col=0;col<rows[0].length;col++){
    const cell=sheet[XLSX.utils.encode_cell({r:0,c:col})];
    if(cell) cell.s={font:{bold:true,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'7B302E'}},alignment:{vertical:'center',wrapText:true}};
  }
  (options.textColumns||[]).forEach(col=>{for(let row=1;row<rows.length;row++){const cell=sheet[XLSX.utils.encode_cell({r:row,c:col})];if(cell)cell.z='@'}});
  (options.dateColumns||[]).forEach(col=>{for(let row=1;row<rows.length;row++){const cell=sheet[XLSX.utils.encode_cell({r:row,c:col})];if(cell)cell.z='yyyy-mm-dd'}});
  (options.wrapColumns||[]).forEach(col=>{for(let row=1;row<rows.length;row++){const cell=sheet[XLSX.utils.encode_cell({r:row,c:col})];if(cell)cell.s={...(cell.s||{}),alignment:{vertical:'top',wrapText:true}}}});
  XLSX.utils.book_append_sheet(workbook,sheet,name);
  return sheet;
}

function buildWorkbook(data) {
  const workbook=XLSX.utils.book_new();
  const projectsRows=[['Project Number','Project Name','Building Type','Overall SF','MEP Consultant','Project Status','Completion Date','Chosen HVAC Tonnage','Stated HVAC Tonnage','Listed Equipment Tonnage Sum','HVAC Tonnage Source','HVAC Tonnage Verification','Chosen HVAC Unit Count','Stated HVAC Unit Count','Calculated HVAC Unit Count','Chosen Duct Linear Feet','Stated Duct Linear Feet','Calculated Duct Linear Feet','Duct Total Source','Duct Verification','Chosen Electrical Panel Count','Stated Panel Count','Calculated Panel Count','Panel Total Source','Panel Verification','Electrical Service','Needs Total Review','Excluded From Analysis','Project Notes','Created Date','Last Updated','Update Source','Entered By','Record Origin']];
  (data.projects || []).forEach(project => {
    const tons =
      safeMechanicalTotals(project);

    const duct =
      total(
        project,
        "mechanical",
        "ductFeet"
      );

    const units =
      total(
        project,
        "mechanical",
        "unitCount"
      );

    const panels =
      total(
        project,
        "electrical",
        "panelCount"
      );

    projectsRows.push([
      valueOrBlank(
        project.projectNumber
      ),

      valueOrBlank(
        project.projectName
      ),

      valueOrBlank(
        project.buildingType
      ),

      valueOrBlank(
        effectiveSquareFeet(project)
      ),

      valueOrBlank(
        effectiveConsultant(project)
      ),

      valueOrBlank(
        project.projectStatus
      ),

      valueOrBlank(
        project.completionDate
      ),

      valueOrBlank(
        tons.chosen
      ),

      valueOrBlank(
        tons.stated
      ),

      valueOrBlank(
        tons.calculated
      ),

      sourceLabel(
        tons.source
      ),

      valueOrBlank(
        tons.verificationStatus
      ),

      valueOrBlank(
        unitCount(project)
      ),

      valueOrBlank(
        units.stated
      ),

      valueOrBlank(
        units.calculated
      ),

      valueOrBlank(
        project.mechanical
          ?.totalDuctFeet
      ),

      valueOrBlank(
        duct.stated
      ),

      valueOrBlank(
        duct.calculated
      ),

      sourceLabel(
        duct.source
      ),

      valueOrBlank(
        duct.verificationStatus
      ),

      valueOrBlank(
        project.electrical
          ?.panelCount
      ),

      valueOrBlank(
        panels.stated
      ),

      valueOrBlank(
        panels.calculated
      ),

      sourceLabel(
        panels.source
      ),

      valueOrBlank(
        panels.verificationStatus
      ),

      valueOrBlank(
        project.electrical
          ?.serviceInfo
      ),

      project.analysisReviewRequired
        ? "Yes"
        : "No",

      project.excludedFromAnalysis
        ? "Yes"
        : "No",

      (project.notes || []).join("; "),

      valueOrBlank(
        project.audit?.createdAt
      ),

      valueOrBlank(
        project.audit?.updatedAt
      ),

      valueOrBlank(
        project.audit?.sourceType
      ),

      valueOrBlank(
        project.audit?.enteredBy
      ),

      valueOrBlank(
        project.audit?.origin
      )
    ]);
  });
  
  addSheet(workbook,'Projects',projectsRows,[16,32,20,14,26,16,14,17,17,20,22,22,18,18,20,18,18,20,22,20,20,18,19,22,20,24,18,18,42,21,21,24,15,14],{textColumns:[0],wrapColumns:[1,2,4,10,11,18,19,23,24,25,28,31]});

  const mechanicalRows=[['Project Number','Project Name','Consultant','Overall SF','Unit Name','Quantity','Individual Unit Tonnage','Original Unit Type','Normalized Unit Type','Manufacturer','Model','Individual Duct Linear Feet','Classification','Equipment Notes','Chosen Project Tonnage','Stated Project Tonnage','Listed Equipment Sum','Tonnage Source','Verification Status','Source Workbook','Source Sheet','Source Row','Value Provenance']];
  
  (data.projects || []).forEach(project => {
    const mechanical =
      project.mechanical || {};

    const tons =
      safeMechanicalTotals(project);

    const units =
      (mechanical.units || []).length
        ? mechanical.units
        : [{}];

    units.forEach((unit, index) => {
      mechanicalRows.push([
        valueOrBlank(
          project.projectNumber
        ),

        valueOrBlank(
          project.projectName
        ),

        valueOrBlank(
          effectiveConsultant(project)
        ),

        valueOrBlank(
          effectiveSquareFeet(project)
        ),

        valueOrBlank(
          unit.name ||
          (
            index === 0 &&
            mechanical.primarySystemType
              ? "Primary system"
              : ""
          )
        ),

        valueOrBlank(
          unit.quantity || 1
        ),

        valueOrBlank(
          unit.tonnage
        ),

        valueOrBlank(
          unit.originalType
        ),

        valueOrBlank(
          unit.normalizedType ||
          unit.type ||
          mechanical.primarySystemType
        ),

        valueOrBlank(
          unit.manufacturer ||
          mechanical.manufacturer
        ),

        valueOrBlank(
          unit.model ||
          mechanical.model
        ),

        valueOrBlank(
          unit.ductFeet
        ),

        valueOrBlank(
          unit.classification
        ),

        valueOrBlank(
          unit.notes ||
          mechanical.notes
        ),

        valueOrBlank(
          tons.chosen
        ),

        valueOrBlank(
          tons.stated
        ),

        valueOrBlank(
          tons.calculated
        ),

        sourceLabel(
          tons.source
        ),

        valueOrBlank(
          tons.verificationStatus
        ),

        traceValue(
          unit.sourceTrace,
          "workbook"
        ),

        traceValue(
          unit.sourceTrace,
          "sheet"
        ),

        traceValue(
          unit.sourceTrace,
          "row"
        ),

        valueOrBlank(
          project.provenance
            ?.mechanical ||
          "recorded"
        )
      ]);
    });
  });  
  
  addSheet(workbook,'Mechanical Equipment',mechanicalRows,[16,32,24,13,16,11,18,24,28,20,20,20,16,38,20,20,20,22,20,28,22,12,16],{textColumns:[0],wrapColumns:[1,7,8,13,17,18,19,20]});

  const electricalRows=[['Project Number','Project Name','Consultant','Overall SF','Equipment / Panel Tag','Panel Type','Quantity','Rating','Manufacturer','Model','Service Information','Equipment Notes','Chosen Project Panel Count','Stated Project Panel Count','Calculated Project Panel Count','Panel Total Source','Verification Status','Source Workbook','Source Sheet','Source Row','Value Provenance']];
  
  
  (data.projects || []).forEach(project => {
    const electrical =
      project.electrical || {};

    const panelTotal =
      total(
        project,
        "electrical",
        "panelCount"
      );

    const panels =
      (electrical.panels || []).length
        ? electrical.panels
        : [{}];

    panels.forEach(panel => {
      electricalRows.push([
        valueOrBlank(
          project.projectNumber
        ),

        valueOrBlank(
          project.projectName
        ),

        valueOrBlank(
          effectiveConsultant(project)
        ),

        valueOrBlank(
          effectiveSquareFeet(project)
        ),

        valueOrBlank(
          panel.name
        ),

        valueOrBlank(
          panel.type
        ),

        valueOrBlank(
          panel.quantity ??
          panel.count
        ),

        valueOrBlank(
          panel.rating
        ),

        valueOrBlank(
          panel.manufacturer
        ),

        valueOrBlank(
          panel.model
        ),

        valueOrBlank(
          panel.serviceInfo ||
          electrical.serviceInfo
        ),

        valueOrBlank(
          panel.notes ||
          electrical.notes
        ),

        valueOrBlank(
          electrical.panelCount
        ),

        valueOrBlank(
          panelTotal.stated
        ),

        valueOrBlank(
          panelTotal.calculated
        ),

        sourceLabel(
          panelTotal.source
        ),

        valueOrBlank(
          panelTotal.verificationStatus
        ),

        traceValue(
          panel.sourceTrace,
          "workbook"
        ),

        traceValue(
          panel.sourceTrace,
          "sheet"
        ),

        traceValue(
          panel.sourceTrace,
          "row"
        ),

        valueOrBlank(
          project.provenance
            ?.electrical ||
          "recorded"
        )
      ]);
    });
  });  
  
  
  addSheet(workbook,'Electrical',electricalRows,[16,32,24,13,22,20,12,16,20,20,26,38,20,20,20,22,20,28,22,12,16],{textColumns:[0],wrapColumns:[1,5,10,11,15,16,17,18]});

  const severityOrder={Blocking:0,Warning:1,Note:2};
  
  
  const issues = exportableIssues(data)
    .sort(
      (a, b) =>
        (a.status === "Resolved") -
          (b.status === "Resolved") ||
        (severityOrder[a.severity] ?? 9) -
          (severityOrder[b.severity] ?? 9) ||
        String(
          a.projectNumber || ""
        ).localeCompare(
          String(
            b.projectNumber || ""
          )
        )
    );  
  
  const errorRows=[ERROR_HEADERS];
  issues.forEach(issue=>errorRows.push([issue.severity,issue.status,issue.discipline,valueOrBlank(issue.projectNumber),valueOrBlank(issue.projectName),valueOrBlank(issue.consultant),valueOrBlank(issue.squareFeet),valueOrBlank(issue.category),valueOrBlank(issue.message),valueOrBlank(issue.detailedNote),valueOrBlank(issue.createdAt),valueOrBlank(issue.updatedAt),valueOrBlank(issue.recordedBy),valueOrBlank(issue.resolvedAt),valueOrBlank(issue.resolvedBy),valueOrBlank(issue.resolutionNote),issue.excludedFromAnalysis?'Yes':'No',valueOrBlank(issue.source)]));
  const errorsSheet=addSheet(workbook,'ERRORS',errorRows,[11,12,13,16,30,24,12,27,42,42,20,20,15,20,15,36,20,28],{textColumns:[3],wrapColumns:[4,7,8,9,15,17]});
  issues.forEach((issue,index)=>{const cell=errorsSheet[`A${index+2}`];if(cell)cell.s={font:{bold:true},fill:{fgColor:{rgb:COLORS[issue.severity]||'FFFFFF'}}}});

  const eligible=(data.projects||[]).filter(project=>!excludedFromAnalysis(project,data.issues||[]));
  const grouped=eligible.reduce((acc,project)=>{const name=project.consultant||'Unknown';(acc[name]??=[]).push(project);return acc},{});
  const consultantRows=[['Consultant','Projects Used in Analysis','Building Types','Median Project SF','Median HVAC Tonnage','Median SF per Ton','Average HVAC Unit Count','Average Electrical Panel Count']];
  
  
  Object.entries(grouped)
  .sort(
    (a, b) =>
      a[0].localeCompare(b[0])
  )
  .forEach(([name, list]) => {
    const average = values => {
      const validValues =
        values.filter(Number.isFinite);

      return validValues.length
        ? validValues.reduce(
            (sum, value) => sum + value,
            0
          ) / validValues.length
        : "";
    };

    const squareFeetValues =
      list.map(project =>
        effectiveSquareFeet(project)
      );

    const tonnageValues =
      list.map(project =>
        safeMechanicalTotals(project).chosen
      );

    const squareFeetPerTon =
      list.map(project => {
        const squareFeet =
          effectiveSquareFeet(project);

        const tonnage =
          safeMechanicalTotals(project).chosen;

        return (
          Number.isFinite(squareFeet) &&
          Number.isFinite(tonnage) &&
          tonnage > 0
        )
          ? squareFeet / tonnage
          : null;
      });

    consultantRows.push([
      name,

      list.length,

      [
        ...new Set(
          list
            .map(
              project =>
                project.buildingType
            )
            .filter(Boolean)
        )
      ].join("; "),

      median(squareFeetValues),

      median(tonnageValues),

      median(squareFeetPerTon),

      average(
        list.map(unitCount)
      ),

      average(
        list.map(
          project =>
            project.electrical?.panelCount
        )
      )
    ]);
  });
  addSheet(workbook,'Consultants Summary',consultantRows,[28,20,36,18,20,18,22,24],{wrapColumns:[0,2]});

  const notesRows=[['Sheet / Field','Definition'],['Workbook purpose','Current local SGA MEP master dataset. Historical observations only; not engineering calculations or consultant recommendations.'],['Projects','One row per project with audit information and analysis-exclusion status.'],['Mechanical Equipment','Recorded mechanical equipment and project-level mechanical totals.'],['Electrical','Recorded electrical panels, totals, service information, and notes.'],['ERRORS','Consolidated unresolved and resolved project issues. Unresolved items are sorted first.'],['Consultants Summary','Summary of projects eligible for analysis; blocked and excluded projects are omitted.'],['Recorded','Value entered from a document, field verification, import, or staff entry.'],['Estimated','Value explicitly identified as an estimate. Never silently treated as recorded.'],['Not recorded','No value is available in the active dataset.'],['Local storage notice','Data is stored on this installation unless deployed to a shared firm server.']];
  addSheet(workbook,'Notes',notesRows,[28,100],{wrapColumns:[1]});
  const importedNoteRows=[['Project Number','Project Name','Discipline','Original Note Text','Suggested Interpretation','Confidence','Review Status','Source Workbook','Source Sheet','Source Row']];
  (data.projects||[]).forEach(project=>(project.importedNotes||[]).forEach(note=>importedNoteRows.push([valueOrBlank(project.projectNumber),valueOrBlank(project.projectName),valueOrBlank(note.discipline),valueOrBlank(note.originalText),valueOrBlank((note.suggestedInterpretations||[]).map(item=>`${item.field}: ${item.value} (${item.label||'Suggested from note'})`).join('; ')),valueOrBlank(note.confidence||(note.suggestedInterpretations||[])[0]?.confidence),valueOrBlank(note.reviewStatus),valueOrBlank(note.sourceWorkbook),valueOrBlank(note.sourceSheet),valueOrBlank(note.sourceRow)])));
  addSheet(workbook,'Imported Notes',importedNoteRows,[16,32,14,55,55,14,18,28,24,12],{textColumns:[0],wrapColumns:[1,3,4,6,7,8]});
  addSheet(workbook,METADATA_SHEET,metadataRows(data),[18,10,15,38,18,8,8,120],{textColumns:[3,4],wrapColumns:[7]});
  workbook.Workbook={Sheets:workbook.SheetNames.map(name=>({name,Hidden:name===METADATA_SHEET?1:0}))};
  workbook.Props={Title:'SGA MEP Master',Subject:'Architectural pre-design MEP project history',Author:'Sam Garcia Architects',CreatedDate:new Date()};
  return workbook;
}

function replaceEntry(cfb,name,content){XLSX.CFB.utils.cfb_add(cfb,`/${name}`,Buffer.from(content,'utf8'))}
function setCellStyle(xml,cellRef,style){const escaped=cellRef.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return xml.replace(new RegExp(`<c r="${escaped}"([^>]*)>`),(_match,attrs)=>`<c r="${cellRef}"${attrs.replace(/\s+s="\d+"/,'')} s="${style}">`)}
function styleColumn(xml,column,style,startRow=2){return xml.replace(new RegExp(`<c r="${column}(\\d+)"([^>]*)>`,'g'),(match,row,attrs)=>Number(row)>=startRow?`<c r="${column}${row}"${attrs.replace(/\s+s="\d+"/,'')} s="${style}">`:match)}
function enhanceWorkbookXml(buffer,data){
  const cfb=XLSX.CFB.read(buffer,{type:'buffer'}),stylesEntry=XLSX.CFB.find(cfb,'/xl/styles.xml');if(!stylesEntry)return buffer;
  let styles=Buffer.from(stylesEntry.content).toString('utf8');
  styles=styles.replace(/<fonts count="1">([\s\S]*?)<\/fonts>/,`<fonts count="3">$1<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF2B2926"/><name val="Calibri"/></font></fonts>`)
    .replace(/<fills count="2">([\s\S]*?)<\/fills>/,`<fills count="6">$1<fill><patternFill patternType="solid"><fgColor rgb="FF7B302E"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4CCCC"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE5CD"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAD3"/><bgColor indexed="64"/></patternFill></fill></fills>`)
    .replace(/<cellXfs count="2">([\s\S]*?)<\/cellXfs>/,`<cellXfs count="8">$1<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>`);
  replaceEntry(cfb,'xl/styles.xml',styles);
  const wrapColumns={1:['B','C','E','K','L','S','T','X','Y','Z','AC','AF'],2:['B','H','I','N','R','S','T','U'],3:['B','F','K','L','P','Q','R','S'],4:['E','H','I','J','P','R'],5:['A','C'],6:['B'],7:['B','D','E','G','H','I']};
  for(let index=1;index<=7;index++){
    const entry=XLSX.CFB.find(cfb,`/xl/worksheets/sheet${index}.xml`);if(!entry)continue;let xml=Buffer.from(entry.content).toString('utf8');
    xml=xml.replace(/<sheetViews><sheetView workbookViewId="0"\s*\/><\/sheetViews>/,`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`);
    const header=(xml.match(/<row r="1"[^>]*>([\s\S]*?)<\/row>/)||[])[1]||'';for(const ref of header.match(/r="([A-Z]+1)"/g)||[])xml=setCellStyle(xml,ref.slice(3,-1),2);
    for(const column of wrapColumns[index]||[])xml=styleColumn(xml,column,index===4&&column==='D'?7:6);
    if(index===4){const order={Blocking:3,Warning:4,Note:5};

    const sorted = exportableIssues(data)
      .sort(
        (a, b) =>
          (a.status === "Resolved") -
            (b.status === "Resolved") ||
          (
            {
              Blocking: 0,
              Warning: 1,
              Note: 2
            }[a.severity] ?? 9
          ) -
            (
              {
                Blocking: 0,
                Warning: 1,
                Note: 2
              }[b.severity] ?? 9
            ) ||
          String(
            a.projectNumber || ""
          ).localeCompare(
            String(
              b.projectNumber || ""
            )
          )
      );
    
    sorted.forEach((issue,row)=>{xml=setCellStyle(xml,`A${row+2}`,order[issue.severity]||4);xml=setCellStyle(xml,`D${row+2}`,7)})}
    replaceEntry(cfb,`xl/worksheets/sheet${index}.xml`,xml);
  }
  return XLSX.CFB.write(cfb,{type:'buffer',fileType:'zip',compression:true});
}
function generateWorkbookBuffer(data){const raw=XLSX.write(buildWorkbook(data),{type:'buffer',bookType:'xlsx',cellStyles:true});return enhanceWorkbookXml(raw,data)}
function validateWorkbookBuffer(buffer){const workbook=XLSX.read(buffer,{type:'buffer'});const required=['Projects','Mechanical Equipment','Electrical','ERRORS','Consultants Summary','Notes','Imported Notes',METADATA_SHEET];required.forEach(name=>{if(!workbook.SheetNames.includes(name))throw new Error(`Generated workbook is missing ${name}.`)});return workbook.SheetNames}
function masterTarget(settings){const directory=path.resolve(settings.masterDirectory);const filename=path.basename(settings.masterFilename||'SGA_MEP_Master.xlsx');if(!filename.toLowerCase().endsWith('.xlsx'))throw new Error('Master workbook filename must end in .xlsx.');return{directory,filename,target:path.join(directory,filename)}}
function pruneFiles(directory,max=20){if(!fs.existsSync(directory))return;const files=fs.readdirSync(directory).filter(name=>name.toLowerCase().endsWith('.xlsx')).map(name=>({path:path.join(directory,name),time:fs.statSync(path.join(directory,name)).mtimeMs})).sort((a,b)=>b.time-a.time);files.slice(max).forEach(file=>fs.unlinkSync(file.path))}
function writeMasterWorkbook(data){const {directory,filename,target}=masterTarget(data.settings);fs.mkdirSync(directory,{recursive:true});const buffer=generateWorkbookBuffer(data);validateWorkbookBuffer(buffer);const temp=path.join(directory,`.${filename}.${Date.now()}.tmp`);fs.writeFileSync(temp,buffer);validateWorkbookBuffer(fs.readFileSync(temp));let backup=null,previous=null;try{if(fs.existsSync(target)){const backupDir=path.join(directory,'backups');fs.mkdirSync(backupDir,{recursive:true});backup=path.join(backupDir,`SGA_MEP_Master_${new Date().toISOString().slice(0,16).replace(/[-:T]/g,'-')}.xlsx`);fs.copyFileSync(target,backup);previous=`${target}.previous`;if(fs.existsSync(previous))fs.unlinkSync(previous);fs.renameSync(target,previous)}fs.renameSync(temp,target);if(previous&&fs.existsSync(previous))fs.unlinkSync(previous);if(backup)pruneFiles(path.dirname(backup),20);return{path:target,backup,lastUpdated:new Date().toISOString()}}catch(error){if(fs.existsSync(temp))fs.unlinkSync(temp);if(previous&&fs.existsSync(previous)&&!fs.existsSync(target))fs.renameSync(previous,target);throw new Error(`JSON data was saved, but the master workbook could not be replaced. Close Excel if the file is open, then retry. ${error.message}`)}}

module.exports={ERROR_HEADERS,buildWorkbook,generateWorkbookBuffer,validateWorkbookBuffer,writeMasterWorkbook,masterTarget,enhanceWorkbookXml};
