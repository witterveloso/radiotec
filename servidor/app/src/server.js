import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { measureLoudness, TARGET_LUFS } from './loudness.js';
import { db, kvGet, kvSet, getSettings, CATEGORIES } from './db.js';
import { nextTrack, simulate, toMin } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.resolve('../data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const LIQ_DATA_DIR = process.env.LIQ_DATA_DIR || '/data';            // onde o Liquidsoap enxerga a mesma pasta
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'radiotec';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'troque-esta-chave';  // compartilhada com o Liquidsoap
const ICECAST_STATUS = process.env.ICECAST_STATUS_URL || 'http://icecast:8000/status-json.xsl';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Relógio padrão na primeira execução.
if (!db.prepare('SELECT COUNT(*) n FROM clocks').get().n) {
  const items = [
    { type: 'category', category: 'horacerta' },
    { type: 'category', category: 'vinheta' },
    { type: 'category', category: 'musica' },
    { type: 'category', category: 'musica' },
    { type: 'category', category: 'vinheta' },
    { type: 'category', category: 'musica' },
    { type: 'category', category: 'musica' },
    { type: 'category', category: 'spot' },
    { type: 'category', category: 'musica' },
    { type: 'category', category: 'musica' },
  ];
  const id = db.prepare('INSERT INTO clocks (name, color, items) VALUES (?, ?, ?)').run('Padrão', '#6d5dfc', JSON.stringify(items)).lastInsertRowid;
  kvSet('settings', { ...kvGet('settings', {}), defaultClockId: Number(id) });
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- Acesso ----------
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (safeEq(u, ADMIN_USER) && safeEq(p.join(':'), ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Radio Tec"').status(401).send('Acesso restrito');
}
function requireInternal(req, res, next) {
  const k = req.headers['x-radio-key'] || req.query.key || '';
  if (safeEq(String(k), INTERNAL_KEY)) return next();
  res.status(403).send('forbidden');
}
const cors = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); };

// ---------- Rotas internas (Liquidsoap) ----------
const esc = (v) => String(v ?? '').replace(/\\/g, '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');

app.get('/internal/next', requireInternal, (req, res) => {
  const { track, slot, note } = nextTrack(new Date());
  if (!track) return res.status(204).end();
  const file = path.posix.join(LIQ_DATA_DIR, track.path);
  const meta = {
    title: track.title, artist: track.artist, album: track.album,
    track_id: track.id, category: track.category, slot: slot?.title || 'Programação padrão',
  };
  if (track.loudness != null) meta.liq_amplify = `${(TARGET_LUFS - track.loudness).toFixed(2)} dB`;
  const ann = Object.entries(meta).map(([k, v]) => `${k}="${esc(v)}"`).join(',');
  console.log(`[next] ${track.title} | ${note}`);
  res.type('text/plain').send(`annotate:${ann}:${file}`);
});

app.post('/internal/played', requireInternal, (req, res) => {
  const m = req.body || {};
  const now = Math.floor(Date.now() / 1000);
  const t = m.track_id ? db.prepare('SELECT * FROM tracks WHERE id = ?').get(Number(m.track_id)) : null;
  const live = !!kvGet('live', {}).on && !t;
  const row = {
    track_id: t?.id ?? null,
    title: t?.title || m.title || 'Ao vivo',
    artist: t?.artist || m.artist || '',
    composer: t?.composer || '',
    isrc: t?.isrc || '',
    category: t?.category || (live ? 'aovivo' : 'desconhecido'),
    duration: t?.duration || null,
    slot_title: m.slot || '',
    source: live ? 'aovivo' : 'automacao',
    started_at: now,
  };
  db.prepare(`INSERT INTO play_log (track_id,title,artist,composer,isrc,category,duration,slot_title,source,started_at)
    VALUES (@track_id,@title,@artist,@composer,@isrc,@category,@duration,@slot_title,@source,@started_at)`).run(row);
  if (t) {
    db.prepare('UPDATE tracks SET last_played_at = ?, play_count = play_count + 1 WHERE id = ?').run(now, t.id);
    const st = kvGet('sched', {});
    st.queued = (st.queued || []).filter((q) => q.id !== t.id);
    kvSet('sched', st);
  }
  kvSet('nowplaying', row);
  res.json({ ok: true });
});

app.post('/internal/live', requireInternal, (req, res) => {
  kvSet('live', { on: !!req.body?.on, since: Date.now() });
  console.log(`[live] ${req.body?.on ? 'locutor entrou' : 'locutor saiu'}`);
  res.json({ ok: true });
});

// ---------- API pública (site / player) ----------
let listenersCache = { at: 0, n: null };
async function listeners() {
  if (Date.now() - listenersCache.at < 10000) return listenersCache.n;
  try {
    const r = await fetch(ICECAST_STATUS, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    const src = [].concat(j.icestats?.source || []);
    listenersCache = { at: Date.now(), n: src.reduce((a, s) => a + (s.listeners || 0), 0) };
  } catch { listenersCache = { at: Date.now(), n: null }; }
  return listenersCache.n;
}

app.get('/api/nowplaying', cors, async (req, res) => {
  const np = kvGet('nowplaying', null);
  res.json({
    station: getSettings().stationName,
    live: !!kvGet('live', {}).on,
    listeners: await listeners(),
    now: np,
    history: db.prepare('SELECT title, artist, category, started_at FROM play_log ORDER BY id DESC LIMIT 10 OFFSET 1').all(),
  });
});

app.get('/api/schedule', cors, (req, res) => {
  res.json(db.prepare('SELECT day, start, end, kind, title FROM slots ORDER BY day, start').all());
});

// ---------- Painel (admin) ----------
app.use('/admin', requireAdmin, express.static(path.join(__dirname, '../public/admin')));
app.use('/api/admin', requireAdmin);
app.use('/media', requireAdmin, express.static(MEDIA_DIR));

app.get('/api/admin/meta', (req, res) => res.json({ categories: CATEGORIES, settings: getSettings(), live: kvGet('live', {}), nowplaying: kvGet('nowplaying', null) }));
app.put('/api/admin/settings', (req, res) => {
  const allowed = ['stationName', 'defaultClockId', 'songSeparationMin', 'artistSeparationMin', 'protectProgramStartMin'];
  const cur = kvGet('settings', {});
  for (const k of allowed) if (k in req.body) cur[k] = req.body[k];
  kvSet('settings', cur);
  res.json(getSettings());
});

// Biblioteca
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'audio';
    cb(null, `${base}-${crypto.randomBytes(3).toString('hex')}${ext}`);
  },
});
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i;
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 }, fileFilter: (req, f, cb) => cb(null, AUDIO.test(f.originalname)) });

app.post('/api/admin/tracks', upload.array('files', 200), async (req, res) => {
  const category = CATEGORIES[req.body.category] ? req.body.category : 'musica';
  const added = [];
  for (const f of req.files || []) {
    let meta = {};
    try { meta = await parseFile(f.path, { duration: true }); } catch { /* arquivo sem tags */ }
    const c = meta.common || {};
    const row = {
      path: path.posix.join('media', f.filename),
      title: c.title || path.basename(f.originalname, path.extname(f.originalname)),
      artist: c.artist || '', album: c.album || '', genre: (c.genre || [])[0] || '',
      isrc: (c.isrc || [])[0] || '', composer: (c.composer || [])[0] || '',
      duration: meta.format?.duration || 0, category,
    };
    const id = db.prepare(`INSERT INTO tracks (path,title,artist,album,genre,isrc,composer,duration,category)
      VALUES (@path,@title,@artist,@album,@genre,@isrc,@composer,@duration,@category)`).run(row).lastInsertRowid;
    added.push({ id: Number(id), ...row });
  }
  res.json({ added });
  // Mede o loudness em segundo plano (não trava o upload).
  (async () => {
    for (const t of added) {
      const lufs = await measureLoudness(path.join(DATA_DIR, t.path));
      if (lufs != null) db.prepare('UPDATE tracks SET loudness = ? WHERE id = ?').run(lufs, t.id);
    }
  })();
});

app.get('/api/admin/tracks', (req, res) => {
  const { q = '', category = '' } = req.query;
  const like = `%${q}%`;
  res.json(db.prepare(`SELECT * FROM tracks WHERE (? = '' OR category = ?) AND (title LIKE ? OR artist LIKE ? OR album LIKE ?)
    ORDER BY category, artist, title`).all(category, category, like, like, like));
});

app.patch('/api/admin/tracks/:id', (req, res) => {
  const fields = ['title', 'artist', 'album', 'genre', 'isrc', 'composer', 'category', 'active'];
  const sets = fields.filter((f) => f in req.body);
  if (sets.length) db.prepare(`UPDATE tracks SET ${sets.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`)
    .run({ ...Object.fromEntries(sets.map((f) => [f, f === 'active' ? (req.body[f] ? 1 : 0) : req.body[f]])), id: Number(req.params.id) });
  res.json(db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id));
});

app.delete('/api/admin/tracks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (t) {
    db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id);
    fs.rm(path.join(DATA_DIR, t.path), { force: true }, () => {});
  }
  res.json({ ok: true });
});

// Relógios
const clockOut = (c) => ({ ...c, items: JSON.parse(c.items) });
app.get('/api/admin/clocks', (req, res) => res.json(db.prepare('SELECT * FROM clocks ORDER BY name').all().map(clockOut)));
app.post('/api/admin/clocks', (req, res) => {
  const { name = 'Novo relógio', color = '#6d5dfc', items = [] } = req.body;
  const id = db.prepare('INSERT INTO clocks (name,color,items) VALUES (?,?,?)').run(name, color, JSON.stringify(items)).lastInsertRowid;
  res.json(clockOut(db.prepare('SELECT * FROM clocks WHERE id = ?').get(id)));
});
app.put('/api/admin/clocks/:id', (req, res) => {
  const { name, color, items } = req.body;
  db.prepare('UPDATE clocks SET name = ?, color = ?, items = ? WHERE id = ?').run(name, color, JSON.stringify(items || []), req.params.id);
  res.json(clockOut(db.prepare('SELECT * FROM clocks WHERE id = ?').get(req.params.id)));
});
app.delete('/api/admin/clocks/:id', (req, res) => { db.prepare('DELETE FROM clocks WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

// Grade
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
function validSlot(b) {
  if (!(b.day >= 0 && b.day <= 6)) return 'Dia inválido';
  if (!HHMM.test(b.start) || !HHMM.test(b.end)) return 'Horário inválido (use HH:MM)';
  if (toMin(b.end) <= toMin(b.start)) return 'O fim precisa ser depois do início (para atravessar a meia-noite, crie duas faixas)';
  if (!['relogio', 'programa', 'aovivo'].includes(b.kind)) return 'Tipo inválido';
  return null;
}
const slotOut = (s) => ({ ...s, items: JSON.parse(s.items) });
app.get('/api/admin/slots', (req, res) => res.json(db.prepare('SELECT * FROM slots ORDER BY day, start').all().map(slotOut)));
app.post('/api/admin/slots', (req, res) => {
  const b = req.body; const err = validSlot(b); if (err) return res.status(400).json({ error: err });
  const days = Array.isArray(b.days) && b.days.length ? b.days : [b.day];
  const ins = db.prepare('INSERT INTO slots (day,start,end,kind,title,clock_id,items) VALUES (?,?,?,?,?,?,?)');
  const ids = db.transaction(() => days.map((d) => ins.run(d, b.start, b.end, b.kind, b.title || 'Sem título', b.clock_id || null, JSON.stringify(b.items || [])).lastInsertRowid))();
  res.json({ ids: ids.map(Number) });
});
app.put('/api/admin/slots/:id', (req, res) => {
  const b = req.body; const err = validSlot(b); if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE slots SET day=?, start=?, end=?, kind=?, title=?, clock_id=?, items=? WHERE id=?')
    .run(b.day, b.start, b.end, b.kind, b.title, b.clock_id || null, JSON.stringify(b.items || []), req.params.id);
  res.json(slotOut(db.prepare('SELECT * FROM slots WHERE id = ?').get(req.params.id)));
});
app.delete('/api/admin/slots/:id', (req, res) => { db.prepare('DELETE FROM slots WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/slots/copy-day', (req, res) => {
  const { from, to } = req.body;
  const src = db.prepare('SELECT * FROM slots WHERE day = ?').all(from);
  db.transaction(() => {
    for (const d of to) {
      if (d === from) continue;
      db.prepare('DELETE FROM slots WHERE day = ?').run(d);
      for (const s of src) db.prepare('INSERT INTO slots (day,start,end,kind,title,clock_id,items) VALUES (?,?,?,?,?,?,?)').run(d, s.start, s.end, s.kind, s.title, s.clock_id, s.items);
    }
  })();
  res.json({ ok: true });
});

// Simulação e relatórios
app.get('/api/admin/simulate', (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date();
  res.json(simulate(from, Math.min(Number(req.query.hours) || 3, 24)));
});

app.get('/api/admin/log', (req, res) => {
  res.json(db.prepare('SELECT * FROM play_log ORDER BY id DESC LIMIT ?').all(Math.min(Number(req.query.limit) || 100, 1000)));
});

app.get('/api/admin/reports/ecad.csv', (req, res) => {
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : new Date(Date.now() - 30 * 86400000);
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59`) : new Date();
  const all = req.query.all === '1';
  const rows = db.prepare(`SELECT * FROM play_log WHERE started_at BETWEEN ? AND ? ${all ? '' : "AND category = 'musica'"} ORDER BY started_at`)
    .all(Math.floor(from / 1000), Math.floor(to / 1000));
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
  const lines = [['Data', 'Hora', 'Título', 'Intérprete', 'Autor/Compositor', 'ISRC', 'Duração', 'Programa', 'Origem'].map(q).join(';')];
  for (const r of rows) {
    const d = new Date(r.started_at * 1000);
    lines.push([d.toLocaleDateString('pt-BR'), d.toLocaleTimeString('pt-BR'), r.title, r.artist, r.composer, r.isrc, fmtDur(r.duration), r.slot_title, r.source].map(q).join(';'));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="execucao-radio-tec.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// Página pública
app.use('/', express.static(path.join(__dirname, '../public/site')));
app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Rádio Tec: painel em http://localhost:${PORT}/admin`));

// Mede o loudness de arquivos que ainda não foram medidos (ex.: enviados antes desta versão).
(async () => {
  const pend = db.prepare('SELECT id, path FROM tracks WHERE loudness IS NULL').all();
  for (const t of pend) {
    const lufs = await measureLoudness(path.join(DATA_DIR, t.path));
    if (lufs != null) db.prepare('UPDATE tracks SET loudness = ? WHERE id = ?').run(lufs, t.id);
  }
})();
