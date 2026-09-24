'use strict';
const $ = id => document.getElementById(id);
const state = { activeEvaluation: null, nodeEvent: null, tree: null, view: 'workbench', custom: {}, busy: false, dirty: false };
const sample = '<math xmlns="http://www.w3.org/1998/Math/MathML">\n  <mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo><msqrt><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac>\n</math>';
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Unexpected server response (${response.status})`); }
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function fillSelect(id, values, chosen) {
  const select = $(id);
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option'); option.value = value; option.textContent = value; select.append(option);
  }
  if (chosen && !values.includes(chosen)) {
    const option = document.createElement('option'); option.value = chosen; option.textContent = chosen; select.append(option);
  }
  select.value = chosen || values[0] || '';
}
function settings() {
  return { language: $('language').value, speechStyle: $('speechStyle').value,
    verbosity: $('verbosity').value, brailleCode: $('brailleCode').value,
    navMode: $('navMode').value, custom: {...state.custom} };
}
function loadSettings(value) {
  if (!value) return;
  for (const key of ['language','speechStyle','verbosity','brailleCode','navMode']) {
    const select = $(key), wanted = value[key];
    if (wanted && !Array.from(select.options).some(option => option.value === wanted)) {
      const option = document.createElement('option'); option.value = wanted; option.textContent = wanted; select.append(option);
    }
    if (wanted) select.value = wanted;
  }
  state.custom = {...(value.custom || {})}; renderCustom();
}
function renderCustom() {
  const container = $('custom-list'); container.replaceChildren();
  for (const [name, value] of Object.entries(state.custom).sort()) {
    const chip = document.createElement('span'); chip.className = 'chip';
    const label = document.createElement('span'); label.textContent = `${name} = ${value}`;
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${name}`);
    remove.onclick = () => { delete state.custom[name]; renderCustom(); markDirty(); };
    chip.append(label, remove); container.append(chip);
  }
}
function markDirty() {
  state.dirty = true;
  document.querySelectorAll('[data-command]').forEach(button => button.disabled = true);
  $('reload').disabled = true;
  setText('nav-status', 'Run to apply changes');
  updateTreeControls();
}
function setText(id, value) { $(id).textContent = value === undefined || value === null ? '' : String(value); }
function preview(canonical) {
  const frame = $('preview');
  frame.srcdoc = canonical ? `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{min-height:100%;margin:0}body{display:grid;place-items:center;padding:1rem;color:#1d2b31;background:#fff;font-size:1.7rem}math{max-width:100%;overflow:auto}</style>${canonical}` : '';
}
function display(event) {
  state.dirty = false;
  const base = ['navigate','node'].includes(event?.kind) ? state.activeEvaluation : event;
  const baseOutput = base?.outputs || {}, output = event?.outputs || {};
  const canonical = baseOutput.canonical;
  preview(canonical);
  setText('display-status', canonical ? 'Rendered' : 'No expression');
  setText('speech', baseOutput.speech); setText('ssml', baseOutput.ssml); setText('braille', baseOutput.braille);
  setText('canonical', canonical); setText('intent', baseOutput.intent);
  setText('nav-speech', output.navigationSpeech || output.nodeSpeech); setText('node-id', output.nodeId ? `ID: ${output.nodeId} · offset: ${output.offset ?? 0}` : '');
  setText('focused-mathml', output.focusedMathml); setText('highlighted-braille', output.highlightedBraille);
  setText('braille-range', output.brailleRange ? `Braille range: [${output.brailleRange.join(', ')}]` : '');
  const errors = $('errors'); errors.replaceChildren();
  for (const [name, message] of Object.entries(event?.errors || {})) {
    const item = document.createElement('p'); item.textContent = `${name}: ${message}`; errors.append(item);
  }
  const timings = event?.timings_ms || {};
  setText('timings', Object.entries(timings).map(([name,value]) => `${name}: ${value} ms`).join('  ·  '));
  setText('active-prefs', JSON.stringify(event?.preferences || {}, null, 2));
  setText('logs', (event?.logs || []).join('\n'));
  if (event?.input !== undefined) $('input').value = event.input;
  if (event?.settings) loadSettings(event.settings);
  const navigable = !state.dirty && !!state.activeEvaluation;
  document.querySelectorAll('[data-command]').forEach(button => button.disabled = state.busy || !navigable);
  $('reload').disabled = state.busy || !navigable;
  setText('nav-status', navigable ? 'Ready' : 'Submit an expression');
}
function busy(value) {
  state.busy = value;
  for (const id of ['run','add-pref']) $(id).disabled = value;
  document.querySelectorAll('[data-command]').forEach(button => button.disabled = value || state.dirty || !state.activeEvaluation);
  $('reload').disabled = value || state.dirty || !state.activeEvaluation;
  updateTreeControls();
}
function receive(event) {
  const resultEvent = !['navigate','node'].includes(event.kind);
  if (resultEvent) { state.activeEvaluation = event.outputs?.canonical ? event : null; state.nodeEvent = null; }
  else state.nodeEvent = event;
  display(event);
  if (resultEvent) buildTree(event); else syncTreeFocus(event);
}
async function run(input, chosenSettings) {
  if (state.busy) return;
  busy(true);
  try { receive(await api('/api/evaluate', {input, settings: chosenSettings})); }
  catch (error) { showTransportError(error); }
  finally { busy(false); }
}
function showTransportError(error) {
  const errors = $('errors'); errors.replaceChildren(); const item = document.createElement('p'); item.textContent = `Server: ${error.message}`; errors.append(item);
  if (state.view === 'tree') showTreeError(`Server: ${error.message}`);
}
async function action(path, body) {
  if (state.busy) return;
  busy(true);
  try { receive(await api(path, body)); }
  catch (error) { showTransportError(error); }
  finally { busy(false); }
}
async function updateStyles() {
  try {
    const style = $('speechStyle').value;
    const result = await api('/api/styles', {language:$('language').value});
    fillSelect('speechStyle', result.styles, result.styles.includes(style) ? style : result.styles[0]);
  } catch (error) { showTransportError(error); }
}
function setView(view) {
  state.view = view;
  $('workbench-view').hidden = view !== 'workbench';
  $('tree-view').hidden = view !== 'tree';
  $('show-workbench').setAttribute('aria-pressed', view === 'workbench');
  $('show-tree').setAttribute('aria-pressed', view === 'tree');
  if (view === 'tree' && state.tree?.selectedId) revealTreeRow(state.tree.selectedId);
}
function parseXml(value) {
  const doc = new DOMParser().parseFromString(value, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML parsing failed');
  return doc.documentElement;
}
function elements(root) { return root ? [root, ...root.querySelectorAll('*')] : []; }
function nodeSignature(node) {
  const content = node.textContent.replace(/[\u2061-\u2064]/g, '').replace(/\s+/g, ' ').trim();
  return `${node.localName}|${content}`;
}
function sourceMatches(canonical, source) {
  const matches = new WeakMap(), used = new Set(), sourceIds = new Map();
  if (!source) return matches;
  for (const node of elements(source)) {
    const id = node.getAttribute('id');
    if (id) sourceIds.set(id, sourceIds.has(id) ? null : node);
  }
  for (const node of elements(canonical)) {
    const id = node.getAttribute('id'), original = id && sourceIds.get(id);
    if (original && !used.has(original)) { matches.set(node, original); used.add(original); }
  }
  if (!matches.has(canonical) && canonical.localName === source.localName && !used.has(source)) {
    matches.set(canonical, source); used.add(source);
  }
  const visited = new Set();
  function align(canonicalParent, sourceParent) {
    if (visited.has(canonicalParent)) return;
    visited.add(canonicalParent);
    const children = [];
    function collect(node) {
      if (node.getAttribute('data-changed') === 'added') {
        for (const child of node.children) collect(child);
      } else children.push(node);
    }
    for (const child of canonicalParent.children) collect(child);
    const sourceChildren = [...sourceParent.children];
    for (const candidate of children) {
      if (matches.has(candidate)) continue;
      const key = nodeSignature(candidate);
      const peers = children.filter(node => !matches.has(node) && nodeSignature(node) === key);
      const originals = sourceChildren.filter(node => !used.has(node) && nodeSignature(node) === key);
      if (peers.length === 1 && originals.length === 1) {
        matches.set(candidate, originals[0]); used.add(originals[0]);
      }
    }
    for (const candidate of children) {
      const original = matches.get(candidate);
      if (original && sourceChildren.includes(original)) align(candidate, original);
    }
  }
  for (const node of elements(canonical)) {
    const original = matches.get(node);
    if (original) align(node, original);
  }
  return matches;
}
function intentMatches(tree, id) {
  if (!tree.intent) return [];
  const matches = elements(tree.intent).filter(node => {
    const nodeId = node.getAttribute('id');
    return nodeId === id || nodeId?.startsWith(`${id}-literal-`) || nodeId?.startsWith(`${id}-fixity-`);
  });
  return matches.filter(node => !matches.some(parent => parent !== node && parent.contains(node)));
}
function treePreview(node) {
  const content = node.textContent.replace(/\s+/g, ' ').trim();
  return content.length > 52 ? `${content.slice(0, 49)}…` : content;
}
function showTreeError(message) {
  $('tree-error').hidden = !message;
  setText('tree-error', message);
}
function updateTreeControls() {
  document.querySelectorAll('.tree-select').forEach(button => button.disabled = state.busy || state.dirty);
  if (!state.tree) setText('tree-status', 'Run an expression');
  else if (state.dirty) setText('tree-status', 'Last evaluated · run to apply changes');
  else setText('tree-status', `${state.tree.byId.size} nodes`);
}
function expandTreeRow(entry) {
  if (!entry.node.children.length) return;
  if (!entry.loaded) {
    for (const child of entry.node.children) entry.list.append(renderTreeNode(child, entry.id, entry.depth + 1));
    entry.loaded = true;
  }
  entry.list.hidden = false;
  entry.toggle.setAttribute('aria-expanded', 'true');
}
function collapseTreeRow(entry) {
  entry.list.hidden = true;
  entry.toggle.setAttribute('aria-expanded', 'false');
}
function renderTreeNode(node, parentId, depth) {
  const tree = state.tree, id = node.getAttribute('id');
  const li = document.createElement('li'), row = document.createElement('div');
  const toggle = document.createElement(node.children.length ? 'button' : 'span');
  const select = document.createElement('button'), children = document.createElement('ul');
  row.className = 'tree-row'; children.className = 'tree-list tree-children'; children.hidden = true;
  toggle.className = node.children.length ? 'tree-toggle' : 'tree-spacer';
  if (node.children.length) {
    toggle.type = 'button'; toggle.textContent = '▸'; toggle.setAttribute('aria-label', `Expand ${node.localName}`);
    toggle.setAttribute('aria-expanded', 'false');
  }
  select.type = 'button'; select.className = 'tree-select';
  select.setAttribute('aria-label', `${node.localName}${treePreview(node) ? ` ${treePreview(node)}` : ''}`);
  const tag = document.createElement('span'); tag.className = 'tree-tag'; tag.textContent = `<${node.localName}>`;
  const preview = document.createElement('span'); preview.className = 'tree-preview'; preview.textContent = treePreview(node);
  select.append(tag, preview);
  for (const label of [node.getAttribute('data-changed')].filter(Boolean)) {
    const badge = document.createElement('span'); badge.className = 'tree-badge'; badge.textContent = label; select.append(badge);
  }
  if (id) {
    const entry = {node, id, parentId, depth, select, toggle, list: children, loaded: false};
    tree.rows.set(id, entry);
    if (node.children.length) toggle.onclick = () => toggle.getAttribute('aria-expanded') === 'true' ? collapseTreeRow(entry) : expandTreeRow(entry);
    select.onclick = () => selectTreeNode(id);
  } else select.disabled = true;
  row.append(toggle, select); li.append(row, children);
  if (id && node.children.length && depth < 1) expandTreeRow(tree.rows.get(id));
  return li;
}
function revealTreeRow(id) {
  const tree = state.tree, node = tree?.byId.get(id);
  if (!node) return null;
  const ancestors = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
  for (const parent of ancestors.reverse()) {
    const entry = tree.rows.get(parent.getAttribute('id'));
    if (entry) expandTreeRow(entry);
  }
  const entry = tree.rows.get(id);
  if (entry && state.view === 'tree') entry.select.scrollIntoView({block:'nearest'});
  return entry;
}
function markSelectedTreeNode(id) {
  const tree = state.tree;
  if (!tree?.byId.has(id)) return;
  const previous = tree.rows.get(tree.selectedId);
  if (previous) previous.select.removeAttribute('aria-current');
  tree.selectedId = id;
  const entry = revealTreeRow(id);
  if (entry) entry.select.setAttribute('aria-current', 'true');
}
function buildTree(event) {
  const base = state.activeEvaluation;
  state.tree = null;
  $('tree-root').replaceChildren();
  showTreeError('');
  if (!base?.outputs?.canonical) {
    clearTreeDetail();
    if (event?.errors && Object.keys(event.errors).length) showTreeError(Object.entries(event.errors).map(([name, message]) => `${name}: ${message}`).join('\n'));
    updateTreeControls(); return;
  }
  try {
    const canonical = parseXml(base.outputs.canonical);
    let source = null, sourceError = '';
    try { source = parseXml(base.input); } catch { sourceError = 'Source XML could not be parsed for node matching. The original input remains in Workbench.'; }
    let intent = null;
    try { if (base.outputs.intent) intent = parseXml(base.outputs.intent); } catch { /* Intent error is reported by the engine. */ }
    const byId = new Map();
    for (const node of elements(canonical)) if (node.getAttribute('id')) byId.set(node.getAttribute('id'), node);
    state.tree = {canonical, source, intent, sourceError, byId, sourceMap:sourceMatches(canonical, source), rows:new Map(), selectedId:null};
    const list = document.createElement('ul'); list.className = 'tree-list';
    list.append(renderTreeNode(canonical, null, 0)); $('tree-root').append(list);
    markSelectedTreeNode(canonical.getAttribute('id'));
    renderTreeDetail();
  } catch (error) {
    state.tree = null; $('tree-root').replaceChildren();
    clearTreeDetail(); showTreeError(`Could not build tree: ${error.message}. Raw outputs remain in Workbench.`);
  }
  updateTreeControls();
}
function clearTreeDetail() {
  setText('tree-node-title', 'No expression'); setText('tree-node-id', '');
  for (const id of ['tree-source','tree-canonical','tree-intent','tree-speech','tree-ssml','tree-braille','tree-braille-range','tree-source-status','tree-canonical-status','tree-intent-status','tree-node-timings','tree-node-logs']) setText(id, '');
  $('tree-node-errors').replaceChildren();
  $('tree-node-preview').srcdoc = '';
}
function renderTreeBraille(event) {
  const container = $('tree-braille'); container.replaceChildren();
  const full = state.activeEvaluation?.outputs?.braille || '';
  const range = event?.outputs?.brailleRange;
  const cells = [...full];
  if (Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 0 && range[1] > range[0] && range[1] <= cells.length) {
    const focus = document.createElement('span'); focus.className = 'braille-focus'; focus.textContent = cells.slice(range[0], range[1]).join('');
    container.append(cells.slice(0, range[0]).join(''), focus, cells.slice(range[1]).join(''));
    setText('tree-braille-range', `[${range[0]}, ${range[1]})`);
  } else {
    container.textContent = event?.outputs?.highlightedBraille || full;
    setText('tree-braille-range', range ? `[${range.join(', ')}]` : 'Unicode');
  }
}
function renderTreeDetail() {
  const tree = state.tree, id = tree?.selectedId, node = tree?.byId.get(id);
  if (!node) { clearTreeDetail(); return; }
  const root = node === tree.canonical;
  const event = state.nodeEvent?.outputs?.nodeId === id ? state.nodeEvent : null;
  const output = event?.outputs || (root ? state.activeEvaluation?.outputs || {} : {});
  const source = tree.sourceMap.get(node), intents = intentMatches(tree, id);
  setText('tree-node-title', `<${node.localName}>${treePreview(node) ? `  ${treePreview(node)}` : ''}`);
  setText('tree-node-id', id);
  setText('tree-source', source ? new XMLSerializer().serializeToString(source) : root && tree.sourceError ? state.activeEvaluation.input : 'No reliable source-node match');
  setText('tree-source-status', source ? 'Matched' : tree.sourceError ? 'Parse unavailable' : node.getAttribute('data-changed') === 'added' ? 'Generated' : 'Ambiguous');
  const canonicalXml = new XMLSerializer().serializeToString(node);
  setText('tree-canonical', canonicalXml);
  const mathXml = root ? canonicalXml : `<math xmlns="http://www.w3.org/1998/Math/MathML">${canonicalXml}</math>`;
  $('tree-node-preview').srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{min-height:100%;margin:0}body{display:grid;place-items:center;padding:10px;color:#1d2b31;background:#fff;font-size:1.3rem}math{max-width:100%;overflow:auto}</style>${mathXml}`;
  setText('tree-canonical-status', node.getAttribute('data-changed') || (node.hasAttribute('data-id-added') ? 'ID assigned' : ''));
  setText('tree-intent', intents.length ? intents.map(item => new XMLSerializer().serializeToString(item)).join('\n\n') : tree.intent ? 'No direct intent-node match' : 'Intent output unavailable');
  setText('tree-intent-status', intents.length ? `${intents.length} match${intents.length === 1 ? '' : 'es'}` : tree.intent ? 'Unmapped' : 'Unavailable');
  setText('tree-speech', event ? output.nodeSpeech : root ? output.speech : 'Select node to read');
  setText('tree-ssml', event ? output.nodeSsml : root ? output.ssml : '');
  renderTreeBraille(event);
  const errors = $('tree-node-errors'); errors.replaceChildren();
  for (const [key, value] of Object.entries(event?.errors || {})) {
    const line = document.createElement('p'); line.textContent = `${key}: ${value}`; errors.append(line);
  }
  setText('tree-node-timings', Object.entries(event?.timings_ms || {}).map(([key,value]) => `${key}: ${value} ms`).join('  ·  '));
  setText('tree-node-logs', (event?.logs || []).join('\n'));
}
function syncTreeFocus(event) {
  const id = event.outputs?.nodeId;
  if (id && state.tree?.byId.has(id)) markSelectedTreeNode(id);
  if (!id && Object.keys(event.errors || {}).length) showTreeError(Object.values(event.errors).join('\n'));
  else showTreeError('');
  renderTreeDetail();
  updateTreeControls();
}
function selectTreeNode(id) {
  if (state.busy || state.dirty || !state.tree?.byId.has(id)) return;
  markSelectedTreeNode(id);
  state.nodeEvent = null;
  renderTreeDetail();
  setText('tree-speech', 'Reading node…');
  action('/api/node', {id});
}
function treeKeydown(event) {
  if (!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const current = document.activeElement.closest('.tree-row');
  if (!current || !$('tree-root').contains(current)) return;
  const visible = [...$('tree-root').querySelectorAll('.tree-select')].filter(button => button.getClientRects().length);
  const button = current.querySelector('.tree-select'), index = visible.indexOf(button);
  if (index < 0) return;
  let target;
  if (event.key === 'ArrowDown') target = visible[Math.min(index + 1, visible.length - 1)];
  if (event.key === 'ArrowUp') target = visible[Math.max(index - 1, 0)];
  if (event.key === 'Home') target = visible[0];
  if (event.key === 'End') target = visible[visible.length - 1];
  const entry = [...state.tree.rows.values()].find(item => item.select === button);
  if (event.key === 'ArrowRight' && entry?.node.children.length) {
    if (entry.toggle.getAttribute('aria-expanded') === 'false') expandTreeRow(entry);
    else target = entry.list.querySelector('.tree-select');
  }
  if (event.key === 'ArrowLeft' && entry) {
    if (entry.toggle.getAttribute('aria-expanded') === 'true') collapseTreeRow(entry);
    else target = state.tree.rows.get(entry.parentId)?.select;
  }
  event.preventDefault();
  target?.focus();
}

async function init() {
  try {
    const data = await api('/api/bootstrap');
    setText('version', `MathCAT ${data.version}`);
    fillSelect('language', data.languages, data.defaults.language);
    fillSelect('speechStyle', data.speechStyles, data.defaults.speechStyle);
    fillSelect('brailleCode', data.brailleCodes, data.defaults.brailleCode);
    loadSettings(data.defaults);
    $('input').value = sample;
    receive(data.current || {kind:'bootstrap'});
    $('input').addEventListener('input', markDirty);
    $('input').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !state.busy && !$('input').readOnly) {
        event.preventDefault();
        run($('input').value, settings());
      }
    });
    for (const id of ['language','speechStyle','verbosity','brailleCode','navMode']) {
      $(id).addEventListener('change', markDirty);
    }
    $('language').addEventListener('change', updateStyles);
    $('show-workbench').onclick = () => setView('workbench');
    $('show-tree').onclick = () => setView('tree');
    $('tree-root').addEventListener('keydown', treeKeydown);
    $('open-settings').onclick = () => $('settings-dialog').showModal();
    $('close-settings').onclick = () => $('settings-dialog').close();
    $('settings-dialog').onclick = event => { if (event.target === $('settings-dialog')) $('settings-dialog').close(); };
    $('run').onclick = () => run($('input').value, settings());
    $('reload').onclick = () => action('/api/reload', {});
    document.querySelectorAll('[data-command]').forEach(button => button.onclick = () => action('/api/navigate', {command:button.dataset.command}));
    $('add-pref').onclick = () => {
      const name = $('pref-name').value.trim(), value = $('pref-value').value;
      if (!name) { showTransportError(new Error('Enter a preference name')); return; }
      state.custom[name] = value; $('pref-name').value = ''; $('pref-value').value = ''; renderCustom(); markDirty();
    };
  } catch (error) { showTransportError(error); }
}
init();
