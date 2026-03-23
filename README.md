# 中文 Flow

Pimsleur-inspired adaptive Chinese learning game. No lessons — one continuous flow that introduces words, spirals back at expanding intervals, and adapts to how you're actually learning.

Built for macOS (uses native TTS). Zero dependencies.

## Quick Start

```bash
npm start
# Open http://localhost:3000
# Press Space to start learning
```

Requires **Node.js 18+** and **macOS** (uses the `say` command with the Tingting Mandarin voice for audio).

## How It Works

- **Adaptive engine** — every question is chosen dynamically based on your performance. Struggling? It slows down. Cruising? It pushes new material.
- **SM-2 spaced repetition** — tracks each word's easiness, interval, and review schedule across sessions.
- **Pimsleur-style cascading** — new words spiral back at expanding intervals within a session, each time with a different drill type.
- **5 drill types**: Character → Meaning, Character → Pinyin, Listening (audio only), Meaning → Character, Sentence Comprehension.
- **Character mnemonics** — visual stories breaking characters into radicals. Editable — write your own associations.
- **Deep dive mode** — when drilling fails twice, switches to teaching: character breakdown, example sentences, slow audio.
- **Mastery stages** — words progress through: Just met → Fragile → Growing → Solid → Mastered. Advancement requires evidence across multiple days and drill types.
- **Don't Know button** (Space) — honest "I don't know" that prevents guessing from corrupting your data.

## Claude Code Integration

This project is designed to work with [Claude Code](https://claude.ai/code) as an AI tutor. Claude reads your progress data, analyzes learning signals, writes coaching assessments, adjusts vocabulary, and restructures the system based on what's actually working. See `CLAUDE.md` for the full protocol.

## Data

All progress is stored in JSON files under `data/`:

- `progress.json` — per-word SM-2 state and full answer history (gitignored)
- `sessions/` — detailed session logs with learning signals (gitignored)
- `vocabulary.json` — 120 travel-essential words with mnemonics (HSK 1-2)
- `sentences.json` — 20 sentence comprehension drills

Your learning data never leaves your machine.

## License

ISC
