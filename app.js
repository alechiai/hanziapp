// HanziApp — Logica principale
// IndexedDB + SM-2 + Gemini API + 4 sezioni

'use strict';

// ══════════════════════════════════════════════════
// 1. DATABASE (IndexedDB)
// ══════════════════════════════════════════════════
let db;
const DB_NAME = 'hanziapp', DB_VER = 1;

function initDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('known'))    d.createObjectStore('known',    { keyPath: 'id' });
      if (!d.objectStoreNames.contains('srs'))      d.createObjectStore('srs',      { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = e => { db = e.target.result; res(); };
    req.onerror   = () => rej(req.error);
  });
}

function dbGet(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
function dbGetAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
function dbPut(store, val) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(val);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}
function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}
function dbClear(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// Cache settings in memoria
let settingsCache = {};
async function loadSettings() {
  const all = await dbGetAll('settings');
  all.forEach(r => settingsCache[r.key] = r.value);
}
async function getSetting(key, def = '') {
  return settingsCache[key] !== undefined ? settingsCache[key] : def;
}
async function setSetting(key, value) {
  settingsCache[key] = value;
  await dbPut('settings', { key, value });
}

// ══════════════════════════════════════════════════
// 2. STATO APPLICAZIONE
// ══════════════════════════════════════════════════
let knownSet  = new Set();   // set di id numerici
let srsMap    = {};           // id -> record SM-2

async function loadState() {
  const knownAll = await dbGetAll('known');
  knownSet = new Set(knownAll.map(r => r.id));
  const srsAll = await dbGetAll('srs');
  srsMap = {};
  srsAll.forEach(r => srsMap[r.id] = r);
}

async function markKnown(id, known) {
  if (known) {
    knownSet.add(id);
    await dbPut('known', { id });
    if (!srsMap[id]) {
      const rec = freshSRS(id);
      srsMap[id] = rec;
      await dbPut('srs', rec);
    }
  } else {
    knownSet.delete(id);
    await dbDelete('known', id);
  }
}

// ══════════════════════════════════════════════════
// 3. ALGORITMO SM-2
// ══════════════════════════════════════════════════
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function freshSRS(id) {
  return { id, easiness: 2.5, interval: 1, repetitions: 0, due: todayStr() };
}

async function updateSRS(id, q) {
  // q: 0-5  (0=blackout, 5=perfetto)
  let r = srsMap[id] || freshSRS(id);
  if (q < 3) {
    r.repetitions = 0;
    r.interval = 1;
  } else {
    r.easiness = Math.max(1.3, r.easiness + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (r.repetitions === 0)      r.interval = 1;
    else if (r.repetitions === 1) r.interval = 6;
    else r.interval = Math.round(r.interval * r.easiness);
    r.repetitions++;
  }
  r.due = addDays(todayStr(), r.interval);
  srsMap[id] = r;
  await dbPut('srs', r);
}

function getDueIds() {
  const today = todayStr();
  return [...knownSet].filter(id => {
    const r = srsMap[id];
    return !r || r.due <= today;
  });
}

// ══════════════════════════════════════════════════
// 4. GEMINI API
// ══════════════════════════════════════════════════
const geminiCache = {};

async function callGemini(prompt) {
  const key   = await getSetting('gemini_api_key', '');
  const model = await getSetting('gemini_model', 'gemini-2.5-flash');
  if (!key) throw new Error('API Key non configurata');

  const cacheKey = prompt.slice(0, 300);
  if (geminiCache[cacheKey]) return geminiCache[cacheKey];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    let friendly = msg;
    if (res.status === 400) friendly = `Modello non valido o chiave errata (400): ${msg}`;
    else if (res.status === 403) friendly = `Chiave non autorizzata (403) — verifica su aistudio.google.com`;
    else if (res.status === 404) friendly = `Modello non trovato (404): ${model}`;
    else if (res.status === 429) friendly = `Troppe richieste (429), aspetta`;
    throw new Error(friendly);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = (parts.find(p => !p.thought) || parts[0] || {}).text || '';
  geminiCache[cacheKey] = text;
  return text;
}

function parseJSON(text) {
  // Estrae il primo oggetto JSON dal testo (ignora eventuali markdown ```json```)
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Risposta AI non parsabile');
  return JSON.parse(m[0]);
}

async function generateTranslationExercise(knownChars) {
  const shuffled = [...knownChars].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, 20).map(c => c.char).join('');
  const prompt = `Sei un insegnante di cinese per principianti. Crea UNA frase breve (5-7 caratteri) usando SOLO i caratteri di questa lista: ${sample}
Regole RIGIDE:
- Usa SOLO caratteri di questa lista + le particelle grammaticali: 的 了 吗 呢 也 都 (anche se non in lista)
- Massimo 7 caratteri totali
- Frase semplice, vita quotidiana, non poetica
- Se non riesci con questi caratteri, semplifica fino all'osso
Rispondi SOLO con questo JSON valido (nessun altro testo):
{"sentence":"...","pinyin":"...","translation_it":"..."}`;
  const text = await callGemini(prompt);
  return parseJSON(text);
}

async function generateExampleSentence(newChar, knownChars) {
  const shuffled = [...knownChars].sort(() => Math.random() - 0.5);
  const known10 = shuffled.slice(0, 10).map(c => c.char).join('');
  const prompt = `Crea UNA frase di esempio breve (5-7 caratteri) che metta in risalto il carattere ${newChar.char} (${newChar.pinyin}, "${newChar.it}").
Preferisci questi caratteri già noti per il resto della frase: ${known10}
Particelle sempre permesse: 的 了 吗 呢 也 都
Priorità: chiarezza sul significato di ${newChar.char}, non naturalezza a tutti i costi.
Rispondi SOLO con questo JSON valido:
{"sentence":"...","pinyin":"...","translation_it":"..."}`;
  const text = await callGemini(prompt);
  return parseJSON(text);
}

// ══════════════════════════════════════════════════
// 5. NAVIGAZIONE
// ══════════════════════════════════════════════════
function showScreen(name) {
  if (isSelecting && name !== 'library') {
    isSelecting = false;
    selectedIds.clear();
    document.getElementById('select-bar').classList.remove('visible');
    const btn = document.getElementById('btn-select');
    if (btn) { btn.textContent = 'Seleziona'; btn.classList.remove('active'); }
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  document.querySelector(`[data-screen="${name}"]`).classList.add('active');

  if (name === 'library')  renderLibrary();
  if (name === 'review')   renderReviewStart();
  if (name === 'learn')    renderLearnStart();
  if (name === 'settings') renderSettings();
}

// ══════════════════════════════════════════════════
// 6. LIBRERIA
// ══════════════════════════════════════════════════
let libFilter = 'all', libSearch = '';
let isSelecting = false;
let selectedIds = new Set();

function renderLibrary() {
  updateStats();
  renderCharGrid();
}

function updateStats() {
  const today = todayStr();
  document.getElementById('stat-known').textContent = knownSet.size;
  document.getElementById('stat-total').textContent = HANZI_DB.length;
  document.getElementById('stat-due').textContent   = getDueIds().length;
}

function renderCharGrid() {
  const grid = document.getElementById('char-grid');
  let data = HANZI_DB;

  // Filtro
  if (libFilter === 'known')   data = data.filter(c => knownSet.has(c.id));
  else if (libFilter === 'unknown') data = data.filter(c => !knownSet.has(c.id));
  else if (/^[1-6]$/.test(libFilter)) data = data.filter(c => c.hsk === +libFilter);

  // Ricerca
  if (libSearch) {
    const q = libSearch.toLowerCase();
    data = data.filter(c =>
      c.char.includes(q) ||
      c.pinyin.toLowerCase().includes(q) ||
      c.it.toLowerCase().includes(q)
    );
  }

  grid.innerHTML = data.map(c => {
    const isKnown    = knownSet.has(c.id);
    const isSelected = isSelecting && selectedIds.has(c.id);
    const classes    = ['char-card', isKnown ? 'known' : '', isSelecting ? 'selectable' : '', isSelected ? 'selected' : ''].filter(Boolean).join(' ');
    const badge      = isSelecting ? '<span class="select-check"></span>' : (isKnown ? '<span class="known-badge">✓</span>' : '');
    return `
      <div class="${classes}" data-id="${c.id}" onclick="handleCardClick(${c.id})">
        ${badge}
        <span class="hsk-badge">HSK${c.hsk}</span>
        <div class="char-big">${c.char}</div>
        <div class="char-pinyin">${c.pinyin}</div>
        <div class="char-meaning">${c.it}</div>
      </div>`;
  }).join('');

  if (!isSelecting) {
    grid.querySelectorAll('.char-card').forEach(card => {
      const id = +card.dataset.id;
      addLongPress(card, () => { enterSelectMode(); toggleSelectCard(id); });
    });
  }
}

function handleCardClick(id) {
  if (isSelecting) toggleSelectCard(id);
  else openModal(id);
}

function enterSelectMode() {
  isSelecting = true;
  selectedIds.clear();
  document.getElementById('select-bar').classList.add('visible');
  const btn = document.getElementById('btn-select');
  if (btn) { btn.textContent = 'Fine'; btn.classList.add('active'); }
  updateSelectionBar();
  renderCharGrid();
}

function exitSelectMode() {
  isSelecting = false;
  selectedIds.clear();
  document.getElementById('select-bar').classList.remove('visible');
  const btn = document.getElementById('btn-select');
  if (btn) { btn.textContent = 'Seleziona'; btn.classList.remove('active'); }
  renderCharGrid();
}

function toggleSelectMode() {
  if (isSelecting) exitSelectMode();
  else enterSelectMode();
}

function toggleSelectCard(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  const card = document.querySelector('.char-card[data-id="' + id + '"]');
  if (card) card.classList.toggle('selected', selectedIds.has(id));
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = selectedIds.size;
  document.getElementById('select-count').textContent =
    n === 0 ? 'Seleziona caratteri' : n + ' selezionat' + (n === 1 ? 'o' : 'i');
}

async function markSelectedAsKnown() {
  if (selectedIds.size === 0) { showToast('Nessun carattere selezionato'); return; }
  const count = selectedIds.size;
  const ids   = [...selectedIds];
  for (const id of ids) await markKnown(id, true);
  exitSelectMode();
  updateStats();
  showToast(count + ' caratter' + (count === 1 ? 'e aggiunto' : 'i aggiunti') + ' ai noti ✓');
}

// Filtri libreria
document.getElementById('lib-filters').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  libFilter = btn.dataset.filter;
  renderCharGrid();
});

document.getElementById('lib-search').addEventListener('input', e => {
  libSearch = e.target.value.trim();
  renderCharGrid();
});

// ── Modal ──
let modalCurrentId = null;
function openModal(id) {
  const c = HANZI_DB.find(x => x.id === id);
  if (!c) return;
  modalCurrentId = id;
  document.getElementById('modal-char').textContent    = c.char;
  document.getElementById('modal-pinyin').textContent  = c.pinyin;
  document.getElementById('modal-meaning').textContent = c.it;
  document.getElementById('modal-meta').textContent    = `HSK ${c.hsk}`;
  const btn = document.getElementById('modal-toggle-known');
  if (knownSet.has(id)) {
    btn.textContent = '✗ Non lo conosco';
    btn.className = 'btn btn-danger';
  } else {
    btn.textContent = '✓ Lo conosco';
    btn.className = 'btn btn-success';
  }
  document.getElementById('char-modal').classList.add('open');
}
function closeModal() {
  document.getElementById('char-modal').classList.remove('open');
  modalCurrentId = null;
}
async function toggleKnownFromModal() {
  if (modalCurrentId === null) return;
  const isKnown = knownSet.has(modalCurrentId);
  await markKnown(modalCurrentId, !isKnown);
  showToast(isKnown ? 'Rimosso dai noti' : 'Aggiunto ai noti ✓');
  closeModal();
  renderLibrary();
}

// ══════════════════════════════════════════════════
// 7. RIPASSO
// ══════════════════════════════════════════════════
let exerciseBank = [], bankIdx = 0, reviewTotal = 0;
let buildAnswer = [];

function renderReviewStart() {
  const due = getDueIds();
  document.getElementById('review-due-count').textContent = due.length;
  document.getElementById('review-start').style.display = '';
  document.getElementById('review-session').style.display = 'none';

  if (knownSet.size < 5) {
    document.getElementById('review-empty').classList.remove('hidden');
    document.getElementById('review-ready').style.display = 'none';
  } else {
    document.getElementById('review-empty').classList.add('hidden');
    document.getElementById('review-ready').style.display = '';
  }
}

async function generateExerciseBank(knownChars, discoveryChars = []) {
  const shuffled = [...knownChars].sort(() => Math.random() - 0.5);
  const vocab = shuffled.slice(0, 150).map(c => `${c.char}|${c.pinyin}|${c.it}`).join('\n');
  const nTotal = Math.min(8, knownChars.length);
  const discPart = discoveryChars.length > 0
    ? '\nCARATTERI DA SCOPRIRE (introducili in 1-2 esercizi): ' +
      discoveryChars.map(c => `${c.char}(${c.pinyin},"${c.it}")`).join(', ')
    : '';
  const prompt =
    `Sei un insegnante esperto di cinese mandarino. Genera un banco di ${nTotal} esercizi VARIATI basati su questi caratteri noti:\n` +
    vocab + discPart +
    '\nTIPI disponibili (usa almeno 2 tipi diversi):\n' +
    '1. translate_v2 — mostra frase cinese, studente la traduce\n' +
    '2. fill_v2 — frase con carattere mancante, 4 opzioni multiple\n' +
    '3. build — frase italiana, studente ricostruisce cinese scegliendo caratteri\n' +
    '4. discover — presenta carattere NUOVO con esempio\n' +
    'REGOLE:\n' +
    '- Ogni frase max 7 caratteri\n' +
    '- Usa SOLO caratteri dal vocabolario dato + particelle: 的 了 吗 呢 也 都\n' +
    '- Per fill_v2: "distractors"=array di 3 caratteri errati ma plausibili\n' +
    '- Per build: "words"=array dei caratteri/parole della frase cinese in ordine MESCOLATO\n' +
    '- Per discover: usa campi char,pinyin,meaning_it,example_sentence,example_pinyin,example_translation_it\n' +
    '- JSON puro, nessun testo extra\n' +
    'Rispondi SOLO con un array JSON valido:\n' +
    '[{"type":"translate_v2","sentence":"...","pinyin":"...","translation_it":"..."},' +
    '{"type":"fill_v2","sentence_with_blank":"...","pinyin":"...","answer":"...","distractors":["","",""],"translation_it":"..."},' +
    '{"type":"build","translation_it":"...","sentence":"...","pinyin":"...","words":["",""]},' +
    '{"type":"discover","char":"...","pinyin":"...","meaning_it":"...","example_sentence":"...","example_pinyin":"...","example_translation_it":"..."}]';
  const raw = await callGemini(prompt);
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Bank non parsabile');
  return JSON.parse(m[0]);
}

async function startReview() {
  const maxEx = +settingsCache['ex_count'] || 20;
  const knownChars = HANZI_DB.filter(c => knownSet.has(c.id));
  const dueIds = getDueIds();

  const discoveryChars = knownChars.length >= 10
    ? HANZI_DB.filter(c => !knownSet.has(c.id)).sort((a, b) => a.hsk - b.hsk).slice(0, 2)
    : [];

  document.getElementById('review-start').style.display = 'none';
  document.getElementById('review-session').style.display = '';

  showSpinner(true);
  try {
    exerciseBank = await generateExerciseBank(knownChars, discoveryChars);
  } catch (e) {
    showToast('AI: ' + (e.message || 'errore'), 4000);
    exerciseBank = [...knownChars].sort(() => Math.random() - 0.5).slice(0, maxEx)
      .map(c => ({ type: 'pinyin_local', char: c.char, pinyin: c.pinyin, meaning_it: c.it, id: c.id }));
  } finally {
    showSpinner(false);
  }

  if (exerciseBank.length < maxEx) {
    const extra = HANZI_DB.filter(c => dueIds.includes(c.id))
      .sort(() => Math.random() - 0.5)
      .slice(0, maxEx - exerciseBank.length)
      .map(c => ({ type: 'pinyin_local', char: c.char, pinyin: c.pinyin, meaning_it: c.it, id: c.id }));
    exerciseBank = [...exerciseBank, ...extra];
  }

  bankIdx = 0;
  reviewTotal = Math.min(maxEx, exerciseBank.length);
  await nextReviewExercise();
}

async function nextReviewExercise() {
  if (bankIdx >= reviewTotal) { showReviewComplete(); return; }
  renderBankExercise(exerciseBank[bankIdx]);
}

function progressHTML() {
  const pct = Math.round((bankIdx / reviewTotal) * 100);
  return `
    <div class="exercise-progress">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="progress-text">${bankIdx}/${reviewTotal}</div>
    </div>`;
}

function renderBankExercise(ex) {
  if (!ex) { showReviewComplete(); return; }
  switch (ex.type) {
    case 'translate_v2': renderTranslateExercise_v2(ex); break;
    case 'fill_v2':      renderFillExercise_v2(ex); break;
    case 'build':        renderBuildExercise(ex); break;
    case 'discover':     renderDiscoverCard(ex); break;
    default:             renderPinyinLocal(ex);
  }
}

function escapePy(s) { return s.replace(/'/g, "\\'"); }

function normalizePinyin(s) {
  return s.toLowerCase()
    .replace(/[āáǎà]/g, 'a').replace(/[ēéěè]/g, 'e')
    .replace(/[īíǐì]/g, 'i').replace(/[ōóǒò]/g, 'o')
    .replace(/[ūúǔù]/g, 'u').replace(/[ǖǘǚǜü]/g, 'u')
    .replace(/\s+/g, '');
}

function togglePinyin() {
  const el  = document.getElementById('ex-pinyin');
  const btn = document.querySelector('.toggle-pinyin-btn');
  el.classList.toggle('visible');
  btn.textContent = el.classList.contains('visible') ? 'Nascondi Pinyin' : 'Mostra Pinyin';
}

// ── Esercizio A: Traduzione frase (v2) ──
function renderTranslateExercise_v2(ex) {
  const wrap = document.getElementById('review-session');
  wrap.innerHTML = progressHTML() + `
    <div class="exercise-card">
      <div class="exercise-type">Traduzione frase</div>
      <div class="sentence-display">${ex.sentence}</div>
      <div class="pinyin-display" id="ex-pinyin">${ex.pinyin}</div>
      <button class="toggle-pinyin-btn" onclick="togglePinyin()">Mostra Pinyin</button>
      <textarea class="answer-input" id="ex-answer" rows="2" placeholder="Scrivi la traduzione in italiano…"></textarea>
      <div class="answer-reveal" id="ex-reveal">
        <div class="label">Traduzione corretta:</div>
        <div class="value">${ex.translation_it}</div>
      </div>
      <button class="btn btn-primary btn-full" id="ex-check-btn" onclick="checkTranslate_v2()" style="margin-top:12px">Controlla</button>
      <div class="rating-row" id="ex-rating" style="display:none">
        <button class="rating-btn" onclick="rateBank(1)">😕</button>
        <button class="rating-btn" onclick="rateBank(3)">🤔</button>
        <button class="rating-btn" onclick="rateBank(5)">😊</button>
      </div>
    </div>`;
}

function checkTranslate_v2() {
  document.getElementById('ex-reveal').classList.add('visible');
  document.getElementById('ex-check-btn').style.display = 'none';
  document.getElementById('ex-rating').style.display = 'flex';
}

async function rateBank(q) {
  const ex = exerciseBank[bankIdx];
  if (ex) {
    if ((ex.type === 'translate_v2' || ex.type === 'build') && ex.sentence) {
      for (const ch of [...ex.sentence]) {
        const c = HANZI_DB.find(x => x.char === ch);
        if (c && knownSet.has(c.id)) await updateSRS(c.id, q);
      }
    } else if (ex.id && knownSet.has(ex.id)) {
      await updateSRS(ex.id, q);
    }
  }
  bankIdx++;
  await nextReviewExercise();
}

// ── Esercizio B: Fill-in-the-blank (v2) ──
function renderFillExercise_v2(ex) {
  const options = [ex.answer, ...(ex.distractors || [])].sort(() => Math.random() - 0.5);
  const choicesHtml = options.map(ch =>
    `<button class="choice-btn" onclick="checkFill_v2(this,'${ch}','${ex.answer}')">${ch}</button>`
  ).join('');
  const blankHtml = (ex.sentence_with_blank || '').replace('___', '<span class="blank-slot">___</span>');
  const wrap = document.getElementById('review-session');
  wrap.innerHTML = progressHTML() + `
    <div class="exercise-card">
      <div class="exercise-type">Completa la frase</div>
      <div class="sentence-blank">${blankHtml}</div>
      <div style="font-size:13px;color:var(--text2);text-align:center;margin-bottom:12px">${ex.pinyin}</div>
      <div class="choices-grid" id="choices-grid">${choicesHtml}</div>
      <div class="answer-reveal" id="ex-reveal" style="display:none">
        <div class="label">Traduzione:</div>
        <div class="value">${ex.translation_it}</div>
      </div>
    </div>`;
}

async function checkFill_v2(btn, chosen, correct) {
  document.querySelectorAll('.choice-btn').forEach(b => b.classList.add('disabled'));
  const q = chosen === correct ? 5 : 1;
  if (chosen === correct) {
    btn.classList.add('correct');
    showToast('✓ Corretto!');
  } else {
    btn.classList.add('wrong');
    document.querySelectorAll('.choice-btn').forEach(b => { if (b.textContent === correct) b.classList.add('correct'); });
    showToast('✗ Sbagliato');
  }
  const revEl = document.getElementById('ex-reveal');
  revEl.style.display = 'block';
  revEl.classList.add('visible');
  const ex = exerciseBank[bankIdx];
  if (ex && ex.answer) {
    const c = HANZI_DB.find(x => x.char === ex.answer);
    if (c && knownSet.has(c.id)) await updateSRS(c.id, q);
  }
  bankIdx++;
  setTimeout(() => nextReviewExercise(), 1800);
}

// ── Esercizio C: Build (ricostruisci la frase) ──
function renderBuildExercise(ex) {
  buildAnswer = [];
  const shuffled = [...(ex.words || [])].sort(() => Math.random() - 0.5);
  const chipsHtml = shuffled.map((w, i) =>
    `<button class="chip-btn" id="chip-${i}" onclick="selectChip(this,'${w}')">${w}</button>`
  ).join('');
  const encodedSentence = encodeURIComponent(ex.sentence || '');
  const wrap = document.getElementById('review-session');
  wrap.innerHTML = progressHTML() + `
    <div class="exercise-card">
      <div class="exercise-type">Ricostruisci la frase</div>
      <div class="build-prompt">${ex.translation_it}</div>
      <div class="build-answer-row" id="build-answer-row"><span class="build-placeholder">Tocca i caratteri →</span></div>
      <div class="build-chips" id="build-chips">${chipsHtml}</div>
      <div class="answer-reveal" id="ex-reveal" style="display:none">
        <div class="label">Risposta corretta:</div>
        <div class="value">${ex.sentence || ''} (${ex.pinyin || ''})</div>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" id="build-check-btn" onclick="checkBuild('${encodedSentence}')">Controlla</button>
    </div>`;
}

function selectChip(btn, word) {
  if (btn.classList.contains('used')) {
    const idx = buildAnswer.lastIndexOf(word);
    if (idx !== -1) buildAnswer.splice(idx, 1);
    btn.classList.remove('used');
  } else {
    buildAnswer.push(word);
    btn.classList.add('used');
  }
  const row = document.getElementById('build-answer-row');
  if (buildAnswer.length === 0) {
    row.innerHTML = '<span class="build-placeholder">Tocca i caratteri →</span>';
  } else {
    row.innerHTML = buildAnswer.map(w => `<span class="build-token">${w}</span>`).join('');
  }
}

async function checkBuild(encodedSentence) {
  const correct = decodeURIComponent(encodedSentence);
  const given   = buildAnswer.join('');
  const ok      = given === correct;
  const revEl   = document.getElementById('ex-reveal');
  revEl.style.display = 'block';
  revEl.classList.add('visible');
  document.getElementById('build-check-btn').style.display = 'none';
  showToast(ok ? '✓ Perfetto!' : '✗ Non corretto');
  const q = ok ? 5 : 1;
  const ex = exerciseBank[bankIdx];
  if (ex && ex.sentence) {
    for (const ch of [...ex.sentence]) {
      const c = HANZI_DB.find(x => x.char === ch);
      if (c && knownSet.has(c.id)) await updateSRS(c.id, q);
    }
  }
  bankIdx++;
  setTimeout(() => nextReviewExercise(), 2000);
}

// ── Esercizio D: Scoperta carattere ──
function renderDiscoverCard(ex) {
  const wrap = document.getElementById('review-session');
  wrap.innerHTML = progressHTML() + `
    <div class="exercise-card">
      <div class="exercise-type">Scopri un nuovo carattere</div>
      <div class="discover-char">${ex.char}</div>
      <div class="discover-pinyin">${ex.pinyin}</div>
      <div class="discover-meaning">${ex.meaning_it}</div>
      <div class="example-sentence-box" style="margin-top:12px">
        <div class="sentence">${ex.example_sentence}</div>
        <div class="pinyin">${ex.example_pinyin}</div>
        <div class="translation">${ex.example_translation_it}</div>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:16px" onclick="rateBank(3)">Continua →</button>
    </div>`;
}

// ── Esercizio E: Pinyin locale (fallback, no AI) ──
function renderPinyinLocal(ex) {
  const py = escapePy(ex.pinyin || '');
  const id = ex.id || 0;
  const wrap = document.getElementById('review-session');
  wrap.innerHTML = progressHTML() + `
    <div class="exercise-card">
      <div class="exercise-type">Scrivi il Pinyin</div>
      <div class="char-study">${ex.char}</div>
      <input type="text" class="answer-input" id="ex-pinyin-input" placeholder="es. nǐ" autocomplete="off"
        onkeydown="if(event.key==='Enter')checkPinyinLocal('${py}',${id})">
      <div class="answer-reveal" id="ex-reveal">
        <div class="label">Pinyin corretto:</div>
        <div class="value">${ex.pinyin || ''} — ${ex.meaning_it || ''}</div>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="checkPinyinLocal('${py}',${id})">Controlla</button>
      <div class="rating-row" id="ex-rating" style="display:none">
        <button class="rating-btn" onclick="rateBank(1)">😕</button>
        <button class="rating-btn" onclick="rateBank(3)">🤔</button>
        <button class="rating-btn" onclick="rateBank(5)">😊</button>
      </div>
    </div>`;
}

function checkPinyinLocal(correct, id) {
  const input = document.getElementById('ex-pinyin-input').value.trim();
  const ok    = normalizePinyin(input) === normalizePinyin(correct);
  document.getElementById('ex-reveal').classList.add('visible');
  document.querySelector('#review-session .btn.btn-primary').style.display = 'none';
  document.getElementById('ex-rating').style.display = 'flex';
  if (ok) showToast('✓ Corretto!');
}

function showReviewComplete() {
  document.getElementById('review-session').innerHTML = `
    <div class="empty-state" style="padding:40px 20px">
      <div class="es-icon">🎉</div>
      <h3>Ripasso completato!</h3>
      <p style="margin:12px 0">Hai completato ${reviewTotal} esercizi.</p>
      <button class="btn btn-primary" style="margin-top:16px" onclick="renderReviewStart()">Torna al Ripasso</button>
    </div>`;
  updateStats();
}

// ══════════════════════════════════════════════════
// 8. NUOVI CARATTERI
// ══════════════════════════════════════════════════
let learnChars = [], learnPhase = 'present', learnIdx = 0, learnExIdx = 0;
let learnResults = {};
let learnCurrentExample = null;

function getNewChars(count) {
  const knownChars = new Set(HANZI_DB.filter(c => knownSet.has(c.id)).map(c => c.char));
  return HANZI_DB
    .filter(c => !knownSet.has(c.id))
    .sort((a, b) => a.hsk - b.hsk || a.id - b.id)
    .slice(0, count);
}

async function renderLearnStart() {
  const hasKey = !!(await getSetting('gemini_api_key', ''));
  document.getElementById('learn-start').style.display = '';
  document.getElementById('learn-session').style.display = 'none';

  if (!hasKey) {
    document.getElementById('learn-no-api').classList.remove('hidden');
    document.getElementById('learn-ready').style.display = 'none';
    return;
  }
  document.getElementById('learn-no-api').classList.add('hidden');
  document.getElementById('learn-ready').style.display = '';

  const newCount = HANZI_DB.filter(c => !knownSet.has(c.id)).length;
  document.getElementById('learn-new-count').textContent = newCount;
}

async function startLearn() {
  const count = +document.getElementById('learn-count-slider').value || 7;
  learnChars  = getNewChars(count);
  learnIdx    = 0;
  learnExIdx  = 0;
  learnPhase  = 'present';
  learnResults = {};
  learnCurrentExample = null;

  document.getElementById('learn-start').style.display   = 'none';
  document.getElementById('learn-session').style.display = '';

  await renderLearnPresent();
}

async function renderLearnPresent() {
  if (learnIdx >= learnChars.length) {
    learnPhase = 'exercise';
    learnExIdx = 0;
    await renderLearnExercise();
    return;
  }
  const c = learnChars[learnIdx];
  const knownChars = HANZI_DB.filter(x => knownSet.has(x.id));

  showSpinner(true);
  let example = { sentence: '—', pinyin: '', translation_it: '' };
  try { example = await generateExampleSentence(c, knownChars); } catch(_) {}
  showSpinner(false);

  learnCurrentExample = example;

  const wrap = document.getElementById('learn-session');
  wrap.innerHTML = `
    <div class="exercise-progress">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${Math.round((learnIdx/learnChars.length)*100)}%"></div>
      </div>
      <div class="progress-text">${learnIdx+1}/${learnChars.length}</div>
    </div>
    <div class="exercise-card">
      <div class="exercise-type">Nuovo carattere</div>
      <div class="new-char-presentation">
        <div class="new-char-big">${c.char}</div>
        <div class="new-char-pinyin">${c.pinyin}</div>
        <div class="new-char-meaning">${c.it}</div>
        <div style="font-size:12px;color:var(--text2)">HSK ${c.hsk}</div>
      </div>
      <div class="example-sentence-box">
        <div class="label">Frase d'esempio:</div>
        <div class="sentence">${example.sentence}</div>
        ${example.pinyin ? `<div class="pinyin">${example.pinyin}</div>` : ''}
        <div class="translation">${example.translation_it}</div>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:8px" onclick="showLearnTest(${c.id})">
        Metti alla prova →
      </button>
    </div>`;
}

function showLearnTest(charId) {
  const c = learnChars.find(x => x.id === charId);
  if (!c) { learnNext(); return; }
  renderLearnTest(c);
}

function renderLearnTest(c) {
  const example = learnCurrentExample;
  const sentence = (example && example.sentence) || '';
  const useBlank = sentence.includes(c.char) && sentence !== '—';

  // 3 distractors from learnChars + knownChars
  const pool = [...learnChars, ...HANZI_DB.filter(x => knownSet.has(x.id))]
    .filter(x => x.id !== c.id && x.char !== c.char)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);
  const options = [c, ...pool].sort(() => Math.random() - 0.5);

  const choicesHtml = options.map(opt =>
    `<button class="choice-btn" onclick="checkLearnTest(this,'${opt.char}','${c.char}',${c.id})">${opt.char}</button>`
  ).join('');

  let questionHtml = '';
  if (useBlank) {
    const blank = sentence.replace(c.char, '<span class="blank-slot">___</span>');
    questionHtml = `
      <div class="learn-test-label">Quale carattere manca?</div>
      <div class="sentence-blank">${blank}</div>
      <div style="font-size:13px;color:var(--text2);text-align:center;margin-bottom:12px">${example.translation_it}</div>`;
  } else {
    questionHtml = `
      <div class="learn-test-label">Quale carattere significa:</div>
      <div class="learn-test-meaning">${c.it}</div>`;
  }

  const wrap = document.getElementById('learn-session');
  wrap.innerHTML = `
    <div class="exercise-progress">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${Math.round((learnIdx/learnChars.length)*100)}%"></div>
      </div>
      <div class="progress-text">${learnIdx+1}/${learnChars.length}</div>
    </div>
    <div class="exercise-card">
      <div class="exercise-type">Metti alla prova</div>
      ${questionHtml}
      <div class="choices-grid" id="lt-choices">${choicesHtml}</div>
      <div class="answer-reveal" id="lt-reveal" style="display:none">
        <div class="label">Carattere corretto:</div>
        <div class="value">${c.char} — ${c.pinyin} — ${c.it}</div>
      </div>
      <div id="lt-next" style="display:none;margin-top:12px">
        <button class="btn btn-primary btn-full" onclick="learnNext()">
          ${learnIdx < learnChars.length - 1 ? 'Prossimo →' : 'Inizia esercizi →'}
        </button>
      </div>
    </div>`;
}

async function checkLearnTest(btn, chosen, correct, charId) {
  document.querySelectorAll('#lt-choices .choice-btn').forEach(b => b.classList.add('disabled'));
  const ok = chosen === correct;
  if (ok) {
    btn.classList.add('correct');
    await markKnown(charId, true);
    showToast('✓ Carattere acquisito!');
  } else {
    btn.classList.add('wrong');
    document.querySelectorAll('#lt-choices .choice-btn').forEach(b => {
      if (b.textContent === correct) b.classList.add('correct');
    });
    showToast('✗ Riprova al prossimo ripasso');
  }
  const revEl = document.getElementById('lt-reveal');
  if (revEl) { revEl.style.display = 'block'; revEl.classList.add('visible'); }
  const nextEl = document.getElementById('lt-next');
  if (nextEl) nextEl.style.display = 'block';
}

function learnNext() {
  learnIdx++;
  renderLearnPresent();
}

async function renderLearnExercise() {
  const allChars = [...HANZI_DB.filter(c => knownSet.has(c.id)), ...learnChars];
  const maxEx    = learnChars.length * 2;
  if (learnExIdx >= maxEx) { renderLearnSummary(); return; }

  const r = Math.random();
  showSpinner(true);
  try {
    if (r < 0.5) await renderLearnTranslate(allChars);
    else renderLearnPinyin(allChars);
  } catch(_) {
    renderLearnPinyin(allChars);
  } finally {
    showSpinner(false);
  }
}

async function renderLearnTranslate(allChars) {
  const data = await generateTranslationExercise(allChars);
  const wrap = document.getElementById('learn-session');
  const pct  = Math.round((learnExIdx / (learnChars.length * 2)) * 100);
  wrap.innerHTML = `
    <div class="exercise-progress">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="progress-text">Esercizi</div>
    </div>
    <div class="exercise-card">
      <div class="exercise-type">Traduzione</div>
      <div class="sentence-display">${data.sentence}</div>
      <div class="pinyin-display" id="ex-pinyin">${data.pinyin}</div>
      <button class="toggle-pinyin-btn" onclick="togglePinyin()">Mostra Pinyin</button>
      <textarea class="answer-input" id="ex-answer" rows="2" placeholder="Traduzione italiana…"></textarea>
      <div class="answer-reveal" id="ex-reveal">
        <div class="label">Risposta:</div>
        <div class="value">${data.translation_it}</div>
      </div>
      <button class="btn btn-primary btn-full" id="ex-check-btn" onclick="checkLearnTranslate()" style="margin-top:12px">Controlla</button>
      <div class="rating-row" id="ex-rating" style="display:none">
        <button class="rating-btn" onclick="learnRate(1)">😕</button>
        <button class="rating-btn" onclick="learnRate(3)">🤔</button>
        <button class="rating-btn" onclick="learnRate(5)">😊</button>
      </div>
    </div>`;
}

function checkLearnTranslate() {
  document.getElementById('ex-reveal').classList.add('visible');
  document.getElementById('ex-check-btn').style.display = 'none';
  document.getElementById('ex-rating').style.display    = 'flex';
}
async function learnRate(q) {
  learnExIdx++;
  await renderLearnExercise();
}

function renderLearnPinyin(allChars) {
  const c   = allChars[Math.floor(Math.random() * allChars.length)];
  const pct = Math.round((learnExIdx / (learnChars.length * 2)) * 100);
  const wrap = document.getElementById('learn-session');
  wrap.innerHTML = `
    <div class="exercise-progress">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="progress-text">Esercizi</div>
    </div>
    <div class="exercise-card">
      <div class="exercise-type">Pinyin</div>
      <div class="char-study">${c.char}</div>
      <input type="text" class="answer-input" id="ex-pinyin-input" placeholder="es. hǎo" autocomplete="off"
        onkeydown="if(event.key==='Enter')checkLearnPinyin('${escapePy(c.pinyin)}')">
      <div class="answer-reveal" id="ex-reveal">
        <div class="label">Risposta:</div>
        <div class="value">${c.pinyin} — ${c.it}</div>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="checkLearnPinyin('${escapePy(c.pinyin)}')">Controlla</button>
      <div class="rating-row" id="ex-rating" style="display:none">
        <button class="rating-btn" onclick="learnRate(1)">😕</button>
        <button class="rating-btn" onclick="learnRate(3)">🤔</button>
        <button class="rating-btn" onclick="learnRate(5)">😊</button>
      </div>
    </div>`;
}

function checkLearnPinyin(correct) {
  const input = document.getElementById('ex-pinyin-input')?.value.trim() || '';
  const ok    = normalizePinyin(input) === normalizePinyin(correct);
  document.getElementById('ex-reveal').classList.add('visible');
  document.querySelector('#learn-session .btn.btn-primary').style.display = 'none';
  document.getElementById('ex-rating').style.display = 'flex';
  if (ok) showToast('✓ Corretto!');
}

function renderLearnSummary() {
  const wrap = document.getElementById('learn-session');
  wrap.innerHTML = `
    <div class="screen-header">
      <h1>Sessione completata!</h1>
      <p>Seleziona i caratteri rimanenti da aggiungere ai noti:</p>
    </div>
    <ul class="summary-list">
      ${learnChars.map(c => `
        <li class="summary-item" id="sum-${c.id}">
          <div class="si-char">${c.char}</div>
          <div class="si-info">
            <div class="si-pinyin">${c.pinyin}</div>
            <div class="si-meaning">${c.it}</div>
          </div>
          <div class="si-action">
            ${knownSet.has(c.id)
              ? '<span class="si-known-badge">✓ Acquisito</span>'
              : `<button class="btn btn-success" onclick="addToKnown(${c.id})">✓ Noto</button>
                 <button class="btn btn-secondary" onclick="skipNew(${c.id})">↩ Dopo</button>`
            }
          </div>
        </li>
      `).join('')}
    </ul>
    <button class="btn btn-primary btn-full" style="margin-top:16px" onclick="finishLearn()">Fine</button>`;
}

async function addToKnown(id) {
  await markKnown(id, true);
  const el = document.getElementById(`sum-${id}`);
  if (el) {
    el.style.opacity = '.4';
    el.querySelectorAll('button').forEach(b => b.disabled = true);
  }
  showToast('Aggiunto ai noti ✓');
}
function skipNew(id) {
  const el = document.getElementById(`sum-${id}`);
  if (el) {
    el.style.opacity = '.4';
    el.querySelectorAll('button').forEach(b => b.disabled = true);
  }
}
function finishLearn() {
  renderLearnStart();
  updateStats();
}

// ══════════════════════════════════════════════════
// 9. IMPOSTAZIONI
// ══════════════════════════════════════════════════
async function renderSettings() {
  document.getElementById('set-api-key').value  = await getSetting('gemini_api_key', '');
  document.getElementById('set-model').value    = await getSetting('gemini_model', 'gemini-2.5-flash');
  const exCount = +(await getSetting('ex_count', '20'));
  const sl = document.getElementById('set-ex-count');
  sl.value = exCount;
  document.getElementById('set-ex-val').textContent = exCount;
}

async function saveSettings() {
  await setSetting('gemini_api_key', document.getElementById('set-api-key').value.trim());
  await setSetting('gemini_model',   document.getElementById('set-model').value);
  await setSetting('ex_count',       document.getElementById('set-ex-count').value);
  checkBanner();
  showToast('Impostazioni salvate ✓');
}

// ══════════════════════════════════════════════════
// 10. EXPORT / IMPORT
// ══════════════════════════════════════════════════
async function exportData() {
  const data = {
    version: 1,
    date: new Date().toISOString(),
    known:  await dbGetAll('known'),
    srs:    await dbGetAll('srs')
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `hanzi_progress_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Dati esportati ✓');
}

function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      await dbClear('known');
      await dbClear('srs');
      for (const r of (data.known || [])) await dbPut('known', r);
      for (const r of (data.srs   || [])) await dbPut('srs',   r);
      await loadState();
      renderLibrary();
      showToast('Dati importati ✓');
    } catch(err) {
      showToast('Errore importazione: ' + err.message);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function confirmReset() {
  if (!confirm('Sei sicuro di voler resettare tutti i progressi?')) return;
  if (!confirm('CONFERMA: cancellare tutti i caratteri noti e dati SRS?')) return;
  resetAll();
}
async function resetAll() {
  await dbClear('known');
  await dbClear('srs');
  await loadState();
  renderLibrary();
  showToast('Progressi resettati');
}

// ══════════════════════════════════════════════════
// 11. UTILITY
// ══════════════════════════════════════════════════
function addLongPress(el, cb, ms = 500) {
  let timer;
  el.addEventListener('touchstart', e => {
    timer = setTimeout(() => { e.preventDefault(); cb(); }, ms);
  }, { passive: false });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
    el.addEventListener(ev, () => clearTimeout(timer))
  );
}

function showSpinner(show) {
  document.getElementById('spinner').classList.toggle('show', show);
}

let toastTimer;
function showToast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function checkBanner() {
  const key = await getSetting('gemini_api_key', '');
  document.getElementById('banner').classList.toggle('hidden', !!key);
}

// ══════════════════════════════════════════════════
// 0. LOCK SCREEN
// ══════════════════════════════════════════════════
const PIN_KEY = 'hanziapp_pin_hash';
const PIN_REGEX = /^\d{6}[a-zA-Z]{3}$/;

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initLock() {
  const lockEl = document.getElementById('lock-screen');
  const stored = localStorage.getItem(PIN_KEY);
  if (!stored) {
    document.getElementById('lock-title').textContent = 'Imposta PIN';
    document.getElementById('lock-subtitle').textContent = '6 cifre + 3 lettere (es. 123456abc)';
  }
  lockEl.style.display = 'flex';
}

async function submitPin() {
  const val    = document.getElementById('pin-input').value.trim();
  const errEl  = document.getElementById('pin-error');
  const stored = localStorage.getItem(PIN_KEY);

  if (!PIN_REGEX.test(val)) {
    errEl.textContent = 'Formato: 6 cifre + 3 lettere (es. 123456abc)';
    errEl.classList.remove('hidden');
    return;
  }

  const hash = await sha256(val);

  if (!stored) {
    localStorage.setItem(PIN_KEY, hash);
    unlockApp();
    return;
  }

  if (hash === stored) {
    unlockApp();
  } else {
    errEl.textContent = 'PIN non corretto';
    errEl.classList.remove('hidden');
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-input').focus();
  }
}

function unlockApp() {
  document.getElementById('lock-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
  init();
}

function changePinFlow() {
  const newPin = prompt('Inserisci il nuovo PIN (6 cifre + 3 lettere, es. 123456abc):');
  if (!newPin) return;
  if (!PIN_REGEX.test(newPin)) {
    showToast('Formato non valido: 6 cifre + 3 lettere');
    return;
  }
  sha256(newPin).then(hash => {
    localStorage.setItem(PIN_KEY, hash);
    showToast('PIN aggiornato ✓');
  });
}

document.getElementById('pin-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitPin();
});

// ══════════════════════════════════════════════════
// 12. INIT
// ══════════════════════════════════════════════════
async function init() {
  await initDB();
  await loadSettings();
  await loadState();
  checkBanner();
  renderLibrary();

  // Registrazione Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('app').style.display = 'none';
  initLock();
});
