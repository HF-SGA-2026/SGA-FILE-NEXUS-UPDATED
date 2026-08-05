const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { DATA_FILE, readData, writeData, resetToDemo, listBackups, restoreBackup } = require('./lib/storage');
const { parseWorkbook, applyTotalDecision } = require('./lib/importer');
const { canonicalizeConsultants } = require('./lib/analysis');
const { ISSUE_CATEGORIES, projectQualityStatus, likelyDuplicateIssue, detectProjectIssues } = require('./lib/issues');
const { saveProject, saveIssue, resolveIssue, projectConflicts, mergePreferExisting, importIssues, projectKey } = require('./lib/data-service');
const { generateWorkbookBuffer, validateWorkbookBuffer, writeMasterWorkbook, masterTarget } = require('./lib/workbook');
const { projectAvailability, statusCounts } = require('./lib/quality');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));
app.get('/analysis.js', (_req, res) => res.sendFile(path.join(__dirname, 'lib', 'analysis.js')));

function preparedData() {
  const data=readData();data.projects=canonicalizeConsultants(data.projects||[]);const before={Ready:0,'Limited Data':0,'Review Needed':0,Excluded:0,'Complete History':0};data.projects=data.projects.map(project=>{const legacy=projectQualityStatus(project,data.issues||[]),mapped=legacy==='Complete'?'Ready':legacy==='Resolved'?'Complete History':legacy==='Excluded'?'Excluded':'Review Needed';before[mapped]++;const availability=projectAvailability(project,data.issues||[]);return{...project,internalQualityStatus:legacy,qualityStatus:availability.status,dataStatus:availability.status,dataAvailability:availability}});data.statusMigration={before,after:statusCounts(data.projects,data.issues||[])};data.issueCategories=ISSUE_CATEGORIES;data.storage={jsonFile:DATA_FILE,lastSavedAt:data.system?.lastSavedAt,lastBackupAt:data.system?.lastBackupAt,masterStatus:data.settings?.lastMasterError?'Update pending':data.settings?.maintainMasterExcel?'Up to date':'Not enabled',notice:'Data is stored on this installation unless deployed to a shared firm server.'};return data;
}
function saveAndRefresh(data,reason){writeData(data,{reason});let masterWarning=null;if(data.settings?.maintainMasterExcel){try{const result=writeMasterWorkbook(data);data.settings.lastMasterUpdate=result.lastUpdated;data.settings.lastMasterBackup=result.backup?result.lastUpdated:data.settings.lastMasterBackup;data.settings.lastMasterError=null;writeData(data,{backup:false})}catch(error){masterWarning=error.message;data.settings.lastMasterError=error.message;writeData(data,{backup:false})}}return{data:preparedData(),masterWarning}}

app.get('/api/data',(_req,res)=>res.json(preparedData()));

app.post('/api/projects/save',(req,res)=>{try{const data=readData(),result=saveProject(data,req.body.project||{},req.body.options||{});if(!result.saved)return res.status(result.code==='blocking'?422:409).json(result);const saved=saveAndRefresh(data,result.project.audit?.origin==='manual'?'project-update':'project-save');res.json({...saved,project:result.project,message:'Project data saved and analysis updated.'})}catch(error){res.status(400).json({error:error.message})}});

app.delete("/api/projects/:id", (req, res) => {
  try {
    const data = readData();

    data.projects = data.projects || [];
    data.issues = data.issues || [];

    const projectId = String(
      req.params.id || ""
    );

    const project = data.projects.find(
      item =>
        String(item.id) === projectId
    );

    if (!project) {
      return res.status(404).json({
        error: "Project not found."
      });
    }

    /*
     * Remove the project.
     */
    data.projects = data.projects.filter(
      item =>
        String(item.id) !== projectId
    );

    /*
     * Remove issues attached to the project so
     * deleted projects do not remain in Data Review
     * or the exported ERRORS worksheet.
     */
    data.issues = data.issues.filter(issue => {
      const matchesId =
        String(issue.projectId || "") ===
        projectId;

      const matchesNumber =
        project.projectNumber &&
        issue.projectNumber ===
          project.projectNumber;

      return !matchesId && !matchesNumber;
    });

    data.isDemo = false;
    data.label = "Firm Spreadsheet Data";

    const saved = saveAndRefresh(
      data,
      "project-delete"
    );

    res.json({
      ...saved,

      deletedProject: {
        id: project.id,
        projectNumber:
          project.projectNumber || null,
        projectName:
          project.projectName ||
          "Unnamed project"
      },

      message:
        `${project.projectName || "Project"} was deleted.`
    });
  } catch (error) {
    res.status(400).json({
      error:
        error.message ||
        "Project could not be deleted."
    });
  }
});


app.post("/api/projects/:id/resolve-square-feet", (req, res) => {
  try {
    const data = readData();

    const project = (data.projects || []).find(
      item => item.id === req.params.id
    );

    if (!project) {
      return res.status(404).json({
        error: "Project not found."
      });
    }

    const selectedValue = Number(req.body.squareFeet);

    if (
      !Number.isFinite(selectedValue) ||
      selectedValue <= 0
    ) {
      return res.status(400).json({
        error: "Enter a valid square-footage value."
      });
    }

    const timestamp = new Date().toISOString();

    const sourceConflict =
      project.squareFeetSourceConflict &&
      Array.isArray(
        project.squareFeetSourceConflict.values
      )
        ? project.squareFeetSourceConflict
        : null;

    const crossDisciplineConflict =
      project.squareFeetConflict &&
      project.squareFeetConflict.type ===
        "cross-discipline"
        ? project.squareFeetConflict
        : null;

    /*
     * Preserve the original conflicting values.
     * We only record the staff decision.
     */
    project.squareFeetResolution = {
      selectedValue,
      resolvedAt: timestamp,
      resolvedBy:
        String(req.body.resolvedBy || "").trim() ||
        null,

      source:
        req.body.source === "custom"
          ? "Staff-entered corrected value"
          : "Staff-selected imported value",

      originalSourceConflict:
        sourceConflict
          ? JSON.parse(JSON.stringify(sourceConflict))
          : null,

      originalCrossDisciplineConflict:
        crossDisciplineConflict
          ? JSON.parse(
              JSON.stringify(crossDisciplineConflict)
            )
          : null
    };

    project.squareFeet = selectedValue;

    /*
     * If this conflict occurred inside one workbook,
     * assign the selected value to that discipline.
     */
    if (sourceConflict?.discipline === "mechanical") {
      project.mechanical = {
        ...(project.mechanical || {}),
        squareFeet: selectedValue
      };

      project.squareFeetSourceConflict = {
        ...sourceConflict,
        status: "Resolved",
        selectedValue,
        resolvedAt: timestamp
      };
    }

    if (sourceConflict?.discipline === "electrical") {
      project.electrical = {
        ...(project.electrical || {}),
        squareFeet: selectedValue
      };

      project.squareFeetSourceConflict = {
        ...sourceConflict,
        status: "Resolved",
        selectedValue,
        resolvedAt: timestamp
      };
    }

    /*
     * For a Mechanical-versus-Electrical disagreement,
     * preserve both original discipline values but select
     * one approved project value for analysis.
     */
    if (crossDisciplineConflict) {
      project.squareFeetConflict = {
        ...crossDisciplineConflict,
        status: "Resolved",
        selectedValue,
        resolvedAt: timestamp
      };
    }

    /*
     * Remove old active SF-conflict wording while keeping
     * the resolution in the audit history.
     */
    project.quality = (project.quality || []).filter(
      message =>
        !/square[- ]?foot|square footage|mechanical sf|electrical sf|sf conflict/i.test(
          String(message)
        )
    );

    const remainingPendingTotals = [
      project.mechanical?.totals?.tonnage,
      project.mechanical?.totals?.ductFeet,
      project.mechanical?.totals?.unitCount,
      project.electrical?.totals?.panelCount
    ].some(
      total =>
        total?.conflict &&
        total?.reviewStatus === "Pending review"
    );

    project.analysisReviewRequired =
      remainingPendingTotals;

    project.audit = {
      ...(project.audit || {}),
      updatedAt: timestamp
    };

    /*
     * Resolve matching automatically detected SF issues,
     * but retain their full history.
     */
    for (const issue of data.issues || []) {
      const matchesProject =
        issue.projectId === project.id ||
        (
          issue.projectNumber &&
          issue.projectNumber ===
            project.projectNumber
        );

      const isSquareFeetConflict =
        issue.category === "Conflicting values" &&
        /square[- ]?foot|square footage|mechanical sf|electrical sf/i.test(
          String(issue.message || "")
        );

      if (
        matchesProject &&
        isSquareFeetConflict &&
        issue.status !== "Resolved"
      ) {
        issue.status = "Resolved";
        issue.resolvedAt = timestamp;
        issue.updatedAt = timestamp;
        issue.resolvedBy =
          project.squareFeetResolution.resolvedBy;
        issue.resolutionNote =
          `Staff selected ${selectedValue.toLocaleString()} SF.`;

        issue.resolutionHistory = [
          ...(issue.resolutionHistory || []),
          {
            resolvedAt: timestamp,
            resolvedBy:
              project.squareFeetResolution.resolvedBy,
            note:
              `Staff selected ${selectedValue.toLocaleString()} SF.`,
            source:
              "Past Projects square-footage review"
          }
        ];
      }
    }

    const saved = saveAndRefresh(
      data,
      "square-feet-resolution"
    );

    res.json({
      ...saved,
      project,
      message:
        `${selectedValue.toLocaleString()} SF was approved and saved.`
    });
  } catch (error) {
    res.status(400).json({
      error:
        error.message ||
        "The square-footage decision could not be saved."
    });
  }
});

app.post("/api/projects/:id/reopen-square-feet", (req, res) => {
  try {
    const data = readData();

    const project = (data.projects || []).find(
      item => item.id === req.params.id
    );

    if (!project) {
      return res.status(404).json({
        error: "Project not found."
      });
    }

    const resolution = project.squareFeetResolution;

    if (!resolution) {
      return res.status(400).json({
        error: "This project does not have a saved SF decision."
      });
    }

    if (project.squareFeetSourceConflict) {
      project.squareFeetSourceConflict.status = "Review Needed";
      project.squareFeetSourceConflict.selectedValue = null;
      project.squareFeetSourceConflict.resolvedAt = null;
    }

    if (project.squareFeetConflict) {
      project.squareFeetConflict.status = "Review Needed";
      project.squareFeetConflict.selectedValue = null;
      project.squareFeetConflict.resolvedAt = null;
    }

    project.squareFeet = null;
    project.analysisReviewRequired = true;

    if (
      project.squareFeetSourceConflict?.discipline === "mechanical"
    ) {
      project.mechanical.squareFeet = null;
    }

    if (
      project.squareFeetSourceConflict?.discipline === "electrical"
    ) {
      project.electrical.squareFeet = null;
    }

    project.squareFeetResolutionHistory = [
      ...(project.squareFeetResolutionHistory || []),
      resolution
    ];

    project.squareFeetResolution = null;

    project.audit = {
      ...(project.audit || {}),
      updatedAt: new Date().toISOString()
    };

    const saved = saveAndRefresh(
      data,
      "square-feet-review-reopened"
    );

    res.json({
      ...saved,
      project,
      message: "Square-footage review reopened."
    });
  } catch (error) {
    res.status(400).json({
      error:
        error.message ||
        "The SF decision could not be reopened."
    });
  }
});


app.post('/api/issues/save',(req,res)=>{try{const data=readData(),issue=saveIssue(data,req.body.issue||req.body);const saved=saveAndRefresh(data,'issue-change');res.json({...saved,issue,message:'Issue saved and data quality updated.'})}catch(error){res.status(400).json({error:error.message})}});
app.post('/api/issues/:id/resolve',(req,res)=>{try{const data=readData(),issue=resolveIssue(data,req.params.id,req.body||{});const saved=saveAndRefresh(data,'issue-resolution');res.json({...saved,issue,message:'Issue resolved; its history has been retained.'})}catch(error){res.status(404).json({error:error.message})}});

app.post('/api/import/preview',upload.single('file'),(req,res)=>{try{if(!req.file)return res.status(400).json({error:'Choose a spreadsheet file.'});if(!/\.(xlsx|xls|csv)$/i.test(req.file.originalname))return res.status(400).json({error:'Use an .xlsx, .xls, or .csv file.'});const requestedType=req.body.type==='electrical'?'electrical':'mechanical',mapping=req.body.mapping?JSON.parse(req.body.mapping):{},data=readData(),knownConsultants=[...new Set((data.projects||[]).map(project=>project.consultant).filter(value=>value&&value!=='Unknown'))],result=parseWorkbook(req.file.buffer,requestedType,mapping,{workbookName:req.file.originalname,knownConsultants}),type=result.detectedType||requestedType,parserIssues=result.issues.map(issue=>({...issue,sourceWorkbook:req.file.originalname})),importedIssues=(result.errorIssues||[]).map(issue=>({...issue,sourceWorkbook:req.file.originalname})),detectedIssues=result.masterWorkbook?[]:result.projects.records.flatMap(project=>detectProjectIssues(project).map(issue=>({...issue,source:`Detected during ${req.file.originalname} import`,sourceWorkbook:req.file.originalname})));result.issues=result.masterWorkbook?parserIssues:[...detectedIssues,...parserIssues];const recoverySummary=importRecovery(data.projects||[],result.projects.records),conflicts=projectConflicts(data,result.projects.records,type==='master'?'mechanical':type),issueDuplicates=result.issues.filter(issue=>data.issues.some(existing=>likelyDuplicateIssue(existing,issue))).length;res.json({...result,importedIssues,detectedIssues,recoverySummary,type,filename:req.file.originalname,conflicts,issueDuplicates})}catch(error){res.status(400).json({error:error.message||'The spreadsheet could not be read.'})}});

app.post('/api/import/commit',(req,res)=>{
  try{
    const{type,filename,records,issues=[],totalDecisions=[],mode='add',duplicateAction='skip',projectConflictAction='saved',issueDuplicateAction='skip'}=req.body;
    if(!['mechanical','electrical','master'].includes(type)||!Array.isArray(records))return res.status(400).json({error:'Invalid import data.'});
    if(!['saved','imported','merge'].includes(projectConflictAction))return res.status(400).json({error:'Choose how manual project conflicts should be handled.'});
    const reviewedRecords=JSON.parse(JSON.stringify(records));
    for(const decision of totalDecisions){const project=reviewedRecords.find(item=>item.id===decision.projectId||projectKey(item)===String(decision.projectKey||'').toLowerCase());if(!project)continue;applyTotalDecision(project,decision.metric,decision.decision,decision.correctedValue)}
    reviewedRecords.forEach(project=>{const totals=[project.mechanical?.totals?.tonnage,project.mechanical?.totals?.ductFeet,project.mechanical?.totals?.unitCount,project.electrical?.totals?.panelCount].filter(Boolean);project.analysisReviewRequired=Boolean(project.identityReviewRequired)||totals.some(total=>total.conflict&&total.reviewStatus==='Pending review')});
    const reviewedIds=new Set(totalDecisions.map(decision=>decision.projectId).filter(Boolean));
    const confirmedProjects=new Set(reviewedRecords.filter(project=>reviewedIds.has(project.id)&&!project.analysisReviewRequired).map(project=>project.id));
    const reviewedIssues=issues.map(issue=>{if(issue.category==='Conflicting values'&&confirmedProjects.has(issue.projectId)){const timestamp=new Date().toISOString();return{...issue,status:'Resolved',resolvedAt:timestamp,updatedAt:timestamp,resolutionNote:'Resolved during import total review.',resolutionHistory:[...(issue.resolutionHistory||[]),{resolvedAt:timestamp,resolvedBy:null,note:'Resolved during import total review.',source:'Import review'}]}}return issue});
    const data=readData();data.projects=canonicalizeConsultants(data.projects||[]);const normalizedRecords=canonicalizeConsultants(reviewedRecords),conflicts=projectConflicts(data,normalizedRecords,type),conflictIds=new Set(conflicts.map(item=>item.projectId));if(data.isDemo)data.projects=[];
    const duplicateKeys=new Set(),incomingKeys=normalizedRecords.map(projectKey).filter(Boolean);incomingKeys.forEach((value,index)=>{if(incomingKeys.indexOf(value)!==index)duplicateKeys.add(value)});data.projects.forEach(existing=>{if(incomingKeys.includes(projectKey(existing)))duplicateKeys.add(projectKey(existing))});
    if(mode==='replace'&&type==='master'){data.projects=[];data.issues=[]}else if(mode==='replace'){const other=type==='mechanical'?'electrical':'mechanical';data.projects=data.projects.map(project=>clearDiscipline(project,type)).filter(project=>hasDiscipline(project,other))}
    let imported=0,skipped=0,conflictsKept=0;for(const incoming of normalizedRecords){incoming.id=incoming.id||crypto.randomUUID();incoming.audit={createdAt:incoming.audit?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),sourceType:`Spreadsheet import: ${filename}`,enteredBy:null,origin:'import'};const index=data.projects.findIndex(existing=>projectKey(existing)===projectKey(incoming));if(index<0){data.projects.push(incoming);imported++;continue}const existing=data.projects[index];if(conflictIds.has(existing.id)){if(projectConflictAction==='saved'){skipped++;conflictsKept++;continue}if(projectConflictAction==='merge'){data.projects[index]=mergePreferExisting(existing,incoming,type);imported++;continue}}if(mode==='replace'||duplicateAction==='replace'){data.projects[index]=preserveOtherDiscipline(incoming,existing,type);imported++}else if(duplicateAction==='merge'){data.projects[index]=mergeProjects(existing,incoming,type);imported++}else skipped++}
    const issueSummary=importIssues(data,reviewedIssues,issueDuplicateAction);data.isDemo=false;data.label='Firm Spreadsheet Data';data.imports=data.imports||{};data.imports[type]={at:new Date().toISOString(),filename,projects:imported,issues:issueSummary.imported};const saved=saveAndRefresh(data,mode==='replace'?'bulk-replace':'bulk-import');res.json({...saved,summary:{imported,skipped,duplicates:duplicateKeys.size,conflicts:conflicts.length,conflictsKept,issuesImported:issueSummary.imported,issuesSkipped:issueSummary.skipped,issuesMerged:issueSummary.merged,issues:issueSummary}})
  }catch(error){res.status(400).json({error:error.message||'Import could not be saved.'})}
});

app.get('/api/export/excel',(_req,res)=>{try{const buffer=generateWorkbookBuffer(readData());validateWorkbookBuffer(buffer);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="SGA_MEP_Latest.xlsx"');res.send(buffer)}catch(error){res.status(500).json({error:error.message})}});
app.get('/api/export/json',(_req,res)=>{const data=readData();res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition',`attachment; filename="SGA_MEP_Backup_${new Date().toISOString().slice(0,10)}.json"`);res.send(JSON.stringify(data,null,2))});

app.get('/api/backups',(_req,res)=>res.json({backups:listBackups()}));
app.post('/api/backups/restore',(req,res)=>{try{const restored=restoreBackup(req.body.name);res.json({data:preparedData(),restored:restored.projects.length,message:'Backup restored and analysis updated.'})}catch(error){res.status(400).json({error:error.message})}});
app.post('/api/data/restore-json',upload.single('file'),(req,res)=>{try{if(!req.file)return res.status(400).json({error:'Choose a JSON backup.'});const restored=JSON.parse(req.file.buffer.toString('utf8'));if(!Array.isArray(restored.projects))throw new Error('This file is not an SGA MEP JSON backup.');writeData(restored,{reason:'before-json-restore'});res.json({data:preparedData(),message:'JSON backup restored and analysis updated.'})}catch(error){res.status(400).json({error:error.message})}});

app.post('/api/settings/master',(req,res)=>{try{const data=readData(),directory=String(req.body.masterDirectory||'').trim(),filename=path.basename(String(req.body.masterFilename||'SGA_MEP_Master.xlsx'));if(req.body.maintainMasterExcel&&(!directory||!path.isAbsolute(directory)))throw new Error('Choose an absolute folder path for the local master workbook.');const sourceNames=Object.values(data.imports||{}).map(info=>info?.filename?.toLowerCase()).filter(Boolean);if(sourceNames.includes(filename.toLowerCase()))throw new Error('The master workbook must use a different filename from imported source files.');data.settings={...data.settings,maintainMasterExcel:Boolean(req.body.maintainMasterExcel),masterDirectory:directory||data.settings.masterDirectory,masterFilename:filename};const saved=saveAndRefresh(data,'master-settings');res.json(saved)}catch(error){res.status(400).json({error:error.message})}});
app.post('/api/master/regenerate',(req,res)=>{try{const data=readData(),result=writeMasterWorkbook(data);data.settings.lastMasterUpdate=result.lastUpdated;data.settings.lastMasterBackup=result.backup?result.lastUpdated:data.settings.lastMasterBackup;data.settings.lastMasterError=null;writeData(data,{backup:false});res.json({data:preparedData(),result,message:'Master workbook regenerated.'})}catch(error){const data=readData();data.settings.lastMasterError=error.message;writeData(data,{backup:false});res.status(409).json({error:error.message,data:preparedData()})}});

app.post('/api/data/clear',(req,res)=>{try{const{type='all'}=req.body||{},data=readData();if(type==='all'){data.projects=[];data.issues=[];data.imports={mechanical:null,electrical:null}}else if(['mechanical','electrical'].includes(type)){data.projects=data.projects.map(project=>clearDiscipline(project,type)).filter(project=>hasDiscipline(project,type==='mechanical'?'electrical':'mechanical'));data.imports[type]=null}data.isDemo=false;data.label='Firm Spreadsheet Data';const saved=saveAndRefresh(data,`clear-${type}`);res.json(saved.data)}catch(error){res.status(400).json({error:error.message})}});
app.post('/api/data/demo',(_req,res)=>{try{resetToDemo();res.json(preparedData())}catch(error){res.status(400).json({error:error.message})}});

function hasDiscipline(project,type){return type==='mechanical'?Boolean(project.mechanical?.units?.length||project.mechanical?.unitCount||project.mechanical?.totalTonnage!=null||project.mechanical?.totalDuctFeet!=null):Boolean(project.electrical?.panels?.length||project.electrical?.panelCount!=null||project.electrical?.serviceInfo)}
function importRecovery(existingProjects,incomingProjects){const existingByNumber=new Map(existingProjects.filter(project=>project.projectNumber).map(project=>[String(project.projectNumber).trim().toLowerCase(),project])),projects=[];let matchingProjects=0,missingSquareFeetBefore=0,missingConsultantsBefore=0,recoveredSquareFeet=0,recoveredConsultants=0;for(const incoming of incomingProjects){const existing=existingByNumber.get(String(incoming.projectNumber||'').trim().toLowerCase());if(!existing)continue;matchingProjects++;const sfMissing=!Number.isFinite(existing.squareFeet)||existing.squareFeet<=0,consultantMissing=!existing.consultant||existing.consultant==='Unknown';if(sfMissing)missingSquareFeetBefore++;if(consultantMissing)missingConsultantsBefore++;const fields=[];if(sfMissing&&Number.isFinite(incoming.squareFeet)&&incoming.squareFeet>0){recoveredSquareFeet++;fields.push('Overall SF')}if(consultantMissing&&incoming.consultant&&incoming.consultant!=='Unknown'){recoveredConsultants++;fields.push('Consultant')}incoming.importRecovery={previouslyMissing:fields};if(fields.length)projects.push({projectNumber:incoming.projectNumber,projectName:incoming.projectName,fields})}return{matchingProjects,missingSquareFeetBefore,missingConsultantsBefore,recoveredSquareFeet,recoveredConsultants,projects}}

function usableSquareFeet(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : null;
}


function disciplineConsultant(project, type) {
  const disciplineValue =
    project?.[type]?.consultant;

  if (
    disciplineValue &&
    disciplineValue !== "Unknown"
  ) {
    return disciplineValue;
  }

  // Supports older saved records that only used project.consultant.
  if (
    hasDiscipline(project, type) &&
    project?.consultant &&
    project.consultant !== "Unknown"
  ) {
    return project.consultant;
  }

  return null;
}


function disciplineSquareFeet(project, type) {
  const disciplineValue = usableSquareFeet(
    project?.[type]?.squareFeet
  );

  if (disciplineValue !== null) {
    return disciplineValue;
  }

  // Supports older saved data that only had project.squareFeet.
  if (hasDiscipline(project, type)) {
    return usableSquareFeet(project?.squareFeet);
  }

  return null;
}





function reconcileSquareFeet(project) {
  const sourceConflict =
    project.squareFeetSourceConflict &&
    Array.isArray(project.squareFeetSourceConflict.values) &&
    project.squareFeetSourceConflict.values.length > 1
      ? project.squareFeetSourceConflict
      : null;

  const mechanicalSquareFeet = disciplineSquareFeet(
    project,
    "mechanical"
  );

  const electricalSquareFeet = disciplineSquareFeet(
    project,
    "electrical"
  );

  const crossDisciplineConflict =
    mechanicalSquareFeet !== null &&
    electricalSquareFeet !== null &&
    mechanicalSquareFeet !== electricalSquareFeet;

  project.mechanical = {
    ...(project.mechanical || {}),
    squareFeet: mechanicalSquareFeet
  };

  project.electrical = {
    ...(project.electrical || {}),
    squareFeet: electricalSquareFeet
  };

  if (sourceConflict) {
    project.squareFeetConflict = {
      type: "source-workbook",
      discipline: sourceConflict.discipline,
      values: sourceConflict.values,
      status: "Review Needed",
      message: sourceConflict.message
    };

    project.squareFeet = null;
    project.analysisReviewRequired = true;

    if (sourceConflict.discipline === "mechanical") {
      project.mechanical.squareFeet = null;
    }

    if (sourceConflict.discipline === "electrical") {
      project.electrical.squareFeet = null;
    }

    const conflictMessage =
      sourceConflict.message ||
      `The source workbook contains conflicting square-footage values: ` +
      `${sourceConflict.values
        .map(value => Number(value).toLocaleString())
        .join(" and ")} SF.`;

    project.quality = [
      ...new Set([
        ...(project.quality || []),
        conflictMessage
      ])
    ];

    return project;
  }

  if (crossDisciplineConflict) {
    project.squareFeetConflict = {
      type: "cross-discipline",
      mechanical: mechanicalSquareFeet,
      electrical: electricalSquareFeet,
      status: "Review Needed",
      message:
        `Mechanical source records ${mechanicalSquareFeet.toLocaleString()} SF; ` +
        `electrical source records ${electricalSquareFeet.toLocaleString()} SF.`
    };

    project.squareFeet = null;
    project.analysisReviewRequired = true;

    const conflictMessage =
      `Source conflict: Mechanical SF is ` +
      `${mechanicalSquareFeet.toLocaleString()} and Electrical SF is ` +
      `${electricalSquareFeet.toLocaleString()}.`;

    project.quality = [
      ...new Set([
        ...(project.quality || []),
        conflictMessage
      ])
    ];
  } else {
    project.squareFeetConflict = null;

    project.squareFeet =
      mechanicalSquareFeet ??
      electricalSquareFeet ??
      usableSquareFeet(project.squareFeet);
  }

  return project;
}

function usableConsultant(...values) {
  for (const value of values) {
    const cleaned = String(value ?? "").trim();

    if (
      cleaned &&
      cleaned.toLowerCase() !== "unknown" &&
      cleaned.toLowerCase() !== "not recorded"
    ) {
      return cleaned;
    }
  }

  return null;
}

function preserveOtherDiscipline(incoming, existing, type) {
  const meaningful = Object.fromEntries(
    Object.entries(incoming).filter(
      ([, value]) =>
        value !== null &&
        value !== "" &&
        value !== "Unknown"
    )
  );

  const merged = {
    ...existing,
    ...meaningful,
    id: existing.id
  };

  if (type === "mechanical") {
    merged.mechanical = {
      ...(incoming.mechanical || {}),

      consultant: usableConsultant(
        incoming.mechanical?.consultant,
        incoming.consultant
      ),

      squareFeet:
        incoming.mechanical?.squareFeet ??
        incoming.squareFeet ??
        null
    };

    merged.electrical = {
      ...(existing.electrical || {}),

      consultant: usableConsultant(
        existing.electrical?.consultant,
        disciplineConsultant(existing, "electrical")
      ),

      squareFeet:
        existing.electrical?.squareFeet ??
        disciplineSquareFeet(existing, "electrical")
    };
  } else {
    merged.electrical = {
      ...(incoming.electrical || {}),

      consultant: usableConsultant(
        incoming.electrical?.consultant,
        incoming.consultant
      ),

      squareFeet:
        incoming.electrical?.squareFeet ??
        incoming.squareFeet ??
        null
    };

    merged.mechanical = {
      ...(existing.mechanical || {}),

      consultant: usableConsultant(
        existing.mechanical?.consultant,
        disciplineConsultant(existing, "mechanical")
      ),

      squareFeet:
        existing.mechanical?.squareFeet ??
        disciplineSquareFeet(existing, "mechanical")
    };
  }

  merged.notes = [
    ...new Set([
      ...(existing.notes || []),
      ...(incoming.notes || [])
    ])
  ];

  merged.quality = [
    ...new Set([
      ...(existing.quality || []),
      ...(incoming.quality || [])
    ])
  ];

  return reconcileSquareFeet(merged);
}

function mergeProjects(existing, incoming, type) {
  const meaningfulIncoming = Object.fromEntries(
    Object.entries(incoming).filter(
      ([, value]) =>
        value !== null &&
        value !== "" &&
        value !== "Unknown"
    )
  );

  const merged = {
    ...existing,
    ...meaningfulIncoming,
    id: existing.id
  };

  merged.notes = [
    ...new Set([
      ...(existing.notes || []),
      ...(incoming.notes || [])
    ])
  ];

  merged.quality = [
    ...new Set([
      ...(existing.quality || []),
      ...(incoming.quality || [])
    ])
  ];

  if (type === "mechanical") {
    merged.mechanical = {
      ...(incoming.mechanical || {}),

      consultant: usableConsultant(
        incoming.mechanical?.consultant,
        incoming.consultant
      ),

      squareFeet:
        incoming.mechanical?.squareFeet ??
        incoming.squareFeet ??
        null
    };

    merged.electrical = {
      ...(existing.electrical || {}),

      consultant: usableConsultant(
        existing.electrical?.consultant,
        disciplineConsultant(existing, "electrical")
      ),

      squareFeet:
        existing.electrical?.squareFeet ??
        disciplineSquareFeet(existing, "electrical")
    };
  } else {
    merged.electrical = {
      ...(incoming.electrical || {}),

      consultant: usableConsultant(
        incoming.electrical?.consultant,
        incoming.consultant
      ),

      squareFeet:
        incoming.electrical?.squareFeet ??
        incoming.squareFeet ??
        null
    };

    merged.mechanical = {
      ...(existing.mechanical || {}),

      consultant: usableConsultant(
        existing.mechanical?.consultant,
        disciplineConsultant(existing, "mechanical")
      ),

      squareFeet:
        existing.mechanical?.squareFeet ??
        disciplineSquareFeet(existing, "mechanical")
    };
  }

  return reconcileSquareFeet(merged);
}


function clearDiscipline(project,type){const copy=JSON.parse(JSON.stringify(project));
  if (
    copy.squareFeetSourceConflict?.discipline === type
  ) {
    copy.squareFeetSourceConflict = null;
  }

  if (
    copy.squareFeetConflict?.discipline === type ||
    copy.squareFeetConflict?.type === "source-workbook"
  ) {
    copy.squareFeetConflict = null;
  }

  if (
    copy.squareFeetResolution?.originalSourceConflict?.discipline === type
  ) {
    copy.squareFeetResolution = null;
  }
  if (type === "mechanical") {
    copy.mechanical = {
      consultant: null,
      squareFeet: null,
      units: [],
      unitCount: null,
      totalTonnage: null,
      totalDuctFeet: null,
      totals: {}
    };
  } else {
    copy.electrical = {
      consultant: null,
      squareFeet: null,
      panels: [],
      disconnects: [],
      panelCount: null,
      serviceInfo: null,
      notes: null,
      totals: {}
    };
  }


copy.importedNotes=(copy.importedNotes||[]).filter(note=>String(note.discipline||'').toLowerCase()!==type);const totals=[copy.mechanical?.totals?.tonnage,copy.mechanical?.totals?.ductFeet,copy.mechanical?.totals?.unitCount,copy.electrical?.totals?.panelCount].filter(Boolean);copy.analysisReviewRequired=totals.some(total=>total.conflict&&total.reviewStatus==='Pending review');
reconcileSquareFeet(copy);
return copy}

app.use((error,_req,res,_next)=>res.status(error.code==='LIMIT_FILE_SIZE'?413:500).json({error:error.code==='LIMIT_FILE_SIZE'?'File exceeds the 25 MB limit.':'Unexpected local server error.'}));
if(require.main===module)app.listen(PORT,()=>console.log(`SGA MEP Analyzer is running at http://localhost:${PORT}`));
module.exports=app;
