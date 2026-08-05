function present(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'Unknown' && value !== 'Not recorded';
}

function finitePositive(value) { return Number.isFinite(Number(value)) && Number(value) > 0; }

function relatedIssues(project, issues = []) {
  return issues.filter(issue => issue.projectId === project.id || (issue.projectNumber && project.projectNumber && String(issue.projectNumber).trim().toLowerCase() === String(project.projectNumber).trim().toLowerCase()));
}

function approvedTonnage(project) {
  const total = project.mechanical?.totals?.tonnage;
  return finitePositive(project.mechanical?.totalTonnage) && total?.verificationStatus !== 'Conflict' && total?.verificationStatus !== 'Needs review' && total?.reviewStatus !== 'Pending review';
}

function projectAvailability(project, issues = []) {
  const mechanical = project.mechanical || {}, electrical = project.electrical || {};
  const units = mechanical.units || [], panels = electrical.panels || [];
  const related = relatedIssues(project, issues), unresolved = related.filter(issue => issue.status !== 'Resolved');
  const identityUsable = present(project.projectNumber) && present(project.projectName);
  const hasTonnage = approvedTonnage(project);
  const hasUnits = units.length > 0 || finitePositive(mechanical.unitCount);
  const hasTypes = units.some(unit => present(unit.normalizedType || unit.type || unit.originalType)) || present(mechanical.primarySystemType);
  const hasDuct = finitePositive(mechanical.totalDuctFeet);
  const hasSf = finitePositive(project.squareFeet);
  const hasConsultant = present(project.consultant);
  const hasPanels = panels.length > 0 || finitePositive(electrical.panelCount);
  const meaningful = hasTonnage || hasUnits || hasTypes || hasDuct || hasPanels || present(electrical.serviceInfo);
  const globalConflict = Boolean(project.analysisReviewRequired || project.identityReviewRequired);

  const uses = [
    ['tonnage-history','Tonnage history',hasTonnage,hasTonnage?'':'approved HVAC tonnage is not recorded'],
    ['unit-history','HVAC unit history',hasUnits,hasUnits?'':'equipment rows or a confirmed unit count are not recorded'],
    ['equipment-types','Equipment-type history',hasTypes,hasTypes?'':'equipment types are not recorded'],
    ['duct-analysis','Ductwork analysis',hasDuct,hasDuct?'':'duct linear feet are not recorded'],
    ['sf-per-ton','SF-per-ton analysis',hasSf && hasTonnage,hasSf?(hasTonnage?'':'approved HVAC tonnage is not recorded'):'square footage is not recorded'],
    ['consultant-comparison','Consultant comparison',hasConsultant,hasConsultant?'':'consultant is not recorded'],
    ['similar-projects','Similar-project matching',identityUsable && meaningful && (hasSf || present(project.buildingType)),identityUsable?'more project size, type, or MEP information is needed':'project identity is incomplete'],
    ['electrical-panels','Electrical-panel history',hasPanels,hasPanels?'':'electrical panel information is not recorded']
  ];
  const available = uses.filter(item => item[2]).map(item => ({key:item[0],label:item[1]}));
  const unavailable = uses.filter(item => !item[2]).map(item => ({key:item[0],label:item[1],reason:item[3]}));

  let status, explanation;
  if (project.excludedFromAnalysis) {
    status='Excluded'; explanation='Staff intentionally excluded this project from analytical calculations.';
  } else if (!identityUsable || !meaningful || globalConflict) {
    status='Review Needed'; explanation=globalConflict?'Recorded values conflict and need staff confirmation.':'The project does not yet contain enough reliable information for its main recorded uses.';
  } else if (related.length && !unresolved.length) {
    status='Complete History'; explanation='Previous issues were resolved and remain in the audit history.';
  } else if (unavailable.length || unresolved.length) {
    status='Limited Data'; explanation=`Usable for ${available.slice(0,3).map(item=>item.label.toLowerCase()).join(', ') || 'record lookup'}; some information is not recorded.`;
  } else {
    status='Ready'; explanation='The project has enough reliable information for its main recorded uses.';
  }
  return {status,explanation,available,unavailable,meaningful,identityUsable,globallyExcluded:status==='Excluded'||status==='Review Needed'&&(!identityUsable||!meaningful||Boolean(project.identityReviewRequired))};
}

function statusCounts(projects = [], issues = []) {
  const counts={Ready:0,'Limited Data':0,'Review Needed':0,Excluded:0,'Complete History':0};
  projects.forEach(project=>counts[projectAvailability(project,issues).status]++);
  return counts;
}

module.exports={projectAvailability,statusCounts,approvedTonnage,relatedIssues};
