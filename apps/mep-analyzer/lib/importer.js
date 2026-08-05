const XLSX = require('xlsx');
const { normalizeConsultantName, canonicalizeConsultants, consultantKey } = require('./analysis');
const { makeIssue } = require('./issues');
const { cleaned, normalizedLabel, isUnknownValue, isTotalLabel, normalizeEquipmentType, interpretNote } = require('./import-interpretation');
const { parseMasterWorkbook } = require('./master-import');

const FIELD_ALIASES = {
  projectNumber: ['project number','project no','project #','job number','job no','project id'],
  projectName: ['project name','job name','name of project'],
  consultant: ['mep','mep consultant','consultant','electrical consultant','engineer'],
  buildingType: ['building type','project type','facility type','occupancy'],
  squareFeet: ['overall sf','overall square footage','square footage','building sf','total sf','sf'],
  projectTonnage: ['project total hvac tonnage','project total tonnage','total hvac tonnage','total tonnage','combined tonnage','grand total tons','project tons'],
  projectDuctFeet: ['project total duct linear feet','total duct linear feet','total linear feet','total lf','project duct feet'],
  unitName: ['unit name','equipment name','equipment tag','unit tag','tag','name'],
  tonnage: ['individual tonnage','unit tonnage','tonnage','tons','capacity tons'],
  unitType: ['unit type','equipment type','system type','type'],
  quantity: ['quantity','qty','unit quantity','equipment quantity','count'],
  manufacturer: ['manufacturer','mfr','make'],
  model: ['model','model number','model no'],
  ductFeet: ['linear ft','linear feet','duct linear ft','duct length','duct ft'],
  classification: ['classification','standard unusual custom','equipment classification'],
  
  
  disconnectName: [
  'disconnect',
  'disconnects',
  'disconnect name',
  'disconnect tag',
  'disconnect info'
  ],

  disconnectAmps: [
    'disconnect amps',
    'disconnect amperage',
    'disconnect rating'
  ],

  panelName: [
    'panel name',
    'panel tag',
    'equipment tag',
    'panel',
    'panelboard',
    'panels'
  ],

  panelType: [
    'panel type',
    'equipment type',
    'type'
  ],

  panelCount: [
    'panel count',
    'number of panels',
    'no of panels',
    '# panels',
    'quantity',
    'qty'
  ],

  projectPanelTotal: [
    'project panel total',
    'total panels',
    'total panel count',
    'electrical panel total'
  ],

  panelLoadKva: [
    'load kva',
    'load (kva)',
    'panel load kva',
    'connected load kva',
    'kva'
  ],

  panelAmps: [
    'panel amps',
    'panel amperage',
    'panel amp rating'
  ],

  serviceInfo: [
    'service information',
    'service info',
    'electrical service',
    'service'
  ],

  rating: [
    'rating',
    'amp rating',
    'amperage',
    'amps',
    'voltage'
  ],
    
  
  electricalManufacturer: ['electrical manufacturer','panel manufacturer','manufacturer','mfr','make'],
  electricalModel: ['electrical model','panel model','model','model number','model no'],
  notes: ['notes','comments','remarks','other information','error note']
};

const ISSUE_ALIASES = {
  projectNumber:['project number','project no','project #','job number','job no'], projectName:['project name','job name','project'], consultant:['consultant','mep','engineer'], squareFeet:['overall sf','square footage','sf'],
  discipline:['discipline','trade'], severity:['severity','priority'], status:['status','resolution status'], category:['issue category','category','error category'], message:['error / note','error','issue','issue text','error note','note','comments','remarks'], detailedNote:['detailed notes','details','description'], recordedBy:['recorded by','entered by','staff'], dateRecorded:['date recorded','date','created date']
};

const MECHANICAL_FIELDS=['projectNumber','projectName','consultant','buildingType','squareFeet','projectTonnage','projectDuctFeet','unitName','tonnage','unitType','quantity','manufacturer','model','ductFeet','classification','notes'];
const ELECTRICAL_FIELDS = [
  'projectNumber',
  'projectName',
  'consultant',
  'buildingType',
  'squareFeet',
  'projectPanelTotal',

  'disconnectName',
  'disconnectAmps',

  'panelName',
  'panelType',
  'panelCount',
  'panelLoadKva',
  'panelAmps',

  'serviceInfo',
  'rating',
  'quantity',
  'electricalManufacturer',
  'electricalModel',
  'notes'
];


function cleanHeader(value){return cleaned(value)}
function key(value){return normalizedLabel(value)}
function text(value){const result=cleaned(value);return result||null}
function numeric(value){
  if(value===null||value===undefined||value===''||isUnknownValue(value))return null;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  const normalized=String(value).replace(/,/g,'').trim();if(!normalized||/^[-–—]+$/.test(normalized))return null;
  const match=normalized.match(/-?\d+(?:\.\d+)?/);if(!match)return null;const parsed=Number(match[0]);return Number.isFinite(parsed)?parsed:null;
}

function phaseNameFromRow(row) {
  for (const rawValue of row.__cells || []) {
    const value = text(rawValue);

    if (!value) continue;

    const match = value.match(
      /^phase\s*([0-9]+|[ivx]+)\s*:?\s*$/i
    );

    if (match) {
      return `Phase ${match[1].toUpperCase()}`;
    }
  }

  return null;
}

function labeledSquareFeet(value) {
  const raw = text(value);

  if (!raw) return null;

  const match = raw.match(
    /^(.*?)\s*[-:]\s*(\d[\d,]*(?:\.\d+)?)\s*(?:sf|sq\.?\s*ft\.?|square\s*feet)\b/i
  );

  if (!match) return null;

  const parsed = Number(
    match[2].replace(/,/g, "")
  );

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const label =
    match[1].trim() || "Area component";

  return {
    label,
    squareFeet: parsed,
    isTotal: /\btotal\b/i.test(label)
  };
}

function extractMechanicalPhases(
  block,
  mapping,
  headers
) {
  const phases = [];
  let currentPhase = null;

  for (const row of block.rows) {
    const detectedPhase =
      phaseNameFromRow(row);

    if (detectedPhase) {
      currentPhase = {
        name: detectedPhase,
        components: [],
        totalSquareFeet: null,
        totalTonnage: null,
        totalDuctFeet: null,
        sourceRows: [],
        _equipmentTonnages: []
      };

      phases.push(currentPhase);
    }

    if (!currentPhase) continue;

    currentPhase.sourceRows.push(row.__row);

    const squareFeetCell = fieldCell(
      row,
      mapping,
      headers,
      "squareFeet"
    );

    const squareFeetInfo =
      labeledSquareFeet(squareFeetCell.raw);

    if (squareFeetInfo) {
      if (squareFeetInfo.isTotal) {
        currentPhase.totalSquareFeet =
          squareFeetInfo.squareFeet;
      } else {
        currentPhase.components.push({
          name: squareFeetInfo.label,
          squareFeet:
            squareFeetInfo.squareFeet,
          sourceRow: row.__row
        });
      }
    }

    const tonnage = numeric(
      fieldCell(
        row,
        mapping,
        headers,
        "tonnage"
      ).raw
    );

    const unitName = text(
      fieldCell(
        row,
        mapping,
        headers,
        "unitName"
      ).raw
    );

    if (tonnage !== null) {
      if (
        unitName &&
        looksEquipmentTag(unitName)
      ) {
        currentPhase._equipmentTonnages.push(
          tonnage
        );
      } else {
        // A numeric tonnage on a row without an equipment
        // tag is treated as the recorded phase total.
        currentPhase.totalTonnage =
          tonnage;
      }
    }

    const ductFeet = numeric(
      fieldCell(
        row,
        mapping,
        headers,
        "ductFeet"
      ).raw
    );

    if (ductFeet !== null) {
      currentPhase.totalDuctFeet =
        ductFeet;
    }
  }

  return phases.map(phase => {
    if (
      phase.totalTonnage === null &&
      phase._equipmentTonnages.length
    ) {
      phase.totalTonnage = sum(
        phase._equipmentTonnages
      );
    }

    delete phase._equipmentTonnages;

    phase.sourceRows = [
      ...new Set(phase.sourceRows)
    ];

    return phase;
  });
}

function squareFeetNumeric(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    isUnknownValue(value)
  ) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : null;
  }

  const raw = String(value).trim();

  /*
   * Prefer the number explicitly followed by:
   * SF, sq ft, or square feet.
   *
   * Example:
   * "SUITE 280: 2,008 SF" → 2008
   */
  const squareFeetMatches = [
    ...raw.matchAll(
      /(-?\d[\d,]*(?:\.\d+)?)\s*(?:sf|sq\.?\s*ft\.?|square\s*feet)\b/gi
    )
  ];

  if (squareFeetMatches.length) {
    const selected =
      squareFeetMatches[
        squareFeetMatches.length - 1
      ][1];

    const parsed = Number(
      selected.replace(/,/g, "")
    );

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return numeric(value);
}


function titleCase(value){return String(value||'').replace(/^./,letter=>letter.toUpperCase())}
function columnName(index){return XLSX.utils.encode_col(index)}

function validProjectNumber(value) {
  return /^\d{4}-\d{2,4}[A-Za-z]?$/.test(cleaned(value));
}
function ratioSummary(value){return /^\s*\d[\d,]*(?:\.\d+)?\s*:\s*\d[\d,]*(?:\.\d+)?\s*:\s*\d[\d,]*(?:\.\d+)?\s*$/.test(String(value??''))}

function parseRatioSummary(value) {
  const raw = String(value ?? "").trim();

  if (!ratioSummary(raw)) {
    return null;
  }

  const parts = raw
    .split(":")
    .map(part =>
      Number(
        part
          .trim()
          .replace(/,/g, "")
      )
    );

  if (
    parts.length !== 3 ||
    !parts.every(Number.isFinite)
  ) {
    return null;
  }

  return {
    squareFeet: parts[0],
    tonnage: parts[1],
    ductFeet: parts[2]
  };
}

function projectSummaryFromHeaderRow(block) {
  const row =
    block.rows.find(
      item =>
        item.__row ===
        block.projectNumberRow
    ) || block.rows[0];

  for (
    let index = 0;
    index < row.__cells.length;
    index++
  ) {
    const parsed = parseRatioSummary(
      row.__cells[index]
    );

    if (parsed) {
      return {
        ...parsed,
        row: row.__row,
        index,
        column: columnName(index),
        originalValue: row.__cells[index]
      };
    }
  }

  return null;
}

function fieldsFor(type){return type==='electrical'?ELECTRICAL_FIELDS:MECHANICAL_FIELDS}
function aliasMatch(header,alias){const normalized=key(header);if(normalized===alias)return true;if(alias.length<5||normalized.length<5)return false;return normalized.includes(alias)||alias.includes(normalized)}
function suggestMapping(headers,type){
  const mapping={};for(const field of fieldsFor(type)){const aliases=FIELD_ALIASES[field]||[],exact=headers.find(header=>aliases.includes(key(header))),partial=headers.find(header=>aliases.some(alias=>aliasMatch(header,alias)));mapping[field]=exact||partial||''}
  if(mapping.projectTonnage&&mapping.projectTonnage===mapping.tonnage){const headerKey=key(mapping.tonnage);if(!/project|total|combined|grand/.test(headerKey))mapping.projectTonnage='';else mapping.tonnage=''}
  if(mapping.projectDuctFeet&&mapping.projectDuctFeet===mapping.ductFeet){const headerKey=key(mapping.ductFeet);if(!/project|total/.test(headerKey))mapping.projectDuctFeet='';else mapping.ductFeet=''}
  if(mapping.projectPanelTotal&&mapping.projectPanelTotal===mapping.panelCount){const headerKey=key(mapping.panelCount);if(!/project|total/.test(headerKey))mapping.projectPanelTotal='';else mapping.panelCount=''}
    if (type === 'electrical') {
    const ampHeaders = headers.filter(header =>
      /^amps(?:\s*\(\d+\))?$/i.test(String(header).trim())
    );

    if (ampHeaders.length >= 1) {
      mapping.disconnectAmps = ampHeaders[0];
    }

    if (ampHeaders.length >= 2) {
      mapping.panelAmps = ampHeaders[1];
    }

    const loadHeader = headers.find(header =>
      /^load\s*\(kva\)$/i.test(String(header).trim()) ||
      /^load kva$/i.test(String(header).trim())
    );

    if (loadHeader) {
      mapping.panelLoadKva = loadHeader;
    }

    const disconnectHeader = headers.find(header =>
      /^disconnects?$/i.test(String(header).trim())
    );

    if (disconnectHeader) {
      mapping.disconnectName = disconnectHeader;
    }

    const panelHeader = headers.find(header =>
      /^panels?$/i.test(String(header).trim())
    );

    if (panelHeader) {
      mapping.panelName = panelHeader;
    }
  }
  return mapping;
}

function compositeHeaders(rows,start,height){
  const width=Math.max(...rows.slice(start,start+height).map(row=>row.length),0);return Array.from({length:width},(_unused,column)=>{const values=[];for(let row=start;row<start+height;row++){const value=cleanHeader(rows[row]?.[column]);if(value&&!values.includes(value))values.push(value)}return values.join(' ')||`Column ${column+1}`})
}
function detectHeader(rows,type){
  let best={start:0,height:1,headers:compositeHeaders(rows,0,1),score:-Infinity};const limit=Math.min(rows.length,30);
  for(let start=0;start<limit;start++)for(let height=1;height<=3&&start+height<=limit;height++){
    const headers=compositeHeaders(rows,start,height),mapping=suggestMapping(headers,type),mapped=Object.values(mapping).filter(Boolean).length,identity=['projectNumber','projectName'].filter(field=>mapping[field]).length,equipment=(type==='mechanical'?['unitName','tonnage','unitType']:['panelName','panelCount','serviceInfo']).filter(field=>mapping[field]).length;
    const score=mapped*10+identity*8+equipment*4-height*.25;if(score>best.score)best={start,height,headers,score};
  }
  return best;
}
function uniqueHeaders(row){const seen=new Map();return row.map((value,index)=>{const base=cleanHeader(value)||`Column ${index+1}`,count=seen.get(base)||0;seen.set(base,count+1);return count?`${base} (${count+1})`:base})}
function issueMapping(headers){const mapping={};for(const[field,aliases]of Object.entries(ISSUE_ALIASES))mapping[field]=headers.find(header=>aliases.includes(key(header)))||headers.find(header=>aliases.some(alias=>aliasMatch(header,alias)))||'';return mapping}

function parseWorkbook(buffer,type,suppliedMapping={},options={}){
  const workbook=XLSX.read(buffer,{type:'buffer',cellDates:false});if(!workbook.SheetNames.length)throw new Error('The workbook does not contain a worksheet.');
  const master=parseMasterWorkbook(workbook);if(master){master.projects.forEach(project=>Object.defineProperty(project,'__masterImport',{value:true,enumerable:false}));const equipment=master.projects.reduce((sum,p)=>sum+(p.mechanical?.units?.length||0)+(p.electrical?.panels?.length||0),0);return{detectedType:'master',masterWorkbook:true,headers:[],mapping:{},projects:{records:master.projects,count:master.projects.length,equipmentCount:equipment,errors:[],interpretedIssues:[],importedNotes:master.projects.flatMap(p=>p.importedNotes||[])},issues:master.issues,errorIssues:[],importedNotes:master.projects.flatMap(p=>p.importedNotes||[]),errorSheetRows:master.issues.length,masterDataset:master.dataset}}
  const dataSheetName=workbook.SheetNames.find(name=>!/errors?/i.test(name))||workbook.SheetNames[0],sheet=workbook.Sheets[dataSheetName],rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null,raw:false,blankrows:true});if(!rows.some(row=>row.some(value=>text(value))))throw new Error('The first worksheet is empty.');
  const detected=detectHeader(rows,type),headers=uniqueHeaders(detected.headers),autoMapping=suggestMapping(headers,type),mapping={...autoMapping,...Object.fromEntries(Object.entries(suppliedMapping).filter(([,value])=>value))},source={workbookName:options.workbookName||'Uploaded workbook',sheetName:dataSheetName,knownConsultants:options.knownConsultants||[]};
  const objects=rows.slice(detected.start+detected.height).map((row,rowOffset)=>{const record={__row:detected.start+detected.height+rowOffset+1,__cells:row};headers.forEach((header,index)=>record[header]=row[index]);return record});
  const normalized=normalizeRows(objects,mapping,type,{...source,headers});
  const errorIssues=workbook.SheetNames.filter(name=>/errors?/i.test(name)).flatMap(name=>parseIssuesSheet(workbook.Sheets[name],type,name,source.workbookName));
  return{headers,mapping,headerRow:detected.start+detected.height,headerRows:{start:detected.start+1,end:detected.start+detected.height},dataSheetName,projects:normalized,issues:[...normalized.interpretedIssues,...errorIssues],errorIssues,importedNotes:normalized.importedNotes,errorSheetRows:errorIssues.length};
}

function parseIssuesSheet(sheet,type,sheetName,workbookName='Uploaded workbook'){
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null,raw:false,blankrows:true});if(!rows.length)return[];let best={index:0,score:-1};rows.slice(0,20).forEach((row,index)=>{const score=Object.values(issueMapping(row.map(cleanHeader))).filter(Boolean).length;if(score>best.score)best={index,score}});const headers=uniqueHeaders(rows[best.index]),mapping=issueMapping(headers);
  return rows.slice(best.index+1).map((row,offset)=>{const object={};headers.forEach((header,index)=>object[header]=row[index]);const get=field=>mapping[field]?object[mapping[field]]:null,allText=row.map(text).filter(Boolean);if(!allText.length)return null;const message=text(get('message'))||(best.score<2?allText.join(' | '):null);if(!message)return null;const severity=/^blocking$/i.test(text(get('severity'))||'')?'Blocking':/^note$/i.test(text(get('severity'))||'')?'Note':'Warning',status=/resolved/i.test(text(get('status'))||'')?'Resolved':'Unresolved',project={id:null,projectNumber:text(get('projectNumber')),projectName:text(get('projectName'))||'Unknown project',consultant:normalizeConsultantName(text(get('consultant'))),squareFeet:numeric(get('squareFeet'))};
    return makeIssue(project,{discipline:text(get('discipline'))||titleCase(type),category:text(get('category'))||'Imported spreadsheet note',message,detailedNote:text(get('detailedNote')),severity,status,createdAt:text(get('dateRecorded'))||new Date().toISOString(),updatedAt:new Date().toISOString(),recordedBy:text(get('recordedBy')),source:'Imported ERRORS sheet',sourceSheet:sheetName,sourceWorkbook:workbookName,originalRow:best.index+offset+2,originalText:allText.join(' | '),autoDetected:false})
  }).filter(Boolean);
}

function fieldCell(row,mapping,headers,field){const header=mapping[field],index=header?headers.indexOf(header):-1,raw=index>=0?row.__cells[index]:null;return{raw,header,index,column:index>=0?columnName(index):null}}
function traceFor(field,cell,parsed,row,source,method){return{field,workbook:source.workbookName,sheet:source.sheetName,row:row.__row,column:cell.column,originalValue:cell.raw??null,parsedValue:parsed??null,parsingMethod:method}}
function addTrace(target,trace){if(trace.originalValue!==null&&trace.originalValue!=='')target.sourceTrace.push(trace)}
function sum(values){return values.filter(Number.isFinite).reduce((total,value)=>total+value,0)}
function valuesClose(a,b,tolerance){return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tolerance}
function looksHeaderRow(row,headers){const values=row.__cells.map(key).filter(Boolean);if(values.length<2)return false;const headerTokens=headers.map(key);return values.filter(value=>headerTokens.some(header=>header===value||header.includes(value))).length>=Math.max(2,Math.ceil(values.length*.6))}
function looksEquipmentTag(value){return /\b(?:RTU|AHU|FCU|CU|HP|DOAS|MAU|VAV|EF|ERV|VRF|VRV)(?:\b|[-_\d])/i.test(text(value)||'')||/[A-Za-z]{2,}[-_ ]?\d+[A-Za-z]?\b/.test(text(value)||'')}
function rowTotalInfo(row){const cells=row.__cells.map(value=>text(value));for(let index=0;index<cells.length;index++){if(!isTotalLabel(cells[index]))continue;const label=normalizedLabel(cells[index]);let value=null,valueIndex=-1;for(let next=index+1;next<Math.min(cells.length,index+4);next++){const parsed=numeric(row.__cells[next]);if(parsed!==null){value=parsed;valueIndex=next;break}}return{isTotal:true,label,value,valueIndex,labelIndex:index}}
  return{isTotal:false,label:null,value:null,valueIndex:-1,labelIndex:-1};
}
function metricKind(label,type){if(/duct|linear|\blf\b/.test(label))return'ductFeet';if(/panel/.test(label))return'panelCount';if(/unit|equipment count/.test(label))return'unitCount';return type==='electrical'?'panelCount':'tonnage'}
function recordStated(project,kind,value,trace){if(!Number.isFinite(value))return;(project.__stated[kind]??=[]).push({value,trace})}


function createProject(identity, source, type) {
  const importedSquareFeet = identity.squareFeet ?? null;

  return {
    id:
      identity.projectNumber ||
      `import-${String(identity.projectName || "project")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`,

    projectNumber: identity.projectNumber,
    projectName: identity.projectName || "Unnamed project",
    buildingType: identity.buildingType || "Unknown",
    consultant: normalizeConsultantName(identity.consultant),

    // Shared value remains available for projects with only one source.
    squareFeet: importedSquareFeet,

    mechanical: {
      consultant:
        type === "mechanical"
          ? normalizeConsultantName(identity.consultant)
          : null,
      
      squareFeet:
        type === "mechanical"
          ? importedSquareFeet
          :null,

      units: [],
      unitCount: null,
      totalTonnage: null,
      totalDuctFeet: null,
      totals: {}
    },

    electrical: {
      consultant:
        type === "electrical"
          ? normalizeConsultantName(identity.consultant)
          : null,

      squareFeet:
        type === "electrical"
          ? importedSquareFeet
          : null,

      panels: [],
      disconnects: [],
      panelCount: null,
      serviceInfo: null,
      notes: null,
      totals: {}
    },

    squareFeetConflict: null,

    notes: [],
    importedNotes: [],
    quality: [],
    dataQualityStatus: "Unknown",
    analysisReviewRequired: false,
    excludedFromAnalysis: false,
    provenance: {},
    sourceTrace: [],
    sourceRows: [],

    __stated: {
      tonnage: [],
      ductFeet: [],
      unitCount: [],
      panelCount: []
    },

    audit: {
      createdAt: null,
      updatedAt: null,
      sourceType: `Spreadsheet import: ${source.workbookName}`,
      enteredBy: null,
      origin: "import"
    }
  };
}

function rowProjectNumber(row,mapping,headers){const mapped=fieldCell(row,mapping,headers,'projectNumber');if(validProjectNumber(mapped.raw))return{value:cleaned(mapped.raw),cell:mapped};for(let index=0;index<row.__cells.length;index++){if(validProjectNumber(row.__cells[index]))return{value:cleaned(row.__cells[index]),cell:{raw:row.__cells[index],header:headers[index],index,column:columnName(index)}}}return null}

function splitProjectBlocks(rows, mapping, headers) {
  const dataRows = rows.filter(
    row =>
      row.__cells.some(value => text(value)) &&
      !looksHeaderRow(row, headers)
  );

  const strict = dataRows.some(row =>
    Boolean(rowProjectNumber(row, mapping, headers))
  );

  const blocks = [];
  let current = null;
  const orphanRows = [];

  function rowContainsTotal(row) {
    if (!row) return false;

    return row.__cells.some(value => {
      const normalized = String(text(value) || "")
        .trim()
        .toLowerCase();

      return /^(total|project total|grand total|total lf|total panels?)\s*:?$/.test(
        normalized
      );
    });
  }

  function rowHasProjectIdentity(row) {
    if (!row) return false;

    const projectNumberCell = fieldCell(
      row,
      mapping,
      headers,
      "projectNumber"
    );

    const projectNameCell = fieldCell(
      row,
      mapping,
      headers,
      "projectName"
    );

    return Boolean(
      text(projectNumberCell.raw) ||
      text(projectNameCell.raw)
    );
  }

  function rowHasProjectOrEquipmentData(row) {
    if (!row) return false;

    const fieldsToCheck = [
      "consultant",
      "squareFeet",

      "unitName",
      "tonnage",
      "unitType",
      "ductFeet",
      "manufacturer",
      "model",

      "disconnectName",
      "disconnectAmps",
      "panelName",
      "panelLoadKva",
      "panelAmps"
    ];

    return fieldsToCheck.some(field => {
      if (!mapping[field]) return false;

      const cell = fieldCell(row, mapping, headers, field);
      return text(cell.raw) !== null;
    });
  }

  for (const row of dataRows) {
    let number = rowProjectNumber(row, mapping, headers);

    if (!strict && !number) {
      const mappedNumber = fieldCell(
        row,
        mapping,
        headers,
        "projectNumber"
      );

      const mappedName = fieldCell(
        row,
        mapping,
        headers,
        "projectName"
      );

      const fallback =
        text(mappedNumber.raw) ||
        text(mappedName.raw);

      if (fallback) {
        number = {
          value:
            text(mappedNumber.raw) ||
            text(mappedName.raw),

          cell: text(mappedNumber.raw)
            ? mappedNumber
            : mappedName
        };
      }
    }

    if (
      number &&
      (!current || current.projectNumber !== number.value)
    ) {
      let carryForwardRow = null;

      if (current && current.rows.length >= 2) {
        const candidate =
          current.rows[current.rows.length - 1];

        const precedingRow =
          current.rows[current.rows.length - 2];

        const shouldCarryForward =
          rowContainsTotal(precedingRow) &&
          !rowHasProjectIdentity(candidate) &&
          rowHasProjectOrEquipmentData(candidate);

        if (shouldCarryForward) {
          carryForwardRow = current.rows.pop();
        }
      }

      if (current) {
        blocks.push(current);
      }

      current = {
        projectNumber: number.value,
        projectNumberCell: number.cell,
        projectNumberRow: row.__row,
        rows: carryForwardRow
          ? [carryForwardRow, row]
          : [row]
      };

      continue;
    }

    if (current) {
      current.rows.push(row);
    } else {
      orphanRows.push(row.__row);
    }
  }

  if (current) {
    blocks.push(current);
  }

  return {
    blocks,
    orphanRows,
    strictProjectNumbers: strict
  };
}

function mappedCandidates(block,mapping,headers,field,parser=value=>text(value),validator=()=>true){const candidates=[];for(const row of block.rows){const cell=fieldCell(row,mapping,headers,field),raw=text(cell.raw);if(!raw||isUnknownValue(cell.raw)||ratioSummary(cell.raw))continue;const parsed=parser(cell.raw);if(parsed===null||parsed===undefined||parsed===''||!validator(parsed,cell,row))continue;candidates.push({raw:cell.raw,parsed,row:row.__row,cell,trace:traceFor(field,cell,parsed,row,{workbookName:block.workbookName,sheetName:block.sheetName},'project block mapped field')})}return candidates}
function chooseCompleteText(candidates){if(!candidates.length)return null;let chosen=candidates[0];for(const candidate of candidates.slice(1)){const first=key(chosen.parsed),later=key(candidate.parsed);if(later.length>first.length&&(later.includes(first)||first.includes(later)))chosen=candidate}return chosen}
function chooseRepeatedNumber(candidates){if(!candidates.length)return{chosen:null,values:[],conflict:false};const counts=new Map();for(const candidate of candidates)counts.set(candidate.parsed,(counts.get(candidate.parsed)||0)+1);const values=[...counts.keys()],max=Math.max(...counts.values()),winner=values.find(value=>counts.get(value)===max);return{chosen:candidates.find(candidate=>candidate.parsed===winner),values,conflict:values.length>1}}
function strongProjectName(value){const raw=text(value);return Boolean(raw)&&!isTotalLabel(raw)&&!looksEquipmentTag(raw)&&!ratioSummary(raw)&&!/^(?:error|issue|note|unknown|tbd)$/i.test(raw)&&!/^(?:carrier|trane|lennox|york|daikin|mitsubishi|aaon)$/i.test(raw)&&!/(?:\bexisting\b|\bserving\b|\bvav\b|no mechanical|no electrical|not sure|fill in info)/i.test(raw)}
function looksLikeProjectNote(value){const raw=text(value);return Boolean(raw)&&raw.length>=8&&!validProjectNumber(raw)&&!looksEquipmentTag(raw)&&!isTotalLabel(raw)&&!ratioSummary(raw)&&!/^[\d,\.]+$/.test(raw)}
function buildingTypeValue(value){const raw=text(value);return Boolean(raw)&&raw.length<=60&&!/\b(?:existing|rtu|ahu|fcu|vav|duct|tons?|equipment|not sure|fill in|no mechanical|no electrical)\b/i.test(raw)&&!ratioSummary(raw)}

function inferBuildingType(projectName) {
  const name = key(projectName);

  if (!name) return null;

  if (
    /\bmedical office\b|\bmedical center\b|\bmob\b/.test(name)
  ) {
    return "Medical Office";
  }

  if (
    /\bclinic\b|\bchiropractic\b|\bveterinary\b|\bwellness\b|\bbehavioral health\b/.test(name)
  ) {
    return "Healthcare";
  }

  if (
    /\bfire station\b|\bpolice station\b|\bpublic safety\b/.test(name)
  ) {
    return "Public Safety";
  }

  if (
    /\bschool\b|\bacademy\b|\binstitute\b|\buniversity\b|\bcollege\b|\bstisd\b/.test(name)
  ) {
    return "Education";
  }

  if (
    /\bstorage\b|\bwarehouse\b|\bindustrial\b/.test(name)
  ) {
    return "Storage / Industrial";
  }

  if (
    /\brestaurant\b|\bsmoothie\b|\bcafe\b|\bcoffee\b|\bfood\b/.test(name)
  ) {
    return "Restaurant / Food Service";
  }

  if (
    /\bretail\b|\bplaza\b|\bshopping\b|\bstore\b|\bfinish out\b|\btenant\b/.test(name)
  ) {
    return "Retail / Tenant Finish-Out";
  }

  if (
    /\boffice\b|\blaw office\b|\bcorporate\b|\bheadquarters\b|\bhq\b/.test(name)
  ) {
    return "Office";
  }

  if (
    /\bbank\b|\bcredit union\b|\bfinancial\b/.test(name)
  ) {
    return "Financial";
  }

  if (
    /\bchurch\b|\bchapel\b|\bministry\b|\bworship\b/.test(name)
  ) {
    return "Religious";
  }

  if (
    /\bpublic works\b|\bcity of\b|\bcounty\b|\bmunicipal\b|\bgovernment\b/.test(name)
  ) {
    return "Government / Civic";
  }

  if (
    /\bresidential\b|\bapartment\b|\bhousing\b|\bmultifamily\b/.test(name)
  ) {
    return "Residential";
  }

  return null;
}

function findFallbackProjectName(block,mapping,headers){const mappedIndex=mapping.projectNumber?headers.indexOf(mapping.projectNumber):block.projectNumberCell.index;for(const row of block.rows){for(let index=Math.max(0,mappedIndex-1);index<=Math.min(row.__cells.length-1,mappedIndex+3);index++){if(index===mappedIndex)continue;const value=row.__cells[index];if(strongProjectName(value))return{raw:value,parsed:text(value),row:row.__row,cell:{raw:value,header:headers[index],index,column:columnName(index)},trace:traceFor('projectName',{raw:value,column:columnName(index)},text(value),row,{workbookName:block.workbookName,sheetName:block.sheetName},'project block adjacent field')}}}return null}
function candidateConsultants(block,mapping,headers,source){const manufacturers=new Set(block.rows.flatMap(row=>[fieldCell(row,mapping,headers,'manufacturer').raw,fieldCell(row,mapping,headers,'electricalManufacturer').raw]).map(value=>key(value)).filter(Boolean)),known=new Set([...(source.knownConsultants||[]),'Trinity','MEP Solutions Engineering','Cleary Zimmerman','A&G','DBR','DBR Engineering'].map(consultantKey));const valid=value=>{const normalized=key(value);return Boolean(normalized)&&!manufacturers.has(normalized)&&!looksEquipmentTag(value)&&!ratioSummary(value)&&!/^(?:carrier|trane|lennox|york|daikin|mitsubishi|aaon|rheem|goodman|bryant)$/i.test(text(value)||'')};let candidates=mappedCandidates(block,mapping,headers,'consultant',value=>normalizeConsultantName(text(value)),valid);if(!candidates.length){for(const row of block.rows)for(let index=0;index<row.__cells.length;index++){const value=text(row.__cells[index]);if(value&&known.has(consultantKey(value))&&valid(value)){const cell={raw:row.__cells[index],header:headers[index],index,column:columnName(index)};candidates.push({raw:cell.raw,parsed:normalizeConsultantName(value),row:row.__row,cell,trace:traceFor('consultant',cell,normalizeConsultantName(value),row,source,'known consultant found in project block')})}}}return candidates}


function addIdentityConflict(
  project,
  field,
  values,
  collections
) {
  const isSquareFeet = field === "squareFeet";

  const label = isSquareFeet
    ? "overall square footage"
    : "MEP consultant";

  const formattedValues = isSquareFeet
    ? values
        .map(value => `${Number(value).toLocaleString()} SF`)
        .join(" and ")
    : values.join(", ");

  const message =
    `The project block contains conflicting ${label} values: ` +
    `${formattedValues}. Manual confirmation is required.`;

  project.identityReviewRequired = true;
  project.analysisReviewRequired = true;

  project.quality = [
    ...new Set([
      ...(project.quality || []),
      message
    ])
  ];

  collections.interpretedIssues.push(
    makeIssue(project, {
      discipline: "General",
      category: "Conflicting values",
      message,

      detailedNote: isSquareFeet
        ? "No square-footage value was selected for analysis. Both source values were preserved."
        : "All source values were preserved for staff review.",

      severity: "Warning",
      status: "Unresolved",
      source: "Import project-block comparison",
      autoDetected: true
    })
  );
}


function collectExtraNotes(project,block,mapping,headers,source,collections,parsedNoteKeys){const projectColumn=block.projectNumberCell.index,notes=[];for(const row of block.rows){for(let index=0;index<projectColumn;index++){const raw=text(row.__cells[index]);if(!looksLikeProjectNote(raw))continue;const noteKey=`${row.__row}|${key(raw)}`;if(parsedNoteKeys.has(noteKey))continue;notes.push({text:raw,row,column:columnName(index),method:'left-side project note'})}const mappedBuilding=fieldCell(row,mapping,headers,'buildingType');if(text(mappedBuilding.raw)&&!buildingTypeValue(mappedBuilding.raw)&&looksLikeProjectNote(mappedBuilding.raw))notes.push({text:text(mappedBuilding.raw),row,column:mappedBuilding.column,method:'non-building-type text preserved as note'});for(let index=0;index<row.__cells.length;index++){const raw=text(row.__cells[index]);if(ratioSummary(raw))project.importDiagnostics.ignoredSummaryCells.push({row:row.__row,column:columnName(index),originalText:raw})}}
  for(const note of notes){const noteKey=`${note.row.__row}|${key(note.text)}`;if(parsedNoteKeys.has(noteKey))continue;parsedNoteKeys.add(noteKey);handleNote(project,note.text,note.row,source,titleCase(source.type),collections,null);project.importDiagnostics.notesRows.push(note.row.__row);project.sourceTrace.push({field:'notes',workbook:source.workbookName,sheet:source.sheetName,row:note.row.__row,column:note.column,originalValue:note.text,parsedValue:note.text,parsingMethod:note.method})}}

function normalizeRows(
  rows,
  mapping,
  type,
  source = {
    workbookName: "Uploaded workbook",
    sheetName: "Sheet1",
    headers: []
  }
) {
  const headers = source.headers || [];
  const errors = [];
  const interpretedIssues = [];
  const importedNotes = [];

  const collections = {
    interpretedIssues,
    importedNotes
  };

  const segmented = splitProjectBlocks(
    rows,
    mapping,
    headers
  );

  const records = [];
  let equipmentCount = 0;

  if (segmented.orphanRows.length) {
    errors.push(
      `${segmented.orphanRows.length} row(s) before the first valid project number were not assigned to a project block.`
    );
  }

  for (const rawBlock of segmented.blocks) {
    const block = {
      ...rawBlock,
      workbookName: source.workbookName,
      sheetName: source.sheetName
    };

    const projectNameCandidates = mappedCandidates(
      block,
      mapping,
      headers,
      "projectName",
      value => text(value),
      strongProjectName
    );

    const projectName =
      chooseCompleteText(projectNameCandidates) ||
      findFallbackProjectName(
        block,
        mapping,
        headers
      );

    const consultantCandidates = candidateConsultants(
      block,
      mapping,
      headers,
      source
    );

    const consultantGroups = new Map();

    for (const candidate of consultantCandidates) {
      const normalized = consultantKey(
        candidate.parsed
      );

      if (!consultantGroups.has(normalized)) {
        consultantGroups.set(
          normalized,
          candidate
        );
      }
    }

    const consultants = [
      ...consultantGroups.values()
    ];

    const squareFeetCandidates = mappedCandidates(
      block,
      mapping,
      headers,
      "squareFeet",
      value => squareFeetNumeric(value),
      value =>
        Number.isFinite(value) &&
        value > 0
    );


    const mechanicalPhases =
      type === "mechanical"
        ? extractMechanicalPhases(
            block,
            mapping,
            headers
          )
        : [];

    const hasMechanicalPhases =
      mechanicalPhases.length > 0;

    
    const projectSummary =
      projectSummaryFromHeaderRow(block);

    const projectHeaderSfCandidate =
      squareFeetCandidates.find(
        candidate =>
          candidate.row ===
          block.projectNumberRow
      );

    const summarySfCandidate =
      projectSummary &&
      Number.isFinite(projectSummary.squareFeet) &&
      projectSummary.squareFeet > 0
        ? {
            parsed: projectSummary.squareFeet,
            row: projectSummary.row,
            cell: {
              raw: projectSummary.originalValue,
              header: null,
              index: projectSummary.index,
              column: projectSummary.column
            },
            trace: {
              field: "squareFeet",
              workbook: source.workbookName,
              sheet: source.sheetName,
              row: projectSummary.row,
              column: projectSummary.column,
              originalValue:
                projectSummary.originalValue,
              parsedValue:
                projectSummary.squareFeet,
              parsingMethod:
                "project-header SF : tonnage : duct LF summary"
            }
          }
        : null;

    const chosenProjectSf =
      projectHeaderSfCandidate ||
      summarySfCandidate;

    const sfResult = hasMechanicalPhases
      ? {
          chosen: null,
          values: [],
          conflict: false
        }
      : chosenProjectSf
        ? {
            chosen: chosenProjectSf,
            values: [chosenProjectSf.parsed],
            conflict: false
          }
        : chooseRepeatedNumber(
            squareFeetCandidates
          );
        
        

    const buildingCandidates = mappedCandidates(
      block,
      mapping,
      headers,
      "buildingType",
      value => text(value),
      buildingTypeValue
    );

    const buildingType = chooseCompleteText(
      buildingCandidates
    );

    const inferredBuildingType =
      buildingType?.parsed
        ? null
        : inferBuildingType(projectName?.parsed);

    const identity = {
      projectNumber: block.projectNumber,

      projectName:
        projectName?.parsed ||
        "Unnamed project",

      consultant:
        consultants[0]?.parsed ||
        null,

      buildingType:
        buildingType?.parsed ||
        inferredBuildingType ||
        null,

      // Do not select a value when the workbook itself
      // contains conflicting project square footage.
      squareFeet: sfResult.conflict
        ? null
        : sfResult.chosen?.parsed ?? null
    };

    const project = createProject(
      identity,
      source,
      type
    );

    if (type === "mechanical") {
      project.mechanical.consultant =
        normalizeConsultantName(identity.consultant);
    }

    if (type === "electrical") {
      project.electrical.consultant =
        normalizeConsultantName(identity.consultant);
    }

    if (type === "mechanical" && hasMechanicalPhases) {
      project.mechanical.phases = mechanicalPhases;

      project.mechanical.squareFeet = null;
      project.squareFeet = null;

      project.quality.push(
        "Project contains phase-specific square footage but no confirmed overall project square footage."
      );
    }

    if (
      type === "mechanical" &&
      projectSummary
    ) {
      // recordStated tonnage and ductwork block
    }

    project.identityReviewRequired = false;

    project.blockFieldCandidates = {
      projectName:
        projectNameCandidates.map(item => ({
          value: item.parsed,
          row: item.row,
          column: item.cell.column
        })),

      consultant:
        consultantCandidates.map(item => ({
          value: item.parsed,
          row: item.row,
          column: item.cell.column
        })),

      squareFeet:
        squareFeetCandidates.map(item => ({
          value: item.parsed,
          row: item.row,
          column: item.cell.column
        })),

      buildingType:
        buildingCandidates.map(item => ({
          value: item.parsed,
          row: item.row,
          column: item.cell.column
        }))
    };

    project.importDiagnostics = {
      blockStartRow:
        block.rows[0].__row,

      blockEndRow:
        block.rows.at(-1).__row,

      projectNumberSourceRow:
        block.projectNumberRow,

      projectNameSourceRow:
        projectName?.row || null,

      consultantSourceRow:
        consultants[0]?.row || null,

      squareFeetSourceRow:
        sfResult.conflict
          ? null
          : sfResult.chosen?.row || null,

      buildingTypeSourceRow:
        buildingType?.row ||
        projectName?.row ||
        null,

      equipmentRows: [],
      totalRows: [],
      notesRows: [],
      ignoredSummaryCells: []
    };

    addTrace(
      project,
      traceFor(
        "projectNumber",
        block.projectNumberCell,
        block.projectNumber,
        block.rows[0],
        source,
        "project block start"
      )
    );

    if (projectName) {
      addTrace(
        project,
        projectName.trace
      );
    }

    if (consultants[0]) {
      addTrace(
        project,
        consultants[0].trace
      );
    }

    if (!sfResult.conflict && sfResult.chosen) {
      addTrace(
        project,
        sfResult.chosen.trace
      );
    }


    if (buildingType) {
      addTrace(
        project,
        buildingType.trace
      );
    } else if (inferredBuildingType) {
      project.sourceTrace.push({
        field: "buildingType",
        workbook: source.workbookName,
        sheet: source.sheetName,
        row: projectName?.row || block.projectNumberRow,
        column: projectName?.cell?.column || null,
        originalValue: projectName?.parsed || null,
        parsedValue: inferredBuildingType,
        parsingMethod: "inferred conservatively from project name"
      });

      project.provenance.buildingType =
        "Inferred from project name";
    }


    if (consultants.length > 1) {
      addIdentityConflict(
        project,
        "consultant",
        consultants.map(
          item => item.parsed
        ),
        collections
      );
    }

    if (
      sfResult.conflict &&
      !hasMechanicalPhases
    ) {
      project.squareFeetSourceConflict = {
        discipline: type,

        values: sfResult.values,

        candidates:
          squareFeetCandidates.map(
            candidate => ({
              value: candidate.parsed,
              row: candidate.row,
              column: candidate.cell.column,
              workbook: source.workbookName,
              sheet: source.sheetName
            })
          ),

        status: "Review Needed",
        selectedValue: null,

        message:
          `The ${type} workbook contains conflicting square footage values: ` +
          `${sfResult.values
            .map(
              value =>
                `${Number(value).toLocaleString()} SF`
            )
            .join(" and ")}.`
      };

      project.squareFeet = null;

      if (type === "mechanical") {
        project.mechanical.squareFeet = null;
      } else {
        project.electrical.squareFeet = null;
      }

      addIdentityConflict(
        project,
        "squareFeet",
        sfResult.values,
        collections
      );

      for (const candidate of squareFeetCandidates) {
        project.sourceTrace.push(
          traceFor(
            "squareFeetConflict",
            candidate.cell,
            candidate.parsed,
            block.rows.find(
              row =>
                row.__row === candidate.row
            ) || block.rows[0],
            source,
            "conflicting square footage preserved for review"
          )
        );
      }
    }

    /*
    * Phased Mechanical projects contain several legitimate
    * square-footage values. They should not be treated as
    * alternative overall-project SF values.
    */
    if (
      type === "mechanical" &&
      hasMechanicalPhases
    ) {
      project.squareFeetSourceConflict = null;
      project.squareFeetConflict = null;

      project.squareFeet = null;
      project.mechanical.squareFeet = null;

      project.quality = [
        ...new Set([
          ...(project.quality || []).filter(
            message =>
              !/conflicting square footage|square-footage values|sf conflict/i.test(
                String(message)
              )
          ),

          "Phase-based project: square footage is recorded separately by phase."
        ])
      ];
    }
    
    const parsedNoteKeys = new Set();

    const unknownSquareFeet =
      block.rows
        .map(row => ({
          row,
          cell: fieldCell(
            row,
            mapping,
            headers,
            "squareFeet"
          )
        }))
        .filter(item =>
          isUnknownValue(
            item.cell.raw
          )
        );

    for (const item of unknownSquareFeet) {
      const note =
        `Overall SF: ${text(item.cell.raw)}`;

      handleNote(
        project,
        note,
        item.row,
        source,
        "General",
        collections,
        null
      );

      parsedNoteKeys.add(
        `${item.row.__row}|${key(note)}`
      );

      project.importDiagnostics.notesRows.push(
        item.row.__row
      );

      project.sourceTrace.push(
        traceFor(
          "squareFeet",
          item.cell,
          null,
          item.row,
          source,
          "unknown placeholder preserved"
        )
      );
    }

    for (const row of block.rows) {
      project.sourceRows.push(row.__row);

      const cells = Object.fromEntries(
        fieldsFor(type).map(field => [
          field,
          fieldCell(
            row,
            mapping,
            headers,
            field
          )
        ])
      );

      const total = rowTotalInfo(row);

      const before =
        type === "mechanical"
          ? project.mechanical.units.length
          : project.electrical.panels.length;

      if (type === "mechanical") {
        parseMechanicalRow(
          project,
          row,
          cells,
          total,
          source,
          collections
        );
      } else {
        parseElectricalRow(
          project,
          row,
          cells,
          total,
          source,
          collections
        );
      }

      const after =
        type === "mechanical"
          ? project.mechanical.units.length
          : project.electrical.panels.length;

      if (after > before) {
        equipmentCount += after - before;

        project.importDiagnostics
          .equipmentRows
          .push(row.__row);
      }

      if (total.isTotal) {
        project.importDiagnostics
          .totalRows
          .push(row.__row);
      }

      const mappedNote = text(
        cells.notes?.raw
      );

      if (
        mappedNote &&
        !ratioSummary(mappedNote)
      ) {
        parsedNoteKeys.add(
          `${row.__row}|${key(mappedNote)}`
        );

        project.importDiagnostics
          .notesRows
          .push(row.__row);
      }
    }

    collectExtraNotes(
      project,
      block,
      mapping,
      headers,
      {
        ...source,
        type
      },
      collections,
      parsedNoteKeys
    );

    finalizeProject(
      project,
      type,
      collections
    );

    records.push(project);
  }

  return {
    records: canonicalizeConsultants(
      records.map(project => {
        delete project.__stated;
        return project;
      })
    ),

    errors,
    equipmentCount,
    interpretedIssues,
    importedNotes,
    blockCount:
      segmented.blocks.length
  };
}



function parseMechanicalRow(
  project,
  row,
  cells,
  total,
  source,
  collections
) {
  const directProjectTonnage = numeric(
    cells.projectTonnage.raw
  );

  const directProjectDuct = numeric(
    cells.projectDuctFeet.raw
  );

  if (directProjectTonnage !== null) {
    recordStated(
      project,
      "tonnage",
      directProjectTonnage,
      traceFor(
        "mechanical.totals.tonnage.stated",
        cells.projectTonnage,
        directProjectTonnage,
        row,
        source,
        "direct mapped field"
      )
    );
  }

  if (directProjectDuct !== null) {
    recordStated(
      project,
      "ductFeet",
      directProjectDuct,
      traceFor(
        "mechanical.totals.ductFeet.stated",
        cells.projectDuctFeet,
        directProjectDuct,
        row,
        source,
        "direct mapped field"
      )
    );
  }

  const tag = text(cells.unitName.raw);
  const tonnage = numeric(cells.tonnage.raw);
  const quantity = numeric(cells.quantity.raw);
  const manufacturer = text(cells.manufacturer.raw);
  const model = text(cells.model.raw);
  const originalType = text(cells.unitType.raw);
  const ductFeet = numeric(cells.ductFeet.raw);

  const classification =
    text(cells.classification.raw) ||
    inferClassification(cells.notes.raw);

  const note = ratioSummary(cells.notes.raw)
    ? null
    : text(cells.notes.raw);

  const typeInfo = normalizeEquipmentType(
    originalType,
    tag
  );

  const hasEquipmentSignal =
    looksEquipmentTag(tag) ||
    Boolean(
      originalType ||
      manufacturer ||
      model
    ) ||
    (
      quantity !== null &&
      (
        tonnage !== null ||
        ductFeet !== null
      )
    );

  /*
   * A spreadsheet row can contain both a project-level TOTAL
   * label and legitimate equipment information.
   *
   * Example:
   * "GRAND TOTAL: 1,850 SF" and "CWFC-1" occupy the same row.
   *
   * Record relevant totals, but only return early when the row
   * does not also contain actual equipment.
   */
  if (total.isTotal) {
    const mappedTotals = [
      ["tonnage", cells.tonnage],
      ["ductFeet", cells.ductFeet],
      ["unitCount", cells.quantity]
    ];

    /*
     * Do not treat the equipment values on a mixed total/equipment
     * row as project totals. They belong to the listed equipment.
     */
    if (!hasEquipmentSignal) {
      const available = mappedTotals.filter(
        ([, cell]) =>
          numeric(cell.raw) !== null
      );

      if (available.length) {
        for (const [kind, cell] of available) {
          const value = numeric(cell.raw);

          recordStated(
            project,
            kind,
            value,
            traceFor(
              `mechanical.totals.${kind}.stated`,
              cell,
              value,
              row,
              source,
              "detected total"
            )
          );
        }
      } else {
        const kind = metricKind(
          total.label,
          "mechanical"
        );

        const cell =
          kind === "ductFeet"
            ? cells.ductFeet
            : kind === "unitCount"
              ? cells.quantity
              : cells.tonnage;

        recordStated(
          project,
          kind,
          total.value,
          traceFor(
            `mechanical.totals.${kind}.stated`,
            cell,
            total.value,
            row,
            source,
            "detected neighboring total"
          )
        );
      }

      return;
    }
  }

  if (hasEquipmentSignal) {
    const unit = {
      name: tag,
      originalType: typeInfo.originalType,
      normalizedType:
        typeInfo.normalizedType,
      type: typeInfo.normalizedType,
      matchedTypeCode:
        typeInfo.matchedCode,
      tonnage,

      quantity:
        quantity !== null &&
        quantity > 0
          ? quantity
          : 1,

      manufacturer,
      model,
      ductFeet,
      classification,
      notes: note,
      sourceRow: row.__row,
      sourceSheet: source.sheetName,
      sourceWorkbook:
        source.workbookName,
      sourceTrace: []
    };

    const traceFields = [
      [
        "name",
        tag,
        looksEquipmentTag(tag)
          ? "normalized label"
          : "direct mapped field"
      ],
      [
        "originalType",
        originalType,
        "direct mapped field"
      ],
      [
        "normalizedType",
        typeInfo.normalizedType,
        typeInfo.method
      ],
      [
        "tonnage",
        tonnage,
        "direct mapped field"
      ],
      [
        "quantity",
        unit.quantity,
        quantity === null
          ? "default quantity 1"
          : "direct mapped field"
      ],
      [
        "manufacturer",
        manufacturer,
        "direct mapped field"
      ],
      [
        "model",
        model,
        "direct mapped field"
      ],
      [
        "ductFeet",
        ductFeet,
        "direct mapped field"
      ],
      [
        "classification",
        classification,
        "direct mapped field"
      ],
      [
        "notes",
        note,
        "direct mapped field"
      ]
    ];

    for (
      const [field, parsed, method]
      of traceFields
    ) {
      const sourceCell =
        field === "name"
          ? cells.unitName
          : field === "originalType" ||
              field === "normalizedType"
            ? cells.unitType
            : field === "tonnage"
              ? cells.tonnage
              : field === "quantity"
                ? cells.quantity
                : field === "manufacturer"
                  ? cells.manufacturer
                  : field === "model"
                    ? cells.model
                    : field === "ductFeet"
                      ? cells.ductFeet
                      : field === "classification"
                        ? cells.classification
                        : cells.notes;

      if (sourceCell) {
        addTrace(
          unit,
          traceFor(
            `mechanical.units.${field}`,
            sourceCell,
            parsed,
            row,
            source,
            method
          )
        );
      }
    }

    project.mechanical.units.push(unit);
  } else if (tonnage !== null) {
    recordStated(
      project,
      "tonnage",
      tonnage,
      traceFor(
        "mechanical.totals.tonnage.stated",
        cells.tonnage,
        tonnage,
        row,
        source,
        "single project-level value"
      )
    );
  }

  handleNote(
    project,
    note,
    row,
    source,
    "Mechanical",
    collections,
    hasEquipmentSignal
      ? project.mechanical.units.at(-1)
      : null
  );
}




function parseElectricalRow(
  project,
  row,
  cells,
  total,
  source,
  collections
) {
  const directTotal = numeric(cells.projectPanelTotal.raw);

  if (directTotal !== null) {
    recordStated(
      project,
      'panelCount',
      directTotal,
      traceFor(
        'electrical.totals.panelCount.stated',
        cells.projectPanelTotal,
        directTotal,
        row,
        source,
        'direct mapped field'
      )
    );
  }

  if (total.isTotal) {
    const value =
      numeric(cells.panelCount.raw) ??
      numeric(cells.quantity.raw) ??
      total.value;

    recordStated(
      project,
      'panelCount',
      value,
      traceFor(
        'electrical.totals.panelCount.stated',
        cells.panelCount,
        value,
        row,
        source,
        'detected total'
      )
    );

    return;
  }

  const rawDisconnectName = text(cells.disconnectName.raw);

  const disconnectName =
    rawDisconnectName &&
    /^(disconnect info|disconnects?)$/i.test(rawDisconnectName.trim())
      ? null
      : rawDisconnectName;

  const disconnectAmps = numeric(cells.disconnectAmps.raw);

  const rawPanelName = text(cells.panelName.raw);

  const panelName =
    rawPanelName &&
    /^(panel info|panels?)$/i.test(rawPanelName.trim())
      ? null
      : rawPanelName;

  const panelType = text(cells.panelType.raw);
  
  
  
  const panelLoadKva = numeric(cells.panelLoadKva.raw);
  const panelAmps = numeric(cells.panelAmps.raw);

  const quantity =
    numeric(cells.panelCount.raw) ??
    numeric(cells.quantity.raw);

  const serviceInfo = text(cells.serviceInfo.raw);
  const rating = text(cells.rating.raw);
  const manufacturer = text(cells.electricalManufacturer.raw);
  const model = text(cells.electricalModel.raw);

  const note = ratioSummary(cells.notes.raw)
    ? null
    : text(cells.notes.raw);

  const hasPanelSignal = Boolean(
    panelName ||
    panelType ||
    panelLoadKva !== null ||
    panelAmps !== null
  );

  const hasDisconnectSignal = Boolean(
    disconnectName ||
    disconnectAmps !== null
  );

  const panelHeaderKey = key(cells.panelName.raw);
  const disconnectHeaderKey = key(cells.disconnectName.raw);

  const ignorePanelHeader = [
    "panel",
    "panels",
    "panel info"
  ].includes(panelHeaderKey);

  const ignoreDisconnectHeader = [
    "disconnect",
    "disconnects",
    "disconnect info"
  ].includes(disconnectHeaderKey);

  if (ignorePanelHeader && ignoreDisconnectHeader) {
    return;
  }


  let linkedEquipment = null;

  if (hasPanelSignal) {
    const panel = {
      name: panelName,
      panelName,
      type: panelType,

      quantity:
        quantity !== null && quantity > 0
          ? quantity
          : 1,

      count:
        quantity !== null && quantity > 0
          ? quantity
          : 1,

      disconnectName,
      disconnectAmps,
      panelLoadKva,
      panelAmps,

      serviceInfo,
      rating,
      manufacturer,
      model,
      notes: note,

      sourceRow: row.__row,
      sourceSheet: source.sheetName,
      sourceWorkbook: source.workbookName,
      sourceTrace: []
    };

    const traceFields = [
      ['panelName', cells.panelName, panelName],
      ['type', cells.panelType, panelType],
      ['quantity', cells.panelCount, panel.quantity],
      ['disconnectName', cells.disconnectName, disconnectName],
      ['disconnectAmps', cells.disconnectAmps, disconnectAmps],
      ['panelLoadKva', cells.panelLoadKva, panelLoadKva],
      ['panelAmps', cells.panelAmps, panelAmps],
      ['serviceInfo', cells.serviceInfo, serviceInfo],
      ['rating', cells.rating, rating],
      ['manufacturer', cells.electricalManufacturer, manufacturer],
      ['model', cells.electricalModel, model],
      ['notes', cells.notes, note]
    ];

    for (const [field, cell, parsed] of traceFields) {
      addTrace(
        panel,
        traceFor(
          `electrical.panels.${field}`,
          cell,
          parsed,
          row,
          source,
          field === 'quantity' && quantity === null
            ? 'default quantity 1'
            : 'direct mapped field'
        )
      );
    }

    project.electrical.panels.push(panel);
    linkedEquipment = panel;
  }

  if (hasDisconnectSignal && !hasPanelSignal) {
    const disconnect = {
      name: disconnectName,
      disconnectName,
      disconnectAmps,
      quantity:
        quantity !== null && quantity > 0
          ? quantity
          : 1,

      notes: note,
      sourceRow: row.__row,
      sourceSheet: source.sheetName,
      sourceWorkbook: source.workbookName,
      sourceTrace: []
    };

    addTrace(
      disconnect,
      traceFor(
        'electrical.disconnects.disconnectName',
        cells.disconnectName,
        disconnectName,
        row,
        source,
        'direct mapped field'
      )
    );

    addTrace(
      disconnect,
      traceFor(
        'electrical.disconnects.disconnectAmps',
        cells.disconnectAmps,
        disconnectAmps,
        row,
        source,
        'direct mapped field'
      )
    );

    project.electrical.disconnects.push(disconnect);
    linkedEquipment = disconnect;
  }

  if (
    !hasPanelSignal &&
    !hasDisconnectSignal &&
    quantity !== null
  ) {
    recordStated(
      project,
      'panelCount',
      quantity,
      traceFor(
        'electrical.totals.panelCount.stated',
        cells.panelCount,
        quantity,
        row,
        source,
        'single project-level value'
      )
    );
  }

  if (serviceInfo) {
    project.electrical.serviceInfo = [
      project.electrical.serviceInfo,
      serviceInfo
    ]
      .filter(Boolean)
      .join('; ');
  }

  handleNote(
    project,
    note,
    row,
    source,
    'Electrical',
    collections,
    linkedEquipment
  );

  if (note) {
    project.electrical.notes = [
      project.electrical.notes,
      note
    ]
      .filter(Boolean)
      .join('; ');
  }
}

function handleNote(project,note,row,source,discipline,collections,equipment){if(!note)return;project.notes.push(note);const interpreted=interpretNote(note,{projectId:project.id,projectNumber:project.projectNumber,projectName:project.projectName,discipline,sourceWorkbook:source.workbookName,sourceSheet:source.sheetName,sourceRow:row.__row});if(!interpreted)return;project.importedNotes.push(interpreted);collections.importedNotes.push(interpreted);for(const issue of interpreted.issues)collections.interpretedIssues.push(makeIssue(project,{discipline,category:issue.category,message:issue.message,detailedNote:note,severity:issue.severity,status:'Unresolved',source:'Suggested from imported note',sourceSheet:source.sheetName,sourceWorkbook:source.workbookName,originalRow:row.__row,originalText:note,autoDetected:true}));if(equipment&&interpreted.suggestedInterpretations.length)equipment.noteSuggestions=interpreted.suggestedInterpretations}

function chooseMetric(project,kind,calculated,tolerance,discipline){
  const statedEntries=project.__stated[kind]||[],statedValues=[...new Set(statedEntries.map(entry=>entry.value))],stated=statedValues.length?statedValues[0]:null,multipleStated=statedValues.length>1;let chosen=null,source='Unknown',verificationStatus='Unknown',analysisEligible=false,conflict=false,message=null;
  if(stated!==null&&Number.isFinite(calculated)){if(!multipleStated&&valuesClose(stated,calculated,tolerance)){chosen=stated;source='Verified spreadsheet total';verificationStatus='Verified';analysisEligible=true}else{chosen=stated;source='Spreadsheet stated total pending review';verificationStatus='Needs review';conflict=true;message=multipleStated?`The spreadsheet contains conflicting stated ${kind} totals: ${statedValues.join(', ')}.`:`Listed equipment totals ${calculated} ${kind==='tonnage'?'tons':kind==='ductFeet'?'feet':'items'}, but the spreadsheet states ${stated} ${kind==='tonnage'?'tons':kind==='ductFeet'?'feet':'items'}.`}}
  else if(stated!==null){chosen=stated;source='Stated spreadsheet total';verificationStatus='Stated total';analysisEligible=true}else if(Number.isFinite(calculated)){chosen=calculated;source='Calculated from listed equipment';verificationStatus='Calculated';analysisEligible=true}
  const calculatedTrace=kind==='panelCount'?(project.electrical.panels||[]).flatMap(item=>item.sourceTrace||[]):(project.mechanical.units||[]).flatMap(item=>item.sourceTrace||[]).filter(trace=>kind==='unitCount'?/quantity$/.test(trace.field):kind==='ductFeet'?/ductFeet$/.test(trace.field):/tonnage$/.test(trace.field));
  const result={stated,statedValues,calculated,chosen,source,verificationStatus,analysisEligible,conflict,tolerance,userChoice:null,reviewStatus:conflict?'Pending review':'Accepted',sourceTrace:{stated:statedEntries.map(entry=>entry.trace),calculated:calculatedTrace}};
  if(conflict){project.analysisReviewRequired=true;project.quality.push(message);project.__newIssues.push(makeIssue(project,{discipline,category:'Conflicting values',message,detailedNote:`Stated: ${statedValues.join(', ')}. Calculated: ${calculated}.`,severity:'Warning',status:'Unresolved',source:'Import total comparison',autoDetected:true}))}
  return result;
}

function finalizeProject(project,type,collections){project.__newIssues=[];
  if(type==='mechanical'){
    const units=project.mechanical.units,unitCount=units.length?sum(units.map(unit=>Number.isFinite(unit.quantity)?unit.quantity:1)):null,tonnages=units.filter(unit=>Number.isFinite(unit.tonnage)),ducts=units.filter(unit=>Number.isFinite(unit.ductFeet)),calculatedTonnage=tonnages.length?sum(tonnages.map(unit=>unit.tonnage*(unit.quantity||1))):null,calculatedDuct=ducts.length?sum(ducts.map(unit=>unit.ductFeet*(unit.quantity||1))):null;
    project.mechanical.totals.tonnage=chooseMetric(project,'tonnage',calculatedTonnage,.1,'Mechanical');project.mechanical.totals.ductFeet=chooseMetric(project,'ductFeet',calculatedDuct,1,'Mechanical');project.mechanical.totals.unitCount=chooseMetric(project,'unitCount',unitCount,0,'Mechanical');
    project.mechanical.totalTonnage=project.mechanical.totals.tonnage.analysisEligible?project.mechanical.totals.tonnage.chosen:null;project.mechanical.totalDuctFeet=project.mechanical.totals.ductFeet.analysisEligible?project.mechanical.totals.ductFeet.chosen:null;project.mechanical.unitCount=project.mechanical.totals.unitCount.analysisEligible?project.mechanical.totals.unitCount.chosen:unitCount;
  
    } else {
    const panels = project.electrical.panels || [];

    const calculated = panels.length
      ? sum(
          panels.map(panel =>
            Number.isFinite(Number(panel.quantity))
              ? Number(panel.quantity)
              : 1
          )
        )
      : null;

    project.electrical.totals.panelCount = chooseMetric(
      project,
      'panelCount',
      calculated,
      0,
      'Electrical'
    );

    project.electrical.panelCount =
      project.electrical.totals.panelCount.analysisEligible
        ? project.electrical.totals.panelCount.chosen
        : null;
    }
  
  collections.interpretedIssues.push(...project.__newIssues);delete project.__newIssues;
  if(!project.squareFeet)project.quality.push('Missing overall square footage.');if(!project.consultant||project.consultant==='Unknown')project.quality.push('Missing consultant.');if(!project.buildingType||project.buildingType==='Unknown')project.quality.push('Missing building type.');project.dataQualityStatus=project.analysisReviewRequired?'Needs review':project.excludedFromAnalysis?'Excluded':project.quality.length?'Warning':'Complete';project.notes=[...new Set(project.notes.filter(Boolean))];project.sourceRows=[...new Set(project.sourceRows)].sort((a,b)=>a-b);
}

function inferClassification(note){const normalized=key(note);if(normalized.includes('custom'))return'Custom';if(normalized.includes('unusual'))return'Unusual';return'Standard'}

function applyTotalDecision(project,metric,decision,correctedValue){
  const target=metric==='panelCount'?project.electrical?.totals?.panelCount:project.mechanical?.totals?.[metric];if(!target)throw new Error('The selected total could not be found.');let value=null,source='';
  if(decision==='stated'){value=target.stated;source='Manually confirmed stated spreadsheet total'}else if(decision==='calculated'){value=target.calculated;source='Manually confirmed calculated equipment sum'}else if(decision==='corrected'){value=numeric(correctedValue);source='Manually corrected during import'}else if(decision==='review'){value=null;source='Pending staff review'}else if(decision==='exclude'){value=null;source='Excluded during import review';project.excludedFromAnalysis=true}else throw new Error('Choose how the conflicting total should be handled.');
  if(['stated','calculated','corrected'].includes(decision)&&!Number.isFinite(value))throw new Error('The selected total is not a usable number.');target.chosen=value;target.source=source;target.userChoice=decision;target.reviewStatus=decision==='review'?'Pending review':'Manually confirmed';target.verificationStatus=decision==='review'?'Needs review':'Manually confirmed';target.analysisEligible=['stated','calculated','corrected'].includes(decision);target.conflict=decision==='review';target.sourceTrace.manualConfirmation={parsedValue:value,parsingMethod:'manually confirmed',decision};project.analysisReviewRequired=decision==='review';if(metric==='panelCount')project.electrical.panelCount=target.analysisEligible?value:null;else if(metric==='tonnage')project.mechanical.totalTonnage=target.analysisEligible?value:null;else if(metric==='ductFeet')project.mechanical.totalDuctFeet=target.analysisEligible?value:null;return project;
}

module.exports={FIELD_ALIASES,parseWorkbook,parseIssuesSheet,numeric,text,suggestMapping,detectHeader,normalizeRows,applyTotalDecision,looksEquipmentTag,validProjectNumber,splitProjectBlocks};
