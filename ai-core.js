/* Shared by the Netlify function (server) and the browser (direct-key fallback).
   Builds the Claude request, forces structured output through a tool schema, and parses the answer. */

export const DEFAULT_MODEL = "claude-haiku-5-5";   // fast + cheap: this runs on every signing pause

export const LANGS = { en: "English", hi: "Hindi", te: "Telugu", ta: "Tamil" };
export const TONES = ["casual", "formal"];

const VOCAB = "HELLO BYE THANK YOU PLEASE SORRY YES NO GOOD BAD OK WELCOME WAIT STOP ME YOU WE MY NAME FRIEND FAMILY BABY FATHER MOTHER BROTHER SISTER SON DAUGHTER GRANDFATHER GRANDMOTHER WHAT WHERE WHO WHY HOW WHEN TODAY TOMORROW YESTERDAY NOW LATER MORNING NIGHT FINISH GO COME EAT DRINK SLEEP WORK HELP LOVE UNDERSTAND KNOW THINK REMEMBER FORGET SEE LOOK HEAR LISTEN TALK LEARN TEACH WANT NEED GIVE TAKE BUY MONEY WRITE READ PLAY LIKE HAPPY SAD ANGRY AFRAID TIRED HUNGRY THIRSTY PAIN SICK COLD BEAUTIFUL HOME SCHOOL HOSPITAL DOCTOR WATER FOOD PHONE BOOK TOILET MEDICINE BIG SMALL MORE ALL AGAIN MAYBE";

export const SYSTEM_PROMPT = `You are the language engine of SignBridge, a two-way interpreter for Indian Sign Language (ISL).

A camera-based recognizer turns a signer's hands into a list of word tokens ("glosses"). Your job: work out what the signer most plausibly MEANT and say it as one natural sentence a hearing person can understand.

How the input works:
- Tokens are in ISL gloss order, which is NOT English order. ISL is typically subject-object-verb, puts time words first, and puts question words last. Tense and function words are usually absent.
- The recognizer is imperfect. Each token carries a confidence (0-1), the face zone where it was signed and its motion. Each token may also carry "alternatives": the recognizer's next-best guesses with scores. If the top token makes the sentence nonsense but an alternative fits the other tokens and the conversation, use the alternative, and list the doubted token in "suspect". Never prefer an alternative when the top token already makes sense.
- Vocabulary is fixed (100 signs): ${VOCAB}. Any other token is a name or word the signer taught the app (treat as a person's name or a noun).
- FINISH or YESTERDAY marks past; TOMORROW or LATER marks future; NO negates; ME is "I/me", WE is "we", MY is "my". Question words (WHAT, WHERE, WHO, WHY, HOW, WHEN) usually come last and turn the sentence into a question. A bare emotion/state word (HUNGRY, TIRED, PAIN) is about the signer. WANT/NEED + noun = "I want/need <noun>". YOU + word = addressing the other person.
- "turns" is the conversation so far (who: "signer" or "hearing", newest last). If the signing looks like an answer, use that context to disambiguate (e.g. hearing: "Where are you going tomorrow?" + signer: SCHOOL GO -> "I'm going to school tomorrow.").
- Examples: [ME, SCHOOL, GO, TOMORROW] -> "I'm going to school tomorrow."; [YOU, NAME, WHAT] -> "What's your name?"; [ME, FOOD, WANT] -> "I want food."; [YESTERDAY, ME, HOSPITAL, GO] -> "I went to the hospital yesterday."; [ME, PAIN, DOCTOR, NEED] -> "I'm in pain and I need a doctor."; [HELLO, ME, HAPPY] -> "Hello! I'm happy."

Rules:
- Stay faithful to the tokens. Do not invent facts, names, places or times that are not signed or clearly implied by context.
- Speak as the signer, in first person, unless the tokens or context clearly show otherwise.
- One short sentence (two at most when a greeting plus a statement). Natural spoken English.
- "tone": casual = everyday contractions and warm; formal = polite, complete sentences, suitable for a doctor, bank or office.
- If the tokens are genuinely ambiguous, give your best reading as "sentence" and up to 2 other plausible readings in "alternatives". If not ambiguous, leave alternatives empty.
- List in "suspect" only tokens you chose to ignore or doubt as likely recognition errors.
- List in "confirm" at most 2 tokens whose recognition confidence is low AND whose meaning changes the sentence, so the signer can check them. Otherwise leave it empty.
- "intent" is a 1-4 word label for what the signer is doing (e.g. "greeting", "asking where someone is", "making a plan", "asking for help").
- If "language" is not English, also fill "target" with the same sentence naturally translated into that language, in its own script. The "sentence" field stays in English.
Always answer by calling the emit_sentence tool.`;

export const EXPLAIN_PROMPT = `You explain, in plain words, how SignBridge read a signer's hand signs. You get the recognized tokens (with confidence and the recognizer's alternatives), the conversation so far, and the final sentence. In 1-2 short sentences, say why the sentence follows from the tokens: the word order, any word you treated as a likely misread, and what context helped. Be honest about uncertainty. Do not invent anything not in the input. Answer by calling the emit_explanation tool.`;

export const COACH_PROMPT = `You are a warm, concise sign-language coach inside SignBridge. The learner is practising one sign from a demo Indian Sign Language vocabulary. You get the word, how the sign is made, and what the camera currently sees wrong. In at most 2 short sentences, give one concrete, encouraging tip about hand shape, position or movement. Do not invent details that are not in the input. Answer by calling the emit_explanation tool.`;

export const TOOL = {
  name: "emit_sentence",
  description: "Return the interpreted sentence for the signed tokens.",
  input_schema: {
    type: "object",
    properties: {
      sentence:     { type: "string", description: "Best natural English sentence, as the signer would say it." },
      target:       { type: "string", description: "The same sentence in the requested non-English language and script. Empty if language is English." },
      alternatives: { type: "array", items: { type: "string" }, description: "0-2 other plausible readings, only if ambiguous." },
      intent:       { type: "string", description: "1-4 word label of the communicative intent." },
      suspect:      { type: "array", items: { type: "string" }, description: "Input tokens ignored or doubted as probable misrecognitions." },
      confirm:      { type: "array", items: { type: "string" }, description: "At most 2 low-confidence input tokens the signer should confirm." }
    },
    required: ["sentence", "alternatives", "intent", "suspect"]
  }
};
export const EXPLAIN_TOOL = {
  name: "emit_explanation",
  description: "Return a short plain-language explanation of the reading.",
  input_schema: { type: "object", properties: { explanation: { type: "string" } }, required: ["explanation"] }
};

const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

/* Defensive: this is the only place untrusted browser input is accepted. */
export function sanitizePayload(raw){
  const words = Array.isArray(raw?.words) ? raw.words.slice(0, 16).map(w => clip(w, 24)).filter(Boolean) : [];
  const details = Array.isArray(raw?.details) ? raw.details.slice(0, 16).map(d => ({
    w: clip(d?.w, 24),
    conf: Number.isFinite(d?.conf) ? Math.max(0, Math.min(1, Math.round(d.conf * 100) / 100)) : null,
    zone: clip(d?.zone, 12) || null,
    motion: clip(d?.motion, 12) || null,
    alts: Array.isArray(d?.alts) ? d.alts.slice(0, 3).map(a => ({ w: clip(a?.w ?? a, 24), s: Number.isFinite(a?.s ?? a?.c) ? Math.round((a.s ?? a.c) * 100) / 100 : null })).filter(a => a.w) : []
  })) : [];
  /* conversation memory: last 5 turns. Older clients send history[] (signer lines) and heard (hearing line). */
  let turns = Array.isArray(raw?.turns) ? raw.turns.slice(-5).map(t => ({ who: t?.who === "hearing" ? "hearing" : "signer", text: clip(t?.text, 160) })).filter(t => t.text) : [];
  if (!turns.length) {
    const hist = Array.isArray(raw?.history) ? raw.history.slice(-3).map(h => ({ who: "signer", text: clip(h, 160) })).filter(t => t.text) : [];
    const heard = clip(raw?.heard, 160);
    turns = [...hist, ...(heard ? [{ who: "hearing", text: heard }] : [])];
  }
  const language = Object.prototype.hasOwnProperty.call(LANGS, raw?.language) ? raw.language : "en";
  const tone = TONES.includes(raw?.tone) ? raw.tone : "casual";
  const mode = raw?.mode === "explain" ? "explain" : raw?.mode === "coach" ? "coach" : "interpret";
  const sentence = clip(raw?.sentence, 300);
  return { words, details: details.length === words.length ? details : [], turns, language, tone, mode, sentence };
}

export function buildRequestBody(payload, model = DEFAULT_MODEL){
  const p = sanitizePayload(payload);
  const tokens = p.words.map((w, i) => {
    const d = p.details[i];
    return d ? { token: w, confidence: d.conf, zone: d.zone, motion: d.motion, ...(d.alts && d.alts.length ? { alternatives: d.alts } : {}) } : { token: w };
  });
  if (p.mode === "coach") {
    return {
      model, max_tokens: 160, system: COACH_PROMPT, tools: [EXPLAIN_TOOL],
      tool_choice: { type: "tool", name: EXPLAIN_TOOL.name },
      messages: [{ role: "user", content: JSON.stringify({ word: p.words[0] || "", details: p.sentence }) }]
    };
  }
  if (p.mode === "explain") {
    return {
      model, max_tokens: 200, system: EXPLAIN_PROMPT, tools: [EXPLAIN_TOOL],
      tool_choice: { type: "tool", name: EXPLAIN_TOOL.name },
      messages: [{ role: "user", content: JSON.stringify({ tokens, turns: p.turns, sentence: p.sentence }) }]
    };
  }
  const user = JSON.stringify({ tokens, turns: p.turns, tone: p.tone, language: LANGS[p.language] });
  return {
    model,
    max_tokens: p.language === "en" ? 300 : 450,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: user }]
  };
}

/* Accepts the raw Messages API JSON. Returns a clean result or null. */
export function parseToolResult(json){
  const arr = a => Array.isArray(a) ? a.filter(x => typeof x === "string").map(x => clip(x, 160)).filter(Boolean) : [];
  const ex = Array.isArray(json?.content) ? json.content.find(b => b.type === "tool_use" && b.name === EXPLAIN_TOOL.name) : null;
  if (ex) return typeof ex.input?.explanation === "string" && ex.input.explanation.trim() ? { explanation: clip(ex.input.explanation, 400) } : null;
  const block = Array.isArray(json?.content) ? json.content.find(b => b.type === "tool_use" && b.name === TOOL.name) : null;
  const input = block?.input;
  if(!input || typeof input.sentence !== "string" || !input.sentence.trim()) return null;
  return {
    text: clip(input.sentence, 300),
    target: typeof input.target === "string" ? clip(input.target, 400) : "",
    alts: arr(input.alternatives).filter(a => a !== clip(input.sentence, 300)).slice(0, 2),
    intent: clip(input.intent, 40),
    suspect: arr(input.suspect).slice(0, 8),
    confirm: arr(input.confirm).slice(0, 2)
  };
}
