/* learn.js — "teach a sign": capture, template building and matching. Pure logic, no DOM, unit-tested.

   Why this is more reliable than "tap Record three times":
   - capture is automatic: the hand must be STEADY, and bad frames are discarded instead of averaged in
   - three separate rounds (lower the hand in between) so the template covers natural variation
   - rounds that disagree with each other are rejected up front ("your 3 attempts looked different")
   - the match threshold is per sign, derived from how consistent the person actually is
   - matching needs a margin over the runner-up, so two similar taught signs can't flip-flop
   - saving checks for collisions with other taught signs before it can hurt recognition */

import { ZONE_GROUP } from "./engine.js";

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* wrist-origin, hand-size-normalised landmarks (hand distance from the camera cancels out) */
export function lmNormalize(lm) {
  const w = lm[0];
  const s = dist2(lm[0], lm[9]) || 1;
  return lm.map(p => ({ x: (p.x - w.x) / s, y: (p.y - w.y) / s }));
}
/* hand size in image units: used to reject hands that are too far away to read reliably */
export function handSize(lm) { return dist2(lm[0], lm[9]); }

export function lmDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += dist2(a[i], b[i]);
  return s / a.length;
}
/* Matching distance. The plain mean is blind to a single finger changing (4 of 21 points), so it is blended with the
   mean of the 6 worst landmarks: uniform jitter barely moves it, a different thumb or finger does. */
export function shapeDistance(a, b) {
  const ds = [];
  for (let i = 0; i < a.length; i++) ds.push(dist2(a[i], b[i]));
  const mean = ds.reduce((t, d) => t + d, 0) / ds.length;
  ds.sort((x, y) => y - x);
  const worst = ds.slice(0, 6).reduce((t, d) => t + d, 0) / 6;
  return Math.max(mean, 0.8 * worst);
}
/* where on the face a sign was made is part of the sign. Same group (e.g. nose vs cheek) is forgiven; a different part
   of the face/body is not, so a taught sign can't hijack a built-in that merely shares its handshape elsewhere. */
export const zoneCost = (saved, now) => {
  if (!saved || !now || saved === "any" || now === "any" || saved === now) return 0;
  return ZONE_GROUP[saved] === ZONE_GROUP[now] ? 0.04 : 0.3;
};

export function meanVector(vs) {
  return vs[0].map((_, i) => ({
    x: vs.reduce((t, v) => t + v[i].x, 0) / vs.length,
    y: vs.reduce((t, v) => t + v[i].y, 0) / vs.length,
  }));
}

export const THR_MIN = 0.2, THR_MAX = 0.32, LEGACY_THR = 0.26, AMBIGUITY_MARGIN = 0.025;

/* ---------- guided capture ----------
   states: idle -> waitHand -> capturing -> between -> (capturing ...) -> done | failed
   feed(lm, zone, t) is called every frame with the primary hand's landmarks (or null). */
export class Teacher {
  constructor(opts = {}) {
    this.rounds = opts.rounds ?? 3;
    this.perRound = opts.perRound ?? 7;          // steady frames needed per round
    this.frameGapMs = opts.frameGapMs ?? 90;
    this.steadyMax = opts.steadyMax ?? 0.06;     // max frame-to-frame change (normalised units) to count as steady
    this.moveMax = opts.moveMax ?? 0.25;         // max wrist travel per frame, in hand-sizes (a hand sweeping through is not a pose)
    this.minSize = opts.minSize ?? 0.06;         // smallest acceptable hand size
    this.settleMs = opts.settleMs ?? 350;        // steady time before frames count
    this.betweenMs = opts.betweenMs ?? 600;      // hand must be away this long between rounds
    this.maxRoundSpread = opts.maxRoundSpread ?? 0.3;
    this.reset();
  }
  reset() {
    this.state = "idle"; this.roundIdx = 0; this.roundMeans = []; this.roundZones = [];
    this.frames = []; this.zones = []; this.prev = null; this.prevWrist = null; this.steadySince = 0; this.lastFrameAt = 0; this.goneSince = 0;
    this.message = ""; this.progress = 0; this.result = null;
  }
  start() { this.reset(); this.state = "waitHand"; this.message = "Show your sign to the camera"; this.goneSince = 0; }
  cancel() { this.reset(); }
  get active() { return this.state === "waitHand" || this.state === "capturing" || this.state === "between"; }

  feed(lm, zone, t) {
    if (!this.active) return this.state;
    const hasHand = !!lm;
    if (this.state === "between") {
      if (!hasHand) {
        this.prevWrist = null;
        if (!this.goneSince) this.goneSince = t;
        this.message = "Good — now show the same sign again";
        if (t - this.goneSince >= this.betweenMs) { this.state = "waitHand"; this.prev = null; this.steadySince = 0; }
      } else { this.goneSince = 0; this.message = "Lower your hand for a moment, then show it again"; }
      return this.state;
    }
    if (!hasHand) {                                          // lost the hand mid-round: restart this round only
      this.frames = []; this.zones = []; this.prev = null; this.steadySince = 0; this.progress = 0;
      this.state = "waitHand"; this.message = "Show your sign to the camera";
      return this.state;
    }
    if (handSize(lm) < this.minSize) {
      this.frames = []; this.zones = []; this.prev = null; this.steadySince = 0; this.progress = 0;
      this.state = "waitHand"; this.message = "Move your hand a little closer";
      return this.state;
    }
    const n = lmNormalize(lm);
    const moved = this.prev ? lmDistance(n, this.prev) : 0;
    const travelled = this.prevWrist ? dist2(lm[0], this.prevWrist) / (handSize(lm) || 1) : 0;
    this.prev = n; this.prevWrist = { x: lm[0].x, y: lm[0].y };
    if (moved > this.steadyMax || travelled > this.moveMax) {                            // moving: not a sign pose yet
      this.frames = []; this.zones = []; this.steadySince = 0; this.progress = 0;
      this.state = "waitHand"; this.message = "Hold it still";
      return this.state;
    }
    if (!this.steadySince) this.steadySince = t;
    if (t - this.steadySince < this.settleMs) { this.state = "waitHand"; this.message = "Hold it still"; return this.state; }

    this.state = "capturing"; this.message = "Hold…";
    if (t - this.lastFrameAt >= this.frameGapMs) {
      this.frames.push(n); this.zones.push(zone || null); this.lastFrameAt = t;
      this.progress = this.frames.length / this.perRound;
    }
    if (this.frames.length >= this.perRound) this._finishRound(t);
    return this.state;
  }

  _finishRound(t) {
    this.roundMeans.push(meanVector(this.frames));
    this.roundZones.push(modeZone(this.zones));
    this.frames = []; this.zones = []; this.prev = null; this.steadySince = 0; this.progress = 0;
    this.roundIdx++;
    if (this.roundIdx >= this.rounds) { this._finish(); return; }
    this.state = "between"; this.goneSince = 0; this.message = "Got it. Lower your hand, then show it again";
  }

  _finish() {
    const spread = maxPairDistance(this.roundMeans);
    if (spread > this.maxRoundSpread) {
      this.state = "failed";
      this.result = { ok: false, reason: "inconsistent", spread };
      this.message = "Your attempts looked different from each other. Pick one clear hand shape and try again.";
      return;
    }
    const overall = meanVector(this.roundMeans);
    const zone = modeZone(this.roundZones);
    this.state = "done";
    this.result = {
      ok: true, spread, zone,
      samples: [overall, ...this.roundMeans],
      thr: thresholdFor(spread),
    };
    this.message = "Captured!";
  }
}

export function maxPairDistance(vs) {
  let m = 0;
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) m = Math.max(m, shapeDistance(vs[i], vs[j]));
  return m;
}
export function thresholdFor(spread) { return Math.max(THR_MIN, Math.min(THR_MAX, 0.16 + spread * 1.4)); }

export function modeZone(arr) {
  const c = {};
  let best = null, n = 0;
  for (const z of arr) { if (!z) continue; c[z] = (c[z] || 0) + 1; if (c[z] > n) { n = c[z]; best = z; } }
  return best;
}

/* ---------- stored signs ----------
   current shape: { word, samples:[[{x,y}x21], ...], thr, zone, v:2 }
   legacy shape (earlier builds): { word, landmarks:[{x,y}x21], zone } -> upgraded on load */
export function upgradeSign(s) {
  if (!s || typeof s.word !== "string") return null;
  if (Array.isArray(s.samples) && s.samples.length && Array.isArray(s.samples[0]) && s.samples[0].length === 21) {
    return { word: s.word, samples: s.samples, thr: s.thr || LEGACY_THR, zone: s.zone || null, v: 2 };
  }
  if (Array.isArray(s.landmarks) && s.landmarks.length === 21) {
    return { word: s.word, samples: [s.landmarks], thr: LEGACY_THR, zone: s.zone || null, v: 2 };
  }
  return null;
}
export function upgradeAll(arr) { return (Array.isArray(arr) ? arr : []).map(upgradeSign).filter(Boolean); }

/* distance from a live (normalised) hand to a sign: nearest stored sample, plus a soft penalty for the wrong face zone */
export function signDistance(norm, sign, zone, useZone = true) {
  let d = Infinity;
  for (const s of sign.samples) d = Math.min(d, shapeDistance(norm, s));
  return d + (useZone ? zoneCost(sign.zone, zone) : 0);
}

/* returns { sign, d, conf } or null. Needs to beat the sign's own threshold AND the runner-up by a margin. */
export function matchCustom(norm, signs, zone, useZone = true) {
  let best = null, bestD = Infinity, second = Infinity;
  for (const sign of signs) {
    const d = signDistance(norm, sign, zone, useZone);
    if (d < bestD) { second = bestD; bestD = d; best = sign; }
    else if (d < second) second = d;
  }
  if (!best || bestD >= best.thr) return null;
  if (second - bestD < AMBIGUITY_MARGIN && second < Infinity) return null;
  return { sign: best, d: bestD, conf: Math.max(0.4, Math.min(1, 1 - bestD / (best.thr * 1.25))) };
}

/* before saving: is the new sign too close to a different taught sign? (same word = replacement, ignored) */
export function findCollision(candidate, signs) {
  const others = signs.filter(s => s.word.toLowerCase() !== candidate.word.toLowerCase());
  let worst = null, worstD = Infinity;
  for (const o of others) {
    let d = Infinity;
    for (const a of candidate.samples) for (const b of o.samples) d = Math.min(d, shapeDistance(a, b));
    d += zoneCost(candidate.zone, o.zone);
    const limit = Math.min(candidate.thr, o.thr) * 0.85;
    if (d < limit && d < worstD) { worstD = d; worst = o; }
  }
  return worst ? { word: worst.word, d: worstD } : null;
}

export function cleanName(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 20);
}

/* =====================================================================================================
   Learn mode: live coaching against a built-in sign, a practice game, and shareable sign packs.
   ===================================================================================================== */

/* what each handshape needs, per finger: E extended · C curved · F folded · N not extended (C or F) · . don't care.
   thumb: E out · T touching the index tip · N not out · . don't care. */
export const SHAPE_SPEC = {
  fist:       { I: "N", M: "N", R: "N", P: "N", T: "N" },
  thumbsUp:   { I: "N", M: "N", R: "N", P: "N", T: "E" },
  thumbsDown: { I: "N", M: "N", R: "N", P: "N", T: "E" },
  flat:       { I: "E", M: "E", R: "E", P: "E", T: "." },
  five:       { I: "E", M: "E", R: "E", P: "E", T: "E" },
  four:       { I: "E", M: "E", R: "E", P: "E", T: "N" },
  point:      { I: "E", M: "N", R: "N", P: "N", T: "N" },
  lShape:     { I: "E", M: "N", R: "N", P: "N", T: "E" },
  peace:      { I: "E", M: "E", R: "N", P: "N", T: "." },
  uShape:     { I: "E", M: "E", R: "N", P: "N", T: "." },
  three:      { I: "E", M: "E", R: "E", P: "N", T: "." },
  pinky:      { I: "N", M: "N", R: "N", P: "E", T: "N" },
  callMe:     { I: "N", M: "N", R: "N", P: "E", T: "E" },
  rockOn:     { I: "E", M: "N", R: "N", P: "E", T: "N" },
  iLoveYou:   { I: "E", M: "N", R: "N", P: "E", T: "E" },
  ok:         { I: ".", M: "E", R: "E", P: "E", T: "T" },
  pinchI:     { I: ".", M: "N", R: "N", P: "N", T: "T" },
  oShape:     { I: "C", M: "C", R: "C", P: "C", T: "T" },
  cShape:     { I: "C", M: "C", R: "C", P: "C", T: "E" },
  claw:       { I: "C", M: "C", R: "C", P: "C", T: "." },
  hook:       { I: "C", M: "F", R: "F", P: "F", T: "." }
};
const FINGER_NAME = { I: "index finger", M: "middle finger", R: "ring finger", P: "little finger" };

/* a = analyzeHand() output for one hand. Returns { pct, hints:[string] } for the target handshape (lexicon name). */
export function coachShape(a, target) {
  const spec = SHAPE_SPEC[target];
  if (!a || !spec) return { pct: 0, hints: [] };
  let need = 0, got = 0; const hints = [];
  for (const k of ["I", "M", "R", "P"]) {
    const w = spec[k]; if (w === ".") continue; need++;
    const s = a.fs[k];
    const ok = w === "N" ? s !== "E" : s === w;
    if (ok) { got++; continue; }
    if (w === "E") hints.push(`Straighten your ${FINGER_NAME[k]}`);
    else if (w === "F") hints.push(`Curl your ${FINGER_NAME[k]} in tight`);
    else if (w === "C") hints.push(`Gently curve your ${FINGER_NAME[k]}`);
    else hints.push(`Fold your ${FINGER_NAME[k]} down`);
  }
  if (spec.T !== ".") {
    need++;
    const touching = a.touch && a.touch.I < 0.45;
    const ok = spec.T === "E" ? a.thumb === "E" : spec.T === "N" ? a.thumb !== "E" : touching;
    if (ok) got++;
    else hints.push(spec.T === "E" ? "Stick your thumb out" : spec.T === "N" ? "Tuck your thumb in" : "Touch your thumb to your index fingertip");
  }
  if ((target === "thumbsUp" || target === "thumbsDown") && a.thumb === "E") {
    const want = target === "thumbsUp" ? "up" : "down";
    if (a.thumbDir !== want) hints.push(`Point your thumb ${want}`);
  }
  return { pct: need ? got / need : 0, hints: hints.slice(0, 2) };
}

/* full coaching for a lexicon sign: shape first, then place on the face, then the movement.
   hands: [analyzeHand output...] (1 or 2); zone: current zone of the primary hand; motion: current motion class. */
export function coachSign(sign, hands, zone, motion, texts = {}) {
  if (!sign) return { stage: "none", pct: 0, hints: [], ready: false };
  if (!hands.length) return { stage: "show", pct: 0, hints: ["Show your hand to the camera"], ready: false };
  if (hands.length < sign.h) return { stage: "hands", pct: 0.2, hints: [`This sign uses ${sign.h} hands`], ready: false };
  let pct = 0; const hints = [];
  if (sign.h === 1) { const c = coachShape(hands[0], sign.s[0]); pct = c.pct; hints.push(...c.hints); }
  else {
    const c1 = [coachShape(hands[0], sign.s[0]), coachShape(hands[1], sign.s[1])];
    const c2 = [coachShape(hands[0], sign.s[1]), coachShape(hands[1], sign.s[0])];
    const best = (c1[0].pct + c1[1].pct) >= (c2[0].pct + c2[1].pct) ? c1 : c2;
    pct = (best[0].pct + best[1].pct) / 2; hints.push(...best[0].hints, ...best[1].hints);
  }
  if (pct < 0.999) return { stage: "shape", pct, hints: hints.slice(0, 2), ready: false };
  if (sign.z !== "any" && zone && zone !== sign.z && ZONE_GROUP[zone] !== ZONE_GROUP[sign.z]) {
    return { stage: "place", pct: 0.7, hints: [`Move your hand to ${(texts.zone && texts.zone[sign.z]) || "the right spot"}`], ready: false };
  }
  if (sign.m !== "idle" && motion !== sign.m) {
    return { stage: "motion", pct: 0.85, hints: [`Now: ${(texts.motion && texts.motion[sign.m]) || sign.m}`], ready: false };
  }
  return { stage: "good", pct: 1, hints: ["That's it!"], ready: true };
}

/* ---------- practice game ---------- */
export class PracticeGame {
  /* pool: array of words to be asked. rnd: injectable for tests. */
  constructor(pool, { rounds = 10, rnd = Math.random } = {}) {
    this.pool = pool.slice(); this.rounds = rounds; this.rnd = rnd; this.reset();
  }
  reset() { this.score = 0; this.streak = 0; this.best = 0; this.asked = 0; this.missed = []; this.current = null; this.over = false; this.history = []; }
  next() {
    if (this.asked >= this.rounds) { this.over = true; this.current = null; return null; }
    let w, guard = 0;
    do { w = this.pool[Math.floor(this.rnd() * this.pool.length)]; } while (w === this.current && this.pool.length > 1 && ++guard < 20);
    this.current = w; this.asked++; return w;
  }
  /* word = what the recognizer saw (or null on timeout/skip) */
  answer(word) {
    if (!this.current) return null;
    const ok = word === this.current;
    if (ok) { this.score += 10 + Math.min(this.streak, 5) * 2; this.streak++; this.best = Math.max(this.best, this.streak); }
    else { this.streak = 0; this.missed.push(this.current); }
    this.history.push({ word: this.current, ok });
    const r = { ok, expected: this.current, got: word };
    this.current = null;
    return r;
  }
  get accuracy() { const n = this.history.length; return n ? this.history.filter(h => h.ok).length / n : 0; }
}

/* ---------- sign packs (export / import) ---------- */
const PACK_KIND = "signbridge-pack";
const ZONES_OK = new Set(["overHead", "forehead", "eyes", "nose", "cheek", "ear", "mouth", "chin", "neck", "chest", "any"]);
export function exportPack(signs, { author = "" } = {}) {
  return JSON.stringify({
    kind: PACK_KIND, v: 1, created: new Date().toISOString(), author: String(author).slice(0, 40),
    signs: signs.map(s => ({
      word: s.word, zone: s.zone || null, thr: s.thr,
      samples: s.samples.map(sm => sm.map(p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })))
    }))
  });
}
const finiteNum = n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 20;
/* returns { ok, signs, skipped:[{word,reason}], error } — nothing from the file is trusted */
export function parsePack(text, { existing = [], builtinWords = [] } = {}) {
  if (typeof text !== "string" || text.length > 2_000_000) return { ok: false, signs: [], skipped: [], error: "That file is too large or not text." };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, signs: [], skipped: [], error: "That is not a valid sign pack file." }; }
  if (!j || j.kind !== PACK_KIND || j.v !== 1 || !Array.isArray(j.signs)) return { ok: false, signs: [], skipped: [], error: "That file is not a SignBridge sign pack." };
  const taken = new Set(builtinWords.map(w => w.toUpperCase()));
  const out = [], skipped = [];
  for (const raw of j.signs.slice(0, 100)) {
    const word = cleanName(raw && raw.word);
    if (!word) { skipped.push({ word: "?", reason: "no name" }); continue; }
    if (taken.has(word.toUpperCase())) { skipped.push({ word, reason: "same name as a built-in sign" }); continue; }
    const samples = Array.isArray(raw.samples) ? raw.samples.slice(0, 6) : [];
    const validSamples = samples.every(sm => Array.isArray(sm) && sm.length === 21 && sm.every(p => p && finiteNum(p.x) && finiteNum(p.y)));
    if (!samples.length || !validSamples) { skipped.push({ word, reason: "damaged hand data" }); continue; }
    const thr = Number.isFinite(raw.thr) ? Math.max(0.15, Math.min(0.35, raw.thr)) : LEGACY_THR;
    const zone = ZONES_OK.has(raw.zone) ? raw.zone : null;
    const cand = { word, samples: samples.map(sm => sm.map(p => ({ x: p.x, y: p.y }))), thr, zone, v: 2 };
    const clash = findCollision(cand, [...existing.filter(e => e.word.toLowerCase() !== word.toLowerCase()), ...out]);
    if (clash) { skipped.push({ word, reason: `looks too much like “${clash.word}”` }); continue; }
    out.push(cand);
  }
  return { ok: true, signs: out, skipped, error: "" };
}
export function mergePack(existing, incoming) {
  const names = new Set(incoming.map(s => s.word.toLowerCase()));
  return [...existing.filter(s => !names.has(s.word.toLowerCase())), ...incoming];
}
