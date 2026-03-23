import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); }
  catch { return null; }
}

async function generateReport() {
  const vocab = await readJSON(join(DATA_DIR, 'vocabulary.json')) || [];
  const progress = await readJSON(join(DATA_DIR, 'progress.json')) || {};
  const sessionFiles = (await readdir(join(DATA_DIR, 'sessions')).catch(() => [])).filter(f => f.endsWith('.json'));
  const sessions = [];
  for (const f of sessionFiles) {
    sessions.push(await readJSON(join(DATA_DIR, 'sessions', f)));
  }

  const today = new Date().toISOString().slice(0, 10);
  const tripDate = new Date('2026-05-03');
  const daysLeft = Math.ceil((tripDate - new Date()) / 86400000);
  const learned = Object.keys(progress).length;
  const dueCards = vocab.filter(v => {
    const p = progress[v.id];
    return p && p.nextReview <= today;
  });

  // Recent sessions (last 7 days)
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
  const recentSessions = sessions.filter(s => s && new Date(s.startTime) >= weekAgo);
  const totalQuestions = recentSessions.reduce((s, x) => s + (x.totalQuestions || 0), 0);
  const totalCorrect = recentSessions.reduce((s, x) => s + (x.correct || 0), 0);
  const totalNew = recentSessions.reduce((s, x) => s + (x.newWordsIntroduced || 0), 0);

  // Category accuracy
  const cats = {};
  for (const v of vocab) {
    if (!cats[v.cat]) cats[v.cat] = { correct: 0, total: 0 };
    const p = progress[v.id];
    if (p && p.history) {
      for (const h of p.history) {
        cats[v.cat].total++;
        if (h.correct) cats[v.cat].correct++;
      }
    }
  }

  // Leeches (EF < 1.8)
  const leeches = Object.entries(progress)
    .filter(([, p]) => p.ef < 1.8)
    .sort((a, b) => a[1].ef - b[1].ef);

  // Build report
  let md = `# Progress Report — ${today}\n\n`;
  md += `## Summary\n`;
  md += `- **Days until trip:** ${daysLeft}\n`;
  md += `- **Words learned:** ${learned} / ${vocab.length}\n`;
  md += `- **Cards due today:** ${dueCards.length}\n`;
  md += `- **Sessions this week:** ${recentSessions.length}\n`;
  md += `- **Questions this week:** ${totalQuestions}\n`;
  md += `- **Weekly accuracy:** ${totalQuestions > 0 ? Math.round(totalCorrect / totalQuestions * 100) : 0}%\n`;
  md += `- **New words this week:** ${totalNew}\n\n`;

  md += `## Category Accuracy\n`;
  for (const [cat, data] of Object.entries(cats).sort((a, b) => {
    const pctA = a[1].total > 0 ? a[1].correct / a[1].total : 0;
    const pctB = b[1].total > 0 ? b[1].correct / b[1].total : 0;
    return pctA - pctB;
  })) {
    const pct = data.total > 0 ? Math.round(data.correct / data.total * 100) : 0;
    md += `- **${cat}:** ${pct}% (${data.correct}/${data.total})\n`;
  }

  if (leeches.length > 0) {
    md += `\n## Leeches (EF < 1.8 — struggling words)\n`;
    for (const [id, p] of leeches) {
      const v = vocab.find(x => x.id === id);
      if (v) md += `- ${v.zh} (${v.pinyin}) — ${v.en} — EF: ${p.ef}\n`;
    }
  }

  md += `\n## SM-2 Health\n`;
  const avgEF = Object.values(progress).reduce((s, p) => s + p.ef, 0) / Math.max(Object.keys(progress).length, 1);
  const matured = Object.values(progress).filter(p => p.interval >= 21).length;
  md += `- Average EF: ${avgEF.toFixed(2)}\n`;
  md += `- Matured cards (21+ day interval): ${matured}\n`;
  md += `- Leech count: ${leeches.length}\n`;

  // Projected vocabulary at trip date
  const dailyRate = totalNew / 7;
  const projected = learned + Math.round(dailyRate * daysLeft);
  md += `\n## Projection\n`;
  md += `- Current daily rate: ~${dailyRate.toFixed(1)} new words/day\n`;
  md += `- Projected vocab at trip: ~${projected} words\n`;
  md += `- Target: 300+ words for basic travel fluency\n`;

  // Write report
  const filename = `report-${today}.md`;
  await writeFile(join(DATA_DIR, 'reports', filename), md);
  console.log(md);
  console.log(`\nSaved to data/reports/${filename}`);
}

generateReport();
