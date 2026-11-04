// Rádio Tec: painel de programação
const $ = (s) => document.querySelector(s);
const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const KIND = { relogio: 'Relógio', programa: 'Programa', aovivo: 'Ao vivo' };
let META = { categories: {}, settings: {} };
let TRACKS = [], CLOCKS = [], SLOTS = [];

const api = async (url, opts = {}) => {
  const o = { ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(o.body); }
  const r = await fetch(url, o);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || data || r.statusText);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '–');
const hm = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const catName = (c) => META.categories[c] || c;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }

// ---------- Abas ----------
document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === b.dataset.tab));
  location.hash = b.dataset.tab;
  if (b.dataset.tab === 'grade') renderWeek();
});

// ---------- No ar ----------
async function refreshOnAir() {
  try {
    const np = await api('/api/nowplaying');
    const live = np.live;
    $('#airDot').className = 'dot ' + (live ? 'live' : np.now ? 'on' : '');
    $('.onair').classList.toggle('live', live);
    $('#onairLabel').textContent = live ? 'AO VIVO' : 'TOCANDO AGORA';
    if (np.now) {
      $('#npTitle').textContent = np.now.title;
      $('#npArtist').textContent = np.now.artist || '';
      $('#npChips').innerHTML = [
        `<span class="chip">${esc(catName(np.now.category))}</span>`,
        np.now.slot_title ? `<span class="chip">${esc(np.now.slot_title)}</span>` : '',
        `<span class="chip">desde ${hm(np.now.started_at * 1000)}</span>`,
        np.listeners != null ? `<span class="chip">${np.listeners} ouvinte${np.listeners === 1 ? '' : 's'}</span>` : '',
      ].join('');
    }
    const log = await api('/api/admin/log?limit=40');
    $('#logList').innerHTML = log.map((r) => `<li><span class="t">${hm(r.started_at * 1000)}</span>
      <div><div class="ti">${esc(r.title)}</div><div class="sub">${esc(r.artist || r.slot_title || '')}</div></div>
      <span class="cat ${r.category}">${esc(catName(r.category))}</span></li>`).join('') || '<li class="muted">Nada tocou ainda.</li>';
  } catch (e) { console.warn(e); }
}
async function refreshNext() {
  const list = await api('/api/admin/simulate?hours=1');
  $('#nextList').innerHTML = timelineHtml(list);
}
function timelineHtml(list) {
  return list.map((r) => `<li><span class="t">${hm(r.at)}</span>
    <div><div class="ti">${esc(r.title)}</div><div class="sub">${esc([r.artist, r.slot].filter(Boolean).join(' · '))}</div></div>
    <span class="cat ${r.category || ''}">${esc(catName(r.category || ''))}</span></li>`).join('') || '<li class="muted">Sem faixas na biblioteca ainda.</li>';
}
$('#refreshNext').onclick = refreshNext;

// ---------- Biblioteca ----------
async function loadTracks() {
  TRACKS = await api('/api/admin/tracks');
  renderLib(); fillTrackSelects();
}
function renderLib() {
  const q = $('#libSearch').value.toLowerCase(), c = $('#libCat').value;
  const rows = TRACKS.filter((t) => (!c || t.category === c) && (!q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)));
  $('#libCount').textContent = `${rows.length} de ${TRACKS.length}`;
  const catOpts = (sel) => Object.entries(META.categories).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  $('#libBody').innerHTML = rows.map((t) => `<tr data-id="${t.id}" class="${t.active ? '' : 'off'}">
    <td><button class="icon" data-act="play" title="Ouvir">▶</button></td>
    <td><input data-f="title" value="${esc(t.title)}"></td>
    <td><input data-f="artist" value="${esc(t.artist)}"></td>
    <td><select data-f="category">${catOpts(t.category)}</select></td>
    <td class="mono">${dur(t.duration)}</td>
    <td class="mono" title="Loudness medido">${t.loudness != null ? t.loudness.toFixed(1) + ' LUFS' : '…'}</td>
    <td class="mono">${t.play_count}</td>
    <td><input type="checkbox" data-f="active" ${t.active ? 'checked' : ''}></td>
    <td><button class="icon" data-act="del" title="Excluir">✕</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">Nenhum arquivo.</td></tr>';
}
$('#libSearch').oninput = renderLib; $('#libCat').onchange = renderLib;
$('#libBody').addEventListener('change', async (e) => {
  const tr = e.target.closest('tr'), f = e.target.dataset.f; if (!f) return;
  const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  const t = await api(`/api/admin/tracks/${tr.dataset.id}`, { method: 'PATCH', body: { [f]: val } });
  Object.assign(TRACKS.find((x) => x.id === t.id), t); tr.classList.toggle('off', !t.active); toast('Salvo');
});
$('#libBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = Number(b.closest('tr').dataset.id), t = TRACKS.find((x) => x.id === id);
  if (b.dataset.act === 'play') { const a = $('#preview'); a.hidden = false; a.src = `/media/${t.path.replace(/^media\//, '')}`; a.play(); }
  if (b.dataset.act === 'del' && confirm(`Excluir "${t.title}"? O arquivo será apagado.`)) { await api(`/api/admin/tracks/${id}`, { method: 'DELETE' }); loadTracks(); }
});
async function uploadFiles(files) {
  files = [...files]; if (!files.length) return;
  const st = $('#upStatus'); let done = 0;
  for (let i = 0; i < files.length; i += 10) {
    const fd = new FormData(); fd.append('category', $('#upCat').value);
    files.slice(i, i + 10).forEach((f) => fd.append('files', f));
    st.textContent = `Enviando ${Math.min(i + 10, files.length)} de ${files.length}…`;
    const r = await api('/api/admin/tracks', { method: 'POST', body: fd }); done += r.added.length;
  }
  st.textContent = `${done} arquivo(s) adicionados. O volume de cada um é medido em segundo plano.`;
  loadTracks(); setTimeout(loadTracks, 8000);
}
$('#upFiles').onchange = (e) => uploadFiles(e.target.files);
const drop = $('#drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); };

function fillTrackSelects() {
  const all = TRACKS.filter((t) => t.active).map((t) => `<option value="${t.id}">[${esc(catName(t.category))}] ${esc(t.title)}${t.artist ? ' · ' + esc(t.artist) : ''}</option>`).join('');
  $('#ckAddTrack').innerHTML = all;
  const prog = TRACKS.filter((t) => t.active && t.category !== 'musica').concat(TRACKS.filter((t) => t.active && t.category === 'musica'));
  $('#slAddItem').innerHTML = prog.map((t) => `<option value="${t.id}">[${esc(catName(t.category))}] ${esc(t.title)} (${dur(t.duration)})</option>`).join('');
}

// ---------- Relógios ----------
let editingClock = null;
async function loadClocks() { CLOCKS = await api('/api/admin/clocks'); renderClockList(); fillClockSelect(); }
function renderClockList() {
  $('#clockList').innerHTML = CLOCKS.map((c) => `<li data-id="${c.id}" class="${editingClock?.id === c.id ? 'sel' : ''}">
    <span class="swatch" style="background:${c.color}"></span><span class="grow">${esc(c.name)}</span>
    ${META.settings.defaultClockId === c.id ? '<span class="chip">padrão</span>' : ''}<span class="muted">${c.items.length} itens</span></li>`).join('');
}
$('#clockList').onclick = (e) => { const li = e.target.closest('li'); if (li) openClock(CLOCKS.find((c) => c.id === Number(li.dataset.id))); };
function openClock(c) {
  editingClock = JSON.parse(JSON.stringify(c));
  $('#clockEditor').hidden = false;
  $('#ckName').value = c.name; $('#ckColor').value = c.color;
  $('#ckDefault').checked = META.settings.defaultClockId === c.id;
  renderClockItems(); renderClockList();
}
function itemLabel(it) {
  if (it.type === 'track') { const t = TRACKS.find((x) => x.id === it.trackId); return `Faixa fixa: ${t ? t.title : '(removida)'}`; }
  return `${catName(it.category)}${it.genre ? ` · gênero "${it.genre}"` : ''}`;
}
function renderClockItems() {
  const items = editingClock.items;
  $('#ckItems').innerHTML = items.map((it, i) => `<li data-i="${i}"><span class="cat ${it.category || ''} grow">${esc(itemLabel(it))}</span>
    <button class="icon" data-m="-1" title="Subir">↑</button><button class="icon" data-m="1" title="Descer">↓</button><button class="icon" data-m="x" title="Remover">✕</button></li>`).join('');
  // Estimativa de duração da hora com a média da biblioteca
  const avg = (cat) => { const l = TRACKS.filter((t) => t.category === cat && t.duration); return l.length ? l.reduce((a, t) => a + t.duration, 0) / l.length : 0; };
  const total = items.reduce((a, it) => a + (it.type === 'track' ? (TRACKS.find((t) => t.id === it.trackId)?.duration || 0) : avg(it.category)), 0);
  $('#ckEstimate').textContent = total ? `≈ ${Math.round(total / 60)} min por ciclo${total < 3300 ? ' (o resto da hora é completado repetindo o relógio)' : ''}` : '';
}
$('#ckItems').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const i = Number(b.closest('li').dataset.i), it = editingClock.items;
  if (b.dataset.m === 'x') it.splice(i, 1);
  else { const j = i + Number(b.dataset.m); if (j >= 0 && j < it.length) [it[i], it[j]] = [it[j], it[i]]; }
  renderClockItems();
};
$('#ckAdd').onclick = () => { editingClock.items.push({ type: 'category', category: $('#ckAddCat').value, ...($('#ckAddGenre').value ? { genre: $('#ckAddGenre').value } : {}) }); renderClockItems(); };
$('#ckAddT').onclick = () => { if ($('#ckAddTrack').value) { editingClock.items.push({ type: 'track', trackId: Number($('#ckAddTrack').value) }); renderClockItems(); } };
$('#newClock').onclick = async () => { const c = await api('/api/admin/clocks', { method: 'POST', body: { name: 'Novo relógio', items: [] } }); await loadClocks(); openClock(c); };
$('#ckSave').onclick = async () => {
  const c = await api(`/api/admin/clocks/${editingClock.id}`, { method: 'PUT', body: { name: $('#ckName').value, color: $('#ckColor').value, items: editingClock.items } });
  if ($('#ckDefault').checked && META.settings.defaultClockId !== c.id) META.settings = await api('/api/admin/settings', { method: 'PUT', body: { defaultClockId: c.id } });
  await loadClocks(); openClock(c); toast('Relógio salvo');
};
$('#ckDel').onclick = async () => {
  if (!confirm('Excluir este relógio? As faixas da grade que usam ele passam a tocar o padrão.')) return;
  await api(`/api/admin/clocks/${editingClock.id}`, { method: 'DELETE' }); editingClock = null; $('#clockEditor').hidden = true; loadClocks();
};
function fillClockSelect() { $('#slClock').innerHTML = '<option value="">Usar o relógio padrão</option>' + CLOCKS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); }

// ---------- Grade ----------
async function loadSlots() { SLOTS = await api('/api/admin/slots'); renderWeek(); }
function renderWeek() {
  const today = new Date().getDay();
  let html = '<div class="hd"></div>' + DAYS.map((d, i) => `<div class="hd ${i === today ? 'today' : ''}">${d}</div>`).join('');
  html += '<div class="hours">' + Array.from({ length: 24 }, (_, h) => `<div>${String(h).padStart(2, '0')}h</div>`).join('') + '</div>';
  for (let d = 0; d < 7; d++) {
    html += `<div class="col" data-day="${d}">` + SLOTS.filter((s) => s.day === d).map((s) => {
      const top = toMin(s.start) / 60 * 40, h = Math.max(18, (toMin(s.end) - toMin(s.start)) / 60 * 40 - 2);
      const clock = CLOCKS.find((c) => c.id === s.clock_id);
      return `<div class="slot ${s.kind}" data-id="${s.id}" style="top:${top}px;height:${h}px"><b>${esc(s.title)}</b><span>${s.start} às ${s.end} · ${KIND[s.kind]}${clock ? ' · ' + esc(clock.name) : ''}</span></div>`;
    }).join('');
    if (d === today) { const n = new Date(); html += `<div class="nowline" style="top:${(n.getHours() * 60 + n.getMinutes()) / 60 * 40}px"></div>`; }
    html += '</div>';
  }
  $('#week').innerHTML = html;
}
$('#week').onclick = (e) => {
  const s = e.target.closest('.slot');
  if (s) return openSlot(SLOTS.find((x) => x.id === Number(s.dataset.id)));
  const col = e.target.closest('.col'); if (!col) return;
  const y = e.offsetY, h = Math.min(23, Math.floor(y / 40));
  openSlot(null, { day: Number(col.dataset.day), start: `${String(h).padStart(2, '0')}:00`, end: h === 23 ? '24:00' : `${String(h + 1).padStart(2, '0')}:00` });
};
$('#week').addEventListener('scroll', () => {}, { passive: true });

let editingSlot = null, slotItems = [];
function daysHtml(sel, name) { return DAYS.map((d, i) => `<label><input type="checkbox" name="${name}" value="${i}" ${sel.includes(i) ? 'checked' : ''}> ${d}</label>`).join(''); }
function openSlot(s, defaults = {}) {
  editingSlot = s; const v = s || { kind: 'relogio', title: '', start: '08:00', end: '09:00', day: 1, clock_id: null, items: [], ...defaults };
  $('#slotDlgTitle').textContent = s ? 'Editar faixa da grade' : 'Nova faixa na grade';
  $('#slTitle').value = v.title; $('#slKind').value = v.kind; $('#slStart').value = v.start; $('#slEnd').value = v.end === '24:00' ? '23:59' : v.end;
  $('#slDays').innerHTML = daysHtml([v.day], 'sd'); $('#slClock').value = v.clock_id || '';
  slotItems = [...v.items]; renderSlotItems(); syncKind(); $('#slErr').textContent = '';
  $('#slDel').hidden = !s; $('#slotDlg').showModal();
}
function syncKind() {
  const k = $('#slKind').value;
  $('#slProgBox').hidden = k !== 'programa';
  $('#slClockHint').textContent = k === 'programa' ? '(toca depois que os arquivos do programa acabarem)' : k === 'aovivo' ? '(cobre a janela se o locutor não entrar)' : '';
}
$('#slKind').onchange = syncKind;
function renderSlotItems() {
  const total = slotItems.reduce((a, id) => a + (TRACKS.find((t) => t.id === id)?.duration || 0), 0);
  $('#slItems').innerHTML = slotItems.map((id, i) => { const t = TRACKS.find((x) => x.id === id);
    return `<li data-i="${i}"><span class="grow">${esc(t ? t.title : '(removido)')}</span><span class="muted mono">${dur(t?.duration)}</span><button type="button" class="icon" data-x>✕</button></li>`; }).join('')
    + (slotItems.length ? `<li class="muted">Total: ${dur(total)}</li>` : '');
}
$('#slAdd').onclick = () => { if ($('#slAddItem').value) { slotItems.push(Number($('#slAddItem').value)); renderSlotItems(); } };
$('#slItems').onclick = (e) => { if (e.target.dataset.x !== undefined) { slotItems.splice(Number(e.target.closest('li').dataset.i), 1); renderSlotItems(); } };
$('#slCancel').onclick = () => $('#slotDlg').close();
$('#slDel').onclick = async () => { if (confirm('Excluir esta faixa da grade?')) { await api(`/api/admin/slots/${editingSlot.id}`, { method: 'DELETE' }); $('#slotDlg').close(); loadSlots(); } };
$('#slotForm').onsubmit = async (e) => {
  e.preventDefault();
  const days = [...document.querySelectorAll('input[name=sd]:checked')].map((x) => Number(x.value));
  if (!days.length) { $('#slErr').textContent = 'Escolha pelo menos um dia.'; return; }
  const end = $('#slEnd').value === '23:59' ? '24:00' : $('#slEnd').value;
  const body = { title: $('#slTitle').value, kind: $('#slKind').value, start: $('#slStart').value, end, day: days[0], days, clock_id: Number($('#slClock').value) || null, items: slotItems };
  try {
    if (editingSlot) {
      await api(`/api/admin/slots/${editingSlot.id}`, { method: 'PUT', body });
      if (days.length > 1) await api('/api/admin/slots', { method: 'POST', body: { ...body, days: days.slice(1) } });
    } else await api('/api/admin/slots', { method: 'POST', body });
    $('#slotDlg').close(); loadSlots(); toast('Grade atualizada');
  } catch (err) { $('#slErr').textContent = err.message; }
};
$('#newSlot').onclick = () => openSlot(null);
$('#copyDay').onclick = () => { $('#cpFrom').innerHTML = DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join(''); $('#cpTo').innerHTML = daysHtml([], 'cp'); $('#copyDlg').showModal(); };
$('#cpCancel').onclick = () => $('#copyDlg').close();
$('#copyForm').onsubmit = async (e) => {
  e.preventDefault();
  const to = [...document.querySelectorAll('input[name=cp]:checked')].map((x) => Number(x.value));
  if (!to.length) return;
  await api('/api/admin/slots/copy-day', { method: 'POST', body: { from: Number($('#cpFrom').value), to } });
  $('#copyDlg').close(); loadSlots(); toast('Grade copiada');
};

// Simulação
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$('#simFrom').value = localInput(new Date());
$('#simRun').onclick = async () => {
  const list = await api(`/api/admin/simulate?from=${encodeURIComponent(new Date($('#simFrom').value).toISOString())}&hours=${$('#simHours').value}`);
  $('#simList').innerHTML = timelineHtml(list);
};

// ---------- Relatórios e configurações ----------
const iso = (d) => localInput(d).slice(0, 10);
$('#repFrom').value = iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); $('#repTo').value = iso(new Date());
$('#repDl').onclick = () => { location.href = `/api/admin/reports/ecad.csv?from=${$('#repFrom').value}&to=${$('#repTo').value}${$('#repAll').checked ? '&all=1' : ''}`; };
function fillSettings() {
  const s = META.settings;
  $('#setName').value = s.stationName; $('#setSong').value = s.songSeparationMin; $('#setArtist').value = s.artistSeparationMin; $('#setProtect').value = s.protectProgramStartMin;
  $('#stationName').textContent = s.stationName; document.title = `${s.stationName} · Painel de programação`;
}
$('#setSave').onclick = async () => {
  META.settings = await api('/api/admin/settings', { method: 'PUT', body: { stationName: $('#setName').value, songSeparationMin: Number($('#setSong').value), artistSeparationMin: Number($('#setArtist').value), protectProgramStartMin: Number($('#setProtect').value) } });
  fillSettings(); toast('Configurações salvas');
};

// ---------- Início ----------
(async () => {
  META = await api('/api/admin/meta');
  const opts = Object.entries(META.categories).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#upCat').innerHTML = opts; $('#ckAddCat').innerHTML = opts; $('#libCat').innerHTML += opts;
  fillSettings();
  await Promise.all([loadTracks(), loadClocks()]);
  await loadSlots();
  const openHash = () => { const tab = location.hash.slice(1); const b = tab && document.querySelector(`#tabs [data-tab="${tab}"]`); if (b && !b.classList.contains('on')) b.click(); };
  window.addEventListener('hashchange', openHash); openHash();
  refreshOnAir(); refreshNext();
  setInterval(refreshOnAir, 10000);
  setInterval(() => { if ($('#grade').classList.contains('on')) renderWeek(); }, 60000);
})();
