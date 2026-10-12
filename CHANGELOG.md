# Changelog — Phase 2

## Segment 1 — Recognizing
- Per-user 20 s calibration (open hand, fist, point); validated, saved on-device, resettable; falls back to defaults if the poses are not clearly different.
- Temporal n-best smoothing (top 3), recognition lab panel, hold-to-fire / resting-hand / release-before-repeat kept.
- Matcher thresholds tightened after loosening (accept 0.56, margin 0.06) to keep false positives down. Synthetic only: 100% self-recognition on noisy generated hands; random held poses are still accepted often (see `test/metrics.mjs`), so the hold, resting and release guards matter.

## Segment 2 — Understanding
- Claude request v2: words + per-word confidence/zone/motion/alternatives + last 5 turns + what the hearing person said. Tool-forced output: sentence, intent, alternative reading, low-confidence words.
- "Explain my reading" mode. Offline engine remains instant draft and fallback. Tests use a mocked Claude.

## Segment 3 — Teaching
- Learn a sign with live finger-state coaching (no AI required), optional Claude tip; practice game (score, streak); sign packs export/import with strict validation. Delete controls, collision checks and test-it-now kept.

## Segment 4 — Sentence
- 14 offline phrases, tense/question/negation/politeness rules, casual/formal tone, output in English/Hindi/Telugu/Tamil via Claude + browser TTS, transcript bubbles with copy/clear.

## UI
- New two-panel layout, light/dark, onboarding, Demo mode, Judge view with live stats counting real recognitions separately from manual test words.

## Late addition
- Copyright/credits footer and a simple in-browser human check (arithmetic, honeypot field). Not server-side bot protection; see README.

## Cut / not done
- No server-side speech; no real-hand accuracy claim; no official ISLRTC vocabulary.
