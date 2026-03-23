// ─── STATE ──────────────────────────────────────────
let vocab = [];
let sentences = [];
let progress = {};
let assessment = {};
let settings = {};
let sessionAnswers = [];
let currentQ = null;
let questionStart = 0;
let timerInterval = null;
let score = 0;
let total = 0;
let streak = 0;
let bestStreak = 0;
let answered = false;
let inIntro = false; // true during new word intro screens
let currentMode = 'cascade';
let cascadeQueue = [];      // Pimsleur-style queue: items scheduled at specific times
let cascadeStartTime = 0;
let newWordsThisSession = 0;
let MAX_NEW_PER_SESSION = 5;

// ─── SM-2 ───────────────────────────────────────────
function sm2(prev, quality) {
  let { ef = 2.5, interval = 0, reps = 0 } = prev || {};
  if (quality >= 3) {
    reps++;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ef);
    ef = Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  } else {
    reps = 0;
    interval = 1;
    ef = Math.max(1.3, ef - 0.2);
  }
  const next = new Date();
  next.setDate(next.getDate() + interval);
  return { ef: Math.round(ef * 100) / 100, interval, reps, nextReview: next.toISOString().slice(0, 10) };
}

function qualityFromResult(correct, responseMs) {
  if (!correct) return 1;
  if (responseMs < 2000) return 5;
  if (responseMs < 4000) return 4;
  if (responseMs < 7000) return 3;
  return 3;
}

// ─── DATA ───────────────────────────────────────────
function getGoalDate() {
  if (settings.goal && settings.goal.date) return new Date(settings.goal.date);
  return null;
}

function getGoalLabel() {
  if (settings.goal && settings.goal.label) return settings.goal.label;
  return 'Goal';
}

async function loadData() {
  [vocab, sentences, progress, assessment, settings] = await Promise.all([
    fetch('/api/vocabulary').then(r => r.json()),
    fetch('/api/sentences').then(r => r.json()),
    fetch('/api/progress').then(r => r.json()),
    fetch('/api/assessment').then(r => r.json()).catch(() => ({})),
    fetch('/api/settings').then(r => r.json()).catch(() => ({})),
  ]);
  if (settings.newWordsPerSession) MAX_NEW_PER_SESSION = settings.newWordsPerSession;
  updateDueInfo();
  updateGoalCountdown();
  updateCoachPanel();
}

async function saveProgress() {
  await fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(progress),
  });
}

function computeLearningSignals() {
  // Compute deeper metrics that distinguish real learning from quiz performance
  const signals = {};

  // 1. Retention rate: % of previously-seen words answered correctly on first try this session
  const reviewAnswers = sessionAnswers.filter(a => {
    if (!a.vocabId) return false;
    const p = progress[a.vocabId];
    return p && p.history && p.history.length > 1; // seen before this session
  });
  const firstAttempts = {};
  for (const a of reviewAnswers) {
    if (!firstAttempts[a.vocabId]) firstAttempts[a.vocabId] = a;
  }
  const retentionItems = Object.values(firstAttempts);
  signals.retentionRate = retentionItems.length > 0
    ? Math.round(retentionItems.filter(a => a.correct).length / retentionItems.length * 100)
    : null;

  // 2. Speed trend: are response times getting faster for known words?
  const speedTrends = [];
  for (const a of sessionAnswers) {
    if (!a.vocabId || !a.correct) continue;
    const p = progress[a.vocabId];
    if (!p || !p.history || p.history.length < 3) continue;
    const pastCorrect = p.history.filter(h => h.correct).slice(-5);
    if (pastCorrect.length >= 2) {
      const avgPast = pastCorrect.reduce((s, h) => s + h.responseMs, 0) / pastCorrect.length;
      speedTrends.push({ ratio: a.responseMs / avgPast, vocabId: a.vocabId });
    }
  }
  signals.speedTrend = speedTrends.length > 0
    ? Math.round(speedTrends.reduce((s, t) => s + t.ratio, 0) / speedTrends.length * 100) / 100
    : null;
  // < 1.0 means getting faster (good), > 1.0 means slowing down

  // 3. Drill diversity: how well does knowledge transfer across drill types?
  const drillAccuracy = {};
  for (const a of sessionAnswers) {
    if (!drillAccuracy[a.drill]) drillAccuracy[a.drill] = { correct: 0, total: 0 };
    drillAccuracy[a.drill].total++;
    if (a.correct) drillAccuracy[a.drill].correct++;
  }
  signals.drillAccuracy = drillAccuracy;

  // 4. Listening vs reading gap
  const listeningAnswers = sessionAnswers.filter(a => a.drill === 'LISTENING');
  const readingAnswers = sessionAnswers.filter(a => a.drill === 'CHARACTER → MEANING');
  signals.listeningAccuracy = listeningAnswers.length > 0
    ? Math.round(listeningAnswers.filter(a => a.correct).length / listeningAnswers.length * 100)
    : null;
  signals.readingAccuracy = readingAnswers.length > 0
    ? Math.round(readingAnswers.filter(a => a.correct).length / readingAnswers.length * 100)
    : null;

  // 5. New word absorption: of words introduced this session, how many were correct on spiral-back?
  const newWordIds = new Set();
  const newWordResults = {};
  for (const a of sessionAnswers) {
    if (!a.vocabId) continue;
    const p = progress[a.vocabId];
    if (p && p.history && p.history.length <= 3) {
      newWordIds.add(a.vocabId);
      if (!newWordResults[a.vocabId]) newWordResults[a.vocabId] = [];
      newWordResults[a.vocabId].push(a.correct);
    }
  }
  const absorbed = Object.values(newWordResults).filter(results =>
    results.length >= 2 && results[results.length - 1] === true
  ).length;
  signals.absorptionRate = newWordIds.size > 0
    ? Math.round(absorbed / newWordIds.size * 100)
    : null;

  return signals;
}

async function saveSession() {
  if (sessionAnswers.length === 0) return;
  const signals = computeLearningSignals();
  await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startTime: new Date(cascadeStartTime).toISOString(),
      endTime: new Date().toISOString(),
      mode: currentMode,
      totalQuestions: total,
      correct: score,
      streak: bestStreak,
      answers: sessionAnswers,
      newWordsIntroduced: newWordsThisSession,
      learningSignals: signals,
    }),
  });
}

// ─── AUDIO ──────────────────────────────────────────
let audioEl = null;
let lastAudioText = '';

function playAudio(text, rate = 180) {
  lastAudioText = text;
  if (audioEl) { audioEl.pause(); audioEl = null; }
  audioEl = new Audio(`/api/tts?text=${encodeURIComponent(text)}&rate=${rate}`);
  audioEl.play().catch(() => {});
}

function replayAudio() {
  if (lastAudioText) playAudio(lastAudioText);
}

// ─── SCREENS ────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showSplash() {
  // Reload data every time we return to splash (picks up Claude Code changes)
  loadData();
  showScreen('splash');
}

function updateCoachPanel() {
  const msg = document.getElementById('coach-message');
  const focus = document.getElementById('coach-focus');
  const goal = document.getElementById('coach-goal');
  if (assessment && assessment.message) {
    msg.textContent = assessment.message;
    if (assessment.focus && assessment.focus.length > 0) {
      focus.textContent = 'Focus: ' + assessment.focus.join(' · ');
    } else {
      focus.textContent = '';
    }
    if (assessment.weeklyGoal) {
      goal.textContent = 'Goal: ' + assessment.weeklyGoal;
    } else {
      goal.textContent = '';
    }
  } else {
    msg.textContent = 'Start a session to begin learning!';
    focus.textContent = '';
    goal.textContent = '';
  }
}

// ─── GOAL COUNTDOWN ─────────────────────────────────
function updateGoalCountdown() {
  const el = document.getElementById('trip-countdown');
  const goalDate = getGoalDate();
  if (!goalDate || !settings.goal.date) {
    el.innerHTML = `<span style="cursor:pointer" onclick="showGoalEditor()">Set a goal →</span>`;
    return;
  }
  const days = Math.ceil((goalDate - new Date()) / 86400000);
  const label = getGoalLabel();
  if (days > 0) {
    el.innerHTML = `<span style="cursor:pointer" onclick="showGoalEditor()">${days} days until ${label}</span>`;
  } else {
    el.innerHTML = `<span style="cursor:pointer" onclick="showGoalEditor()">${label} is here! Keep learning!</span>`;
  }
}

function showGoalEditor() {
  const el = document.getElementById('trip-countdown');
  const currentLabel = settings.goal?.label || '';
  const currentDate = settings.goal?.date || '';
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
      <input id="goal-label" type="text" placeholder="Goal name (e.g. China trip)" value="${currentLabel}"
        style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:4px;font-family:inherit;font-size:0.85rem;width:220px;text-align:center">
      <input id="goal-date" type="date" value="${currentDate}"
        style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:4px;font-family:inherit;font-size:0.85rem;width:220px;text-align:center">
      <div style="display:flex;gap:8px">
        <button onclick="saveGoal()" style="background:var(--accent);color:#000;border:none;padding:5px 16px;border-radius:4px;font-family:inherit;cursor:pointer;font-size:0.8rem">Save</button>
        <button onclick="clearGoal()" style="background:var(--surface);color:var(--dim);border:1px solid var(--border);padding:5px 16px;border-radius:4px;font-family:inherit;cursor:pointer;font-size:0.8rem">Clear</button>
      </div>
    </div>`;
  // Prevent keys from triggering game start
  for (const id of ['goal-label', 'goal-date']) {
    document.getElementById(id).addEventListener('keydown', e => e.stopPropagation());
  }
}

async function saveGoal() {
  const label = document.getElementById('goal-label').value.trim();
  const date = document.getElementById('goal-date').value;
  settings.goal = { label: label || 'Goal', date };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  updateGoalCountdown();
}

async function clearGoal() {
  settings.goal = { label: '', date: '' };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  updateGoalCountdown();
}

// ─── DUE INFO ───────────────────────────────────────
function getDueCards() {
  const today = new Date().toISOString().slice(0, 10);
  return vocab.filter(v => {
    const p = progress[v.id];
    if (!p) return false;
    return p.nextReview <= today;
  });
}

function getNewCards() {
  return vocab.filter(v => !progress[v.id]);
}

function updateDueInfo() {
  const due = getDueCards().length;
  const learned = Object.keys(progress).length;
  const el = document.getElementById('due-info');
  el.textContent = `${due} cards due · ${learned}/${vocab.length} words learned`;
}

// ─── DRILL TYPES ────────────────────────────────────
// Each drill returns { promptZh, promptPinyin, promptEn, showAudio, choices, correctIdx, badge }
// Choices are { text, sub }

function pickDistractors(correct, pool, count, field) {
  const others = pool.filter(v => v.id !== correct.id);
  const shuffled = others.sort(() => Math.random() - 0.5);
  // prefer same category distractors
  const sameCat = shuffled.filter(v => v.cat === correct.cat);
  const diffCat = shuffled.filter(v => v.cat !== correct.cat);
  const picks = [...sameCat, ...diffCat].slice(0, count);
  return picks;
}

function drillCharToEn(item) {
  const distractors = pickDistractors(item, vocab, 3, 'en');
  const choices = [item, ...distractors].sort(() => Math.random() - 0.5);
  return {
    promptZh: item.zh,
    promptPinyin: '',
    promptEn: '',
    showAudio: true,
    audioText: item.zh,
    choices: choices.map(v => ({ text: v.en, sub: '' })),
    correctIdx: choices.indexOf(item),
    badge: 'CHARACTER → MEANING',
    vocabId: item.id,
  };
}

function drillCharToPinyin(item) {
  const distractors = pickDistractors(item, vocab, 3, 'pinyin');
  const choices = [item, ...distractors].sort(() => Math.random() - 0.5);
  return {
    promptZh: item.zh,
    promptPinyin: '',
    promptEn: '',
    showAudio: false,
    choices: choices.map(v => ({ text: v.pinyin, sub: '' })),
    correctIdx: choices.indexOf(item),
    badge: 'CHARACTER → PINYIN',
    vocabId: item.id,
  };
}

function drillListening(item) {
  const distractors = pickDistractors(item, vocab, 3, 'en');
  const choices = [item, ...distractors].sort(() => Math.random() - 0.5);
  return {
    promptZh: '',
    promptPinyin: '',
    promptEn: '',
    showAudio: true,
    audioText: item.zh,
    audioRate: item.zh.length >= 3 ? 150 : 170,
    autoPlay: true,
    choices: choices.map(v => ({ text: v.en, sub: '' })),
    correctIdx: choices.indexOf(item),
    badge: 'LISTENING',
    vocabId: item.id,
  };
}

function drillEnToChinese(item) {
  const distractors = pickDistractors(item, vocab, 3, 'zh');
  const choices = [item, ...distractors].sort(() => Math.random() - 0.5);
  return {
    promptZh: '',
    promptPinyin: '',
    promptEn: item.en,
    showAudio: false,
    choices: choices.map(v => ({ text: v.zh, sub: v.pinyin, isChinese: true })),
    correctIdx: choices.indexOf(item),
    badge: 'MEANING → CHARACTER',
    vocabId: item.id,
  };
}

function drillSentence(sent) {
  const otherSentences = sentences.filter(s => s.id !== sent.id).sort(() => Math.random() - 0.5).slice(0, 3);
  const choices = [sent, ...otherSentences].sort(() => Math.random() - 0.5);
  return {
    promptZh: sent.zh,
    promptPinyin: '',
    promptEn: '',
    showAudio: true,
    audioText: sent.zh,
    audioRate: 130,
    choices: choices.map(s => ({ text: s.en, sub: '' })),
    correctIdx: choices.indexOf(sent),
    badge: 'SENTENCE COMPREHENSION',
    vocabId: null,
    sentenceId: sent.id,
  };
}

// ─── ADAPTIVE CASCADE ENGINE ────────────────────────
// No pre-built queue. Every question decided dynamically based on what you need NOW.
// Tracks in-session state to spiral, adapt drill types, and control pacing.

let sessionIntroduced = [];   // words introduced THIS session: { item, questionsSinceTest, timesTestedThisSession }
let sessionWordHistory = {};  // vocabId -> [{ drill, correct, responseMs }] THIS session
let lastDrillType = '';
let lastVocabId = '';
let questionsUntilNewWord = 0;
let sessionSentenceCount = 0;

function getWordWeakestDrill(vocabId) {
  // Analyze all history to find which drill type this word is weakest at
  const p = progress[vocabId];
  if (!p || !p.history || p.history.length < 2) return null;

  const drillStats = {};
  for (const h of p.history) {
    const d = h.drill;
    if (!drillStats[d]) drillStats[d] = { correct: 0, total: 0, totalMs: 0 };
    drillStats[d].total++;
    drillStats[d].totalMs += h.responseMs;
    if (h.correct) drillStats[d].correct++;
  }

  // Find drill with lowest accuracy, or slowest average time if all correct
  let weakest = null;
  let worstScore = Infinity;
  for (const [drill, stats] of Object.entries(drillStats)) {
    const accuracy = stats.correct / stats.total;
    const avgMs = stats.totalMs / stats.total;
    // Score: accuracy * 100 - (avgMs / 200). Lower = weaker.
    const score = accuracy * 100 - (avgMs / 200);
    if (score < worstScore) {
      worstScore = score;
      weakest = drill;
    }
  }
  return weakest;
}

function drillNameToKey(drillName) {
  const map = {
    'CHARACTER → MEANING': 'charToEn',
    'CHARACTER → PINYIN': 'charToPinyin',
    'LISTENING': 'listening',
    'MEANING → CHARACTER': 'enToChinese',
  };
  return map[drillName] || 'charToEn';
}

function pickSmartDrill(item) {
  // Decide which drill type to use based on this word's performance profile
  const p = progress[item.id];
  const sessionHist = sessionWordHistory[item.id] || [];
  const allHistory = p ? (p.history || []) : [];

  // Drill types this word has been tested on this session
  const sessionDrills = new Set(sessionHist.map(h => h.drill));

  // All available drills
  const allDrills = ['charToEn', 'charToPinyin', 'listening', 'enToChinese'];

  // Compute per-drill accuracy from all history
  const drillPerf = {};
  for (const d of allDrills) drillPerf[d] = { correct: 0, total: 0, totalMs: 0 };
  for (const h of allHistory) {
    const key = drillNameToKey(h.drill);
    if (drillPerf[key]) {
      drillPerf[key].total++;
      drillPerf[key].totalMs += h.responseMs;
      if (h.correct) drillPerf[key].correct++;
    }
  }

  // Priority 1: drill types never tested on this word
  const untested = allDrills.filter(d => drillPerf[d].total === 0);
  if (untested.length > 0) {
    // Prefer in learning order: charToEn -> listening -> charToPinyin -> enToChinese
    const order = ['charToEn', 'listening', 'charToPinyin', 'enToChinese'];
    for (const d of order) {
      if (untested.includes(d) && !sessionDrills.has(d)) return d;
    }
    return untested[0];
  }

  // Priority 2: drill types not yet tested THIS session
  const notThisSession = allDrills.filter(d => !sessionDrills.has(d));

  // Priority 3: weakest drill type (lowest accuracy or slowest)
  let candidates = notThisSession.length > 0 ? notThisSession : allDrills;
  // Don't repeat the exact same drill back-to-back on same word
  if (candidates.length > 1 && lastVocabId === item.id) {
    candidates = candidates.filter(d => d !== drillNameToKey(lastDrillType));
  }

  // Score each candidate: lower = should drill more
  let best = candidates[0];
  let bestScore = Infinity;
  for (const d of candidates) {
    const perf = drillPerf[d];
    if (perf.total === 0) return d; // untested = top priority
    const accuracy = perf.correct / perf.total;
    const avgMs = perf.totalMs / perf.total;
    const score = accuracy * 100 - (avgMs / 100);
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function decideNextAction() {
  // The brain of the system. Called every question to decide what to do next.
  // Returns { type: 'intro'|'test'|'sentence', item?, drill?, sentence? }

  const today = new Date().toISOString().slice(0, 10);
  const knownWords = vocab.filter(v => progress[v.id] && progress[v.id].history.length > 0);

  // ─── Check spiral-backs first (Pimsleur core) ───
  // Recently introduced words need re-testing at expanding intervals
  for (const intro of sessionIntroduced) {
    intro.questionsSinceTest++;
    // Spiral schedule: test after 2, then 5, then 10, then 20 questions
    const thresholds = [2, 5, 10, 20];
    const threshold = thresholds[Math.min(intro.timesTestedThisSession, thresholds.length - 1)];
    if (intro.questionsSinceTest >= threshold && intro.timesTestedThisSession < 5) {
      intro.questionsSinceTest = 0;
      intro.timesTestedThisSession++;
      const drill = pickSmartDrill(intro.item);
      return { type: 'test', item: intro.item, drill };
    }
  }

  // ─── Check for words that were wrong recently in session ───
  for (const [vocabId, hist] of Object.entries(sessionWordHistory)) {
    const lastAttempt = hist[hist.length - 1];
    if (!lastAttempt.correct) {
      const questionsSinceWrong = total - lastAttempt.questionNum;
      const wrongCount = hist.filter(h => !h.correct).length;

      if (wrongCount >= 2 && questionsSinceWrong >= 2 && questionsSinceWrong < 8) {
        // Failed twice — switch to deep dive teaching, not more quizzing
        const item = vocab.find(v => v.id === vocabId);
        if (item) {
          // Mark as stuck so Claude Code can see it
          if (progress[vocabId]) {
            progress[vocabId].stuck = true;
            saveProgress();
          }
          return { type: 'deepdive', item };
        }
      } else if (wrongCount < 2 && questionsSinceWrong >= 2 && questionsSinceWrong < 6) {
        // Only wrong once — retry with easiest drill
        const item = vocab.find(v => v.id === vocabId);
        if (item && notOverdrilled(item)) return { type: 'test', item, drill: 'charToEn' };
      }
    }
  }

  // ─── Compute session health to decide pacing ───
  const recentAnswers = sessionAnswers.slice(-10);
  const recentAccuracy = recentAnswers.length > 0
    ? recentAnswers.filter(a => a.correct).length / recentAnswers.length
    : 1;
  const struggling = recentAccuracy < 0.7;
  const cruising = recentAccuracy >= 0.9 && sessionAnswers.length >= 5;

  // ─── Adjust max new words dynamically ───
  const effectiveMaxNew = struggling ? Math.min(2, MAX_NEW_PER_SESSION) : MAX_NEW_PER_SESSION;

  // ─── Due review cards ───
  const dueCards = getDueCards().sort((a, b) => {
    const pa = progress[a.id], pb = progress[b.id];
    return (pa.ef || 2.5) - (pb.ef || 2.5);
  });
  // Dynamic cap: depends on how you're doing with that word THIS session
  const notOverdrilled = (v) => {
    const sh = sessionWordHistory[v.id] || [];
    if (sh.length === 0) return true;
    const wrongCount = sh.filter(h => !h.correct).length;
    // If you've been wrong 2+ times this session, stop drilling — you need a different approach
    if (wrongCount >= 2) return false;
    // If all correct, allow up to 5 (for spiral-backs on new words)
    if (wrongCount === 0) return sh.length < 5;
    // 1 wrong: allow up to 3 attempts total
    return sh.length < 3;
  };

  const dueNotOverdrilled = dueCards.filter(notOverdrilled);

  // ─── Weakest known words (EF < 2.0, not due but need practice) ───
  const weakWords = knownWords
    .filter(v => (progress[v.id].ef || 2.5) < 2.0)
    .filter(notOverdrilled)
    .sort((a, b) => (progress[a.id].ef || 2.5) - (progress[b.id].ef || 2.5));

  // ─── New words ───
  const newCards = getNewCards().filter(v => v.travel);

  // ─── DECISION TREE ───

  // If struggling: no new words, drill weakest
  if (struggling && weakWords.length > 0) {
    const item = weakWords[0];
    const drill = pickSmartDrill(item);
    return { type: 'test', item, drill };
  }

  // Due cards first (always highest priority for retention)
  if (dueNotOverdrilled.length > 0 && questionsUntilNewWord > 0) {
    questionsUntilNewWord--;
    const item = dueNotOverdrilled[0];
    const drill = pickSmartDrill(item);
    return { type: 'test', item, drill };
  }

  // Introduce new word if allowed
  if (newWordsThisSession < effectiveMaxNew && newCards.length > 0 && !struggling) {
    questionsUntilNewWord = cruising ? 3 : 5; // space between new words
    return { type: 'intro', item: newCards[0] };
  }

  // Sentence challenge (every ~12 questions, if enough vocab known)
  if (knownWords.length >= 8 && total > 0 && total % 12 === 0 && sessionSentenceCount < 5) {
    const availSentences = sentences.filter(s => s.diff <= 2).sort(() => Math.random() - 0.5);
    if (availSentences.length > 0) {
      sessionSentenceCount++;
      return { type: 'sentence', sentence: availSentences[0] };
    }
  }

  // Due cards (even if over limit, better than nothing)
  const dueAvailable = dueCards.filter(notOverdrilled);
  if (dueAvailable.length > 0) {
    const item = dueAvailable[Math.floor(Math.random() * Math.min(3, dueAvailable.length))];
    const drill = pickSmartDrill(item);
    return { type: 'test', item, drill };
  }

  // Weak words
  if (weakWords.length > 0) {
    const item = weakWords[Math.floor(Math.random() * Math.min(3, weakWords.length))];
    const drill = pickSmartDrill(item);
    return { type: 'test', item, drill };
  }

  // Drill any known word — pick one with fewest drill-type coverage
  const availableKnown = knownWords.filter(notOverdrilled);
  if (availableKnown.length > 0) {
    // Find word with least drill diversity
    const scored = availableKnown.map(v => {
      const h = progress[v.id].history || [];
      const drillTypes = new Set(h.map(x => x.drill));
      return { item: v, diversity: drillTypes.size, ef: progress[v.id].ef || 2.5 };
    }).sort((a, b) => a.diversity - b.diversity || a.ef - b.ef);
    const item = scored[0].item;
    const drill = pickSmartDrill(item);
    return { type: 'test', item, drill };
  }

  // Nothing known yet — introduce first word
  if (newCards.length > 0) {
    return { type: 'intro', item: newCards[0] };
  }

  return null; // nothing to do
}

// ─── GAME LOOP ──────────────────────────────────────
function startMode(mode) {
  currentMode = mode || 'cascade';
  score = 0;
  total = 0;
  streak = 0;
  bestStreak = 0;
  sessionAnswers = [];
  newWordsThisSession = 0;
  cascadeStartTime = Date.now();
  sessionIntroduced = [];
  sessionWordHistory = {};
  questionsUntilNewWord = 0;
  sessionSentenceCount = 0;
  lastDrillType = '';
  lastVocabId = '';

  showScreen('game');
  nextQuestion();
}

function nextQuestion() {
  const action = decideNextAction();

  if (!action) {
    endSession();
    return;
  }

  if (action.type === 'intro') {
    showIntro(action.item);
    return;
  }

  if (action.type === 'deepdive') {
    showDeepDive(action.item);
    return;
  }

  let q;
  if (action.type === 'sentence') {
    q = drillSentence(action.sentence);
  } else {
    const drillFns = {
      charToEn: drillCharToEn,
      charToPinyin: drillCharToPinyin,
      listening: drillListening,
      enToChinese: drillEnToChinese,
    };
    q = drillFns[action.drill](action.item);
    lastDrillType = q.badge;
    lastVocabId = action.item.id;
  }

  currentQ = q;
  answered = false;
  renderQuestion(q);

  // Auto-play audio
  const rate = q.audioRate || 180;
  if (q.autoPlay && q.audioText) {
    setTimeout(() => playAudio(q.audioText, rate), 300);
  } else if (q.showAudio && q.audioText && action.drill !== 'charToPinyin') {
    setTimeout(() => playAudio(q.audioText, rate), 300);
  }

  // Start timer
  questionStart = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - questionStart) / 1000).toFixed(1);
    document.getElementById('timer').textContent = elapsed + 's';
  }, 100);
}

function buildMemoEditor(item) {
  const memoText = item.memo || '';
  return `<div class="memo-editor" style="max-width:520px;margin:8px auto;text-align:left">
    <textarea id="memo-input" style="width:100%;min-height:50px;background:var(--surface);border:1px solid var(--accent);border-radius:6px;padding:10px 14px;font-size:0.85rem;line-height:1.5;color:var(--text);font-family:inherit;resize:vertical">${memoText}</textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
      <span style="font-size:0.7rem;color:var(--dim)">Edit to make your own mnemonic</span>
      <button id="memo-save" style="background:var(--accent);color:#000;border:none;padding:4px 12px;border-radius:4px;font-size:0.75rem;font-family:inherit;cursor:pointer;display:none">Saved!</button>
    </div>
  </div>`;
}

function setupMemoSave(item) {
  const input = document.getElementById('memo-input');
  const saveBtn = document.getElementById('memo-save');
  if (!input || !saveBtn) return;

  let saveTimeout;
  input.addEventListener('input', () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      const newMemo = input.value.trim();
      item.memo = newMemo;
      await fetch('/api/mnemonic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, memo: newMemo }),
      });
      saveBtn.style.display = 'inline-block';
      setTimeout(() => saveBtn.style.display = 'none', 1500);
    }, 800);
  });

  // Prevent space/number keys from triggering game actions while typing
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });
}

function showDeepDive(item) {
  // When drilling fails, teach differently: full breakdown, context, slow audio
  const choicesEl = document.getElementById('choices');
  const feedbackEl = document.getElementById('feedback');
  const badge = document.getElementById('drill-badge');

  badge.textContent = 'DEEP DIVE — LEARNING DIFFERENTLY';
  document.getElementById('prompt-zh').textContent = item.zh;
  document.getElementById('prompt-pinyin').textContent = item.pinyin;
  document.getElementById('prompt-en').textContent = item.en;
  document.getElementById('audio-btn').classList.remove('hidden');

  // Build rich teaching content
  let html = '';

  // Editable mnemonic
  html += buildMemoEditor(item);

  // Character-by-character breakdown for multi-char words
  if (item.zh.length > 1) {
    html += `<div style="display:flex;gap:16px;justify-content:center;margin:12px 0">`;
    for (const char of item.zh) {
      // Find if this character exists as its own vocab entry
      const charVocab = vocab.find(v => v.zh === char);
      const meaning = charVocab ? charVocab.en : '';
      html += `<div style="text-align:center">
        <div style="font-size:2.5rem;font-family:'PingFang SC',sans-serif">${char}</div>
        <div style="font-size:0.75rem;color:var(--dim)">${meaning}</div>
      </div>`;
    }
    html += `</div>`;
  }

  // Find example sentences containing this word
  const examples = sentences.filter(s => s.zh.includes(item.zh)).slice(0, 2);
  if (examples.length > 0) {
    html += `<div style="margin-top:8px;font-size:0.8rem;color:var(--dim);text-align:left;max-width:520px">`;
    for (const ex of examples) {
      html += `<div style="margin:4px 0;padding:6px 10px;background:var(--surface);border-radius:4px">
        <span style="font-family:'PingFang SC',sans-serif">${ex.zh}</span>
        <br><span style="color:var(--accent2)">${ex.en}</span>
      </div>`;
    }
    html += `</div>`;
  }

  html += `<div style="margin-top:12px;color:var(--accent2);font-size:0.85rem">Take a moment to study · Press <kbd>Space</kbd> to continue</div>`;
  html += `<div style="margin-top:4px;color:var(--dim);font-size:0.75rem">This word will come back next session with fresh eyes</div>`;

  choicesEl.innerHTML = '';
  feedbackEl.innerHTML = html;
  feedbackEl.className = 'feedback';

  // Play slowly — twice
  lastAudioText = item.zh;
  playAudio(item.zh, 110);
  setTimeout(() => playAudio(item.zh, 110), 2500);

  updateHUD();
  setupMemoSave(item);

  answered = true;
  inIntro = true;
  const handler = (e) => {
    // Don't intercept if user is typing in the mnemonic box
    if (document.activeElement && document.activeElement.id === 'memo-input') return;
    if (e.code === 'Space' || e.key === ' ' || ['1','2','3','4'].includes(e.key)) {
      e.preventDefault();
      inIntro = false;
      document.removeEventListener('keydown', handler);
      nextQuestion();
    }
  };
  document.addEventListener('keydown', handler);
}

function showIntro(item) {
  // Show the word with full info - no question, just "press space to continue"
  const promptArea = document.getElementById('prompt-area');
  const choicesEl = document.getElementById('choices');
  const feedbackEl = document.getElementById('feedback');
  const badge = document.getElementById('drill-badge');

  badge.textContent = 'NEW WORD';
  document.getElementById('prompt-zh').textContent = item.zh;
  document.getElementById('prompt-pinyin').textContent = item.pinyin;
  document.getElementById('prompt-en').textContent = item.en;
  document.getElementById('audio-btn').classList.remove('hidden');
  choicesEl.innerHTML = '';

  // Editable mnemonic
  feedbackEl.innerHTML = `${buildMemoEditor(item)}<span style="color:var(--accent2)">Listen and remember · Press <kbd>Space</kbd> to continue</span>`;
  feedbackEl.className = 'feedback';

  lastAudioText = item.zh;
  playAudio(item.zh, 140); // slower for new words

  // Initialize progress for new word
  if (!progress[item.id]) {
    progress[item.id] = { ef: 2.5, interval: 0, reps: 0, nextReview: new Date().toISOString().slice(0, 10), history: [] };
    newWordsThisSession++;
    saveProgress();
  }

  // Register in session tracking
  sessionIntroduced.push({ item, questionsSinceTest: 0, timesTestedThisSession: 0 });

  updateHUD();
  setupMemoSave(item);

  // Wait for space
  answered = true;
  inIntro = true;
  const handler = (e) => {
    if (document.activeElement && document.activeElement.id === 'memo-input') return;
    if (e.code === 'Space' || e.key === ' ' || ['1','2','3','4'].includes(e.key)) {
      e.preventDefault();
      inIntro = false;
      document.removeEventListener('keydown', handler);
      nextQuestion();
    }
  };
  document.addEventListener('keydown', handler);
}

function renderQuestion(q) {
  document.getElementById('prompt-zh').textContent = q.promptZh;
  document.getElementById('prompt-pinyin').textContent = q.promptPinyin;
  document.getElementById('prompt-en').textContent = q.promptEn;
  document.getElementById('drill-badge').textContent = q.badge;
  document.getElementById('feedback').innerHTML = '';
  document.getElementById('feedback').className = 'feedback';

  const audioBtn = document.getElementById('audio-btn');
  if (q.showAudio) {
    audioBtn.classList.remove('hidden');
  } else {
    audioBtn.classList.add('hidden');
  }

  const choicesEl = document.getElementById('choices');
  choicesEl.innerHTML = '';
  q.choices.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice fade-in';
    btn.style.animationDelay = (i * 0.05) + 's';
    const keySpan = `<span class="choice-key">${i + 1}</span>`;
    const textClass = c.isChinese ? 'choice-chinese' : '';
    const sub = c.sub ? `<span style="color:var(--dim);font-size:0.8em;margin-left:8px">${c.sub}</span>` : '';
    btn.innerHTML = `${keySpan}<span class="${textClass}">${c.text}</span>${sub}`;
    btn.onclick = () => handleAnswer(i);
    choicesEl.appendChild(btn);
  });

  // Don't Know button
  const dkBtn = document.createElement('button');
  dkBtn.className = 'choice fade-in dont-know';
  dkBtn.style.animationDelay = '0.2s';
  dkBtn.innerHTML = `<span class="choice-key">Space</span><span>Don't know</span>`;
  dkBtn.onclick = () => handleDontKnow();
  choicesEl.appendChild(dkBtn);

  updateHUD();
}

function handleDontKnow() {
  if (answered) return;
  answered = true;
  if (timerInterval) clearInterval(timerInterval);

  const responseMs = Date.now() - questionStart;
  const quality = 0; // complete blank — worst SM-2 score

  total++;
  streak = 0;

  // Update SM-2
  if (currentQ.vocabId) {
    const prev = progress[currentQ.vocabId] || {};
    const history = (prev.history || []);
    const sessionDates = new Set(history.map(h => h.date.slice(0, 10)));
    const todayStr = new Date().toISOString().slice(0, 10);
    const alreadyDrilledToday = sessionDates.has(todayStr);
    let updated;
    if (alreadyDrilledToday) {
      updated = { ef: Math.max(1.3, (prev.ef || 2.5) - 0.2), interval: prev.interval || 1, reps: prev.reps || 0, nextReview: prev.nextReview || todayStr };
    } else {
      updated = sm2(prev, quality);
    }
    updated.history = history.concat({ date: new Date().toISOString(), quality, drill: currentQ.badge, responseMs, correct: false, dontKnow: true });
    if (updated.history.length > 50) updated.history = updated.history.slice(-50);
    progress[currentQ.vocabId] = updated;
    saveProgress();
  }

  sessionAnswers.push({ vocabId: currentQ.vocabId, sentenceId: currentQ.sentenceId || null, drill: currentQ.badge, correct: false, responseMs, quality, dontKnow: true });

  // Track in session word history
  if (currentQ.vocabId) {
    if (!sessionWordHistory[currentQ.vocabId]) sessionWordHistory[currentQ.vocabId] = [];
    sessionWordHistory[currentQ.vocabId].push({ drill: currentQ.badge, correct: false, responseMs, questionNum: total });
  }

  // Show correct answer
  const choices = document.querySelectorAll('.choice:not(.dont-know)');
  choices[currentQ.correctIdx].classList.add('correct');

  const feedbackEl = document.getElementById('feedback');
  const v = currentQ.vocabId ? vocab.find(x => x.id === currentQ.vocabId) : null;
  const detail = v ? `${v.zh} · ${v.pinyin} · ${v.en}` : '';
  const memoLine = v && v.memo ? `<div style="margin-top:6px;font-size:0.8rem;color:var(--accent);line-height:1.4">${v.memo}</div>` : '';
  feedbackEl.innerHTML = `Study this one<div class="feedback-detail">${detail}</div>${memoLine}`;
  feedbackEl.className = 'feedback show-wrong';

  if (v) playAudio(v.zh, 140); // slow playback to learn

  // Re-insert for cascade re-test
  if (currentQ.vocabId) {
    const reItem = vocab.find(x => x.id === currentQ.vocabId);
    if (reItem) {
      const insertAt = Math.min(queueIdx + 2, cascadeQueue.length);
      cascadeQueue.splice(insertAt, 0, { type: 'test', item: reItem, drill: 'charToEn' });
    }
  }

  updateHUD();
  setTimeout(() => nextQuestion(), 3000); // longer pause to study
}

function handleAnswer(idx) {
  if (answered) return;
  answered = true;
  if (timerInterval) clearInterval(timerInterval);

  const responseMs = Date.now() - questionStart;
  const correct = idx === currentQ.correctIdx;
  const quality = qualityFromResult(correct, responseMs);

  total++;
  if (correct) {
    score++;
    streak++;
    if (streak > bestStreak) bestStreak = streak;
  } else {
    streak = 0;
  }

  // Update SM-2 for vocab items
  if (currentQ.vocabId) {
    const prev = progress[currentQ.vocabId] || {};

    // Count distinct SESSION DATES this word has been seen (not in-session reps)
    const history = (prev.history || []);
    const sessionDates = new Set(history.map(h => h.date.slice(0, 10)));
    const todayStr = new Date().toISOString().slice(0, 10);
    const distinctDays = sessionDates.size + (sessionDates.has(todayStr) ? 0 : 1);

    // Only advance SM-2 reps/interval once per calendar day
    // Within same day: update EF and history, but don't inflate interval
    const alreadyDrilledToday = sessionDates.has(todayStr);
    let updated;
    if (alreadyDrilledToday) {
      // Same-day repeat: adjust EF only, don't advance reps/interval
      let ef = prev.ef || 2.5;
      if (quality >= 3) {
        ef = Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
      } else {
        ef = Math.max(1.3, ef - 0.2);
      }
      updated = {
        ef: Math.round(ef * 100) / 100,
        interval: prev.interval || 1,
        reps: prev.reps || 0,
        nextReview: prev.nextReview || todayStr,
      };
    } else {
      updated = sm2(prev, quality);
    }

    updated.history = history.concat({
      date: new Date().toISOString(),
      quality,
      drill: currentQ.badge,
      responseMs,
      correct,
    });
    // Keep last 50 history entries
    if (updated.history.length > 50) updated.history = updated.history.slice(-50);
    progress[currentQ.vocabId] = updated;
    saveProgress();
  }

  sessionAnswers.push({
    vocabId: currentQ.vocabId,
    sentenceId: currentQ.sentenceId || null,
    drill: currentQ.badge,
    correct,
    responseMs,
    quality,
  });

  // Track in session word history
  if (currentQ.vocabId) {
    if (!sessionWordHistory[currentQ.vocabId]) sessionWordHistory[currentQ.vocabId] = [];
    sessionWordHistory[currentQ.vocabId].push({ drill: currentQ.badge, correct, responseMs, questionNum: total });
  }

  // Visual feedback
  const choices = document.querySelectorAll('.choice');
  choices[currentQ.correctIdx].classList.add('correct');
  if (!correct) {
    choices[idx].classList.add('wrong');
    choices[idx].classList.add('shake');
  } else {
    choices[idx].classList.add('pulse');
  }

  const feedbackEl = document.getElementById('feedback');
  if (correct) {
    const speedMsg = responseMs < 2000 ? '⚡ Lightning!' : responseMs < 4000 ? '✓ Good' : '✓ Correct';
    feedbackEl.innerHTML = `${speedMsg}${streak >= 3 ? ` · 🔥 ${streak} streak` : ''}`;
    feedbackEl.className = 'feedback show-correct';

    // Show the word info briefly
    if (currentQ.vocabId) {
      const v = vocab.find(x => x.id === currentQ.vocabId);
      if (v) {
        feedbackEl.innerHTML += `<div class="feedback-detail">${v.zh} · ${v.pinyin} · ${v.en}</div>`;
      }
    }
  } else {
    const v = currentQ.vocabId ? vocab.find(x => x.id === currentQ.vocabId) : null;
    const detail = v ? `${v.zh} · ${v.pinyin} · ${v.en}` : '';
    const memoLine = v && v.memo ? `<div style="margin-top:6px;font-size:0.8rem;color:var(--accent);line-height:1.4">${v.memo}</div>` : '';
    feedbackEl.innerHTML = `✗ Wrong${detail ? `<div class="feedback-detail">${detail}</div>` : ''}${memoLine}`;
    feedbackEl.className = 'feedback show-wrong';

    // Wrong answers are automatically re-tested by the adaptive engine
  }

  // Play correct answer audio
  if (currentQ.vocabId) {
    const v = vocab.find(x => x.id === currentQ.vocabId);
    if (v) playAudio(v.zh);
  }

  updateHUD();

  // Auto-advance after delay
  setTimeout(() => {
    if (!answered) return; // guard
    nextQuestion();
  }, correct ? 1200 : 2500);
}

function updateHUD() {
  document.getElementById('hud-score').textContent = score;
  document.getElementById('hud-total').textContent = total;
  document.getElementById('hud-accuracy').textContent = total > 0 ? Math.round(score / total * 100) + '%' : '100%';
  // Progress bar: fill based on session time (sessions run ~5 min naturally)
  const elapsed = (Date.now() - cascadeStartTime) / 1000;
  const progressPct = Math.min(100, Math.round(elapsed / 300 * 100)); // 5 min = full
  document.getElementById('progress-fill').style.width = progressPct + '%';
  document.getElementById('streak-display').textContent = streak >= 2 ? `🔥${streak}` : '';
}

async function endSession() {
  await saveSession();
  if (timerInterval) clearInterval(timerInterval);
  showSessionSummary();
}

function showSessionSummary() {
  const statsEl = document.getElementById('stats-content');
  const accuracy = total > 0 ? Math.round(score / total * 100) : 0;
  const duration = Math.round((Date.now() - cascadeStartTime) / 1000);
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  const signals = computeLearningSignals();

  let html = `<h2>Session Complete</h2>`;
  html += `<div class="stat-row"><span class="stat-label">Score</span><span class="stat-value">${score} / ${total}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Accuracy</span><span class="stat-value ${accuracy >= 80 ? 'good' : accuracy >= 60 ? 'neutral' : 'bad'}">${accuracy}%</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Best Streak</span><span class="stat-value neutral">${bestStreak}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">New Words</span><span class="stat-value neutral">${newWordsThisSession}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Time</span><span class="stat-value">${mins}m ${secs}s</span></div>`;

  // Learning signals - the real assessment data
  html += `<div class="session-coach">`;
  html += `<div class="session-coach-header">LEARNING SIGNALS</div>`;

  if (signals.retentionRate !== null) {
    const cls = signals.retentionRate >= 85 ? 'signal-good' : signals.retentionRate >= 70 ? 'signal-warn' : 'signal-bad';
    html += `<div class="learning-signal"><span class="signal-label">Retention (review words)</span><span class="signal-value ${cls}">${signals.retentionRate}%</span></div>`;
  }

  if (signals.speedTrend !== null) {
    const cls = signals.speedTrend <= 0.9 ? 'signal-good' : signals.speedTrend <= 1.1 ? 'signal-warn' : 'signal-bad';
    const label = signals.speedTrend <= 0.9 ? 'Getting faster' : signals.speedTrend <= 1.1 ? 'Steady' : 'Slowing down';
    html += `<div class="learning-signal"><span class="signal-label">Speed trend</span><span class="signal-value ${cls}">${label} (${signals.speedTrend}x)</span></div>`;
  }

  if (signals.listeningAccuracy !== null && signals.readingAccuracy !== null) {
    const gap = signals.readingAccuracy - signals.listeningAccuracy;
    const cls = gap <= 10 ? 'signal-good' : gap <= 25 ? 'signal-warn' : 'signal-bad';
    html += `<div class="learning-signal"><span class="signal-label">Listening vs Reading</span><span class="signal-value ${cls}">${signals.listeningAccuracy}% / ${signals.readingAccuracy}%</span></div>`;
  }

  if (signals.absorptionRate !== null) {
    const cls = signals.absorptionRate >= 70 ? 'signal-good' : signals.absorptionRate >= 50 ? 'signal-warn' : 'signal-bad';
    html += `<div class="learning-signal"><span class="signal-label">New word absorption</span><span class="signal-value ${cls}">${signals.absorptionRate}%</span></div>`;
  }

  // Drill type breakdown
  if (Object.keys(signals.drillAccuracy).length > 1) {
    for (const [drill, data] of Object.entries(signals.drillAccuracy)) {
      const pct = Math.round(data.correct / data.total * 100);
      const cls = pct >= 80 ? 'signal-good' : pct >= 60 ? 'signal-warn' : 'signal-bad';
      html += `<div class="learning-signal"><span class="signal-label">${drill}</span><span class="signal-value ${cls}">${pct}% (${data.correct}/${data.total})</span></div>`;
    }
  }

  html += `</div>`;

  // Words that need attention (wrong answers)
  const wrongIds = [...new Set(sessionAnswers.filter(a => !a.correct && a.vocabId).map(a => a.vocabId))];
  if (wrongIds.length > 0) {
    html += `<h2>Needs Practice</h2>`;
    for (const id of wrongIds) {
      const v = vocab.find(x => x.id === id);
      if (v) {
        html += `<div class="stat-row"><span class="stat-label" style="font-family:'PingFang SC',sans-serif">${v.zh}</span><span class="stat-value">${v.pinyin} — ${v.en}</span></div>`;
      }
    }
  }

  // Total learned snapshot
  const learned = Object.keys(progress).length;
  const goalDate = getGoalDate();
  const daysLeft = goalDate ? Math.ceil((goalDate - new Date()) / 86400000) : null;
  html += `<div style="margin-top:20px;padding:12px;background:var(--surface);border-radius:6px;text-align:center">`;
  html += `<span style="color:var(--dim)">Total: </span><span style="color:var(--accent2);font-weight:700">${learned} words</span>`;
  if (daysLeft !== null) html += `<span style="color:var(--dim)"> · ${daysLeft > 0 ? daysLeft + ' days to ' + getGoalLabel() : getGoalLabel() + '!'}</span>`;
  html += `</div>`;

  statsEl.innerHTML = html;
  showScreen('stats');
}

// ─── MASTERY STAGES ─────────────────────────────────
// Every word progresses through stages based on real evidence of learning
function getMasteryStage(vocabId) {
  const p = progress[vocabId];
  if (!p || !p.history || p.history.length === 0) return { stage: 0, label: 'Unseen', color: 'var(--border)' };

  const h = p.history;
  const drillTypes = new Set(h.map(x => x.drill));
  const distinctDays = new Set(h.map(x => x.date.slice(0, 10))).size;
  const recentCorrect = h.slice(-5).filter(x => x.correct).length;
  const avgMs = h.filter(x => x.correct).reduce((s, x) => s + x.responseMs, 0) / Math.max(h.filter(x => x.correct).length, 1);
  const ef = p.ef || 2.5;

  // Stage 5: Mastered — seen across 10+ days, EF >= 2.3, fast, all drill types
  if (distinctDays >= 10 && ef >= 2.3 && avgMs < 3000 && drillTypes.size >= 4)
    return { stage: 5, label: 'Mastered', color: '#ffd700' };

  // Stage 4: Solid — seen across 5+ days, EF >= 2.0, most drill types
  if (distinctDays >= 5 && ef >= 2.0 && drillTypes.size >= 3)
    return { stage: 4, label: 'Solid', color: 'var(--correct)' };

  // Stage 3: Growing — seen across 3+ days, or 2+ days with good accuracy
  if (distinctDays >= 3 || (distinctDays >= 2 && recentCorrect >= 4))
    return { stage: 3, label: 'Growing', color: 'var(--accent2)' };

  // Stage 2: Fragile — tested across 2+ days or tested in 3+ drill types same day
  if (distinctDays >= 2 || drillTypes.size >= 3)
    return { stage: 2, label: 'Fragile', color: 'var(--accent)' };

  // Stage 1: Just met — has some history but very new
  return { stage: 1, label: 'Just met', color: 'var(--dim)' };
}

// ─── PROGRESS VIEW ──────────────────────────────────
function showStats() {
  const statsEl = document.getElementById('stats-content');
  const today = new Date().toISOString().slice(0, 10);
  const learned = Object.keys(progress).length;
  const due = getDueCards().length;
  const totalVocab = vocab.length;

  // Category breakdown
  const cats = {};
  for (const v of vocab) {
    if (!cats[v.cat]) cats[v.cat] = { total: 0, learned: 0, totalCorrect: 0, totalAnswers: 0 };
    cats[v.cat].total++;
    const p = progress[v.id];
    if (p) {
      cats[v.cat].learned++;
      if (p.history) {
        for (const h of p.history) {
          cats[v.cat].totalAnswers++;
          if (h.correct) cats[v.cat].totalCorrect++;
        }
      }
    }
  }

  // Weakest words
  const weak = Object.entries(progress)
    .filter(([, p]) => p.ef < 2.0)
    .sort((a, b) => a[1].ef - b[1].ef)
    .slice(0, 10);

  // Strongest words
  const strong = Object.entries(progress)
    .filter(([, p]) => p.interval >= 7)
    .sort((a, b) => b[1].interval - a[1].interval)
    .slice(0, 5);

  // Compute mastery distribution
  const stageCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const stageLabels = { 0: 'Unseen', 1: 'Just met', 2: 'Fragile', 3: 'Growing', 4: 'Solid', 5: 'Mastered' };
  const stageColors = { 0: 'var(--border)', 1: 'var(--dim)', 2: 'var(--accent)', 3: 'var(--accent2)', 4: 'var(--correct)', 5: '#ffd700' };
  for (const v of vocab) {
    const m = getMasteryStage(v.id);
    stageCounts[m.stage]++;
  }
  const totalSeen = totalVocab - stageCounts[0];

  let html = `<h2>Mastery Journey</h2>`;
  html += `<div style="display:flex;gap:2px;height:20px;border-radius:4px;overflow:hidden;margin-bottom:12px">`;
  for (let s = 5; s >= 1; s--) {
    const pct = totalVocab > 0 ? (stageCounts[s] / totalVocab * 100) : 0;
    if (pct > 0) {
      html += `<div style="width:${pct}%;background:${stageColors[s]}" title="${stageLabels[s]}: ${stageCounts[s]}"></div>`;
    }
  }
  const unseenPct = totalVocab > 0 ? (stageCounts[0] / totalVocab * 100) : 100;
  html += `<div style="width:${unseenPct}%;background:var(--border)" title="Unseen: ${stageCounts[0]}"></div>`;
  html += `</div>`;
  for (let s = 5; s >= 0; s--) {
    if (stageCounts[s] > 0) {
      html += `<div class="stat-row"><span class="stat-label"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${stageColors[s]};margin-right:6px"></span>${stageLabels[s]}</span><span class="stat-value">${stageCounts[s]}</span></div>`;
    }
  }

  html += `<h2>Overview</h2>`;
  html += `<div class="stat-row"><span class="stat-label">Words Encountered</span><span class="stat-value neutral">${totalSeen} / ${totalVocab}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Due for Review</span><span class="stat-value ${due > 20 ? 'bad' : 'neutral'}">${due}</span></div>`;
  const goalDate = getGoalDate();
  const daysLeft = goalDate ? Math.ceil((goalDate - new Date()) / 86400000) : null;
  if (daysLeft !== null) {
    html += `<div class="stat-row"><span class="stat-label">Days Until ${getGoalLabel()}</span><span class="stat-value neutral">${daysLeft > 0 ? daysLeft : 'Now!'}</span></div>`;
  }
  const totalHistory = Object.values(progress).reduce((s, p) => s + (p.history || []).length, 0);
  const totalDays = new Set(Object.values(progress).flatMap(p => (p.history || []).map(h => h.date.slice(0, 10)))).size;
  html += `<div class="stat-row"><span class="stat-label">Total Answers</span><span class="stat-value neutral">${totalHistory}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Days Studied</span><span class="stat-value neutral">${totalDays}</span></div>`;

  html += `<h2>Categories</h2>`;
  for (const [cat, data] of Object.entries(cats).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = data.totalAnswers > 0 ? Math.round(data.totalCorrect / data.totalAnswers * 100) : 0;
    const color = pct >= 80 ? 'var(--correct)' : pct >= 60 ? 'var(--accent2)' : 'var(--wrong)';
    html += `<div class="cat-bar">
      <span class="cat-bar-label">${cat}</span>
      <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
        <div class="cat-bar-fill" style="width:${data.totalAnswers > 0 ? pct : 0}%;background:${color}"></div>
      </div>
      <span class="cat-bar-pct">${data.learned}/${data.total}</span>
    </div>`;
  }

  if (weak.length > 0) {
    html += `<h2>Struggling</h2>`;
    for (const [id, p] of weak) {
      const v = vocab.find(x => x.id === id);
      if (v) {
        const m = getMasteryStage(id);
        html += `<div class="stat-row"><span class="stat-label" style="font-family:'PingFang SC',sans-serif">${v.zh} ${v.pinyin}</span><span class="stat-value" style="color:${m.color}">${m.label} · EF ${p.ef}</span></div>`;
      }
    }
  }

  if (strong.length > 0) {
    html += `<h2>Strongest</h2>`;
    for (const [id, p] of strong) {
      const v = vocab.find(x => x.id === id);
      if (v) {
        const m = getMasteryStage(id);
        html += `<div class="stat-row"><span class="stat-label" style="font-family:'PingFang SC',sans-serif">${v.zh} ${v.pinyin}</span><span class="stat-value" style="color:${m.color}">${m.label} · ${p.interval}d</span></div>`;
      }
    }
  }

  statsEl.innerHTML = html;
  showScreen('stats');
}

// ─── KEYBOARD ───────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen) return;

  // Splash screen
  if (activeScreen.id === 'splash') {
    if (e.key === '1' || e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      startMode('cascade');
    } else if (e.key === '5') {
      showStats();
    }
    return;
  }

  // Stats screen
  if (activeScreen.id === 'stats') {
    if (e.key === 'q' || e.key === 'Q') showSplash();
    return;
  }

  // Game screen
  if (activeScreen.id === 'game') {
    if (e.key === 'q' || e.key === 'Q') {
      saveSession();
      showSplash();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      replayAudio();
      return;
    }
    if (inIntro) return; // intro screen has its own handler
    if (e.key === '0' || e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      handleDontKnow();
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      handleAnswer(parseInt(e.key) - 1);
    }
  }
});

// ─── INIT ───────────────────────────────────────────
loadData();
