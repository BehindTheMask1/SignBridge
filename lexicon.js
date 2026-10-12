/* lexicon.js — the 100-sign vocabulary and the scoring matcher. Pure data + logic, unit-tested.

   Every sign is described the way sign languages are actually organised: HANDSHAPE + LOCATION on the face/body + MOVEMENT
   (+ one or two hands). The matcher scores every sign against what the camera saw and returns the best one only when it is
   clearly ahead of the runner-up, so a pose that fits nothing well produces nothing instead of a random word.

   Honest scope: this is a demo vocabulary of common ISL-style words, each mapped to a gesture a webcam can tell apart.
   It is NOT frame-matched to the official ISLRTC dictionary. Family signs follow a simple rule so they are easy to learn:
   forehead = male relative, chin = female relative. */

import { ZONE_GROUP } from "./engine.js";

export const SHAPE_INFO = {
  fist:       ["✊", "Fist"],
  thumbsUp:   ["👍", "Thumbs up"],
  thumbsDown: ["👎", "Thumbs down"],
  flat:       ["🖐", "Flat hand, fingers together"],
  five:       ["✋", "Open hand, fingers spread"],
  four:       ["🖖", "Four fingers spread, thumb tucked"],
  point:      ["☝️", "Index finger only"],
  lShape:     ["👆", "L: index finger and thumb out"],
  peace:      ["✌️", "V: index and middle spread"],
  uShape:     ["🤞", "U: index and middle together"],
  three:      ["🤟", "Three fingers (index, middle, ring)"],
  pinky:      ["🤙", "Little finger only"],
  callMe:     ["🤙", "Thumb and little finger out"],
  iLoveYou:   ["🤟", "Thumb, index and little finger out"],
  rockOn:     ["🤘", "Index and little finger out"],
  ok:         ["👌", "OK: thumb-index ring, other fingers up"],
  pinchI:     ["🤏", "Thumb and index pinched, others curled"],
  oShape:     ["⭕", "O: fingertips meeting the thumb"],
  cShape:     ["🫳", "C: curved hand, like holding a cup"],
  claw:       ["🦞", "Claw: curved, spread fingers"],
  hook:       ["☝️", "Index finger hooked, others curled"]
};

/* shapes a camera mixes up: observed shape B scores this much for a sign written with shape A (symmetric) */
const SIM_PAIRS = [
  ["flat", "five", 0.72], ["flat", "four", 0.72], ["five", "four", 0.8], ["flat", "uShape", 0.5],
  ["point", "lShape", 0.55], ["point", "hook", 0.55], ["lShape", "iLoveYou", 0.5],
  ["fist", "thumbsUp", 0.55], ["fist", "thumbsDown", 0.55], ["thumbsUp", "thumbsDown", 0.0],
  ["peace", "uShape", 0.78], ["peace", "three", 0.5], ["uShape", "three", 0.5],
  ["ok", "oShape", 0.65], ["ok", "pinchI", 0.5], ["pinchI", "oShape", 0.55],
  ["cShape", "claw", 0.72], ["cShape", "oShape", 0.5], ["claw", "oShape", 0.5],
  ["rockOn", "iLoveYou", 0.72], ["pinky", "callMe", 0.72], ["rockOn", "pinky", 0.4], ["rockOn", "point", 0.45], ["callMe", "iLoveYou", 0.5],
  ["hook", "cShape", 0.5], ["hook", "claw", 0.45], ["fist", "hook", 0.45], ["fist", "pinchI", 0.5], ["fist", "oShape", 0.4]
];
const SIM = {};
for (const [a, b, s] of SIM_PAIRS) { (SIM[a] ||= {})[b] = s; (SIM[b] ||= {})[a] = s; }
export const shapeScore = (want, got) => want === got ? 1 : (SIM[want]?.[got] ?? 0);

export const ZONE_TEXT = {
  any: "in front of you, away from your face", overHead: "above your head", forehead: "at your forehead", eyes: "at your eyes",
  nose: "at your nose", cheek: "beside your cheek", ear: "at your ear", mouth: "at your mouth", chin: "at your chin",
  neck: "at your throat", chest: "on your chest"
};
export const MOTION_TEXT = {
  idle: "hold still", swipeL: "swipe left", swipeR: "swipe right", swipeU: "swipe up", swipeD: "swipe down",
  circle: "draw a circle", shake: "wave side to side", pump: "tap up and down", push: "push toward the camera",
  pull: "pull back toward you", apart: "pull the hands apart", together: "bring the hands together"
};

/* [word, category, hands, shape(s), motion, zone, optional tip, optional extra]
   hands 2 => shapes "a+b" (either hand). extra: { joined:true } = the two hands touch. */
const ROWS = [
  /* ---------- greetings & courtesy ---------- */
  ["HELLO", "Greetings", 2, "flat+flat", "idle", "chest", "Palms together, like Namaste.", { joined: true }],
  ["BYE", "Greetings", 1, "five", "shake", "any", "Wave."],
  ["THANK YOU", "Greetings", 1, "flat", "swipeD", "chin", "Fingertips from your chin, moving down and out."],
  ["PLEASE", "Greetings", 1, "flat", "circle", "chest", "Rub a flat hand in a circle on your chest."],
  ["SORRY", "Greetings", 1, "fist", "circle", "chest", "Rub a fist in a circle on your chest."],
  ["YES", "Greetings", 1, "fist", "pump", "any", "A fist that nods."],
  ["NO", "Greetings", 1, "point", "shake", "any", "Wag your index finger."],
  ["GOOD", "Greetings", 1, "thumbsUp", "idle", "any", "Thumbs up, away from your face."],
  ["BAD", "Greetings", 1, "thumbsDown", "idle", "any", "Thumbs down."],
  ["OK", "Greetings", 1, "ok", "idle", "any", "The OK ring."],
  ["WELCOME", "Greetings", 2, "five+five", "apart", "chest", "Open arms: both hands start together and move apart."],
  ["WAIT", "Greetings", 1, "five", "pump", "any", "Open hand, patting down gently."],
  ["STOP", "Greetings", 1, "flat", "push", "any", "Flat palm pushed toward the camera."],
  /* ---------- me, you, people ---------- */
  ["ME", "People", 1, "point", "idle", "chest", "Point at your chest."],
  ["YOU", "People", 1, "point", "push", "any", "Point at the other person: finger toward the camera."],
  ["WE", "People", 2, "point+point", "together", "chest", "Two index fingers coming together."],
  ["MY", "People", 1, "flat", "idle", "chest", "Flat hand on your chest."],
  ["NAME", "People", 1, "uShape", "pump", "any", "Two fingers tapping."],
  ["FRIEND", "People", 2, "hook+hook", "idle", "chest", "Two hooked index fingers linked together.", { joined: true }],
  ["FAMILY", "People", 2, "cShape+cShape", "idle", "chest", "Two C-hands touching, a circle of people.", { joined: true }],
  ["BABY", "People", 2, "flat+flat", "pump", "chest", "Cradle: both flat hands rocking."],
  /* ---------- family: forehead = male, chin = female ---------- */
  ["FATHER", "Family", 1, "lShape", "idle", "forehead", "L at your forehead. (Forehead = male relatives.)"],
  ["MOTHER", "Family", 1, "lShape", "idle", "chin", "L at your chin. (Chin = female relatives.)"],
  ["BROTHER", "Family", 1, "peace", "idle", "forehead", "V at your forehead."],
  ["SISTER", "Family", 1, "peace", "idle", "chin", "V at your chin."],
  ["SON", "Family", 1, "callMe", "idle", "forehead", "Thumb and little finger at your forehead."],
  ["DAUGHTER", "Family", 1, "callMe", "idle", "chin", "Thumb and little finger at your chin."],
  ["GRANDFATHER", "Family", 1, "thumbsUp", "idle", "forehead", "Thumbs up at your forehead."],
  ["GRANDMOTHER", "Family", 1, "thumbsUp", "idle", "chin", "Thumbs up at your chin."],
  /* ---------- questions ---------- */
  ["WHAT", "Questions", 2, "five+five", "shake", "chest", "Both open hands shaking."],
  ["WHERE", "Questions", 1, "uShape", "shake", "any", "Two fingers wagging."],
  ["WHO", "Questions", 1, "point", "circle", "mouth", "Circle an index finger around your mouth."],
  ["WHY", "Questions", 1, "callMe", "swipeD", "forehead", "Thumb and little finger from your forehead, moving down."],
  ["HOW", "Questions", 2, "fist+fist", "circle", "chest", "Two fists circling."],
  ["WHEN", "Questions", 1, "point", "pump", "chest", "Index finger tapping at your chest."],
  /* ---------- time ---------- */
  ["TODAY", "Time", 1, "lShape", "pump", "any", "L-hand tapping down: right here, right now."],
  ["TOMORROW", "Time", 1, "lShape", "push", "any", "L-hand moving forward."],
  ["YESTERDAY", "Time", 1, "lShape", "pull", "any", "L-hand moving back toward you."],
  ["NOW", "Time", 1, "lShape", "swipeD", "any", "L-hand dropping down."],
  ["LATER", "Time", 1, "lShape", "swipeR", "any", "L-hand sweeping to the right."],
  ["MORNING", "Time", 1, "cShape", "swipeU", "any", "A C-hand rising, like a sun."],
  ["NIGHT", "Time", 1, "cShape", "swipeD", "any", "A C-hand sinking, like a sun."],
  ["FINISH", "Time", 1, "thumbsUp", "swipeU", "any", "Thumbs up lifted upward."],
  /* ---------- actions ---------- */
  ["GO", "Actions", 1, "point", "swipeR", "any", "Point and sweep to the right."],
  ["COME", "Actions", 1, "point", "pull", "any", "Beckon: finger pulled toward you."],
  ["EAT", "Actions", 1, "oShape", "idle", "mouth", "Fingertips to your mouth."],
  ["DRINK", "Actions", 1, "cShape", "idle", "mouth", "A cup at your mouth."],
  ["SLEEP", "Actions", 1, "flat", "idle", "cheek", "Cheek on a flat hand."],
  ["WORK", "Actions", 2, "fist+fist", "pump", "chest", "Two fists tapping."],
  ["HELP", "Actions", 2, "fist+flat", "idle", "chest", "A fist resting on a flat palm.", { joined: true }],
  ["LOVE", "Actions", 1, "iLoveYou", "idle", "any", "The I-love-you hand."],
  ["UNDERSTAND", "Actions", 1, "point", "pump", "forehead", "Tap your forehead with your index finger."],
  ["KNOW", "Actions", 1, "flat", "idle", "forehead", "Flat hand on your forehead."],
  ["THINK", "Actions", 1, "point", "idle", "forehead", "Index finger resting at your forehead."],
  ["REMEMBER", "Actions", 1, "fist", "idle", "forehead", "Fist at your forehead."],
  ["FORGET", "Actions", 1, "flat", "swipeR", "forehead", "Wipe across your forehead."],
  ["SEE", "Actions", 1, "peace", "idle", "eyes", "V at your eyes."],
  ["LOOK", "Actions", 1, "peace", "swipeR", "eyes", "V at your eyes, sweeping sideways."],
  ["HEAR", "Actions", 1, "point", "idle", "ear", "Point at your ear."],
  ["LISTEN", "Actions", 1, "cShape", "idle", "ear", "Cup your ear."],
  ["TALK", "Actions", 1, "four", "pump", "mouth", "Fingers opening and closing at your mouth."],
  ["LEARN", "Actions", 1, "oShape", "swipeU", "forehead", "Pick something up and lift it to your forehead."],
  ["TEACH", "Actions", 1, "oShape", "swipeD", "forehead", "Take it from your forehead and move it down and out."],
  ["WANT", "Actions", 1, "claw", "pull", "chest", "Claw hand pulled toward your chest."],
  ["NEED", "Actions", 1, "hook", "pump", "any", "Hooked finger nodding."],
  ["GIVE", "Actions", 1, "oShape", "push", "any", "Pinched fingers moving out toward the other person."],
  ["TAKE", "Actions", 1, "fist", "pull", "any", "Grab and pull toward you."],
  ["BUY", "Actions", 1, "pinchI", "push", "any", "Pinched fingers (money) handed out."],
  ["MONEY", "Actions", 1, "pinchI", "shake", "any", "Rub thumb and finger together."],
  ["WRITE", "Actions", 1, "pinchI", "swipeR", "any", "Writing with a pinched pen."],
  ["READ", "Actions", 1, "peace", "swipeD", "any", "V fingers scanning down a page."],
  ["PLAY", "Actions", 1, "callMe", "shake", "any", "Thumb and little finger shaking."],
  ["LIKE", "Actions", 1, "pinchI", "swipeD", "chest", "Pinched fingers drawn down your chest."],
  /* ---------- feelings & body ---------- */
  ["HAPPY", "Feelings", 1, "flat", "swipeU", "chest", "Brush your chest upward."],
  ["SAD", "Feelings", 1, "peace", "swipeD", "cheek", "V fingers down your cheek, like tear tracks."],
  ["ANGRY", "Feelings", 1, "claw", "shake", "forehead", "Claw at your forehead, shaking."],
  ["AFRAID", "Feelings", 1, "claw", "shake", "chest", "Claw on your chest, trembling."],
  ["TIRED", "Feelings", 1, "five", "swipeD", "chest", "Open hand drooping down your chest."],
  ["HUNGRY", "Feelings", 1, "cShape", "swipeD", "neck", "C-hand down your throat."],
  ["THIRSTY", "Feelings", 1, "point", "swipeD", "neck", "Index finger down your throat."],
  ["PAIN", "Feelings", 2, "point+point", "shake", "any", "Two index fingers jabbing."],
  ["SICK", "Feelings", 1, "three", "idle", "forehead", "Three fingers at your forehead."],
  ["COLD", "Feelings", 2, "fist+fist", "shake", "chest", "Two fists shivering."],
  ["BEAUTIFUL", "Feelings", 1, "five", "circle", "chin", "Circle your open hand around your face."],
  /* ---------- places & things ---------- */
  ["HOME", "Things", 2, "flat+flat", "idle", "forehead", "Both flat hands joined above your face, a roof.", { joined: true }],
  ["SCHOOL", "Things", 2, "flat+flat", "together", "chest", "Clap: flat hands coming together.", {}],
  ["HOSPITAL", "Things", 1, "three", "shake", "chest", "Three fingers shaking on your chest."],
  ["DOCTOR", "Things", 1, "three", "idle", "chest", "Three fingers on your chest, like feeling a pulse."],
  ["WATER", "Things", 1, "three", "pump", "chin", "Three fingers tapping your chin."],
  ["FOOD", "Things", 1, "oShape", "pump", "mouth", "Fingertips tapping your mouth."],
  ["PHONE", "Things", 1, "callMe", "idle", "ear", "Phone to your ear."],
  ["BOOK", "Things", 2, "flat+flat", "apart", "any", "Open a book: flat hands moving apart.", {}],
  ["TOILET", "Things", 1, "rockOn", "shake", "any", "Index and little finger shaking."],
  ["MEDICINE", "Things", 1, "pinchI", "pump", "chest", "Pinched fingers tapping your chest."],
  /* ---------- describing words ---------- */
  ["BIG", "Describing", 2, "cShape+cShape", "apart", "any", "Two C-hands moving apart."],
  ["SMALL", "Describing", 1, "pinchI", "idle", "any", "Pinch the air."],
  ["MORE", "Describing", 2, "oShape+oShape", "together", "any", "Two pinched hands coming together."],
  ["ALL", "Describing", 2, "flat+flat", "circle", "any", "Both flat hands sweeping a circle."],
  ["AGAIN", "Describing", 1, "hook", "swipeR", "any", "Hooked finger flicking to the right."],
  ["MAYBE", "Describing", 1, "ok", "shake", "any", "OK ring wobbling."]
];

export const SIGNS = ROWS.map(([w, cat, h, shape, m, z, tip, extra]) => ({
  w, cat, h, s: shape.split("+"), m, z, tip: tip || "", joined: !!(extra && extra.joined)
}));
export const WORDS = SIGNS.map(s => s.w);
export const CATEGORIES = [...new Set(SIGNS.map(s => s.cat))];
const BY_WORD = new Map(SIGNS.map(s => [s.w, s]));
export const signFor = w => BY_WORD.get(w) || null;

/* "how to do it", generated from the same data the matcher uses, so the guide can never drift from the recogniser */
export function describeSign(s) {
  const nm = k => (SHAPE_INFO[k] ? SHAPE_INFO[k][1] : k);
  const hands = s.h === 2
    ? (s.s[0] === s.s[1] ? `Both hands: ${nm(s.s[0])}` : `One hand ${nm(s.s[0])}, the other ${nm(s.s[1])}`)
    : nm(s.s[0]);
  const where = s.z === "any" ? "away from your face" : ZONE_TEXT[s.z];
  const move = MOTION_TEXT[s.m];
  return `${hands}; ${where}; ${move}.`;
}

/* ---------- matcher ---------- */
export const ACCEPT = 0.56, MIN_MARGIN = 0.06;

function zoneScore(sign, obs) {
  if (!obs.hasFace) return sign.z === "any" ? 1 : 0.3;                    // no face: only location-free signs are trustworthy
  const oz = obs.zone || "any";
  if (sign.z === "any") return oz === "any" ? 1 : 0.78;
  if (oz === sign.z) return 1;
  if (oz !== "any" && ZONE_GROUP[oz] === ZONE_GROUP[sign.z]) return 0.92;
  return 0.2;
}
function shapesScore(sign, obs) {
  if (sign.h === 1) return shapeScore(sign.s[0], obs.shapes[0]);
  const [a, b] = sign.s, [x, y] = obs.shapes;
  return Math.max(Math.min(shapeScore(a, x), shapeScore(b, y)), Math.min(shapeScore(a, y), shapeScore(b, x)));
}

/* obs: { n, shapes:[...], motion, zone, hasFace, joined } -> { best, margin, ranked:[{sign,score}] } */
export function matchSigns(obs) {
  const ranked = [];
  for (const sign of SIGNS) {
    if (sign.h !== obs.n) continue;
    if (sign.m !== obs.motion) continue;
    const sh = shapesScore(sign, obs);
    if (!sh) continue;
    let score = sh * zoneScore(sign, obs);
    if (sign.joined && !obs.joined) score *= 0.5;
    ranked.push({ sign, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0], second = ranked[1];
  const margin = top ? top.score - (second ? second.score : 0) : 0;
  const best = top && top.score >= ACCEPT && (margin >= MIN_MARGIN || (second && second.score < 0.5)) ? top : null;
  return { best, margin, ranked };
}

/* ---------- n-best over time ----------
   Averages the matcher's candidate scores across the frames of one hold, so one noisy frame can neither create nor
   hide a candidate. A word missing from a frame counts as 0 for that frame. */
export class NBest {
  constructor() { this.reset(); }
  reset() { this.n = 0; this.sum = new Map(); }
  add(ranked) {
    this.n++;
    for (const r of ranked.slice(0, 6)) this.sum.set(r.sign.w, (this.sum.get(r.sign.w) || 0) + r.score);
  }
  top(k = 3) {
    if (!this.n) return [];
    return [...this.sum.entries()].map(([w, s]) => ({ w, score: Math.round(s / this.n * 100) / 100 }))
      .sort((a, b) => b.score - a.score).slice(0, k);
  }
}
