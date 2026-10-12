/* hands.js — everything between "21 landmarks per hand" and "a named handshape / motion". Pure logic, unit-tested.

   Why this replaces the old classifier:
   - the old finger test compared raw image-y values, so it only worked for hands held perfectly upright; any tilt or
     sideways hand produced random shapes. Everything here is rotation-invariant (joint angles + distances in hand-size units).
   - x/y landmarks are normalised by image width/height, so a 4:3 frame distorts angles; all maths runs in an isotropic space.
   - the two hands are tracked as two stable slots with a short dropout grace, so a hand that flickers out for a few
     frames (very common when the hands are close) no longer breaks a two-handed sign. */

const hyp = Math.hypot;
export const D3 = (a, b) => hyp(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
export const D2 = (a, b) => hyp(a.x - b.x, a.y - b.y);

/* raw MediaPipe landmarks -> mirrored (selfie view), aspect-corrected, isotropic space. y grows downward. */
export function toIso(lm, aspect) {
  return lm.map(p => ({ x: (1 - p.x) * aspect, y: p.y, z: (p.z || 0) * aspect }));
}

const FINGERS = { I: [5, 6, 7, 8], M: [9, 10, 11, 12], R: [13, 14, 15, 16], P: [17, 18, 19, 20] };
const TIPS = { I: 8, M: 12, R: 16, P: 20 };

function angleAt(a, b, c) {            // angle at b between a and c, degrees (180 = straight)
  const ux = a.x - b.x, uy = a.y - b.y, uz = (a.z || 0) - (b.z || 0);
  const vx = c.x - b.x, vy = c.y - b.y, vz = (c.z || 0) - (b.z || 0);
  const m = hyp(ux, uy, uz) * hyp(vx, vy, vz);
  if (!m) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / m))) * 180 / Math.PI;
}

/* E extended · C curved · F folded */
export const DEFAULT_CAL = {
  I: { aExt: 150, aFold: 108, rExt: 1.55, rFold: 1.2 }, M: { aExt: 150, aFold: 108, rExt: 1.55, rFold: 1.2 },
  R: { aExt: 150, aFold: 108, rExt: 1.55, rFold: 1.2 },
  /* the pinky is short, so the same landmark noise bends its angles more: it gets a more forgiving "extended" test */
  P: { aExt: 136, aFold: 108, rExt: 1.4, rFold: 1.2 },
  thumbE: 1.0, thumbF: 0.75
};
function fingerState(p, [mcp, pip, dip, tip], c) {
  const a = (angleAt(p[mcp], p[pip], p[dip]) + angleAt(p[pip], p[dip], p[tip])) / 2;
  const reach = D3(p[tip], p[0]) / (D3(p[mcp], p[0]) || 1);
  let state;
  if (a >= c.aExt && reach >= c.rExt) state = "E";
  else if (a < c.aFold || reach < c.rFold) state = "F";
  else state = "C";
  return { state, angle: a, reach };
}

/* spread between neighbouring extended fingers, degrees (together ≈ 4, spread ≈ 20) */
function spreadOf(p, states) {
  const order = ["I", "M", "R", "P"], angs = [];
  for (let i = 0; i < 3; i++) {
    const a = order[i], b = order[i + 1];
    if (states[a] === "F" || states[b] === "F") continue;           // E and C fingers both fan out (claw vs C-shape)
    const va = dirOf(p[FINGERS[a][0]], p[FINGERS[a][1]]), vb = dirOf(p[FINGERS[b][0]], p[FINGERS[b][1]]);
    angs.push(Math.acos(Math.max(-1, Math.min(1, va.x * vb.x + va.y * vb.y))) * 180 / Math.PI);
  }
  return angs.length ? angs.reduce((t, v) => t + v, 0) / angs.length : 0;
}
function dirOf(a, b) { const x = b.x - a.x, y = b.y - a.y, m = hyp(x, y) || 1; return { x: x / m, y: y / m }; }

/* palm axis direction in the mirrored view: up | right | down | left */
export function dirName(p) {
  const dx = p[9].x - p[0].x, dy = p[9].y - p[0].y;
  const deg = Math.atan2(dx, -dy) * 180 / Math.PI;       // 0 = up, 90 = right
  if (deg > -45 && deg <= 45) return "up";
  if (deg > 45 && deg <= 135) return "right";
  if (deg > -135 && deg <= -45) return "left";
  return "down";
}

/* full per-frame analysis of one hand. `lm` = raw landmarks, `aspect` = videoWidth/videoHeight */
export function analyzeHand(lm, aspect = 4 / 3, cal = DEFAULT_CAL) {
  const p = toIso(lm, aspect);
  const size = D2(p[0], p[9]) || 1e-6;
  const fs = {}, detail = {};
  for (const k of ["I", "M", "R", "P"]) { const r = fingerState(p, FINGERS[k], cal[k] || DEFAULT_CAL[k]); fs[k] = r.state; detail[k] = r; }
  const reach = D3(p[4], p[17]) / (D3(p[0], p[9]) || 1);
  const thumb = reach >= (cal.thumbE ?? 1.0) ? "E" : reach < (cal.thumbF ?? 0.75) ? "F" : "A";            // out · across the palm · alongside
  const touch = {};
  for (const k of ["I", "M", "R", "P"]) touch[k] = D3(p[4], p[TIPS[k]]) / (D3(p[0], p[9]) || 1);
  const spread = spreadOf(p, fs);
  const tdx = p[4].x - p[2].x, tdy = p[4].y - p[2].y, tl = hyp(tdx, tdy) || 1;
  const thumbDir = tdy / tl < -0.6 ? "up" : tdy / tl > 0.6 ? "down" : "side";
  const out = { size, fs, thumb, touch, spread, thumbDir, dir: dirName(p), center: { x: p[9].x, y: p[9].y },
    raw: { I: detail.I, M: detail.M, R: detail.R, P: detail.P, thumbReach: reach } };
  out.shape = classifyShape(out);
  return out;
}

/* handshape names (the vocabulary lexicon.js is written in):
   fist thumbsUp thumbsDown flat five four point lShape peace uShape three pinky callMe iLoveYou rockOn
   ok pinchI oShape cShape claw hook */
export function classifyShape(a) {
  const { fs, thumb, touch, spread } = a;
  const ext = ["I", "M", "R", "P"].filter(k => fs[k] === "E");
  const non = k => fs[k] !== "E";
  const nCurved = ["I", "M", "R", "P"].filter(k => fs[k] === "C").length;
  const nFolded = ["I", "M", "R", "P"].filter(k => fs[k] === "F").length;
  const key = ext.join("");
  const T = thumb === "E";

  const pinching = touch.I < 0.34;
  if (pinching && key === "MRP") return "ok";
  if (pinching && ext.length === 0 && nCurved >= 2 && touch.M < 0.55) return "oShape";
  if (pinching && ext.length === 0) return nFolded >= 2 ? "pinchI" : "oShape";

  if (ext.length === 0) {
    if (nCurved >= 3) return spread > 13 ? "claw" : "cShape";
    if (nCurved >= 3 || (fs.I === "C" && nFolded >= 2 && fs.M !== "F")) return "cShape";
    if (fs.I === "C" && nFolded === 3) return "hook";
    if (T && a.thumbDir === "up") return "thumbsUp";
    if (T && a.thumbDir === "down") return "thumbsDown";
    return "fist";
  }
  switch (key) {
    case "I": return !non("I") && ["M", "R", "P"].every(non) ? (T ? "lShape" : "point") : null;
    case "IM": return spread > 11 ? "peace" : "uShape";
    case "IMR": return ["P"].every(non) ? "three" : null;
    case "IMRP": return spread > 11 ? (T ? "five" : "four") : "flat";
    case "P": return T ? "callMe" : "pinky";
    case "IP": return T ? "iLoveYou" : "rockOn";
    default: return null;
  }
}

/* ---------- two stable hand slots ---------- */
export class HandTracker {
  constructor({ graceMs = 260, alpha = 0.6 } = {}) {
    this.graceMs = graceMs; this.alpha = alpha;
    this.slots = [null, null];          // { lm, seen, held }
  }
  reset() { this.slots = [null, null]; }

  /* hands: array of raw landmark arrays (0-2). Returns [slot0, slot1], each null or { lm, held } */
  update(hands, now) {
    const det = hands.slice(0, 2).map(lm => ({ lm, w: lm[0] }));
    const prev = this.slots;
    const assigned = [null, null];

    if (det.length === 2) {
      if (prev[0] && prev[1]) {                                          // keep identities: minimise total movement
        const straight = D2(det[0].w, prev[0].lm[0]) + D2(det[1].w, prev[1].lm[0]);
        const swapped = D2(det[1].w, prev[0].lm[0]) + D2(det[0].w, prev[1].lm[0]);
        if (straight <= swapped) { assigned[0] = det[0]; assigned[1] = det[1]; } else { assigned[0] = det[1]; assigned[1] = det[0]; }
      } else if (prev[0] || prev[1]) {
        const k = prev[0] ? 0 : 1, o = 1 - k;
        const pick = D2(det[0].w, prev[k].lm[0]) <= D2(det[1].w, prev[k].lm[0]) ? 0 : 1;
        assigned[k] = det[pick]; assigned[o] = det[1 - pick];
      } else {                                                           // fresh: left-in-view first (view is mirrored)
        const sorted = det.slice().sort((a, b) => b.w.x - a.w.x);
        assigned[0] = sorted[0]; assigned[1] = sorted[1];
      }
    } else if (det.length === 1) {
      if (prev[0] && prev[1]) {
        const k = D2(det[0].w, prev[0].lm[0]) <= D2(det[0].w, prev[1].lm[0]) ? 0 : 1;
        assigned[k] = det[0];
      } else if (prev[0] || prev[1]) {
        assigned[prev[0] ? 0 : 1] = det[0];
      } else assigned[0] = det[0];
    }

    for (let i = 0; i < 2; i++) {
      if (assigned[i]) {
        const old = prev[i];
        const lm = old && !old.held ? assigned[i].lm.map((q, j) => ({
          x: old.lm[j].x + (q.x - old.lm[j].x) * this.alpha,
          y: old.lm[j].y + (q.y - old.lm[j].y) * this.alpha,
          z: (old.lm[j].z || 0) + ((q.z || 0) - (old.lm[j].z || 0)) * this.alpha
        })) : assigned[i].lm;
        this.slots[i] = { lm, seen: now, held: false };
      } else if (prev[i] && now - prev[i].seen <= this.graceMs) {
        this.slots[i] = { lm: prev[i].lm, seen: prev[i].seen, held: true };
      } else this.slots[i] = null;
    }
    return this.slots;
  }
}

/* ---------- motion ----------
   Samples are positions in isotropic image units plus hand size; every threshold is in HAND-SIZE units, so it behaves the
   same near or far from the camera. Classes: idle swipeL swipeR swipeU swipeD circle shake pump push pull */
export class MotionTracker {
  constructor(windowMs = 900) { this.win = windowMs; this.buf = []; }
  push(x, y, size, t) {
    this.buf.push({ x, y, s: size, t });
    while (this.buf.length && t - this.buf[0].t > this.win) this.buf.shift();
  }
  reset() { this.buf = []; }
  classify() {
    const b = this.buf;
    if (b.length < 6) return "idle";
    const unit = b.reduce((t, q) => t + q.s, 0) / b.length || 1;
    const last = b[b.length - 1];
    const recent = b.filter(q => last.t - q.t <= 650);
    if (recent.length < 5) return "idle";
    const path = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += hyp(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return L; };
    const pathLen = path(recent) / unit;
    const dx = (last.x - recent[0].x) / unit, dy = (last.y - recent[0].y) / unit;
    const net = hyp(dx, dy);

    /* circle: continuous turning, ends near where it started */
    let turn = 0;
    for (let i = 2; i < recent.length; i++) {
      const v1x = recent[i - 1].x - recent[i - 2].x, v1y = recent[i - 1].y - recent[i - 2].y;
      const v2x = recent[i].x - recent[i - 1].x, v2y = recent[i].y - recent[i - 1].y;
      turn += Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
    }
    if (pathLen >= 1.2 && Math.abs(turn) > 4.2 && net < pathLen * 0.55) return "circle";

    /* back-and-forth: count direction reversals with a minimum stroke length (rejects jitter) */
    const wide = path(b) / unit;
    const rev = axis => {
      let dir = 0, extreme = b[0][axis], count = 0, strokes = 0;
      for (let i = 1; i < b.length; i++) {
        const v = b[i][axis];
        if (dir === 0) { if (Math.abs(v - extreme) / unit >= 0.3) { dir = v > extreme ? 1 : -1; extreme = v; strokes = 1; } continue; }
        if (dir === 1) { if (v > extreme) extreme = v; else if ((extreme - v) / unit >= 0.3) { dir = -1; extreme = v; count++; strokes++; } }
        else { if (v < extreme) extreme = v; else if ((v - extreme) / unit >= 0.3) { dir = 1; extreme = v; count++; strokes++; } }
      }
      return count;
    };
    const rx = rev("x"), ry = rev("y");
    const spanX = (Math.max(...b.map(q => q.x)) - Math.min(...b.map(q => q.x))) / unit;
    const spanY = (Math.max(...b.map(q => q.y)) - Math.min(...b.map(q => q.y))) / unit;
    if (wide >= 1.2 && rx >= 3 && spanX > spanY * 1.2) return "shake";
    if (wide >= 0.8 && ry >= 2 && spanY > spanX * 1.2) return "pump";

    /* toward / away from the camera: the hand grows or shrinks */
    const s0 = recent.slice(0, 3).reduce((t, q) => t + q.s, 0) / 3, s1 = recent.slice(-3).reduce((t, q) => t + q.s, 0) / 3;
    if (net < 1.1 && s1 / s0 > 1.28) return "push";
    if (net < 1.1 && s1 / s0 < 0.78) return "pull";

    if (pathLen < 0.9 || net / pathLen < 0.55 || net < 0.8) return "idle";
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "swipeR" : "swipeL") : (dy > 0 ? "swipeD" : "swipeU");
  }
}

/* two hands: relation + opening/closing, measured in mean hand sizes */
export class PairTracker {
  constructor(windowMs = 600) { this.win = windowMs; this.buf = []; }
  reset() { this.buf = []; }
  /* a, b = analyzeHand outputs; returns { gap, motion } where gap is wrist-to-wrist distance / mean size */
  push(a, b, t) {
    const gap = hyp(a.center.x - b.center.x, a.center.y - b.center.y) / ((a.size + b.size) / 2);
    this.buf.push({ gap, t });
    while (this.buf.length && t - this.buf[0].t > this.win) this.buf.shift();
    let motion = "idle";
    if (this.buf.length >= 5) {
      const g0 = this.buf[0].gap, g1 = gap;
      if (g1 < 1.5 && g0 - g1 > 1.0) motion = "together";
      else if (g1 - g0 > 1.6) motion = "apart";
    }
    return { gap, motion, joined: gap < 1.9 };
  }
}

/* ---------- per-user calibration ----------
   The user shows an open hand and a fist (and a pointing hand to check). From what THEIR fingers measure in those poses
   we set personal "extended" / "folded" thresholds for each finger and for the thumb. The result is only used when it
   re-classifies the calibration poses correctly, so a bad calibration can never make things worse than the defaults. */
const mean = a => a.reduce((t, v) => t + v, 0) / (a.length || 1);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function makeCalibration(openRaws, fistRaws) {
  if (!openRaws.length || !fistRaws.length) return null;
  const cal = { thumbE: DEFAULT_CAL.thumbE, thumbF: DEFAULT_CAL.thumbF, v: 1 };
  for (const k of ["I", "M", "R", "P"]) {
    const oa = mean(openRaws.map(r => r[k].angle)), fa = mean(fistRaws.map(r => r[k].angle));
    const orr = mean(openRaws.map(r => r[k].reach)), fr = mean(fistRaws.map(r => r[k].reach));
    if (!(oa - fa > 40) || !(orr - fr > 0.5)) return null;                         // poses too similar: user did not really open/close
    const D = DEFAULT_CAL[k], pinky = k === "P";
    cal[k] = {
      aExt: clamp(oa - 0.2 * (oa - fa), pinky ? 126 : 138, pinky ? 150 : 162),
      aFold: clamp(oa - 0.62 * (oa - fa), 92, 124),
      rExt: clamp(orr - 0.3 * (orr - fr), pinky ? 1.25 : 1.4, pinky ? 1.6 : 1.8),
      rFold: clamp(orr - 0.7 * (orr - fr), 1.0, 1.35)
    };
  }
  const to = mean(openRaws.map(r => r.thumbReach)), tf = mean(fistRaws.map(r => r.thumbReach));
  if (to - tf > 0.15) { cal.thumbE = clamp(tf + 0.7 * (to - tf), 0.85, 1.15); cal.thumbF = clamp(tf + 0.25 * (to - tf), 0.6, 0.85); }
  return cal;
}
/* does the calibration reproduce the poses the user showed? (open: no folded finger; fist: no extended finger; point: only I extended) */
export function validateCalibration(cal, { open, fist, point }, aspect = 4 / 3) {
  if (!cal) return false;
  const states = (lms) => lms.map(lm => analyzeHand(lm, aspect, cal).fs);
  const okOpen = states(open).every(f => ["I", "M", "R", "P"].every(k => f[k] === "E"));
  const okFist = states(fist).every(f => ["I", "M", "R", "P"].every(k => f[k] !== "E"));
  const okPoint = !point || !point.length || states(point).every(f => f.I === "E" && f.M !== "E" && f.R !== "E" && f.P !== "E");
  return okOpen && okFist && okPoint;
}

/* guided capture for the three calibration poses: a pose counts once the hand is steady for a moment */
export class Calibrator {
  constructor({ poses = ["open", "fist", "point"], perPose = 12, gapMs = 80, steadyMs = 500 } = {}) {
    this.order = poses; this.perPose = perPose; this.gapMs = gapMs; this.steadyMs = steadyMs; this.reset();
  }
  reset() { this.idx = 0; this.data = { open: [], fist: [], point: [] }; this.lms = { open: [], fist: [], point: [] };
    this.state = "idle"; this.steadySince = 0; this.last = 0; this.prev = null; this.result = null; this.msg = ""; }
  start() { this.reset(); this.state = "running"; }
  cancel() { this.reset(); }
  get pose() { return this.order[this.idx]; }
  get progress() { return this.state === "running" ? (this.data[this.pose].length / this.perPose) : this.state === "done" ? 1 : 0; }
  get active() { return this.state === "running"; }
  /* lm raw landmarks or null; a = analyzeHand result computed WITH THE DEFAULT calibration; t = ms */
  feed(lm, a, t, aspect = 4 / 3) {
    if (this.state !== "running") return this.state;
    const want = this.pose;
    if (!lm || !a) { this.steadySince = 0; this.prev = null; this.msg = `Show your ${labelOf(want)}`; return this.state; }
    /* the pose must look roughly right under the default thresholds, otherwise we would learn from the wrong gesture */
    const f = a.fs, n = k => f[k];
    const roughOk = want === "open" ? ["I", "M", "R", "P"].every(k => n(k) !== "F")
      : want === "fist" ? ["I", "M", "R", "P"].every(k => n(k) !== "E")
      : (n("I") !== "F" && ["M", "R", "P"].every(k => n(k) !== "E"));
    const moved = this.prev ? Math.hypot(a.center.x - this.prev.x, a.center.y - this.prev.y) / a.size : 0;
    this.prev = { x: a.center.x, y: a.center.y };
    if (!roughOk || moved > 0.2) { this.steadySince = 0; this.msg = roughOk ? "Hold it still" : `Show your ${labelOf(want)}`; return this.state; }
    if (!this.steadySince) this.steadySince = t;
    if (t - this.steadySince < this.steadyMs) { this.msg = "Hold it still"; return this.state; }
    this.msg = "Hold…";
    if (t - this.last >= this.gapMs) { this.data[want].push(a.raw); this.lms[want].push(lm); this.last = t; }
    if (this.data[want].length >= this.perPose) {
      this.idx++; this.steadySince = 0; this.prev = null;
      if (this.idx >= this.order.length) this._finish(aspect);
      else this.msg = `Great. Now: ${labelOf(this.pose)}`;
    }
    return this.state;
  }
  _finish(aspect) {
    const cal = makeCalibration(this.data.open, this.data.fist);
    const ok = validateCalibration(cal, { open: this.lms.open, fist: this.lms.fist, point: this.lms.point }, aspect);
    this.result = ok ? cal : null;
    this.state = ok ? "done" : "failed";
    this.msg = ok ? "Calibrated to your hand." : "That didn't look right, so the standard settings stay on. Try again with the hand fully open, then a tight fist.";
  }
}
function labelOf(p) { return p === "open" ? "open hand, fingers spread" : p === "fist" ? "closed fist" : "pointing hand (index finger only)"; }
