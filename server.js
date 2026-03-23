import { createServer } from 'http';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';

const PORT = 3000;
const DATA_DIR = join(import.meta.dirname, 'data');
const PUBLIC_DIR = join(import.meta.dirname, 'public');

// Ensure data directories and files exist
await mkdir(join(DATA_DIR, 'sessions'), { recursive: true });
await mkdir(join(DATA_DIR, 'reports'), { recursive: true });

// Initialize from templates if data files don't exist
for (const file of ['progress.json', 'assessment.json', 'settings.json']) {
  if (!existsSync(join(DATA_DIR, file))) {
    const template = join(DATA_DIR, file.replace('.json', '.template.json'));
    if (existsSync(template)) {
      await writeFile(join(DATA_DIR, file), await readFile(template));
    }
  }
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJSON(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2));
}

// Generate TTS audio using macOS say command, return as WAV buffer
function generateTTS(text, rate = 180) {
  return new Promise((resolve, reject) => {
    const tmpFile = `/tmp/chinese-tts-${Date.now()}.aiff`;
    execFile('say', ['-v', 'Tingting', '-r', String(rate), '-o', tmpFile, text], (err) => {
      if (err) return reject(err);
      readFile(tmpFile).then(buf => {
        require('fs').unlinkSync(tmpFile);
        resolve(buf);
      }).catch(reject);
    });
  });
}

// Use dynamic import for fs.unlinkSync since we're in ESM
import { unlinkSync } from 'fs';

function generateTTSBuffer(text, rate = 180) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2);
    const aiffFile = `/tmp/chinese-tts-${id}.aiff`;
    const wavFile = `/tmp/chinese-tts-${id}.wav`;
    execFile('say', ['-v', 'Tingting', '-r', String(rate), '-o', aiffFile, text], (err) => {
      if (err) return reject(err);
      execFile('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiffFile, wavFile], (err2) => {
        try { unlinkSync(aiffFile); } catch {}
        if (err2) return reject(err2);
        readFile(wavFile).then(buf => {
          try { unlinkSync(wavFile); } catch {}
          resolve(buf);
        }).catch(reject);
      });
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // API routes
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    try {
      // GET vocabulary
      if (path === '/api/vocabulary' && req.method === 'GET') {
        const vocab = await readJSON(join(DATA_DIR, 'vocabulary.json'));
        res.end(JSON.stringify(vocab || []));
        return;
      }

      // GET progress
      if (path === '/api/progress' && req.method === 'GET') {
        const progress = await readJSON(join(DATA_DIR, 'progress.json'));
        res.end(JSON.stringify(progress || {}));
        return;
      }

      // POST save progress
      if (path === '/api/progress' && req.method === 'POST') {
        const body = await getBody(req);
        await writeJSON(join(DATA_DIR, 'progress.json'), JSON.parse(body));
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST save session
      if (path === '/api/session' && req.method === 'POST') {
        const body = await getBody(req);
        const session = JSON.parse(body);
        const filename = new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        await writeJSON(join(DATA_DIR, 'sessions', filename), session);
        res.end(JSON.stringify({ ok: true, filename }));
        return;
      }

      // GET sessions list
      if (path === '/api/sessions' && req.method === 'GET') {
        const files = await readdir(join(DATA_DIR, 'sessions'));
        const sessions = [];
        for (const f of files.filter(f => f.endsWith('.json')).slice(-20)) {
          sessions.push(await readJSON(join(DATA_DIR, 'sessions', f)));
        }
        res.end(JSON.stringify(sessions));
        return;
      }

      // GET sentences
      if (path === '/api/sentences' && req.method === 'GET') {
        const sentences = await readJSON(join(DATA_DIR, 'sentences.json'));
        res.end(JSON.stringify(sentences || []));
        return;
      }

      // GET reading sentences (generated for current level)
      if (path === '/api/reading-sentences' && req.method === 'GET') {
        const rs = await readJSON(join(DATA_DIR, 'reading-sentences.json'));
        res.end(JSON.stringify(rs || []));
        return;
      }

      // GET/POST settings
      if (path === '/api/settings' && req.method === 'GET') {
        const settings = await readJSON(join(DATA_DIR, 'settings.json'));
        res.end(JSON.stringify(settings || {}));
        return;
      }
      if (path === '/api/settings' && req.method === 'POST') {
        const body = await getBody(req);
        await writeJSON(join(DATA_DIR, 'settings.json'), JSON.parse(body));
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST save a note from the user about a word
      if (path === '/api/note' && req.method === 'POST') {
        const body = await getBody(req);
        const { vocabId, note } = JSON.parse(body);
        const notesPath = join(DATA_DIR, 'notes.json');
        const notes = await readJSON(notesPath) || {};
        if (!notes[vocabId]) notes[vocabId] = [];
        notes[vocabId].push({ note, date: new Date().toISOString() });
        await writeJSON(notesPath, notes);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET notes
      if (path === '/api/notes' && req.method === 'GET') {
        const notes = await readJSON(join(DATA_DIR, 'notes.json'));
        res.end(JSON.stringify(notes || {}));
        return;
      }

      // POST update mnemonic for a vocab item
      if (path === '/api/mnemonic' && req.method === 'POST') {
        const body = await getBody(req);
        const { id, memo } = JSON.parse(body);
        const vocabPath = join(DATA_DIR, 'vocabulary.json');
        const vocab = await readJSON(vocabPath);
        const item = vocab.find(v => v.id === id);
        if (item) {
          item.memo = memo;
          await writeJSON(vocabPath, vocab);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Word not found' }));
        }
        return;
      }

      // GET assessment (Claude Code writes this)
      if (path === '/api/assessment' && req.method === 'GET') {
        const assessment = await readJSON(join(DATA_DIR, 'assessment.json'));
        res.end(JSON.stringify(assessment || {}));
        return;
      }

      // TTS endpoint
      if (path === '/api/tts' && req.method === 'GET') {
        const text = url.searchParams.get('text');
        const rate = parseInt(url.searchParams.get('rate') || '180');
        if (!text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'text parameter required' }));
          return;
        }
        try {
          const buf = await generateTTSBuffer(text, rate);
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Content-Length', buf.length);
          res.end(buf);
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'TTS failed: ' + e.message }));
        }
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files
  let filePath = path === '/' ? '/index.html' : path;
  const fullPath = join(PUBLIC_DIR, filePath);
  const ext = filePath.substring(filePath.lastIndexOf('.'));

  try {
    const content = await readFile(fullPath);
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

function getBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

server.listen(PORT, () => {
  console.log(`\n  中文 Flow — http://localhost:${PORT}\n`);
});
