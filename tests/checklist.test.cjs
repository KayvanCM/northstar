const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const runtime = read('assets/app.js');
const id = 'NCT00000001';
const storageKey = 'northstar:check:v2:' + id;
const legacyKey = 'northstar:check:' + id;
function fixture(inclusion, exclusion = []) {
  return 'Inclusion Criteria:\n' + inclusion.map(x => '- ' + x).join('\n') +
    '\nExclusion Criteria:\n' + exclusion.map(x => '- ' + x).join('\n');
}
function testRuntime(initial = {}) {
  const storage = new Map(Object.entries(initial));
  const localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const context = vm.createContext({ localStorage });
  const run = (s, params) => { Object.assign(context, params); return vm.runInContext(s, context); };
  run(runtime);
  const load = (src, revision, nct = id) => run('checklistAnswersFor(nct, parseCriteria(src), revision)', {src, revision, nct});
  function record(src, revision) {
    return {protocolSection:{identificationModule:{nctId:id,briefTitle:'Synthetic test record'},
      eligibilityModule:{eligibilityCriteria:src},statusModule:{lastUpdatePostDateStruct:{date:revision}}}};
  }
  return { load, run, record, storage, context };
}
function answers(state) { return {...state.answers}; }
const before=fixture(['Original question','Another question'], ['Exclusion question']);
const after=fixture(['New question','Another question','Original question'], ['Exclusion question']);
test('insertion and reorder keep answers on their original questions on both sides', () => {
  const r=testRuntime();
  const state=r.load(before,'2026-01-01');
  state.setAnswer('i0','y'); state.setAnswer('i1','u'); state.setAnswer('o0','n');
  const next=r.load(after,'2026-01-02');
  assert.deepEqual(answers(next),{i1:'u',i2:'y',o0:'n'});
  assert.equal(next.needsReview,false);
  assert.deepEqual(answers(r.load(after,'2026-01-02','NCT00000002')),{});
  next.setAnswer('i2','');
  assert.deepEqual(answers(r.load(after,'2026-01-02')),{i1:'u',o0:'n'});
});
test('text, section, and subgroup changes do not carry answers over', () => {
  const r=testRuntime();
  r.load(fixture(['Group One:','Same text','Age 21 or older','Stays here']), '1').setAnswer('i1','y');
  r.load(fixture(['Group One:','Same text','Age 21 or older','Stays here']), '1').setAnswer('i2','y');
  const next=r.load(fixture(['Group Two:','Same text','Age 25 or older'],['Age 21 or older']),'2');
  assert.deepEqual(answers(next),{});
  assert.equal(next.needsReview,true);
});
test('duplicate responses are scoped to the exact revision and criteria snapshot', () => {
  const r=testRuntime();
  const duplicate=fixture(['Same row','Same row','Unique row']);
  const s=r.load(duplicate,'1');
  s.setAnswer('i0','y');s.setAnswer('i1','n');s.setAnswer('i2','u');
  assert.deepEqual(answers(r.load(duplicate,'1')),{i0:'y',i1:'n',i2:'u'});
  assert.deepEqual(answers(r.load(duplicate,'2')),{i2:'u'});
  const edited=r.load(fixture(['Same row','New row','Same row','Unique row']),'1');
  assert.deepEqual(answers(edited),{i3:'u'}); assert.equal(edited.needsReview,true);
  const single=r.load(fixture(['Same row','Unique row']),'2');
  assert.deepEqual(answers(single),{i1:'u'});
  single.setAnswer('i0','y');
  assert.deepEqual(answers(r.load(duplicate,'3')),{i2:'u'});
});
test('legacy answers never attach by position; re-answers persist without erasing legacy data', () => {
  const r=testRuntime({[legacyKey]:'{"i0":"n"}'});
  const state=r.load(before,'1');
  assert.deepEqual(answers(state),{}); assert.equal(state.needsReview,true);
  state.setAnswer('i0','y');
  assert.equal(r.load(before,'1').needsReview,true);
  state.setAnswer('i1','y');state.setAnswer('o0','n');
  assert.equal(r.load(before,'1').needsReview,false);
  assert.equal(r.storage.get(legacyKey),'{"i0":"n"}');
  assert.ok(r.storage.has(storageKey));
  assert.equal(testRuntime({['northstar:ask:'+id]:'["i0"]'}).load(before,'1').needsReview,true);
});
test('the actual standalone brief and the shared modal renderer show the correct answer and incomplete status', async () => {
  const r=testRuntime();
  r.load(before,'1').setAnswer('i0','y');
  const next=r.load(after,'2');
  const d=r.record(after,'2');
  const html=r.run('buildBrief(d, {answers: next.answers, needsReview: next.needsReview})',{d,next});
  assert.match(html, /<td>Original question<\/td><td><span class="tag tag-go">Meets/);
  assert.match(html, /<td>New question<\/td><td><span class="ans-none">Not answered/);
  assert.match(html, /3 unanswered/);
  assert.doesNotMatch(html, /all point toward eligibility/);
  const inline = page => read(page).match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes={};
  const node=sel=>nodes[sel]??={href:'',innerHTML:'',insertAdjacentHTML(){},addEventListener(){}};
  const document={querySelector:node,querySelectorAll:()=>[],title:''};
  const location={search:'?id='+id};
  const doctor=inline('doctor.html');
  new vm.Script(inline('study.html'));
  assert.match(inline('study.html'), /buildBrief\(studyData, \{ answers, needsReview: checklist.needsReview/);
  r.run('api = async () => d; dataVersion = async () => null;', {document,location,URLSearchParams});
  await r.run(doctor);
  assert.match(nodes['#page'].innerHTML, /<td>Original question<\/td><td><span class="tag tag-go">Meets/);
  assert.match(nodes['#page'].innerHTML, /<td>New question<\/td><td><span class="ans-none">Not answered/);
});
