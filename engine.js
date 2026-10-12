/* SignBridge engine — pure logic, no DOM, unit-testable in Node.
   1. Face frame: a tilt- and distance-invariant coordinate system built from face keypoints,
      so "near the forehead / at the chin" means the same thing at any camera distance or head tilt.
   2. ShapeSmoother: majority vote over recent frames so one flickery frame can't change a sign.
   3. Rule-based gloss -> English engine: instant offline fallback and first draft before the AI answers. */

/* ====================== 1. FACE FRAME ====================== */

/* All face maths happens in "mirrored, aspect-corrected" space: x' = (1 - x_norm) * aspect, y = y_norm,
   where aspect = videoWidth / videoHeight. That makes distances and angles isotropic and matches the
   mirrored selfie view the user actually sees. */
export function toMirroredSpace(p, aspect){ return { x:(1 - p.x) * aspect, y:p.y }; }

/* kps: BlazeFace keypoints (normalized): [eyeA, eyeB, nose, mouth, earA, earB].
   bbox: {left, top, width, height} normalized, un-mirrored (used only if keypoints are unusable). */
export function makeFaceFrame(kps, bbox, aspect){
  let eyeA, eyeB, nose, mouth;
  if(kps && kps.length >= 4){
    [eyeA, eyeB, nose, mouth] = kps.slice(0,4);
  } else if(bbox){
    const cx = bbox.left + bbox.width/2;
    eyeA = { x:cx - bbox.width*0.2, y:bbox.top + bbox.height*0.36 };
    eyeB = { x:cx + bbox.width*0.2, y:bbox.top + bbox.height*0.36 };
    nose  = { x:cx, y:bbox.top + bbox.height*0.58 };
    mouth = { x:cx, y:bbox.top + bbox.height*0.76 };
  } else return null;

  let eL = toMirroredSpace(eyeA, aspect), eR = toMirroredSpace(eyeB, aspect);
  if(eL.x > eR.x){ const t = eL; eL = eR; eR = t; }   // eL = left-most eye in the mirrored view
  const ipd = Math.hypot(eR.x - eL.x, eR.y - eL.y);
  if(!(ipd > 1e-4)) return null;
  let roll = Math.atan2(eR.y - eL.y, eR.x - eL.x);
  if(Math.abs(roll) > 1.05) roll = 0;                 // >60° "tilt" is a bad detection, not a head tilt
  const eyeMid = { x:(eL.x + eR.x)/2, y:(eL.y + eR.y)/2 };
  const frame = { eyeMid, ipd, roll, aspect, eL, eR, vNose:0.7, vMouth:1.15 };
  const n = toFace(frame, toMirroredSpace(nose, aspect));
  const m = toFace(frame, toMirroredSpace(mouth, aspect));
  /* trust measured nose/mouth heights only when they are anatomically plausible */
  if(n.v > 0.25 && n.v < 1.4) frame.vNose = n.v;
  if(m.v > frame.vNose + 0.2 && m.v < 2.2) frame.vMouth = m.v;
  return frame;
}

/* point in mirrored aspect-corrected space -> face coords (u right, v down, unit = inter-eye distance) */
export function toFace(f, P){
  const dx = P.x - f.eyeMid.x, dy = P.y - f.eyeMid.y, c = Math.cos(f.roll), s = Math.sin(f.roll);
  return { u:(dx*c + dy*s)/f.ipd, v:(-dx*s + dy*c)/f.ipd };
}
export function fromFace(f, u, v){
  const c = Math.cos(f.roll), s = Math.sin(f.roll);
  return { x:f.eyeMid.x + (u*c - v*s)*f.ipd, y:f.eyeMid.y + (u*s + v*c)*f.ipd };
}

/* Zones are bands in face-v, anchored to this person's own measured nose/mouth heights.
   Order top -> bottom. Each: [name, vFrom, vTo]. */
export function zoneBands(f){
  const m = f.vMouth;
  return [
    ["overHead", -9,   -1.5],
    ["forehead", -1.5, -0.4],
    ["eyes",     -0.4,  0.35],
    ["nose",      0.35, m - 0.3],
    ["mouth",     m - 0.3, m + 0.3],
    ["chin",      m + 0.3, m + 0.95],
    ["neck",      m + 0.95, m + 1.9],
    ["chest",     m + 1.9,  m + 4.6]
  ];
}

/* coarse groups: older table entries / fallbacks use these */
export const ZONE_GROUP = {
  overHead:"forehead", forehead:"forehead", eyes:"eyeCheek", nose:"eyeCheek", cheek:"eyeCheek", ear:"eyeCheek",
  mouth:"mouthChin", chin:"mouthChin", neck:"chest", chest:"chest", any:"any"
};

/* returns { zone, u, v, side } — zone "any" when the hand is far from the face/body column */
export function classifyZone(f, P){
  if(!f) return { zone:"any", u:0, v:0, side:"center" };
  const { u, v } = toFace(f, P);
  const side = u < -0.55 ? "left" : u > 0.55 ? "right" : "center";
  if(Math.abs(u) > 3.6 || v < -3.2 || v > f.vMouth + 4.6) return { zone:"any", u, v, side };
  let zone = "any";
  for(const [name, a, b] of zoneBands(f)){ if(v >= a && v < b){ zone = name; break; } }
  /* beside the face (not in front of it): cheek / ear instead of nose/mouth/eyes bands */
  if(Math.abs(u) > 0.95 && (zone === "nose" || zone === "mouth" || zone === "eyes")) zone = Math.abs(u) > 1.5 ? "ear" : "cheek";
  if(Math.abs(u) > 1.8 && (zone === "forehead" || zone === "chin")) zone = "any";
  return { zone, u, v, side };
}

/* which fingertip/palm point decides "where the sign is" for each handshape */
export const REF_LANDMARK = {
  point:8, lShape:8, peace:8, ok:8, iLoveYou:8, rockOn:8, three:12, four:12,
  pinky:20, callMe:20, thumbsUp:4, thumbsDown:4, openPalm:9, fist:9
};

/* ====================== 2. TEMPORAL SMOOTHING ====================== */

export class ShapeSmoother{
  constructor(size = 8, minShare = 0.6){ this.size = size; this.minShare = minShare; this.buf = []; }
  push(shape){ this.buf.push(shape || null); if(this.buf.length > this.size) this.buf.shift(); }
  reset(){ this.buf = []; }
  /* majority shape and how dominant it is (0..1) */
  get(){
    if(this.buf.length < 3) return { shape:null, share:0 };
    const counts = new Map();
    for(const s of this.buf) counts.set(s, (counts.get(s) || 0) + 1);
    let best = null, n = 0;
    for(const [s, c] of counts){ if(s !== null && c > n){ best = s; n = c; } }
    const share = n / this.buf.length;
    return share >= this.minShare ? { shape:best, share } : { shape:null, share };
  }
}

/* keeps the last good face frame alive while a hand covers the face (detectors drop out exactly then) */
export class FaceTracker{
  constructor({ holdMs = 1600, alpha = 0.45 } = {}){ this.holdMs = holdMs; this.alpha = alpha; this.frame = null; this.lastSeen = -1e9; }
  update(newFrame, now){
    if(newFrame){
      if(!this.frame) this.frame = newFrame;
      else {
        const a = this.alpha, o = this.frame;
        const mix = (p, q) => p + (q - p) * a;
        this.frame = {
          ...newFrame,
          eyeMid:{ x:mix(o.eyeMid.x, newFrame.eyeMid.x), y:mix(o.eyeMid.y, newFrame.eyeMid.y) },
          ipd:mix(o.ipd, newFrame.ipd), roll:mix(o.roll, newFrame.roll),
          vNose:mix(o.vNose, newFrame.vNose), vMouth:mix(o.vMouth, newFrame.vMouth)
        };
      }
      this.lastSeen = now;
    }
    return this.get(now);
  }
  get(now){ return this.frame && (now - this.lastSeen) <= this.holdMs ? this.frame : null; }
  /* true when the frame is being held from memory rather than freshly detected */
  isStale(now){ return now - this.lastSeen > 250; }
}

/* ====================== 3. SENTENCE ENGINE (offline) ====================== */

const V = (base, ing, past, pp, s, kind = "action") => ({ t:"verb", base, ing, past, pp, s, kind });
const ADJ = (adj, self = false) => ({ t:"adj", adj, self });          // self: a feeling/state, so a bare "HUNGRY" means "I am hungry"
const THING = (n, a = "") => ({ t:"thing", n, a });
const PERSON = (n, art = "") => ({ t:"person", n, art });
const PLACE = (at, to) => ({ t:"place", at, to });
const TIME = (w, o = {}) => ({ t:"time", w, ...o });                   // fut / past / habit
const GREET = say => ({ t:"greet", say });
const Q = w => ({ t:"q", w });

/* every one of the 100 lexicon words has an entry, so the offline engine knows what kind of word it is */
const LEX = {
  /* greetings & courtesy */
  HELLO:GREET("Hello!"), BYE:GREET("Goodbye!"), "THANK YOU":GREET("Thank you."), WELCOME:GREET("You're welcome."), OK:GREET("Okay."),
  YES:{ t:"yes" }, NO:{ t:"neg" }, PLEASE:{ t:"please" }, SORRY:ADJ("sorry", true), GOOD:ADJ("good"), BAD:ADJ("bad"),
  WAIT:V("wait","waiting","waited","waited","waits"), STOP:V("stop","stopping","stopped","stopped","stops"),
  /* people */
  ME:{ t:"pron", p:"I" }, YOU:{ t:"pron", p:"you" }, WE:{ t:"pron", p:"we", pl:true }, MY:{ t:"my" }, NAME:{ t:"nameword" },
  FRIEND:PERSON("friend"), FAMILY:{ t:"person", n:"family", art:"", fam:true }, BABY:PERSON("baby", "the"),
  FATHER:PERSON("father"), MOTHER:PERSON("mother"), BROTHER:PERSON("brother"), SISTER:PERSON("sister"), SON:PERSON("son"),
  DAUGHTER:PERSON("daughter"), GRANDFATHER:PERSON("grandfather"), GRANDMOTHER:PERSON("grandmother"), DOCTOR:PERSON("doctor", "the"),
  /* questions */
  WHAT:Q("What"), WHERE:Q("Where"), WHO:Q("Who"), WHY:Q("Why"), HOW:Q("How"), WHEN:Q("When"),
  /* time */
  TODAY:TIME("today"), TOMORROW:TIME("tomorrow", { fut:true }), YESTERDAY:TIME("yesterday", { past:true }), NOW:TIME("now"),
  LATER:TIME("later", { fut:true }), MORNING:TIME("in the morning", { habit:true }), NIGHT:TIME("at night", { habit:true }),
  FINISH:{ t:"perf" },
  /* actions */
  GO:V("go","going","went","gone","goes"), COME:V("come","coming","came","come","comes"),
  EAT:V("eat","eating","ate","eaten","eats"), DRINK:V("drink","drinking","drank","drunk","drinks"),
  SLEEP:V("sleep","sleeping","slept","slept","sleeps"), WORK:V("work","working","worked","worked","works"),
  HELP:V("help","helping","helped","helped","helps","help"),
  LOVE:V("love","loving","loved","loved","loves","state"), UNDERSTAND:V("understand","understanding","understood","understood","understands","state"),
  KNOW:V("know","knowing","knew","known","knows","state"), THINK:V("think","thinking","thought","thought","thinks"),
  REMEMBER:V("remember","remembering","remembered","remembered","remembers","state"), FORGET:V("forget","forgetting","forgot","forgotten","forgets","state"),
  SEE:V("see","seeing","saw","seen","sees"), LOOK:V("look","looking","looked","looked","looks"),
  HEAR:V("hear","hearing","heard","heard","hears","state"), LISTEN:V("listen","listening","listened","listened","listens"),
  TALK:V("talk","talking","talked","talked","talks"), LEARN:V("learn","learning","learned","learned","learns"),
  TEACH:V("teach","teaching","taught","taught","teaches"), WANT:V("want","wanting","wanted","wanted","wants","state"),
  NEED:V("need","needing","needed","needed","needs","state"), GIVE:V("give","giving","gave","given","gives"),
  TAKE:V("take","taking","took","taken","takes"), BUY:V("buy","buying","bought","bought","buys"),
  WRITE:V("write","writing","wrote","written","writes"), READ:V("read","reading","read","read","reads"),
  PLAY:V("play","playing","played","played","plays"), LIKE:V("like","liking","liked","liked","likes","state"),
  /* feelings */
  HAPPY:ADJ("happy", true), SAD:ADJ("sad", true), ANGRY:ADJ("angry", true), AFRAID:ADJ("afraid", true), TIRED:ADJ("tired", true),
  HUNGRY:ADJ("hungry", true), THIRSTY:ADJ("thirsty", true), PAIN:ADJ("in pain", true), SICK:ADJ("sick", true), COLD:ADJ("cold", true),
  BEAUTIFUL:ADJ("beautiful"), BIG:ADJ("big"), SMALL:ADJ("small"),
  /* places & things */
  HOME:PLACE("home", "home"), SCHOOL:PLACE("school", "to school"), HOSPITAL:PLACE("the hospital", "to the hospital"), TOILET:PLACE("the toilet", "to the toilet"),
  WATER:THING("water"), FOOD:THING("food"), PHONE:THING("phone", "a"), BOOK:THING("book", "a"), MONEY:THING("money"), MEDICINE:THING("medicine"),
  /* modifiers */
  MORE:{ t:"more" }, AGAIN:{ t:"again" }, ALL:{ t:"all" }, MAYBE:{ t:"maybe" }, TOGETHER:{ t:"together" }
};
export const KNOWN_GLOSSES = Object.keys(LEX);

const SINGLE = {
  HELLO:"Hello!", YES:"Yes.", NO:"No.", PLEASE:"Please.", SORRY:"I'm sorry.", GOOD:"Good.", BAD:"That's bad.",
  HAPPY:"I'm happy.", HELP:"I need help.", WAIT:"Please wait.", STOP:"Stop!", LOVE:"I love you.",
  UNDERSTAND:"I understand.", FINISH:"I'm finished.", MORE:"I want more.", GO:"Let's go.", WORK:"I'm working.",
  WHAT:"What?", WHERE:"Where?", WHO:"Who?", WHY:"Why?", HOW:"How?", WHEN:"When?", ME:"Me.", YOU:"You.", WE:"We.", TOMORROW:"Tomorrow.", TODAY:"Today.", YESTERDAY:"Yesterday.",
  SCHOOL:"School.", HOME:"Home.", FATHER:"My father.", MOTHER:"My mother.", FRIEND:"My friend.", FAMILY:"My family.",
  BROTHER:"My brother.", SISTER:"My sister.", SON:"My son.", DAUGHTER:"My daughter.", GRANDFATHER:"My grandfather.", GRANDMOTHER:"My grandmother.",
  TOGETHER:"Together.", "THANK YOU":"Thank you.", BYE:"Goodbye!", WELCOME:"You're welcome.", OK:"Okay.",
  HUNGRY:"I'm hungry.", THIRSTY:"I'm thirsty.", TIRED:"I'm tired.", SAD:"I'm sad.", ANGRY:"I'm angry.", AFRAID:"I'm afraid.", SICK:"I'm sick.", COLD:"I'm cold.", PAIN:"I'm in pain.",
  WATER:"Water, please.", FOOD:"Food, please.", MEDICINE:"I need medicine.", AGAIN:"Again.", MAYBE:"Maybe."
};

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const lcFirst = s => /^I[\s']/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);

function tokenize(words){
  const out = [];
  for(const raw of words){
    const w = String(raw || "").trim();
    if(!w) continue;
    const key = w.toUpperCase();
    if(out.length && out[out.length-1].key === key) continue;           // held-sign duplicates
    out.push(LEX[key] ? { key, ...LEX[key] } : { key, t:"name", name:titleCase(w) });
  }
  return out;
}

/* noun phrase for subject (role "s") or object (role "o") */
const npOf = (tok, role, poss) => {
  if(tok.t === "pron") return tok.p === "I" ? (role === "s" ? "I" : "me") : tok.p === "we" ? (role === "s" ? "we" : "us") : "you";
  if(tok.t === "person") return tok.fam ? "my family" : (tok.art ? `${tok.art} ${tok.n}` : `my ${tok.n}`);
  if(tok.t === "thing") return `${poss ? "my " : (tok.a ? tok.a + " " : "")}${tok.n}`;
  return tok.name;
};
const firstPerson = np => np === "I" || np === "you" || np === "we";            // verbs agree like "I/you/we": base form
const beOf = np => np === "I" ? "am" : (np === "we" || np === "you" ? "are" : "is");

/* ---------- phrases: sign sequences that mean one fixed thing ----------
   Each phrase lists the glosses in any accepted order. A phrase is matched as a unit when it fills a whole utterance
   (so "GOOD MORNING" is a greeting, not "good" + "morning"). */
export const PHRASES = [
  { id:"good-morning", say:"Good morning!", seqs:[["GOOD","MORNING"],["MORNING","GOOD"]] },
  { id:"good-night", say:"Good night!", seqs:[["GOOD","NIGHT"],["NIGHT","GOOD"]] },
  { id:"how-are-you", say:"How are you?", seqs:[["HOW","YOU"],["YOU","HOW"]] },
  { id:"i-love-you", say:"I love you.", seqs:[["ME","LOVE","YOU"],["ME","YOU","LOVE"]] },
  { id:"thank-you-much", say:"Thank you very much.", seqs:[["THANK YOU","MORE"],["THANK YOU","BIG"],["THANK YOU","THANK YOU"]] },
  { id:"whats-name", say:"What is your name?", seqs:[["YOU","NAME","WHAT"],["NAME","WHAT"],["WHAT","NAME"],["WHAT","YOU","NAME"]] },
  { id:"dont-understand", say:"I do not understand.", seqs:[["ME","NO","UNDERSTAND"],["NO","UNDERSTAND"]] },
  { id:"please-help", say:"Please help me.", seqs:[["PLEASE","HELP"],["ME","PLEASE","HELP"],["HELP","PLEASE"]] },
  { id:"where-toilet", say:"Where is the toilet?", seqs:[["TOILET","WHERE"],["WHERE","TOILET"]] },
  { id:"need-doctor", say:"I need a doctor.", seqs:[["ME","DOCTOR","NEED"],["DOCTOR","NEED"],["DOCTOR","HELP"]] },
  { id:"feel-pain", say:"I am in pain.", seqs:[["ME","PAIN"],["PAIN"]] },
  { id:"see-you-later", say:"See you later!", seqs:[["BYE","LATER"],["LATER","BYE"],["SEE","YOU","LATER"]] },
  { id:"nice-meet", say:"Nice to meet you.", seqs:[["HAPPY","YOU","SEE"],["ME","HAPPY","YOU","SEE"],["HELLO","HAPPY","YOU"]] },
  { id:"okay-fine", say:"I am fine.", seqs:[["ME","GOOD"],["ME","OK"]] }
];
const PHRASE_KEYS = PHRASES.flatMap(p => p.seqs.map(sq => ({ p, key: sq.join("|") })));
/* the phrase (if any) that the whole list of glosses spells out */
export function findPhrase(words){
  const clean = []; for(const w of words){ const k = String(w || "").trim().toUpperCase(); if(k && clean[clean.length-1] !== k) clean.push(k); }
  const key = clean.join("|");
  const hit = PHRASE_KEYS.find(x => x.key === key);
  return hit ? hit.p : null;
}

/* ---------- tone ---------- */
const CONTRACT = [[/\bI am\b/g, "I'm"], [/\bI have\b/g, "I've"], [/\bI will\b/g, "I'll"], [/\bdo not\b/g, "don't"], [/\bdoes not\b/g, "doesn't"],
  [/\bdid not\b/g, "didn't"], [/\bhave not\b/g, "haven't"], [/\bhas not\b/g, "hasn't"], [/\bare not\b/g, "aren't"], [/\bWhat is\b/g, "What's"],
  [/\bWhere is\b/g, "Where's"], [/\bWho is\b/g, "Who's"], [/\bHow is\b/g, "How's"], [/\bwe are\b/g, "we're"], [/\bWe are\b/g, "We're"], [/\byou are\b/g, "you're"], [/\bYou are\b/g, "You're"]];
const EXPAND = [[/\bI'm\b/g, "I am"], [/\bI've\b/g, "I have"], [/\bI'll\b/g, "I will"], [/\bdon't\b/g, "do not"], [/\bdoesn't\b/g, "does not"], [/\bdidn't\b/g, "did not"], [/\bWhat's\b/g, "What is"], [/\bWhere's\b/g, "Where is"]];
/* casual = contractions; formal = full forms and polite wording. Pure string work, so it also applies to the offline engine. */
export function applyTone(text, tone){
  let s = String(text || "");
  if(!s) return s;
  if(tone === "formal"){
    for(const [a, b] of EXPAND) s = s.replace(a, b);
    s = s.replace(/\bDo you want to\b/g, "Would you like to").replace(/\bDo you want\b/g, "Would you like")
         .replace(/\bI want to\b/g, "I would like to").replace(/\bI want\b/g, "I would like")
         .replace(/^(I (?:am|have) [^.!?]*?)\.$/, "$1.");
    if(/^I need help\.$/.test(s)) s = "I need help, please.";
    if(/^Where is\b.*\?$/.test(s)) s = s.replace(/^Where is/, "Could you tell me where") .replace(/\?$/, " is?").replace(/where (the|my|your) (\w+) is\?$/, "where $1 $2 is?");
    return s;
  }
  for(const [a, b] of CONTRACT) s = s.replace(a, b);
  return s;
}

/* returns { text, ok } — ok=false means "I could only do a polite word-join; ask the AI" */
export function ruleEngine(words){
  const toks = tokenize(words);
  if(!toks.length) return { text:"", ok:true };
  const phrase = findPhrase(words);
  if(phrase) return { text:phrase.say, ok:true, phrase:phrase.id };
  if(toks.length === 1 && SINGLE[toks[0].key]) return { text:SINGLE[toks[0].key], ok:true };
  if(toks.length === 1 && toks[0].t === "name") return { text:`${toks[0].name}.`, ok:true };

  const q = toks.find(t => t.t === "q");
  const neg = toks.some(t => t.t === "neg");
  const time = toks.find(t => t.t === "time");
  const perf = toks.some(t => t.t === "perf");
  const please = toks.some(t => t.t === "please");
  const greet = toks.find(t => t.t === "greet");
  const yes = toks.some(t => t.t === "yes");
  const more = toks.some(t => t.t === "more");
  const again = toks.some(t => t.t === "again");
  const maybe = toks.some(t => t.t === "maybe");
  const together = toks.some(t => t.t === "together");
  const poss = toks.some(t => t.t === "my");
  const verb = toks.find(t => t.t === "verb");
  const adj = toks.find(t => t.t === "adj");
  const place = toks.find(t => t.t === "place");
  const agents = toks.filter(t => t.t === "pron" || t.t === "person" || t.t === "name");
  const things = toks.filter(t => t.t === "thing");

  /* "my name is X" / "what is your name?" */
  if(toks.some(t => t.t === "nameword")){
    const names = toks.filter(t => t.t === "name");
    if(names.length) return finish(`My name is ${names[0].name}.`, { greet, yes, ok:true });
    if(q || toks.some(t => t.key === "YOU")) return finish("What is your name?", { greet, yes, ok:true });
    return { text:"My name.", ok:false };
  }
  if(q && q.key === "HOW" && toks.some(t => t.key === "YOU") && !verb) return finish("How are you?", { greet, yes, ok:true });

  /* a feeling plus an action: say both ("I am hungry. I want food.") */
  if(verb && adj && !q){
    const subj = agents[0] ? [agents[0].key] : [];
    const a = ruleEngine([...subj, adj.key]), b = ruleEngine(toks.filter(t => t !== adj).map(t => t.key));
    return { text:`${a.text} ${b.text}`, ok:a.ok && b.ok };
  }

  /* "I am thirsty" + a thing and no verb: they want it ("ME THIRSTY WATER") */
  if(adj && adj.self && !verb && !q && things.length && !neg){
    const subjNP = agents[0] ? npOf(agents[0], "s") : "I";
    return finish(`${cap(subjNP)} ${beOf(subjNP)} ${adj.adj}. ${cap(subjNP)} ${firstPerson(subjNP) ? "need" : "needs"} ${npOf(things[0], "o")}.`.replace(/^I am/, "I am"), { greet, yes, ok:true });
  }

  /* want/need/like + another action: "I want to sleep" */
  const modal = toks.find(t => t.key === "WANT" || t.key === "NEED" || t.key === "LIKE");
  const mainVerb = modal && toks.find(t => t.t === "verb" && t !== modal && t.key !== "HELP");
  let body = null;
  if(modal && mainVerb && !q){
    const subjTok = agents[0], subjNP = subjTok ? npOf(subjTok, "s") : "I";
    const f = firstPerson(subjNP) || subjNP === "we";
    const tgt = (mainVerb.key === "GO" || mainVerb.key === "COME") && place ? ` ${place.to}` : "";
    const core = `${modal.base} to ${mainVerb.base}${tgt}`;
    if(subjNP === "you" ) return finish(`Do you ${core}?`, { greet, yes, ok:true });
    return finish(cap(`${subjNP} ${neg ? (f ? "do not " : "does not ") + core : (f ? modal.base : modal.s) + " to " + mainVerb.base + tgt}.`), { greet, yes, ok:true });
  }

  if(verb){
    let subjToks = together ? agents.slice() : agents.slice(0, 1);
    const objTok = together ? null : (agents[1] || things[0] || null);
    const imperativeVerb = ["HELP","WAIT","STOP","GO","COME","LOOK","LISTEN"].includes(verb.key);
    let imperative = false;
    if(!subjToks.length) imperative = imperativeVerb && !q;
    if(please && imperativeVerb && (!subjToks.length || (subjToks[0].t === "pron" && verb.key === "HELP"))) imperative = true;
    if(please && !subjToks.length && !imperativeVerb) imperative = true;

    let subjNP, plural = false;
    if(imperative) subjNP = null;
    else if(!subjToks.length) subjNP = "I";
    else if(subjToks.length > 1){
      const others = subjToks.filter(t => t.t !== "pron").map(t => npOf(t, "s"));
      const meIn = subjToks.some(t => t.t === "pron");
      subjNP = (others.length ? others.join(" and ") + (meIn ? " and I" : "") : "we");
      plural = true;
    } else subjNP = npOf(subjToks[0], "s");
    if(subjNP === "we") plural = false;
    const base1 = plural || firstPerson(subjNP || "I");
    const be = plural ? "are" : beOf(subjNP || "I");
    const ask = !!q || (subjNP === "you" && !imperative && !neg);            // "YOU WATER WANT" is a question to the other person

    /* object / complement */
    let obj = "";
    if(verb.key === "GO" || verb.key === "COME"){ obj = place ? ` ${place.to}` : (objTok && objTok.t === "person" ? ` to ${npOf(objTok, "o")}` : ""); }
    else if(objTok){ obj = ` ${npOf(objTok, "o", poss)}`; }
    else if(verb.key === "HELP" && (!subjNP || subjNP !== "I")) obj = " me";
    else if(verb.key === "LOVE" && !objTok) obj = " you";
    else if(place) obj = ` at ${place.at}`;
    if(more && verb.key !== "HELP"){ if(objTok && objTok.t === "thing") obj = ` more ${npOf(objTok, "o", poss).replace(/^(a|my) /, "")}`; else obj += " more"; }
    if(together) obj += " together";
    if(again) obj += " again";

    const fut = !!(time && time.fut), past = !!(time && time.past), habit = !!(time && time.habit);
    const tsfx = time ? ` ${time.w}` : "";
    const continuous = verb.kind === "action" && verb.key !== "STOP";
    let vp;
    if(imperative){
      if(verb.key === "HELP") vp = `${please ? "Please help" : "Help"} me`;
      else vp = `${please ? "Please " : ""}${verb.base}${obj}`;
      if(verb.key === "STOP" && !please) vp = `Stop${obj}`;
      if(neg) vp = `${please ? "Please do" : "Do"} not ${verb.base}${obj}`;
      body = cap(vp.trim());
      if(time) body = body.replace(/\.$/, "") + tsfx;
    } else if(verb.key === "HELP" && subjNP === "I" && !objTok && !ask){
      body = `${neg ? "I do not need" : "I need"}${more ? " more" : ""} help${tsfx}`;
    } else if(ask){
      /* question: invert the auxiliary. wh = the question word if there is one */
      const wh = q ? q.w + " " : "";
      const goLike = verb.key === "GO" || verb.key === "COME";
      let inner;
      if(perf) inner = `${wh}${base1 ? "have" : "has"} ${subjNP} ${verb.pp}${goLike && place ? " " + place.to : obj.replace(/^ (to|at) /, " ")}`;
      else if(past) inner = `${wh}did ${subjNP} ${verb.base}${obj}`;
      else if(continuous && !(fut && !goLike) && !habit) inner = `${wh}${be} ${subjNP} ${verb.ing}${goLike && q ? "" : obj}`;
      else if(fut) inner = `${wh}will ${subjNP} ${verb.base}${obj}`;
      else inner = `${wh}${base1 ? "do" : "does"} ${subjNP} ${verb.base}${obj}`;
      body = inner + tsfx;
    } else if(perf){
      const have = base1 ? "have" : "has";
      body = `${subjNP} ${have}${neg ? " not" : ""} ${verb.pp}${(verb.key === "GO" || verb.key === "COME") && place ? " " + place.to : obj.replace(/^ (to|at) /, " ")}`;
      if(verb.key === "GO") body = `${subjNP} ${have}${neg ? " not" : ""} ${place && place.key === "HOME" ? "gone home" : (place ? "gone " + place.to : "gone")}`;
    } else if(past){
      body = neg ? `${subjNP} did not ${verb.base}${obj}${tsfx}` : `${subjNP} ${verb.past}${obj}${tsfx}`;
    } else if(fut && verb.key === "GO" && !neg){
      body = `${subjNP} ${be} going${obj}${tsfx}`;
    } else if(fut){
      body = `${subjNP} will${neg ? " not" : ""} ${verb.base}${obj}${tsfx}`;
    } else if(continuous && !habit){
      body = `${subjNP} ${be}${neg ? " not" : ""} ${verb.ing}${obj}${tsfx}`;
    } else {
      body = neg ? `${subjNP} ${base1 ? "do" : "does"} not ${verb.base}${obj}${tsfx}` : `${subjNP} ${base1 ? verb.base : verb.s}${obj}${tsfx}`;
    }
    const sentence = cap(body.trim()) + (ask && !imperative ? "?" : (verb.key === "STOP" && imperative ? "!" : "."));
    return finish(maybe ? "Maybe " + lcFirst(sentence) : sentence, { greet, yes, ok:true });
  }

  if(adj && !q){
    const subjTok = agents[0] || things[0];
    const subjNP = subjTok ? npOf(subjTok, "s", poss) : (adj.self ? "I" : "That");
    const be = beOf(subjNP);
    if(subjNP === "you") return finish(cap(`${neg ? "aren't" : "are"} you ${adj.adj}${time ? " " + time.w : ""}?`), { greet, yes, ok:true });
    const contr = (!subjTok && adj.adj === "bad") ? "That's" : `${subjNP} ${be}`;
    const s = `${contr}${neg ? " not" : ""} ${adj.adj}${time ? " " + time.w : ""}.`;
    return finish(maybe ? "Maybe " + lcFirst(cap(s)) : cap(s), { greet, yes, ok:true });
  }

  if(q){
    const ag = agents[0] || things[0] || place;
    if(ag){
      const np = ag.t === "place" ? ag.at : npOf(ag, "s", poss);
      const be = ag.t === "place" ? "is" : beOf(np);
      const s = ag.t === "pron" && ag.p === "I" ? `${q.w} ${be} I?` : `${q.w} ${be} ${np}?`;
      return finish(s, { greet, yes, ok:true });
    }
    return { text:`${q.w}?`, ok:true };
  }

  if(greet){ const rest = toks.filter(t => t.t !== "greet"); return rest.length ? finish(ruleEngine(rest.map(t => t.key)).text, { greet, ok:false }) : { text:greet.say, ok:true }; }
  if(please && toks.length <= 2 && agents.length === 0) return { text:"Please.", ok:true };

  /* nothing we can build confidently: readable word-join, flagged so the AI is preferred */
  const joined = toks.map(t => t.t === "name" ? t.name : t.key.toLowerCase()).join(", ");
  return { text:cap(joined) + ".", ok:false };
}

const LOWERABLE = new Set(["my","where","what","who","why","how","when","that","that's","please","do","does","did","stop","help","hello","are","is","will","have","has","the","can"]);
function finish(sentence, { greet, yes, ok }){
  let s = sentence;
  if(yes){
    const first = s.split(/[\s!?.,]/)[0].toLowerCase();
    /* only lower-case plain function words — never "I" or a person's name */
    s = `Yes, ${LOWERABLE.has(first) ? s.charAt(0).toLowerCase() + s.slice(1) : s}`;
  }
  if(greet) s = `${greet.say} ${s}`;
  return { text:s, ok:ok !== false };
}

/* ====================== 4. UTILITIES ====================== */

/* mode of an array (for the zone recorded during a teach session) */
export function modeOf(arr){
  const c = new Map(); let best = null, n = 0;
  for(const a of arr){ if(a == null) continue; c.set(a, (c.get(a)||0)+1); if(c.get(a) > n){ n = c.get(a); best = a; } }
  return best;
}

/* distance penalty when a taught sign is performed in a different face zone than it was taught in */
export function zonePenalty(savedZone, nowZone){
  if(!savedZone || !nowZone || savedZone === "any" || nowZone === "any") return 0;
  if(savedZone === nowZone) return 0;
  return ZONE_GROUP[savedZone] === ZONE_GROUP[nowZone] ? 0.02 : 0.07;
}

/* ---------------- who is the signer? ----------------
   With several people in the frame, only ONE person is the signer: the prominent, central face. Everyone else (faces and hands)
   is background and must never reach the recognizer. All pure functions so they can be tested without a camera. */

/* faces: [{cx, cy, w, h}] in 0..1 image units (centre and size). prev: the signer's last {cx, cy, w} or null.
   Score = size x how central it is; a face that is where the signer just was gets a stickiness bonus so two similar faces cannot flip-flop. */
export function pickSigner(faces, prev) {
  let best = -1, bestScore = 0;
  faces.forEach((f, i) => {
    const central = Math.max(0.12, 1 - 1.4 * Math.abs(f.cx - 0.5) - 0.4 * Math.abs(f.cy - 0.4));
    let s = f.w * f.h * central;
    if (prev && Math.hypot(f.cx - prev.cx, f.cy - prev.cy) < Math.max(prev.w, f.w) * 0.9) s *= 1.8;
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

const HAND_SPAN = (lm, aspect) => Math.hypot((lm[0].x - lm[9].x) * aspect, lm[0].y - lm[9].y);

/* hands: raw landmark arrays (0..4). face: the signer's face frame or null. Returns indices to keep (max 2, nearest the signer first) and indices ignored.
   With a face: a hand belongs to the signer when it is within arm's reach of the signer's face (sideways and vertically)
   and its size fits that face's distance from the camera. Without a face: the biggest, most central hand(s) win, and a clearly smaller (farther) hand is ignored. */
export function selectSignerHands(hands, face, aspect, maxHands = 2) {
  const n = hands.length;
  if (n === 0) return { keep: [], dropped: [] };
  const info = hands.map((lm, i) => {
    const span = HAND_SPAN(lm, aspect);
    const c = { x: (lm[0].x + lm[9].x) / 2, y: (lm[0].y + lm[9].y) / 2 };
    return { i, lm, span, c };
  });
  let ok;
  if (face) {
    ok = info.filter(h => {
      const P = toFace(face, toMirroredSpace(h.c, aspect));
      h.u = P.u; h.v = P.v;
      const ratio = h.span / face.ipd;
      return Math.abs(P.u) <= 6.5 && P.v >= -5 && P.v <= 18 && ratio >= 0.4 && ratio <= 5;
    });
    ok.sort((a, b) => Math.abs(a.u) - Math.abs(b.u));
  } else {
    const maxSpan = Math.max(...info.map(h => h.span));
    ok = info.filter(h => h.span >= 0.6 * maxSpan && h.c.x > 0.04 && h.c.x < 0.96);
    ok.forEach(h => { h.score = h.span * (1.2 - Math.abs(h.c.x - 0.5)); });
    ok.sort((a, b) => b.score - a.score);
    if (ok.length > 1 && Math.hypot((ok[0].c.x - ok[1].c.x) * aspect, ok[0].c.y - ok[1].c.y) > 9 * ok[0].span) ok = [ok[0]];   // too far apart to be one person's two hands
  }
  const keep = ok.slice(0, maxHands).map(h => h.i);
  return { keep, dropped: info.map(h => h.i).filter(i => !keep.includes(i)) };
}
