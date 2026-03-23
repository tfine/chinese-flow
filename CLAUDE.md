# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Pimsleur-inspired cascading Chinese learning web app built for lifelong use. No discrete lessons — a continuous adaptive flow that introduces words, spirals back at expanding intervals, and interleaves listening drills and sentence comprehension. SM-2 spaced repetition tracks mastery. Near-term milestone: trip to China on 2026-05-03. Long-term goal: full mastery through HSK 1-6.

## Forever Architecture

All learning data is permanent and cumulative. The system is designed to scale from beginner to advanced:
- `data/progress.json` — complete answer history per word, never deleted. Enables long-term trend analysis.
- `data/sessions/` — every session preserved. Enables cross-session learning signal analysis.
- Vocabulary expandable: currently 120 words (HSK 1-2). Add HSK 3-6 progressively as user advances.
- Mastery stages per word: Unseen → Just met → Fragile → Growing → Solid → Mastered.
- Stage advancement requires evidence across multiple days and drill types — not just correct answers.
- Claude Code's coaching role evolves: early = pacing/mnemonics, later = grammar, conversation, cultural context.
- Words flagged `stuck: true` in progress.json need alternative teaching approaches from Claude Code.

## Commands

- `npm start` — runs the server on http://localhost:3000
- `npm run report` — generates a progress report to stdout and `data/reports/`

## Architecture

Single-page web app with a vanilla Node.js HTTP server (no framework, no dependencies).

- `server.js` — HTTP server, serves static files from `public/`, API endpoints under `/api/`, TTS via macOS `say` command (Tingting voice for zh_CN)
- `public/app.js` — all game logic: SM-2 algorithm, cascade queue builder, drill types, keyboard input, session tracking, learning signal computation
- `public/index.html` + `style.css` — dark-themed game UI with coach panel
- `data/vocabulary.json` — master word list (120 travel-essential words, HSK 1-2)
- `data/sentences.json` — sentence bank for comprehension drills
- `data/progress.json` — per-word SM-2 state (EF, interval, reps, review date, answer history)
- `data/sessions/` — one JSON file per study session with answers + learning signals
- `data/assessment.json` — Claude Code writes this; the app displays it on the splash screen
- `data/reports/` — generated markdown progress reports

## Dynamic Assessment Protocol — THE TIGHT LOOP

Claude Code is the coach. This is not passive — every conversation should include assessment.

### On every conversation start:
1. Read `data/progress.json` — check EF values, intervals, history
2. Read the most recent 3-5 files in `data/sessions/` — check learningSignals
3. Write an updated `data/assessment.json` with coaching message, focus areas, and weekly goal
4. The app loads this file on every return to the splash screen, so changes appear immediately

### What to look for (learning vs. quiz performance):
- **Retention rate** (in learningSignals): Are review words actually retained? >85% = real learning. <70% = too many new words, slow down.
- **Speed trend** (in learningSignals): <1.0 means getting faster (automaticity building). >1.1 means struggling, words aren't solidifying.
- **Listening vs reading gap**: If listening accuracy is 20%+ below reading, the user is reading characters but not hearing them. Shift to more listening drills.
- **Absorption rate**: Of new words introduced and spiral-tested, how many stuck? <50% means introducing too fast.
- **Leeches** (EF < 1.8): Words that keep failing. Consider: are they too similar to other words? Should they be paired with a mnemonic sentence?
- **Category gaps**: If a category is below 60% accuracy, add more words from that category or more sentences using those words.

### Actions Claude Code can take:
- **Write `data/assessment.json`** — message, focus areas, weekly goal. App displays this.
- **Edit `data/vocabulary.json`** — add words targeting weak areas, add travel-critical phrases as trip approaches.
- **Edit `data/sentences.json`** — add sentences that exercise weak vocabulary in context.
- **Edit `public/app.js` constants** — `MAX_NEW_PER_SESSION` (slow down or speed up introduction rate).
- **Run `npm run report`** — generate a full progress report.
- **Discuss with user** — explain what the signals mean, what's actually being learned vs. just passed, suggest study strategies.

### Assessment.json format:
```json
{
  "timestamp": "ISO date",
  "message": "Coaching message shown on splash screen",
  "focus": ["category or skill to focus on"],
  "metrics": { "retention": 85, "speedTrend": 0.9, "listenGap": 12 },
  "adjustments": ["what was changed and why"],
  "weeklyGoal": "concrete goal for this week"
}
```

### Philosophy — what counts as learning:
- **Not learning**: Getting a word right that you just saw 2 seconds ago. That's short-term memory.
- **Learning**: Getting a word right after a delay, across different drill types, from audio alone.
- **Deep learning**: Response time dropping below 2 seconds. The word is automatic. No translation happening — direct comprehension.
- The SM-2 interval tells you how deep a word is embedded. Interval 1 = fragile. Interval 7+ = solidifying. Interval 21+ = acquired.
- Listening comprehension is the real goal. If reading accuracy is high but listening is low, that's a false signal.

## Drill Types

- **Character → Meaning**: show 汉字, pick English (4 choices)
- **Character → Pinyin**: show 汉字, pick pinyin
- **Listening**: audio only, pick English meaning
- **Meaning → Character**: show English, pick 汉字
- **Sentence Comprehension**: show/play full sentence, pick translation

## Cascade Flow (Pimsleur Strategy)

The cascade queue introduces new words then spirals back at expanding intervals within a single session: test immediately, then 2 items later, then 4 items later, varying the drill type each time. Wrong answers get re-inserted 2 positions ahead for immediate re-test. Due review cards (from SM-2) are interleaved. Sentences appear once enough vocabulary is known.

## TTS

Uses macOS `say -v Tingting` for Mandarin audio. The `/api/tts?text=你好&rate=180` endpoint generates AIFF audio on the fly. Rate 140 for new word introductions (slower), 180 for normal drills.
