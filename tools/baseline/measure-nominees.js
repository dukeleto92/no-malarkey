/* How hard is each GOP nominee? Runs every NM_GOP_ROSTER profile through
   Code 1's own nmApplyNominee and the engine model.

   Usage:  node tools/baseline/measure-nominees.js            (report)
           node tools/baseline/measure-nominees.js --solve    (report + solved strengths)
           node tools/baseline/measure-nominees.js --write    (solve and write strengths into Code 1)

   A profile's issues and regions set the SHAPE of a nominee's map; his
   `strength` sets the LEVEL. --solve finds, for each nominee, the strength
   that puts his break-even on its `break_even` target, so the issue vector
   can be authored for regional texture without accidentally making
   someone ten points stronger than intended.

   BREAK-EVEN is the headline number: starting from the start-of-term
   record, how many points of `delivery` (each worth +0.02 national
   standing, about half a point of vote share) the player needs before
   Biden reaches 270 against that nominee. Negative means Biden wins even
   with that much delivery taken away. It is a one-dimensional read of
   difficulty; the scenario columns show the whole record moving. */

const model = require("./model");
const scenarios = require("./scenarios");

const ctx = model.load();
const t = ctx.campaignTrail_temp;
const pristine = JSON.parse(JSON.stringify({
    cis: t.candidate_issue_score_json, csm: t.candidate_state_multiplier_json, cj: t.candidate_json,
}));
function reset() {
    t.candidate_issue_score_json = JSON.parse(JSON.stringify(pristine.cis));
    t.candidate_state_multiplier_json = JSON.parse(JSON.stringify(pristine.csm));
    t.candidate_json = JSON.parse(JSON.stringify(pristine.cj));
}

function evAt(delivery) {
    model.setRecord(ctx, { delivery });
    return model.project(ctx).demEV;
}
function breakEven() {
    let lo = -12, hi = 12;
    if (evAt(lo) >= 270) return -Infinity;
    if (evAt(hi) < 270) return Infinity;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (evAt(mid) >= 270) hi = mid; else lo = mid; }
    return hi;
}

function solveStrength(entry) {
    const original = entry.strength;
    let lo = 0.8, hi = 1.25;
    const beAt = (k) => { reset(); entry.strength = k; ctx.nmApplyNominee(entry); return breakEven(); };
    for (let i = 0; i < 25; i++) { const mid = (lo + hi) / 2; if (beAt(mid) < entry.break_even) lo = mid; else hi = mid; }
    entry.strength = original;
    return Number(((lo + hi) / 2).toFixed(3));
}

if (process.argv.includes("--solve") || process.argv.includes("--write")) {
    const fs = require("fs"), path = require("path");
    const file = path.join(model.ROOT, "Code 1");
    let src = fs.readFileSync(file, "utf8");
    console.log("Solved strengths (target break-even -> strength):");
    for (const e of ctx.NM_GOP_ROSTER) {
        const k = solveStrength(e);
        console.log("  " + e.last_name.padEnd(10) + String(e.break_even).padStart(6) + "  ->  " + k.toFixed(3) + (k <= 0.81 || k >= 1.24 ? "   (hit the search bound: reshape the issue vector)" : ""));
        e.strength = k;
        const re = new RegExp('(last_name: "' + e.last_name + '",\\s+state: "[^"]*",\\s+gate:[\\s\\S]*?strength: )[0-9.]+');
        src = src.replace(re, "$1" + k.toFixed(3));
    }
    if (process.argv.includes("--write")) { fs.writeFileSync(file, src); console.log("Wrote strengths into Code 1."); }
    console.log("");
}

const SWING = ["PA", "MI", "WI", "FL", "OH", "IA", "NC", "AZ", "GA", "NH", "NV", "MN", "VA", "CO", "TX"];
const names = Object.keys(scenarios);
const rows = [{ label: "generic", entry: null }].concat(ctx.NM_GOP_ROSTER.map((e) => ({ label: e.last_name, entry: e })));

console.log("Start-of-term record unless noted. Normal difficulty.\n");
console.log("nominee     break-even  " + names.map((n) => (n + " EV").padStart(11)).join("") + "    neutral: nat%");
const swingTable = [];
for (const r of rows) {
    reset();
    if (r.entry) ctx.nmApplyNominee(r.entry);
    const be = breakEven();
    const evs = names.map((n) => { model.setRecord(ctx, scenarios[n]); return model.project(ctx).demEV; });
    model.setRecord(ctx, {});
    const p = model.project(ctx);
    const beTxt = Number.isFinite(be) ? (be >= 0 ? "+" : "") + be.toFixed(1) : String(be);
    console.log(r.label.padEnd(12) + beTxt.padStart(10) + "  " + evs.map((v) => String(v).padStart(11)).join("") + "    " + (100 * p.national).toFixed(1));
    swingTable.push([r.label, SWING.map((s) => (100 * (2 * p.states[s].share - 1)).toFixed(1))]);
}

console.log("\nNeutral-record Dem margin in the swing states:");
console.log("".padEnd(10) + SWING.map((s) => s.padStart(6)).join(""));
for (const [label, vals] of swingTable) console.log(label.padEnd(10) + vals.map((v) => v.padStart(6)).join(""));
