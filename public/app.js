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
let gameState = 'question'; // 'question' | 'feedback' | 'intro' | 'deepdive'
let cascadeStartTime = 0;
let newWordsThisSession = 0;
let MAX_NEW_PER_SESSION = 5;

// Adaptive engine session state
let sessionIntroduced = [];
let sessionWordHistory = {};
let lastDrillType = '';
let lastVocabId = '';
let questionsUntilNewWord = 0;
let sessionSentenceCount = 0;
let sessionDeepDived = new Set(); // words already deep-dived this session

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
  return 3;
}

// ─── DATA ───────────────────────────────────────────
function getGoalDate() {
  return settings.goal?.date ? new Date(settings.goal.date) : null;
}

function getGoalLabel() {
  return settings.goal?.label || 'Goal';
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
  const signals = {};
  const reviewAnswers = sessionAnswers.filter(a => {
    if (!a.vocabId) return false;
    const p = progress[a.vocabId];
    return p && p.history && p.history.length > 1;
  });
  const firstAttempts = {};
  for (const a of reviewAnswers) {
    if (!firstAttempts[a.vocabId]) firstAttempts[a.vocabId] = a;
  }
  const retentionItems = Object.values(firstAttempts);
  signals.retentionRate = retentionItems.length > 0
    ? Math.round(retentionItems.filter(a => a.correct).length / retentionItems.length * 100) : null;

  const speedTrends = [];
  for (const a of sessionAnswers) {
    if (!a.vocabId || !a.correct) continue;
    const p = progress[a.vocabId];
    if (!p || !p.history || p.history.length < 3) continue;
    const pastCorrect = p.history.filter(h => h.correct).slice(-5);
    if (pastCorrect.length >= 2) {
      const avgPast = pastCorrect.reduce((s, h) => s + h.responseMs, 0) / pastCorrect.length;
      speedTrends.push(a.responseMs / avgPast);
    }
  }
  signals.speedTrend = speedTrends.length > 0
    ? Math.round(speedTrends.reduce((s, t) => s + t, 0) / speedTrends.length * 100) / 100 : null;

  const drillAccuracy = {};
  for (const a of sessionAnswers) {
    if (!drillAccuracy[a.drill]) drillAccuracy[a.drill] = { correct: 0, total: 0 };
    drillAccuracy[a.drill].total++;
    if (a.correct) drillAccuracy[a.drill].correct++;
  }
  signals.drillAccuracy = drillAccuracy;

  const listeningAnswers = sessionAnswers.filter(a => a.drill === 'LISTENING');
  const readingAnswers = sessionAnswers.filter(a => a.drill === 'CHARACTER → MEANING');
  signals.listeningAccuracy = listeningAnswers.length > 0
    ? Math.round(listeningAnswers.filter(a => a.correct).length / listeningAnswers.length * 100) : null;
  signals.readingAccuracy = readingAnswers.length > 0
    ? Math.round(readingAnswers.filter(a => a.correct).length / readingAnswers.length * 100) : null;

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
  const absorbed = Object.values(newWordResults).filter(r => r.length >= 2 && r[r.length - 1]).length;
  signals.absorptionRate = newWordIds.size > 0 ? Math.round(absorbed / newWordIds.size * 100) : null;
  return signals;
}

async function saveSession() {
  if (sessionAnswers.length === 0) return;
  await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startTime: new Date(cascadeStartTime).toISOString(),
      endTime: new Date().toISOString(),
      totalQuestions: total, correct: score, streak: bestStreak,
      answers: sessionAnswers, newWordsIntroduced: newWordsThisSession,
      learningSignals: computeLearningSignals(),
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
  loadData();
  showScreen('splash');
}

function updateCoachPanel() {
  const msg = document.getElementById('coach-message');
  const focus = document.getElementById('coach-focus');
  const goal = document.getElementById('coach-goal');
  if (assessment && assessment.message) {
    msg.textContent = assessment.message;
    focus.textContent = assessment.focus?.length ? 'Focus: ' + assessment.focus.join(' · ') : '';
    goal.textContent = assessment.weeklyGoal ? 'Goal: ' + assessment.weeklyGoal : '';
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
  if (!goalDate) {
    el.innerHTML = `<span style="cursor:pointer" onclick="showGoalEditor()">Set a goal →</span>`;
    return;
  }
  const days = Math.ceil((goalDate - new Date()) / 86400000);
  const label = getGoalLabel();
  el.innerHTML = days > 0
    ? `<span style="cursor:pointer" onclick="showGoalEditor()">${days} days until ${label}</span>`
    : `<span style="cursor:pointer" onclick="showGoalEditor()">${label} is here! Keep learning!</span>`;
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
  for (const id of ['goal-label', 'goal-date']) {
    document.getElementById(id).addEventListener('keydown', e => e.stopPropagation());
  }
}

async function saveGoal() {
  settings.goal = { label: document.getElementById('goal-label').value.trim() || 'Goal', date: document.getElementById('goal-date').value };
  await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  updateGoalCountdown();
}

async function clearGoal() {
  settings.goal = { label: '', date: '' };
  await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  updateGoalCountdown();
}

// ─── DUE INFO ───────────────────────────────────────
function getDueCards() {
  const today = new Date().toISOString().slice(0, 10);
  return vocab.filter(v => progress[v.id]?.nextReview <= today);
}

function getNewCards() {
  return vocab.filter(v => !progress[v.id]);
}

function updateDueInfo() {
  const el = document.getElementById('due-info');
  el.textContent = `${getDueCards().length} cards due · ${Object.keys(progress).length}/${vocab.length} words learned`;
}

// ─── DRILL TYPES ────────────────────────────────────
function pickDistractors(correct, pool, count) {
  const others = pool.filter(v => v.id !== correct.id).sort(() => Math.random() - 0.5);
  const sameCat = others.filter(v => v.cat === correct.cat);
  const diffCat = others.filter(v => v.cat !== correct.cat);
  return [...sameCat, ...diffCat].slice(0, count);
}

function drillCharToEn(item) {
  const choices = [item, ...pickDistractors(item, vocab, 3)].sort(() => Math.random() - 0.5);
  return { promptZh: item.zh, promptPinyin: '', promptEn: '', showAudio: true, audioText: item.zh,
    choices: choices.map(v => ({ text: v.en, sub: '' })), correctIdx: choices.indexOf(item),
    badge: 'CHARACTER → MEANING', vocabId: item.id };
}

function drillCharToPinyin(item) {
  const choices = [item, ...pickDistractors(item, vocab, 3)].sort(() => Math.random() - 0.5);
  return { promptZh: item.zh, promptPinyin: '', promptEn: '', showAudio: false,
    choices: choices.map(v => ({ text: v.pinyin, sub: '' })), correctIdx: choices.indexOf(item),
    badge: 'CHARACTER → PINYIN', vocabId: item.id };
}

function drillListening(item) {
  const choices = [item, ...pickDistractors(item, vocab, 3)].sort(() => Math.random() - 0.5);
  return { promptZh: '', promptPinyin: '', promptEn: '', showAudio: true, audioText: item.zh,
    audioRate: item.zh.length >= 3 ? 150 : 170, autoPlay: true,
    choices: choices.map(v => ({ text: v.en, sub: '' })), correctIdx: choices.indexOf(item),
    badge: 'LISTENING', vocabId: item.id };
}

function drillEnToChinese(item) {
  const choices = [item, ...pickDistractors(item, vocab, 3)].sort(() => Math.random() - 0.5);
  return { promptZh: '', promptPinyin: '', promptEn: item.en, showAudio: false,
    choices: choices.map(v => ({ text: v.zh, sub: v.pinyin, isChinese: true })), correctIdx: choices.indexOf(item),
    badge: 'MEANING → CHARACTER', vocabId: item.id };
}

function drillSentence(sent) {
  const choices = [sent, ...sentences.filter(s => s.id !== sent.id).sort(() => Math.random() - 0.5).slice(0, 3)].sort(() => Math.random() - 0.5);
  return { promptZh: sent.zh, promptPinyin: '', promptEn: '', showAudio: true, audioText: sent.zh, audioRate: 130,
    choices: choices.map(s => ({ text: s.en, sub: '' })), correctIdx: choices.indexOf(sent),
    badge: 'SENTENCE COMPREHENSION', vocabId: null, sentenceId: sent.id };
}

// ─── ADAPTIVE CASCADE ENGINE ────────────────────────
function drillNameToKey(drillName) {
  return { 'CHARACTER → MEANING': 'charToEn', 'CHARACTER → PINYIN': 'charToPinyin',
    'LISTENING': 'listening', 'MEANING → CHARACTER': 'enToChinese' }[drillName] || 'charToEn';
}

function pickSmartDrill(item) {
  const p = progress[item.id];
  const sessionHist = sessionWordHistory[item.id] || [];
  const allHistory = p ? (p.history || []) : [];
  const sessionDrills = new Set(sessionHist.map(h => h.drill));
  const allDrills = ['charToEn', 'charToPinyin', 'listening', 'enToChinese'];

  // Per-drill performance for THIS word
  const drillPerf = {};
  for (const d of allDrills) drillPerf[d] = { correct: 0, total: 0, totalMs: 0 };
  for (const h of allHistory) {
    const key = drillNameToKey(h.drill);
    if (drillPerf[key]) { drillPerf[key].total++; drillPerf[key].totalMs += h.responseMs; if (h.correct) drillPerf[key].correct++; }
  }

  // Priority 1: drill types never tested on this word (in learning order)
  const untested = allDrills.filter(d => drillPerf[d].total === 0);
  if (untested.length > 0) {
    for (const d of ['charToEn', 'listening', 'charToPinyin', 'enToChinese']) {
      if (untested.includes(d) && !sessionDrills.has(d)) return d;
    }
    return untested[0];
  }

  // Priority 2: balance weakness drilling with confidence building
  // 70% chance: pick weakest drill. 30% chance: pick strongest drill.
  // This prevents every question being the hardest type which causes frustration.
  let candidates = allDrills.filter(d => !sessionDrills.has(d));
  if (candidates.length === 0) candidates = allDrills;
  // Avoid same drill back-to-back on same word
  if (candidates.length > 1 && lastVocabId === item.id) {
    const filtered = candidates.filter(d => d !== drillNameToKey(lastDrillType));
    if (filtered.length > 0) candidates = filtered;
  }

  // Score each candidate (lower = weaker)
  const scored = candidates.map(d => {
    const perf = drillPerf[d];
    if (perf.total === 0) return { drill: d, score: 0 };
    const accuracy = perf.correct / perf.total;
    const avgMs = perf.totalMs / perf.total;
    return { drill: d, score: accuracy * 100 - (avgMs / 100) };
  }).sort((a, b) => a.score - b.score);

  // 70% weakest, 30% strongest — keeps sessions balanced
  if (scored.length >= 2 && Math.random() < 0.3) {
    return scored[scored.length - 1].drill; // strongest
  }
  return scored[0].drill; // weakest
}

function notOverdrilled(v) {
  const sh = sessionWordHistory[v.id] || [];
  if (sh.length === 0) return true;
  const wrongCount = sh.filter(h => !h.correct).length;
  if (wrongCount >= 2) return false;
  if (wrongCount === 0) return sh.length < 5;
  return sh.length < 3;
}

function decideNextAction() {
  const today = new Date().toISOString().slice(0, 10);
  const knownWords = vocab.filter(v => progress[v.id] && progress[v.id].history.length > 0);

  // Spiral-backs for recently introduced words
  let spiralResult = null;
  for (const intro of sessionIntroduced) {
    if (!notOverdrilled(intro.item)) continue;
    intro.questionsSinceTest++;
    const thresholds = [2, 5, 10, 20];
    const threshold = thresholds[Math.min(intro.timesTestedThisSession, thresholds.length - 1)];
    if (intro.questionsSinceTest >= threshold && intro.timesTestedThisSession < 5 && !spiralResult) {
      intro.questionsSinceTest = 0;
      intro.timesTestedThisSession++;
      spiralResult = { type: 'test', item: intro.item, drill: pickSmartDrill(intro.item) };
    }
  }
  if (spiralResult) return spiralResult;

  // Re-test or deep-dive words that were wrong recently
  for (const [vocabId, hist] of Object.entries(sessionWordHistory)) {
    const lastAttempt = hist[hist.length - 1];
    if (!lastAttempt.correct) {
      const gap = total - lastAttempt.questionNum;
      const wrongCount = hist.filter(h => !h.correct).length;
      if (wrongCount >= 2 && gap >= 2 && gap < 8 && !sessionDeepDived.has(vocabId)) {
        const item = vocab.find(v => v.id === vocabId);
        if (item) {
          if (progress[vocabId]) { progress[vocabId].stuck = true; saveProgress(); }
          sessionDeepDived.add(vocabId);
          return { type: 'deepdive', item };
        }
      } else if (wrongCount < 2 && gap >= 2 && gap < 6) {
        const item = vocab.find(v => v.id === vocabId);
        if (item && notOverdrilled(item)) return { type: 'test', item, drill: 'charToEn' };
      }
    }
  }

  // Session health
  const recentAnswers = sessionAnswers.slice(-10);
  const recentAccuracy = recentAnswers.length > 0
    ? recentAnswers.filter(a => a.correct).length / recentAnswers.length : 1;
  const struggling = recentAccuracy < 0.7;
  const cruising = recentAccuracy >= 0.9 && sessionAnswers.length >= 5;
  const effectiveMaxNew = struggling ? Math.min(2, MAX_NEW_PER_SESSION) : MAX_NEW_PER_SESSION;

  const dueCards = getDueCards().sort((a, b) => (progress[a.id].ef || 2.5) - (progress[b.id].ef || 2.5));
  const dueAvailable = dueCards.filter(notOverdrilled);
  const weakWords = knownWords.filter(v => (progress[v.id].ef || 2.5) < 2.0).filter(notOverdrilled)
    .sort((a, b) => (progress[a.id].ef || 2.5) - (progress[b.id].ef || 2.5));
  const newCards = getNewCards().filter(v => v.travel);

  // Build pools
  const strongWords = knownWords.filter(v => (progress[v.id].ef || 2.5) >= 2.0).filter(notOverdrilled);

  // Decision tree — balances weak/strong, new/review, and variety
  if (struggling && weakWords.length > 0) {
    // When struggling: 70% weak words, 30% strong words for confidence
    if (strongWords.length > 0 && Math.random() < 0.3) {
      const item = strongWords[Math.floor(Math.random() * strongWords.length)];
      return { type: 'test', item, drill: pickSmartDrill(item) };
    }
    return { type: 'test', item: weakWords[0], drill: pickSmartDrill(weakWords[0]) };
  }

  if (dueAvailable.length > 0 && questionsUntilNewWord > 0) {
    questionsUntilNewWord--;
    // Pick from due cards with some randomness (not always hardest first)
    const pick = dueAvailable[Math.floor(Math.random() * Math.min(4, dueAvailable.length))];
    return { type: 'test', item: pick, drill: pickSmartDrill(pick) };
  }

  if (newWordsThisSession < effectiveMaxNew && newCards.length > 0 && !struggling) {
    questionsUntilNewWord = cruising ? 3 : 5;
    return { type: 'intro', item: newCards[0] };
  }

  // Sentence challenge every ~12 questions
  if (knownWords.length >= 8 && total > 0 && total % 12 === 0 && sessionSentenceCount < 5) {
    const s = sentences.filter(s => s.diff <= 2).sort(() => Math.random() - 0.5)[0];
    if (s) { sessionSentenceCount++; return { type: 'sentence', sentence: s }; }
  }

  // Mix weak and strong words — 60% weak, 40% strong for balanced sessions
  const mixPool = [];
  if (weakWords.length > 0) mixPool.push(...weakWords.slice(0, 3).map(item => ({ item, weak: true })));
  if (strongWords.length > 0) mixPool.push(...strongWords.sort(() => Math.random() - 0.5).slice(0, 2).map(item => ({ item, weak: false })));
  if (dueAvailable.length > 0) mixPool.push(...dueAvailable.slice(0, 2).map(item => ({ item, weak: true })));

  if (mixPool.length > 0) {
    // Weighted random: weak items 60%, strong 40%
    const weakPool = mixPool.filter(m => m.weak);
    const strongPool = mixPool.filter(m => !m.weak);
    let pick;
    if (weakPool.length > 0 && (strongPool.length === 0 || Math.random() < 0.6)) {
      pick = weakPool[Math.floor(Math.random() * weakPool.length)].item;
    } else if (strongPool.length > 0) {
      pick = strongPool[Math.floor(Math.random() * strongPool.length)].item;
    } else {
      pick = mixPool[Math.floor(Math.random() * mixPool.length)].item;
    }
    return { type: 'test', item: pick, drill: pickSmartDrill(pick) };
  }

  // Fallback: any available word, prefer least drill diversity
  const available = knownWords.filter(notOverdrilled);
  if (available.length > 0) {
    const scored = available.map(v => {
      const drillTypes = new Set((progress[v.id].history || []).map(x => x.drill));
      return { item: v, diversity: drillTypes.size, ef: progress[v.id].ef || 2.5 };
    }).sort((a, b) => a.diversity - b.diversity || a.ef - b.ef);
    return { type: 'test', item: scored[0].item, drill: pickSmartDrill(scored[0].item) };
  }
  if (newCards.length > 0) return { type: 'intro', item: newCards[0] };
  if (knownWords.length > 0) {
    const item = knownWords[Math.floor(Math.random() * knownWords.length)];
    return { type: 'test', item, drill: pickSmartDrill(item) };
  }
  return null;
}

// ─── GAME LOOP ──────────────────────────────────────
function startMode() {
  score = 0; total = 0; streak = 0; bestStreak = 0;
  sessionAnswers = []; newWordsThisSession = 0;
  cascadeStartTime = Date.now();
  sessionIntroduced = []; sessionWordHistory = {};
  questionsUntilNewWord = 0; sessionSentenceCount = 0;
  sessionDeepDived = new Set();
  lastDrillType = ''; lastVocabId = '';
  showScreen('game');
  nextQuestion();
}

function nextQuestion() {
  const action = decideNextAction();
  if (!action) { endSession(); return; }
  if (action.type === 'intro') { showIntro(action.item); return; }
  if (action.type === 'deepdive') { showDeepDive(action.item); return; }

  const drillFns = { charToEn: drillCharToEn, charToPinyin: drillCharToPinyin, listening: drillListening, enToChinese: drillEnToChinese };
  let q;
  if (action.type === 'sentence') {
    q = drillSentence(action.sentence);
  } else {
    q = drillFns[action.drill](action.item);
    lastDrillType = q.badge;
    lastVocabId = action.item.id;
  }

  currentQ = q;
  answered = false;
  gameState = 'question';
  renderQuestion(q);

  const rate = q.audioRate || 180;
  if (q.autoPlay && q.audioText) setTimeout(() => playAudio(q.audioText, rate), 300);
  else if (q.showAudio && q.audioText && action.drill !== 'charToPinyin') setTimeout(() => playAudio(q.audioText, rate), 300);

  questionStart = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    document.getElementById('timer').textContent = ((Date.now() - questionStart) / 1000).toFixed(1) + 's';
  }, 100);
}

// ─── ADVANCE FROM INTRO/DEEPDIVE ────────────────────
function advanceFromScreen() {
  const mi = document.getElementById('memo-input');
  if (mi) mi.blur();
  gameState = 'question';
  nextQuestion();
}

// ─── MNEMONIC EDITOR ────────────────────────────────
function buildMemoEditor(item) {
  const memoText = item.memo || '';
  if (!memoText) {
    return `<div class="memo-editor" style="max-width:520px;margin:8px auto;text-align:left">
      <button id="memo-edit-btn" style="background:none;border:1px solid var(--border);color:var(--dim);padding:6px 14px;border-radius:4px;font-size:0.8rem;font-family:inherit;cursor:pointer">+ Add mnemonic</button>
      <div id="memo-edit-area" style="display:none"></div>
    </div>`;
  }
  return `<div class="memo-editor" style="max-width:520px;margin:8px auto;text-align:left">
    <div id="memo-display" style="background:var(--surface);border:1px solid var(--accent);border-radius:6px;padding:10px 14px;font-size:0.85rem;line-height:1.5;color:var(--text);cursor:pointer" title="Click to edit">${memoText}</div>
    <div id="memo-edit-area" style="display:none"></div>
  </div>`;
}

function setupMemoSave(item) {
  const display = document.getElementById('memo-display');
  const editBtn = document.getElementById('memo-edit-btn');
  const editArea = document.getElementById('memo-edit-area');
  if (!editArea) return;

  function openEditor() {
    editArea.style.display = 'block';
    if (display) display.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';
    editArea.innerHTML = `<textarea id="memo-input" style="width:100%;min-height:60px;background:var(--surface);border:1px solid var(--accent);border-radius:6px;padding:10px 14px;font-size:0.85rem;line-height:1.5;color:var(--text);font-family:inherit;resize:vertical">${item.memo || ''}</textarea>
    <button id="memo-done" style="background:var(--accent);color:#000;border:none;padding:4px 14px;border-radius:4px;font-size:0.75rem;font-family:inherit;cursor:pointer;margin-top:4px">Done editing</button>`;
    const input = document.getElementById('memo-input');
    input.focus();
    input.addEventListener('keydown', e => e.stopPropagation());
    document.getElementById('memo-done').onclick = async () => {
      const newMemo = input.value.trim();
      item.memo = newMemo;
      await fetch('/api/mnemonic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, memo: newMemo }) });
      editArea.style.display = 'none';
      if (display) { display.textContent = newMemo; display.style.display = 'block'; }
      input.blur();
    };
  }

  if (display) display.onclick = openEditor;
  if (editBtn) editBtn.onclick = openEditor;
}

// ─── DEEP DIVE ──────────────────────────────────────
function showDeepDive(item) {
  const choicesEl = document.getElementById('choices');
  const feedbackEl = document.getElementById('feedback');
  document.getElementById('drill-badge').textContent = 'DEEP DIVE — LEARNING DIFFERENTLY';
  document.getElementById('prompt-zh').textContent = item.zh;
  document.getElementById('prompt-pinyin').textContent = item.pinyin;
  document.getElementById('prompt-en').textContent = item.en;
  document.getElementById('audio-btn').classList.remove('hidden');

  let html = buildMemoEditor(item);

  if (item.zh.length > 1) {
    html += `<div style="display:flex;gap:16px;justify-content:center;margin:12px 0">`;
    for (const char of item.zh) {
      const cv = vocab.find(v => v.zh === char);
      html += `<div style="text-align:center"><div style="font-size:3.5rem;font-family:'PingFang SC',sans-serif">${char}</div><div style="font-size:0.75rem;color:var(--dim)">${cv ? cv.en : ''}</div></div>`;
    }
    html += `</div>`;
  }

  const examples = sentences.filter(s => s.zh.includes(item.zh)).slice(0, 2);
  if (examples.length > 0) {
    html += `<div style="margin-top:8px;font-size:0.8rem;color:var(--dim);text-align:left;max-width:520px">`;
    for (const ex of examples) {
      html += `<div style="margin:4px 0;padding:6px 10px;background:var(--surface);border-radius:4px"><span style="font-family:'PingFang SC',sans-serif">${ex.zh}</span><br><span style="color:var(--accent2)">${ex.en}</span></div>`;
    }
    html += `</div>`;
  }

  html += `<div style="margin-top:4px;color:var(--dim);font-size:0.75rem">This word will come back next session with fresh eyes</div>`;
  choicesEl.innerHTML = '';
  feedbackEl.innerHTML = html;
  feedbackEl.className = 'feedback';

  lastAudioText = item.zh;
  playAudio(item.zh, 110);
  setTimeout(() => playAudio(item.zh, 110), 2500);

  updateHUD();
  setupMemoSave(item);
  answered = true;
  gameState = 'deepdive';

  const contBtn = document.createElement('button');
  contBtn.textContent = 'Continue →';
  contBtn.style.cssText = 'background:var(--accent);color:#000;border:none;padding:8px 24px;border-radius:6px;font-family:inherit;font-size:0.9rem;cursor:pointer;margin-top:8px';
  contBtn.onclick = advanceFromScreen;
  feedbackEl.appendChild(contBtn);
}

// ─── INTRO ──────────────────────────────────────────
function showIntro(item) {
  const choicesEl = document.getElementById('choices');
  const feedbackEl = document.getElementById('feedback');
  document.getElementById('drill-badge').textContent = 'NEW WORD';
  document.getElementById('prompt-zh').textContent = item.zh;
  document.getElementById('prompt-pinyin').textContent = item.pinyin;
  document.getElementById('prompt-en').textContent = item.en;
  document.getElementById('audio-btn').classList.remove('hidden');
  choicesEl.innerHTML = '';

  feedbackEl.innerHTML = `${buildMemoEditor(item)}<span style="color:var(--accent2)">Press <kbd>Space</kbd> or click Continue</span>`;
  feedbackEl.className = 'feedback';

  lastAudioText = item.zh;
  playAudio(item.zh, 140);

  if (!progress[item.id]) {
    progress[item.id] = { ef: 2.5, interval: 0, reps: 0, nextReview: new Date().toISOString().slice(0, 10), history: [] };
    newWordsThisSession++;
    saveProgress();
  }
  sessionIntroduced.push({ item, questionsSinceTest: 0, timesTestedThisSession: 0 });

  updateHUD();
  setupMemoSave(item);
  answered = true;
  gameState = 'intro';

  const contBtn = document.createElement('button');
  contBtn.textContent = 'Continue →';
  contBtn.style.cssText = 'background:var(--accent);color:#000;border:none;padding:8px 24px;border-radius:6px;font-family:inherit;font-size:0.9rem;cursor:pointer;margin-top:8px';
  contBtn.onclick = advanceFromScreen;
  feedbackEl.appendChild(contBtn);
}

// ─── RENDER QUESTION ────────────────────────────────
function renderQuestion(q) {
  document.getElementById('prompt-zh').textContent = q.promptZh;
  document.getElementById('prompt-pinyin').textContent = q.promptPinyin;
  document.getElementById('prompt-en').textContent = q.promptEn;
  document.getElementById('drill-badge').textContent = q.badge;
  document.getElementById('feedback').innerHTML = '';
  document.getElementById('feedback').className = 'feedback';

  const audioBtn = document.getElementById('audio-btn');
  audioBtn.classList.toggle('hidden', !q.showAudio);

  const choicesEl = document.getElementById('choices');
  choicesEl.innerHTML = '';
  q.choices.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice fade-in';
    btn.style.animationDelay = (i * 0.05) + 's';
    const textClass = c.isChinese ? 'choice-chinese' : '';
    const sub = c.sub ? `<span style="color:var(--dim);font-size:0.8em;margin-left:8px">${c.sub}</span>` : '';
    btn.innerHTML = `<span class="choice-key">${i + 1}</span><span class="${textClass}">${c.text}</span>${sub}`;
    btn.onclick = () => handleAnswer(i);
    choicesEl.appendChild(btn);
  });

  const dkBtn = document.createElement('button');
  dkBtn.className = 'choice fade-in dont-know';
  dkBtn.style.animationDelay = '0.2s';
  dkBtn.innerHTML = `<span class="choice-key">Space</span><span>Don't know</span>`;
  dkBtn.onclick = () => handleDontKnow();
  choicesEl.appendChild(dkBtn);

  updateHUD();
}

// ─── HANDLE DON'T KNOW ──────────────────────────────
function handleDontKnow() {
  if (answered) return;
  answered = true;
  gameState = 'feedback';
  if (timerInterval) clearInterval(timerInterval);

  const responseMs = Date.now() - questionStart;
  total++;
  streak = 0;

  if (currentQ.vocabId) {
    const prev = progress[currentQ.vocabId] || {};
    const history = prev.history || [];
    const todayStr = new Date().toISOString().slice(0, 10);
    const alreadyToday = new Set(history.map(h => h.date.slice(0, 10))).has(todayStr);
    let updated;
    if (alreadyToday) {
      updated = { ef: Math.max(1.3, (prev.ef || 2.5) - 0.2), interval: prev.interval || 1, reps: prev.reps || 0, nextReview: prev.nextReview || todayStr };
    } else {
      updated = sm2(prev, 0);
    }
    updated.history = history.concat({ date: new Date().toISOString(), quality: 0, drill: currentQ.badge, responseMs, correct: false, dontKnow: true });
    if (updated.history.length > 50) updated.history = updated.history.slice(-50);
    progress[currentQ.vocabId] = updated;
    saveProgress();
  }

  sessionAnswers.push({ vocabId: currentQ.vocabId, sentenceId: currentQ.sentenceId || null, drill: currentQ.badge, correct: false, responseMs, quality: 0, dontKnow: true });
  if (currentQ.vocabId) {
    if (!sessionWordHistory[currentQ.vocabId]) sessionWordHistory[currentQ.vocabId] = [];
    sessionWordHistory[currentQ.vocabId].push({ drill: currentQ.badge, correct: false, responseMs, questionNum: total });
  }

  try {
    const choices = document.querySelectorAll('.choice:not(.dont-know)');
    if (choices[currentQ.correctIdx]) choices[currentQ.correctIdx].classList.add('correct');
    const feedbackEl = document.getElementById('feedback');
    const v = currentQ.vocabId ? vocab.find(x => x.id === currentQ.vocabId) : null;
    const detail = v ? `${v.zh} · ${v.pinyin} · ${v.en}` : '';
    const memoLine = v?.memo ? `<div style="margin-top:6px;font-size:0.8rem;color:var(--accent);line-height:1.4">${v.memo}</div>` : '';
    feedbackEl.innerHTML = `Study this one<div class="feedback-detail">${detail}</div>${memoLine}`;
    feedbackEl.className = 'feedback show-wrong';
    feedbackEl.innerHTML += `<div style="margin-top:8px;color:var(--dim);font-size:0.8rem">Press <kbd style="background:var(--border);color:var(--text);padding:1px 6px;border-radius:3px">Space</kbd> to continue</div>`;
    if (v) playAudio(v.zh, 140);
  } catch (err) { console.error('[handleDontKnow]', err); }

  updateHUD();
}

// ─── HANDLE ANSWER ──────────────────────────────────
function handleAnswer(idx) {
  if (answered) return;
  answered = true;
  gameState = 'feedback';
  if (timerInterval) clearInterval(timerInterval);

  const responseMs = Date.now() - questionStart;
  const correct = idx === currentQ.correctIdx;
  const quality = qualityFromResult(correct, responseMs);

  total++;
  if (correct) { score++; streak++; if (streak > bestStreak) bestStreak = streak; }
  else { streak = 0; }

  if (currentQ.vocabId) {
    const prev = progress[currentQ.vocabId] || {};
    const history = prev.history || [];
    const todayStr = new Date().toISOString().slice(0, 10);
    const alreadyToday = new Set(history.map(h => h.date.slice(0, 10))).has(todayStr);
    let updated;
    if (alreadyToday) {
      let ef = prev.ef || 2.5;
      if (quality >= 3) ef = Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
      else ef = Math.max(1.3, ef - 0.2);
      updated = { ef: Math.round(ef * 100) / 100, interval: prev.interval || 1, reps: prev.reps || 0, nextReview: prev.nextReview || todayStr };
    } else {
      updated = sm2(prev, quality);
    }
    updated.history = history.concat({ date: new Date().toISOString(), quality, drill: currentQ.badge, responseMs, correct });
    if (updated.history.length > 50) updated.history = updated.history.slice(-50);
    progress[currentQ.vocabId] = updated;
    saveProgress();
  }

  sessionAnswers.push({ vocabId: currentQ.vocabId, sentenceId: currentQ.sentenceId || null, drill: currentQ.badge, correct, responseMs, quality });
  if (currentQ.vocabId) {
    if (!sessionWordHistory[currentQ.vocabId]) sessionWordHistory[currentQ.vocabId] = [];
    sessionWordHistory[currentQ.vocabId].push({ drill: currentQ.badge, correct, responseMs, questionNum: total });
  }

  try {
    const choices = document.querySelectorAll('.choice:not(.dont-know)');
    if (choices[currentQ.correctIdx]) choices[currentQ.correctIdx].classList.add('correct');
    if (!correct && choices[idx]) { choices[idx].classList.add('wrong'); choices[idx].classList.add('shake'); }
    else if (choices[idx]) { choices[idx].classList.add('pulse'); }

    const feedbackEl = document.getElementById('feedback');
    if (correct) {
      const speedMsg = responseMs < 2000 ? '⚡ Lightning!' : responseMs < 4000 ? '✓ Good' : '✓ Correct';
      feedbackEl.innerHTML = `${speedMsg}${streak >= 3 ? ` · 🔥 ${streak} streak` : ''}`;
      feedbackEl.className = 'feedback show-correct';
      if (currentQ.vocabId) {
        const v = vocab.find(x => x.id === currentQ.vocabId);
        if (v) feedbackEl.innerHTML += `<div class="feedback-detail">${v.zh} · ${v.pinyin} · ${v.en}</div>`;
      }
    } else {
      const v = currentQ.vocabId ? vocab.find(x => x.id === currentQ.vocabId) : null;
      const detail = v ? `${v.zh} · ${v.pinyin} · ${v.en}` : '';
      const memoLine = v?.memo ? `<div style="margin-top:6px;font-size:0.8rem;color:var(--accent);line-height:1.4">${v.memo}</div>` : '';
      feedbackEl.innerHTML = `✗ Wrong${detail ? `<div class="feedback-detail">${detail}</div>` : ''}${memoLine}`;
      feedbackEl.className = 'feedback show-wrong';
    }

    if (currentQ.vocabId) { const v = vocab.find(x => x.id === currentQ.vocabId); if (v) playAudio(v.zh); }
    feedbackEl.innerHTML += `<div style="margin-top:8px;color:var(--dim);font-size:0.8rem">Press <kbd style="background:var(--border);color:var(--text);padding:1px 6px;border-radius:3px">Space</kbd> to continue</div>`;
  } catch (err) { console.error('[handleAnswer]', err); }

  updateHUD();
}

// ─── HUD ────────────────────────────────────────────
function updateHUD() {
  document.getElementById('hud-score').textContent = score;
  document.getElementById('hud-total').textContent = total;
  document.getElementById('hud-accuracy').textContent = total > 0 ? Math.round(score / total * 100) + '%' : '100%';
  const elapsed = (Date.now() - cascadeStartTime) / 1000;
  document.getElementById('progress-fill').style.width = Math.min(100, Math.round(elapsed / 300 * 100)) + '%';
  document.getElementById('streak-display').textContent = streak >= 2 ? `🔥${streak}` : '';
}

async function endSession() {
  await saveSession();
  if (timerInterval) clearInterval(timerInterval);
  showSessionSummary();
}

// ─── SESSION SUMMARY ────────────────────────────────
function showSessionSummary() {
  const statsEl = document.getElementById('stats-content');
  const accuracy = total > 0 ? Math.round(score / total * 100) : 0;
  const duration = Math.round((Date.now() - cascadeStartTime) / 1000);
  const signals = computeLearningSignals();

  let html = `<h2>Session Complete</h2>`;
  html += `<div class="stat-row"><span class="stat-label">Score</span><span class="stat-value">${score} / ${total}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Accuracy</span><span class="stat-value ${accuracy >= 80 ? 'good' : accuracy >= 60 ? 'neutral' : 'bad'}">${accuracy}%</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Best Streak</span><span class="stat-value neutral">${bestStreak}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">New Words</span><span class="stat-value neutral">${newWordsThisSession}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Time</span><span class="stat-value">${Math.floor(duration / 60)}m ${duration % 60}s</span></div>`;

  html += `<div class="session-coach"><div class="session-coach-header">LEARNING SIGNALS</div>`;
  if (signals.retentionRate !== null) {
    const cls = signals.retentionRate >= 85 ? 'signal-good' : signals.retentionRate >= 70 ? 'signal-warn' : 'signal-bad';
    html += `<div class="learning-signal"><span class="signal-label">Retention</span><span class="signal-value ${cls}">${signals.retentionRate}%</span></div>`;
  }
  if (signals.speedTrend !== null) {
    const cls = signals.speedTrend <= 0.9 ? 'signal-good' : signals.speedTrend <= 1.1 ? 'signal-warn' : 'signal-bad';
    const label = signals.speedTrend <= 0.9 ? 'Getting faster' : signals.speedTrend <= 1.1 ? 'Steady' : 'Slowing down';
    html += `<div class="learning-signal"><span class="signal-label">Speed trend</span><span class="signal-value ${cls}">${label}</span></div>`;
  }
  if (signals.listeningAccuracy !== null && signals.readingAccuracy !== null) {
    const cls = (signals.readingAccuracy - signals.listeningAccuracy) <= 10 ? 'signal-good' : 'signal-warn';
    html += `<div class="learning-signal"><span class="signal-label">Listen / Read</span><span class="signal-value ${cls}">${signals.listeningAccuracy}% / ${signals.readingAccuracy}%</span></div>`;
  }
  if (signals.absorptionRate !== null) {
    const cls = signals.absorptionRate >= 70 ? 'signal-good' : signals.absorptionRate >= 50 ? 'signal-warn' : 'signal-bad';
    html += `<div class="learning-signal"><span class="signal-label">Absorption</span><span class="signal-value ${cls}">${signals.absorptionRate}%</span></div>`;
  }
  html += `</div>`;

  const wrongIds = [...new Set(sessionAnswers.filter(a => !a.correct && a.vocabId).map(a => a.vocabId))];
  if (wrongIds.length > 0) {
    html += `<h2>Needs Practice</h2>`;
    for (const id of wrongIds) {
      const v = vocab.find(x => x.id === id);
      if (v) html += `<div class="stat-row"><span class="stat-label" style="font-family:'PingFang SC',sans-serif">${v.zh}</span><span class="stat-value">${v.pinyin} — ${v.en}</span></div>`;
    }
  }

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
function getMasteryStage(vocabId) {
  const p = progress[vocabId];
  if (!p || !p.history || p.history.length === 0) return { stage: 0, label: 'Unseen', color: 'var(--border)' };
  const h = p.history;
  const drillTypes = new Set(h.map(x => x.drill));
  const distinctDays = new Set(h.map(x => x.date.slice(0, 10))).size;
  const recentCorrect = h.slice(-5).filter(x => x.correct).length;
  const avgMs = h.filter(x => x.correct).reduce((s, x) => s + x.responseMs, 0) / Math.max(h.filter(x => x.correct).length, 1);
  const ef = p.ef || 2.5;
  if (distinctDays >= 10 && ef >= 2.3 && avgMs < 3000 && drillTypes.size >= 4) return { stage: 5, label: 'Mastered', color: '#ffd700' };
  if (distinctDays >= 5 && ef >= 2.0 && drillTypes.size >= 3) return { stage: 4, label: 'Solid', color: 'var(--correct)' };
  if (distinctDays >= 3 || (distinctDays >= 2 && recentCorrect >= 4)) return { stage: 3, label: 'Growing', color: 'var(--accent2)' };
  if (distinctDays >= 2 || drillTypes.size >= 3) return { stage: 2, label: 'Fragile', color: 'var(--accent)' };
  return { stage: 1, label: 'Just met', color: 'var(--dim)' };
}

// ─── PROGRESS VIEW ──────────────────────────────────
function showStats() {
  const statsEl = document.getElementById('stats-content');
  const learned = Object.keys(progress).length;
  const due = getDueCards().length;
  const totalVocab = vocab.length;

  const cats = {};
  for (const v of vocab) {
    if (!cats[v.cat]) cats[v.cat] = { total: 0, learned: 0, totalCorrect: 0, totalAnswers: 0 };
    cats[v.cat].total++;
    const p = progress[v.id];
    if (p) {
      cats[v.cat].learned++;
      for (const h of (p.history || [])) { cats[v.cat].totalAnswers++; if (h.correct) cats[v.cat].totalCorrect++; }
    }
  }
  const weak = Object.entries(progress).filter(([, p]) => p.ef < 2.0).sort((a, b) => a[1].ef - b[1].ef).slice(0, 10);
  const strong = Object.entries(progress).filter(([, p]) => p.interval >= 7).sort((a, b) => b[1].interval - a[1].interval).slice(0, 5);

  // Mastery bar
  const stageCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const stageLabels = { 0: 'Unseen', 1: 'Just met', 2: 'Fragile', 3: 'Growing', 4: 'Solid', 5: 'Mastered' };
  const stageColors = { 0: 'var(--border)', 1: 'var(--dim)', 2: 'var(--accent)', 3: 'var(--accent2)', 4: 'var(--correct)', 5: '#ffd700' };
  for (const v of vocab) stageCounts[getMasteryStage(v.id).stage]++;

  let html = `<h2>Mastery Journey</h2>`;
  html += `<div style="display:flex;gap:2px;height:20px;border-radius:4px;overflow:hidden;margin-bottom:12px">`;
  for (let s = 5; s >= 1; s--) {
    const pct = (stageCounts[s] / totalVocab * 100);
    if (pct > 0) html += `<div style="width:${pct}%;background:${stageColors[s]}" title="${stageLabels[s]}: ${stageCounts[s]}"></div>`;
  }
  html += `<div style="width:${stageCounts[0] / totalVocab * 100}%;background:var(--border)" title="Unseen: ${stageCounts[0]}"></div></div>`;
  for (let s = 5; s >= 0; s--) {
    if (stageCounts[s] > 0) html += `<div class="stat-row"><span class="stat-label"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${stageColors[s]};margin-right:6px"></span>${stageLabels[s]}</span><span class="stat-value">${stageCounts[s]}</span></div>`;
  }

  html += `<h2>Overview</h2>`;
  html += `<div class="stat-row"><span class="stat-label">Words Encountered</span><span class="stat-value neutral">${learned} / ${totalVocab}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Due for Review</span><span class="stat-value ${due > 20 ? 'bad' : 'neutral'}">${due}</span></div>`;
  const goalDate = getGoalDate();
  const daysLeft = goalDate ? Math.ceil((goalDate - new Date()) / 86400000) : null;
  if (daysLeft !== null) html += `<div class="stat-row"><span class="stat-label">Days Until ${getGoalLabel()}</span><span class="stat-value neutral">${daysLeft > 0 ? daysLeft : 'Now!'}</span></div>`;
  const totalHistory = Object.values(progress).reduce((s, p) => s + (p.history || []).length, 0);
  const totalDays = new Set(Object.values(progress).flatMap(p => (p.history || []).map(h => h.date.slice(0, 10)))).size;
  html += `<div class="stat-row"><span class="stat-label">Total Answers</span><span class="stat-value neutral">${totalHistory}</span></div>`;
  html += `<div class="stat-row"><span class="stat-label">Days Studied</span><span class="stat-value neutral">${totalDays}</span></div>`;

  html += `<h2>Categories</h2>`;
  for (const [cat, data] of Object.entries(cats).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = data.totalAnswers > 0 ? Math.round(data.totalCorrect / data.totalAnswers * 100) : 0;
    const color = pct >= 80 ? 'var(--correct)' : pct >= 60 ? 'var(--accent2)' : 'var(--wrong)';
    html += `<div class="cat-bar"><span class="cat-bar-label">${cat}</span><div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden"><div class="cat-bar-fill" style="width:${pct}%;background:${color}"></div></div><span class="cat-bar-pct">${data.learned}/${data.total}</span></div>`;
  }

  if (weak.length > 0) {
    html += `<h2>Struggling</h2>`;
    for (const [id, p] of weak) { const v = vocab.find(x => x.id === id); const m = getMasteryStage(id); if (v) html += `<div class="stat-row"><span class="stat-label" style="font-family:'PingFang SC',sans-serif">${v.zh} ${v.pinyin}</span><span class="stat-value" style="color:${m.color}">${m.label} · EF ${p.ef}</span></div>`; }
  }
  if (strong.length > 0) {
    html += `<h2>Strongest</h2>`;
    for (const [id, p] of strong) { const v = vocab.find(x => x.id === id); const m = getMasteryStage(id); if (v) html += `<div class="stat-row"><span class="stat-label" style="font-family:'PingFang SC',sans-serif">${v.zh} ${v.pinyin}</span><span class="stat-value" style="color:${m.color}">${m.label} · ${p.interval}d</span></div>`; }
  }

  statsEl.innerHTML = html;
  showScreen('stats');
}

// ─── KEYBOARD ───────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen) return;

  if (activeScreen.id === 'splash') {
    if (e.key === '1' || e.key === ' ' || e.code === 'Space') { e.preventDefault(); startMode(); }
    else if (e.key === '5') showStats();
    return;
  }

  if (activeScreen.id === 'stats') {
    if (e.key === 'q' || e.key === 'Q') showSplash();
    if (e.key === '1') startMode();
    return;
  }

  if (activeScreen.id === 'game') {
    if (e.key === 'q' || e.key === 'Q') { saveSession(); showSplash(); return; }
    if (e.key === 'r' || e.key === 'R') { replayAudio(); return; }

    const isAdvance = e.code === 'Space' || e.key === ' ' || e.key === 'Enter';
    const isNum = ['1','2','3','4'].includes(e.key);

    if (gameState === 'intro' || gameState === 'deepdive') {
      // Don't advance if editing mnemonic
      if (document.activeElement?.id === 'memo-input') return;
      if (isAdvance || isNum) { e.preventDefault(); advanceFromScreen(); }
      return;
    }

    if (gameState === 'feedback') {
      if (isAdvance) { e.preventDefault(); nextQuestion(); }
      return;
    }

    if (gameState === 'question' && !answered) {
      if (e.key === '0' || isAdvance) { e.preventDefault(); handleDontKnow(); }
      else if (isNum) handleAnswer(parseInt(e.key) - 1);
    }
  }
});

// ─── INIT ───────────────────────────────────────────
loadData();
