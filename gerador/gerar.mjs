// Rádio Tec: gerador da programação para o GitHub Pages.
// Lê o acervo e o programacao.json, padroniza os áudios e monta a programação
// minuto a minuto de um ciclo de 28 dias. O player só segue o relógio.
//
// Uso: node gerador/gerar.mjs [--sem-audio]   (na raiz do repositório)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { parseFile } from 'music-metadata';
import { lerAcervoR2, r2Configurado } from './r2.mjs';

const ROOT = process.cwd();
const OUT = path.join(ROOT, '_site');
const CACHE = path.join(ROOT, '.cache-audio');
const SEM_AUDIO = process.argv.includes('--sem-audio') || spawnSync('ffmpeg', ['-version']).status !== 0;

// Ciclo: 28 dias a partir de um domingo, meia-noite em Brasília (UTC-3, sem horário de verão).
export const ANCORA = Date.parse('2026-01-04T00:00:00-03:00');
const DIAS_CICLO = 28;
const CICLO_S = DIAS_CICLO * 86400;

const PASTAS = { musicas: 'musica', vinhetas: 'vinheta', horacerta: 'horacerta', comerciais: 'comercial', podcasts: 'podcast', programas: 'programa', noticias: 'noticia' };
const pastaDe = (nome) => PASTAS[String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()];
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4v|mov|mkv|webm|avi|mpg|mpeg|mxf)$/i; // vídeo também: o áudio é extraído

const log = (...a) => console.log('[radiotec]', ...a);
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// ---------- 1. Programação ----------
const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'programacao.json'), 'utf8'));
const regras = { musicaNaoRepeteMin: 180, artistaNaoRepeteMin: 60, volumeLUFS: -16, bitrate: '128k', ...prog.regras };

// ---------- 2. Acervo ----------
function listar(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listar(p) : AUDIO.test(e.name) ? [p] : [];
  });
}
const hashArquivo = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

async function lerAcervo() {
  const faixas = [];
  const pastasLocais = fs.existsSync(path.join(ROOT, 'acervo')) ? fs.readdirSync(path.join(ROOT, 'acervo')).filter((n) => pastaDe(n)) : [];
  for (const pasta of pastasLocais) {
    const cat = pastaDe(pasta);
    for (const arq of listar(path.join(ROOT, 'acervo', pasta)).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))) {
      let meta = {};
      try { meta = await parseFile(arq, { duration: true }); } catch { /* sem tags */ }
      const c = meta.common || {};
      const nomeArq = path.basename(arq, path.extname(arq));
      const rel = path.relative(path.join(ROOT, 'acervo', pasta), arq).split(path.sep);
      const f = {
        origem: path.relative(ROOT, arq),
        hash: hashArquivo(arq),
        cat,
        programa: cat === 'programa' && rel.length > 1 ? rel[0] : null,
        titulo: c.title || nomeArq.replace(/[-_]+/g, ' '),
        artista: c.artist || '',
        genero: (c.genre || [])[0] || '',
        compositor: (c.composer || [])[0] || '',
        isrc: (c.isrc || [])[0] || '',
        dur: meta.format?.duration || 0,
        nomeArq,
      };
      if (!f.dur) { log(`aviso: não consegui ler a duração de ${f.origem}, ignorado`); continue; }
      faixas.push(f);
    }
  }
  return faixas;
}

// ---------- 3. Áudio: volume padrão e MP3 leve ----------
function ffmpeg(args) {
  return new Promise((ok, falha) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = ''; p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? ok() : falha(new Error(err))));
  });
}
// Tratamento profissional: corta silêncio do início e do fim (músicas, vinhetas, spots),
// padroniza o volume (loudness) e gera MP3 leve.
export const VERSAO_TRATAMENTO = 'v2';
const CURTAS = new Set(['musica', 'vinheta', 'horacerta', 'comercial']);
function tratar(origem, destino, cat = 'musica') {
  const corte = 'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-48dB';
  const filtros = CURTAS.has(cat) ? `${corte},areverse,${corte},areverse,` : '';
  return ffmpeg(['-i', origem, '-vn', '-map_metadata', '-1',
    '-af', `${filtros}loudnorm=I=${regras.volumeLUFS}:TP=-1.5:LRA=11`,
    '-ar', '44100', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', regras.bitrate, destino]);
}

async function processar(faixas) {
  fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
  const chave = `${regras.volumeLUFS}_${regras.bitrate}_${VERSAO_TRATAMENTO}`;
  const fila = [...faixas];
  let feitos = 0;
  const worker = async () => {
    while (fila.length) {
      const f = fila.shift();
      f.arquivo = `audio/${f.hash}.mp3`;
      const destino = path.join(OUT, f.arquivo);
      if (SEM_AUDIO) { fs.copyFileSync(path.join(ROOT, f.origem), destino); continue; }
      const cache = path.join(CACHE, `${f.hash}_${chave}.mp3`);
      if (!fs.existsSync(cache)) {
        await tratar(path.join(ROOT, f.origem), cache, f.cat);
        feitos++;
      }
      fs.copyFileSync(cache, destino);
      try { f.dur = (await parseFile(destino, { duration: true })).format.duration || f.dur; } catch { /* mantém */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, os.cpus().length) }, worker));
  log(SEM_AUDIO ? 'áudio copiado sem tratamento (ffmpeg ausente)' : `${feitos} áudio(s) tratados, ${faixas.length - feitos} vindos do cache`);
}

// ---------- 4. Motor de programação ----------
function rng(seed) { // gerador pseudoaleatório com semente: mesma entrada, mesma programação
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function montarProgramacao(prog, faixas, regras) {
  const random = rng(42);
  const porCat = {};
  for (const [i, f] of faixas.entries()) { f.idx = i; (porCat[f.cat] ||= []).push(f); }
  const porPrograma = {};
  for (const f of porCat.programa || []) (porPrograma[f.programa || '_'] ||= []).push(f);

  // Faixas da grade expandidas no ciclo de 28 dias
  const slots = prog.grade.map((g, k) => ({ ...g, k }));
  const instancias = [];
  for (let d = 0; d < DIAS_CICLO; d++) {
    for (const g of slots) {
      if (!g.dias.includes(DIAS[d % 7])) continue;
      instancias.push({ g, ini: d * 86400 + toMin(g.inicio) * 60, fim: d * 86400 + (g.fim === '24:00' ? 1440 : toMin(g.fim)) * 60, chave: `${g.k}@${d}` });
    }
  }
  instancias.sort((a, b) => a.ini - b.ini);
  const inicioFixos = instancias.filter((i) => i.g.tipo === 'programa').map((i) => i.ini);
  const slotEm = (t) => { let s = null; for (const i of instancias) { if (i.ini > t) break; if (t < i.fim) s = i; } return s; };
  const proximoFixo = (t) => inicioFixos.find((x) => x > t) ?? CICLO_S;

  const ultimaVez = new Map(), ultimoArtista = new Map();
  let ultimoIdx = null;
  const sepMus = regras.musicaNaoRepeteMin * 60, sepArt = regras.artistaNaoRepeteMin * 60;

  function escolher(item, t, cabe) {
    const cat = typeof item === 'string' ? item : item.categoria;
    const genero = typeof item === 'string' ? '' : (item.genero || '').toLowerCase();
    let lista = porCat[cat] || [];
    if (genero) { const g = lista.filter((f) => f.genero.toLowerCase().includes(genero)); if (g.length) lista = g; }
    if (!lista.length) return null;
    if (cat === 'horacerta') {
      const h = Math.floor((t % 86400) / 3600);
      if ((t % 3600) >= 300) return null; // só nos primeiros 5 minutos da hora
      const hora = (f) => { const m = `${f.titulo} ${f.nomeArq}`.match(/(\d{1,2})\s*h/i); return m ? Number(m[1]) : null; };
      return lista.find((f) => hora(f) === h) || lista.find((f) => hora(f) === null) || null;
    }
    const musica = cat === 'musica';
    const sep = musica ? sepMus : 1800;
    const okMus = (f) => t - (ultimaVez.get(f.idx) ?? -1e9) >= sep;
    const okArt = (f) => !musica || !f.artista || t - (ultimoArtista.get(f.artista.toLowerCase()) ?? -1e9) >= sepArt;
    const okCabe = (f) => !cabe || f.dur <= cabe;
    if (['podcast', 'noticia'].includes(cat)) { // fala nunca é cortada: só entra se couber inteira
      const pool = lista.filter((f) => okCabe(f) && f.idx !== ultimoIdx);
      const ok = pool.filter(okMus);
      const usar = ok.length ? ok : pool;
      if (!usar.length) return null;
      usar.sort((a, b) => (ultimaVez.get(a.idx) ?? -1e9) - (ultimaVez.get(b.idx) ?? -1e9));
      return usar[0];
    }
    for (const ok of [(f) => okMus(f) && okArt(f) && okCabe(f), (f) => okMus(f) && okArt(f), okMus, (f) => f.idx !== ultimoIdx, () => true]) {
      const pool = lista.filter(ok);
      if (!pool.length) continue;
      pool.sort((a, b) => (ultimaVez.get(a.idx) ?? -1e9) - (ultimaVez.get(b.idx) ?? -1e9));
      return pool[Math.floor(random() * Math.min(3, pool.length))];
    }
    return null;
  }

  const relogioDe = (nome) => prog.relogios[nome] || prog.relogios[prog.relogioPadrao] || { itens: ['musica'] };
  // Crossfade: quanto a faixa nova "entra por cima" do fim da anterior, em segundos.
  const xf = regras.crossfade ?? 2;
  const FALA = new Set(['podcast', 'noticia', 'programa']);
  function sobreposicao(ant, atual, antCortada) {
    if (!ant || antCortada || atual.cat === 'programa' || ant.cat === 'programa') return 0; // programa entra limpo, na hora exata
    if (FALA.has(ant.cat)) return 0; // fala termina inteira: nada entra por cima
    let s;
    if (ant.cat === 'musica' && atual.cat === 'musica') s = xf;
    else if (atual.cat === 'podcast' || ant.cat === 'podcast') s = Math.min(1, xf);
    else s = Math.min(0.6, xf); // vinheta, hora certa e comercial colados na música
    return Math.min(s, ant.dur * 0.25, atual.dur * 0.25);
  }
  // Regra "depois de cada podcast": toca o(s) áudio(s) indicado(s) em seguida, em rodízio.
  const normT = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const regraApos = normT(prog.depoisDoPodcast);
  const aposPodcast = regraApos ? faixas.filter((f) => normT(f.titulo).includes(regraApos) || normT(f.nomeArq).includes(regraApos)) : [];
  let posApos = 0, pedeApos = false;
  const eventos = [];
  let anterior = null, antCortada = false;
  let t = 0, posRel = 0, horaRel = -1, chaveSlot = null, posProg = 0, vazios = 0;

  while (t < CICLO_S) {
    const slot = slotEm(t);
    const chave = slot?.chave || 'livre';
    if (chave !== chaveSlot) { chaveSlot = chave; posProg = 0; }
    const hora = Math.floor(t / 3600);
    if (hora !== horaRel) { horaRel = hora; posRel = 0; }
    const limite = proximoFixo(t);
    const resta = limite - t;
    if (resta < 3) { t = limite; continue; }

    let f = null;
    if (pedeApos && aposPodcast.length) { const cand = aposPodcast[posApos++ % aposPodcast.length]; if (cand.dur <= resta) f = cand; }
    pedeApos = false;
    const arquivosPrograma = slot?.g.tipo === 'programa' ? (porPrograma[slot.g.programa] || []) : [];
    if (f) {
      // já escolhido pela regra "depois do podcast"
    } else if (posProg < arquivosPrograma.length) {
      f = arquivosPrograma[posProg++];
    } else {
      const rel = relogioDe(slot?.g.relogio);
      for (let tent = 0; tent < rel.itens.length * 2 && !f; tent++) {
        const item = rel.itens[posRel % rel.itens.length];
        const repeticao = posRel >= rel.itens.length;
        posRel++;
        if (repeticao && (item === 'horacerta' || item.categoria === 'horacerta')) continue;
        const catItem = typeof item === 'string' ? item : item.categoria;
        f = escolher(item, t, resta < 900 || ['podcast', 'noticia'].includes(catItem) ? resta : 0);
      }
    }
    if (!f) { // acervo vazio: avança um minuto
      if (++vazios > 5000) break;
      t += 60; continue;
    }
    const sob = sobreposicao(anterior, f, antCortada);
    const ini = Math.max(eventos.length ? eventos[eventos.length - 1][0] + 1 : 0, t - sob);
    const dur = Math.min(f.dur, limite - ini);
    const entra = Math.round((t - ini) * 10) / 10; // segundos de fade de entrada (sobreposição)
    eventos.push([Math.round(ini * 10) / 10, Math.round(dur * 10) / 10, f.idx, slot ? slot.g.k : -1, entra]);
    anterior = f; antCortada = dur < f.dur - 0.5;
    if (f.cat === 'podcast') pedeApos = true;
    t = ini;
    ultimaVez.set(f.idx, t); ultimoIdx = f.idx;
    if (f.artista) ultimoArtista.set(f.artista.toLowerCase(), t);
    t += dur;
  }
  return eventos;
}

// ---------- 5. Publicação ----------
function copiarPasta(de, para) {
  fs.mkdirSync(para, { recursive: true });
  for (const e of fs.readdirSync(de, { withFileTypes: true })) {
    const a = path.join(de, e.name), b = path.join(para, e.name);
    e.isDirectory() ? copiarPasta(a, b) : fs.copyFileSync(a, b);
  }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const faixas = await lerAcervo();
  await processar(faixas);
  if (prog.depoisDoPodcast) log(`regra: depois de cada podcast toca "${prog.depoisDoPodcast}"`);
  if (r2Configurado()) faixas.push(...await lerAcervoR2({ tratar, regras, log, versao: VERSAO_TRATAMENTO }));
  else log('R2 não configurado: usando só o acervo do repositório');
  // Faixas fora do ar: o arquivo continua guardado, mas não entra na programação.
  const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const fora = (prog.foraDoAr || []).map(norm).filter(Boolean);
  if (fora.length) {
    for (let i = faixas.length - 1; i >= 0; i--) {
      const f = faixas[i];
      if (fora.some((n) => n === norm(f.titulo) || n === norm(f.nomeArq) || n === norm(path.basename(f.origem)))) {
        log(`fora do ar: ${f.origem}`); faixas.splice(i, 1);
      }
    }
  }
  const cont = faixas.reduce((a, f) => ((a[f.cat] = (a[f.cat] || 0) + 1), a), {});
  log('acervo:', JSON.stringify(cont));

  const eventos = montarProgramacao(prog, faixas, regras);
  const horas = eventos.length ? (eventos[eventos.length - 1][0] + eventos[eventos.length - 1][1] - eventos[0][0]) / 3600 : 0;
  log(`programação: ${eventos.length} entradas, ${horas.toFixed(1)} h de ${DIAS_CICLO * 24} h cobertas`);

  const playout = {
    radio: prog.radio,
    gerado: new Date().toISOString(),
    versao: '',
    ancora: ANCORA,
    ciclo: CICLO_S,
    faixas: faixas.map((f) => ({ f: f.arquivo, t: f.titulo, a: f.artista, c: f.cat, d: Math.round(f.dur * 10) / 10, cp: f.compositor || undefined, i: f.isrc || undefined })),
    slots: prog.grade.map((g) => ({ t: g.titulo, k: g.tipo, l: g.link || undefined })),
    e: eventos,
  };
  // TV Tec ao vivo: pega o vídeo atual da página oficial (se a TVTEC trocar a live, a rádio acompanha).
  if (prog.tvAoVivo?.site) {
    try {
      const html = await (await fetch(prog.tvAoVivo.site, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 RadioTec' } })).text();
      const m = html.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/);
      if (m && m[1] !== prog.tvAoVivo.youtube) { log(`TV ao vivo: vídeo atualizado pelo site (${m[1]})`); prog.tvAoVivo.youtube = m[1]; }
    } catch (e) { log(`TV ao vivo: não consegui ler o site (${e.message}), mantendo o vídeo configurado`); }
  }
  playout.versao = crypto.createHash('sha1').update(JSON.stringify([playout.faixas, playout.slots, playout.e])).digest('hex').slice(0, 12);
  copiarPasta(path.join(ROOT, 'site'), OUT);
  fs.writeFileSync(path.join(OUT, 'playout.json'), JSON.stringify(playout));
  fs.writeFileSync(path.join(OUT, 'versao.json'), JSON.stringify({ versao: playout.versao, gerado: playout.gerado })); // arquivo leve que o player consulta todo minuto
  fs.writeFileSync(path.join(OUT, 'programacao.json'), JSON.stringify(prog, null, 2));
  fs.writeFileSync(path.join(OUT, 'acervo.json'), JSON.stringify(faixas.map((f) => ({ origem: f.origem, cat: f.cat, programa: f.programa, titulo: f.titulo, artista: f.artista, genero: f.genero, dur: Math.round(f.dur) }))));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  const mb = listar(path.join(OUT, 'audio')).reduce((a, p) => a + fs.statSync(p).size, 0) / 1e6;
  log(`site pronto em _site/ (áudio: ${mb.toFixed(1)} MB)`);
  if (mb > 900) log('ATENÇÃO: o GitHub Pages aceita até 1 GB por site. Reduza o acervo ou o bitrate.');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
