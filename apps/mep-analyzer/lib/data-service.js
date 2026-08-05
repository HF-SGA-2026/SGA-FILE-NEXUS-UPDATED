const crypto = require('crypto');
const { normalizeConsultantName, canonicalizeConsultants } = require('./analysis');
const { detectProjectIssues, usefulMepFields, likelyDuplicateIssue, makeIssue } = require('./issues');

function text(value){const result=String(value??'').trim().replace(/\s+/g,' ');return result||null}
function numeric(value){if(value===null||value===undefined||value==='')return null;const number=Number(String(value).replace(/,/g,''));return Number.isFinite(number)?number:null}
function normalizeProjectNumber(value){return String(value??'').trim().toUpperCase().replace(/[‐‑‒–—−]/g,'-').replace(/\s*-\s*/g,'-').replace(/\s+/g,' ')}
function projectKey(project){const number=normalizeProjectNumber(project.projectNumber);return number?`number:${number}`:`name:${String(project.projectName||'').trim().toLowerCase()}`}
function meaningful(value){return value!==null&&value!==undefined&&value!==''&&value!=='Unknown'}

function normalizeManualProject(input,existing=null){
  const timestamp=new Date().toISOString(),m=input.mechanical||{},e=input.electrical||{};
  const units=Array.isArray(m.units)?m.units.map(unit=>({name:text(unit.name),originalType:text(unit.originalType),normalizedType:text(unit.normalizedType),type:text(unit.normalizedType||unit.type||unit.originalType),tonnage:numeric(unit.tonnage),quantity:Math.max(1,numeric(unit.quantity)||1),manufacturer:text(unit.manufacturer),model:text(unit.model),classification:text(unit.classification),existingCondition:Boolean(unit.existingCondition),notes:text(unit.notes),provenance:unit.provenance||'Manually updated'})):existing?.mechanical?.units||[];
  const panels=Array.isArray(e.panels)?e.panels.map(panel=>({name:text(panel.name),type:text(panel.type),rating:text(panel.rating||panel.serviceInfo),serviceInfo:text(panel.serviceInfo||panel.rating),quantity:Math.max(1,numeric(panel.quantity)||1),manufacturer:text(panel.manufacturer),model:text(panel.model),notes:text(panel.notes),provenance:panel.provenance||'Manually updated'})):existing?.electrical?.panels||[];
  const calculatedTonnage=units.reduce((sum,unit)=>sum+(Number.isFinite(unit.tonnage)?unit.tonnage*unit.quantity:0),0)||null,calculatedUnits=units.reduce((sum,unit)=>sum+unit.quantity,0)||null,calculatedPanels=panels.reduce((sum,panel)=>sum+panel.quantity,0)||null;
  const statedTonnage=numeric(m.statedTonnage??m.totals?.tonnage?.stated??m.totalTonnage??existing?.mechanical?.totals?.tonnage?.stated),choice=m.totalChoice||'keep-recorded',corrected=numeric(m.correctedTonnage);
  let chosenTonnage=statedTonnage,tonSource='stated-total',verification=calculatedTonnage&&statedTonnage&&Math.abs(calculatedTonnage-statedTonnage)>.05?'Conflict':calculatedTonnage&&statedTonnage?'Verified':statedTonnage?'Stated':'Calculated';
  if(choice==='use-calculated'){chosenTonnage=calculatedTonnage;tonSource='calculated-equipment';verification='Manually confirmed'}else if(choice==='corrected'&&corrected!==null){chosenTonnage=corrected;tonSource='manually-confirmed';verification='Manually confirmed'}else if(choice==='review'&&verification==='Conflict')chosenTonnage=null;
  const project={...(existing||{}),id:existing?.id||input.id||crypto.randomUUID(),projectNumber:normalizeProjectNumber(input.projectNumber)||null,projectName:text(input.projectName),buildingType:text(input.buildingType)||'Unknown',squareFeet:numeric(input.squareFeet),consultant:normalizeConsultantName(input.consultant),projectStatus:text(input.projectStatus)||'Completed',completionDate:text(input.completionDate),excludedFromAnalysis:Boolean(input.excludedFromAnalysis),analysisReviewRequired:verification==='Conflict'&&choice==='review',mechanical:{...(existing?.mechanical||{}),units,totalTonnage:chosenTonnage,unitCount:calculatedUnits??numeric(m.unitCount),primarySystemType:text(m.primarySystemType),manufacturer:text(m.manufacturer),model:text(m.model),totalDuctFeet:numeric(m.totalDuctFeet),notes:text(m.notes),totals:{...(existing?.mechanical?.totals||{}),tonnage:{stated:statedTonnage,calculated:calculatedTonnage,chosen:chosenTonnage,source:tonSource,verificationStatus:verification},unitCount:{stated:numeric(m.unitCount),calculated:calculatedUnits,chosen:calculatedUnits??numeric(m.unitCount),source:calculatedUnits?'calculated-equipment':'stated-total',verificationStatus:calculatedUnits?'Calculated':'Stated'}}},electrical:{...(existing?.electrical||{}),panels,panelCount:calculatedPanels??numeric(e.panelCount),serviceInfo:text(e.serviceInfo),notes:text(e.notes),totals:{...(existing?.electrical?.totals||{}),panelCount:{stated:numeric(e.panelCount),calculated:calculatedPanels,chosen:calculatedPanels??numeric(e.panelCount),source:calculatedPanels?'calculated-equipment':'stated-total',verificationStatus:calculatedPanels?'Calculated':'Stated'}}},notes:existing?.notes||[],quality:existing?.quality||[],audit:{createdAt:existing?.audit?.createdAt||timestamp,updatedAt:timestamp,sourceType:text(input.audit?.sourceType)||'Other',enteredBy:text(input.audit?.enteredBy),origin:'manual'},provenance:{...(existing?.provenance||{})}};
  ['projectNumber','projectName','buildingType','squareFeet','consultant','projectStatus','completionDate'].forEach(field=>project.provenance[field]=meaningful(project[field])?'recorded':'not recorded');
  project.provenance.mechanical=usefulMepFields({mechanical:project.mechanical,electrical:{}})?'recorded':'not recorded';
  project.provenance.electrical=usefulMepFields({mechanical:{},electrical:project.electrical})?'recorded':'not recorded';
  return project;
}

function validationForProject(project,data,isNew){
  const issues=detectProjectIssues(project);
  if(!project.projectNumber)issues.push(makeIssue(project,{severity:'Blocking',discipline:'General',category:'Conflicting values',message:'Project number is required.',autoDetected:true}));
  if(!project.projectName)issues.push(makeIssue(project,{severity:'Blocking',discipline:'General',category:'Conflicting values',message:'Project name is required.',autoDetected:true}));
  if(isNew&&project.projectNumber&&data.projects.some(existing=>String(existing.projectNumber||'').toLowerCase()===project.projectNumber.toLowerCase()))issues.push(makeIssue(project,{severity:'Blocking',discipline:'General',category:'Conflicting values',message:'Another project already uses this project number.',autoDetected:true}));
  return issues;
}

function syncDetectedIssues(
  data,
  project,
  detected,
  staff
) {
  data.issues =
    data.issues || [];

  const timestamp =
    new Date().toISOString();

  const existing =
    data.issues.filter(
      issue =>
        issue.projectId === project.id &&
        issue.autoDetected
    );

  /*
   * Automatically resolve old detected issues
   * whose underlying problem no longer exists.
   */
  existing.forEach(issue => {
    const stillExists =
      detected.some(
        detectedIssue =>
          detectedIssue.discipline ===
            issue.discipline &&
          detectedIssue.category ===
            issue.category &&
          detectedIssue.message ===
            issue.message
      );

    if (
      stillExists ||
      issue.status === "Resolved"
    ) {
      return;
    }

    const resolutionEntry = {
      resolvedAt: timestamp,
      resolvedBy: staff || null,
      note:
        "Automatically resolved after the project data was corrected.",
      source:
        "Automatic validation"
    };

    issue.status = "Resolved";
    issue.resolvedAt =
      resolutionEntry.resolvedAt;
    issue.resolvedBy =
      resolutionEntry.resolvedBy;
    issue.resolutionNote =
      resolutionEntry.note;
    issue.updatedAt = timestamp;

    issue.resolutionHistory = [
      ...(issue.resolutionHistory || []),
      resolutionEntry
    ];

    issue.projectNumber =
      project.projectNumber;

    issue.projectName =
      project.projectName;

    issue.consultant =
      project.consultant ||
      project.mechanical?.consultant ||
      project.electrical?.consultant ||
      "Unknown";

    issue.squareFeet =
      project.squareFeetResolution
        ?.selectedValue ??
      project.squareFeet ??
      project.mechanical?.squareFeet ??
      project.electrical?.squareFeet ??
      null;
  });

  /*
   * Add newly detected problems or reopen an
   * auto-detected problem if it has returned.
   */
  detected.forEach(detectedIssue => {
    const match =
      existing.find(
        issue =>
          issue.discipline ===
            detectedIssue.discipline &&
          issue.category ===
            detectedIssue.category &&
          issue.message ===
            detectedIssue.message
      );

    if (match) {
      if (match.status === "Resolved") {
        match.status = "Unresolved";
        match.resolvedAt = null;
        match.resolvedBy = null;
        match.resolutionNote = null;
      }

      match.updatedAt = timestamp;
      match.projectNumber =
        project.projectNumber;
      match.projectName =
        project.projectName;

      match.consultant =
        detectedIssue.consultant;

      match.squareFeet =
        detectedIssue.squareFeet;

      match.excludedFromAnalysis =
        Boolean(
          project.excludedFromAnalysis
        );

      return;
    }

    detectedIssue.projectId =
      project.id;

    detectedIssue.recordedBy =
      staff || null;

    detectedIssue.excludedFromAnalysis =
      Boolean(
        project.excludedFromAnalysis
      );

    data.issues.push(
      detectedIssue
    );
  });
}

function saveProject(data,input,options={}){
  data.projects=canonicalizeConsultants(data.projects||[]);data.issues=data.issues||[];
  const existing=input.id?data.projects.find(project=>project.id===input.id):null,isNew=!existing,project=normalizeManualProject(input,existing),detected=validationForProject(project,data,isNew),blocking=detected.filter(issue=>issue.severity==='Blocking'),warnings=detected.filter(issue=>issue.severity==='Warning');
  if(blocking.length&&!options.excludeOnBlocking)return{saved:false,code:'blocking',project,issues:detected};
  if(warnings.length&&!options.saveWithWarnings&&!blocking.length)return{saved:false,code:'warnings',project,issues:detected};
  if(blocking.length&&options.excludeOnBlocking)project.excludedFromAnalysis=true;
  const index=data.projects.findIndex(item=>item.id===project.id);if(index>=0)data.projects[index]=project;else data.projects.push(project);
  syncDetectedIssues(data,project,detected,project.audit.enteredBy);
  data.isDemo=false;data.label='Firm Spreadsheet Data';
  return{saved:true,project,data,issues:detected};
}

function normalizeIssueInput(data,input){const project=data.projects.find(project=>project.id===input.projectId)||data.projects.find(project=>project.projectNumber&&project.projectNumber===input.projectNumber)||{};const existing=input.id?data.issues.find(issue=>issue.id===input.id):null,timestamp=new Date().toISOString();return{...(existing||{}),id:existing?.id||crypto.randomUUID(),projectId:project.id||input.projectId||null,projectNumber:project.projectNumber||text(input.projectNumber),projectName:project.projectName||text(input.projectName)||'Unknown project',consultant:project.consultant||normalizeConsultantName(input.consultant),squareFeet:project.squareFeet??numeric(input.squareFeet),discipline:text(input.discipline)||'General',category:text(input.category)||'Other',message:text(input.message)||'Staff note',detailedNote:text(input.detailedNote),severity:['Blocking','Warning','Note'].includes(input.severity)?input.severity:'Warning',status:input.status==='Resolved'?'Resolved':'Unresolved',createdAt:existing?.createdAt||timestamp,updatedAt:timestamp,recordedBy:text(input.recordedBy)||existing?.recordedBy||null,resolvedAt:existing?.resolvedAt||null,resolvedBy:existing?.resolvedBy||null,resolutionNote:existing?.resolutionNote||null,resolutionHistory:existing?.resolutionHistory||[],source:text(input.source)||existing?.source||'Manual issue',autoDetected:Boolean(existing?.autoDetected),originalRow:existing?.originalRow||null,sourceWorkbook:existing?.sourceWorkbook||null,excludedFromAnalysis:Boolean(project.excludedFromAnalysis)}}
function saveIssue(data,input){data.issues=data.issues||[];const issue=normalizeIssueInput(data,input),index=data.issues.findIndex(item=>item.id===issue.id);if(index>=0)data.issues[index]=issue;else data.issues.push(issue);return issue}
function resolveIssue(data,id,resolution){const issue=data.issues.find(item=>item.id===id);if(!issue)throw new Error('Issue not found.');const timestamp=new Date().toISOString(),entry={resolvedAt:timestamp,resolvedBy:text(resolution.resolvedBy),note:text(resolution.resolutionNote)||'Resolved',source:'Manual resolution'};issue.status='Resolved';issue.resolvedAt=timestamp;issue.resolvedBy=entry.resolvedBy;issue.resolutionNote=entry.note;issue.updatedAt=timestamp;issue.resolutionHistory=[...(issue.resolutionHistory||[]),entry];return issue}

function flattenForConflict(project,type){const common={projectName:project.projectName,buildingType:project.buildingType,squareFeet:project.squareFeet,consultant:project.consultant},mechanical={totalTonnage:project.mechanical?.totalTonnage,totalDuctFeet:project.mechanical?.totalDuctFeet},electrical={panelCount:project.electrical?.panelCount,serviceInfo:project.electrical?.serviceInfo};if(type==='master')return{...common,...mechanical,...electrical};if(type==='mechanical')return{...common,...mechanical};return{...common,...electrical}}
function projectConflicts(data,records,type){if(type==='mechanical'&&records.some(record=>record.__masterImport))type='master';const conflicts=[];records.forEach(incoming=>{const existing=data.projects.find(project=>projectKey(project)===projectKey(incoming));if(!existing||existing.audit?.origin!=='manual')return;const saved=flattenForConflict(existing,type),imported=flattenForConflict(incoming,type),fields=[];Object.keys(saved).forEach(field=>{if(meaningful(saved[field])&&meaningful(imported[field])&&String(saved[field]).trim().toLowerCase()!==String(imported[field]).trim().toLowerCase())fields.push({field,saved:saved[field],imported:imported[field],savedSource:existing.provenance?.[field]||'Manually updated',importedSource:incoming.provenance?.[field]||'Imported'})});if(fields.length)conflicts.push({projectId:existing.id,projectNumber:existing.projectNumber,projectName:existing.projectName,savedUpdatedAt:existing.audit?.updatedAt||null,savedSource:existing.audit?.sourceType||'Manual update',importedSource:incoming.audit?.sourceType||'Spreadsheet import',fields})});return conflicts}
function mergePreferExisting(existing,incoming,type){const merged={...incoming,...existing,id:existing.id};merged.mechanical=type==='mechanical'?{...(incoming.mechanical||{}),...(existing.mechanical||{})}:existing.mechanical;merged.electrical=type==='electrical'?{...(incoming.electrical||{}),...(existing.electrical||{})}:existing.electrical;merged.notes=[...new Set([...(existing.notes||[]),...(incoming.notes||[])])];merged.quality=[...new Set([...(existing.quality||[]),...(incoming.quality||[])])];return merged}
function importIssues(data,incoming,action='skip'){let imported=0,skipped=0,merged=0;incoming.forEach(issue=>{const project=data.projects.find(project=>project.projectNumber&&project.projectNumber===issue.projectNumber)||data.projects.find(project=>project.projectName===issue.projectName);if(project){issue.projectId=project.id;issue.projectName=project.projectName;issue.projectNumber=project.projectNumber;issue.consultant=project.consultant;issue.squareFeet=project.squareFeet}const duplicate=data.issues.find(existing=>likelyDuplicateIssue(existing,issue));if(!duplicate||action==='keep'){issue.id=crypto.randomUUID();data.issues.push(issue);imported++}else if(action==='merge'){duplicate.detailedNote=[duplicate.detailedNote,issue.detailedNote||issue.message].filter(Boolean).join('\nImported note: ');duplicate.updatedAt=new Date().toISOString();duplicate.source=[duplicate.source,issue.source].filter(Boolean).join('; ');merged++}else skipped++});return{imported,skipped,merged}}

module.exports={normalizeManualProject,validationForProject,saveProject,saveIssue,resolveIssue,projectConflicts,mergePreferExisting,importIssues,projectKey,normalizeProjectNumber,meaningful};
