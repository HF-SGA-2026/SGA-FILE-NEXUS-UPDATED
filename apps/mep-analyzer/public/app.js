const state={data:null,chart:null,expanded:new Set(),precedentExpanded:new Set(),preview:null,importMode:'add',previewFilter:'first',pendingCommit:null, projectDiscipline:'mechanical', constultantDisciplines:'mechanical', dataQualityDiscipline: "mechanical"};
const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const analysis=window.SGAAnalysis;

document.addEventListener('DOMContentLoaded',init);
async function init(){bindNavigation();bindHelp();bindEstimator();bindProjectFilters();bindConsultants();bindImporter();bindUpdates();bindDataQuality();await refreshData()}
async function refreshData(){const response=await fetch('/api/data');state.data=await response.json();state.data.projects=analysis.canonicalizeConsultants(state.data.projects||[]);renderAll()}
function projects(){return state.data?.projects||[]}
function renderAll(){const label=state.data.isDemo?'Demonstration Data — Replace With Firm Spreadsheet':'Firm spreadsheet data active';$('#dataset-label').textContent=label;populateSelects();renderDashboard();renderProjects();renderConsultants();renderDataQuality();renderManagement()}

function bindNavigation(){
  $$('.section-nav button').forEach(button=>button.addEventListener('click',()=>goTo(button.dataset.section)));
  $$('[data-go]').forEach(button=>button.addEventListener('click',()=>goTo(button.dataset.go)))
}
function goTo(id){$$('.section-nav button').forEach(button=>button.classList.toggle('active',button.dataset.section===id));$$('.page').forEach(page=>page.classList.toggle('active',page.id===id));window.scrollTo({top:0,behavior:'smooth'})}
function bindHelp(){const dialog=$('#help-dialog');$$('[data-help-open]').forEach(button=>button.addEventListener('click',()=>dialog.showModal()));$('#close-help').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()})}

function valid(values){return values.filter(Number.isFinite)}
function sum(values){return valid(values).reduce((a,b)=>a+b,0)}
function average(values){const v=valid(values);return v.length?sum(v)/v.length:null}
function percentile(values,p){const sorted=valid(values).sort((a,b)=>a-b);if(!sorted.length)return null;const index=(sorted.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);return lo===hi?sorted[lo]:sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo)}
function median(values){return percentile(values,.5)}
function number(value,digits=0){return Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:digits}):'Not recorded'}
function compactNumber(value){return Number.isFinite(value)?new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value):'Not recorded'}
function percent(value){return Number.isFinite(value)?`${value.toFixed(1)}%`:'Insufficient data'}
function title(value){return String(value||'').replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}
function esc(value){return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[char])}
function unique(values){return [...new Set(values.filter(value=>value&&value!=='Unknown'))].sort((a,b)=>a.localeCompare(b))}
function mechanical(project){return project.mechanical||{units:[],totalTonnage:null,totalDuctFeet:null}}
function electrical(project){return project.electrical||{panels:[],panelCount:null}}
function projectConsultantForCurrentView(project) {
  if (state.projectDiscipline === "electrical") {
    return (
      electrical(project).consultant ??
      project.consultant
    );
  }

  return (
    mechanical(project).consultant ??
    project.consultant
  );
}


function hasMechanical(project){const m=mechanical(project);return Boolean(m.units?.length||Number.isFinite(m.unitCount)||Number.isFinite(m.totalTonnage)||Number.isFinite(m.totalDuctFeet))}
function hasElectrical(project){const e=electrical(project);return Boolean(e.panels?.length||Number.isFinite(e.panelCount)||e.serviceInfo)}
function allUnits(list=projects()){return list.flatMap(project=>mechanical(project).units||[])}
function countBy(values){return values.filter(Boolean).reduce((acc,value)=>{acc[value]=(acc[value]||0)+1;return acc},{})}
function mode(values){return Object.entries(countBy(values)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||'Insufficient data'}
function topValues(values,n=3){return Object.entries(countBy(values)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,n).map(([name])=>name)}
function projectKey(project){return String(project.projectNumber||project.projectName||'').trim().toLowerCase()}

function populateSelect(select,values,first){const previous=select.value;select.innerHTML=`<option value="">${esc(first)}</option>`+unique(values).map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');if([...select.options].some(option=>option.value===previous))select.value=previous}
function populateSelects(){const types=projects().map(p=>p.buildingType),consultants=projects().map(p=>p.consultant);populateSelect($('#estimate-type'),types,'All building types');populateSelect($('#estimate-consultant'),consultants,'All Consultants');populateSelect($('#filter-type'),types,'All building types');populateSelect($('#filter-consultant'),consultants,'All consultants');populateSelect($('#filter-unit'),allUnits().map(u=>u.type),'All system types');populateSelect($('#filter-manufacturer'),allUnits().map(u=>u.manufacturer),'All manufacturers')}

function renderDashboard(){
  const list=projects(),sf=list.map(p=>p.squareFeet),sfTon=list.map(p=>p.squareFeet&&mechanical(p).totalTonnage?p.squareFeet/mechanical(p).totalTonnage:null);
  const stats=[['Total projects',list.length],['Square footage represented',compactNumber(sum(sf))],['Consultants',new Set(list.map(p=>analysis.consultantKey(p.consultant)).filter(key=>key&&key!=='unknown')).size],['Median square feet per ton',number(median(sfTon))]];
  $('#portfolio-stats').innerHTML=stats.map(([label,value])=>`<div class="portfolio-stat"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');
  $('#recent-projects').innerHTML=[...list].reverse().slice(0,5).map(p=>`<div class="recent-row"><div><strong>${esc(p.projectName)}</strong><span>${esc(p.projectNumber||'No project number')} · ${esc(p.consultant||'Consultant not recorded')}</span></div><span class="sf">${number(p.squareFeet)} SF</span></div>`).join('')||'<p class="helper">No projects are active.</p>';
  renderScatter()
}
function renderScatter(){if(!window.Chart)return;if(state.chart)state.chart.destroy();const data=projects().filter(p=>p.squareFeet&&mechanical(p).totalTonnage).map(p=>({x:p.squareFeet,y:mechanical(p).totalTonnage,project:p.projectName}));state.chart=new Chart($('#tonnage-chart'),{type:'scatter',data:{datasets:[{data,backgroundColor:'#7b302e',pointRadius:5}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.raw.project}: ${number(ctx.raw.x)} SF · ${number(ctx.raw.y,1)} tons`}}},scales:{x:{title:{display:true,text:'Building square feet'},grid:{color:'#e5e0d8'},ticks:{color:'#6d6963'}},y:{title:{display:true,text:'Total HVAC tons'},beginAtZero:true,grid:{color:'#e5e0d8'},ticks:{color:'#6d6963'}}}}})}

function wizardValue(selector) {
  return $(selector)?.value || "";
}

function renderWizardReview() {
  const review = $("#wizard-project-review");

  if (!review) return;

  const sf = Number(wizardValue("#estimate-sf"));
  const buildingType =
    wizardValue("#estimate-type") ||
    "All building types";

  const consultant =
    wizardValue("#estimate-consultant") ||
    "All represented consultants";

  const scope =
    wizardValue("#estimate-scope") ||
    "Mechanical + Electrical";

  review.innerHTML = `
    <div class="wizard-review-row">
      <span>Building square footage</span>
      <strong>${number(sf)} SF</strong>
    </div>

    <div class="wizard-review-row">
      <span>Building type</span>
      <strong>${esc(buildingType)}</strong>
    </div>

    <div class="wizard-review-row">
      <span>Planning scope</span>
      <strong>${esc(scope)}</strong>
    </div>

    <div class="wizard-review-row">
      <span>Consultant context</span>
      <strong>${esc(consultant)}</strong>
    </div>
  `;
}

function setWizardStep(step) {
  const targetStep = Number(step);

  $$("[data-wizard-step]").forEach(panel => {
    panel.hidden =
      Number(panel.dataset.wizardStep) !== targetStep;
  });

  $$(".wizard-progress-item").forEach(item => {
    const itemStep = Number(
      item.dataset.wizardGo
    );

    item.classList.toggle(
      "is-active",
      itemStep === targetStep
    );

    item.classList.toggle(
      "is-complete",
      itemStep < targetStep
    );

    item.setAttribute(
      "aria-current",
      itemStep === targetStep
        ? "step"
        : "false"
    );
  });

  if (targetStep === 3) {
    renderWizardReview();
  }

  if (targetStep === 4) {
    showPlanningRangeOnly();
  }

  if (targetStep === 5) {
    showPrecedentsOnly();
  }

  const newProjectPage =
    $("#new-project");

  if (newProjectPage) {
    newProjectPage.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}

function showPlanningRangeOnly() {
  const results = $("#estimate-results");

  if (!results) return;

  const hero =
    results.querySelector(".estimate-hero");

  const otherSections = [
    ...results.querySelectorAll(
      ".estimate-section"
    )
  ];

  if (hero) {
    hero.hidden = false;
  }

  otherSections.forEach(section => {
    section.hidden = true;
  });
}

function showPrecedentsOnly() {
  const source = $("#estimate-results");
  const destination = $("#wizard-precedent-results");

  if (!source || !destination) return;

  const sections = [
    ...source.querySelectorAll(".estimate-section")
  ];

  if (!sections.length) {
    destination.innerHTML = `
      <div class="empty-state">
        Generate an estimate before viewing comparable projects.
      </div>
    `;

    return;
  }

  destination.innerHTML = "";

  sections.forEach(section => {
    const copy = section.cloneNode(true);

    // The original result sections are hidden during Step 4.
    // The copies displayed in Step 5 must be visible.
    copy.hidden = false;
    copy.removeAttribute("hidden");

    destination.appendChild(copy);
  });

  bindEstimateInteractions();
}

function validateWizardStep(step) {
  if (step === 1) {
    const sf = Number(
      wizardValue("#estimate-sf")
    );

    if (
      !Number.isFinite(sf) ||
      sf < 100
    ) {
      toast(
        "Enter a valid building square footage."
      );

      $("#estimate-sf")?.focus();
      return false;
    }
  }

  return true;
}

function bindEstimator() {
  const form = $("#estimator-form");

  if (!form) {
    console.error("Estimator form was not found.");
    return;
  }

  function activeWizardStep() {
    const panel = form.querySelector(
      '[data-wizard-step]:not([hidden])'
    );

    return Number(
      panel?.dataset.wizardStep || 1
    );
  }

  /*
   * Enter moves to the next wizard step.
   * It only generates the estimate from Step 3.
   */
  form.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;

    const step = activeWizardStep();

    if (step === 1 || step === 2) {
      event.preventDefault();

      if (!validateWizardStep(step)) {
        return;
      }

      setWizardStep(step + 1);
      return;
    }

    if (step !== 3) {
      event.preventDefault();
    }
  });

  form.addEventListener("submit", event => {
    event.preventDefault();

    if (activeWizardStep() !== 3) {
      return;
    }

    renderWizardReview();
    renderEstimate();
    setWizardStep(4);
  });

  $$("[data-wizard-next]").forEach(button => {
    button.addEventListener("click", () => {
      const currentPanel = button.closest(
        "[data-wizard-step]"
      );

      const currentStep = Number(
        currentPanel?.dataset.wizardStep || 1
      );

      if (!validateWizardStep(currentStep)) {
        return;
      }

      const nextStep = Number(
        button.dataset.wizardNext
      );

      setWizardStep(nextStep);
    });
  });

  $$("[data-wizard-back]").forEach(button => {
    button.addEventListener("click", () => {
      setWizardStep(
        Number(button.dataset.wizardBack)
      );
    });
  });

  $$("[data-wizard-go]").forEach(button => {
    button.addEventListener("click", () => {
      const targetStep = Number(
        button.dataset.wizardGo
      );

      const estimateExists = Boolean(
        $("#estimate-results")
          ?.querySelector(".estimate-hero")
      );

      if (targetStep >= 4 && !estimateExists) {
        toast(
          "Complete the project review and generate the planning range first."
        );
        return;
      }

      setWizardStep(targetStep);
    });
  });

  $("#wizard-new-estimate")
    ?.addEventListener("click", () => {
      form.reset();

      $("#estimate-sf").value = "10000";

      const results = $("#estimate-results");

      results.className =
        "estimate-results empty-state";

      results.innerHTML =
        "Complete the first three steps to generate a preliminary planning range.";

      $("#wizard-precedent-results").innerHTML = "";

      setWizardStep(1);
    });

  setWizardStep(1);
}


function comparableSet(buildingType,consultant,scope){const eligible=projects().filter(p=>scope==='Mechanical'?hasMechanical(p):scope==='Electrical'?hasElectrical(p):(hasMechanical(p)||hasElectrical(p)));const stages=[];if(buildingType&&consultant)stages.push({label:`same building type and ${consultant}`,level:0,list:eligible.filter(p=>p.buildingType===buildingType&&analysis.consultantKey(p.consultant)===analysis.consultantKey(consultant))});if(buildingType)stages.push({label:'same building type across all consultants',level:1,list:eligible.filter(p=>p.buildingType===buildingType)});if(consultant)stages.push({label:`${consultant} across all building types`,level:2,list:eligible.filter(p=>analysis.consultantKey(p.consultant)===analysis.consultantKey(consultant))});stages.push({label:'entire available dataset',level:3,list:eligible});return stages.find(stage=>stage.list.length)||stages.at(-1)}
function confidence(n,level){if(n>=8&&level<=1)return'High';if(n>=3&&level<=2)return'Moderate';return'Low'}
function rangeFromRatios(values,transform){const v=valid(values);if(!v.length)return[null,null];const low=v.length>=4?percentile(v,.25):Math.min(...v),high=v.length>=4?percentile(v,.75):Math.max(...v);return[transform(high),transform(low)].sort((a,b)=>a-b)}
function roundHalf(value){return Number.isFinite(value)?Math.round(value*2)/2:null}
function roundTen(value){return Number.isFinite(value)?Math.round(value/10)*10:null}
function calculateEstimate(comparable,sf){
  const mech=comparable.list.filter(p=>p.squareFeet&&mechanical(p).totalTonnage),sfTon=mech.map(p=>p.squareFeet/mechanical(p).totalTonnage),ratio=median(sfTon),tonnage=roundHalf(sf/ratio),tonRange=rangeFromRatios(sfTon,r=>roundHalf(sf/r));
  const ducts=comparable.list.filter(p=>p.squareFeet&&Number.isFinite(mechanical(p).totalDuctFeet)),ductRatios=ducts.map(p=>mechanical(p).totalDuctFeet/p.squareFeet),duct=roundTen(sf*median(ductRatios));
  const unitProjects=comparable.list.filter(p=>p.squareFeet&&mechanical(p).units?.length),unitRatios=unitProjects.map(p=>p.squareFeet/mechanical(p).units.length),unitCount=Number.isFinite(median(unitRatios))?Math.max(1,Math.round(sf/median(unitRatios))):null;
  const elec=comparable.list.filter(p=>p.squareFeet&&electrical(p).panelCount),panelRatios=elec.map(p=>p.squareFeet/electrical(p).panelCount),panelRatio=median(panelRatios),panels=Number.isFinite(panelRatio)?Math.max(1,Math.round(sf/panelRatio)):null,panelRange=rangeFromRatios(panelRatios,r=>Math.max(1,Math.round(sf/r)));
  return{mech,sfTon,ratio,tonnage,tonRange,ducts,ductRatios,duct,unitProjects,unitRatios,unitCount,elec,panelRatios,panelRatio,panels,panelRange}
}

function topConsultantsFromRanked(ranked, limit = 3) {
  const counts = {};

  ranked.forEach(item => {
    const consultant = item.project?.consultant;

    if (!consultant || consultant === 'Unknown') {
      return;
    }

    const key = analysis.consultantKey(consultant);

    if (!counts[key]) {
      counts[key] = {
        name: consultant,
        count: 0
      };
    }

    counts[key].count += 1;
  });

  return Object.values(counts)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function consultantMetric(consultants) {
  if (!consultants.length) {
    return metric(
      'Not enough data',
      'Consultants in similar projects'
    );
  }

  const names = consultants
    .map(item => `${item.name} (${item.count})`)
    .join('<br>');

  return `
    <div class="estimate-metric consultant-suggestion-metric">
      <strong>${names}</strong>
      <span>Most represented in similar SGA projects</span>
    </div>
  `;
}

function renderEstimate(){
  const sf=Number($('#estimate-sf').value),buildingType=$('#estimate-type').value,consultant=$('#estimate-consultant').value,scope=$('#estimate-scope').value,comparable=comparableSet(buildingType,consultant,scope),calc=calculateEstimate(comparable,sf);
  const usableCounts=[];if(scope!=='Electrical')usableCounts.push(calc.mech.length);if(scope!=='Mechanical')usableCounts.push(calc.elec.length);const sample=Math.min(...usableCounts.filter(Number.isFinite)),label=confidence(sample,comparable.level);
  const ranked=analysis.rankSimilarProjects(projects(),{squareFeet:sf,buildingType,consultant,scope}).slice(0,5);
  const topConsultants = topConsultantsFromRanked(ranked, 3);
  const warnings=estimateWarnings(label,comparable,calc,scope);
  const metrics=[];
  if (scope !== 'Electrical') {
  metrics.push(
    metric(
      `${number(calc.tonRange[0],1)}–${number(calc.tonRange[1],1)} tons`,
      'Estimated HVAC tonnage range'
    )
  );

  metrics.push(
    metric(
      number(calc.unitCount),
      'Estimated HVAC units'
    )
  );

  metrics.push(
    metric(
      `${number(calc.duct)} ft`,
      'Estimated ductwork'
    )
  );

  metrics.push(
    consultantMetric(topConsultants)
  );
}
  if(scope!=='Mechanical'&&Number.isFinite(calc.panels))metrics.push(metric(`${number(calc.panelRange[0])}–${number(calc.panelRange[1])}`,'Estimated electrical panels'));
  $('#estimate-results').className='estimate-results';
  $('#estimate-results').innerHTML=`<section class="estimate-hero"><div class="estimate-hero-header"><div><p class="kicker">Preliminary planning range</p><h3>${number(sf)} SF ${esc(buildingType||'project')}</h3><p>Based on ${number(comparable.list.length)} comparable SGA project${comparable.list.length===1?'':'s'}.</p></div><span class="badge ${label.toLowerCase()}">${label} confidence</span></div><div class="estimate-summary">${metrics.join('')}</div>${warnings.map(w=>`<div class="warning">${esc(w)}</div>`).join('')}<details class="calculation-details"><summary>How this estimate was calculated</summary><div class="detail-content">${calculationDetails(comparable,calc,sf,scope)}</div></details></section>${precedentSection(ranked)}${similarConsultantsSection(comparable.list)}`;
  bindEstimateInteractions()
}
function metric(value,label){return`<div class="estimate-metric"><strong>${value}</strong><span>${label}</span></div>`}
function estimateWarnings(label,comparable,calc,scope){const warnings=[];if(comparable.level>0)warnings.push(`A broader fallback was needed: ${comparable.label}.`);if(label==='Low')warnings.push('Confidence is low because few comparable projects contain the required measurements.');if(comparable.list.some(p=>!p.squareFeet))warnings.push('Some comparable records are missing square footage.');if(new Set(comparable.list.map(p=>p.buildingType)).size>1&&comparable.level>=2)warnings.push('The fallback set contains mixed building types.');if(scope!=='Electrical'&&calc.mech.some(p=>mechanical(p).units?.some(u=>u.tonnage==null||!u.type)))warnings.push('Some comparable equipment records are incomplete.');return warnings}
function calculationDetails(c,calc,sf,scope){let html=`<p><strong>Comparable selection:</strong> ${esc(c.label)}. ${c.level?`This is fallback level ${c.level}.`:'No broader fallback was needed.'}</p>`;if(scope!=='Electrical')html+=`<p><strong>Mechanical:</strong> ${number(sf)} SF ÷ median ${number(calc.ratio)} SF/ton = ${number(calc.tonnage,1)} tons. Range uses ${calc.mech.length>=4?'25th–75th percentiles':'minimum–maximum observed values'}. Ductwork uses median ${number(median(calc.ductRatios),3)} duct ft/SF. Unit count uses median ${number(median(calc.unitRatios))} SF/unit.</p>`;if(scope!=='Mechanical')html+=`<p><strong>Electrical:</strong> ${number(sf)} SF ÷ median ${number(calc.panelRatio)} SF/panel = ${number(calc.panels)} panels. Range uses ${calc.elec.length>=4?'25th–75th percentiles':'minimum–maximum observed values'}.</p>`;html+=`<p><strong>Projects used for calculations:</strong> ${c.list.map(p=>esc(`${p.projectNumber||'No number'} — ${p.projectName}`)).join('; ')||'None with usable data'}.</p><p>Historical observation only—not an engineering calculation, equipment selection, or consultant recommendation.</p>`;return html}
function precedentSection(ranked){return`<section class="estimate-section"><div class="panel-heading"><div><p class="kicker">Ranked precedents</p><h3>Most Similar SGA Projects</h3></div><span>Building type, consultant, and size relevance</span></div><div class="precedent-list">${ranked.length?ranked.map(precedentCard).join(''):'<p class="helper">No comparable projects are available.</p>'}</div></section>`}
function similarConsultantsSection(list){const grouped=Object.entries(list.reduce((acc,p)=>{const key=analysis.consultantKey(p.consultant);if(!key||key==='unknown')return acc;(acc[key]??={name:p.consultant,projects:[]}).projects.push(p);return acc},{})).map(([,entry])=>entry).sort((a,b)=>b.projects.length-a.projects.length);return`<section class="estimate-section"><div class="panel-heading"><div><p class="kicker">Historical context</p><h3>Consultants represented in similar SGA projects</h3></div><span>Not recommended or ranked</span></div><div class="similar-consultants">${grouped.length?grouped.map(entry=>{const ratios=entry.projects.map(p=>p.squareFeet&&mechanical(p).totalTonnage?p.squareFeet/mechanical(p).totalTonnage:null);return`<article class="similar-consultant"><h4>${esc(entry.name)}</h4><p>${entry.projects.length} relevant project${entry.projects.length===1?'':'s'}<br>${esc(unique(entry.projects.map(p=>p.buildingType)).join(', ')||'Building types not recorded')}<br>${valid(ratios).length>=2?`Median ${number(median(ratios))} SF/ton`:'Insufficient data for SF/ton tendency'}</p><button class="text-button" data-profile-link="${esc(entry.name)}">View consultant profile</button></article>`}).join(''):'<p class="helper">Consultant information is not recorded in these projects.</p>'}</div></section>`}

function bindEstimateInteractions() {
  $$("[data-open-project]").forEach(button => {
    button.addEventListener("click", () => {
      const projectId = button.dataset.openProject;

      openProject(projectId);
    });
  });

  $$("[data-profile-link]").forEach(button => {
    button.addEventListener("click", () => {
      goTo("consultants");
      openConsultantProfile(
        button.dataset.profileLink
      );
    });
  });
}


function projectWarnings(project){const warnings=[...(project.quality||[])];if(!project.squareFeet)warnings.push('Missing overall square footage.');if(!project.consultant||project.consultant==='Unknown')warnings.push('Missing consultant.');if(hasMechanical(project)&&mechanical(project).units?.some(u=>u.tonnage==null||!u.type))warnings.push('One or more HVAC units have incomplete equipment data.');if(hasElectrical(project)&&!Number.isFinite(electrical(project).panelCount))warnings.push('Electrical panel count is unavailable.');return unique(warnings)}
function bindProjectFilters() {
  const filterSelectors = [
    "#project-search",
    "#filter-type",
    "#filter-consultant",
    "#filter-unit",
    "#filter-manufacturer",
    "#filter-special",
    "#filter-missing"
  ];

  filterSelectors.forEach(selector => {
    const element = $(selector);

    if (!element) {
      console.warn(
        `Project filter not found: ${selector}`
      );
      return;
    }

    element.addEventListener(
      "input",
      renderProjects
    );

    element.addEventListener(
      "change",
      renderProjects
    );
  });

  const exportButton =
    $("#export-filtered");

  if (exportButton) {
    exportButton.addEventListener(
      "click",
      () => {
        exportProjects(
          filteredProjects(),
          "sga-mep-filtered-projects.csv"
        );
      }
    );
  }
}

function filteredProjects(){const q=$('#project-search').value.trim().toLowerCase(),type=$('#filter-type').value,consultant=$('#filter-consultant').value,unitType=$('#filter-unit').value,manufacturer=$('#filter-manufacturer').value;return projects().filter(p=>{const units=mechanical(p).units||[];return(!q||`${p.projectNumber} ${p.projectName}`.toLowerCase().includes(q))&&(!type||p.buildingType===type)&&(!consultant||analysis.consultantKey(p.consultant)===analysis.consultantKey(consultant))&&(!unitType||units.some(u=>u.type===unitType))&&(!manufacturer||units.some(u=>u.manufacturer===manufacturer))&&(!$('#filter-special').checked||units.some(u=>/custom|unusual/i.test(u.classification||'')))&&(!$('#filter-missing').checked||projectWarnings(p).length)})}
function renderProjects(){const list=filteredProjects();$('#project-count').textContent=`Showing ${list.length} of ${projects().length} projects`;if(!list.length){$('#projects-table').innerHTML='<div class="empty-state">No projects match the current filters.</div>';return}$('#projects-table').innerHTML=`<table><thead><tr><th></th><th>Project</th><th>Building type</th><th>Consultant</th><th>SF</th><th>Tons</th><th>Units</th><th>Panels</th><th>Status</th></tr></thead><tbody>${list.map(projectRows).join('')}</tbody></table>`;$$('.expand-btn').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.id;state.expanded.has(id)?state.expanded.delete(id):state.expanded.add(id);renderProjects()}));$$('[data-related-id]').forEach(button=>button.addEventListener('click',()=>openProject(button.dataset.relatedId)))}
function projectRows(p){const open=state.expanded.has(p.id),warnings=projectWarnings(p);return`<tr><td><button class="expand-btn" data-id="${esc(p.id)}" aria-expanded="${open}">${open?'−':'+'}</button></td><td><strong>${esc(p.projectName)}</strong><br><span class="source-note">${esc(p.projectNumber||'No project number')}</span></td><td>${esc(p.buildingType||'Not recorded')}</td><td><span class="consultant-badge">${esc(p.consultant||'Not recorded')}</span></td><td>${number(p.squareFeet)}</td><td>${number(mechanical(p).totalTonnage,1)}</td><td>${number(mechanical(p).units?.length)}</td><td>${number(electrical(p).panelCount)}</td><td>${warnings.length?`<span class="badge low">${warnings.length} warning${warnings.length===1?'':'s'}</span>`:'<span class="badge high">Ready</span>'}</td></tr>${open?`<tr class="detail-row"><td colspan="9">${projectDetail(p,warnings)}</td></tr>`:''}`}
function relatedProjects(p){return analysis.rankSimilarProjects(projects().filter(other=>other.id!==p.id),{squareFeet:p.squareFeet,buildingType:p.buildingType,consultant:p.consultant,scope:'Mechanical + Electrical'}).slice(0,3).map(item=>item.project)}
function projectDetail(p,warnings,compact=false){const units=(mechanical(p).units||[]).length?mechanical(p).units.map(u=>`<div class="unit-item"><span><strong>${esc(u.name||'Unnamed')}</strong></span><span>${number(u.tonnage,1)} tons</span><span>${esc(u.type||'Not recorded')}</span><span>${esc(u.manufacturer||'Not recorded')}</span><span>${esc(u.model||'Not recorded')}</span><span>${esc(u.classification||'Not recorded')}</span></div>`).join(''):'<p>No mechanical equipment detail recorded.</p>',panels=(electrical(p).panels||[]).map(panel=>`${esc(panel.name||'Unnamed panel')} (${number(panel.count)})`).join(', ')||'No panel detail recorded.';if(compact)return`<p><strong>Mechanical:</strong> ${number(mechanical(p).totalTonnage,1)} tons · ${number(mechanical(p).totalDuctFeet)} duct LF · ${number(mechanical(p).units?.length)} units<br><strong>Electrical:</strong> ${number(electrical(p).panelCount)} panels · ${esc(electrical(p).serviceInfo||'Service not recorded')}<br><strong>Notes:</strong> ${esc((p.notes||[]).join('; ')||'No notes recorded.')}</p>`;const related=relatedProjects(p);return`<div class="project-detail"><div class="detail-grid"><div><span>Consultant</span><strong>${esc(p.consultant||'Not recorded')}</strong></div><div><span>Overall SF</span><strong>${number(p.squareFeet)}</strong></div><div><span>Total tonnage</span><strong>${number(mechanical(p).totalTonnage,1)}</strong></div><div><span>Total duct</span><strong>${number(mechanical(p).totalDuctFeet)} LF</strong></div><div><span>Electrical panels</span><strong>${number(electrical(p).panelCount)}</strong></div></div><h3>Mechanical records</h3><div class="unit-list">${units}</div><h3>Electrical records</h3><p><strong>Panels:</strong> ${panels}<br><strong>Service:</strong> ${esc(electrical(p).serviceInfo||'Not recorded')}</p><h3>Notes</h3><p>${esc((p.notes||[]).join('; ')||electrical(p).notes||'No notes recorded.')}</p>${warnings.length?`<h3>Data-quality warnings</h3><ul class="quality-list">${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}<h3>Related projects</h3><div class="related-list">${related.map(other=>`<button data-related-id="${esc(other.id)}">${esc(other.projectName)}</button>`).join('')||'No related projects available.'}</div></div>`}
function openProject(id){$('#project-search').value='';$('#filter-type').value='';$('#filter-consultant').value='';$('#filter-unit').value='';$('#filter-manufacturer').value='';$('#filter-special').checked=false;$('#filter-missing').checked=false;state.expanded.add(id);renderProjects();goTo('past-projects')}
function exportProjects(list,filename){const csv=analysis.createProjectsCsv(list),blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url)}

function consultantStats(name){const list=projects().filter(p=>analysis.consultantKey(p.consultant)===analysis.consultantKey(name)),sf=list.map(p=>p.squareFeet),tons=list.map(p=>mechanical(p).totalTonnage),ratios=list.map(p=>p.squareFeet&&mechanical(p).totalTonnage?p.squareFeet/mechanical(p).totalTonnage:null),units=allUnits(list),projectUnits=list.filter(hasMechanical).map(p=>mechanical(p).units?.length||0),checks=list.flatMap(p=>[p.projectNumber,p.projectName,p.buildingType,p.squareFeet,mechanical(p).totalTonnage,electrical(p).panelCount]),missing=checks.filter(v=>v==null||v===''||v==='Unknown').length/Math.max(1,checks.length)*100;return{name,list,types:unique(list.map(p=>p.buildingType)),totalSf:sum(sf),medSf:median(sf),minSf:valid(sf).length?Math.min(...valid(sf)):null,maxSf:valid(sf).length?Math.max(...valid(sf)):null,medTon:median(tons),sfTon:median(ratios),unitCount:average(projectUnits),systems:topValues(units.map(u=>u.type)),manufacturers:topValues(units.map(u=>u.manufacturer)),panels:average(list.map(p=>electrical(p).panelCount)),custom:units.filter(u=>/custom|unusual/i.test(u.classification||'')).length,missing}}
function bindConsultants(){$('#toggle-comparison').addEventListener('click',openComparison);$('#close-comparison').addEventListener('click',()=>$('#comparison-mode').classList.add('hidden'))}
function openConsultantProfile(name){const s=consultantStats(name),panel=$('#consultant-profile');panel.classList.remove('hidden');panel.innerHTML=`<div class="profile-header"><div><p class="kicker">Consultant profile · ${s.list.length} project${s.list.length===1?'':'s'}</p><h2>${esc(s.name)}</h2><p class="heading-copy">Patterns observed in recorded SGA projects. Not a measure of engineering quality.</p></div><div class="card-actions"><button id="profile-compare" class="secondary">Select for comparison</button><button id="close-profile" class="text-button">Close</button></div></div>${s.list.length<2?'<div class="warning">Only one recorded project is available. Do not interpret this as a consultant-wide tendency.</div>':''}<div class="detail-grid"><div><span>Building types</span><strong>${esc(s.types.join(', ')||'Not recorded')}</strong></div><div><span>Project size range</span><strong>${number(s.minSf)}–${number(s.maxSf)} SF</strong></div><div><span>Common systems</span><strong>${esc(s.systems.join(', ')||'Insufficient data')}</strong></div><div><span>Common manufacturers</span><strong>${esc(s.manufacturers.join(', ')||'Insufficient data')}</strong></div><div><span>Average electrical panels</span><strong>${number(s.panels,1)}</strong></div><div><span>Data completeness</span><strong>${percent(100-s.missing)}</strong></div></div><h3>Historical projects</h3><div class="profile-projects">${s.list.map(p=>`<article class="profile-project"><strong>${esc(p.projectName)}</strong><br><span class="source-note">${esc(p.projectNumber||'No number')} · ${esc(p.buildingType)} · ${number(p.squareFeet)} SF · ${number(mechanical(p).totalTonnage,1)} tons · ${number(electrical(p).panelCount)} panels</span></article>`).join('')}</div><p class="warning">Differences among consultants may reflect building type, owner requirements, project scope, or incomplete records. This profile is not a recommendation or performance ranking.</p>`;$('#close-profile').addEventListener('click',()=>panel.classList.add('hidden'));$('#profile-compare').addEventListener('click',()=>{const checkbox=$$('.consultant-select').find(input=>input.value===s.name);if(checkbox)checkbox.checked=true;toast(`${s.name} selected. Choose at least one more consultant, then compare.`)});panel.scrollIntoView({behavior:'smooth',block:'start'})}
function showConsultantProjects(name){goTo('past-projects');$('#filter-consultant').value=name;renderProjects()}
function openComparison(){const selected=$$('.consultant-select:checked').map(input=>input.value);if(selected.length<2){toast('Select at least two consultant cards to compare.');return}$('#comparison-mode').classList.remove('hidden');renderComparison(selected);$('#comparison-mode').scrollIntoView({behavior:'smooth',block:'start'})}
function renderComparison(selected){$('#consultant-picker').innerHTML=unique(projects().map(p=>p.consultant)).map(name=>`<label><input type="checkbox" value="${esc(name)}" ${selected.includes(name)?'checked':''}>${esc(name)}</label>`).join('');$$('#consultant-picker input').forEach(input=>input.addEventListener('change',()=>renderComparisonResults($$('#consultant-picker input:checked').map(i=>i.value))));renderComparisonResults(selected)}
function renderComparisonResults(selected){if(selected.length<2){$('#comparison-table-wrap').innerHTML='<div class="empty-state">Select at least two consultants.</div>';$('#tendencies').innerHTML='';return}const stats=selected.map(consultantStats),rows=[['Projects represented',s=>s.list.length],['Building types',s=>esc(s.types.join(', ')||'Not recorded')],['Median project SF',s=>number(s.medSf)],['Median HVAC tonnage',s=>number(s.medTon,1)],['Median SF per ton',s=>s.list.length>=2?number(s.sfTon):'Insufficient data'],['Average HVAC units',s=>number(s.unitCount,1)],['Observed systems',s=>esc(s.systems.join(', ')||'Insufficient data')],['Observed manufacturers',s=>esc(s.manufacturers.join(', ')||'Insufficient data')],['Average electrical panels',s=>number(s.panels,1)],['Custom / unusual units',s=>s.custom],['Missing key fields',s=>percent(s.missing)]];$('#comparison-table-wrap').innerHTML=`<table><thead><tr><th>Recorded measure</th>${stats.map(s=>`<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(([label,get])=>`<tr><th>${label}</th>${stats.map(s=>`<td>${get(s)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;$('#tendencies').innerHTML=stats.map(s=>`<article class="tendency"><p><strong>${esc(s.name)}</strong><br>${s.list.length<2?`Only one project is represented; no consultant-wide tendency should be inferred.`:`Historically represented on ${s.list.length} projects between ${number(s.minSf)} and ${number(s.maxSf)} SF. ${s.systems.length?`${esc(s.systems[0])} is the most frequently recorded system.`:''}`}<br><em>Not a measure of engineering quality.</em></p></article>`).join('')}

function bindImporter(){$('#import-form').addEventListener('submit',event=>{event.preventDefault();previewImport(null,false)})}
function bindSquareFeetConflictActions() {
  $$('input[name^="sf-conflict-"]').forEach(
    radio => {
      radio.addEventListener("change", () => {
        const projectId = radio.name.replace(
          "sf-conflict-",
          ""
        );

        const customInput = document.querySelector(
          `[data-sf-custom="${CSS.escape(projectId)}"]`
        );

        if (!customInput) return;

        const useCustom =
          radio.value === "custom";

        customInput.disabled = !useCustom;

        if (useCustom) {
          customInput.focus();
        } else {
          customInput.value = "";
        }
      });
    }
  );

  $$("[data-resolve-sf]").forEach(button => {
    button.addEventListener("click", async () => {
      const projectId =
        button.dataset.resolveSf;

      const selected = document.querySelector(
        `input[name="sf-conflict-${CSS.escape(
          projectId
        )}"]:checked`
      );

      if (!selected) {
        toast(
          "Choose which square-footage value should be used."
        );
        return;
      }

      let selectedValue;
      let source = "imported";

      if (selected.value === "custom") {
        const customInput =
          document.querySelector(
            `[data-sf-custom="${CSS.escape(
              projectId
            )}"]`
          );

        selectedValue = Number(
          customInput?.value
        );

        source = "custom";
      } else {
        selectedValue = Number(
          selected.value
        );
      }

      if (
        !Number.isFinite(selectedValue) ||
        selectedValue <= 0
      ) {
        toast(
          "Enter a valid corrected square footage."
        );
        return;
      }

      button.disabled = true;
      button.textContent = "Saving…";

      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(
            projectId
          )}/resolve-square-feet`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              squareFeet: selectedValue,
              source
            })
          }
        );

        const result = await response.json();

        if (!response.ok) {
          throw new Error(
            result.error ||
              "The decision could not be saved."
          );
        }

        state.data = result.data;

        toast(
          result.message ||
            "Square footage decision saved."
        );

        renderProjects();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
        button.textContent =
          "Save square footage decision";
      }
    });
  });
}

function bindSquareFeetReopenActions() {
  $$("[data-reopen-sf]").forEach(button => {
    button.addEventListener("click", async () => {
      const projectId = button.dataset.reopenSf;

      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/reopen-square-feet`,
          {
            method: "POST"
          }
        );

        const result = await response.json();

        if (!response.ok) {
          throw new Error(
            result.error || "The SF decision could not be reopened."
          );
        }

        state.data = result.data;
        toast("Square-footage review reopened.");
        renderProjects();
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function setImportStatus(message,kind=''){const el=$('#import-status');el.textContent=message;el.className=`status ${kind}`}
function setImportStep(step){$$('[data-step-label]').forEach(label=>{const n=Number(label.dataset.stepLabel);label.classList.toggle('active',n===step);label.classList.toggle('complete',n<step)})}
async function previewImport(mapping=null,continueToReview=false){const file=$('#import-file').files[0];if(!file)return;setImportStatus('Reading and normalizing the spreadsheet…');const form=new FormData();form.append('file',file);form.append('type',$('#import-type').value);if(mapping)form.append('mapping',JSON.stringify(mapping));try{const response=await fetch('/api/import/preview',{method:'POST',body:form}),result=await response.json();if(!response.ok)throw new Error(result.error);state.preview=result;state.previewFilter='first';collapseUpload();renderMapping();setImportStatus(`Found ${result.projects.records.length} projects.`,'success');if(continueToReview)showReview()}catch(error){setImportStatus(error.message,'error')}}
function collapseUpload(){$('#import-step-1').classList.remove('active-step');$('#import-step-1').classList.add('collapsed-step');$('#import-form').classList.add('hidden');let summary=$('#upload-summary');if(!summary){summary=document.createElement('div');summary.id='upload-summary';summary.className='panel-heading';$('#import-step-1').append(summary)}summary.innerHTML=`<span>${esc(state.preview.filename)} · ${title(state.preview.type)}</span><button id="edit-upload" class="text-button">Edit upload</button>`;$('#edit-upload').addEventListener('click',()=>{resetImportPanels();$('#import-form').classList.remove('hidden');summary.remove();$('#import-step-1').classList.remove('collapsed-step');$('#import-step-1').classList.add('active-step');setImportStep(1)})}
function renderMapping(){const p=state.preview,panel=$('#mapping-panel');$('#preview-panel').classList.add('hidden');$('#save-panel').classList.add('hidden');panel.classList.remove('hidden');panel.classList.add('active-step');setImportStep(2);panel.innerHTML=`<div class="step-heading"><span>2</span><div><h3>Verify Columns</h3><p>Confirm how spreadsheet headings map to the project fields. Detected header row: ${p.headerRow}.</p></div></div><div class="mapping-grid">${Object.entries(p.mapping).map(([field,mapped])=>`<label>${esc(title(field))}<select data-map="${esc(field)}"><option value="">Not mapped</option>${p.headers.map(h=>`<option value="${esc(h)}" ${h===mapped?'selected':''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}</div><button id="apply-mapping" class="primary">Apply mapping & review records</button>`;$('#apply-mapping').addEventListener('click',()=>{const mapping={};$$('[data-map]').forEach(select=>mapping[select.dataset.map]=select.value);previewImport(mapping,true)})}
function showReview(){$('#mapping-panel').classList.remove('active-step');$('#mapping-panel').innerHTML=`<div class="panel-heading"><span>Columns verified · ${Object.values(state.preview.mapping).filter(Boolean).length} fields mapped</span><button id="edit-mapping" class="text-button">Edit</button></div>`;$('#edit-mapping').addEventListener('click',renderMapping);renderPreview();setImportStep(3)}
function classifyRecord(project){const required=[],optional=[],info=[];if(!project.squareFeet)required.push('Square footage missing');if(!project.projectName&&!project.projectNumber)required.push('Project identity missing');if(!project.consultant||project.consultant==='Unknown')optional.push('Consultant missing');if(!project.buildingType||project.buildingType==='Unknown')optional.push('Building type missing');if(hasMechanical(project)&&mechanical(project).units?.some(u=>u.tonnage==null||!u.type))optional.push('Equipment detail incomplete');(project.quality||[]).forEach(w=>{/conflict/i.test(w)?info.push(w):optional.push(w)});return{required:unique(required),optional:unique(optional),info:unique(info)}}
function previewSummary(){const p=state.preview,records=p.projects.records,classified=records.map(classifyRecord),keys=records.map(projectKey),active=new Set(projects().map(projectKey));return{projects:records.length,equipment:p.projects.equipmentCount,ready:classified.filter(c=>!c.required.length).length,warnings:classified.filter(c=>c.required.length||c.optional.length||c.info.length).length,duplicates:new Set(keys.filter((key,index)=>keys.indexOf(key)!==index||active.has(key))).size,skipped:p.projects.errors.length}}
function previewRecords(){const records=state.preview.projects.records;if(state.previewFilter==='warnings')return records.filter(p=>{const c=classifyRecord(p);return c.required.length||c.optional.length||c.info.length});if(state.previewFilter==='all')return records;return records.slice(0,10)}
function renderPreview(){const p=state.preview,s=previewSummary(),records=previewRecords(),panel=$('#preview-panel');panel.classList.remove('hidden');panel.classList.add('active-step');panel.innerHTML=`<div class="step-heading"><span>3</span><div><h3>Review Records</h3><p>Review the initial records or focus on records that need attention.</p></div></div><div class="import-summary">${[['Projects found',s.projects],['Equipment records',s.equipment],['Records ready',s.ready],['With warnings',s.warnings],['Duplicates',s.duplicates],['Skipped rows',s.skipped]].map(([label,value])=>`<div><strong>${value}</strong><span>${label}</span></div>`).join('')}</div>${p.projects.errors.length?`<div class="warning"><strong>Skipped rows:</strong> ${p.projects.errors.slice(0,4).map(esc).join(' · ')}</div>`:''}<div class="preview-tabs"><button data-preview-filter="first" class="${state.previewFilter==='first'?'active':''}">First 10</button><button data-preview-filter="warnings" class="${state.previewFilter==='warnings'?'active':''}">Records with warnings</button><button data-preview-filter="all" class="${state.previewFilter==='all'?'active':''}">Show all records</button></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Type</th><th>Consultant</th><th>SF</th><th>${p.type==='mechanical'?'Units':'Panels'}</th><th>Review status</th></tr></thead><tbody>${records.map(project=>{const c=classifyRecord(project),status=c.required.length?`<span class="badge low">Required issue</span> ${esc(c.required.join('; '))}`:c.optional.length?`<span class="badge moderate">Optional missing</span> ${esc(c.optional.join('; '))}`:c.info.length?`<span class="badge high">Normalized</span> ${esc(c.info.join('; '))}`:'Ready';return`<tr><td><strong>${esc(project.projectName)}</strong><br>${esc(project.projectNumber||'No number')}</td><td>${esc(project.buildingType)}</td><td>${esc(project.consultant)}</td><td>${number(project.squareFeet)}</td><td>${p.type==='mechanical'?number(mechanical(project).units.length):number(electrical(project).panelCount)}</td><td>${status}</td></tr>`}).join('')}</tbody></table></div><button id="continue-save" class="primary">Continue to save options</button>`;$$('[data-preview-filter]').forEach(button=>button.addEventListener('click',()=>{state.previewFilter=button.dataset.previewFilter;renderPreview()}));$('#continue-save').addEventListener('click',showSaveOptions)}
function showSaveOptions(){const s=previewSummary();$('#preview-panel').classList.remove('active-step');$('#preview-panel').innerHTML=`<div class="panel-heading"><span>${s.projects} projects reviewed · ${s.warnings} with warnings · ${s.duplicates} duplicates detected</span><button id="edit-review" class="text-button">Edit</button></div>`;$('#edit-review').addEventListener('click',renderPreview);const p=state.preview,panel=$('#save-panel');panel.classList.remove('hidden');panel.classList.add('active-step');setImportStep(4);panel.innerHTML=`<div class="step-heading"><span>4</span><div><h3>Save Data</h3><p>Choose how this ${esc(p.type)} spreadsheet should update the active local dataset.</p></div></div><div class="preview-actions"><label>Import mode<select id="commit-mode"><option value="add" ${state.importMode==='add'?'selected':''}>Add records</option><option value="replace" ${state.importMode==='replace'?'selected':''}>Replace ${esc(p.type)} dataset</option></select></label><label>Duplicate project numbers<select id="duplicate-action"><option value="skip">Skip duplicates</option><option value="replace">Replace duplicates</option><option value="merge">Merge discipline data</option></select></label><button id="commit-import" class="primary">Save firm data</button></div><p class="helper">The first firm import removes fictional demonstration records. All data remains on this computer.</p>`;$('#commit-import').addEventListener('click',commitImport)}
async function commitImport(){const p=state.preview,button=$('#commit-import');button.disabled=true;try{const response=await fetch('/api/import/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:p.type,filename:p.filename,records:p.projects.records,mode:$('#commit-mode').value,duplicateAction:$('#duplicate-action').value})}),result=await response.json();if(!response.ok)throw new Error(result.error);state.data=result.data;state.data.projects=analysis.canonicalizeConsultants(state.data.projects||[]);$('#save-panel').innerHTML=`<div class="save-success"><p class="kicker">Import complete</p><h3>Firm spreadsheet data is now active.</h3><p>${result.summary.imported} projects saved · ${result.summary.skipped} skipped · ${result.summary.duplicates} duplicates detected.</p><button id="import-another" class="secondary">Import another spreadsheet</button></div>`;setImportStep(4);$('#import-another').addEventListener('click',resetImport);renderAll();toast('Firm spreadsheet data is now active.')}catch(error){toast(error.message);button.disabled=false}}
function resetImportPanels(){['#mapping-panel','#preview-panel','#save-panel'].forEach(selector=>{$(selector).classList.add('hidden');$(selector).classList.remove('active-step')})}
function resetImport(){state.preview=null;state.importMode='add';$('#import-form').reset();$('#import-form').classList.remove('hidden');$('#upload-summary')?.remove();resetImportPanels();$('#import-step-1').classList.remove('collapsed-step');$('#import-step-1').classList.add('active-step');setImportStep(1);setImportStatus('')}
function renderManagement(){const cards=['mechanical','electrical'].map(type=>{const count=projects().filter(type==='mechanical'?hasMechanical:hasElectrical).length,info=state.data.imports?.[type];return`<article class="management-card"><header><div><p class="kicker">${title(type)} data</p><div class="big">${count} projects</div></div><span class="badge ${info?'high':'low'}">${info?'Active':'No import'}</span></header><p class="helper">Last import: ${info?new Date(info.at).toLocaleString():'Not yet imported'}<br>Source: ${esc(info?.filename||(state.data.isDemo?'Fictional demonstration data':'Not recorded'))}</p><div class="actions"><button class="action-button" data-action="start" data-mode="replace" data-type="${type}">Replace</button><button class="action-button" data-action="start" data-mode="add" data-type="${type}">Add records</button><button class="action-button" data-action="export" data-type="${type}">Export cleaned</button><button class="action-button danger" data-action="clear" data-type="${type}">Clear</button></div></article>`});$('#management-cards').innerHTML=cards.join('')+`<article class="management-card"><p class="kicker">Demonstration records</p><h3>Restore fictional sample data</h3><p class="helper">Replaces the current local dataset with the original fictional demonstration portfolio.</p><button id="restore-demo" class="secondary">Restore demonstration data</button></article>`;$$('[data-action="start"]').forEach(button=>button.addEventListener('click',()=>{state.importMode=button.dataset.mode;$('#import-type').value=button.dataset.type;$('#import-file').focus();toast(`Choose a ${button.dataset.type} spreadsheet to ${button.dataset.mode==='replace'?'replace the dataset':'add records'}.`)}));$$('[data-action="export"]').forEach(button=>button.addEventListener('click',()=>exportProjects(projects().filter(button.dataset.type==='mechanical'?hasMechanical:hasElectrical),`sga-${button.dataset.type}-cleaned.csv`)));$$('[data-action="clear"]').forEach(button=>button.addEventListener('click',()=>clearDataset(button.dataset.type)));$('#restore-demo').addEventListener('click',restoreDemo)}
async function clearDataset(type){if(!confirm(`Clear all current ${type} data from this local dataset? Re-importing the source spreadsheet will be required to restore it.`))return;const response=await fetch('/api/data/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type})});state.data=await response.json();renderAll();toast(`${title(type)} data cleared.`)}
async function restoreDemo(){if(!confirm('Replace the current local dataset with fictional demonstration data?'))return;const response=await fetch('/api/data/demo',{method:'POST'});state.data=await response.json();renderAll();toast('Fictional demonstration data restored.')}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),3500)}

// Persistent project updates and data quality
function analysisProjects(){return projects().filter(project=>!project.excludedFromAnalysis&&project.qualityStatus!=='Blocked'&&project.qualityStatus!=='Excluded')}
function hvacUnitCount(project){return analysis.hvacUnitCount(project)}
function qualityStatus(project){return project.qualityStatus||'Complete'}

function renderDashboard() {
  const list = projects();

  const squareFootages = list
    .map(project => Number(project.squareFeet))
    .filter(Number.isFinite);

  const sfPerTon = list
    .map(project => {
      const sf = Number(project.squareFeet);
      const tons = Number(mechanical(project).totalTonnage);

      return Number.isFinite(sf) &&
        Number.isFinite(tons) &&
        tons > 0
        ? sf / tons
        : null;
    })
    .filter(Number.isFinite);

  const consultantCount = new Set(
    list
      .map(project =>
        analysis.consultantKey(project.consultant)
      )
      .filter(
        key =>
          key &&
          key !== "unknown"
      )
  ).size;

  const stats = [
    {
      label: "Historical Projects",
      value: number(list.length),
      note: "Recorded SGA projects"
    },
    {
      label: "Portfolio Size",
      value: `${compactNumber(
        sum(squareFootages)
      )} SF`,
      note: "Square footage represented"
    },
    {
      label: "Consultants Recorded",
      value: number(consultantCount),
      note: "MEP firms in the dataset"
    },
    {
      label: "Historical SF / Ton",
      value: number(median(sfPerTon)),
      note: "Median recorded relationship"
    }
  ];

  const portfolioStats =
    $("#portfolio-stats");

  if (portfolioStats) {
    portfolioStats.innerHTML = stats
      .map(
        stat => `
          <article class="dashboard-stat">
            <span>${esc(stat.label)}</span>

            <strong>
              ${stat.value}
            </strong>

            <small>
              ${esc(stat.note)}
            </small>
          </article>
        `
      )
      .join("");
  }

  const recentProjects = [...list]
    .reverse()
    .slice(0, 5);

  const recentContainer =
    $("#recent-projects");

  if (recentContainer) {
    recentContainer.innerHTML =
      recentProjects.length
        ? recentProjects
            .map(project => {
              const status =
                qualityStatus(project);

              return `
                <button
                  type="button"
                  class="dashboard-recent-project"
                  data-dashboard-project="${esc(project.id)}"
                >
                  <span class="dashboard-recent-main">
                    <strong>
                      ${esc(project.projectName)}
                    </strong>

                    <small>
                      ${esc(
                        project.buildingType ||
                        "Building type not recorded"
                      )}
                      ·
                      ${esc(
                        project.consultant ||
                        "Consultant not recorded"
                      )}
                    </small>
                  </span>

                  <span class="dashboard-recent-side">
                    <strong>
                      ${
                        Number.isFinite(
                          Number(project.squareFeet)
                        )
                          ? `${number(
                              project.squareFeet
                            )} SF`
                          : "SF not recorded"
                      }
                    </strong>

                    ${qualityBadge(project)}
                  </span>
                </button>
              `;
            })
            .join("")
        : `
          <p class="helper">
            No projects are currently available.
          </p>
        `;
  }

  $$("[data-dashboard-project]")
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          openProject(
            button.dataset.dashboardProject
          );
        }
      );
    });

  renderDashboardAttention(list);
  renderDashboardDatasetStatus(list);
  renderScatter();
}

function renderDashboardAttention(list) {
  const container =
    $("#dashboard-attention");

  if (!container) return;

  const reviewNeeded = list.filter(
    project =>
      qualityStatus(project) ===
      "Review Needed"
  ).length;

  const missingConsultants = list.filter(
    project =>
      !project.consultant ||
      project.consultant === "Unknown"
  ).length;

  const missingSquareFeet = list.filter(
    project =>
      !Number.isFinite(
        Number(project.squareFeet)
      )
  ).length;

  const missingElectrical = list.filter(
    project => {
      const electricalData =
        electrical(project);

      return (
        !Number.isFinite(
          Number(electricalData.panelCount)
        ) &&
        !(electricalData.panels || []).length
      );
    }
  ).length;

  const items = [
    {
      label: "Projects needing review",
      value: reviewNeeded
    },
    {
      label: "Missing consultants",
      value: missingConsultants
    },
    {
      label: "Missing square footage",
      value: missingSquareFeet
    },
    {
      label: "Missing electrical records",
      value: missingElectrical
    }
  ];

  container.innerHTML = `
    <div class="dashboard-panel-heading">
      <div>
        <p class="kicker">
          Office follow-up
        </p>

        <h3>Needs Attention</h3>
      </div>

      <button
        type="button"
        class="text-button"
        data-go="data-quality"
      >
        Review Data Quality
      </button>
    </div>

    <div class="dashboard-attention-grid">
      ${items
        .map(
          item => `
            <div class="dashboard-attention-item">
              <strong>${number(item.value)}</strong>
              <span>${esc(item.label)}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;

  container
    .querySelector('[data-go="data-quality"]')
    ?.addEventListener(
      "click",
      () => goTo("data-quality")
    );
}

function renderDashboardDatasetStatus(list) {
  const container =
    $("#dashboard-dataset-status");

  if (!container) return;

  const usableMechanical = list.filter(
    project =>
      Number.isFinite(
        Number(
          mechanical(project).totalTonnage
        )
      )
  ).length;

  const usableElectrical = list.filter(
    project =>
      Number.isFinite(
        Number(
          electrical(project).panelCount
        )
      )
  ).length;

  container.innerHTML = `
    <div class="dashboard-panel-heading">
      <div>
        <p class="kicker">
          Active dataset
        </p>

        <h3>Dataset Status</h3>
      </div>
    </div>

    <div class="dataset-status-list">
      <div>
        <span>Projects stored</span>
        <strong>${number(list.length)}</strong>
      </div>

      <div>
        <span>Mechanical records usable</span>
        <strong>${number(usableMechanical)}</strong>
      </div>

      <div>
        <span>Electrical records usable</span>
        <strong>${number(usableElectrical)}</strong>
      </div>

      <div>
        <span>Storage</span>
        <strong>Saved locally</strong>
      </div>
    </div>

    <button
      type="button"
      class="secondary dashboard-dataset-button"
      data-go="data-import"
    >
      Manage Data
    </button>
  `;

  container
    .querySelector('[data-go="data-import"]')
    ?.addEventListener(
      "click",
      () => goTo("data-import")
    );
}


function renderScatter() {
  if (!window.Chart) return;

  if (state.chart) {
    state.chart.destroy();
  }

  const data = projects()
    .filter(project => {
      const sf =
        Number(project.squareFeet);

      const tons =
        Number(
          mechanical(project).totalTonnage
        );

      return (
        Number.isFinite(sf) &&
        Number.isFinite(tons)
      );
    })
    .map(project => ({
      x: Number(project.squareFeet),

      y: Number(
        mechanical(project).totalTonnage
      ),

      project: project.projectName
    }));

  const canvas =
    $("#tonnage-chart");

  if (!canvas) return;

  state.chart = new Chart(canvas, {
    type: "scatter",

    data: {
      datasets: [
        {
          data,
          backgroundColor: "#8f302e",
          borderColor: "#8f302e",
          pointRadius: 5,
          pointHoverRadius: 7
        }
      ]
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,

      plugins: {
        legend: {
          display: false
        },

        tooltip: {
          callbacks: {
            label: context =>
              `${context.raw.project}: ` +
              `${number(context.raw.x)} SF · ` +
              `${number(
                context.raw.y,
                1
              )} tons`
          }
        }
      },

      scales: {
        x: {
          title: {
            display: true,
            text: "Building square feet"
          },

          grid: {
            color: "#e5ded4"
          },

          ticks: {
            color: "#71675f"
          }
        },

        y: {
          title: {
            display: true,
            text: "Installed HVAC tonnage"
          },

          beginAtZero: true,

          grid: {
            color: "#e5ded4"
          },

          ticks: {
            color: "#71675f"
          }
        }
      }
    }
  });
}


function comparableSet(buildingType,consultant,scope){const eligible=analysisProjects().filter(p=>scope==='Mechanical'?hasMechanical(p):scope==='Electrical'?hasElectrical(p):(hasMechanical(p)||hasElectrical(p)));const stages=[];if(buildingType&&consultant)stages.push({label:`same building type and ${consultant}`,level:0,list:eligible.filter(p=>p.buildingType===buildingType&&analysis.consultantKey(p.consultant)===analysis.consultantKey(consultant))});if(buildingType)stages.push({label:'same building type across all consultants',level:1,list:eligible.filter(p=>p.buildingType===buildingType)});if(consultant)stages.push({label:`${consultant} across all building types`,level:2,list:eligible.filter(p=>analysis.consultantKey(p.consultant)===analysis.consultantKey(consultant))});stages.push({label:'entire available dataset',level:3,list:eligible});return stages.find(stage=>stage.list.length)||stages.at(-1)}
function calculateEstimate(comparable,sf){const mech=comparable.list.filter(p=>p.squareFeet&&mechanical(p).totalTonnage),sfTon=mech.map(p=>p.squareFeet/mechanical(p).totalTonnage),ratio=median(sfTon),tonnage=roundHalf(sf/ratio),tonRange=rangeFromRatios(sfTon,r=>roundHalf(sf/r)),ducts=comparable.list.filter(p=>p.squareFeet&&Number.isFinite(mechanical(p).totalDuctFeet)),ductRatios=ducts.map(p=>mechanical(p).totalDuctFeet/p.squareFeet),duct=roundTen(sf*median(ductRatios)),unitProjects=comparable.list.filter(p=>p.squareFeet&&hvacUnitCount(p)),unitRatios=unitProjects.map(p=>p.squareFeet/hvacUnitCount(p)),unitCount=Number.isFinite(median(unitRatios))?Math.max(1,Math.round(sf/median(unitRatios))):null,elec=comparable.list.filter(p=>p.squareFeet&&electrical(p).panelCount),panelRatios=elec.map(p=>p.squareFeet/electrical(p).panelCount),panelRatio=median(panelRatios),panels=Number.isFinite(panelRatio)?Math.max(1,Math.round(sf/panelRatio)):null,panelRange=rangeFromRatios(panelRatios,r=>Math.max(1,Math.round(sf/r)));return{mech,sfTon,ratio,tonnage,tonRange,ducts,ductRatios,duct,unitProjects,unitRatios,unitCount,elec,panelRatios,panelRatio,panels,panelRange}}
function precedentCard(item) {
  const p = item.project;
  

  const scope =
    $("#estimate-scope")?.value ||
    "Mechanical + Electrical";

  const showMechanical =
    scope !== "Electrical";

  const showElectrical =
    scope !== "Mechanical";

  const mechanicalColumns = showMechanical
    ? `
        <div class="data-point">
          <span>HVAC tons</span>
          ${number(
            mechanical(p).totalTonnage,
            1
          )}
        </div>

        <div class="data-point">
          <span>HVAC units</span>
          ${number(
            hvacUnitCount(p)
          )}
        </div>
      `
    : "";

  const electricalColumns = showElectrical
    ? `
        <div class="data-point">
          <span>Panels</span>
          ${number(
            electrical(p).panelCount
          )}
        </div>
      `
    : "";

  return `
    <article
      class="precedent-card"
      data-precedent="${esc(p.id)}"
    >
      <div>
        <strong>
          ${esc(p.projectName)}
        </strong>

        <small>
          ${esc(
            p.projectNumber ||
            "No project number"
          )}
          ·
          ${esc(
            p.buildingType ||
            "Type not recorded"
          )}
          ·
          ${esc(
            p.consultant ||
            "Consultant not recorded"
          )}
        </small>

        <div class="reason-tags">
          ${item.reasons
            .map(
              reason => `
                <span class="reason-tag">
                  ${esc(reason)}
                </span>
              `
            )
            .join("")}
        </div>
      </div>

      <div class="data-point">
        <span>Square feet</span>
        ${number(p.squareFeet)}
      </div>

      ${mechanicalColumns}

      ${electricalColumns}

      <div class="data-point optional-data">
        <span>Relevance</span>
        ${number(item.score, 1)}
      </div>

      <button
        class="expand-mini"
        type="button"
        data-open-project="${esc(p.id)}"
      >
        Details
      </button>

      
    </article>
  `;
}


function bindUpdates(){
  $('#choose-update').addEventListener('click',()=>setUpdateMode('existing'));$('#choose-new').addEventListener('click',()=>setUpdateMode('new'));$('#update-project-search').addEventListener('input',renderUpdateSearch);$('#project-update-form').addEventListener('submit',event=>{event.preventDefault();submitProjectUpdate({})});$('#cancel-update').addEventListener('click',resetUpdateForm);
  ['#update-sf','#update-building-type','#update-consultant'].forEach(selector=>$(selector).addEventListener('input',renderHistoricalEstimate))
}
function setUpdateMode(mode){$('#choose-update').classList.toggle('active',mode==='existing');$('#choose-new').classList.toggle('active',mode==='new');$('#project-selector-panel').classList.toggle('hidden',mode==='new');resetUpdateForm();if(mode==='new'){$('#project-update-form').classList.remove('hidden');$('#update-number').focus()}}
function renderUpdateSearch(){const query=$('#update-project-search').value.trim().toLowerCase();const matches=query?projects().filter(p=>`${p.projectNumber} ${p.projectName}`.toLowerCase().includes(query)).slice(0,10):[];$('#update-project-results').innerHTML=matches.map(p=>`<button class="selector-result" type="button" data-update-project="${esc(p.id)}"><strong>${esc(p.projectName)}</strong><span>${esc(p.projectNumber||'No number')} · ${esc(p.consultant||'Unknown')} · ${qualityStatus(p)}</span></button>`).join('');$$('[data-update-project]').forEach(button=>button.addEventListener('click',()=>loadProjectUpdate(button.dataset.updateProject)))}
function loadProjectUpdate(id){const p=projects().find(project=>project.id===id);if(!p)return;$('#update-project-id').value=p.id;$('#update-number').value=p.projectNumber||'';$('#update-name').value=p.projectName||'';$('#update-building-type').value=p.buildingType==='Unknown'?'':p.buildingType||'';$('#update-sf').value=p.squareFeet??'';$('#update-consultant').value=p.consultant==='Unknown'?'':p.consultant||'';$('#update-status').value=[...$('#update-status').options].some(option=>option.value===p.projectStatus)?p.projectStatus:'Other';$('#update-completion').value=p.completionDate||'';const m=mechanical(p),primary=(m.units||[]).find(unit=>unit.type||unit.manufacturer||unit.model)||{};$('#update-tonnage').value=m.totalTonnage??'';$('#update-units').value=hvacUnitCount(p)??'';$('#update-system').value=m.primarySystemType||primary.type||'';$('#update-manufacturer').value=m.manufacturer||primary.manufacturer||'';$('#update-model').value=m.model||primary.model||'';$('#update-duct').value=m.totalDuctFeet??'';$('#update-mech-notes').value=m.notes||'';const e=electrical(p);$('#update-panels').value=e.panelCount??'';$('#update-service').value=e.serviceInfo||'';$('#update-elec-notes').value=e.notes||'';$('#update-entered-by').value='';$('#update-source').value=p.audit?.sourceType&&[...$('#update-source').options].some(o=>o.value===p.audit.sourceType)?p.audit.sourceType:'Other';$('#update-excluded').checked=Boolean(p.excludedFromAnalysis);$('#project-update-form').classList.remove('hidden');$('#update-validation').classList.add('hidden');renderHistoricalEstimate();$('#project-update-form').scrollIntoView({behavior:'smooth',block:'start'})}
function resetUpdateForm(){$('#project-update-form').reset();$('#update-project-id').value='';$('#project-update-form').classList.add('hidden');$('#update-validation').classList.add('hidden');$('#update-project-results').innerHTML='';$('#update-project-search').value=''}
function currentUpdatePayload(){return{id:$('#update-project-id').value||null,projectNumber:$('#update-number').value,projectName:$('#update-name').value,buildingType:$('#update-building-type').value,squareFeet:$('#update-sf').value,consultant:$('#update-consultant').value,projectStatus:$('#update-status').value,completionDate:$('#update-completion').value,excludedFromAnalysis:$('#update-excluded').checked,mechanical:{totalTonnage:$('#update-tonnage').value,unitCount:$('#update-units').value,primarySystemType:$('#update-system').value,manufacturer:$('#update-manufacturer').value,model:$('#update-model').value,totalDuctFeet:$('#update-duct').value,notes:$('#update-mech-notes').value},electrical:{panelCount:$('#update-panels').value,serviceInfo:$('#update-service').value,notes:$('#update-elec-notes').value},audit:{enteredBy:$('#update-entered-by').value,sourceType:$('#update-source').value}}}
function renderHistoricalEstimate(){const sf=Number($('#update-sf').value),panel=$('#historical-estimate');if(!sf){panel.innerHTML='<h3>Estimated from historical data</h3><p class="helper">Enter square footage to see a separate preliminary reference. Estimated values are never saved automatically.</p>';return}const comparable=comparableSet($('#update-building-type').value,$('#update-consultant').value,'Mechanical + Electrical'),calc=calculateEstimate(comparable,sf);panel.innerHTML=`<h3>Estimated from historical data</h3><p class="helper">Reference only—these values are not written into the official record.</p><div class="estimated-values"><span><strong>${number(calc.tonnage,1)} tons</strong>HVAC reference</span><span><strong>${number(calc.unitCount)}</strong>HVAC units reference</span><span><strong>${number(calc.panels)}</strong>Panels reference</span><span><strong>${comparable.list.length}</strong>Historical projects used</span></div>`}
async function submitProjectUpdate(options){const response=await fetch('/api/projects/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:currentUpdatePayload(),options})}),result=await response.json();if(response.ok){state.data=result.data;renderAll();resetUpdateForm();toast(result.message);if(result.masterWarning)toast(result.masterWarning);return}if(response.status===409||response.status===422){renderUpdateValidation(result);return}toast(result.error||'Project could not be saved.')}
function renderUpdateValidation(result){const panel=$('#update-validation'),blocking=result.code==='blocking';panel.classList.remove('hidden');panel.innerHTML=`<p class="kicker">${blocking?'Blocking issues':'Incomplete information'}</p><h3>${blocking?'This record is not reliable enough for analysis.':'Some information is incomplete. This project can still be saved, and the issue will be recorded in the Errors log.'}</h3><ul>${result.issues.map(issue=>`<li><strong>${esc(issue.severity)}:</strong> ${esc(issue.message)}</li>`).join('')}</ul><div class="validation-actions"><button id="validation-edit" type="button" class="secondary">Go back and edit</button><button id="validation-save" type="button" class="primary">${blocking?'Save as excluded from analysis':'Save with warnings'}</button></div>`;$('#validation-edit').addEventListener('click',()=>panel.classList.add('hidden'));$('#validation-save').addEventListener('click',()=>submitProjectUpdate(blocking?{excludeOnBlocking:true}:{saveWithWarnings:true}))}

function issues(){return state.data?.issues||[]}
function projectIssues(projectId){return issues().filter(issue=>issue.projectId===projectId)}
function qualityBadge(project,interactive=false){const status=qualityStatus(project),tone={Complete:'high',Resolved:'resolved',Warning:'moderate',Blocked:'low',Excluded:'excluded'}[status]||'moderate';return interactive?`<button class="badge quality-badge ${tone}" data-quality-project="${esc(project.id)}" title="Review project issues">${esc(status)}</button>`:`<span class="badge quality-badge ${tone}">${esc(status)}</span>`}

function bindDataQuality(){['#issue-search','#issue-discipline','#issue-severity','#issue-status','#issue-unresolved'].forEach(selector=>$(selector).addEventListener('input',renderDataQuality));$('#add-issue').addEventListener('click',()=>openIssueEditor())}
function filteredIssues(){const query=$('#issue-search').value.trim().toLowerCase(),discipline=$('#issue-discipline').value,severity=$('#issue-severity').value,status=$('#issue-status').value,unresolved=$('#issue-unresolved').checked;return issues().filter(issue=>(!query||`${issue.projectNumber} ${issue.projectName} ${issue.message}`.toLowerCase().includes(query))&&(!discipline||issue.discipline===discipline)&&(!severity||issue.severity===severity)&&(!status||issue.status===status)&&(!unresolved||issue.status!=='Resolved')).sort((a,b)=>{const statusOrder=(a.status==='Resolved')-(b.status==='Resolved');if(statusOrder)return statusOrder;return({Blocking:0,Warning:1,Note:2}[a.severity]??3)-({Blocking:0,Warning:1,Note:2}[b.severity]??3)||String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))})}
function renderDataQuality(){if(!state.data)return;const counts={Blocking:0,Warning:0,Note:0,Resolved:0};issues().forEach(issue=>{if(issue.status==='Resolved')counts.Resolved++;else counts[issue.severity]=(counts[issue.severity]||0)+1});$('#issue-summary').innerHTML=[['Blocking issues',counts.Blocking],['Warnings',counts.Warning],['Notes',counts.Note],['Resolved issues',counts.Resolved]].map(([label,value])=>`<div class="portfolio-stat"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');const list=filteredIssues();$('#issues-table').innerHTML=list.length?`<table><thead><tr><th>Severity</th><th>Project</th><th>Discipline</th><th>Issue</th><th>Status</th><th>Recorded</th><th></th></tr></thead><tbody>${list.map(issue=>`<tr><td><span class="badge issue-${issue.severity.toLowerCase()}">${esc(issue.severity)}</span></td><td><strong>${esc(issue.projectName||'Project not identified')}</strong><br><span class="source-note">${esc(issue.projectNumber||'No number')}</span></td><td>${esc(issue.discipline)}</td><td><strong>${esc(issue.category)}</strong><br>${esc(issue.message)}${issue.detailedNote?`<details><summary>Details</summary><p>${esc(issue.detailedNote)}</p></details>`:''}</td><td>${esc(issue.status)}</td><td>${issue.dateRecorded?new Date(issue.dateRecorded).toLocaleDateString():'Not recorded'}<br><span class="source-note">${esc(issue.recordedBy||issue.source||'')}</span></td><td class="row-actions"><button class="text-button" data-issue-edit="${esc(issue.id)}">Edit</button>${issue.status!=='Resolved'?`<button class="text-button" data-issue-resolve="${esc(issue.id)}">Resolve</button>`:''}${issue.projectId?`<button class="text-button" data-issue-project="${esc(issue.projectId)}">Open project</button>`:''}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state">No issues match these filters.</div>';$$('[data-issue-edit]').forEach(button=>button.addEventListener('click',()=>openIssueEditor(issues().find(issue=>issue.id===button.dataset.issueEdit))));$$('[data-issue-resolve]').forEach(button=>button.addEventListener('click',()=>openResolveEditor(issues().find(issue=>issue.id===button.dataset.issueResolve))));$$('[data-issue-project]').forEach(button=>button.addEventListener('click',()=>openProject(button.dataset.issueProject)))}
function issueProjectOptions(selected){return`<option value="">Project not linked</option>`+projects().map(project=>`<option value="${esc(project.id)}" ${project.id===selected?'selected':''}>${esc(project.projectNumber||'No number')} — ${esc(project.projectName)}</option>`).join('')}
function openIssueEditor(issue=null){const panel=$('#issue-editor'),categories=state.data.issueCategories||[],defaultCategory=issue?.category||'Staff note requiring follow-up',defaultSeverity=issue?.severity||'Note';panel.classList.remove('hidden');panel.innerHTML=`<div class="panel-heading"><div><p class="kicker">${issue?'Edit issue':'New staff note'}</p><h3>${issue?'Update issue details':'Record a data-quality issue'}</h3></div><button id="close-issue-editor" class="text-button">Close</button></div><form id="issue-form" class="issue-form"><input id="issue-id" type="hidden" value="${esc(issue?.id||'')}"><label>Related project<select id="issue-project-id">${issueProjectOptions(issue?.projectId)}</select></label><label>Discipline<select id="issue-form-discipline">${['General','Mechanical','Electrical'].map(value=>`<option ${issue?.discipline===value?'selected':''}>${value}</option>`).join('')}</select></label><label>Issue category<select id="issue-category">${categories.map(value=>`<option ${defaultCategory===value?'selected':''}>${esc(value)}</option>`).join('')}</select></label><label>Severity<select id="issue-form-severity">${['Blocking','Warning','Note'].map(value=>`<option ${defaultSeverity===value?'selected':''}>${value}</option>`).join('')}</select></label><label class="wide">Short message<input id="issue-message" required value="${esc(issue?.message||'')}"></label><label class="wide">Detailed note<textarea id="issue-detail">${esc(issue?.detailedNote||'')}</textarea></label><label>Staff initials / name<input id="issue-recorded-by" value="${esc(issue?.recordedBy||'')}"></label><div class="wide validation-actions"><button type="button" id="cancel-issue" class="secondary">Cancel</button><button type="submit" class="primary">Save issue</button></div></form>`;$('#close-issue-editor').addEventListener('click',()=>panel.classList.add('hidden'));$('#cancel-issue').addEventListener('click',()=>panel.classList.add('hidden'));$('#issue-form').addEventListener('submit',saveIssue);panel.scrollIntoView({behavior:'smooth',block:'start'})}

function openInlineIssueEditor(issue, issueRow) {
  if (!issue || !issueRow) return;

  // Close either existing inline editor.
  document
    .querySelector("#inline-edit-issue-row")
    ?.remove();

  document
    .querySelector("#inline-resolve-editor-row")
    ?.remove();

  document
    .querySelectorAll(
      "#issues-table tr.is-reviewing"
    )
    .forEach(row => {
      row.classList.remove("is-reviewing");
    });

  issueRow.classList.add("is-reviewing");

  const columnCount =
    issueRow.children.length || 6;

  const categories =
    state.data?.issueCategories || [];

  const disciplines = [
    "General",
    "Mechanical",
    "Electrical"
  ];

  const severities = [
    "Blocking",
    "Warning",
    "Note"
  ];

  const selectedCategory =
    issue.category ||
    "Staff note requiring follow-up";

  const selectedSeverity =
    issue.severity || "Note";

  const editorRow =
    document.createElement("tr");

  editorRow.id =
    "inline-edit-issue-row";

  editorRow.className =
    "inline-edit-issue-row";

  editorRow.innerHTML = `
    <td colspan="${columnCount}">
      <section class="inline-issue-review">
        <div class="inline-issue-header">
          <div>
            <p class="kicker">
              Edit issue
            </p>

            <h3>
              Update issue details
            </h3>

            <p class="inline-issue-meta">
              ${esc(
                issue.projectName ||
                "Project not linked"
              )}
              ·
              ${esc(
                issue.discipline ||
                "General"
              )}
              ·
              ${esc(reviewGroup(issue))}
            </p>
          </div>

          <button
            type="button"
            class="text-button"
            data-close-inline-edit
          >
            Close
          </button>
        </div>

        <form class="inline-edit-form">
          <label>
            Related project

            <select data-edit-project>
              ${issueProjectOptions(
                issue.projectId
              )}
            </select>
          </label>

          <label>
            Discipline

            <select data-edit-discipline>
              ${disciplines
                .map(
                  value => `
                    <option
                      value="${esc(value)}"
                      ${
                        issue.discipline === value
                          ? "selected"
                          : ""
                      }
                    >
                      ${esc(value)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>

          <label>
            Issue category

            <select data-edit-category>
              ${categories
                .map(
                  value => `
                    <option
                      value="${esc(value)}"
                      ${
                        selectedCategory === value
                          ? "selected"
                          : ""
                      }
                    >
                      ${esc(value)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>

          <label>
            Severity

            <select data-edit-severity>
              ${severities
                .map(
                  value => `
                    <option
                      value="${esc(value)}"
                      ${
                        selectedSeverity === value
                          ? "selected"
                          : ""
                      }
                    >
                      ${esc(value)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>

          <label class="edit-message-field">
            Short message

            <input
              data-edit-message
              required
              value="${esc(
                issue.message || ""
              )}"
            >
          </label>

          <label class="edit-note-field">
            Detailed note

            <textarea
              data-edit-detail
              rows="3"
            >${esc(
              issue.detailedNote || ""
            )}</textarea>
          </label>

          <label>
            Staff initials / name

            <input
              data-edit-recorded-by
              value="${esc(
                issue.recordedBy || ""
              )}"
            >
          </label>

          <div class="inline-edit-actions">
            <button
              type="button"
              class="secondary"
              data-cancel-inline-edit
            >
              Cancel
            </button>

            <button
              type="submit"
              class="primary"
            >
              Save issue
            </button>
          </div>
        </form>
      </section>
    </td>
  `;

  issueRow.insertAdjacentElement(
    "afterend",
    editorRow
  );

  const closeEditor = () => {
    editorRow.remove();

    issueRow.classList.remove(
      "is-reviewing"
    );
  };

  editorRow
    .querySelector(
      "[data-close-inline-edit]"
    )
    .addEventListener(
      "click",
      closeEditor
    );

  editorRow
    .querySelector(
      "[data-cancel-inline-edit]"
    )
    .addEventListener(
      "click",
      closeEditor
    );

  editorRow
    .querySelector(".inline-edit-form")
    .addEventListener(
      "submit",
      async event => {
        event.preventDefault();

        const submitButton =
          event.currentTarget.querySelector(
            'button[type="submit"]'
          );

        const selectedProjectId =
          editorRow.querySelector(
            "[data-edit-project]"
          ).value;

        const selectedProject =
          projects().find(
            project =>
              String(project.id) ===
              String(selectedProjectId)
          );

        const payload = {
          id: issue.id,

          projectId:
            selectedProject?.id || null,

          projectNumber:
            selectedProject?.projectNumber ||
            "",

          projectName:
            selectedProject?.projectName ||
            "",

          consultant:
            selectedProject?.consultant ||
            "",

          overallSf:
            selectedProject?.squareFeet ??
            null,

          discipline:
            editorRow.querySelector(
              "[data-edit-discipline]"
            ).value,

          category:
            editorRow.querySelector(
              "[data-edit-category]"
            ).value,

          severity:
            editorRow.querySelector(
              "[data-edit-severity]"
            ).value,

          message:
            editorRow
              .querySelector(
                "[data-edit-message]"
              )
              .value.trim(),

          detailedNote:
            editorRow
              .querySelector(
                "[data-edit-detail]"
              )
              .value.trim(),

          recordedBy:
            editorRow
              .querySelector(
                "[data-edit-recorded-by]"
              )
              .value.trim(),

          source:
            issue.source ||
            "Manual data-quality entry"
        };

        submitButton.disabled = true;
        submitButton.textContent =
          "Saving...";

        try {
          const response = await fetch(
            "/api/issues/save",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body: JSON.stringify({
                issue: payload
              })
            }
          );

          const result =
            await response.json();

          if (!response.ok) {
            throw new Error(
              result.error ||
              "Issue could not be saved."
            );
          }

          state.data = result.data;

          renderAll();

          toast(
            result.message ||
            "Issue updated."
          );
        } catch (error) {
          console.error(error);

          toast(
            error.message ||
            "Issue could not be saved."
          );

          submitButton.disabled = false;
          submitButton.textContent =
            "Save issue";
        }
      }
    );

  editorRow
    .querySelector(
      "[data-edit-message]"
    )
    ?.focus();
}

async function saveIssue(event){event.preventDefault();const project=projects().find(p=>p.id===$('#issue-project-id').value),payload={id:$('#issue-id').value||null,projectId:project?.id||null,projectNumber:project?.projectNumber||'',projectName:project?.projectName||'',consultant:project?.consultant||'',overallSf:project?.squareFeet??null,discipline:$('#issue-form-discipline').value,category:$('#issue-category').value,severity:$('#issue-form-severity').value,message:$('#issue-message').value,detailedNote:$('#issue-detail').value,recordedBy:$('#issue-recorded-by').value,source:'Manual data-quality entry'};const response=await fetch('/api/issues/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issue:payload})}),result=await response.json();if(!response.ok)return toast(result.error||'Issue could not be saved.');state.data=result.data;$('#issue-editor').classList.add('hidden');renderAll();toast(result.message)}

function openResolveEditor(
  issue,
  issueRow
) {
  if (!issue || !issueRow) return;

  document
    .querySelector(
      "#inline-resolve-editor-row"
    )
    ?.remove();

  document
    .querySelector(
      "#inline-edit-issue-row"
    )
    ?.remove();

  document
    .querySelectorAll(
      "#issues-table tr.is-reviewing"
    )
    .forEach(row => {
      row.classList.remove(
        "is-reviewing"
      );
    });

  issueRow.classList.add(
    "is-reviewing"
  );

  const project = projects().find(
    item =>
      String(item.id) ===
      String(issue.projectId)
  );

  if (!project) {
    toast(
      "The related project could not be found."
    );

    return;
  }

  const mechanicalData =
    mechanical(project);

  const electricalData =
    electrical(project);

  const editorRow =
    document.createElement("tr");

  editorRow.id =
    "inline-resolve-editor-row";

  editorRow.className =
    "inline-resolve-editor-row";

  editorRow.innerHTML = `
    <td colspan="${
      issueRow.children.length || 6
    }">
      <section class="inline-issue-review">
        <div class="inline-issue-header">
          <div>
            <p class="kicker">
              Resolve issue
            </p>

            <h3>
              ${esc(issue.message)}
            </h3>

            <p class="inline-issue-meta">
              ${esc(project.projectName)}
              ·
              ${esc(
                issue.discipline ||
                "General"
              )}
            </p>
          </div>

          <button
            type="button"
            class="text-button"
            data-close-resolution
          >
            Close
          </button>
        </div>

        <p class="helper">
          Enter any corrected project values below.
          Saved corrections update Past Projects,
          estimates, consultant analysis, and the
          downloadable Excel workbook.
        </p>

        <form class="data-correction-form">
          <label>
            Square footage

            <input
              data-correct-square-feet
              type="number"
              min="1"
              step="1"
              value="${
                effectiveProjectSquareFeet(
                  project
                ) || ""
              }"
              placeholder="Project SF"
            >
          </label>

          <label>
            Consultant

            <input
              data-correct-consultant
              value="${esc(
                effectiveProjectConsultant(
                  project
                )
              )}"
              placeholder="MEP consultant"
            >
          </label>

          <label>
            HVAC tonnage

            <input
              data-correct-tonnage
              type="number"
              min="0"
              step="0.1"
              value="${esc(
                mechanicalData.totalTonnage ??
                ""
              )}"
              placeholder="Total tons"
            >
          </label>

          <label>
            Ductwork LF

            <input
              data-correct-ductwork
              type="number"
              min="0"
              step="1"
              value="${esc(
                mechanicalData.totalDuctFeet ??
                ""
              )}"
              placeholder="Duct LF"
            >
          </label>

          <label>
            Manufacturer

            <input
              data-correct-manufacturer
              value="${esc(
                mechanicalData.manufacturer ||
                ""
              )}"
              placeholder="Manufacturer"
            >
          </label>

          <label>
            Model

            <input
              data-correct-model
              value="${esc(
                mechanicalData.model ||
                ""
              )}"
              placeholder="Model"
            >
          </label>

          <label>
            Electrical panels

            <input
              data-correct-panels
              type="number"
              min="0"
              step="1"
              value="${esc(
                electricalData.panelCount ??
                ""
              )}"
              placeholder="Panel count"
            >
          </label>

          <label>
            Electrical service

            <input
              data-correct-service
              value="${esc(
                electricalData.serviceInfo ||
                ""
              )}"
              placeholder="Service / rating"
            >
          </label>

          <label>
            Resolved by

            <input
              data-resolved-by
              required
              placeholder="Initials or name"
            >
          </label>

          <label class="wide">
            Resolution note

            <textarea
              data-resolution-note
              rows="3"
              placeholder="Describe what was corrected."
            ></textarea>
          </label>

          <div class="wide inline-resolve-actions">
            <button
              type="button"
              class="secondary"
              data-cancel-resolution
            >
              Cancel
            </button>

            <button
              type="submit"
              class="primary"
            >
              Save correction and resolve
            </button>
          </div>
        </form>
      </section>
    </td>
  `;

  issueRow.insertAdjacentElement(
    "afterend",
    editorRow
  );

  const closeEditor = () => {
    editorRow.remove();

    issueRow.classList.remove(
      "is-reviewing"
    );
  };

  editorRow
    .querySelector(
      "[data-close-resolution]"
    )
    .addEventListener(
      "click",
      closeEditor
    );

  editorRow
    .querySelector(
      "[data-cancel-resolution]"
    )
    .addEventListener(
      "click",
      closeEditor
    );

  editorRow
    .querySelector(
      ".data-correction-form"
    )
    .addEventListener(
      "submit",
      async event => {
        event.preventDefault();

        const submitButton =
          event.currentTarget.querySelector(
            'button[type="submit"]'
          );

        submitButton.disabled = true;
        submitButton.textContent =
          "Saving...";

        const projectPayload =
          correctionProjectPayload(
            project,
            editorRow
          );

        try {
          const projectResponse =
            await fetch(
              "/api/projects/save",
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json"
                },

                body: JSON.stringify({
                  project:
                    projectPayload,

                  options: {
                    saveWithWarnings: true
                  }
                })
              }
            );

          const projectResult =
            await projectResponse.json();

          if (!projectResponse.ok) {
            throw new Error(
              projectResult.error ||
              projectResult.issues
                ?.map(item => item.message)
                .join(" ") ||
              "Project correction could not be saved."
            );
          }

          state.data =
            projectResult.data;

          const updatedIssue =
            state.data.issues?.find(
              item =>
                item.id === issue.id
            );

          /*
           * If correcting the project did not
           * automatically resolve this issue,
           * save the manual resolution as well.
           */
          if (
            updatedIssue &&
            updatedIssue.status !==
              "Resolved"
          ) {
            const resolveResponse =
              await fetch(
                `/api/issues/${encodeURIComponent(
                  issue.id
                )}/resolve`,
                {
                  method: "POST",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  body: JSON.stringify({
                    resolvedBy:
                      editorRow
                        .querySelector(
                          "[data-resolved-by]"
                        )
                        .value.trim(),

                    resolutionNote:
                      editorRow
                        .querySelector(
                          "[data-resolution-note]"
                        )
                        .value.trim() ||
                      "Project data corrected through Data Quality."
                  })
                }
              );

            const resolveResult =
              await resolveResponse.json();

            if (!resolveResponse.ok) {
              throw new Error(
                resolveResult.error ||
                "The project was saved, but the issue could not be resolved."
              );
            }

            state.data =
              resolveResult.data;
          }

          renderAll();

          toast(
            "Project data updated and issue resolved."
          );
        } catch (error) {
          console.error(error);

          toast(error.message);

          submitButton.disabled =
            false;

          submitButton.textContent =
            "Save correction and resolve";
        }
      }
    );

  editorRow
    .querySelector(
      "[data-resolved-by]"
    )
    ?.focus();
}


function showProjectIssues(id){const p=projects().find(project=>project.id===id);if(!p)return;goTo('data-quality');$('#issue-search').value=p.projectNumber||p.projectName;$('#issue-unresolved').checked=false;renderDataQuality()}

function projectRows(p){const open=state.expanded.has(p.id),warnings=projectWarnings(p);return`<tr><td><button class="expand-btn" data-id="${esc(p.id)}" aria-expanded="${open}">${open?'−':'+'}</button></td><td><strong>${esc(p.projectName)}</strong><br><span class="source-note">${esc(p.projectNumber||'No project number')}</span></td><td>${esc(p.buildingType||'Not recorded')}</td><td><span class="consultant-badge">${esc(p.consultant||'Not recorded')}</span></td><td>${number(p.squareFeet)}</td><td>${number(mechanical(p).totalTonnage,1)}</td><td>${number(hvacUnitCount(p))}</td><td>${number(electrical(p).panelCount)}</td><td>${qualityBadge(p,true)}</td></tr>${open?`<tr class="detail-row"><td colspan="9">${projectDetail(p,warnings)}<div class="project-detail">${availabilityHtml(p)}</div></td></tr>`:''}`}
function projectDetail(p,warnings,compact=false){const units=(mechanical(p).units||[]).length?mechanical(p).units.map(u=>`<div class="unit-item"><span><strong>${esc(u.name||'Unnamed')}</strong></span><span>${number(u.tonnage,1)} tons</span><span>${esc(u.type||'Not recorded')}</span><span>${esc(u.manufacturer||'Not recorded')}</span><span>${esc(u.model||'Not recorded')}</span><span>${esc(u.classification||'Not recorded')}</span></div>`).join(''):`<p>${hvacUnitCount(p)?`${number(hvacUnitCount(p))} HVAC units recorded without unit-by-unit detail.`:'No mechanical equipment detail recorded.'}</p>`,panels=(electrical(p).panels||[]).map(panel=>`${esc(panel.name||'Unnamed panel')} (${number(panel.count)})`).join(', ')||'No panel detail recorded.',pIssues=projectIssues(p.id);if(compact)return`<p><strong>Mechanical:</strong> ${number(mechanical(p).totalTonnage,1)} tons · ${number(mechanical(p).totalDuctFeet)} duct LF · ${number(hvacUnitCount(p))} units<br><strong>Electrical:</strong> ${number(electrical(p).panelCount)} panels · ${esc(electrical(p).serviceInfo||'Service not recorded')}<br><strong>Quality:</strong> ${esc(qualityStatus(p))}</p>`;const related=relatedProjects(p);return`<div class="project-detail"><div class="detail-grid"><div><span>Consultant</span><strong>${esc(p.consultant||'Not recorded')}</strong></div><div><span>Overall SF</span><strong>${number(p.squareFeet)}</strong></div><div><span>Total tonnage</span><strong>${number(mechanical(p).totalTonnage,1)}</strong></div><div><span>Total duct</span><strong>${number(mechanical(p).totalDuctFeet)} LF</strong></div><div><span>Electrical panels</span><strong>${number(electrical(p).panelCount)}</strong></div><div><span>Data quality</span><strong>${qualityBadge(p)}</strong></div></div><h3>Mechanical records</h3><div class="unit-list">${units}</div><p><strong>Mechanical notes:</strong> ${esc(mechanical(p).notes||'Not recorded')}</p><h3>Electrical records</h3><p><strong>Panels:</strong> ${panels}<br><strong>Service:</strong> ${esc(electrical(p).serviceInfo||'Not recorded')}<br><strong>Notes:</strong> ${esc(electrical(p).notes||'Not recorded')}</p><h3>Audit information</h3><p>Created: ${p.audit?.createdAt?new Date(p.audit.createdAt).toLocaleString():'Not recorded'} · Last updated: ${p.audit?.updatedAt?new Date(p.audit.updatedAt).toLocaleString():'Not recorded'}<br>Source: ${esc(p.audit?.sourceType||'Not recorded')} · Entered by: ${esc(p.audit?.enteredBy||'Not recorded')} · Origin: ${esc(p.audit?.origin||'Not recorded')}</p>${pIssues.length?`<h3>Issue history</h3><ul class="quality-list">${pIssues.map(issue=>`<li><strong>${esc(issue.severity)} · ${esc(issue.status)}:</strong> ${esc(issue.message)}${issue.resolutionNote?` — ${esc(issue.resolutionNote)}`:''}</li>`).join('')}</ul>`:''}<h3>Related projects</h3><div class="related-list">${related.map(other=>`<button data-related-id="${esc(other.id)}">${esc(other.projectName)}</button>`).join('')||'No related projects available.'}</div></div>`}

function consultantStats(name){const all=projects().filter(p=>analysis.consultantKey(p.consultant)===analysis.consultantKey(name)),list=all.filter(p=>!p.excludedFromAnalysis&&p.qualityStatus!=='Blocked'&&p.qualityStatus!=='Excluded'),sf=list.map(p=>p.squareFeet),tons=list.map(p=>mechanical(p).totalTonnage),ratios=list.map(p=>p.squareFeet&&mechanical(p).totalTonnage?p.squareFeet/mechanical(p).totalTonnage:null),units=allUnits(list),projectUnits=list.filter(hasMechanical).map(hvacUnitCount),checks=all.flatMap(p=>[p.projectNumber,p.projectName,p.buildingType,p.squareFeet,mechanical(p).totalTonnage,electrical(p).panelCount]),missing=checks.filter(v=>v==null||v===''||v==='Unknown').length/Math.max(1,checks.length)*100;return{name,list,all,types:unique(all.map(p=>p.buildingType)),totalSf:sum(sf),medSf:median(sf),minSf:valid(sf).length?Math.min(...valid(sf)):null,maxSf:valid(sf).length?Math.max(...valid(sf)):null,medTon:median(tons),sfTon:median(ratios),unitCount:average(projectUnits),systems:topValues(units.map(u=>u.type)),manufacturers:topValues(units.map(u=>u.manufacturer)),panels:average(list.map(p=>electrical(p).panelCount)),custom:units.filter(u=>/custom|unusual/i.test(u.classification||'')).length,missing}}
function consultantCard(s) {
  const lowConfidence = s.list.length < 2;
  const excludedCount = s.all.length - s.list.length;

  const representedSquareFeet = sum(
    s.all
      .map(project => Number(project.squareFeet))
      .filter(Number.isFinite)
  );

  const recentProject = [...s.all]
    .sort((a, b) =>
      String(b.projectNumber || "").localeCompare(
        String(a.projectNumber || "")
      )
    )[0];

  const initials = s.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();

  return `
    <article class="consultant-card">
      <header class="consultant-card-header">
        <div class="consultant-card-identity">
          <div class="consultant-initials">
            ${esc(initials || "MEP")}
          </div>

          <div>
            <h3>${esc(s.name)}</h3>

            <p class="sample-note">
              ${number(s.all.length)}
              project${s.all.length === 1 ? "" : "s"} represented

              ${
                lowConfidence
                  ? " · Low-confidence analytical sample"
                  : ""
              }
            </p>
          </div>
        </div>

        <label class="consultant-compare">
          <input
            class="consultant-select"
            type="checkbox"
            value="${esc(s.name)}"
          >
          Compare
        </label>
      </header>

      <div class="consultant-overview">
        <div class="consultant-overview-block">
          <span>Portfolio represented</span>
          <strong>
            ${
              representedSquareFeet > 0
                ? `${compactNumber(
                    representedSquareFeet
                  )} SF`
                : "Not recorded"
            }
          </strong>
        </div>

        <div class="consultant-overview-block">
          <span>Most recent project</span>
          <strong>
            ${esc(
              recentProject?.projectName ||
              "Not recorded"
            )}
          </strong>
        </div>
      </div>

      <div class="consultant-patterns">
        <div>
          <span>Typical building types</span>

          <p>
            ${esc(
              s.types.slice(0, 3).join(", ") ||
              "Not recorded"
            )}
          </p>
        </div>

        <div>
          <span>Observed systems</span>

          <p>
            ${esc(
              s.systems.slice(0, 3).join(", ") ||
              "Insufficient data"
            )}
          </p>
        </div>

        <div>
          <span>Manufacturers</span>

          <p>
            ${esc(
              s.manufacturers
                .slice(0, 3)
                .join(", ") ||
              "Insufficient data"
            )}
          </p>
        </div>
      </div>

      <div class="consultant-metrics">
        <div class="consultant-metric">
          <span>Median project SF</span>
          <strong>${number(s.medSf)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Median HVAC tons</span>
          <strong>${number(s.medTon, 1)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Median SF / ton</span>
          <strong>
            ${
              valid(
                s.list.map(project =>
                  project.squareFeet &&
                  mechanical(project).totalTonnage
                    ? project.squareFeet /
                      mechanical(project).totalTonnage
                    : null
                )
              ).length >= 2
                ? number(s.sfTon)
                : "Insufficient data"
            }
          </strong>
        </div>

        <div class="consultant-metric">
          <span>Avg. HVAC units</span>
          <strong>${number(s.unitCount, 1)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Avg. electrical panels</span>
          <strong>${number(s.panels, 1)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Usable analysis sample</span>
          <strong>${number(s.list.length)}</strong>
        </div>
      </div>

      ${
        excludedCount
          ? `
            <p class="consultant-excluded-note">
              ${number(excludedCount)}
              record${excludedCount === 1 ? "" : "s"}
              excluded from tendency calculations.
            </p>
          `
          : ""
      }

      <div class="card-actions">
        <button
          class="secondary"
          type="button"
          data-consultant-profile="${esc(s.name)}"
        >
          View Profile
        </button>

        <button
          class="text-button"
          type="button"
          data-consultant-projects="${esc(s.name)}"
        >
          View Projects →
        </button>
      </div>
    </article>
  `;
}


function previewSummary(){const p=state.preview,records=p.projects.records,classified=records.map(classifyRecord),keys=records.map(projectKey),active=new Set(projects().map(projectKey)),imported=p.issues||[];return{projects:records.length,equipment:p.projects.equipmentCount,ready:classified.filter(c=>!c.required.length).length,warnings:classified.filter(c=>c.required.length||c.optional.length||c.info.length).length,duplicates:new Set(keys.filter((key,index)=>keys.indexOf(key)!==index||active.has(key))).size,skipped:p.projects.errors.length,errorRows:p.errorSheetRows||imported.length,blocking:imported.filter(i=>i.severity==='Blocking').length,issueWarnings:imported.filter(i=>i.severity==='Warning').length,notes:imported.filter(i=>i.severity==='Note').length,conflicts:(p.conflicts||[]).length,issueDuplicates:p.issueDuplicates||0}}
function previewRecords(){const p=state.preview;if(state.previewFilter==='issues')return p.importedIssues||[];const records=p.projects.records;if(state.previewFilter==='warnings')return records.filter(project=>{const c=classifyRecord(project);return c.required.length||c.optional.length||c.info.length});return state.previewFilter==='all'?records:records.slice(0,10)}
function conflictPreview(conflicts){if(!conflicts?.length)return'';return`<details class="warning" open><summary><strong>${conflicts.length} manual-update conflict${conflicts.length===1?'':'s'}</strong> — compare saved and imported values</summary><div class="conflict-list">${conflicts.slice(0,10).map(conflict=>`<div><strong>${esc(conflict.projectNumber||conflict.projectName)}</strong><small>Saved source: ${esc(conflict.savedSource||'Manual update')} · Last updated: ${conflict.savedUpdatedAt?new Date(conflict.savedUpdatedAt).toLocaleString():'Not recorded'} · Incoming source: ${esc(conflict.importedSource||'Spreadsheet import')}</small>${conflict.fields.map(field=>`<span>${esc(title(field.field))}: saved “${esc(field.saved)}” (${esc(field.savedSource)}) · imported “${esc(field.imported)}” (${esc(field.importedSource)})</span>`).join('')}</div>`).join('')}</div><p>Newer manually confirmed values are kept by default. Replacing them requires the visible choice in the save step; that choice applies to the listed conflicts.</p></details>`}
function renderPreview(){const p=state.preview,s=previewSummary(),records=previewRecords(),showIssues=state.previewFilter==='issues',panel=$('#preview-panel');panel.classList.remove('hidden');panel.classList.add('active-step');panel.innerHTML=`<div class="step-heading"><span>3</span><div><h3>Review Records</h3><p>Review clean records, records with issues, and imported ERRORS-sheet notes separately.</p></div></div><div class="import-summary">${[['Projects found',s.projects],['Equipment records',s.equipment],['Existing error-sheet rows',s.errorRows],['New blocking issues',s.blocking],['New warnings',s.issueWarnings],['Notes',s.notes],['Duplicate projects',s.duplicates],['Skipped rows',s.skipped]].map(([label,value])=>`<div><strong>${value}</strong><span>${label}</span></div>`).join('')}</div>${conflictPreview(p.conflicts)}${p.projects.errors.length?`<div class="warning"><strong>Skipped rows:</strong> ${p.projects.errors.slice(0,4).map(esc).join(' · ')}</div>`:''}<div class="preview-tabs"><button data-preview-filter="first" class="${state.previewFilter==='first'?'active':''}">First 10</button><button data-preview-filter="warnings" class="${state.previewFilter==='warnings'?'active':''}">Records with issues</button><button data-preview-filter="issues" class="${state.previewFilter==='issues'?'active':''}">Imported error notes</button><button data-preview-filter="all" class="${state.previewFilter==='all'?'active':''}">Show all records</button></div>${showIssues?`<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Project</th><th>Discipline</th><th>Original note</th><th>Source row</th></tr></thead><tbody>${records.map(issue=>`<tr><td>${esc(issue.severity)}</td><td>${esc(issue.projectNumber||issue.projectName||'Not identified')}</td><td>${esc(issue.discipline)}</td><td>${esc(issue.originalText||issue.message)}</td><td>${number(issue.originalRow)}</td></tr>`).join('')||'<tr><td colspan="5">No ERRORS-sheet notes found.</td></tr>'}</tbody></table></div>`:`<div class="table-wrap"><table><thead><tr><th>Project</th><th>Type</th><th>Consultant</th><th>SF</th><th>${p.type==='mechanical'?'Units':'Panels'}</th><th>Review status</th></tr></thead><tbody>${records.map(project=>{const c=classifyRecord(project),status=c.required.length?`<span class="badge low">Required issue</span> ${esc(c.required.join('; '))}`:c.optional.length?`<span class="badge moderate">Optional missing</span> ${esc(c.optional.join('; '))}`:c.info.length?`<span class="badge high">Normalized</span> ${esc(c.info.join('; '))}`:'Ready';return`<tr><td><strong>${esc(project.projectName)}</strong><br>${esc(project.projectNumber||'No number')}</td><td>${esc(project.buildingType)}</td><td>${esc(project.consultant)}</td><td>${number(project.squareFeet)}</td><td>${p.type==='mechanical'?number(hvacUnitCount(project)):number(electrical(project).panelCount)}</td><td>${status}</td></tr>`}).join('')}</tbody></table></div>`}<button id="continue-save" class="primary">Continue to save options</button>`;$$('[data-preview-filter]').forEach(button=>button.addEventListener('click',()=>{state.previewFilter=button.dataset.previewFilter;renderPreview()}));$('#continue-save').addEventListener('click',showSaveOptions)}
function showSaveOptions(){const s=previewSummary();$('#preview-panel').classList.remove('active-step');$('#preview-panel').innerHTML=`<div class="panel-heading"><span>${s.projects} projects reviewed · ${s.errorRows} ERRORS-sheet rows · ${s.duplicates} duplicates</span><button id="edit-review" class="text-button">Edit</button></div>`;$('#edit-review').addEventListener('click',renderPreview);const p=state.preview,panel=$('#save-panel');panel.classList.remove('hidden');panel.classList.add('active-step');setImportStep(4);panel.innerHTML=`<div class="step-heading"><span>4</span><div><h3>Save Data</h3><p>Choose how this ${esc(p.type)} spreadsheet should update the active local dataset.</p></div></div><div class="preview-actions"><label>Import mode<select id="commit-mode"><option value="add" ${state.importMode==='add'?'selected':''}>Add records</option><option value="replace" ${state.importMode==='replace'?'selected':''}>Replace ${esc(p.type)} dataset</option></select></label><label>Duplicate project numbers<select id="duplicate-action"><option value="skip">Skip duplicates</option><option value="replace">Replace duplicates</option><option value="merge">Merge discipline data</option></select></label>${s.conflicts?`<label>Manual update conflicts<select id="conflict-action"><option value="saved">Keep newer saved values</option><option value="imported">Use imported values</option><option value="merge">Merge, preferring saved values</option></select></label>`:''}${s.issueDuplicates?`<label>Likely duplicate issues<select id="issue-duplicate-action"><option value="skip">Skip imported duplicate</option><option value="merge">Merge into existing issue</option><option value="keep">Keep both issues</option></select></label>`:''}<button id="commit-import" class="primary">Save firm data</button></div><p class="helper">A JSON snapshot is created before destructive replacement. Original source files are never overwritten.</p>`;$('#commit-import').addEventListener('click',commitImport)}
async function commitImport(){const p=state.preview,button=$('#commit-import');button.disabled=true;try{const response=await fetch('/api/import/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:p.type,filename:p.filename,records:p.projects.records,issues:p.issues||[],mode:$('#commit-mode').value,duplicateAction:$('#duplicate-action').value,projectConflictAction:$('#conflict-action')?.value||'saved',issueDuplicateAction:$('#issue-duplicate-action')?.value||'skip'})}),result=await response.json();if(!response.ok)throw new Error(result.error);state.data=result.data;state.data.projects=analysis.canonicalizeConsultants(state.data.projects||[]);$('#save-panel').innerHTML=`<div class="save-success"><p class="kicker">Import complete</p><h3>Firm spreadsheet data is now active.</h3><p>${result.summary.imported} projects saved · ${result.summary.issuesImported||0} issues imported · ${result.summary.skipped} skipped · ${result.summary.duplicates} duplicates detected.</p><button id="import-another" class="secondary">Import another spreadsheet</button></div>`;setImportStep(4);$('#import-another').addEventListener('click',resetImport);renderAll();toast('Firm spreadsheet data is now active.')}catch(error){toast(error.message);button.disabled=false}}

function download(url){const anchor=document.createElement('a');anchor.href=url;anchor.click()}
async function renderManagement(){const cards=['mechanical','electrical'].map(type=>{const count=projects().filter(type==='mechanical'?hasMechanical:hasElectrical).length,info=state.data.imports?.[type];return`<article class="management-card"><header><div><p class="kicker">${title(type)} data</p><div class="big">${count} projects</div></div><span class="badge ${info?'high':'low'}">${info?'Active':'No import'}</span></header><p class="helper">Last import: ${info?new Date(info.at).toLocaleString():'Not yet imported'}<br>Source: ${esc(info?.filename||(state.data.isDemo?'Fictional demonstration data':'Not recorded'))}</p><div class="actions"><button class="action-button" data-action="start" data-mode="replace" data-type="${type}">Replace</button><button class="action-button" data-action="start" data-mode="add" data-type="${type}">Add records</button><button class="action-button" data-action="export" data-type="${type}">Export cleaned CSV</button><button class="action-button danger" data-action="clear" data-type="${type}">Clear</button></div></article>`});const master=state.data.settings||{},storage=state.data.storage||{},masterLocation=master.masterDirectory&&master.masterFilename?`${master.masterDirectory}\\${master.masterFilename}`:master.masterDirectory;$('#management-cards').innerHTML=cards.join('')+`<article class="management-card master-management"><p class="kicker">Portable master record</p><h3>Downloads & JSON safety</h3><p class="helper">Primary JSON: ${esc(storage.jsonFile||'Local application data')}<br>${esc(storage.notice||'Data is stored on this installation.')}</p><div class="actions"><button id="download-excel" class="primary">Download Latest Excel</button><button id="download-json" class="secondary">Download JSON Backup</button><label class="action-button file-action">Restore JSON Backup<input id="restore-json-file" type="file" accept=".json"></label><button id="view-backups" class="action-button">View backup history</button></div><div id="backup-history" class="backup-history hidden"></div></article><article class="management-card master-management"><p class="kicker">Optional local file</p><h3>Maintain Local Master Excel File</h3><label class="check"><input id="maintain-master" type="checkbox" ${master.maintainMasterExcel?'checked':''}> Generate after every successful data update</label><label>Dedicated output folder<input id="master-directory" value="${esc(master.masterDirectory||'')}" placeholder="C:\\SGA Data"></label><label>Filename<input id="master-filename" value="${esc(master.masterFilename||'SGA_MEP_Master.xlsx')}"></label><p class="helper">Current location: ${esc(masterLocation||'Not configured')}<br>Last update: ${master.lastMasterUpdate?new Date(master.lastMasterUpdate).toLocaleString():'Not yet generated'}<br>Last backup: ${master.lastMasterBackup?new Date(master.lastMasterBackup).toLocaleString():'None yet'}${master.lastMasterError?`<br><span class="warning-text">Last warning: ${esc(master.lastMasterError)}</span>`:''}</p><div class="actions"><button id="save-master-settings" class="secondary">Save setting</button><button id="regenerate-master" class="action-button">Regenerate Master Excel</button></div></article><article class="management-card"><p class="kicker">Demonstration records</p><h3>Restore fictional sample data</h3><p class="helper">Replaces the current local dataset with the original fictional demonstration portfolio.</p><button id="restore-demo" class="secondary">Reset to demonstration data</button></article>`;bindManagementActions()}
function startImportFlow(type, mode) {
  // Store the choice made from the Mechanical or Electrical data card.
  state.importMode = mode;

  // Open the Data Import page.
  navigateDirect('data-import');

  // Reset only the temporary import wizard.
  // This does not erase the active saved dataset.
  state.preview = null;
  $('#import-form').reset();
  $('#import-form').classList.remove('hidden');
  $('#upload-summary')?.remove();
  resetImportPanels();

  // Reopen Step 1.
  $('#import-step-1').classList.remove('collapsed-step');
  $('#import-step-1').classList.add('active-step');
  setImportStep(1);
  setImportStatus('');

  // Preselect the correct spreadsheet discipline.
  $('#import-type').value = type;

  // Update the upload area so the user knows what they selected.
  const actionLabel = mode === 'replace'
    ? `Replace ${title(type)} Dataset`
    : `Add ${title(type)} Records`;

  const uploadHeading = $('#import-step-1 h3');
  if (uploadHeading) {
    uploadHeading.textContent = actionLabel;
  }

  // Scroll directly to the upload section.
  $('#import-step-1').scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });

  // Open the Windows file picker after the page has moved.
  window.setTimeout(() => {
    $('#import-file').click();
  }, 450);
}

function bindManagementActions() {
  $$('[data-action="start"]').forEach(button => {
    button.addEventListener('click', () => {
      startImportFlow(
        button.dataset.type,
        button.dataset.mode
      );
    });
  });

  $$('[data-action="export"]').forEach(button => {
    button.addEventListener('click', () => {
      exportProjects(
        projects().filter(
          button.dataset.type === 'mechanical'
            ? hasMechanical
            : hasElectrical
        ),
        `sga-${button.dataset.type}-cleaned.csv`
      );
    });
  });

  $$('[data-action="clear"]').forEach(button => {
    button.addEventListener('click', () => {
      clearDataset(button.dataset.type);
    });
  });

  $('#download-excel').addEventListener('click', () => {
    download('/api/export/excel');
    toast('Latest workbook generated successfully.');
  });

  $('#download-json').addEventListener('click', () => {
    download('/api/export/json');
  });

  $('#restore-json-file').addEventListener(
    'change',
    restoreJsonFile
  );

  $('#view-backups').addEventListener(
    'click',
    loadBackupHistory
  );

  $('#save-master-settings').addEventListener(
    'click',
    saveMasterSettings
  );

  $('#regenerate-master').addEventListener(
    'click',
    regenerateMaster
  );

  $('#restore-demo').addEventListener(
    'click',
    restoreDemo
  );
}
async function restoreJsonFile(){const file=$('#restore-json-file').files[0];if(!file||!confirm(`Restore ${file.name} and replace the active local dataset? A snapshot of the current data will be kept.`))return;const form=new FormData();form.append('file',file);const response=await fetch('/api/data/restore-json',{method:'POST',body:form}),result=await response.json();if(!response.ok)return toast(result.error||'Backup could not be restored.');state.data=result.data;renderAll();toast('JSON backup restored.')}
async function loadBackupHistory(){const panel=$('#backup-history'),response=await fetch('/api/backups'),result=await response.json();panel.classList.remove('hidden');panel.innerHTML=`<h4>Recent JSON snapshots</h4>${result.backups?.length?result.backups.map(item=>`<div class="backup-row"><span>${esc(item.name)}<small>${new Date(item.createdAt).toLocaleString()} · ${number(item.size)} bytes</small></span><button class="text-button" data-restore-snapshot="${esc(item.name)}">Restore</button></div>`).join(''):'<p class="helper">No snapshots yet.</p>'}`;$$('[data-restore-snapshot]').forEach(button=>button.addEventListener('click',()=>restoreSnapshot(button.dataset.restoreSnapshot)))}
async function restoreSnapshot(name){if(!confirm(`Restore ${name}? The current dataset will be backed up first.`))return;const response=await fetch('/api/backups/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}),result=await response.json();if(!response.ok)return toast(result.error||'Snapshot could not be restored.');state.data=result.data;renderAll();toast('Previous snapshot restored.')}
async function saveMasterSettings(){const response=await fetch('/api/settings/master',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maintainMasterExcel:$('#maintain-master').checked,masterDirectory:$('#master-directory').value,masterFilename:$('#master-filename').value})}),result=await response.json();if(!response.ok)return toast(result.error||'Master workbook setting could not be saved.');state.data=result.data;renderAll();toast(result.message||'Master workbook setting saved.')}
async function regenerateMaster(){const response=await fetch('/api/master/regenerate',{method:'POST'}),result=await response.json();if(!response.ok)return toast(result.error||'Master workbook could not be generated. JSON data was not lost.');state.data=result.data;renderAll();toast(result.message||'Master workbook regenerated.')}

// Structure-aware import review and analysis eligibility overrides.
function analysisProjects(){return projects().filter(project=>analysis.isAnalysisEligible(project))}
function consultantStats(name){const all=projects().filter(p=>analysis.consultantKey(p.consultant)===analysis.consultantKey(name)),list=all.filter(project=>analysis.isAnalysisEligible(project)),sf=list.map(p=>p.squareFeet),tons=list.map(p=>mechanical(p).totalTonnage),ratios=list.map(p=>p.squareFeet&&mechanical(p).totalTonnage?p.squareFeet/mechanical(p).totalTonnage:null),units=allUnits(list),projectUnits=list.filter(hasMechanical).map(hvacUnitCount),checks=all.flatMap(p=>[p.projectNumber,p.projectName,p.buildingType,p.squareFeet,mechanical(p).totalTonnage,electrical(p).panelCount]),missing=checks.filter(v=>v==null||v===''||v==='Unknown').length/Math.max(1,checks.length)*100;return{name,list,all,types:unique(all.map(p=>p.buildingType)),totalSf:sum(sf),medSf:median(sf),minSf:valid(sf).length?Math.min(...valid(sf)):null,maxSf:valid(sf).length?Math.max(...valid(sf)):null,medTon:median(tons),sfTon:median(ratios),unitCount:average(projectUnits),systems:topValues(units.map(u=>u.normalizedType||u.type)),manufacturers:topValues(units.map(u=>u.manufacturer)),panels:average(list.map(p=>electrical(p).panelCount)),custom:units.filter(u=>/custom|unusual/i.test(u.classification||'')).length,missing}}

function metricEntries(project){return[['tonnage',mechanical(project).totals?.tonnage],['ductFeet',mechanical(project).totals?.ductFeet],['unitCount',mechanical(project).totals?.unitCount],['panelCount',electrical(project).totals?.panelCount]].filter(([,value])=>value)}
function totalLabel(metric){return{tonnage:'HVAC tonnage',ductFeet:'duct linear feet',unitCount:'HVAC unit count',panelCount:'electrical panel count'}[metric]||metric}
function totalValue(value,metric){if(!Number.isFinite(value))return'Unknown';return metric==='tonnage'?`${number(value,1)} tons`:metric==='ductFeet'?`${number(value)} feet`:number(value)}
function interpretationBadge(project){const totals=metricEntries(project).map(([,value])=>value);if(project.excludedFromAnalysis)return'<span class="badge low">Excluded</span>';if(project.analysisReviewRequired||totals.some(value=>value.conflict))return'<span class="badge low">Needs review</span>';if(totals.some(value=>value.verificationStatus==='Verified'))return'<span class="badge high">Verified</span>';if(totals.some(value=>value.verificationStatus==='Calculated'))return'<span class="badge moderate">Calculated</span>';if(totals.some(value=>value.verificationStatus==='Stated total'))return'<span class="badge moderate">Stated total</span>';return'<span class="badge">Unknown</span>'}
function totalDecision(projectId,metric){state.preview.totalDecisions=state.preview.totalDecisions||[];let decision=state.preview.totalDecisions.find(item=>item.projectId===projectId&&item.metric===metric);if(!decision){decision={projectId,metric,decision:'review',correctedValue:''};state.preview.totalDecisions.push(decision)}return decision}
function traceLine(trace){const source=Array.isArray(trace)?trace[0]:trace;if(!source)return'Not recorded';return`${esc(source.workbook||'Uploaded workbook')} / ${esc(source.sheet||'Sheet')} / row ${number(source.row)}${source.column?` / column ${esc(source.column)}`:''}`}
function totalReviewBlock(project,metric,total){if(!total?.conflict)return'';const selection=totalDecision(project.id,metric);return`<div class="total-conflict"><p><strong>${esc(totalLabel(metric))} conflict:</strong> Listed equipment totals ${totalValue(total.calculated,metric)}, but the spreadsheet states ${totalValue(total.stated,metric)}.</p><label>Staff decision<select data-total-decision data-project-id="${esc(project.id)}" data-metric="${metric}"><option value="review" ${selection.decision==='review'?'selected':''}>Save project as needs review</option><option value="stated" ${selection.decision==='stated'?'selected':''}>Use stated spreadsheet total</option><option value="calculated" ${selection.decision==='calculated'?'selected':''}>Use calculated equipment sum</option><option value="corrected" ${selection.decision==='corrected'?'selected':''}>Enter corrected value</option><option value="exclude" ${selection.decision==='exclude'?'selected':''}>Exclude from analysis</option></select></label><label class="corrected-total ${selection.decision==='corrected'?'':'hidden'}">Corrected ${esc(totalLabel(metric))}<input type="number" min="0" step="${metric==='tonnage'?'0.1':'1'}" value="${esc(selection.correctedValue)}" data-corrected-total data-project-id="${esc(project.id)}" data-metric="${metric}"></label><p class="helper">Both original totals and this choice will be preserved.</p></div>`}
function equipmentPreview(project) {
  const units = mechanical(project).units || [];
  const panels = electrical(project).panels || [];

  if (units.length) {
    return `
      <table>
        <thead>
          <tr>
            <th>Source row</th>
            <th>Unit</th>
            <th>Original type</th>
            <th>Normalized type</th>
            <th>Qty.</th>
            <th>Tons each</th>
          </tr>
        </thead>
        <tbody>
          ${units
            .map(
              unit => `
                <tr>
                  <td>${number(unit.sourceRow)}</td>
                  <td>${esc(unit.name || "Unnamed")}</td>
                  <td>${esc(unit.originalType || "Not recorded")}</td>
                  <td>${esc(
                    unit.normalizedType ||
                      unit.type ||
                      "Not recorded"
                  )}</td>
                  <td>${number(unit.quantity || 1)}</td>
                  <td>${
                    Number.isFinite(unit.tonnage)
                      ? number(unit.tonnage, 1)
                      : "Unknown"
                  }</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  if (panels.length) {
    return `
      <table>
        <thead>
          <tr>
            <th>Source row</th>
            <th>Disconnect</th>
            <th>Disconnect Amps</th>
            <th>Panel</th>
            <th>Type</th>
            <th>Load (kVA)</th>
            <th>Panel Amps</th>
            <th>Qty.</th>
            <th>Service / Rating</th>
          </tr>
        </thead>

        <tbody>
          ${panels
            .map(
              panel => `
                <tr>
                  <td>${number(panel.sourceRow)}</td>

                  <td>${esc(panel.disconnectName || "Not recorded")}</td>

                  <td>${
                    Number.isFinite(panel.disconnectAmps)
                      ? number(panel.disconnectAmps)
                      : "Not recorded"
                  }</td>

                  <td>${esc(
                    panel.panelName ||
                      panel.name ||
                      "Unnamed"
                  )}</td>

                  <td>${esc(panel.type || "Not recorded")}</td>

                  <td>${
                    Number.isFinite(panel.panelLoadKva)
                      ? number(panel.panelLoadKva, 2)
                      : "Not recorded"
                  }</td>

                  <td>${
                    Number.isFinite(panel.panelAmps)
                      ? number(panel.panelAmps)
                      : "Not recorded"
                  }</td>

                  <td>${number(panel.quantity || panel.count || 1)}</td>

                  <td>${esc(
                    panel.serviceInfo ||
                      panel.rating ||
                      "Not recorded"
                  )}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  return "<p>No equipment-level records were identified.</p>";
}


function importedNotesPreview(project){const notes=project.importedNotes||[];if(!notes.length)return'<p>No free-text notes were identified.</p>';return notes.map(note=>`<div class="note-review"><p><strong>Original note:</strong> ${esc(note.originalText)}</p>${note.suggestedInterpretations?.length?`<p><strong>Suggested from note:</strong> ${note.suggestedInterpretations.map(item=>`${esc(title(item.field))}: ${esc(item.value)} (${esc(item.confidence)} confidence)`).join(' · ')}</p><p class="helper">Suggestions remain pending review and do not affect official totals.</p>`:''}${note.issues?.length?`<p><strong>Detected issue:</strong> ${note.issues.map(item=>`${esc(item.severity)} — ${esc(item.message)}`).join(' · ')}</p>`:''}<p class="helper">${esc(note.sourceWorkbook||'Uploaded workbook')} / ${esc(note.sourceSheet||'Sheet')} / row ${number(note.sourceRow)}</p></div>`).join('')}
function importProjectCard(project){const tons=mechanical(project).totals?.tonnage,unitTypes=unique((mechanical(project).units||[]).map(unit=>unit.normalizedType||unit.type).filter(Boolean)),warnings=[...(project.quality||[]),...metricEntries(project).filter(([,value])=>value.conflict).map(([metric])=>`${totalLabel(metric)} needs review`)];return`<details class="import-project"><summary><span><strong>${esc(project.projectName)}</strong> <small>${esc(project.projectNumber||'No number')}</small><small>${esc(project.consultant||'Consultant not recorded')} · ${number(project.squareFeet)} SF</small></span><span class="import-project-metrics"><small>${number(hvacUnitCount(project))} equipment units</small><small>Listed sum: ${totalValue(tons?.calculated,'tonnage')}</small><small>Stated: ${totalValue(tons?.stated,'tonnage')}</small><small>Chosen: ${totalValue(mechanical(project).totalTonnage,'tonnage')}</small>${interpretationBadge(project)}</span></summary><div class="import-project-detail"><div class="detail-grid"><div><span>Source rows</span><strong>${esc((project.sourceRows||[]).join(', ')||'Not recorded')}</strong></div><div><span>Unit types found</span><strong>${esc(unitTypes.join(', ')||'Not recorded')}</strong></div><div><span>Notes interpreted</span><strong>${number(project.importedNotes?.length||0)}</strong></div><div><span>Warnings</span><strong>${number(warnings.length)}</strong></div></div>${metricEntries(project).map(([metric,total])=>totalReviewBlock(project,metric,total)).join('')}<h4>Parsed equipment</h4><div class="table-wrap">${equipmentPreview(project)}</div><h4>Original notes and suggestions</h4>${importedNotesPreview(project)}<details><summary>Source traceability</summary><ul class="quality-list">${(project.sourceTrace||[]).map(trace=>`<li>${esc(trace.field)}: ${esc(trace.originalValue)} → ${esc(trace.parsedValue)} (${esc(trace.parsingMethod)}) · ${traceLine(trace)}</li>`).join('')||'<li>No project-level trace was recorded.</li>'}</ul></details>${warnings.length?`<h4>Warnings</h4><ul class="quality-list">${warnings.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}</div></details>`}

function previewSummary(){const p=state.preview,records=p.projects.records,keys=records.map(projectKey),active=new Set(projects().map(projectKey)),issues=p.issues||[],conflictTotals=records.flatMap(metricEntries).filter(([,total])=>total.conflict).length;return{projects:records.length,equipment:p.projects.equipmentCount,ready:records.filter(project=>!project.analysisReviewRequired&&!project.excludedFromAnalysis).length,warnings:records.filter(project=>project.analysisReviewRequired||(project.quality||[]).length).length,duplicates:new Set(keys.filter((key,index)=>keys.indexOf(key)!==index||active.has(key))).size,skipped:p.projects.errors.length,errorRows:p.errorSheetRows||0,blocking:issues.filter(i=>i.severity==='Blocking').length,issueWarnings:issues.filter(i=>i.severity==='Warning').length,notes:issues.filter(i=>i.severity==='Note').length,conflicts:(p.conflicts||[]).length,conflictTotals,issueDuplicates:p.issueDuplicates||0}}
function previewRecords(){const p=state.preview;if(state.previewFilter==='issues')return p.importedIssues||[];const records=p.projects.records;if(state.previewFilter==='warnings')return records.filter(project=>project.analysisReviewRequired||(project.quality||[]).length||(project.importedNotes||[]).some(note=>note.issues?.length));return state.previewFilter==='all'?records:records.slice(0,10)}
function renderPreview(){const p=state.preview,s=previewSummary(),records=previewRecords(),showIssues=state.previewFilter==='issues',panel=$('#preview-panel');panel.classList.remove('hidden');panel.classList.add('active-step');panel.innerHTML=`<div class="step-heading"><span>3</span><div><h3>Review Records</h3><p>Confirm project totals, equipment rows, interpreted notes, and any items requiring staff review.</p></div></div><div class="import-summary">${[['Projects found',s.projects],['Equipment records',s.equipment],['Existing error-sheet rows',s.errorRows],['New blocking issues',s.blocking],['New warnings',s.issueWarnings],['Notes',s.notes],['Total conflicts',s.conflictTotals],['Duplicate projects',s.duplicates],['Skipped rows',s.skipped]].map(([label,value])=>`<div><strong>${value}</strong><span>${label}</span></div>`).join('')}</div>${conflictPreview(p.conflicts)}${p.projects.errors.length?`<div class="warning"><strong>Skipped rows:</strong> ${p.projects.errors.slice(0,4).map(esc).join(' · ')}</div>`:''}<div class="preview-tabs"><button data-preview-filter="first" class="${state.previewFilter==='first'?'active':''}">First 10</button><button data-preview-filter="warnings" class="${state.previewFilter==='warnings'?'active':''}">Records with issues</button><button data-preview-filter="issues" class="${state.previewFilter==='issues'?'active':''}">Imported error notes</button><button data-preview-filter="all" class="${state.previewFilter==='all'?'active':''}">Show all records</button></div>${showIssues?`<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Project</th><th>Discipline</th><th>Original note</th><th>Source row</th></tr></thead><tbody>${records.map(issue=>`<tr><td>${esc(issue.severity)}</td><td>${esc(issue.projectNumber||issue.projectName||'Not identified')}</td><td>${esc(issue.discipline)}</td><td>${esc(issue.originalText||issue.message)}</td><td>${number(issue.originalRow)}</td></tr>`).join('')||'<tr><td colspan="5">No ERRORS-sheet notes found.</td></tr>'}</tbody></table></div>`:`<div class="import-project-list">${records.map(importProjectCard).join('')||'<p>No projects match this review filter.</p>'}</div>`}<button id="continue-save" class="primary">Continue to save options</button>`;$$('[data-preview-filter]').forEach(button=>button.addEventListener('click',()=>{state.previewFilter=button.dataset.previewFilter;renderPreview()}));$$('[data-total-decision]').forEach(select=>select.addEventListener('change',()=>{const item=totalDecision(select.dataset.projectId,select.dataset.metric);item.decision=select.value;select.closest('.total-conflict').querySelector('.corrected-total').classList.toggle('hidden',select.value!=='corrected')}));$$('[data-corrected-total]').forEach(input=>input.addEventListener('input',()=>{totalDecision(input.dataset.projectId,input.dataset.metric).correctedValue=input.value}));$('#continue-save').addEventListener('click',showSaveOptions)}
async function commitImport(){const p=state.preview,button=$('#commit-import');button.disabled=true;try{const response=await fetch('/api/import/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:p.type,filename:p.filename,records:p.projects.records,issues:p.issues||[],totalDecisions:p.totalDecisions||[],mode:$('#commit-mode').value,duplicateAction:$('#duplicate-action').value,projectConflictAction:$('#conflict-action')?.value||'saved',issueDuplicateAction:$('#issue-duplicate-action')?.value||'skip'})}),result=await response.json();if(!response.ok)throw new Error(result.error);state.data=result.data;state.data.projects=analysis.canonicalizeConsultants(state.data.projects||[]);$('#save-panel').innerHTML=`<div class="save-success"><p class="kicker">Import complete</p><h3>Firm spreadsheet data is now active.</h3><p>${result.summary.imported} projects saved · ${result.summary.issuesImported||0} issues imported · ${result.summary.skipped} skipped · ${result.summary.duplicates} duplicates detected.</p><button id="import-another" class="secondary">Import another spreadsheet</button></div>`;setImportStep(4);$('#import-another').addEventListener('click',resetImport);renderAll();toast('Firm spreadsheet data is now active.')}catch(error){toast(error.message);button.disabled=false}}

function squareFeetConflictControls(project) {
  const conflict =
    project.squareFeetSourceConflict ||
    project.squareFeetConflict;

  if (!conflict) return "";

  const values = Array.isArray(conflict.values)
    ? conflict.values.filter(value => Number.isFinite(Number(value)))
    : [
        conflict.mechanical,
        conflict.electrical
      ].filter(value => Number.isFinite(Number(value)));

  if (!values.length) return "";

  const uniqueValues = [...new Set(values.map(Number))];

  return `
    <section class="sf-conflict-panel">
      <div>
        <p class="kicker">Square Footage Review</p>
        <h3>Choose the correct project square footage</h3>
        <p>
          The imported source contains conflicting values.
          Both original values will remain in the project history.
        </p>
      </div>

      <div class="sf-conflict-options">
        ${uniqueValues
          .map(
            value => `
              <label>
                <input
                  type="radio"
                  name="sf-conflict-${esc(project.id)}"
                  value="${value}"
                >
                Use ${number(value)} SF
              </label>
            `
          )
          .join("")}

        <label>
          <input
            type="radio"
            name="sf-conflict-${esc(project.id)}"
            value="custom"
          >
          Enter a corrected value
        </label>

        <input
          class="sf-corrected-value"
          data-sf-custom="${esc(project.id)}"
          type="number"
          min="1"
          step="1"
          placeholder="Correct square footage"
          disabled
        >
      </div>

      <div class="sf-conflict-actions">
        <button
          class="primary"
          data-resolve-sf="${esc(project.id)}"
        >
          Save square footage decision
        </button>
      </div>
    </section>
  `;
}

function projectDetail(p, warnings, compact = false) {
  const m = mechanical(p);
  const e = electrical(p);

  const tons = m.totals?.tonnage;
  const duct = m.totals?.ductFeet;
  const panelTotal = e.totals?.panelCount;
  const pIssues = projectIssues(p.id);

  if (compact) {
    return `
      <p>
        <strong>Mechanical:</strong>
        ${number(m.totalTonnage, 1)} tons ·
        ${number(m.totalDuctFeet)} duct LF ·
        ${number(hvacUnitCount(p))} units
        <br>

        <strong>Electrical:</strong>
        ${number(e.panelCount)} panels
        <br>

        <strong>Quality:</strong>
        ${esc(qualityStatus(p))}
      </p>
    `;
  }

  const units = (m.units || []).length
    ? m.units
        .map(
          unit => `
            <div class="unit-item">
              <span>
                <strong>${esc(unit.name || "Unnamed")}</strong>
              </span>

              <span>
                ${
                  Number.isFinite(unit.tonnage)
                    ? `${number(unit.tonnage, 1)} tons`
                    : "Unknown tonnage"
                }
              </span>

              <span>
                ${esc(
                  unit.normalizedType ||
                    unit.type ||
                    "Not recorded"
                )}
              </span>

              <span>
                ${esc(
                  unit.originalType
                    ? `Original: ${unit.originalType}`
                    : "Original type not recorded"
                )}
              </span>

              <span>
                Qty. ${number(unit.quantity || 1)}
              </span>

              <span>
                ${esc(
                  unit.manufacturer ||
                    "Manufacturer not recorded"
                )}
                ·
                ${esc(
                  unit.model ||
                    "Model not recorded"
                )}
              </span>
            </div>
          `
        )
        .join("")
    : "<p>No mechanical equipment detail recorded.</p>";

  const panels = (e.panels || []).length
    ? e.panels
        .map(
          panel => `
            <div class="unit-item">
              <span>
                <strong>
                  ${esc(panel.name || "Unnamed")}
                </strong>
              </span>

              <span>
                ${esc(panel.type || "Type not recorded")}
              </span>

              <span>
                Qty. ${number(
                  panel.quantity ||
                    panel.count ||
                    1
                )}
              </span>

              <span>
                ${esc(
                  panel.rating ||
                    panel.serviceInfo ||
                    "Rating not recorded"
                )}
              </span>

              <span>
                ${esc(
                  panel.manufacturer ||
                    "Manufacturer not recorded"
                )}
              </span>

              <span>
                ${esc(
                  panel.model ||
                    "Model not recorded"
                )}
              </span>
            </div>
          `
        )
        .join("")
    : "<p>No electrical equipment detail recorded.</p>";

  const related = relatedProjects(p);

  const sourceConflict =
    p.squareFeetSourceConflict &&
    Array.isArray(p.squareFeetSourceConflict.values)
      ? p.squareFeetSourceConflict
      : null;

  const crossDisciplineConflict =
    !sourceConflict &&
    p.squareFeetConflict &&
    Number.isFinite(
      Number(p.squareFeetConflict.mechanical)
    ) &&
    Number.isFinite(
      Number(p.squareFeetConflict.electrical)
    )
      ? p.squareFeetConflict
      : null;

  const conflictValues = sourceConflict
    ? sourceConflict.values
        .map(Number)
        .filter(Number.isFinite)
    : crossDisciplineConflict
      ? [
          Number(crossDisciplineConflict.mechanical),
          Number(crossDisciplineConflict.electrical)
        ]
      : [];

  const uniqueConflictValues = [
    ...new Set(conflictValues)
  ];

  const conflictPanel = uniqueConflictValues.length
    ? `
      <section class="sf-conflict-panel">
        <p class="kicker">
          Square Footage Review
        </p>

        <h3>
          Choose the correct project square footage
        </h3>

        <p>
          ${
            sourceConflict
              ? `The ${esc(
                  sourceConflict.discipline ||
                    "source"
                )} workbook contains conflicting square-footage values.`
              : "The Mechanical and Electrical sources contain different square-footage values."
          }
          Both original values will remain in the project history.
        </p>

        <div class="sf-conflict-options">
          ${uniqueConflictValues
            .map(
              value => `
                <label>
                  <input
                    type="radio"
                    name="sf-conflict-${esc(p.id)}"
                    value="${value}"
                  >
                  Use ${number(value)} SF
                </label>
              `
            )
            .join("")}

          <label>
            <input
              type="radio"
              name="sf-conflict-${esc(p.id)}"
              value="custom"
            >
            Enter a corrected value
          </label>

          <input
            class="sf-corrected-value"
            data-sf-custom="${esc(p.id)}"
            type="number"
            min="1"
            step="1"
            placeholder="Correct square footage"
            disabled
          >
        </div>

        <div class="sf-conflict-actions">
          <button
            class="primary"
            data-resolve-sf="${esc(p.id)}"
          >
            Save square footage decision
          </button>
        </div>
      </section>
    `
    : "";

  const displayedSquareFeet =
    projectSquareFeetForCurrentView(p);

  return `
    <div class="project-detail">
      ${conflictPanel}

      <div class="detail-grid">
        <div>
          <span>Consultant</span>
          <strong>
            ${esc(p.consultant || "Not recorded")}
          </strong>
        </div>

        <div>
          <span>Overall SF</span>
          <strong>
            ${
              Number.isFinite(
                Number(displayedSquareFeet)
              )
                ? number(displayedSquareFeet)
                : uniqueConflictValues.length
                  ? "Pending staff review"
                  : "Not recorded"
            }
          </strong>
        </div>

        <div>
          <span>Project total tonnage</span>
          <strong>
            ${
              Number.isFinite(m.totalTonnage)
                ? `${number(m.totalTonnage, 1)} tons`
                : "Not recorded"
            }
          </strong>
        </div>

        <div>
          <span>Tonnage source</span>
          <strong>
            ${esc(tons?.source || "Not recorded")}
          </strong>
        </div>

        <div>
          <span>Listed equipment sum</span>
          <strong>
            ${totalValue(
              tons?.calculated,
              "tonnage"
            )}
          </strong>
        </div>

        <div>
          <span>HVAC units</span>
          <strong>
            ${number(hvacUnitCount(p))}
          </strong>
        </div>

        <div>
          <span>Project duct total</span>
          <strong>
            ${totalValue(
              m.totalDuctFeet,
              "ductFeet"
            )}
          </strong>
        </div>

        <div>
          <span>Electrical panels</span>
          <strong>
            ${totalValue(
              e.panelCount,
              "panelCount"
            )}
          </strong>
        </div>

        <div>
          <span>Data quality</span>
          <strong>
            ${qualityBadge(p)}
          </strong>
        </div>
      </div>

      ${
        p.analysisReviewRequired
          ? `
            <div class="warning">
              One or more recorded values require staff review
              and may be excluded from some analyses.
            </div>
          `
          : ""
      }

      <h3>Mechanical equipment</h3>

      <div class="unit-list">
        ${units}
      </div>

      ${
        tons || duct
          ? `
            <details>
              <summary>
                Mechanical total comparison
              </summary>

              <ul class="quality-list">
                ${[
                  ["HVAC tonnage", tons],
                  ["Duct linear feet", duct]
                ]
                  .filter(([, value]) => value)
                  .map(
                    ([label, value]) => `
                      <li>
                        <strong>${label}:</strong>
                        stated ${valueOrNot(value.stated)}
                        · calculated ${valueOrNot(value.calculated)}
                        · chosen ${valueOrNot(value.chosen)}
                        · ${esc(
                          value.verificationStatus ||
                            "Unknown"
                        )}
                      </li>
                    `
                  )
                  .join("")}
              </ul>
            </details>
          `
          : ""
      }

      <h3>Electrical equipment</h3>

      <div class="unit-list">
        ${panels}
      </div>

      <p>
        <strong>Service:</strong>
        ${esc(e.serviceInfo || "Not recorded")}

        ${
          panelTotal
            ? `
              <br>
              <strong>Panel total source:</strong>
              ${esc(
                panelTotal.source ||
                  "Not recorded"
              )}
            `
            : ""
        }
      </p>

      <h3>Imported notes</h3>

      ${importedNotesPreview(p)}

      <h3>Audit information</h3>

      <p>
        Created:
        ${
          p.audit?.createdAt
            ? new Date(
                p.audit.createdAt
              ).toLocaleString()
            : "Not recorded"
        }

        · Last updated:
        ${
          p.audit?.updatedAt
            ? new Date(
                p.audit.updatedAt
              ).toLocaleString()
            : "Not recorded"
        }

        <br>

        Source:
        ${esc(p.audit?.sourceType || "Not recorded")}

        · Entered by:
        ${esc(p.audit?.enteredBy || "Not recorded")}

        · Origin:
        ${esc(p.audit?.origin || "Not recorded")}
      </p>

      ${
        pIssues.length
          ? `
            <h3>Issue history</h3>

            <ul class="quality-list">
              ${pIssues
                .map(
                  issue => `
                    <li>
                      <strong>
                        ${esc(issue.severity)}
                        ·
                        ${esc(issue.status)}:
                      </strong>

                      ${esc(issue.message)}

                      ${
                        issue.resolutionNote
                          ? ` — ${esc(
                              issue.resolutionNote
                            )}`
                          : ""
                      }
                    </li>
                  `
                )
                .join("")}
            </ul>
          `
          : ""
      }

      <h3>Related projects</h3>

      <div class="related-list">
        ${
          related.length
            ? related
                .map(
                  other => `
                    <button
                      data-related-id="${esc(other.id)}"
                    >
                      ${esc(other.projectName)}
                    </button>
                  `
                )
                .join("")
            : "No related projects available."
        }
      </div>
    </div>
  `;
}


function valueOrNot(value){return Number.isFinite(value)?number(value,1):'Not recorded'}

function blockDiagnostics(project){const d=project.importDiagnostics;if(!d)return'';const rows=value=>(value||[]).length?(value||[]).join(', '):'None detected';return`<details class="block-diagnostics"><summary>Project-block parsing diagnostics</summary><div class="diagnostic-grid"><div><span>Block rows</span><strong>${number(d.blockStartRow)}–${number(d.blockEndRow)}</strong></div><div><span>Project number row</span><strong>${number(d.projectNumberSourceRow)}</strong></div><div><span>Project name row</span><strong>${number(d.projectNameSourceRow)}</strong></div><div><span>Consultant row</span><strong>${number(d.consultantSourceRow)}</strong></div><div><span>Square footage row</span><strong>${number(d.squareFeetSourceRow)}</strong></div><div><span>Equipment rows</span><strong>${esc(rows(d.equipmentRows))}</strong></div><div><span>Total rows</span><strong>${esc(rows(d.totalRows))}</strong></div><div><span>Notes rows</span><strong>${esc(rows(d.notesRows))}</strong></div></div>${d.ignoredSummaryCells?.length?`<p class="helper">Ignored ratio / summary cells: ${d.ignoredSummaryCells.map(item=>`row ${number(item.row)} (${esc(item.originalText)})`).join(' · ')}</p>`:''}</details>`}
function importProjectCard(project){const tons=mechanical(project).totals?.tonnage,unitTypes=unique((mechanical(project).units||[]).map(unit=>unit.normalizedType||unit.type).filter(Boolean)),warnings=[...(project.quality||[]),...metricEntries(project).filter(([,value])=>value.conflict).map(([metric])=>`${totalLabel(metric)} needs review`)],recovered=project.importRecovery?.previouslyMissing||[];return`<details class="import-project"><summary><span><strong>${esc(project.projectName)}</strong> <small>${esc(project.projectNumber||'No number')}</small><small>${esc(project.consultant||'Consultant not recorded')} · ${number(project.squareFeet)} SF</small>${recovered.length?`<small class="recovered-field">Recovered from later block rows: ${esc(recovered.join(', '))}</small>`:''}</span><span class="import-project-metrics"><small>${number(hvacUnitCount(project))} equipment units</small><small>Listed sum: ${totalValue(tons?.calculated,'tonnage')}</small><small>Stated: ${totalValue(tons?.stated,'tonnage')}</small><small>Chosen: ${totalValue(mechanical(project).totalTonnage,'tonnage')}</small>${interpretationBadge(project)}</span></summary><div class="import-project-detail"><div class="detail-grid"><div><span>Source rows</span><strong>${esc((project.sourceRows||[]).join(', ')||'Not recorded')}</strong></div><div><span>Unit types found</span><strong>${esc(unitTypes.join(', ')||'Not recorded')}</strong></div><div><span>Notes interpreted</span><strong>${number(project.importedNotes?.length||0)}</strong></div><div><span>Warnings</span><strong>${number(warnings.length)}</strong></div></div>${metricEntries(project).map(([metric,total])=>totalReviewBlock(project,metric,total)).join('')}<h4>Parsed equipment</h4><div class="table-wrap">${equipmentPreview(project)}</div><h4>Original notes and suggestions</h4>${importedNotesPreview(project)}${blockDiagnostics(project)}<details><summary>Source traceability</summary><ul class="quality-list">${(project.sourceTrace||[]).map(trace=>`<li>${esc(trace.field)}: ${esc(trace.originalValue)} → ${esc(trace.parsedValue)} (${esc(trace.parsingMethod)}) · ${traceLine(trace)}</li>`).join('')||'<li>No project-level trace was recorded.</li>'}</ul></details>${warnings.length?`<h4>Warnings</h4><ul class="quality-list">${warnings.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}</div></details>`}
function previewSummary(){const p=state.preview,records=p.projects.records,keys=records.map(projectKey),active=new Set(projects().map(projectKey)),issues=p.issues||[],conflictTotals=records.flatMap(metricEntries).filter(([,total])=>total.conflict).length,recovery=p.recoverySummary||{};return{projects:records.length,equipment:p.projects.equipmentCount,ready:records.filter(project=>!project.analysisReviewRequired&&!project.excludedFromAnalysis).length,warnings:records.filter(project=>project.analysisReviewRequired||(project.quality||[]).length).length,duplicates:new Set(keys.filter((key,index)=>keys.indexOf(key)!==index||active.has(key))).size,skipped:p.projects.errors.length,errorRows:p.errorSheetRows||0,blocking:issues.filter(i=>i.severity==='Blocking').length,issueWarnings:issues.filter(i=>i.severity==='Warning').length,notes:issues.filter(i=>i.severity==='Note').length,conflicts:(p.conflicts||[]).length,conflictTotals,issueDuplicates:p.issueDuplicates||0,recoveredSquareFeet:recovery.recoveredSquareFeet||0,recoveredConsultants:recovery.recoveredConsultants||0,matchingProjects:recovery.matchingProjects||0}}
function recoveryPreview(recovery){if(!recovery||!recovery.matchingProjects)return'';return`<div class="recovery-summary"><strong>Before-versus-after field recovery</strong><span>${number(recovery.recoveredSquareFeet)} of ${number(recovery.missingSquareFeetBefore)} previously missing square-footage values found</span><span>${number(recovery.recoveredConsultants)} of ${number(recovery.missingConsultantsBefore)} previously missing consultant values found</span><small>Preview only. Active firm data will not change until Save Data is confirmed.</small></div>`}

// Architect-facing quality and local-save trust refinements.
function qualityStatus(project){return project.dataStatus||project.qualityStatus||'Limited Data'}
function qualityBadge(project,interactive=false){const status=qualityStatus(project),tone={'Ready':'high','Limited Data':'limited','Review Needed':'review','Excluded':'excluded','Complete History':'resolved'}[status]||'limited',tip=project.dataAvailability?.explanation||'Open details for data availability.';return interactive?`<button class="badge quality-badge ${tone}" data-quality-project="${esc(project.id)}" title="${esc(tip)}">${esc(status)}</button>`:`<span class="badge quality-badge ${tone}" title="${esc(tip)}">${esc(status)}</span>`}
function analysisProjects(){return projects().filter(project=>!project.dataAvailability?.globallyExcluded&&!project.excludedFromAnalysis)}
function availabilityHtml(project){const a=project.dataAvailability;if(!a)return'';return`<h3>Data availability</h3><p>${esc(a.explanation)}</p><div class="availability"><div class="available"><strong>Available for</strong><ul>${a.available.map(item=>`<li>✓ ${esc(item.label)}</li>`).join('')||'<li>No analytical uses recorded</li>'}</ul></div><div class="unavailable"><strong>Unavailable for</strong><ul>${a.unavailable.map(item=>`<li>${esc(item.label)} because ${esc(item.reason)}</li>`).join('')||'<li>No known limitations</li>'}</ul></div></div>`}
function reviewGroup(issue){if(issue.status==='Resolved')return'Resolved';if(issue.severity==='Note'||/existing|renovation|vav|no ducts|staff estimate|unusual|custom/i.test(`${issue.category} ${issue.message}`))return'Informational Notes';if(/conflict|identity|ambiguous|multiple consultant|no usable/i.test(`${issue.category} ${issue.message}`))return'Needs Review';return'Missing Information'}
function filteredIssues(){const query=$('#issue-search').value.trim().toLowerCase(),discipline=$('#issue-discipline').value,group=$('#issue-severity').value,status=$('#issue-status').value,unresolved=$('#issue-unresolved').checked;return issues().filter(issue=>(!query||`${issue.projectNumber} ${issue.projectName}`.toLowerCase().includes(query))&&(!discipline||issue.discipline===discipline)&&(!group||reviewGroup(issue)===group)&&(!status||issue.status===status)&&(!unresolved||issue.status!=='Resolved'))}

function isRealDataQualityProject(project) {
  if (!project) return false;

  const name = String(
    project.projectName || ""
  ).trim();

  if (!name) return false;

  // Spreadsheet subtotal and summary rows are not projects.
  if (/^total\s*:?\s*$/i.test(name)) {
    return false;
  }

  return true;
}

function currentDataQualityIssues() {
  const validProjects = projects().filter(
    isRealDataQualityProject
  );

  const validProjectIds = new Set(
    validProjects
      .map(project => String(project.id || ""))
      .filter(Boolean)
  );

  const validProjectNumbers = new Set(
    validProjects
      .map(project =>
        String(project.projectNumber || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );

  const validProjectNames = new Set(
    validProjects
      .map(project =>
        String(project.projectName || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );

  return issues().filter(issue => {
    const projectName = String(
      issue.projectName || ""
    ).trim();

    const projectNumber = String(
      issue.projectNumber || ""
    ).trim();

    // Remove spreadsheet summary rows.
    if (/^total\s*:?\s*$/i.test(projectName)) {
      return false;
    }

    // Staff notes not linked to a project may remain.
    if (
      !issue.projectId &&
      !projectName &&
      !projectNumber
    ) {
      return true;
    }

    // Keep only issues that still match a current project.
    if (
      issue.projectId &&
      validProjectIds.has(String(issue.projectId))
    ) {
      return true;
    }

    if (
      projectNumber &&
      validProjectNumbers.has(
        projectNumber.toLowerCase()
      )
    ) {
      return true;
    }

    if (
      projectName &&
      validProjectNames.has(
        projectName.toLowerCase()
      )
    ) {
      return true;
    }

    return false;
  });
}

function dataQualityDisciplineMatches(issue) {
  const selected =
    state.dataQualityDiscipline || "mechanical";

  const discipline = String(
    issue.discipline || "General"
  ).toLowerCase();

  // General issues matter to both views.
  if (discipline === "general") {
    return true;
  }

  return discipline === selected;
}

function renderDataQualityDisciplineSwitch() {
  const page = $("#data-quality");

  if (!page) return;

  let switcher = $(
    "#data-quality-discipline-switch"
  );

  if (!switcher) {
    switcher = document.createElement("div");

    switcher.id =
      "data-quality-discipline-switch";

    switcher.className =
      "data-quality-discipline-switch";

    const summary = $("#issue-summary");

    summary?.insertAdjacentElement(
      "beforebegin",
      switcher
    );
  }

  switcher.innerHTML = `
    <button
      type="button"
      class="${
        state.dataQualityDiscipline ===
        "mechanical"
          ? "active"
          : ""
      }"
      data-quality-discipline="mechanical"
    >
      Mechanical
    </button>

    <button
      type="button"
      class="${
        state.dataQualityDiscipline ===
        "electrical"
          ? "active"
          : ""
      }"
      data-quality-discipline="electrical"
    >
      Electrical
    </button>
  `;

  switcher
    .querySelectorAll(
      "[data-quality-discipline]"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          state.dataQualityDiscipline =
            button.dataset.qualityDiscipline;

          renderDataQuality();
        }
      );
    });
}

function effectiveProjectSquareFeet(project) {
  const values = [
    project?.squareFeetResolution?.selectedValue,
    project?.squareFeet,
    project?.mechanical?.squareFeet,
    project?.electrical?.squareFeet
  ];

  for (const value of values) {
    const parsed = Number(value);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function effectiveProjectConsultant(project) {
  const values = [
    project?.consultant,
    project?.mechanical?.consultant,
    project?.electrical?.consultant
  ];

  return (
    values.find(value => {
      const text = String(value || "").trim();

      return (
        text &&
        text.toLowerCase() !== "unknown"
      );
    }) || ""
  );
}

function issueStillApplies(issue) {
  if (!issue.autoDetected) {
    return true;
  }

  const project = projects().find(
    item =>
      String(item.id) ===
      String(issue.projectId)
  );

  if (!project) {
    return false;
  }

  const combinedText = `
    ${issue.category || ""}
    ${issue.message || ""}
  `.toLowerCase();

  if (
    combinedText.includes("square footage")
  ) {
    return !Number.isFinite(
      effectiveProjectSquareFeet(project)
    );
  }

  if (
    combinedText.includes("consultant")
  ) {
    return !effectiveProjectConsultant(
      project
    );
  }

  if (
    combinedText.includes("manufacturer")
  ) {
    const mechanicalData =
      mechanical(project);

    return !(
      mechanicalData.manufacturer ||
      (mechanicalData.units || []).some(
        unit => unit.manufacturer
      )
    );
  }

  if (combinedText.includes("model")) {
    const mechanicalData =
      mechanical(project);

    return !(
      mechanicalData.model ||
      (mechanicalData.units || []).some(
        unit => unit.model
      )
    );
  }

  if (
    combinedText.includes("no usable mechanical") ||
    combinedText.includes(
      "no usable mechanical or electrical"
    )
  ) {
    return !(
      hasMechanical(project) ||
      hasElectrical(project)
    );
  }

  return true;
}

function correctionProjectPayload(
  project,
  editorRow
) {
  const mechanicalData =
    mechanical(project);

  const electricalData =
    electrical(project);

  const correctedSquareFeet =
    editorRow.querySelector(
      "[data-correct-square-feet]"
    ).value;

  const correctedConsultant =
    editorRow.querySelector(
      "[data-correct-consultant]"
    ).value;

  const correctedTonnage =
    editorRow.querySelector(
      "[data-correct-tonnage]"
    ).value;

  const correctedManufacturer =
    editorRow.querySelector(
      "[data-correct-manufacturer]"
    ).value;

  const correctedModel =
    editorRow.querySelector(
      "[data-correct-model]"
    ).value;

  const correctedPanels =
    editorRow.querySelector(
      "[data-correct-panels]"
    ).value;

  const correctedService =
    editorRow.querySelector(
      "[data-correct-service]"
    ).value;

  const correctedDuctwork =
    editorRow.querySelector(
      "[data-correct-ductwork]"
    ).value;

  const resolvedBy =
    editorRow.querySelector(
      "[data-resolved-by]"
    ).value.trim();

  return {
    id: project.id,

    projectNumber:
      project.projectNumber || "",

    projectName:
      project.projectName || "",

    buildingType:
      project.buildingType || "",

    squareFeet:
      correctedSquareFeet ||
      effectiveProjectSquareFeet(project) ||
      "",

    consultant:
      correctedConsultant ||
      effectiveProjectConsultant(project) ||
      "",

    projectStatus:
      project.projectStatus ||
      "Completed",

    completionDate:
      project.completionDate || "",

    excludedFromAnalysis:
      Boolean(
        project.excludedFromAnalysis
      ),

    mechanical: {
      units:
        mechanicalData.units || [],

      totalTonnage:
        correctedTonnage ||
        mechanicalData.totalTonnage ||
        "",

      statedTonnage:
        correctedTonnage ||
        mechanicalData.totalTonnage ||
        "",

      totalChoice:
        correctedTonnage
          ? "corrected"
          : "keep-recorded",

      correctedTonnage:
        correctedTonnage || "",

      unitCount:
        mechanicalData.unitCount ??
        hvacUnitCount(project) ??
        "",

      primarySystemType:
        mechanicalData.primarySystemType ||
        "",

      manufacturer:
        correctedManufacturer ||
        mechanicalData.manufacturer ||
        "",

      model:
        correctedModel ||
        mechanicalData.model ||
        "",

      totalDuctFeet:
        correctedDuctwork ||
        mechanicalData.totalDuctFeet ||
        "",

      notes:
        mechanicalData.notes || ""
    },

    electrical: {
      panels:
        electricalData.panels || [],

      panelCount:
        correctedPanels ||
        electricalData.panelCount ||
        "",

      serviceInfo:
        correctedService ||
        electricalData.serviceInfo ||
        "",

      notes:
        electricalData.notes || ""
    },

    audit: {
      enteredBy:
        resolvedBy,

      sourceType:
        "Data Quality correction"
    }
  };
}

async function refreshDataQuality() {
  const button = $("#refresh-data-quality");

  if (!button) return;

  const originalText = button.textContent;

  button.disabled = true;
  button.textContent = "Refreshing...";

  try {
    await refreshData();
    toast("Data Review refreshed.");
  } catch (error) {
    console.error(error);
    toast("Data Review could not be refreshed.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function renderDataQuality() {
  if (!state.data) return;

  renderDataQualityDisciplineSwitch();

  const groups = [
    "Needs Review",
    "Missing Information",
    "Informational Notes",
    "Resolved"
  ];

  const disciplineIssues =
    currentDataQualityIssues()
      .filter(issueStillApplies)
      .filter(
        dataQualityDisciplineMatches
      );

  const counts = Object.fromEntries(
    groups.map(group => [group, 0])
  );

  disciplineIssues.forEach(issue => {
    const group = reviewGroup(issue);

    counts[group] =
      (counts[group] || 0) + 1;
  });

  const summary =
    $("#issue-summary");

  if (summary) {
    summary.innerHTML = groups
      .map(
        label => `
          <div class="portfolio-stat">
            <div class="label">
              ${esc(label)}
            </div>

            <div class="value">
              ${number(counts[label] || 0)}
            </div>
          </div>
        `
      )
      .join("");
  }

  const filteredIds = new Set(
    filteredIssues().map(
      issue => issue.id
    )
  );

  const list =
    disciplineIssues.filter(
      issue =>
        filteredIds.has(issue.id)
    );

  const tableContainer =
    $("#issues-table");

  if (!tableContainer) return;

  tableContainer.innerHTML =
    list.length
      ? `
        <table>
          <thead>
            <tr>
              <th>Review group</th>
              <th>Project</th>
              <th>Discipline</th>
              <th>Issue</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            ${list
              .map(issue => {
                const group =
                  reviewGroup(issue);

                const groupClass =
                  group === "Needs Review"
                    ? "review"
                    : group === "Resolved"
                      ? "resolved"
                      : "limited";

                return `
                  <tr
                    data-issue-row="${esc(
                      issue.id
                    )}"
                  >
                    <td>
                      <span
                        class="badge ${groupClass}"
                      >
                        ${esc(group)}
                      </span>
                    </td>

                    <td>
                      <strong>
                        ${esc(
                          issue.projectName ||
                          "Project not identified"
                        )}
                      </strong>

                      <span class="source-note">
                        ${esc(
                          issue.projectNumber ||
                          "No number"
                        )}
                      </span>
                    </td>

                    <td>
                      ${esc(
                        issue.discipline ||
                        "General"
                      )}
                    </td>

                    <td class="issue-message">
                      <strong>
                        ${esc(
                          issue.category ||
                          "Data-quality issue"
                        )}
                      </strong>

                      <span>
                        ${esc(
                          issue.message ||
                          "No issue message recorded."
                        )}
                      </span>
                    </td>

                    <td>
                      ${esc(
                        issue.status ||
                        "Unresolved"
                      )}
                    </td>

                    <td class="row-actions">
                      <button
                        type="button"
                        class="text-button"
                        data-issue-resolve="${esc(
                          issue.id
                        )}"
                      >
                        Resolve
                      </button>
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      `
      : `
        <div class="empty-state">
          No ${esc(
            state.dataQualityDiscipline
          )} issues match these filters.
        </div>
      `;

  $$("[data-issue-resolve]").forEach(
    button => {
      button.addEventListener(
        "click",
        () => {
          const issue =
            issues().find(
              item =>
                item.id ===
                button.dataset.issueResolve
            );

          const issueRow =
            button.closest("tr");

          if (!issue || !issueRow) {
            return;
          }

          openResolveEditor(
            issue,
            issueRow
          );
        }
      );
    }
  );

  const refreshButton = $("refresh-data-quality");

  if (refreshButton) {
    refreshButton.onclick = refreshDataQuality;
  }
}

function renderTrustStatus() {
  const storage = state.data.storage || {};
  const formatTime = value =>
    value
      ? new Date(value).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit'
        })
      : 'Not yet';

  const masterStatus = state.data.settings?.lastMasterError
    ? 'Master Excel update pending'
    : storage.masterStatus && storage.masterStatus !== 'Not enabled'
      ? `Master Excel: ${storage.masterStatus}`
      : '';

  const unsavedStatus = state.unsavedUpdate
    ? '<span class="trust-unsaved">Unsaved changes</span>'
    : '';

  $('#save-trust').innerHTML = `
    <span class="trust-saved">● Saved locally</span>
    <span>Last saved ${esc(formatTime(storage.lastSavedAt))}</span>
    <span>Backup ${esc(formatTime(storage.lastBackupAt))}</span>
    ${masterStatus ? `<span>${esc(masterStatus)}</span>` : ''}
    ${unsavedStatus}
  `;
}

function markUpdateDirty(){state.unsavedUpdate=true;renderTrustStatus()}
function navigateDirect(id){$$('.section-nav button').forEach(button=>button.classList.toggle('active',button.dataset.section===id));$$('.page').forEach(page=>page.classList.toggle('active',page.id===id));window.scrollTo({top:0,behavior:'smooth'})}
async function goTo(id){if(state.unsavedUpdate&&$('#updates').classList.contains('active')&&id!=='updates'){if(window.confirm('Save your project changes before continuing?')){const saved=await submitProjectUpdate({});if(!saved)return}else if(window.confirm('Discard unsaved changes and continue?')){state.unsavedUpdate=false}else return}navigateDirect(id)}
async function submitProjectUpdate(options){const response=await fetch('/api/projects/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:currentUpdatePayload(),options})}),result=await response.json();if(response.ok){state.data=result.data;state.unsavedUpdate=false;renderAll();resetUpdateForm();toast(result.message);if(result.masterWarning)toast(result.masterWarning);return true}if(response.status===409||response.status===422){renderUpdateValidation(result);return false}toast(result.error||'Project could not be saved.');return false}
async function previewImport(mapping=null,continueToReview=false){const file=$('#import-file').files[0];if(!file)return;setImportStatus('Reading and normalizing the spreadsheet…');const form=new FormData();form.append('file',file);form.append('type',$('#import-type').value);if(mapping)form.append('mapping',JSON.stringify(mapping));try{const response=await fetch('/api/import/preview',{method:'POST',body:form}),result=await response.json();if(!response.ok)throw new Error(result.error);state.preview=result;state.previewFilter='first';collapseUpload();if(result.masterWorkbook){showReview();setImportStatus(`Recognized SGA master workbook: ${result.projects.records.length} projects and ${result.issues.length} retained issues.`,'success')}else{renderMapping();setImportStatus(`Found ${result.projects.records.length} projects.`,'success');if(continueToReview)showReview()}}catch(error){setImportStatus(error.message,'error')}}
function renderUpdateTotals(){const calc=(state.updateUnits||[]).reduce((s,u)=>s+(Number(u.tonnage)||0)*(Number(u.quantity)||1),0),count=(state.updateUnits||[]).reduce((s,u)=>s+(Number(u.quantity)||1),0),stated=Number($('#update-tonnage').value),conflict=calc&&stated&&Math.abs(calc-stated)>.05;$('#update-units').value=count||'';$('#mechanical-total-check').innerHTML=`<strong>Listed equipment:</strong> ${calc?`${number(calc,1)} tons · ${count} units`:'Not recorded'}<br><strong>Recorded project total:</strong> ${stated?`${number(stated,1)} tons`:'Not recorded'}<br><strong>Status:</strong> ${conflict?'Review Needed':calc&&stated?'Verified':'Limited Data'}${conflict?'<label>Total decision<select id="update-total-choice"><option value="review">Leave for review</option><option value="use-calculated">Use listed equipment sum</option><option value="keep-recorded">Keep recorded total</option><option value="corrected">Enter corrected total</option></select></label><label>Corrected total<input id="update-corrected-total" type="number" step="0.5"></label>':''}`}
function renderEquipmentEditors() {
  const units = state.updateUnits || [];
  const panels = state.updatePanels || [];

  const unitSummary = unit => {
    const name =
      unit.name ||
      unit.manufacturer ||
      unit.model ||
      "Unnamed unit";

    const details = [
      unit.tonnage
        ? `${number(unit.tonnage, 1)} tons`
        : null,

      unit.quantity
        ? `Qty. ${number(unit.quantity)}`
        : null,

      unit.normalizedType ||
        unit.originalType ||
        unit.type ||
        null,

      unit.manufacturer || null,

      unit.model || null
    ].filter(Boolean);

    return {
      name,
      details:
        details.join(" · ") ||
        "No equipment details recorded"
    };
  };

  const panelSummary = panel => {
    const name =
      panel.name ||
      panel.type ||
      panel.manufacturer ||
      "Unnamed panel";

    const details = [
      panel.rating ||
        panel.serviceInfo ||
        null,

      panel.quantity
        ? `Qty. ${number(panel.quantity)}`
        : null,

      panel.manufacturer || null,

      panel.model || null
    ].filter(Boolean);

    return {
      name,
      details:
        details.join(" · ") ||
        "No panel details recorded"
    };
  };

  $("#mechanical-unit-editor").innerHTML =
    units.length
      ? units
          .map((unit, index) => {
            const summary =
              unitSummary(unit);

            return `
              <details
                class="equipment-edit-card"
                ${index === 0 ? "open" : ""}
              >
                <summary>
                  <div class="equipment-summary-copy">
                    <strong>
                      ${esc(summary.name)}
                    </strong>

                    <span>
                      ${esc(summary.details)}
                    </span>
                  </div>

                  <span class="equipment-chevron">
                    +
                  </span>
                </summary>

                <div class="equipment-edit-fields">
                  <label>
                    Unit tag

                    <input
                      data-unit-field="${index}:name"
                      value="${esc(
                        unit.name ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Original type

                    <input
                      data-unit-field="${index}:originalType"
                      value="${esc(
                        unit.originalType ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Normalized type

                    <input
                      data-unit-field="${index}:normalizedType"
                      value="${esc(
                        unit.normalizedType ??
                        unit.type ??
                        ""
                      )}"
                    >
                  </label>

                  <label>
                    Tons

                    <input
                      type="number"
                      min="0"
                      step="any"
                      data-unit-field="${index}:tonnage"
                      value="${esc(
                        unit.tonnage ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Quantity

                    <input
                      type="number"
                      min="1"
                      step="1"
                      data-unit-field="${index}:quantity"
                      value="${esc(
                        unit.quantity ?? 1
                      )}"
                    >
                  </label>

                  <label>
                    Manufacturer

                    <input
                      data-unit-field="${index}:manufacturer"
                      value="${esc(
                        unit.manufacturer ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Model

                    <input
                      data-unit-field="${index}:model"
                      value="${esc(
                        unit.model ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Condition

                    <select
                      data-unit-field="${index}:existingCondition"
                    >
                      <option
                        value="false"
                        ${
                          !unit.existingCondition
                            ? "selected"
                            : ""
                        }
                      >
                        New
                      </option>

                      <option
                        value="true"
                        ${
                          unit.existingCondition
                            ? "selected"
                            : ""
                        }
                      >
                        Existing
                      </option>
                    </select>
                  </label>

                  <label class="equipment-notes-field">
                    Notes

                    <textarea
                      rows="2"
                      data-unit-field="${index}:notes"
                    >${esc(
                      unit.notes ?? ""
                    )}</textarea>
                  </label>

                  <div class="equipment-card-actions">
                    <button
                      type="button"
                      class="remove-equipment"
                      data-remove-unit="${index}"
                    >
                      Remove unit
                    </button>
                  </div>
                </div>
              </details>
            `;
          })
          .join("")
      : `
        <p class="helper equipment-empty">
          No unit-level equipment recorded.
        </p>
      `;

  $("#electrical-row-editor").innerHTML =
    panels.length
      ? panels
          .map((panel, index) => {
            const summary =
              panelSummary(panel);

            return `
              <details
                class="equipment-edit-card"
                ${index === 0 ? "open" : ""}
              >
                <summary>
                  <div class="equipment-summary-copy">
                    <strong>
                      ${esc(summary.name)}
                    </strong>

                    <span>
                      ${esc(summary.details)}
                    </span>
                  </div>

                  <span class="equipment-chevron">
                    +
                  </span>
                </summary>

                <div class="equipment-edit-fields panel-fields">
                  <label>
                    Tag

                    <input
                      data-panel-field="${index}:name"
                      value="${esc(
                        panel.name ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Type

                    <input
                      data-panel-field="${index}:type"
                      value="${esc(
                        panel.type ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Rating / service

                    <input
                      data-panel-field="${index}:rating"
                      value="${esc(
                        panel.rating ??
                        panel.serviceInfo ??
                        ""
                      )}"
                    >
                  </label>

                  <label>
                    Quantity

                    <input
                      type="number"
                      min="1"
                      step="1"
                      data-panel-field="${index}:quantity"
                      value="${esc(
                        panel.quantity ?? 1
                      )}"
                    >
                  </label>

                  <label>
                    Manufacturer

                    <input
                      data-panel-field="${index}:manufacturer"
                      value="${esc(
                        panel.manufacturer ?? ""
                      )}"
                    >
                  </label>

                  <label>
                    Model

                    <input
                      data-panel-field="${index}:model"
                      value="${esc(
                        panel.model ?? ""
                      )}"
                    >
                  </label>

                  <label class="equipment-notes-field">
                    Notes

                    <textarea
                      rows="2"
                      data-panel-field="${index}:notes"
                    >${esc(
                      panel.notes ?? ""
                    )}</textarea>
                  </label>

                  <div class="equipment-card-actions">
                    <button
                      type="button"
                      class="remove-equipment"
                      data-remove-panel="${index}"
                    >
                      Remove panel
                    </button>
                  </div>
                </div>
              </details>
            `;
          })
          .join("")
      : `
        <p class="helper equipment-empty">
          No panel-level detail recorded.
        </p>
      `;

  $$("[data-unit-field]").forEach(input => {
    input.addEventListener("input", () => {
      const [index, field] =
        input.dataset.unitField.split(":");

      units[index][field] =
        field === "existingCondition"
          ? input.value === "true"
          : input.value;

      markUpdateDirty();
      renderUpdateTotals();
    });
  });

  $$("[data-panel-field]").forEach(input => {
    input.addEventListener("input", () => {
      const [index, field] =
        input.dataset.panelField.split(":");

      panels[index][field] =
        input.value;

      markUpdateDirty();
    });
  });

  $$("[data-remove-unit]").forEach(button => {
    button.addEventListener("click", () => {
      units.splice(
        Number(button.dataset.removeUnit),
        1
      );

      markUpdateDirty();
      renderEquipmentEditors();
    });
  });

  $$("[data-remove-panel]").forEach(button => {
    button.addEventListener("click", () => {
      panels.splice(
        Number(button.dataset.removePanel),
        1
      );

      markUpdateDirty();
      renderEquipmentEditors();
    });
  });

  renderUpdateTotals();
}

async function refreshUpdatesData() {
  const button =
    $("#refresh-updates-data");

  if (!button) return;

  const currentProjectId =
    $("#update-project-id")?.value || "";

  const originalText =
    button.textContent;

  button.disabled = true;
  button.textContent = "Refreshing...";

  try {
    /*
     * refreshData() already exists near the top
     * of your app.js. It fetches /api/data,
     * updates state.data, and runs renderAll().
     */
    await refreshData();

    /*
     * Reopen the project that was being edited
     * before the refresh.
     */
    if (
      currentProjectId &&
      projects().some(
        project =>
          String(project.id) ===
          String(currentProjectId)
      )
    ) {
      loadProjectUpdate(
        currentProjectId
      );
    }

    toast(
      "Latest project data loaded."
    );
  } catch (error) {
    console.error(error);

    toast(
      "Latest data could not be loaded."
    );
  } finally {
    button.disabled = false;
    button.textContent =
      originalText;
  }
}

function bindUpdates() {
  $("#choose-update")
    .addEventListener(
      "click",
      () => setUpdateMode("existing")
    );

  $("#choose-new")
    .addEventListener(
      "click",
      () => setUpdateMode("new")
    );

  $("#refresh-updates-data")
    ?.addEventListener(
      "click",
      refreshUpdatesData
    );

  $("#update-project-search")
    .addEventListener(
      "input",
      renderUpdateSearch
    );

  $("#project-update-form")
    .addEventListener(
      "submit",
      event => {
        event.preventDefault();

        submitProjectUpdate({});
      }
    );

  $("#cancel-update")
    .addEventListener(
      "click",
      () => {
        state.unsavedUpdate = false;

        resetUpdateForm();
      }
    );

  [
    "#update-sf",
    "#update-building-type",
    "#update-consultant"
  ].forEach(selector => {
    $(selector).addEventListener(
      "input",
      renderHistoricalEstimate
    );
  });

  $("#project-update-form")
    .addEventListener(
      "input",
      event => {
        if (!event.target.readOnly) {
          markUpdateDirty();
        }
      }
    );

  $("#add-mechanical-unit")
    .addEventListener(
      "click",
      () => {
        (
          state.updateUnits ??= []
        ).push({
          quantity: 1
        });

        markUpdateDirty();
        renderEquipmentEditors();
      }
    );

  $("#add-electrical-row")
    .addEventListener(
      "click",
      () => {
        (
          state.updatePanels ??= []
        ).push({
          quantity: 1
        });

        markUpdateDirty();
        renderEquipmentEditors();
      }
    );

  window.addEventListener(
    "beforeunload",
    event => {
      if (state.unsavedUpdate) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
  );
}


function loadProjectUpdate(id){const p=projects().find(project=>project.id===id);if(!p)return;state.updateUnits=JSON.parse(JSON.stringify(mechanical(p).units||[]));state.updatePanels=JSON.parse(JSON.stringify(electrical(p).panels||[]));state.unsavedUpdate=false;$('#update-project-id').value=p.id;$('#update-number').value=p.projectNumber||'';$('#update-name').value=p.projectName||'';$('#update-building-type').value=p.buildingType==='Unknown'?'':p.buildingType||'';$('#update-sf').value=p.squareFeet??'';$('#update-consultant').value=p.consultant==='Unknown'?'':p.consultant||'';$('#update-status').value=[...$('#update-status').options].some(o=>o.value===p.projectStatus)?p.projectStatus:'Other';$('#update-completion').value=p.completionDate||'';const m=mechanical(p),e=electrical(p);$('#update-tonnage').value=m.totals?.tonnage?.stated??m.totalTonnage??'';$('#update-system').value=m.primarySystemType||'';$('#update-manufacturer').value=m.manufacturer||'';$('#update-model').value=m.model||'';$('#update-duct').value=m.totalDuctFeet??'';$('#update-mech-notes').value=m.notes||'';$('#update-panels').value=e.panelCount??'';$('#update-service').value=e.serviceInfo||'';$('#update-elec-notes').value=e.notes||'';$('#update-entered-by').value='';$('#update-source').value=[...$('#update-source').options].some(o=>o.value===p.audit?.sourceType)?p.audit.sourceType:'Other';$('#update-excluded').checked=Boolean(p.excludedFromAnalysis);$('#project-update-form').classList.remove('hidden');$('#update-validation').classList.add('hidden');renderEquipmentEditors();renderHistoricalEstimate();renderTrustStatus()}
function currentUpdatePayload(){return{id:$('#update-project-id').value||null,projectNumber:$('#update-number').value,projectName:$('#update-name').value,buildingType:$('#update-building-type').value,squareFeet:$('#update-sf').value,consultant:$('#update-consultant').value,projectStatus:$('#update-status').value,completionDate:$('#update-completion').value,excludedFromAnalysis:$('#update-excluded').checked,mechanical:{totalTonnage:$('#update-tonnage').value,statedTonnage:$('#update-tonnage').value,totalChoice:$('#update-total-choice')?.value||'keep-recorded',correctedTonnage:$('#update-corrected-total')?.value,unitCount:$('#update-units').value,units:state.updateUnits||[],primarySystemType:$('#update-system').value,manufacturer:$('#update-manufacturer').value,model:$('#update-model').value,totalDuctFeet:$('#update-duct').value,notes:$('#update-mech-notes').value},electrical:{panelCount:$('#update-panels').value,panels:state.updatePanels||[],serviceInfo:$('#update-service').value,notes:$('#update-elec-notes').value},audit:{enteredBy:$('#update-entered-by').value,sourceType:$('#update-source').value}}}
function resetUpdateForm(){$('#project-update-form').reset();$('#update-project-id').value='';$('#project-update-form').classList.add('hidden');$('#update-validation').classList.add('hidden');$('#update-project-results').innerHTML='';$('#update-project-search').value='';state.updateUnits=[];state.updatePanels=[];state.unsavedUpdate=false;renderTrustStatus()}
function renderAll(){const label=state.data.isDemo?'Demonstration Data — Replace With Firm Spreadsheet':'Firm spreadsheet data active';$('#dataset-label').textContent=label;populateSelects();renderDashboard();renderProjects();renderConsultants();renderDataQuality();renderManagement();renderTrustStatus()}
function renderPreview(){const p=state.preview,s=previewSummary(),records=previewRecords(),showIssues=state.previewFilter==='issues',panel=$('#preview-panel');panel.classList.remove('hidden');panel.classList.add('active-step');panel.innerHTML=`<div class="step-heading"><span>3</span><div><h3>Review Records</h3><p>Confirm project blocks, recovered fields, totals, equipment rows, and interpreted notes before saving.</p></div></div><div class="import-summary">${[['Projects found',s.projects],['Equipment records',s.equipment],['Recovered SF',s.recoveredSquareFeet],['Recovered consultants',s.recoveredConsultants],['Existing error-sheet rows',s.errorRows],['New blocking issues',s.blocking],['New warnings',s.issueWarnings],['Total conflicts',s.conflictTotals],['Duplicate projects',s.duplicates],['Skipped rows',s.skipped]].map(([label,value])=>`<div><strong>${value}</strong><span>${label}</span></div>`).join('')}</div>${recoveryPreview(p.recoverySummary)}${conflictPreview(p.conflicts)}${p.projects.errors.length?`<div class="warning"><strong>Import notes:</strong> ${p.projects.errors.slice(0,4).map(esc).join(' · ')}</div>`:''}<div class="preview-tabs"><button data-preview-filter="first" class="${state.previewFilter==='first'?'active':''}">First 10</button><button data-preview-filter="warnings" class="${state.previewFilter==='warnings'?'active':''}">Records with issues</button><button data-preview-filter="issues" class="${state.previewFilter==='issues'?'active':''}">Imported error notes</button><button data-preview-filter="all" class="${state.previewFilter==='all'?'active':''}">Show all records</button></div>${showIssues?`<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Project</th><th>Discipline</th><th>Original note</th><th>Source row</th></tr></thead><tbody>${records.map(issue=>`<tr><td>${esc(issue.severity)}</td><td>${esc(issue.projectNumber||issue.projectName||'Not identified')}</td><td>${esc(issue.discipline)}</td><td>${esc(issue.originalText||issue.message)}</td><td>${number(issue.originalRow)}</td></tr>`).join('')||'<tr><td colspan="5">No ERRORS-sheet notes found.</td></tr>'}</tbody></table></div>`:`<div class="import-project-list">${records.map(importProjectCard).join('')||'<p>No projects match this review filter.</p>'}</div>`}<button id="continue-save" class="primary">Continue to save options</button>`;$$('[data-preview-filter]').forEach(button=>button.addEventListener('click',()=>{state.previewFilter=button.dataset.previewFilter;renderPreview()}));$$('[data-total-decision]').forEach(select=>select.addEventListener('change',()=>{const item=totalDecision(select.dataset.projectId,select.dataset.metric);item.decision=select.value;select.closest('.total-conflict').querySelector('.corrected-total').classList.toggle('hidden',select.value!=='corrected')}));$$('[data-corrected-total]').forEach(input=>input.addEventListener('input',()=>{totalDecision(input.dataset.projectId,input.dataset.metric).correctedValue=input.value}));$('#continue-save').addEventListener('click',showSaveOptions)}


// Past Projects: Mechanical / Electrical view switch

function renderProjectDisciplineSwitch() {
  let switcher = document.querySelector("#project-discipline-switch");

  if (!switcher) {
    switcher = document.createElement("div");
    switcher.id = "project-discipline-switch";
    switcher.className = "discipline-switch";

    const filters = document.querySelector("#past-projects .filters");

    if (filters) {
      filters.parentNode.insertBefore(switcher, filters);
    }
  }

  switcher.innerHTML = `
    <button
      type="button"
      class="${state.projectDiscipline === "mechanical" ? "active" : ""}"
      data-project-discipline="mechanical"
    >
      Mechanical
    </button>

    <button
      type="button"
      class="${state.projectDiscipline === "electrical" ? "active" : ""}"
      data-project-discipline="electrical"
    >
      Electrical
    </button>
  `;

  switcher
    .querySelectorAll("[data-project-discipline]")
    .forEach(button => {
      button.addEventListener("click", () => {
        state.projectDiscipline = button.dataset.projectDiscipline;
        state.expanded.clear();

        populateProjectDisciplineFilters();
        renderProjects();
      });
    });
}

function populateProjectDisciplineFilters() {
  const typeSelect = $("#filter-unit");
  const secondSelect = $("#filter-manufacturer");

  const typeLabel = typeSelect?.closest("label");
  const secondLabel = secondSelect?.closest("label");

  const previousType = typeSelect?.value || "";
  const previousSecond = secondSelect?.value || "";

  if (state.projectDiscipline === "electrical") {
    const panels = projects().flatMap(project => electrical(project).panels || []);

    const panelValues = unique(
      panels.flatMap(panel => [
        panel.type,
        panel.panelName,
        panel.name
      ])
    );

    const disconnectValues = unique(
      panels.flatMap(panel => [
        panel.disconnectName,
        Number.isFinite(panel.disconnectAmps)
          ? `${panel.disconnectAmps} A`
          : null
      ])
    );

    if (typeLabel) {
      typeLabel.childNodes[0].textContent = "Panel / Equipment ";
    }

    if (secondLabel) {
      secondLabel.childNodes[0].textContent = "Disconnect / Rating ";
    }

    populateSelect(typeSelect, panelValues, "All panels / equipment");
    populateSelect(secondSelect, disconnectValues, "All disconnects / ratings");
  } else {
    const units = allUnits();

    if (typeLabel) {
      typeLabel.childNodes[0].textContent = "HVAC System Type ";
    }

    if (secondLabel) {
      secondLabel.childNodes[0].textContent = "Manufacturer ";
    }

    populateSelect(
      typeSelect,
      units.map(unit => unit.normalizedType || unit.type),
      "All system types"
    );

    populateSelect(
      secondSelect,
      units.map(unit => unit.manufacturer),
      "All manufacturers"
    );
  }

  if ([...typeSelect.options].some(option => option.value === previousType)) {
    typeSelect.value = previousType;
  }

  if ([...secondSelect.options].some(option => option.value === previousSecond)) {
    secondSelect.value = previousSecond;
  }
}

function electricalProjectSummary(project) {
  const electricalData = electrical(project);
  const panels = electricalData.panels || [];

  const standaloneDisconnects =
    electricalData.disconnects || [];

  const panelLinkedDisconnects = panels
    .filter(
      panel =>
        panel.disconnectName ||
        Number.isFinite(panel.disconnectAmps)
    )
    .map(panel => ({
      disconnectName: panel.disconnectName,
      disconnectAmps: panel.disconnectAmps,
      quantity: panel.quantity || 1
    }));

  const disconnects = [
    ...standaloneDisconnects,
    ...panelLinkedDisconnects
  ];

  const disconnectNames = unique(
    disconnects
      .map(item => item.disconnectName)
      .filter(Boolean)
  );

  const disconnectAmps = disconnects
    .map(item => item.disconnectAmps)
    .filter(
      value =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        Number.isFinite(Number(value))
    )
    .map(Number);

  const panelAmps = panels
    .map(panel => panel.panelAmps)
    .filter(
      value =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        Number.isFinite(Number(value))
    )
    .map(Number);

  const loads = panels
    .map(panel => panel.panelLoadKva)
    .filter(
      value =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        Number.isFinite(Number(value))
    )
    .map(Number);

  const calculatedPanelCount = panels.length;

  return {
    panelCount:
      panels.length
        ? calculatedPanelCount
        : electrical(project).panelCount ?? null,

    disconnectCount: disconnects.reduce(
      (total, item) =>
        total + (Number(item.quantity) || 1),
      0
    ),

    disconnectAmpRange: disconnectAmps.length
      ? `${number(Math.min(...disconnectAmps))}–${number(
          Math.max(...disconnectAmps)
        )} A`
      : "Not recorded",

    panelAmpRange: panelAmps.length
      ? `${number(Math.min(...panelAmps))}–${number(
          Math.max(...panelAmps)
        )} A`
      : "Not recorded",

    totalLoadKva: loads.length ? sum(loads) : null,

    highestLoadKva: loads.length ? Math.max(...loads) : null
  };
}

function filteredProjects() {
  const query = $("#project-search").value.trim().toLowerCase();
  const buildingType = $("#filter-type").value;
  const consultant = $("#filter-consultant").value;
  const firstFilter = $("#filter-unit").value;
  const secondFilter = $("#filter-manufacturer").value;

  return projects().filter(project => {
    const searchMatch =
      !query ||
      `${project.projectNumber || ""} ${project.projectName || ""}`
        .toLowerCase()
        .includes(query);

    const typeMatch =
      !buildingType || project.buildingType === buildingType;

    const consultantMatch =
      !consultant ||
      analysis.consultantKey(project.consultant) ===
        analysis.consultantKey(consultant);

    if (!searchMatch || !typeMatch || !consultantMatch) {
      return false;
    }

    if (state.projectDiscipline === "electrical") {
      const panels = electrical(project).panels || [];

      const panelMatch =
        !firstFilter ||
        panels.some(panel =>
          [
            panel.type,
            panel.panelName,
            panel.name
          ].includes(firstFilter)
        );

      const disconnectMatch =
        !secondFilter ||
        panels.some(panel => {
          const ampLabel = Number.isFinite(panel.disconnectAmps)
            ? `${panel.disconnectAmps} A`
            : null;

          return (
            panel.disconnectName === secondFilter ||
            ampLabel === secondFilter
          );
        });

      return (
        hasElectrical(project) &&
        panelMatch &&
        disconnectMatch &&
        (!$("#filter-missing").checked || projectWarnings(project).length)
      );
    }

    const units = mechanical(project).units || [];

    return (
      hasMechanical(project) &&
      (!firstFilter ||
        units.some(
          unit =>
            (unit.normalizedType || unit.type) === firstFilter
        )) &&
      (!secondFilter ||
        units.some(unit => unit.manufacturer === secondFilter)) &&
      (!$("#filter-special").checked ||
        units.some(unit =>
          /custom|unusual/i.test(unit.classification || "")
        )) &&
      (!$("#filter-missing").checked || projectWarnings(project).length)
    );
  });
}

function renderProjects() {
  renderProjectDisciplineSwitch();

  const list = filteredProjects();
  const mechanicalMode = state.projectDiscipline === "mechanical";

  $("#project-count").textContent =
    `Showing ${list.length} of ${projects().length} projects`;

  if (!list.length) {
    $("#projects-table").innerHTML = `
      <div class="empty-state">
        No ${mechanicalMode ? "mechanical" : "electrical"} projects match the current filters.
      </div>
    `;
    return;
  }

  const disciplineColumns = mechanicalMode
    ? `
        <th>Tons</th>
        <th>HVAC Units</th>
        <th>Duct LF</th>
      `
    : `
        <th>Panels</th>
        <th>Disconnects</th>
        <th>Panel Amp Range</th>
      `;

  $("#projects-table").innerHTML = `
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Project</th>
          <th>Building Type</th>
          <th>Consultant</th>
          <th>SF</th>
          ${disciplineColumns}
          <th>Data Status</th>
        </tr>
      </thead>

      <tbody>
        ${list.map(projectRows).join("")}
      </tbody>
    </table>
  `;

 $$(
    ".expand-btn, .project-row-details"
  ).forEach(button => {
    button.addEventListener("click", () => {
      const id = button.dataset.id;

      state.expanded.has(id)
        ? state.expanded.delete(id)
        : state.expanded.add(id);

      renderProjects();
    });
  });

  $$("[data-project-consultant]").forEach(
    button => {
      button.addEventListener("click", event => {
        event.stopPropagation();

        const consultant =
          button.dataset.projectConsultant;

        if (!consultant) return;

        goTo("consultants");
        openConsultantProfile(consultant);
      });
    }
  );

  $$("[data-related-id]").forEach(button => {
    button.addEventListener("click", () => {
      openProject(button.dataset.relatedId);
    });
  });

  $$("[data-quality-project]").forEach(button => {
    button.addEventListener("click", () => {
      showProjectIssues(button.dataset.qualityProject);
    });
  });

  bindSquareFeetConflictActions();
  bindSquareFeetReopenActions();
}

function projectRows(project) {
  const open = state.expanded.has(project.id);
  const warnings = projectWarnings(project);
  const mechanicalMode =
    state.projectDiscipline === "mechanical";

  const mechanicalData = mechanical(project);
  const electricalData = electrical(project);
  const electricalSummary =
    electricalProjectSummary(project);

  const displayedSquareFeet =
    projectSquareFeetForCurrentView(project);

  const status = qualityStatus(project);

  const disciplineMetrics = mechanicalMode
    ? `
        <div class="project-row-metric">
          <span>HVAC capacity</span>
          <strong>
            ${
              Number.isFinite(
                Number(mechanicalData.totalTonnage)
              )
                ? `${number(
                    mechanicalData.totalTonnage,
                    1
                  )} tons`
                : "Not recorded"
            }
          </strong>
        </div>

        <div class="project-row-metric">
          <span>HVAC units</span>
          <strong>
            ${number(hvacUnitCount(project))}
          </strong>
        </div>

        <div class="project-row-metric">
          <span>Ductwork</span>
          <strong>
            ${
              Number.isFinite(
                Number(mechanicalData.totalDuctFeet)
              )
                ? `${number(
                    mechanicalData.totalDuctFeet
                  )} LF`
                : "Not recorded"
            }
          </strong>
        </div>
      `
    : `
        <div class="project-row-metric">
          <span>Panels</span>
          <strong>
            ${number(electricalSummary.panelCount)}
          </strong>
        </div>

        <div class="project-row-metric">
          <span>Disconnects</span>
          <strong>
            ${number(electricalSummary.disconnectCount)}
          </strong>
        </div>

        <div class="project-row-metric">
          <span>Panel range</span>
          <strong>
            ${esc(electricalSummary.panelAmpRange)}
          </strong>
        </div>
      `;

  const squareFeetDisplay =
    project.squareFeetSourceConflict &&
    project.squareFeetSourceConflict.discipline ===
      state.projectDiscipline
      ? `
          <span class="project-row-review-value">
            Review needed
          </span>

          <small>
            ${project.squareFeetSourceConflict.values
              .map(value => `${number(value)} SF`)
              .join(" or ")}
          </small>
        `
      : Number.isFinite(Number(displayedSquareFeet))
        ? `${number(displayedSquareFeet)} SF`
        : "Not recorded";

  return `
    <tr
      class="project-summary-row ${
        open ? "is-expanded" : ""
      }"
    >
      <td colspan="9">
        <article class="project-index-card">
          <button
            class="expand-btn project-index-toggle"
            type="button"
            data-id="${esc(project.id)}"
            aria-expanded="${open}"
            aria-label="${
              open
                ? "Collapse project"
                : "Expand project"
            }"
          >
            ${open ? "−" : "+"}
          </button>

          <div class="project-row-identity">
            <div class="project-row-title-line">
              <div>
                <strong class="project-row-title">
                  ${esc(project.projectName)}
                </strong>

                <div class="project-row-meta">
                  <span>
                    ${esc(
                      project.projectNumber ||
                      "No project number"
                    )}
                  </span>

                  <span>
                    ${esc(
                      project.buildingType ||
                      "Building type not recorded"
                    )}
                  </span>

                  <button
                    type="button"
                    class="project-row-consultant"
                    data-project-consultant="${esc(
                      project.consultant || ""
                    )}"
                    ${
                      !project.consultant ||
                      project.consultant === "Unknown"
                        ? "disabled"
                        : ""
                    }
                  >
                    ${esc(
                      project.consultant ||
                      "Consultant not recorded"
                    )}
                  </button>
                </div>
              </div>

              <div class="project-row-status">
                ${qualityBadge(project, true)}

                ${
                  project.squareFeetConflict ||
                  project.squareFeetSourceConflict
                    ? `
                      <span class="badge moderate">
                        SF conflict
                      </span>
                    `
                    : ""
                }
              </div>
            </div>

            <div class="project-row-metrics">
              <div class="project-row-metric">
                <span>Project size</span>
                <strong>
                  ${squareFeetDisplay}
                </strong>
              </div>

              ${disciplineMetrics}
            </div>
          </div>

          <button
            class="project-row-details"
            type="button"
            data-id="${esc(project.id)}"
            aria-expanded="${open}"
          >
            ${open ? "Close details" : "View details"}
            <span aria-hidden="true">
              ${open ? "↑" : "→"}
            </span>
          </button>
        </article>
      </td>
    </tr>

    ${
      open
        ? `
          <tr class="detail-row">
            <td colspan="9">
              ${
                mechanicalMode
                  ? mechanicalProjectDetail(
                      project,
                      warnings
                    )
                  : electricalProjectDetail(
                      project,
                      warnings
                    )
              }
            </td>
          </tr>
        `
        : ""
    }
  `;
}

function mechanicalProjectDetail(project, warnings) {
  const mechanicalData = mechanical(project);
  const units = mechanicalData.units || [];
  const phases =
    mechanicalData.phases || [];
  
  const phaseBreakdown = phases.length
    ? `
      <section class="phase=breakdown">
        <div class="phase-heading">
          <p class="kicker">
            Recorded project phases
          </p>
          
          <h3>Phase breakdown</h3>
          
          <p>
            Phase areas are supporting source details.
            They are not added together or substituted
            for the recorded overall project SF
          </p>
        </div>
        
        <div class="phase grid">
          ${phases
            .map(
              phase => `
                <article class="phase-card">
                  <h4>${esc(phase.name)}</h4>

                  <div class="phase-metrics">
                    <div>
                      <span>Recorded phase SF</span>
                      <strong>
                        ${
                          Number.isFinite(
                            Number(
                              phase.totalSquareFeet
                            )
                          )
                            ? `${number(
                                phase.totalSquareFeet
                              )} SF`
                            : "Not recorded"
                        }
                      </strong>
                    </div>

                    <div>
                      <span>Phase tonnage</span>
                      <strong>
                        ${
                          Number.isFinite(
                            Number(
                              phase.totalTonnage
                            )
                          )
                            ? `${number(
                                phase.totalTonnage,
                                1
                              )} tons`
                            : "Not recorded"
                        }
                      </strong>
                    </div>

                    <div>
                      <span>Phase ductwork</span>
                      <strong>
                        ${
                          Number.isFinite(
                            Number(
                              phase.totalDuctFeet
                            )
                          )
                            ? `${number(
                                phase.totalDuctFeet
                              )} LF`
                            : "Not recorded"
                        }
                      </strong>
                    </div>
                  </div>

                  ${
                    phase.components?.length
                      ? `
                        <div class="phase-components">
                          ${phase.components
                            .map(
                              component => `
                                <div>
                                  <span>
                                    ${esc(
                                      component.name
                                    )}
                                  </span>

                                  <strong>
                                    ${number(
                                      component.squareFeet
                                    )} SF
                                  </strong>
                                </div>
                              `
                            )
                            .join("")}
                        </div>
                      `
                      : `
                        <p class="source-note">
                          No component-level areas recorded.
                        </p>
                      `
                  }
                </article>
              `
            )
            .join("")}
        </div>
      </section>
      `
    : "";
        
  const unitRows = units.length
    ? units
        .map(
          unit => `
            <div class="unit-item">
              <span><strong>${esc(unit.name || "Unnamed")}</strong></span>
              <span>${number(unit.tonnage, 1)} tons</span>
              <span>${esc(unit.normalizedType || unit.type || "Not recorded")}</span>
              <span>${esc(unit.manufacturer || "Not recorded")}</span>
              <span>${esc(unit.model || "Not recorded")}</span>
              <span>Qty. ${number(unit.quantity || 1)}</span>
            </div>
          `
        )
        .join("")
    : "<p>No mechanical equipment detail recorded.</p>";

  const sourceConflict =
    project.squareFeetSourceConflict &&
    project.squareFeetSourceConflict.discipline === "mechanical" &&
    project.squareFeetSourceConflict.status !== "Resolved"
      ? project.squareFeetSourceConflict
      : null;

  const crossDisciplineConflict =
    !sourceConflict &&
    project.squareFeetConflict &&
    project.squareFeetConflict.status !== "Resolved" &&
    Number.isFinite(Number(project.squareFeetConflict.mechanical)) &&
    Number.isFinite(Number(project.squareFeetConflict.electrical))
      ? project.squareFeetConflict
      : null;

  const conflictValues = sourceConflict
    ? sourceConflict.values
    : crossDisciplineConflict
      ? [
          crossDisciplineConflict.mechanical,
          crossDisciplineConflict.electrical
        ]
      : [];

  const uniqueConflictValues = [
    ...new Set(
      conflictValues
        .map(Number)
        .filter(Number.isFinite)
    )
  ];

  const conflictPanel = uniqueConflictValues.length
    ? `
      <section class="sf-conflict-panel">
        <p class="kicker">Square Footage Review</p>

        <h3>Choose the correct project square footage</h3>

        <p>
          ${
            sourceConflict
              ? "The Mechanical workbook contains conflicting square-footage values."
              : "The Mechanical and Electrical workbooks contain different square-footage values."
          }
          Both original values will remain in the project history.
        </p>

        <div class="sf-conflict-options">
          ${uniqueConflictValues
            .map(
              value => `
                <label class="sf-option">
                  <input
                    type="radio"
                    name="sf-conflict-${esc(project.id)}"
                    value="${value}"
                  >
                  
                  <span>Use ${number(value)} SF</span>
                </label>
              `
            )
            .join("")}

          <label class="sf-option">
            <input
              type="radio"
              name="sf-conflict-${esc(project.id)}"
              value="custom"
            >
            
            <span>Enter a corrected value</span>
          </label>
            

          <input
            class="sf-corrected-value"
            data-sf-custom="${esc(project.id)}"
            type="number"
            min="1"
            step="1"
            placeholder="Correct square footage"
            disabled
          >
        </div>

        <div class="sf-conflict-actions">
          <button
            class="primary"
            data-resolve-sf="${esc(project.id)}"
          >
            Save square footage decision
          </button>
        </div>
      </section>
    `
    : "";

  return `
    <div class="project-detail">
      ${conflictPanel}

      ${
        Number.isFinite(
          Number(project.squareFeetResolution?.selectedValue)
        )
          ? `
            <div class="sf-resolution-summary">
              <span>
                Approved SF:
                <strong>
                  ${number(
                    Number(
                      project.squareFeetResolution.selectedValue
                    )
                  )} SF
                </strong>
              </span>

              <button
                class="secondary"
                data-reopen-sf="${esc(project.id)}"
              >
                Change SF decision
              </button>
            </div>
          `
          : ""
      }

      ${phaseBreakdown}

      <div class="detail-grid">
        <div>
          <span>Total tonnage</span>
          <strong>
            ${
              Number.isFinite(
                Number(mechanicalData.totalTonnage)
              )
                ? `${number(
                    mechanicalData.totalTonnage,
                    1
                  )} tons`
                : "Not recorded"
            }
          </strong>
        </div>

        <div>
          <span>HVAC units</span>
          <strong>
            ${number(hvacUnitCount(project))}
          </strong>
        </div>

        <div>
          <span>Ductwork</span>
          <strong>
            ${
              Number.isFinite(
                Number(mechanicalData.totalDuctFeet)
              )
                ? `${number(
                    mechanicalData.totalDuctFeet
                  )} LF`
                : "Not recorded"
            }
          </strong>
        </div>

        <div>
          <span>Consultant</span>
          <strong>
            ${esc(
              mechanicalData.consultant ??
              project.consultant ??
              "Not recorded"
            )}
          </strong>
        </div>
      </div>

      <h3>Mechanical equipment</h3>

      <div class="unit-list">
        ${unitRows}
      </div>

      ${availabilityHtml(project)}
    </div>
  `;
  }


function electricalProjectDetail(project, warnings) {
  const electricalData = electrical(project);
  const panels = electricalData.panels || [];
  const summary = electricalProjectSummary(project);

  const detailedRows = panels
    .map(
      panel => `
        <tr>
          <td>${esc(
            panel.panelName ||
              panel.name ||
              "Unnamed panel"
          )}</td>

          <td>${esc(panel.disconnectName || "Not recorded")}</td>

          <td>${
            Number.isFinite(panel.disconnectAmps)
              ? `${number(panel.disconnectAmps)} A`
              : "Not recorded"
          }</td>

          <td>${
            Number.isFinite(panel.panelLoadKva)
              ? number(panel.panelLoadKva, 2)
              : "Not recorded"
          }</td>

          <td>${
            Number.isFinite(panel.panelAmps)
              ? `${number(panel.panelAmps)} A`
              : "Not recorded"
          }</td>
        </tr>
      `
    )
    .join("");

  const sourceConflict =
    project.squareFeetSourceConflict &&
    project.squareFeetSourceConflict.discipline === "electrical" &&
    project.squareFeetSourceConflict.status !== "Resolved"
      ? project.squareFeetSourceConflict
      : null;

  const crossDisciplineConflict =
    !sourceConflict &&
    project.squareFeetConflict &&
    project.squareFeetConflict.status !== "Resolved" &&
    Number.isFinite(Number(project.squareFeetConflict.mechanical)) &&
    Number.isFinite(Number(project.squareFeetConflict.electrical))
      ? project.squareFeetConflict
      : null;

  const conflictValues = sourceConflict
    ? sourceConflict.values
    : crossDisciplineConflict
      ? [
          crossDisciplineConflict.mechanical,
          crossDisciplineConflict.electrical
        ]
      : [];

  const uniqueConflictValues = [
    ...new Set(
      conflictValues
        .map(Number)
        .filter(Number.isFinite)
    )
  ];

  const conflictPanel = uniqueConflictValues.length
    ? `
      <section class="sf-conflict-panel">
        <p class="kicker">Square Footage Review</p>

        <h3>Choose the correct project square footage</h3>

        <p>
          ${
            sourceConflict
              ? "The Electrical workbook contains conflicting square-footage values."
              : "The Mechanical and Electrical workbooks contain different square-footage values."
          }
          Both original values will remain in the project history.
        </p>

        <div class="sf-conflict-options">
          ${uniqueConflictValues
            .map(
              value => `

                <label class="sf-option">
                  <input
                    type="radio"
                    name="sf-conflict-${esc(project.id)}"
                    value="${value}"
                  >
                  
                  <span>Use ${number(value)} SF</span>
                </label>
              `
            )
            .join("")}

          <label class="sf-option">
            <input
              type="radio"
              name="sf-conflict-${esc(project.id)}"
              value="custom"
            >
            
            <span>Enter a corrected value</span>
          </label>

          <input
            class="sf-corrected-value"
            data-sf-custom="${esc(project.id)}"
            type="number"
            min="1"
            step="1"
            placeholder="Correct square footage"
            disabled
          >
        </div>

        <div class="sf-conflict-actions">
          <button
            class="primary"
            data-resolve-sf="${esc(project.id)}"
          >
            Save square footage decision
          </button>
        </div>
      </section>
    `
    : "";

  return `
    <div class="project-detail">
      ${conflictPanel}
      ${
        Number.isFinite(
          Number(project.squareFeetResolution?.selectedValue)
        )
          ? `
            <div class="sf-resolution-summary">
              <span>
                Approved SF:
                <strong>
                  ${number(
                    Number(
                      project.squareFeetResolution.selectedValue
                    )
                  )} SF
                </strong>
              </span>

              <button
                  class="secondary"
                  data-reopen-sf="${esc(project.id)}"
                >
                Change SF decision
              </button>
            </div>
          `
          : ""
      }




      <div class="electrical-summary-grid">
        <div class="electrical-summary-card">
          <span>Panels recorded</span>
          <strong>${number(summary.panelCount)}</strong>
        </div>

        <div class="electrical-summary-card">
          <span>Disconnect recorded</span>
          <strong>${number(summary.disconnectCount)}</strong>
        </div>

        <div class="electrical-summary-card">
          <span>Disconnect amp range</span>
          <strong>${summary.disconnectAmpRange}</strong>
        </div>

        <div class="electrical-summary-card">
          <span>Panel amp range</span>
          <strong>${summary.panelAmpRange}</strong>
        </div>

        <div class="electrical-summary-card">
          <span>Total recorded load</span>
          <strong>${
            Number.isFinite(summary.totalLoadKva)
              ? `${number(summary.totalLoadKva, 2)} kVA`
              : "Not recorded"
          }</strong>
        </div>

        <div class="electrical-summary-card">
          <span>Highest panel load</span>
          <strong>${
            Number.isFinite(summary.highestLoadKva)
              ? `${number(summary.highestLoadKva, 2)} kVA`
              : "Not recorded"
          }</strong>
        </div>
      </div>

      <details class="electrical-details">
        <summary>
          View electrical equipment details (${number(panels.length)})
        </summary>

        <div class="electrical-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Panel</th>
                <th>Disconnect</th>
                <th>Disconnect Amps</th>
                <th>Load (kVA)</th>
                <th>Panel Amps</th>
              </tr>
            </thead>

            <tbody>
              ${
                detailedRows ||
                `
                  <tr>
                    <td colspan="5">
                      No panel-level electrical detail recorded.
                    </td>
                  </tr>
                `
              }
            </tbody>
          </table>
        </div>
      </details>

      ${availabilityHtml(project)}
    </div>
  `;
}

function electricalPlanningSummary(comparableProjects) {
  const panels = comparableProjects.flatMap(
    project => electrical(project).panels || []
  );

  const panelAmps = panels
    .map(panel => Number(panel.panelAmps))
    .filter(Number.isFinite);

  const disconnectAmps = panels
    .map(panel => Number(panel.disconnectAmps))
    .filter(Number.isFinite);

  return {
    panelAmpRange: panelAmps.length
      ? `${number(Math.min(...panelAmps))}–${number(
          Math.max(...panelAmps)
        )} A`
      : "Not enough data",

    disconnectAmpRange: disconnectAmps.length
      ? `${number(Math.min(...disconnectAmps))}–${number(
          Math.max(...disconnectAmps)
        )} A`
      : "Not enough data"
  };
}

function renderEstimate() {
  const sf = Number($("#estimate-sf").value);
  const buildingType = $("#estimate-type").value;
  const consultant = $("#estimate-consultant").value;
  const scope = $("#estimate-scope").value;

  const comparable = comparableSet(
    buildingType,
    consultant,
    scope
  );

  const calc = calculateEstimate(comparable, sf);

  const usableCounts = [];

  if (scope !== "Electrical") {
    usableCounts.push(calc.mech.length);
  }

  if (scope !== "Mechanical") {
    usableCounts.push(calc.elec.length);
  }

  const usable = usableCounts.filter(Number.isFinite);
  const sample = usable.length ? Math.min(...usable) : 0;
  const confidenceLabel = confidence(sample, comparable.level);

  const ranked = analysis
    .rankSimilarProjects(projects(), {
      squareFeet: sf,
      buildingType,
      consultant,
      scope
    })
    .slice(0, 5);

  const topConsultants = topConsultantsFromRanked(ranked, 3);
  const electricalSummary =
    electricalPlanningSummary(comparable.list);

  const warnings = estimateWarnings(
    confidenceLabel,
    comparable,
    calc,
    scope
  );

  const metrics = [];

  if (scope !== "Electrical") {
    metrics.push(
      metric(
        `${number(calc.tonRange[0], 1)}–${number(
          calc.tonRange[1],
          1
        )} tons`,
        "Estimated HVAC tonnage range"
      )
    );

    metrics.push(
      metric(
        number(calc.unitCount),
        "Estimated HVAC units"
      )
    );

    metrics.push(
      metric(
        `${number(calc.duct)} ft`,
        "Estimated ductwork"
      )
    );
  }

  if (scope !== "Mechanical") {
    metrics.push(
      metric(
        Number.isFinite(calc.panels)
          ? `${number(calc.panelRange[0])}–${number(
              calc.panelRange[1]
            )}`
          : "Not enough data",
        "Estimated electrical panels"
      )
    );

    metrics.push(
      metric(
        electricalSummary.panelAmpRange,
        "Observed panel amp range"
      )
    );

    metrics.push(
      metric(
        electricalSummary.disconnectAmpRange,
        "Observed disconnect amp range"
      )
    );
  }

  // Always show historical consultant context.
  metrics.push(
    consultantMetric(topConsultants)
  );

  $("#estimate-results").className = "estimate-results";

  $("#estimate-results").innerHTML = `
    <section class="estimate-hero">
      <div class="estimate-hero-header">
        <div>
          <p class="kicker">Preliminary planning range</p>

          <h3>
            ${number(sf)} SF ${esc(buildingType || "project")}
          </h3>

          <p>
            Based on ${number(comparable.list.length)}
            comparable SGA project${comparable.list.length === 1 ? "" : "s"}.
          </p>
        </div>

        <span class="badge ${confidenceLabel.toLowerCase()}">
          ${confidenceLabel} confidence
        </span>
      </div>

      <div class="estimate-summary">
        ${metrics.join("")}
      </div>

      ${warnings
        .map(warning => `<div class="warning">${esc(warning)}</div>`)
        .join("")}

      <details class="calculation-details">
        <summary>How this estimate was calculated</summary>

        <div class="detail-content">
          ${calculationDetails(
            comparable,
            calc,
            sf,
            scope
          )}

          ${
            scope !== "Mechanical"
              ? `
                <p>
                  <strong>Electrical ranges:</strong>
                  Panel and disconnect amperage ranges are observed
                  values from the comparable historical projects.
                  They are not engineering selections.
                </p>
              `
              : ""
          }
        </div>
      </details>
    </section>

    ${precedentSection(ranked)}
    ${similarConsultantsSection(comparable.list)}
  `;

  bindEstimateInteractions();
  showPlanningRangeOnly();
}

// Consultants: Mechanical / Electrical comparison switch

function renderConsultantDisciplineSwitch() {
  let switcher = document.querySelector("#consultant-discipline-switch");

  if (!switcher) {
    switcher = document.createElement("div");
    switcher.id = "consultant-discipline-switch";
    switcher.className = "discipline-switch";

    const consultantGrid = document.querySelector("#consultant-cards");

    if (consultantGrid) {
      consultantGrid.parentNode.insertBefore(switcher, consultantGrid);
    }
  }

  switcher.innerHTML = `
    <button
      type="button"
      class="${state.consultantDiscipline === "mechanical" ? "active" : ""}"
      data-consultant-discipline="mechanical"
    >
      Mechanical
    </button>

    <button
      type="button"
      class="${state.consultantDiscipline === "electrical" ? "active" : ""}"
      data-consultant-discipline="electrical"
    >
      Electrical
    </button>
  `;

  switcher
    .querySelectorAll("[data-consultant-discipline]")
    .forEach(button => {
      button.addEventListener("click", () => {
        state.consultantDiscipline =
          button.dataset.consultantDiscipline;

        document
          .querySelector("#comparison-mode")
          ?.classList.add("hidden");

        renderConsultants();
      });
    });
}

function consultantElectricalStats(name) {
  const all = projects().filter(
    project =>
      analysis.consultantKey(project.consultant) ===
      analysis.consultantKey(name)
  );

  const list = all.filter(
    project =>
      hasElectrical(project) &&
      !project.excludedFromAnalysis &&
      !project.dataAvailability?.globallyExcluded
  );

  const panels = list.flatMap(
    project => electrical(project).panels || []
  );


  const disconnects = list.flatMap(project => {
    const electricalData = electrical(project);

    const standalone =
      electricalData.disconnects || [];

    const panelLinked = (
      electricalData.panels || []
    )
      .filter(
        panel =>
          panel.disconnectName ||
          Number.isFinite(panel.disconnectAmps)
      )
      .map(panel => ({
        disconnectName: panel.disconnectName,
        disconnectAmps: panel.disconnectAmps,
        quantity: panel.quantity || 1
      }));

    return [...standalone, ...panelLinked];
  });

  const panelCounts = list
    .map(project => electrical(project).panelCount)
    .filter(Number.isFinite);

  const panelAmps = panels
    .map(panel => Number(panel.panelAmps))
    .filter(Number.isFinite);

  const disconnectAmps = disconnects
    .map(item => Number(item.disconnectAmps))
    .filter(Number.isFinite);

  const loads = panels
    .map(panel => Number(panel.panelLoadKva))
    .filter(Number.isFinite);

  const disconnectNames = unique(
    disconnects.map(item => item.disconnectName)
  );

  return {
    name,
    all,
    list,

    projectCount: all.length,
    usableCount: list.length,

    types: unique(all.map(project => project.buildingType)),

    medianProjectSf: median(
      list.map(project => project.squareFeet)
    ),

    averagePanels: average(panelCounts),

    medianPanels: median(panelCounts),

    panelAmpRange: panelAmps.length
      ? `${number(Math.min(...panelAmps))}–${number(
          Math.max(...panelAmps)
        )} A`
      : "Insufficient data",

    disconnectAmpRange: disconnectAmps.length
      ? `${number(Math.min(...disconnectAmps))}–${number(
          Math.max(...disconnectAmps)
        )} A`
      : "Insufficient data",

    medianLoadKva: median(loads),

    disconnectTypes: disconnectNames.slice(0, 3),

    missing:
      all.length - list.length
  };
}


function electricalConsultantCard(stats) {
  const lowConfidence = stats.usableCount < 2;

  const representedSquareFeet = sum(
    stats.all
      .map(project => Number(project.squareFeet))
      .filter(Number.isFinite)
  );

  const recentProject = [...stats.all]
    .sort((a, b) =>
      String(b.projectNumber || "").localeCompare(
        String(a.projectNumber || "")
      )
    )[0];

  const initials = stats.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();

  return `
    <article class="consultant-card">
      <header class="consultant-card-header">
        <div class="consultant-card-identity">
          <div class="consultant-initials">
            ${esc(initials || "MEP")}
          </div>

          <div>
            <h3>${esc(stats.name)}</h3>

            <p class="sample-note">
              ${number(stats.projectCount)}
              project${stats.projectCount === 1 ? "" : "s"} represented

              ${
                lowConfidence
                  ? " · Low-confidence electrical sample"
                  : ""
              }
            </p>
          </div>
        </div>

        <label class="consultant-compare">
          <input
            class="consultant-select"
            type="checkbox"
            value="${esc(stats.name)}"
          >
          Compare
        </label>
      </header>

      <div class="consultant-overview">
        <div class="consultant-overview-block">
          <span>Portfolio represented</span>

          <strong>
            ${
              representedSquareFeet > 0
                ? `${compactNumber(
                    representedSquareFeet
                  )} SF`
                : "Not recorded"
            }
          </strong>
        </div>

        <div class="consultant-overview-block">
          <span>Most recent project</span>

          <strong>
            ${esc(
              recentProject?.projectName ||
              "Not recorded"
            )}
          </strong>
        </div>
      </div>

      <div class="consultant-patterns">
        <div>
          <span>Typical building types</span>

          <p>
            ${esc(
              stats.types.slice(0, 3).join(", ") ||
              "Not recorded"
            )}
          </p>
        </div>

        <div>
          <span>Recorded disconnects</span>

          <p>
            ${esc(
              stats.disconnectTypes
                .slice(0, 3)
                .join(", ") ||
              "Insufficient data"
            )}
          </p>
        </div>

        <div>
          <span>Electrical data coverage</span>

          <p>
            ${
              stats.missing
                ? `${number(stats.missing)} project${
                    stats.missing === 1 ? "" : "s"
                  } without usable electrical data`
                : "All represented projects have usable electrical data"
            }
          </p>
        </div>
      </div>

      <div class="consultant-metrics">
        <div class="consultant-metric">
          <span>Median project SF</span>
          <strong>${number(stats.medianProjectSf)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Average panels</span>
          <strong>${number(stats.averagePanels, 1)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Median panels</span>
          <strong>${number(stats.medianPanels, 1)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Panel amp range</span>
          <strong>${esc(stats.panelAmpRange)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Disconnect amp range</span>
          <strong>${esc(stats.disconnectAmpRange)}</strong>
        </div>

        <div class="consultant-metric">
          <span>Median recorded load</span>
          <strong>
            ${
              Number.isFinite(stats.medianLoadKva)
                ? `${number(
                    stats.medianLoadKva,
                    2
                  )} kVA`
                : "Insufficient data"
            }
          </strong>
        </div>
      </div>

      <div class="card-actions">
        <button
          class="secondary"
          type="button"
          data-consultant-profile="${esc(stats.name)}"
        >
          View Profile
        </button>

        <button
          class="text-button"
          type="button"
          data-consultant-projects="${esc(stats.name)}"
        >
          View Projects →
        </button>
      </div>
    </article>
  `;
}
function renderConsultants() {
  renderConsultantDisciplineSwitch();

  const names = unique(
    projects()
      .map(project => project.consultant)
      .filter(
        consultant =>
          consultant &&
          consultant !== "Unknown"
      )
  );

  const cards =
    state.consultantDiscipline === "electrical"
      ? names.map(name =>
          electricalConsultantCard(
            consultantElectricalStats(name)
          )
        )
      : names.map(name =>
          consultantCard(
            consultantStats(name)
          )
        );

  $("#consultant-cards").innerHTML =
    cards.join("") ||
    `
      <div class="empty-state">
        No consultant records are active.
      </div>
    `;

  $$("[data-consultant-profile]").forEach(button => {
    button.addEventListener("click", () => {
      openConsultantProfile(
        button.dataset.consultantProfile
      );
    });
  });

  $$("[data-consultant-projects]").forEach(button => {
    button.addEventListener("click", () => {
      showConsultantProjects(
        button.dataset.consultantProjects
      );
    });
  });
}
function renderComparisonResults(selected) {
  if (selected.length < 2) {
    $("#comparison-table-wrap").innerHTML = `
      <div class="empty-state">
        Select at least two consultants.
      </div>
    `;

    $("#tendencies").innerHTML = "";
    return;
  }

  if (state.consultantDiscipline === "electrical") {
    const stats = selected.map(consultantElectricalStats);

    const rows = [
      [
        "Projects represented",
        statsItem => statsItem.projectCount
      ],
      [
        "Usable electrical projects",
        statsItem => statsItem.usableCount
      ],
      [
        "Building types",
        statsItem =>
          esc(
            statsItem.types.join(", ") ||
            "Not recorded"
          )
      ],
      [
        "Median project SF",
        statsItem =>
          number(statsItem.medianProjectSf)
      ],
      [
        "Average panels",
        statsItem =>
          number(statsItem.averagePanels, 1)
      ],
      [
        "Median panels",
        statsItem =>
          number(statsItem.medianPanels, 1)
      ],
      [
        "Panel amp range",
        statsItem =>
          statsItem.panelAmpRange
      ],
      [
        "Disconnect amp range",
        statsItem =>
          statsItem.disconnectAmpRange
      ],
      [
        "Median recorded load",
        statsItem =>
          Number.isFinite(statsItem.medianLoadKva)
            ? `${number(statsItem.medianLoadKva, 2)} kVA`
            : "Insufficient data"
      ],
      [
        "Observed disconnects",
        statsItem =>
          esc(
            statsItem.disconnectTypes.join(", ") ||
            "Insufficient data"
          )
      ]
    ];

    $("#comparison-table-wrap").innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Recorded electrical measure</th>

            ${stats
              .map(
                statsItem =>
                  `<th>${esc(statsItem.name)}</th>`
              )
              .join("")}
          </tr>
        </thead>

        <tbody>
          ${rows
            .map(
              ([label, getValue]) => `
                <tr>
                  <th>${label}</th>

                  ${stats
                    .map(
                      statsItem =>
                        `<td>${getValue(statsItem)}</td>`
                    )
                    .join("")}
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;

    $("#tendencies").innerHTML = stats
      .map(
        statsItem => `
          <article class="tendency">
            <p>
              <strong>${esc(statsItem.name)}</strong><br>

              ${
                statsItem.usableCount < 2
                  ? `
                    Only ${number(statsItem.usableCount)}
                    usable electrical project is represented.
                    No company-wide tendency should be inferred.
                  `
                  : `
                    Historically represented on
                    ${number(statsItem.usableCount)}
                    usable electrical projects.
                    Average recorded panel count:
                    ${number(statsItem.averagePanels, 1)}.
                  `
              }

              <br>
              <em>
                This is historical project context,
                not a performance ranking or fee recommendation.
              </em>
            </p>
          </article>
        `
      )
      .join("");

    return;
  }

  // Preserve the existing mechanical comparison.
  const stats = selected.map(consultantStats);

  const rows = [
    ["Projects represented", item => item.list.length],
    [
      "Building types",
      item => esc(item.types.join(", ") || "Not recorded")
    ],
    ["Median project SF", item => number(item.medSf)],
    [
      "Median HVAC tonnage",
      item => number(item.medTon, 1)
    ],
    [
      "Median SF per ton",
      item =>
        item.list.length >= 2
          ? number(item.sfTon)
          : "Insufficient data"
    ],
    [
      "Average HVAC units",
      item => number(item.unitCount, 1)
    ],
    [
      "Observed systems",
      item =>
        esc(item.systems.join(", ") || "Insufficient data")
    ],
    [
      "Observed manufacturers",
      item =>
        esc(
          item.manufacturers.join(", ") ||
          "Insufficient data"
        )
    ]
  ];

  $("#comparison-table-wrap").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Recorded mechanical measure</th>

          ${stats
            .map(item => `<th>${esc(item.name)}</th>`)
            .join("")}
        </tr>
      </thead>

      <tbody>
        ${rows
          .map(
            ([label, getValue]) => `
              <tr>
                <th>${label}</th>

                ${stats
                  .map(
                    item =>
                      `<td>${getValue(item)}</td>`
                  )
                  .join("")}
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;

  $("#tendencies").innerHTML = stats
    .map(
      item => `
        <article class="tendency">
          <p>
            <strong>${esc(item.name)}</strong><br>

            ${
              item.list.length < 2
                ? `
                  Only one usable mechanical project is represented.
                `
                : `
                  Historically represented on
                  ${item.list.length} usable mechanical projects.
                `
            }

            <br>
            <em>
              This is historical project context,
              not a performance ranking.
            </em>
          </p>
        </article>
      `
    )
    .join("");
}
function projectSquareFeetForCurrentView(project) {
  const sourceConflict =
    project.squareFeetSourceConflict &&
    project.squareFeetSourceConflict.status !== "Resolved" &&
    project.squareFeetSourceConflict.discipline ===
      state.projectDiscipline
      ? project.squareFeetSourceConflict
      : null;

  if (sourceConflict) {
    return null;
  }

  if (state.projectDiscipline === "electrical") {
    return (
      electrical(project).squareFeet ??
      project.squareFeet
    );
  }

  return (
    mechanical(project).squareFeet ??
    project.squareFeet
  );
}


/* =========================================================
   PAST PROJECTS — DELETE PROJECT
   ========================================================= */

/*
 * Preserve the existing project-detail renderer,
 * then add a Delete Project section to the bottom.
 */
function mountDeleteProjectButtons() {
  const table = document.querySelector(
    "#projects-table"
  );

  if (!table) return;

  const detailPanels = table.querySelectorAll(
    ".project-detail"
  );

  detailPanels.forEach(detailPanel => {
    if (
      detailPanel.querySelector(
        "[data-delete-project]"
      )
    ) {
      return;
    }

    let projectId = "";

    /*
     * Original table layout:
     * expanded details are in the row immediately
     * after the row containing the expand button.
     */
    const detailRow =
      detailPanel.closest(".detail-row");

    if (detailRow) {
      projectId =
        detailRow.previousElementSibling
          ?.querySelector(".expand-btn")
          ?.dataset.id || "";
    }

    /*
     * Newer card layout:
     * header and details may share one card.
     */
    if (!projectId) {
      const containingCard =
        detailPanel.closest(
          "article, .project-card, .project-row, .project-list-item"
        );

      projectId =
        containingCard
          ?.querySelector(".expand-btn")
          ?.dataset.id || "";
    }

    /*
     * Final fallback: find the closest expanded
     * button preceding this detail panel.
     */
    if (!projectId) {
      const expandedButtons = [
        ...table.querySelectorAll(
          '.expand-btn[aria-expanded="true"]'
        )
      ];

      const precedingButton =
        expandedButtons
          .filter(button =>
            Boolean(
              button.compareDocumentPosition(
                detailPanel
              ) &
                Node.DOCUMENT_POSITION_FOLLOWING
            )
          )
          .at(-1);

      projectId =
        precedingButton?.dataset.id || "";
    }

    if (!projectId) return;

    const project = projects().find(
      item =>
        String(item.id) ===
        String(projectId)
    );

    if (!project) return;

    const deleteSection =
      document.createElement("section");

    deleteSection.className =
      "project-delete-section";

    deleteSection.innerHTML = `
      <div class="project-delete-copy">
        <p class="kicker">
          Project administration
        </p>

        <h3>Delete this project</h3>

        <p>
          Permanently remove this project, its MEP
          records, and its related Data Review issues.
          Future Excel downloads will no longer include it.
        </p>
      </div>

      <button
        type="button"
        class="delete-project-button"
        data-delete-project="${esc(project.id)}"
      >
        Delete project
      </button>
    `;

    detailPanel.appendChild(
      deleteSection
    );
  });
}


/*
 * Run after Past Projects is rendered or rerendered.
 */
const pastProjectsObserver =
  new MutationObserver(() => {
    requestAnimationFrame(
      mountDeleteProjectButtons
    );
  });

const projectsTable =
  document.querySelector(
    "#projects-table"
  );

if (projectsTable) {
  pastProjectsObserver.observe(
    projectsTable,
    {
      childList: true,
      subtree: true
    }
  );

  mountDeleteProjectButtons();
}


/*
 * Event delegation works even though project details
 * are recreated whenever filters or rows change.
 */
document.addEventListener(
  "click",
  async event => {
    const button =
      event.target.closest(
        "[data-delete-project]"
      );

    if (!button) return;

    const projectId =
      button.dataset.deleteProject;

    const project = projects().find(
      item =>
        String(item.id) ===
        String(projectId)
    );

    if (!project) {
      toast(
        "The project could not be found."
      );

      return;
    }

    const projectLabel = [
      project.projectNumber,
      project.projectName
    ]
      .filter(Boolean)
      .join(" — ");

    const confirmed =
      window.confirm(
        `Delete ${projectLabel}?\n\n` +
        `This removes the project, its mechanical and ` +
        `electrical records, and its related Data Review ` +
        `issues.\n\n` +
        `It will also be removed from future Excel ` +
        `downloads.\n\n` +
        `This action cannot be undone from this screen.`
      );

    if (!confirmed) return;

    const originalText =
      button.textContent;

    button.disabled = true;
    button.textContent =
      "Deleting...";

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(
          projectId
        )}`,
        {
          method: "DELETE"
        }
      );

      const responseText =
        await response.text();
      
      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error(
          response.status === 404
          ?"Delete route was not found. Restart the server and try again."
          : `The server returned an invalid response (${response.status}).`
        );
      }

      

      state.data = result.data;

      state.expanded.delete(
        projectId
      );

      /*
       * Refresh every page using the returned
       * current dataset.
       */
      renderAll();

      toast(
        result.message ||
        "Project deleted."
      );

      if (result.masterWarning) {
        toast(result.masterWarning);
      }
    } catch (error) {
      console.error(error);

      toast(
        error.message ||
        "Project could not be deleted."
      );

      button.disabled = false;
      button.textContent =
        originalText;
    }
  }
);