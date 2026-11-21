mountChrome('');
const byId = id => document.getElementById(id);
const sample = 'Fictional visit summary\nAssessment: Type 2 diabetes mellitus.\nPlan: Continue current medications and repeat A1C at next visit.';
const patterns = [
  ['Type 2 diabetes', /\b(?:type (?:2|II) diabetes(?: mellitus)?|diabetes mellitus(?:,? type (?:2|II))|T2DM)\b/i],
  ['Type 1 diabetes', /\b(?:type (?:1|I) diabetes(?: mellitus)?|T1DM)\b/i],
  ...['Breast cancer','Lung cancer','Prostate cancer','Colorectal cancer','Asthma','Hypertension','Long COVID','Multiple sclerosis','Rheumatoid arthritis','Crohn’s disease','Heart failure','Chronic kidney disease'].map(term => [term,new RegExp('\\b'+term.replace('’', "['’]?")+'\\b','i')])
];
let revision = 0, controller, token, searched, shown;
function stopSearch() {
  controller?.abort();
  controller = null;
  byId('results').hidden = true;
  byId('cards').replaceChildren();
  byId('message').textContent = '';
  token = ''; shown = 0;
}
function reset() {
  revision++; stopSearch();
  for (const id of ['condition','paste','file']) byId(id).value = '';
  byId('mentions').replaceChildren();
  byId('pasteBox').hidden = byId('review').hidden = true;
  byId('intake').hidden = false;
}
function review(text) {
  if (!text.trim()) throw new Error('No readable text found. Paste text from the record or choose a text-based PDF.');
  if (text.length > 200000) throw new Error('Choose a shorter excerpt of up to 200,000 characters.');
  const lines = text.split(/[\n.!?]+/).map(line => line.trim()).filter(Boolean);
  const mentions = byId('mentions');
  mentions.replaceChildren();
  byId('condition').value = '';
  for (const [term, pattern] of patterns) {
    const line = lines.find(value => pattern.test(value));
    if (!line) continue;
    const position = line.search(pattern);
    const excerpt = line.slice(Math.max(0, position-75),position+125);
    const button = document.createElement('button');
    button.className = 'mention';
    button.textContent = term;
    button.setAttribute('aria-pressed','false');
    const quote = document.createElement('small');
    quote.textContent = '“'+excerpt+'”';
    button.append(quote);
    button.onclick = () => {
      stopSearch();
      for (const item of mentions.children) item.setAttribute('aria-pressed',String(item === button));
      byId('condition').value = term;
    };
    mentions.append(button);
  }
  byId('reviewNote').textContent = mentions.childElementCount ? 'Select a mention only if it applies to you. Records may also mention family history or conditions that were ruled out. You can enter another condition below.' : 'Enter the condition you want to search. Northstar couldn’t identify a familiar condition in this record.';
  byId('paste').value = byId('file').value = '';
  byId('message').textContent = '';
  byId('review').hidden = false; byId('intake').hidden = true;
  byId('review').querySelector('h2').focus();
}
async function readPdf(file) {
  const pdf = await import('./pdfjs/pdf.min.mjs');
  pdf.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const task = pdf.getDocument({data:await file.arrayBuffer(),isEvalSupported:false,useSystemFonts:false});
  try {
    const doc = await task.promise;
    if (doc.numPages > 50) throw new Error('Choose a PDF of 50 pages or fewer.');
    let text = '';
    for (let n=1;n<=doc.numPages;n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      text += content.items.map(item => (item.str ?? '')+(item.hasEOL?'\n':' ')).join('')+'\n';
      if (text.length > 200000) throw new Error('Choose a shorter record.');
    }
    return text;
  } finally { await task.destroy(); }
}
async function readFile(files) {
  const current = ++revision;
  try {
    if (files.length !== 1) throw new Error('Choose one record at a time.');
    const file = files[0];
    if (file.size > 5000000) throw new Error('Choose a file smaller than 5 MB.');
    byId('message').textContent = 'Reading on your device…';
    let text;
    if (/\.pdf$/i.test(file.name)) text = await readPdf(file);
    else if (/\.txt$/i.test(file.name)) text = await file.text();
    else throw new Error('Choose a PDF or TXT file, or paste your text.');
    if (revision === current) review(text);
  } catch (error) {
    if (revision === current) byId('message').textContent = /^(Choose|No readable)/.test(error.message) ? error.message : 'This file could not be read. Try an unlocked, text-based PDF or paste the text.';
  } finally { if (revision === current) byId('file').value = ''; }
}
byId('choose').onclick = () => byId('file').click();
byId('file').onchange = e => readFile(e.target.files);
const drop = byId('drop');
for (const type of ['dragover','dragleave','drop']) drop.addEventListener(type,e => {
  e.preventDefault(); drop.classList.toggle('over',type==='dragover');
  if(type==='drop') readFile(e.dataTransfer.files);
});
byId('pasteBtn').onclick = () => { revision++; byId('message').textContent=''; byId('pasteBox').hidden=false; byId('paste').focus(); };
byId('read').onclick = () => { try { review(byId('paste').value); } catch(e) { byId('message').textContent=e.message; } };
byId('sample').onclick = () => { revision++; review(sample); };
byId('clear').onclick = () => { reset(); byId('choose').focus(); };
window.addEventListener('pagehide',reset);
byId('condition').oninput = () => {
  stopSearch();
  for (const item of byId('mentions').children) item.setAttribute('aria-pressed','false');
};
function studyCard(study) {
  const p = study.protocolSection;
  const id = p.identificationModule.nctId;
  const conditions = p.conditionsModule?.conditions?.join(', ') || 'See the study record';
  const criteria = p.eligibilityModule?.eligibilityCriteria?.trim();
  const el = document.createElement('article');
  el.className = 'record-card';
  el.innerHTML = '<small></small><h3><a></a></h3><p></p><details><summary>What to confirm with the study team</summary><blockquote></blockquote></details>';
  el.querySelector('small').textContent = 'Recruiting · '+id;
  const link = el.querySelector('a');
  link.href='study.html?id='+encodeURIComponent(id);
  link.textContent=p.identificationModule.briefTitle;
  el.querySelector('p').textContent='The registry returned this study for “'+searched+'”. Listed conditions: '+conditions+'.';
  el.querySelector('blockquote').textContent=criteria || 'Ask the study team for its current eligibility requirements.';
  return el;
}
async function fetchPage(append) {
  const request = new AbortController();
  controller = request;
  const timer = setTimeout(()=>request.abort(),20000);
  byId('message').textContent='Finding recruiting studies…'; byId('more').hidden=true;
  try {
    const response = await api('/studies',{'query.cond':condQuery(searched),'filter.overallStatus':'RECRUITING','filter.advanced':'AREA[LocationCountry]"United States"',fields:'NCTId,BriefTitle,Condition,EligibilityCriteria',pageSize:'10',pageToken:append?token:'',countTotal:'true'},{signal:request.signal});
    if(controller !== request) return;
    const studies = response.studies ?? [];
    byId('cards').append(...studies.map(studyCard));
    shown+=studies.length; token=response.nextPageToken;
    byId('count').textContent=shown ? 'Showing '+shown+' of '+(response.totalCount ?? shown)+' registry results for “'+searched+'”. The study team confirms eligibility and local availability.' : 'No recruiting US studies came up for “'+searched+'”. Try a broader condition name.';
    byId('results').hidden=false; byId('more').hidden=!token;
    byId('message').textContent='';
    if(!append) byId('results').querySelector('h2').focus();
  } catch {
    if(controller !== request) return;
    byId('message').textContent='The registry could not load these studies. Please try again.';
    byId('more').hidden=!append;
  } finally {clearTimeout(timer);}
}
byId('confirm').onsubmit=e=>{e.preventDefault(); stopSearch(); searched=byId('condition').value.trim(); if(searched) fetchPage(false); else byId('condition').focus();};
byId('more').onclick=()=>fetchPage(true);
