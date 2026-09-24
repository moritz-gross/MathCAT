'use strict';
const $ = id => document.getElementById(id);
const state = { activeEvaluation: null, custom: {}, busy: false, dirty: false };
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
}
function setText(id, value) { $(id).textContent = value === undefined || value === null ? '' : String(value); }
function preview(canonical) {
  const frame = $('preview');
  frame.srcdoc = canonical ? `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{min-height:100%;margin:0}body{display:grid;place-items:center;padding:1rem;color:#1d2b31;background:#fff;font-size:1.7rem}math{max-width:100%;overflow:auto}</style>${canonical}` : '';
}
function display(event) {
  state.dirty = false;
  const base = event?.kind === 'navigate' ? state.activeEvaluation : event;
  const baseOutput = base?.outputs || {}, output = event?.outputs || {};
  const canonical = baseOutput.canonical;
  preview(canonical);
  setText('display-status', canonical ? 'Rendered' : 'No expression');
  setText('speech', baseOutput.speech); setText('ssml', baseOutput.ssml); setText('braille', baseOutput.braille);
  setText('canonical', canonical); setText('intent', baseOutput.intent);
  setText('nav-speech', output.navigationSpeech); setText('node-id', output.nodeId ? `ID: ${output.nodeId} · offset: ${output.offset ?? 0}` : '');
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
}
function receive(event) {
  if (event.kind !== 'navigate') state.activeEvaluation = event.outputs?.canonical ? event : null;
  display(event);
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
async function init() {
  try {
    const data = await api('/api/bootstrap');
    setText('version', `MathCAT ${data.version}`);
    fillSelect('language', data.languages, data.defaults.language);
    fillSelect('speechStyle', data.speechStyles, data.defaults.speechStyle);
    fillSelect('brailleCode', data.brailleCodes, data.defaults.brailleCode);
    loadSettings(data.defaults);
    state.activeEvaluation = data.current?.outputs?.canonical ? data.current : null;
    $('input').value = sample;
    display(data.current || null);
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
