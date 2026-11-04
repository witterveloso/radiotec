// Motor de programação: decide qual é a próxima faixa a tocar.
// O Liquidsoap chama GET /api/next sempre que precisa de uma faixa nova.
import { db, kvGet, kvSet, getSettings } from './db.js';

const pad = (n) => String(n).padStart(2, '0');
export const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;

const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

export function slotsForDay(day) {
  return db.prepare('SELECT * FROM slots WHERE day = ? ORDER BY start').all(day)
    .map((s) => ({ ...s, items: parse(s.items) }));
}

// Faixa da grade ativa neste momento (se houver sobreposição, vale a que começou por último).
export function findSlot(now) {
  const m = minutesOf(now);
  const hits = slotsForDay(now.getDay()).filter((s) => toMin(s.start) <= m && m < toMin(s.end));
  return hits.sort((a, b) => toMin(b.start) - toMin(a.start))[0] || null;
}

// Segundos até o próximo programa fixo (para não atropelar o horário de início).
function secondsToNextProgram(now) {
  const m = minutesOf(now);
  const next = slotsForDay(now.getDay())
    .filter((s) => s.kind !== 'relogio' && toMin(s.start) > m)
    .sort((a, b) => toMin(a.start) - toMin(b.start))[0];
  return next ? (toMin(next.start) - m) * 60 : Infinity;
}

function getClock(id) {
  if (!id) return null;
  const c = db.prepare('SELECT * FROM clocks WHERE id = ?').get(id);
  return c ? { ...c, items: parse(c.items) } : null;
}

// Histórico recente usado pelas regras de separação.
function loadHistory(nowMs, state) {
  const since = Math.floor(nowMs / 1000) - 6 * 3600;
  const rows = db.prepare('SELECT track_id, artist, started_at FROM play_log WHERE started_at >= ? ORDER BY started_at').all(since)
    .map((r) => ({ id: r.track_id, artist: (r.artist || '').toLowerCase(), at: r.started_at * 1000 }));
  for (const q of state.queued || []) rows.push(q);
  return rows;
}

function pickFromCategory({ category, genre }, ctx) {
  const { now, history, settings, maxSeconds } = ctx;
  let cands = db.prepare('SELECT * FROM tracks WHERE active = 1 AND category = ?').all(category);
  if (genre) {
    const g = genre.toLowerCase();
    const byGenre = cands.filter((t) => (t.genre || '').toLowerCase().includes(g));
    if (byGenre.length) cands = byGenre;
  }
  if (!cands.length) return null;

  if (category === 'horacerta') {
    // Só toca nos primeiros minutos da hora e só o arquivo da hora certa ("14h", "14 h"...).
    // Arquivo genérico (sem número no título) serve para qualquer hora.
    if (now.getMinutes() >= 5) return null;
    const h = now.getHours();
    const hourOf = (t) => { const mm = (t.title || '').match(/(\d{1,2})\s*h/i); return mm ? Number(mm[1]) : null; };
    return cands.find((t) => hourOf(t) === h) || cands.find((t) => hourOf(t) === null) || null;
  }

  const nowMs = now.getTime();
  const lastById = new Map();
  const lastByArtist = new Map();
  for (const h of history) {
    if (h.id != null) lastById.set(h.id, Math.max(lastById.get(h.id) || 0, h.at));
    if (h.artist) lastByArtist.set(h.artist, Math.max(lastByArtist.get(h.artist) || 0, h.at));
  }
  const lastPlayed = history.length ? history[history.length - 1].id : null;
  const isMusic = category === 'musica';
  const songSep = (isMusic ? settings.songSeparationMin : 30) * 60000;
  const artistSep = settings.artistSeparationMin * 60000;

  const songOk = (t) => nowMs - (lastById.get(t.id) || 0) >= songSep;
  const artistOk = (t) => !isMusic || !t.artist || nowMs - (lastByArtist.get(t.artist.toLowerCase()) || 0) >= artistSep;
  const fits = (t) => !maxSeconds || !t.duration || t.duration <= maxSeconds;

  // Regras relaxadas em etapas para nunca ficar sem faixa.
  const stages = [
    (t) => songOk(t) && artistOk(t) && fits(t),
    (t) => songOk(t) && artistOk(t),
    (t) => songOk(t),
    (t) => t.id !== lastPlayed,
    () => true,
  ];
  for (const ok of stages) {
    const pool = cands.filter(ok);
    if (!pool.length) continue;
    // Prioriza o que tocou há mais tempo; sorteia entre os 3 primeiros para variar.
    pool.sort((a, b) => (lastById.get(a.id) || a.last_played_at * 1000 || 0) - (lastById.get(b.id) || b.last_played_at * 1000 || 0));
    return pool[Math.floor(Math.random() * Math.min(3, pool.length))];
  }
  return null;
}

function pickFromClock(clock, ctx, state) {
  if (!clock || !clock.items.length) {
    return { track: pickFromCategory({ category: 'musica' }, ctx), note: 'sem relógio: música' };
  }
  // O relógio representa uma hora: recomeça no topo de cada hora.
  const hourKey = `${dateKey(ctx.now)}T${ctx.now.getHours()}`;
  if (state.clockHour !== hourKey) { state.clockHour = hourKey; state.clockPos = 0; }
  // Se o relógio acabar antes da hora virar, repete os itens (sem a hora certa) até completar.
  for (let i = 0; i < clock.items.length * 2; i++) {
    const raw = state.clockPos || 0;
    state.clockPos = raw + 1;
    const pos = raw % clock.items.length;
    const item = clock.items[pos];
    if (raw >= clock.items.length && item.category === 'horacerta') continue;
    let track = null;
    if (item.type === 'track') track = db.prepare('SELECT * FROM tracks WHERE id = ? AND active = 1').get(item.trackId);
    else track = pickFromCategory(item, ctx);
    if (track) return { track, note: `relógio "${clock.name}" item ${pos + 1}` };
  }
  return { track: null, note: 'relógio sem faixas disponíveis' };
}

/**
 * Decide a próxima faixa.
 * dryRun: usa um estado em memória e não grava nada (para a simulação do painel).
 */
export function nextTrack(now = new Date(), { dryRun = false, sim = null } = {}) {
  const settings = getSettings();
  const state = sim ? sim.state : { ...kvGet('sched', {}) };
  const history = sim ? sim.history : loadHistory(now.getTime(), state);

  const slot = findSlot(now);
  const slotKey = slot ? `${slot.id}@${dateKey(now)}` : 'default';
  if (state.slotKey !== slotKey) {
    state.slotKey = slotKey;
    state.programPos = 0;
  }

  const ctx = { now, history, settings, maxSeconds: null };
  const toProgram = secondsToNextProgram(now);
  if (toProgram <= settings.protectProgramStartMin * 60) ctx.maxSeconds = toProgram;

  let result;
  if (slot && slot.kind === 'programa' && (state.programPos || 0) < slot.items.length) {
    const id = slot.items[state.programPos];
    state.programPos = (state.programPos || 0) + 1;
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    result = { track, note: `programa "${slot.title}" parte ${state.programPos}/${slot.items.length}` };
    if (!track) result = pickFromClock(getClock(slot.clock_id || settings.defaultClockId), ctx, state);
  } else {
    const clockId = (slot && slot.clock_id) || settings.defaultClockId;
    result = pickFromClock(getClock(clockId), ctx, state);
    if (slot && slot.kind === 'aovivo') result.note = `janela ao vivo "${slot.title}" (automação cobrindo): ${result.note}`;
  }

  if (result.track) {
    const q = { id: result.track.id, artist: (result.track.artist || '').toLowerCase(), at: now.getTime() };
    if (sim) sim.history.push(q);
    else state.queued = [...(state.queued || []), q].slice(-5);
  }
  if (!dryRun && !sim) kvSet('sched', state);
  return { track: result.track || null, slot, note: result.note };
}

// Simula a programação a partir de uma data, sem tocar em nada (pré-visualização da grade).
export function simulate(from, hours = 3) {
  const sim = { state: {}, history: [] };
  const out = [];
  let t = new Date(from);
  const end = t.getTime() + hours * 3600000;
  let guard = 0;
  while (t.getTime() < end && guard++ < 2000) {
    const { track, slot, note } = nextTrack(t, { sim });
    if (!track) { out.push({ at: t.toISOString(), title: '(sem faixa: entra a playlist de segurança)', slot: slot?.title }); t = new Date(t.getTime() + 60000); continue; }
    out.push({ at: t.toISOString(), id: track.id, title: track.title, artist: track.artist, category: track.category, duration: track.duration, slot: slot?.title || 'Programação padrão', note });
    t = new Date(t.getTime() + Math.max(5, track.duration || 180) * 1000);
  }
  return out;
}
