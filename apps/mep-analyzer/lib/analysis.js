(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SGAAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clean(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
  }

  function consultantKey(value) {
    return clean(value).toLocaleLowerCase('en-US');
  }

  function normalizeConsultantName(value) {
    const name = clean(value);
    if (!name || /^unknown$/i.test(name)) return 'Unknown';
    const words = name.split(' ');
    const acronymThenLower = words.length > 1 && /^[A-Z&]{2,5}$/.test(words[0]) && words.slice(1).every(word => word === word.toLowerCase());
    if (name !== name.toUpperCase() && name !== name.toLowerCase() && !acronymThenLower) return name;
    const alwaysUpper = new Set(['MEP', 'DBR', 'A&G', 'LLC', 'PLLC', 'M&E']);
    return words.map(word => {
      if (alwaysUpper.has(word.toUpperCase())) return word.toUpperCase();
      if (/^[A-Z0-9&]{2,4}$/.test(word) && !/^[A-Z]{2,4}$/.test(word)) return word.toUpperCase();
      return word.toLowerCase().replace(/(^|[-/&])([a-z])/g, (_match, prefix, letter) => prefix + letter.toUpperCase());
    }).join(' ');
  }

  function canonicalizeConsultants(projects) {
    const displayByKey = new Map();
    return projects.map(project => {
      const normalized = normalizeConsultantName(project.consultant);
      const key = consultantKey(normalized);
      if (!displayByKey.has(key)) displayByKey.set(key, normalized);
      return { ...project, consultant: displayByKey.get(key) };
    });
  }

  function mechanical(project) {
    return project.mechanical || { units: [], totalTonnage: null, totalDuctFeet: null };
  }

  function electrical(project) {
    return project.electrical || { panels: [], panelCount: null };
  }

  function hvacUnitCount(project) {
    const m = mechanical(project);
    return Number.isFinite(m.unitCount) ? m.unitCount : ((m.units || []).length || null);
  }

  function disciplineMatch(project, scope) {
    if (project.excludedFromAnalysis || project.analysisReviewRequired || project.qualityStatus === 'Blocked' || project.qualityStatus === 'Excluded') return false;
    const hasMechanical = Boolean(mechanical(project).units?.length || Number.isFinite(mechanical(project).unitCount) || Number.isFinite(mechanical(project).totalTonnage) || Number.isFinite(mechanical(project).totalDuctFeet) || mechanical(project).primarySystemType);
    const hasElectrical = Boolean(electrical(project).panels?.length || Number.isFinite(electrical(project).panelCount) || electrical(project).serviceInfo);
    if (scope === 'Mechanical') return hasMechanical;
    if (scope === 'Electrical') return hasElectrical;
    return hasMechanical || hasElectrical;
  }

  function rankSimilarProjects(projects, criteria = {}) {
    const targetSf = Number(criteria.squareFeet);
    const targetType = clean(criteria.buildingType);
    const targetConsultant = consultantKey(criteria.consultant);
    return projects.filter(project => disciplineMatch(project, criteria.scope)).map(project => {
      let score = 0;
      const reasons = [];
      if (targetType && clean(project.buildingType).toLowerCase() === targetType.toLowerCase()) {
        score += 50;
        reasons.push('same building type');
      }
      if (targetConsultant && consultantKey(project.consultant) === targetConsultant) {
        score += 30;
        reasons.push('same consultant');
      }
      if (targetSf > 0 && project.squareFeet > 0) {
        const difference = Math.abs(project.squareFeet - targetSf) / targetSf;
        score += Math.max(0, 30 * (1 - Math.min(difference, 1)));
        if (difference <= .15) reasons.push('very similar square footage');
        else if (difference <= .35) reasons.push('similar square footage');
        else reasons.push('closest available size');
      }
      if (criteria.scope === 'Mechanical + Electrical' && disciplineMatch(project, 'Mechanical') && disciplineMatch(project, 'Electrical')) score += 5;
      return { project, score: Math.round(score * 10) / 10, reasons };
    }).sort((a, b) => b.score - a.score || Math.abs((a.project.squareFeet || 0) - targetSf) - Math.abs((b.project.squareFeet || 0) - targetSf) || String(a.project.projectName).localeCompare(String(b.project.projectName)));
  }

  function createProjectsCsv(projects) {
    const headers = ['Project Number','Project Name','Building Type','Consultant','Overall SF','Total Tonnage','Total Duct LF','HVAC Unit Count','Electrical Panel Count','Unit Types','Manufacturers','Quality Warnings'];
    const rows = projects.map(project => {
      const units = mechanical(project).units || [];
      return [project.projectNumber,project.projectName,project.buildingType,project.consultant,project.squareFeet,mechanical(project).totalTonnage,mechanical(project).totalDuctFeet,hvacUnitCount(project),electrical(project).panelCount,[...new Set(units.map(unit => unit.type).filter(Boolean))].join('; '),[...new Set(units.map(unit => unit.manufacturer).filter(Boolean))].join('; '),(project.quality || []).join('; ')];
    });
    return [headers, ...rows].map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  }

  function isAnalysisEligible(project){return !project.excludedFromAnalysis&&!project.dataAvailability?.globallyExcluded&&project.qualityStatus!=='Blocked'&&project.qualityStatus!=='Excluded'}

  return { clean, consultantKey, normalizeConsultantName, canonicalizeConsultants, rankSimilarProjects, createProjectsCsv, hvacUnitCount, isAnalysisEligible };
});
