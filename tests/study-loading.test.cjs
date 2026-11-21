const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const read = file => readFileSync(join(__dirname, '..', file), 'utf8');
const studyPage = read('study.html').match(/<script>([\s\S]*?)<\/script>/)[1];
const shared = read('assets/app.js');
const id = 'NCT00000001';

function runPage({ fetch, path = '?id=' + id, loadShared = true, expire = false } = {}) {
  const nodes = new Map(), errors = [];
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { innerHTML: '', addEventListener() {}, insertAdjacentHTML() {}, querySelector: node, querySelectorAll: () => [], classList: { add() {}, toggle() {}, remove() {} }, style: {} });
    return nodes.get(key);
  };
  node('#page').innerHTML = 'Reading the study record…';
  const document = { createElement: node, body: { appendChild() {} }, addEventListener() {}, querySelector: node, getElementById: key => node('#' + key), querySelectorAll: () => [] };
  const context = vm.createContext({
    document, location: { search: path }, localStorage: { getItem: () => null },
    URL, URLSearchParams, AbortController, fetch,
    setTimeout: callback => { if (expire) queueMicrotask(callback); return 1; }, clearTimeout() {},
    IntersectionObserver: class { observe() {} },
    console: { error: (...args) => errors.push(args) },
  });
  if (loadShared) {
    vm.runInContext(shared, context);
    // The test models a loaded document; header/footer paint has its own dependencies.
    vm.runInContext('mountChrome = () => {}; initTooltips = () => {};', context);
  }
  return { completion: vm.runInContext(studyPage, context), page: node('#page'), errors };
}

test('shared and study scripts run together; successful API response renders the study', async () => {
  const subject = runPage({ fetch: async (url, options) => {
    assert.equal(url.pathname, '/api/v2/studies/' + id);
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => ({ protocolSection: {
      identificationModule: { nctId: id, briefTitle: 'Example Diabetes Trial' },
      statusModule: { overallStatus: 'RECRUITING' },
    } }) };
  } });
  await subject.completion;
  if (subject.errors.length) throw subject.errors[0][1];
  assert.match(subject.page.innerHTML, /Example Diabetes Trial/);
  assert.doesNotMatch(subject.page.innerHTML, /Reading the study record/);
  assert.deepEqual(subject.errors, []);
});

test('an unresponsive registry ends loading with a timeout message', async () => {
  const subject = runPage({ expire: true, fetch: (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  await subject.completion;
  assert.match(subject.page.innerHTML, /ClinicalTrials.gov took too long to respond/);
});

test('a missing trial renders a return link rather than the loading state', async () => {
  const subject = runPage({ fetch: async () => ({ ok: false, status: 404 }) });
  await subject.completion;
  assert.match(subject.page.innerHTML, /ClinicalTrials.gov returned 404/);
  assert.match(subject.page.innerHTML, /Back to Studies/);
});

test('unexpected data or a missing shared script still replaces the loading state', async () => {
  for (const subject of [
    runPage({ fetch: async () => ({ ok: true, json: async () => ({}) }) }),
    runPage({ loadShared: false }),
  ]) {
    await subject.completion;
    assert.match(subject.page.innerHTML, /We couldn’t display this study/);
    assert.match(subject.page.innerHTML, /https:\/\/clinicaltrials\.gov\//);
    assert.equal(subject.errors.length, 1);
  }
});

const maskingCases = [
  ['assessor only', { masking: 'SINGLE', whoMasked: ['OUTCOMES_ASSESSOR'] }, 'the people assessing the results.', 'Single'],
  ['participant and assessor', { masking: 'DOUBLE', whoMasked: ['PARTICIPANT', 'OUTCOMES_ASSESSOR'] }, 'participants and the people assessing the results.', 'Double'],
  ['four roles', { masking: 'QUADRUPLE', whoMasked: ['PARTICIPANT', 'CARE_PROVIDER', 'INVESTIGATOR', 'OUTCOMES_ASSESSOR'] }, 'participants, the people providing study care, the researchers running the study, and the people assessing the results.', 'Quadruple'],
  ['open label', { masking: 'NONE' }, 'This study is open-label. The study record reports no blinding.', 'None'],
  ['missing roles', { masking: 'TRIPLE' }, 'The study record reports blinding but doesn’t specify who is blinded.', 'Triple'],
  ['duplicate and unrecognized roles', { masking: 'SINGLE', whoMasked: ['INVESTIGATOR', 'INVESTIGATOR', 'OTHER'] }, 'the researchers running the study.', 'Single'],
  ['not reported', undefined, null, null],
];

for (const [name, maskingInfo, copy, registryLabel] of maskingCases) {
  test(`study explains masking from the registry: ${name}`, async () => {
    const subject = runPage({ fetch: async () => ({ ok: true, json: async () => ({ protocolSection: {
      identificationModule: { nctId: id, briefTitle: 'Example Trial' },
      designModule: { designInfo: { maskingInfo } },
    } }) }) });
    await subject.completion;
    if (subject.errors.length) throw subject.errors[0][1];
    assert.match(subject.page.innerHTML, /Example Trial/);
    const design = subject.page.innerHTML.match(/<ul class="design-lines">([\s\S]*?)<\/ul>/)?.[1] ?? '';
    const line = design.replace(/<[^>]+>/g, '');
    if (copy) {
      assert.ok(line?.endsWith(copy), `Unexpected masking text: ${line}`);
      assert.ok(subject.page.innerHTML.includes(`<dt>Masking</dt><dd>${registryLabel}</dd>`));
    } else assert.equal(line, '');
    assert.doesNotMatch(subject.page.innerHTML, /Neither you nor your doctors|You won’t know which treatment/);
  });
}

test('double-blind glossary entries do not guess which roles are blinded', () => {
  const context = vm.createContext({});
  vm.runInContext(shared, context);
  for (const term of ['double-blind', 'double blind']) {
    const definition = vm.runInContext(`GLOSSARY[${JSON.stringify(term)}][1]`, context);
    assert.match(definition, /Two roles/);
    assert.match(definition, /study record identifies which roles/);
    assert.doesNotMatch(definition, /study team|until the study ends/);
  }
});
