const UNKNOWN_PATTERNS = [
  /^\?+$/, /^-+$/, /^tbd\.?$/i, /^n\/?a\.?$/i, /^unknown$/i, /^not known$/i,
  /^not sure(?: yet)?$/i, /^to be confirmed$/i, /^not shown$/i, /^not provided$/i,
  /^not found$/i, /^no file$/i, /^no mechanical cd$/i, /^no electrical cd$/i
];

const TOTAL_LABELS = [
  'total','project total','total tonnage','combined tonnage','grand total',
  'total lf','total linear feet','total panels','subtotal'
];

const TYPE_RULES = [
  { pattern: /\bRTU(?:\b|[-_\d])/i, normalized:'Packaged rooftop unit', code:'RTU' },
  { pattern: /\bAHU(?:\b|[-_\d])/i, normalized:'Air-handling unit', code:'AHU' },
  { pattern: /\bFCU(?:\b|[-_\d])/i, normalized:'Fan-coil unit', code:'FCU' },
  { pattern: /\bCU(?:\b|[-_\d])/i, normalized:'Condensing unit', code:'CU' },
  { pattern: /\bHP(?:\b|[-_\d])/i, normalized:'Heat pump', code:'HP' },
  { pattern: /\bDOAS(?:\b|[-_\d])/i, normalized:'Dedicated outdoor-air system', code:'DOAS' },
  { pattern: /\bMAU(?:\b|[-_\d])/i, normalized:'Make-up air unit', code:'MAU' },
  { pattern: /\bVAV(?:\b|[-_\d])/i, normalized:'Variable-air-volume terminal', code:'VAV' },
  { pattern: /\bEF(?:\b|[-_\d])/i, normalized:'Exhaust fan', code:'EF' },
  { pattern: /\bERV(?:\b|[-_\d])/i, normalized:'Energy-recovery ventilator', code:'ERV' },
  { pattern: /\b(?:VRF|VRV)(?:\b|[-_\d])/i, normalized:'Variable-refrigerant-flow system', code:'VRF / VRV' },
  { pattern: /\bmini[- ]?split\b/i, normalized:'Split system', code:'Mini-split' },
  { pattern: /\bsplit\b/i, normalized:'Split system', code:'Split' }
];

function cleaned(value){return String(value??'').trim().replace(/\s+/g,' ')}
function normalizedLabel(value){return cleaned(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function isUnknownValue(value){const text=cleaned(value);return Boolean(text)&&UNKNOWN_PATTERNS.some(pattern=>pattern.test(text))}
function isTotalLabel(value){const label=normalizedLabel(value);return TOTAL_LABELS.some(total=>label===total||label.startsWith(`${total} `))}

function normalizeEquipmentType(originalType,tag){
  const original=cleaned(originalType)||null,source=[original,cleaned(tag)].filter(Boolean).join(' ');
  const match=TYPE_RULES.find(rule=>rule.pattern.test(source));
  return { originalType:original, normalizedType:match?.normalized||original||null, matchedCode:match?.code||null, method:match?'normalized label':(original?'direct mapped field':'not recorded') };
}

function suggestion(field,value,confidence,reason){return{field,value,label:'Suggested from note',confidence,reason,reviewStatus:'Pending review',accepted:false}}
function interpretedIssue(category,severity,message){return{category,severity,message}}

function interpretNote(originalText,context={}){
  const text=cleaned(originalText),lower=text.toLowerCase(),suggestions=[],issues=[];
  if(!text)return null;
  if(/\bvav\b/i.test(text))suggestions.push(suggestion('systemType','Variable air volume','High','The note explicitly mentions VAV.'));
  if(/\bair[- ]?handler|\bahu(?:\b|[-_\d])/i.test(text))suggestions.push(suggestion('equipmentType','Air-handling unit','High','The note explicitly identifies air-handler equipment.'));
  if(/\brtu(?:\b|[-_\d])/i.test(text))suggestions.push(suggestion('equipmentType','Packaged rooftop unit','High','The note explicitly identifies RTU equipment.'));
  const countMatch=text.match(/\b(\d+)\s+(?:existing\s+)?(?:rtu|ahu|fcu|unit|units)\b/i);if(countMatch)suggestions.push(suggestion('unitCount',Number(countMatch[1]),'Moderate','A quantity appears directly before an equipment abbreviation.'));
  if(/\bexisting\b/i.test(text))suggestions.push(suggestion('existingCondition',true,'High','The note explicitly says existing.'));
  if(/no mechanical (?:cd|construction documents?)|no mechanical .*server|missing mechanical drawings?/i.test(lower))issues.push(interpretedIssue('Missing mechanical drawings','Blocking','Mechanical source documents are reported missing.'));
  if(/no electrical (?:cd|construction documents?)|no electrical .*server|missing electrical drawings?/i.test(lower))issues.push(interpretedIssue('Missing electrical drawings','Blocking','Electrical source documents are reported missing.'));
  if(/no file(?: found)?(?: on (?:the )?server)?/i.test(lower))issues.push(interpretedIssue('No file found on server','Blocking','The source file is reported missing.'));
  if(/equipment schedule only|partial equipment schedule|only provided for/i.test(lower))issues.push(interpretedIssue('Incomplete consultant set','Warning','The note indicates a partial equipment schedule.'));
  if(/square footage (?:is )?not shown|no (?:overall )?(?:sf|square footage)/i.test(lower))issues.push(interpretedIssue('Square footage not shown','Blocking','Project square footage is reported as unavailable.'));
  const confidence=issues.some(issue=>issue.severity==='Blocking')?'High':suggestions.length?'Moderate':'Low';
  return{originalText:text,projectId:context.projectId||null,projectNumber:context.projectNumber||null,projectName:context.projectName||null,discipline:context.discipline||'General',sourceWorkbook:context.sourceWorkbook||null,sourceSheet:context.sourceSheet||null,sourceRow:context.sourceRow||null,suggestedInterpretations:suggestions,issues,confidence,reviewStatus:suggestions.length||issues.length?'Pending review':'Informational',interpretationMethod:'deterministic note rules'};
}

module.exports={UNKNOWN_PATTERNS,TOTAL_LABELS,TYPE_RULES,cleaned,normalizedLabel,isUnknownValue,isTotalLabel,normalizeEquipmentType,interpretNote};
