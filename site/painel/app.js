// Rádio Tec: painel de programação (versão GitHub Pages).
// Edita a grade e os relógios no navegador; a publicação é um commit do programacao.json no GitHub.
const $ = (s) => document.querySelector(s);
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const DIAS_N = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const CATS = { musica: 'Música', vinheta: 'Vinheta', horacerta: 'Hora certa', comercial: 'Comercial', podcast: 'Podcast', programa: 'Programa' };
const PASTAS = { musica: 'musicas', vinheta: 'vinhetas', horacerta: 'horacerta', comercial: 'comerciais', podcast: 'podcasts' };
const KIND = { relogio: 'Relógio', programa: 'Programa', aovivo: 'Ao vivo' };
const RASCUNHO = 'radiotec-rascunho';

let PUBLICADO = null, PROG = null, ACERVO = [], PLAYOUT = null;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '–');
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
const repo = () => PROG.repositorio || 'witterveloso/radiotec';

// ---------- Estado e rascunho ----------
function salvarRascunho() {
  const igual = JSON.stringify(PROG) === JSON.stringify(PUBLICADO);
  try { igual ? localStorage.removeItem(RASCUNHO) : localStorage.setItem(RASCUNHO, JSON.stringify(PROG)); } catch {}
  $('#dirty').hidden = igual;
  $('#pubJson').value = JSON.stringify(PROG, null, 2);
}

// ---------- Abas ----------
document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === b.dataset.tab));
  history.replaceState(null, '', `#${b.dataset.tab}`);
});

// ---------- Grade ----------
function renderWeek() {
  const hoje = new Date().getDay();
  let html = '<div class="hd"></div>' + DIAS_N.map((d, i) => `<div class="hd ${i === hoje ? 'today' : ''}">${d}</div>`).join('');
  html += '<div class="hours">' + Array.from({ length: 24 }, (_, h) => `<div>${String(h).padStart(2, '0')}h</div>`).join('') + '</div>';
  for (let d = 0; d < 7; d++) {
    html += `<div class="col" data-day="${d}">`;
    PROG.grade.forEach((g, k) => {
      if (!g.dias.includes(DIAS[d])) return;
      const fim = g.fim === '24:00' ? 1440 : toMin(g.fim);
      const top = toMin(g.inicio) / 60 * 40, h = Math.max(18, (fim - toMin(g.inicio)) / 60 * 40 - 2);
      const extra = g.tipo === 'programa' ? (g.programa || '') : g.tipo === 'relogio' ? (PROG.relogios[g.relogio]?.nome || '') : 'ao vivo';
      html += `<div class="slot ${g.tipo}" data-k="${k}" style="top:${top}px;height:${h}px"><b>${esc(g.titulo)}</b><span>${g.inicio} às ${g.fim} · ${esc(extra)}</span></div>`;
    });
    if (d === hoje) { const n = new Date(); html += `<div class="nowline" style="top:${(n.getHours() * 60 + n.getMinutes()) / 60 * 40}px"></div>`; }
    html += '</div>';
  }
  $('#week').innerHTML = html;
}
$('#week').onclick = (e) => {
  const s = e.target.closest('.slot');
  if (s) return abrirSlot(Number(s.dataset.k));
  const col = e.target.closest('.col'); if (!col) return;
  const h = Math.min(23, Math.floor(e.offsetY / 40));
  abrirSlot(null, { dias: [DIAS[Number(col.dataset.day)]], inicio: `${String(h).padStart(2, '0')}:00`, fim: h === 23 ? '24:00' : `${String(h + 1).padStart(2, '0')}:00` });
};
$('#newSlot').onclick = () => abrirSlot(null);

let editK = null;
function abrirSlot(k, padrao = {}) {
  editK = k;
  const g = k != null ? PROG.grade[k] : { tipo: 'relogio', titulo: '', inicio: '08:00', fim: '09:00', dias: ['seg'], ...padrao };
  $('#slotDlgTitle').textContent = k != null ? 'Editar faixa da grade' : 'Nova faixa na grade';
  $('#slTitle').value = g.titulo; $('#slKind').value = g.tipo; $('#slStart').value = g.inicio; $('#slEnd').value = g.fim === '24:00' ? '23:59' : g.fim;
  $('#slDays').innerHTML = DIAS.map((d, i) => `<label><input type="checkbox" name="sd" value="${d}" ${g.dias.includes(d) ? 'checked' : ''}> ${DIAS_N[i]}</label>`).join('');
  $('#slClock').innerHTML = '<option value="">Relógio padrão</option>' + Object.entries(PROG.relogios).map(([id, r]) => `<option value="${id}">${esc(r.nome)}</option>`).join('');
  $('#slClock').value = g.relogio || '';
  const progs = [...new Set(ACERVO.filter((a) => a.cat === 'programa' && a.programa).map((a) => a.programa))];
  if (g.programa && !progs.includes(g.programa)) progs.push(g.programa);
  $('#slProg').innerHTML = progs.map((p) => `<option value="${esc(p)}">${esc(p)} (${ACERVO.filter((a) => a.programa === p).length} arquivos)</option>`).join('') || '<option value="">Nenhum programa no acervo ainda</option>';
  $('#slProg').value = g.programa || progs[0] || '';
  $('#slLink').value = g.link || '';
  $('#slDel').hidden = k == null; $('#slErr').textContent = '';
  syncTipo(); $('#slotDlg').showModal();
}
function syncTipo() {
  const t = $('#slKind').value;
  $('#slProgBox').hidden = t !== 'programa'; $('#slLinkBox').hidden = t !== 'aovivo';
  $('#slClockHint').textContent = t === 'programa' ? '(toca quando os arquivos do programa acabarem)' : t === 'aovivo' ? '(toca na rádio enquanto a live acontece no link)' : '';
}
$('#slKind').onchange = syncTipo;
$('#slCancel').onclick = () => $('#slotDlg').close();
$('#slDel').onclick = () => { if (confirm('Excluir esta faixa da grade?')) { PROG.grade.splice(editK, 1); $('#slotDlg').close(); salvarRascunho(); renderWeek(); } };
$('#slotForm').onsubmit = (e) => {
  e.preventDefault();
  const dias = [...document.querySelectorAll('input[name=sd]:checked')].map((x) => x.value);
  const fim = $('#slEnd').value === '23:59' ? '24:00' : $('#slEnd').value;
  if (!dias.length) return ($('#slErr').textContent = 'Escolha pelo menos um dia.');
  if ((fim === '24:00' ? 1440 : toMin(fim)) <= toMin($('#slStart').value)) return ($('#slErr').textContent = 'O fim precisa ser depois do início. Para atravessar a meia-noite, crie duas faixas.');
  const g = { dias: DIAS.filter((d) => dias.includes(d)), inicio: $('#slStart').value, fim, tipo: $('#slKind').value, titulo: $('#slTitle').value.trim() || 'Sem título' };
  if ($('#slClock').value) g.relogio = $('#slClock').value;
  if (g.tipo === 'programa') { if (!$('#slProg').value) return ($('#slErr').textContent = 'Envie os arquivos do programa no Acervo primeiro.'); g.programa = $('#slProg').value; }
  if (g.tipo === 'aovivo') g.link = $('#slLink').value.trim();
  editK != null ? (PROG.grade[editK] = g) : PROG.grade.push(g);
  PROG.grade.sort((a, b) => toMin(a.inicio) - toMin(b.inicio));
  $('#slotDlg').close(); salvarRascunho(); renderWeek(); toast('Grade alterada. Publique quando terminar.');
};

// ---------- Relógios ----------
let editClock = null;
function renderClocks() {
  $('#clockList').innerHTML = Object.entries(PROG.relogios).map(([id, r]) => `<li data-id="${id}" class="${editClock === id ? 'sel' : ''}">
    <span class="grow">${esc(r.nome)}</span>${PROG.relogioPadrao === id ? '<span class="chip">padrão</span>' : ''}<span class="muted">${r.itens.length} itens</span></li>`).join('');
}
$('#clockList').onclick = (e) => { const li = e.target.closest('li'); if (li) abrirClock(li.dataset.id); };
function abrirClock(id) {
  editClock = id; const r = PROG.relogios[id];
  $('#clockEditor').hidden = false; $('#ckName').value = r.nome; $('#ckDefault').checked = PROG.relogioPadrao === id;
  renderItens(); renderClocks();
}
const itemCat = (it) => (typeof it === 'string' ? it : it.categoria);
function renderItens() {
  const itens = PROG.relogios[editClock].itens;
  $('#ckItems').innerHTML = itens.map((it, i) => `<li data-i="${i}"><span class="cat ${itemCat(it) === 'comercial' ? 'spot' : itemCat(it)} grow">${esc(CATS[itemCat(it)] || itemCat(it))}${it.genero ? ` · gênero "${esc(it.genero)}"` : ''}</span>
    <button class="icon" data-m="-1">↑</button><button class="icon" data-m="1">↓</button><button class="icon" data-m="x">✕</button></li>`).join('');
  const media = (c) => { const l = ACERVO.filter((a) => a.cat === c); return l.length ? l.reduce((s, a) => s + a.dur, 0) / l.length : 0; };
  const total = itens.reduce((s, it) => s + media(itemCat(it)), 0);
  $('#ckEstimate').textContent = total ? `≈ ${Math.round(total / 60)} min por ciclo${total < 3300 ? ' (o resto da hora repete o relógio)' : ''}` : '';
}
$('#ckItems').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const it = PROG.relogios[editClock].itens, i = Number(b.closest('li').dataset.i);
  if (b.dataset.m === 'x') it.splice(i, 1); else { const j = i + Number(b.dataset.m); if (j >= 0 && j < it.length) [it[i], it[j]] = [it[j], it[i]]; }
  renderItens(); salvarRascunho();
};
$('#ckAdd').onclick = () => {
  const c = $('#ckAddCat').value, g = $('#ckAddGenre').value.trim();
  PROG.relogios[editClock].itens.push(g ? { categoria: c, genero: g } : c);
  renderItens(); salvarRascunho(); renderClocks();
};
$('#ckName').oninput = () => { PROG.relogios[editClock].nome = $('#ckName').value; salvarRascunho(); renderClocks(); };
$('#ckDefault').onchange = () => { if ($('#ckDefault').checked) { PROG.relogioPadrao = editClock; salvarRascunho(); renderClocks(); } };
$('#newClock').onclick = () => {
  let id = 'relogio', n = 1; while (PROG.relogios[id + n]) n++; id += n;
  PROG.relogios[id] = { nome: `Novo relógio ${n}`, itens: ['horacerta', 'vinheta', 'musica', 'musica', 'musica'] };
  salvarRascunho(); abrirClock(id);
};
$('#ckDel').onclick = () => {
  if (PROG.relogioPadrao === editClock) return toast('Escolha outro relógio como padrão antes de excluir este.');
  if (!confirm('Excluir este relógio?')) return;
  delete PROG.relogios[editClock];
  PROG.grade.forEach((g) => { if (g.relogio === editClock) delete g.relogio; });
  editClock = null; $('#clockEditor').hidden = true; salvarRascunho(); renderClocks(); renderWeek();
};

// ---------- Acervo ----------
function renderAcervo() {
  const url = (p) => `https://github.com/${repo()}/upload/main/acervo/${p}`;
  $('#folders').innerHTML = Object.entries(PASTAS).map(([c, p]) => `<div class="folder"><h3>${CATS[c]}</h3>
    <div class="muted">${ACERVO.filter((a) => a.cat === c).length} no ar · acervo/${p}</div><a href="${url(p)}" target="_blank" rel="noopener">Enviar ${CATS[c].toLowerCase()}</a></div>`).join('');
  const slug = () => $('#progSlug').value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const upd = () => { $('#progUp').href = slug() ? url(`programas/${slug()}`) : '#'; };
  $('#progSlug').oninput = upd; upd();
  $('#progUp').onclick = (e) => { if (!slug()) { e.preventDefault(); toast('Dê um nome ao programa primeiro.'); } };
  const q = $('#acSearch').value.toLowerCase(), c = $('#acCat').value;
  const rows = ACERVO.filter((a) => (!c || a.cat === c) && (!q || `${a.titulo} ${a.artista} ${a.origem}`.toLowerCase().includes(q)));
  $('#acCount').textContent = `${rows.length} de ${ACERVO.length}`;
  $('#acBody').innerHTML = rows.map((a) => `<tr><td>${esc(a.titulo)}</td><td>${esc(a.artista)}</td><td><span class="cat ${a.cat === 'comercial' ? 'spot' : a.cat}">${CATS[a.cat]}</span></td>
    <td>${esc(a.programa || a.genero)}</td><td class="mono">${dur(a.dur)}</td>
    <td><a class="muted" href="https://github.com/${repo()}/blob/main/${encodeURI(a.origem)}" target="_blank" rel="noopener">${esc(a.origem.split('/').pop())}</a></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhum áudio publicado ainda.</td></tr>';
}
$('#acSearch').oninput = renderAcervo; $('#acCat').onchange = renderAcervo;

// ---------- Prévia e relatório (a partir da programação publicada) ----------
const inicioDia = (data) => Date.parse(`${data}T00:00:00-03:00`);
function eventosDoDia(data) {
  const ms = inicioDia(data), C = PLAYOUT.ciclo;
  const s0 = ((((ms - PLAYOUT.ancora) / 1000) % C) + C) % C;
  return PLAYOUT.e.filter((e) => e[0] >= s0 && e[0] < s0 + 86400).map((e) => ({ e, quando: new Date(ms + (e[0] - s0) * 1000) }));
}
const hms = (d) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const hojeISO = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
$('#pvFrom').innerHTML = ['00', '06', '12', '18'].map((h) => `<option value="${h}">${h}h às ${String(+h + 6).padStart(2, '0')}h</option>`).join('');
$('#pvGo').onclick = () => {
  if (!PLAYOUT?.e.length) return ($('#pvList').innerHTML = '<li class="muted">Ainda não há programação publicada.</li>');
  const h = Number($('#pvFrom').value);
  const lista = eventosDoDia($('#pvDate').value).filter(({ quando }) => { const x = Number(hms(quando).slice(0, 2)); return x >= h && x < h + 6; });
  $('#pvList').innerHTML = lista.map(({ e, quando }) => { const f = PLAYOUT.faixas[e[2]], slot = e[3] >= 0 ? PLAYOUT.slots[e[3]].t : '';
    return `<li><span class="t">${hms(quando).slice(0, 5)}</span><div><div class="ti">${esc(f.t)}${e[1] < f.d - 1 ? ' <span class="muted">(encurtada para o programa entrar na hora)</span>' : ''}</div><div class="sub">${esc([f.a, slot].filter(Boolean).join(' · '))}</div></div><span class="cat ${f.c === 'comercial' ? 'spot' : f.c}">${CATS[f.c]}</span></li>`; }).join('');
  $('#pvInfo').textContent = `Versão publicada em ${new Date(PLAYOUT.gerado).toLocaleString('pt-BR')}. Alterações ainda não publicadas não aparecem aqui.`;
};
$('#repDl').onclick = () => {
  if (!PLAYOUT?.e.length) return toast('Ainda não há programação publicada.');
  const de = $('#repFrom').value, ate = $('#repTo').value, todos = $('#repAll').checked;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [['Data', 'Hora', 'Título', 'Intérprete', 'Autor/Compositor', 'ISRC', 'Duração', 'Programa'].map(q).join(';')];
  for (let ms = inicioDia(de); ms <= inicioDia(ate); ms += 86400000) {
    const data = new Date(ms + 3 * 3600000).toISOString().slice(0, 10);
    for (const { e, quando } of eventosDoDia(data)) {
      const f = PLAYOUT.faixas[e[2]];
      if (!todos && f.c !== 'musica') continue;
      linhas.push([quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }), hms(quando), f.t, f.a, f.cp, f.i, dur(e[1]), e[3] >= 0 ? PLAYOUT.slots[e[3]].t : ''].map(q).join(';'));
    }
  }
  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `execucao-radio-tec_${de}_${ate}.csv`; a.click();
  $('#repInfo').textContent = `${linhas.length - 1} execuções no período. O relatório usa a programação publicada atualmente.`;
};

// ---------- Publicar e configurações ----------
$('#pubGo').onclick = async () => {
  const txt = JSON.stringify(PROG, null, 2) + '\n';
  try { await navigator.clipboard.writeText(txt); $('#pubInfo').textContent = 'Copiado. Agora cole no GitHub e clique em Commit changes.'; }
  catch { $('#pubJson').select(); $('#pubInfo').textContent = 'Não consegui copiar sozinho: copie o texto abaixo (Ctrl+C).'; }
  window.open(`https://github.com/${repo()}/edit/main/programacao.json`, '_blank', 'noopener');
};
$('#pubDiscard').onclick = () => { if (confirm('Voltar para a programação publicada e descartar o que foi alterado aqui?')) { PROG = structuredClone(PUBLICADO); salvarRascunho(); tudo(); } };
function renderConfig() {
  $('#setName').value = PROG.radio || ''; $('#setSlogan').value = PROG.slogan || ''; $('#setRepo').value = PROG.repositorio || '';
  $('#setSong').value = PROG.regras?.musicaNaoRepeteMin ?? 180; $('#setArtist').value = PROG.regras?.artistaNaoRepeteMin ?? 60;
}
const cfg = (id, fn) => ($(id).oninput = () => { fn($(id).value); salvarRascunho(); });
cfg('#setName', (v) => (PROG.radio = v)); cfg('#setSlogan', (v) => (PROG.slogan = v)); cfg('#setRepo', (v) => (PROG.repositorio = v.trim()));
cfg('#setSong', (v) => ((PROG.regras ||= {}).musicaNaoRepeteMin = Number(v))); cfg('#setArtist', (v) => ((PROG.regras ||= {}).artistaNaoRepeteMin = Number(v)));

function tudo() { renderWeek(); renderClocks(); renderAcervo(); renderConfig(); salvarRascunho(); }

// ---------- Início ----------
(async () => {
  const pega = async (u, padrao) => { try { const r = await fetch(`../${u}?v=${Date.now()}`, { cache: 'no-store' }); return r.ok ? await r.json() : padrao; } catch { return padrao; } };
  [PUBLICADO, ACERVO, PLAYOUT] = await Promise.all([pega('programacao.json', null), pega('acervo.json', []), pega('playout.json', null)]);
  if (!PUBLICADO) { document.querySelector('main').innerHTML = '<div class="card">Não encontrei a programação publicada (programacao.json).</div>'; return; }
  let rasc = null; try { rasc = JSON.parse(localStorage.getItem(RASCUNHO)); } catch {}
  PROG = rasc || structuredClone(PUBLICADO);
  if (rasc) toast('Você tem alterações não publicadas desta máquina.');
  const opts = Object.entries(CATS).filter(([c]) => c !== 'programa').map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('#ckAddCat').innerHTML = opts; $('#acCat').innerHTML += Object.entries(CATS).map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('#pvDate').value = hojeISO(); $('#repTo').value = hojeISO(); $('#repFrom').value = hojeISO().slice(0, 8) + '01';
  $('#pvFrom').value = String(Math.floor(new Date().getHours() / 6) * 6).padStart(2, '0');
  tudo(); $('#pvGo').click();
  const tab = location.hash.slice(1); if (tab) document.querySelector(`#tabs [data-tab="${tab}"]`)?.click();
})();
