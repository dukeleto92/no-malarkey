/* Tune the GOP nominees by the runs that actually summon them.

   Usage:  node tools/baseline/measure-nominees.js [--runs N] [--seed S]   (report)
           node tools/baseline/measure-nominees.js --write                 (solve, write strengths into Code 1)

   1. Plays N runs through the real game: Code 1's own cyoAdventure, jumps
      and all, until the engine's end condition (question_number ===
      question_count). The cascade fires inside the run exactly as it does
      in play, so every run ends holding its nominee and its final record.
      Each run is played at one of SKILLS: the chance, per question, that
      the player AIMS — takes the answer nmPreviewAnswer (the Benefit
      Checker's own dry run) says leaves delivery highest — instead of
      picking uniformly.
   2. Groups the runs by nominee. For each, a run is a WIN if the model gives
      Biden 270 at Normal difficulty with no visits, against that nominee's
      profile.
   3. Bisects each nominee's `strength` until his win rate on his own runs
      lands on his `target_win_rate`.

   The skill mix is a proxy for players, not a model of them. Uniform play
   alone fails 63% of presidencies and reaches Jeb's +11 in 0.2% of runs, so
   it cannot tune the top of the cascade at all; the aiming runs are what
   give the good end of the ledger a population. */

const fs = require("fs");
const path = require("path");
const model = require("./model");

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const RUNS = argVal("--runs", 40000);
const SEED = argVal("--seed", 1);
const SOLVE_CAP = 3000;            // runs per nominee used in the bisection
const SKILLS = [0, 0.5, 0.9];      // equal shares of runs at each
const STRENGTH_RANGE = [0.70, 1.40];

const ctx = model.load();
const t = ctx.campaignTrail_temp;

// mulberry32, so a report is reproducible
let seed = SEED >>> 0;
const vmMath = model.evalIn(ctx, "Math");
vmMath.random = function () {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

const pristine = JSON.stringify({
    cis: t.candidate_issue_score_json, csm: t.candidate_state_multiplier_json,
    cj: t.candidate_json, fb: t.answer_feedback_json,
});
function resetData() {
    const p = JSON.parse(pristine);
    t.candidate_issue_score_json = p.cis;
    t.candidate_state_multiplier_json = p.csm;
    t.candidate_json = p.cj;
    t.answer_feedback_json = p.fb;
}

const answersByQuestion = {};
for (const a of t.answers_json) (answersByQuestion[a.fields.question] = answersByQuestion[a.fields.question] || []).push(a.pk);
const questionCount = t.global_parameter_json[0].fields.question_count;

function aimedPick(options) {
    let best = -Infinity, picks = [];
    for (const pk of options) {
        const p = ctx.nmPreviewAnswer(pk);
        const d = p ? p.after.delivery : -Infinity;
        if (d > best) { best = d; picks = [pk]; } else if (d === best) picks.push(pk);
    }
    return picks[Math.floor(vmMath.random() * picks.length)];
}

function playRun(skill) {
    resetData();
    model.setRecord(ctx, {});
    t.player_answers = [];
    t.question_number = 0;
    for (let steps = 0; steps < 40 && t.question_number < questionCount; steps++) {
        const q = t.questions_json[t.question_number];
        const options = answersByQuestion[q.pk];
        const pick = vmMath.random() < skill ? aimedPick(options)
            : options[Math.floor(vmMath.random() * options.length)];
        t.player_answers.push(pick);
        ctx.cyoAdventure();
        t.question_number++;
    }
    if (t.question_number !== questionCount) throw new Error("run did not reach election night");
    return { record: JSON.parse(JSON.stringify(ctx.nm)), nominee: ctx.nm.gop_nominee };
}

// --- 1. sample ---------------------------------------------------------------
const byNominee = {};
for (let i = 0; i < RUNS; i++) {
    const r = playRun(SKILLS[i % SKILLS.length]);
    (byNominee[r.nominee] = byNominee[r.nominee] || []).push(r.record);
}

// --- 2/3. score and solve ----------------------------------------------------
function winRate(row, strength, records) {
    resetData();
    ctx.nmApplyProfile(Object.assign({}, row, { strength }));
    let wins = 0;
    for (const rec of records) {
        model.setRecord(ctx, rec);
        t.player_answers = [model.CARRIER_ANSWER];
        ctx.nmSyncElectorate();
        if (model.project(ctx).demEV >= 270) wins++;
    }
    return wins / records.length;
}

function solve(row, records) {
    let lo = STRENGTH_RANGE[0], hi = STRENGTH_RANGE[1];
    if (winRate(row, lo, records) < row.target_win_rate) return { strength: lo, capped: true };
    if (winRate(row, hi, records) > row.target_win_rate) return { strength: hi, capped: true };
    for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (winRate(row, mid, records) > row.target_win_rate) lo = mid; else hi = mid;
    }
    return { strength: Number(((lo + hi) / 2).toFixed(3)), capped: false };
}

const write = args.includes("--write");
let src = fs.readFileSync(path.join(model.ROOT, "Code 1"), "utf8");
console.log(`${RUNS} runs, seed ${SEED}, aiming ${SKILLS.join(" / ")}. Win = 270+ EV at Normal difficulty, no visits.\n`);
console.log("nominee     runs   share  target   now (strength)   solved   -> win rate");
for (const row of ctx.NM_GOP_ROSTER) {
    const all = byNominee[row.key] || [];
    const share = (100 * all.length / RUNS).toFixed(1) + "%";
    if (all.length < 30) {
        console.log(`${row.last_name.padEnd(10)}${String(all.length).padStart(6)}  ${share.padStart(6)}   too few runs to tune; strength left at ${row.strength}`);
        continue;
    }
    const records = all.length > SOLVE_CAP ? all.filter((_, i) => i % Math.ceil(all.length / SOLVE_CAP) === 0) : all;
    const now = winRate(row, row.strength, records);
    const s = solve(row, records);
    const got = winRate(row, s.strength, records);
    console.log(`${row.last_name.padEnd(10)}${String(all.length).padStart(6)}  ${share.padStart(6)}   ${row.target_win_rate.toFixed(2)}   ${(100 * now).toFixed(0).padStart(3)}% (${row.strength.toFixed(3)})   ${s.strength.toFixed(3)}   ${(100 * got).toFixed(0)}%` +
        (s.capped ? "   (hit the strength bound: the target is out of reach for this profile)" : ""));
    const re = new RegExp('(key: "' + row.key + '"[\\s\\S]*?strength: )[0-9.]+');
    src = src.replace(re, "$1" + s.strength.toFixed(3));
}
if (write) {
    fs.writeFileSync(path.join(model.ROOT, "Code 1"), src);
    console.log("\nWrote strengths into Code 1.");
} else {
    console.log("\nReport only. Re-run with --write to store the solved strengths.");
}
