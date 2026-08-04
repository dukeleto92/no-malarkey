/* =============================================================================
 * Harness UI wiring.
 *
 * Reads mod files, validates them, drives a GameSession, renders the report /
 * turns / results, and posts dumps. Contains no mod-specific values: every id,
 * pk and count on screen comes from the data that was just loaded.
 * ============================================================================= */

'use strict';

import { listMods, fetchMod, inspectMod } from './loader.js';
import { validateMod } from './validate.js';
import { GameSession } from './runner.js';
import { buildDump, writeDump, stableStringify } from './dump.js';

const $ = (id) => document.getElementById(id);

const state = {
  mods: [],
  mod: null,
  report: null,
  session: null,
  engineVersion: null,
  busy: false,
};

/* ---------------------------------------------------------------- logging */

function log(kind, message) {
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  const stamp = new Date().toLocaleTimeString('en-GB');
  line.textContent = `${stamp}  ${message}`;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}

function fail(err) {
  const msg = err && err.message ? err.message : String(err);
  log('error', msg);
  // Surface it where it cannot be missed rather than only in the log tab.
  showTab('pane-log');
}

/* ---------------------------------------------------------------- tabs */

function showTab(paneId) {
  for (const btn of document.querySelectorAll('[role=tab]')) {
    const on = btn.dataset.pane === paneId;
    btn.setAttribute('aria-selected', String(on));
    $(btn.dataset.pane).dataset.active = String(on);
  }
}

for (const btn of document.querySelectorAll('[role=tab]')) {
  btn.addEventListener('click', () => showTab(btn.dataset.pane));
}

/* ---------------------------------------------------------------- url state */

const params = new URLSearchParams(location.search);

function initFromUrl() {
  if (params.has('seed')) {
    const s = params.get('seed');
    if (s === 'random' || s === 'off') {
      $('deterministic').checked = false;
    } else {
      $('seed').value = s;
      $('deterministic').checked = true;
    }
  }
  if (params.has('path')) $('path').value = params.get('path');
  if (params.has('q')) $('jump').value = params.get('q');
}

function currentSeed() {
  return $('deterministic').checked ? $('seed').value.trim() || '1' : null;
}

/* ---------------------------------------------------------------- engine meta */

async function loadEngineVersion() {
  try {
    const res = await fetch('/engine/VERSION', { cache: 'no-store' });
    if (!res.ok) throw new Error(`VERSION returned ${res.status}`);
    const text = await res.text();
    const commit = (text.match(/^commit\s+(\S+)/m) || [])[1] || null;
    const date = (text.match(/^commit date\s+(.+)$/m) || [])[1] || null;
    state.engineVersion = { commit, date };
    $('engine-meta').innerHTML = commit
      ? `<b>commit</b> ${commit.slice(0, 12)}<br><b>upstream date</b> ${date || '?'}<br>pinned verbatim, never edited`
      : 'VERSION found but no commit line';
  } catch (err) {
    $('engine-meta').textContent = `could not read engine/VERSION: ${err.message}`;
  }
}

/* ---------------------------------------------------------------- mods */

async function loadModList() {
  state.mods = await listMods();
  const sel = $('mod-select');
  sel.innerHTML = '';

  if (!state.mods.length) {
    sel.innerHTML = '<option value="">no mods found</option>';
    log('error', 'No mod folders found. Looking for a folder holding both "Code 1" and "Code 2".');
    return;
  }

  for (const m of state.mods) {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = `${m.name}  (${m.dir}/)`;
    sel.appendChild(opt);
  }

  const wanted = params.get('mod');
  if (wanted && state.mods.some((m) => m.name === wanted)) sel.value = wanted;

  log('info', `${state.mods.length} mod folder(s) found.`);
}

function renderFileMeta(mod) {
  const fmt = (f, name) => {
    if (!f) return `<b>${name}</b> absent`;
    const when = new Date(f.mtime).toLocaleString('en-GB');
    return `<b>${name}</b> ${f.bytes.toLocaleString()} bytes<br>&nbsp;&nbsp;${when}`;
  };
  $('file-meta').innerHTML = [
    fmt(mod.code1, 'Code 1'),
    fmt(mod.code2, 'Code 2'),
    mod.code3 ? fmt(mod.code3, 'Code 3') : '',
  ].filter(Boolean).join('<br>');
}

/* ---------------------------------------------------------------- report */

function renderReport(report, sandboxProblems) {
  const root = $('report');
  root.innerHTML = '';

  const add = (html) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    root.appendChild(div);
  };

  const head = [];
  if (report.errors.length) head.push(`<span class="badge err">${report.errors.length} error${report.errors.length === 1 ? '' : 's'}</span>`);
  if (report.warnings.length) head.push(`<span class="badge warn">${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}</span>`);
  const newCount = report.newFields.length + report.newArrays.length;
  if (newCount) head.push(`<span class="badge new">${newCount} new</span>`);
  if (!report.errors.length) head.push('<span class="badge ok">playable</span>');
  add(`<div class="section">${head.join('')}</div>`);

  if (sandboxProblems && sandboxProblems.length) {
    const items = sandboxProblems.map((p) => `
      <div class="item warn">
        <div class="where">${p.stage} threw during pre-flight</div>
        <div class="msg">${escapeHtml(p.message)}${p.line ? ` (around line ${p.line.line} of the executed body)` : ''}
        <br><br>Pre-flight runs your code against a stub browser to validate it before the game starts, so a
        throw here is often just the styling block reaching for a real DOM element. If the game itself runs
        fine, this is noise. If it does not, this is your lead.</div>
      </div>`).join('');
    add(`<div class="section"><h2>Pre-flight execution</h2>${items}</div>`);
  }

  const group = (title, items, cls) => {
    if (!items.length) return;
    const html = items.map((i) => `
      <div class="item ${cls}">
        <div class="where">${escapeHtml(i.where)}</div>
        <div class="msg">${escapeHtml(i.msg)}</div>
      </div>`).join('');
    add(`<div class="section"><h2>${title}</h2>${html}</div>`);
  };

  if (report.newArrays.length) {
    const html = report.newArrays.map((a) => `
      <div class="item new">
        <div class="where">${escapeHtml(a.name)}</div>
        <div class="msg">Array the validator does not recognise, ${a.count} record(s). Passed through to the engine untouched. Listed so new mechanics are visible, never blocked.</div>
      </div>`).join('');
    add(`<div class="section"><h2>New arrays</h2>${html}</div>`);
  }

  if (report.newFields.length) {
    const grouped = new Map();
    for (const f of report.newFields) {
      const key = `${f.array}.${f.field}`;
      if (!grouped.has(key)) grouped.set(key, { ...f, count: 0, pks: [] });
      const g = grouped.get(key);
      g.count += 1;
      if (g.pks.length < 6) g.pks.push(f.pk);
    }
    const html = [...grouped.values()].map((g) => `
      <div class="item new">
        <div class="where">${escapeHtml(g.array)} &rarr; "${escapeHtml(g.field)}"</div>
        <div class="msg">${g.count} record(s), e.g. pk ${g.pks.join(', ')}. Sample value: <code>${escapeHtml(g.sample)}</code>. Unrecognised, passed through untouched.</div>
      </div>`).join('');
    add(`<div class="section"><h2>New fields</h2>${html}</div>`);
  }

  group('Errors', report.errors, 'err');
  group('Warnings', report.warnings, 'warn');
  group('Notes', report.notes, 'note');

  // tab counters
  const c = $('c-report');
  if (report.errors.length) { c.textContent = report.errors.length; c.className = 'count err'; }
  else if (report.warnings.length) { c.textContent = report.warnings.length; c.className = 'count warn'; }
  else if (newCount) { c.textContent = newCount; c.className = 'count new'; }
  else { c.textContent = 'ok'; c.className = 'count'; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------------------------------------------------------------- turns */

function renderTurns(session) {
  const root = $('turns');
  const t = session ? session.transcript : [];
  $('c-turns').textContent = String(t.length);

  if (!t.length) {
    root.innerHTML = '<div class="empty">No turns played.</div>';
    return;
  }

  root.innerHTML = t.map((entry) => `
    <div class="turn">
      <div class="head">Q${(entry.questionIndex ?? 0) + 1} &nbsp;question pk ${entry.questionPk} &nbsp;&rarr;&nbsp; answer pk ${entry.answerPk}</div>
      <div class="ans">${escapeHtml(stripTags(entry.answerText))}</div>
      ${entry.feedback ? `<div class="fb">${escapeHtml(stripTags(entry.feedback))}</div>` : '<div class="fb"><em>no advisor feedback shown</em></div>'}
    </div>`).join('');
}

function stripTags(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent || '';
}

/* ---------------------------------------------------------------- results */

function renderResults(session) {
  const root = $('results');
  const r = session && session.finalResults();

  if (!r) {
    root.innerHTML = '<div class="empty">No results yet. Finish a run (Play to end) and they will appear here.</div>';
    return;
  }

  const needed = Number(session.temp.election_json?.[0]?.fields?.winning_electoral_vote_number) || 0;

  const nat = r.national.map((c) => `
    <tr class="${needed && c.electoralVotes >= needed ? 'win' : ''}">
      <td>${escapeHtml(c.candidate)}</td>
      <td class="num">${c.electoralVotes}</td>
      <td class="num">${c.votes.toLocaleString()}</td>
      <td class="num">${c.votePercent.toFixed(2)}%</td>
    </tr>`).join('');

  const states = r.states.map((st) => {
    const sorted = [...st.results].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    const top = sorted[0];
    const second = sorted[1];
    const margin = top && second && r.totalVotes
      ? (((top.votes || 0) - (second.votes || 0)) / Math.max(1, st.results.reduce((n, x) => n + (x.votes || 0), 0)) * 100)
      : 0;
    return `
      <tr>
        <td>${escapeHtml(st.state)}</td>
        <td class="num">${st.electoralVotes}</td>
        <td>${top ? escapeHtml(top.candidate) : '&ndash;'}</td>
        <td class="num">${margin ? `${margin.toFixed(2)}%` : '&ndash;'}</td>
      </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="section">
      <h2>National &mdash; ${needed} electoral votes to win</h2>
      <table class="res">
        <thead><tr><th>Candidate</th><th style="text-align:right">EV</th><th style="text-align:right">Popular</th><th style="text-align:right">Share</th></tr></thead>
        <tbody>${nat}</tbody>
      </table>
    </div>
    <div class="section">
      <h2>By state (${r.states.length})</h2>
      <table class="res">
        <thead><tr><th>State</th><th style="text-align:right">EV</th><th>Leader</th><th style="text-align:right">Margin</th></tr></thead>
        <tbody>${states}</tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------------------------- actions */

function setBusy(on, why) {
  state.busy = on;
  for (const id of ['btn-reload', 'btn-start', 'btn-play-end']) $(id).disabled = on;
  $('btn-dump').disabled = on || !state.session || !state.session.finalResults();
  if (on && why) log('info', why);
}

async function reloadAndValidate() {
  const name = $('mod-select').value;
  if (!name) return log('error', 'No mod selected.');

  setBusy(true, `Reading ${name} off disk...`);
  try {
    const mod = await fetchMod(name);
    state.mod = mod;
    renderFileMeta(mod);

    const { temp, problems } = inspectMod(mod);
    const report = validateMod(temp);
    state.report = report;
    renderReport(report, problems);

    const bits = [];
    if (report.errors.length) bits.push(`${report.errors.length} error(s)`);
    if (report.warnings.length) bits.push(`${report.warnings.length} warning(s)`);
    const newCount = report.newFields.length + report.newArrays.length;
    if (newCount) bits.push(`${newCount} new field/array`);
    log(report.errors.length ? 'warn' : 'ok', `Validated ${name}: ${bits.length ? bits.join(', ') : 'clean'}.`);

    if (report.errors.length) {
      log('warn', 'Errors found. You can still start the run — nothing here blocks you.');
      showTab('pane-report');
    }
  } catch (err) {
    fail(err);
  } finally {
    setBusy(false);
  }
}

async function startRun() {
  if (!state.mod) await reloadAndValidate();
  if (!state.mod) return;

  setBusy(true, 'Booting the engine...');
  showTab('pane-game');

  try {
    const session = new GameSession({
      mount: $('frame-mount'),
      onEvent: ({ kind, message }) => log(kind === 'warn' ? 'warn' : 'info', message),
    });
    state.session = session;

    await session.boot();
    await session.submitMod(state.mod);
    await session.startGame({
      election: params.get('election'),
      candidate: params.get('candidate'),
      runningMate: params.get('vp'),
      difficulty: params.get('difficulty'),
    });
    await session.begin({ seed: currentSeed() });

    renderTurns(session);
    renderResults(session);

    // Replay a path and/or jump forward.
    const pathRaw = $('path').value.trim();
    const jump = Number($('jump').value);

    if (pathRaw) {
      const pks = pathRaw.split(/[,\s]+/).filter(Boolean).map(Number);
      log('info', `Replaying ${pks.length} answer(s) through the real engine...`);
      await session.playPath(pks, { onTurn: () => renderTurns(session) });
      log('ok', `Replay done. Now at question ${session.temp.question_number + 1}.`);
    } else if (jump > 1) {
      log('info', `Playing ${jump - 1} turn(s) to reach question ${jump} (lowest-pk answer each turn).`);
      await session.playAuto(jump - 1, { onTurn: () => renderTurns(session) });
      log('ok', `Now at question ${session.temp.question_number + 1}.`);
    }

    renderTurns(session);
    renderResults(session);
    reportSeedDraws(session);
    log('ok', 'Ready. Play in the Game tab, or press Play to end.');
  } catch (err) {
    fail(err);
  } finally {
    setBusy(false);
  }
}

async function playToEnd() {
  const session = state.session;
  if (!session) return log('error', 'Start a run first.');

  setBusy(true, 'Playing to the end...');
  try {
    await session.playToEnd({ onTurn: () => renderTurns(session) });
    renderTurns(session);
    renderResults(session);
    reportSeedDraws(session);

    if (session.finalResults()) {
      log('ok', 'Run finished. Results are in the Results tab.');
      showTab('pane-results');
    } else {
      log('warn', `Ran out of clickable answers at question ${session.temp.question_number + 1} without reaching the end. `
        + `question_count is ${session.temp.global_parameter_json?.[0]?.fields?.question_count}. `
        + `Election night fires on strict equality, so a CYOA jump that overshoots will hang here.`);
    }
  } catch (err) {
    fail(err);
  } finally {
    setBusy(false);
  }
}

function reportSeedDraws(session) {
  if (session.rng) {
    log('info', `Seeded stream: ${session.rng.draws} random values drawn so far (seed ${session.rng.seed}).`);
  }
}

async function dumpResults() {
  const session = state.session;
  if (!session) return log('error', 'Nothing to dump.');

  setBusy(true, 'Writing dump...');
  try {
    const dump = buildDump({
      session,
      mod: state.mod,
      seed: currentSeed(),
      engineVersion: state.engineVersion,
      label: $('dump-name').value.trim() || 'run',
    });

    const result = await writeDump($('dump-name').value.trim() || 'run', dump);
    log('ok', `Wrote ${result.file} (${result.bytes.toLocaleString()} bytes).`);
    $('dump-hint').innerHTML = `Last written: <code>${escapeHtml(result.file)}</code>. Diff two of them with <code>diff runs/a.json runs/b.json</code>.`;
  } catch (err) {
    // Fall back to a download so a dump is never lost to a server problem.
    log('warn', `Server write failed (${err.message}); falling back to a browser download.`);
    try {
      const dump = buildDump({
        session, mod: state.mod, seed: currentSeed(), engineVersion: state.engineVersion, label: 'run',
      });
      const blob = new Blob([stableStringify(dump)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${$('dump-name').value.trim() || 'run'}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err2) {
      fail(err2);
    }
  } finally {
    setBusy(false);
  }
}

/* ---------------------------------------------------------------- boot */

$('btn-reload').addEventListener('click', reloadAndValidate);
$('btn-start').addEventListener('click', startRun);
$('btn-play-end').addEventListener('click', playToEnd);
$('btn-dump').addEventListener('click', dumpResults);
$('mod-select').addEventListener('change', () => { state.mod = null; reloadAndValidate(); });
$('deterministic').addEventListener('change', () => {
  $('seed').disabled = !$('deterministic').checked;
});

/* ---------------------------------------------------------------- auto-reload */

let watchedSignature = null;

function signatureFor(mod) {
  if (!mod) return '';
  const parts = [mod.files?.[1], mod.files?.[2], mod.files?.[3]];
  return parts.map((file) => file ? `${file.mtime}:${file.bytes}` : 'missing').join('|');
}

async function checkForSavedEdits() {
  if (state.busy) return;
  try {
    const selected = $('mod-select').value;
    if (!selected) return;
    const mods = await listMods();
    const selectedMod = mods.find((mod) => mod.name === selected);
    const next = signatureFor(selectedMod);
    if (watchedSignature === null) {
      watchedSignature = next;
      return;
    }
    if (next !== watchedSignature) {
      watchedSignature = next;
      log('info', 'Saved edit detected. Reloading and validating Code 1 / Code 2…');
      await reloadAndValidate();
      if (state.session) {
        log('info', 'Current game remains on the prior build. Click Start run for a clean run with the saved edit.');
      }
    }
  } catch (err) {
    // A half-written file is normal during an editor save; the next poll retries.
    log('warn', `Auto-reload check skipped: ${err.message}`);
  }
}

setInterval(checkForSavedEdits, 1250);

(async function main() {
  initFromUrl();
  await loadEngineVersion();
  try {
    await loadModList();
    if (state.mods.length) await reloadAndValidate();
  } catch (err) {
    fail(err);
  }
  log('info', 'Edit a mod file and press Reload & validate, or just refresh the page.');
}());
