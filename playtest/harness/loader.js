/* =============================================================================
 * Mod loading
 *
 * Two responsibilities, kept apart on purpose:
 *
 *   fetchMod()      pulls Code 1 / Code 2 / Code 3 off disk, uncached.
 *   inspectMod()    executes them in a throwaway sandbox to produce a
 *                   campaignTrail_temp for the validator, WITHOUT touching the
 *                   real game.
 *
 * inspectMod exists because Code 2 only runs at game start in the real engine
 * (the questionset has to load first), and you want validation errors before
 * you start playing rather than after. The sandbox is a read-only preview; the
 * authoritative run is always the real engine driven by runner.js.
 *
 * Nothing here knows anything about any particular mod.
 * ============================================================================= */

'use strict';

export async function listMods() {
  const res = await fetch('/api/mods', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/api/mods returned ${res.status}`);
  const data = await res.json();
  return data.mods || [];
}

async function fetchOne(modName, which) {
  const res = await fetch(`/api/mod/${encodeURIComponent(modName)}/${which}`, { cache: 'no-store' });

  if (res.status === 204) return null; // optional file absent (Code 3)
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* not json */ }
    throw new Error(`Code ${which}: ${detail || res.statusText}`);
  }

  return {
    text: await res.text(),
    bytes: Number(res.headers.get('X-Mod-Bytes')) || 0,
    mtime: Number(res.headers.get('X-Mod-Mtime')) || 0,
    path: res.headers.get('X-Mod-Path') || '',
  };
}

export async function fetchMod(modName) {
  const [code1, code2, code3] = await Promise.all([
    fetchOne(modName, 1),
    fetchOne(modName, 2),
    fetchOne(modName, 3).catch(() => null),
  ]);
  return { name: modName, code1, code2, code3 };
}

/* ---------------------------------------------------------------- sandbox */

// A permissive stand-in for anything Code 1's styling block reaches for.
// Every property access returns another one of these, every call returns one
// too, so `document.getElementsByClassName("game_header")[0].style.background =`
// resolves without throwing and without doing anything.
function makeVoid(name = 'void') {
  const target = function voidFn() { return makeVoid(`${name}()`); };
  target.__void = name;

  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => '';
      }
      if (prop === Symbol.iterator) {
        return function* iter() { /* empty */ };
      }
      if (prop === '__void') return name;
      if (prop === 'length') return 0;
      // Array-ish indexing: $("#x")[0] must not be undefined.
      return makeVoid(`${name}.${String(prop)}`);
    },
    set() { return true; },
    has() { return true; },
    apply() { return makeVoid(`${name}()`); },
    construct() { return makeVoid(`new ${name}`); },
  });
}

/**
 * Run Code 1 then Code 2 against a fresh campaignTrail_temp, in the same order
 * the real loader uses, and hand back the resulting data plus whatever went
 * wrong. Errors are captured rather than thrown: Code 1's data assignments all
 * happen before its DOM block, so even if the styling throws we still get the
 * data and can validate it.
 */
export function inspectMod(mod) {
  const temp = {};
  const problems = [];

  const ctx = {
    campaignTrail_temp: temp,
    window: makeVoid('window'),
    document: makeVoid('document'),
    $: makeVoid('$'),
    jQuery: makeVoid('jQuery'),
    nct_stuff: makeVoid('nct_stuff'),
    console: { log() {}, warn() {}, error() {}, info() {} },
  };

  const runStage = (label, code) => {
    if (!code) return;
    try {
      // Same shape as the engine's executeMod: one Function body, so `var` and
      // `function` declarations stay closure-scoped exactly as they do live.
      // eslint-disable-next-line no-new-func
      const fn = new Function(...Object.keys(ctx), code);
      fn(...Object.values(ctx));
    } catch (err) {
      problems.push({
        stage: label,
        message: err && err.message ? err.message : String(err),
        line: extractLine(err),
      });
    }
  };

  runStage('Code 1', mod.code1 && mod.code1.text);
  runStage('Code 2', mod.code2 && mod.code2.text);

  return { temp, problems };
}

function extractLine(err) {
  if (!err || !err.stack) return null;
  // Anonymous Function bodies report as "<anonymous>:LINE:COL". The line number
  // is offset by the Function wrapper, so it is indicative not exact.
  const m = err.stack.match(/<anonymous>:(\d+):(\d+)/);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : null;
}
