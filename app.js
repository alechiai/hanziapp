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
  const model = await getSetting('gemini_model', 'gemini-1.5-flash');
  if (!key) throw new Error('API Key non configurata');

  const cacheKey = prompt.slice(0, 80);
  if (geminiCache[cacheKey]) return geminiCache[cacheKey];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 400 }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
  const sample = knownChars.slice(0, 30).map(c => c.char).join('');
  const prompt = `Genera UNA frase in cinese mandarino semplificato usando principalmente questi caratteri: ${sample}
La frase deve essere naturale e di complessità media.
Rispondi SOLO con questo JSON valido (nessun altro testo):
{"sentence":"...","pinyin":"...","translation_it":"..."}`;
  const text = await callGemini(prompt);
  return parseJSON(text);
}

async function generateFillBlank(knownChars) {
  const sample = knownChars.slice(0, 20).map(c => c.char).join('');
  const target = knownChars[Math.floor(Math.random() * Math.min(knownChars.length, 15))];
  const prompt = `Genera UNA frase in cinese mandarino usando principalmente questi caratteri: ${sample}
Il carattere TARGET che deve essere rimosso dalla frase è: ${target.char}
Rispondi SOLO con questo JSON valido:
{"sentence_with_blank":"frase con ___ al posto del target","pinyin":"pinyin completo","answer":"${target.char}","translation_it":"traduzione italiana"}`;
  const text = await callGemini(prompt);
  const obj  = parseJSON(text);
  obj.targetId = target.id;
  return obj;
}

async function generateExampleSentence(newChar, knownChars) {
  const known20 = knownChars.slice(0, 20).map(c => c.char).join('');
  const prompt = `Crea UNA frase di esempio in cinese mandarino che usi il carattere "${newChar.char}" (${newChar.pinyin}, "${newChar.it}").
Usa anche alcuni di questi caratteri già noti se possibile: ${known20}
Rispondi SOLO con questo JSON valido:
{"sentence":"...","pinyin":"...","translation_it":"..."}`;
  const text = await callGemini(prompt);
  return parseJSON(text);
}

// ══════════════════════════════════════════════════
// 5. NAVIGAZIONE
// ══════════════════════════════════════════════════
function showScreen(name) {
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

  grid.innerHTML = data.map(c => `
    <div class="char-card ${knownSet.has(c.id) ? 'known' : ''}" onclick="openModal(${c.id})">
      ${knownSet.has(c.id) ? '<span class="known-badge">✓</span>' : ''}
      <span class="hsk-badge">HSK${c.hsk}</span>
      <div class="char-big">${c.char}</div>
      <div class="char-pinyin">${c.pinyin}</div>
      <div class="char-meaning">${c.it}</div>
    </div>
  `).join('');
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
let reviewQueue = [], reviewIdx = 0, reviewTotal = 0;

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

async function startReview() {
  const maxEx = +settingsCache['ex_count'] || 20;
  // Priorità: caratteri in scadenza, poi tutti i noti
  const dueIds  = getDueIds();
  const allKnown = [...knownSet];
  const pool = [...new Set([...dueIds, ...allKnown])].slice(0, maxEx * 3);

  reviewQueue = [];
  reviewIdx   = 0;
  reviewTotal = Math.min(maxEx, pool.length);

  document.getElementById('review-start').style.display = 'none';
  document.getElementById('review-session').style.display = '';

  await nextReviewExercise(pool);
}

async function nextReviewExercise(pool) {
  if (reviewIdx >= reviewTotal) {
    showReviewComplete();
    return;
  }

  const knownChars = HANZI_DB.filter(c => knownSet.has(c.id));
  const r = Math.random();
  let type = r < 0.4 ? 'translate' : r < 0.7 ? 'pinyin' : 'fill';
  // Fallback se pochi caratteri
  if (knownChars.length < 3) type = 'pinyin';

  showSpinner(true);
  try {
    if (type === 'translate') await renderTranslateExercise(knownChars);
    else if (type === 'pinyin') renderPinyinExercise(pool, knownChars);
    else await renderFillExercise(knownChars);
  } catch (e) {
    // Fallback a pinyin se Gemini fallisce
    renderPinyinExercise(pool, knownChars);
    showToast('AI non disponibile, esercizio alternativo');
  } finally {
    showSpinner(false);
  }
}

function progressHTML() {
  const pct = Math.round((reviewIdx / reviewTotal) * 100);
  return `
    <div class="exercise-progress">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="progress-text">${reviewIdx}/${reviewTotal}</div>
    </div>`;
}

// ── Esercizio A: Traduzione ──
async function renderTranslateExercise(knownChars) {
  const data = await generateTranslationExercise(knownChars);
  const wrap = document.getElementById('review-session');
  wrap.innerHTML = `
    ${progressHTML()}
    <div class="exercise-card">
      <div class="exercise-type">Traduzione frase</div>
      <div class="sentence-display">${data.sentence}</div>
      <div class="pinyin-display" id="ex-pinyin">${data.pinyin}</div>
      <button class="toggle-pinyin-btn" onclick="togglePinyin()">Mostra Pinyin</button>
      <textarea class="answer-input" id="ex-answer" rows="2" placeholder="Scrivi la traduzione in italiano…"></textarea>
      <div class="answer-reveal" id="ex-reveal">
        <div class="label">Traduzione corretta:</div>
        <div class="value">${data.translation_it}</div>
      </div>
      <button class="btn btn-primary btn-full" id="ex-check-btn" onclick="checkTranslate()" style="margin-top:12px">Controlla</button>
      <div class="rating-row" id="ex-rating" style="display:none">
        <button class="rating-btn" onclick="rateTranslate(1,'${encodeChars(data.sentence)}')">😕</button>
        <button class="rating-btn" onclick="rateTranslate(3,'${encodeChars(data.sentence)}')">🤔</button>
        <button class="rating-btn" onclick="rateTranslate(5,'${encodeChars(data.sentence)}')">😊</button>
      </div>
    </div>`;
}

function encodeChars(s) { return encodeURIComponent(s); }

function togglePinyin() {
  const el  = document.getElementById('ex-pinyin');
  const btn = document.querySelector('.toggle-pinyin-btn');
  el.classList.toggle('visible');
  btn.textContent = el.classList.contains('visible') ? 'Nascondi Pinyin' : 'Mostra Pinyin';
}
function checkTranslate() {
  document.getElementById('ex-reveal').classList.add('visible');
  document.getElementById('ex-check-btn').style.display = 'none';
  document.getElementById('ex-rating').style.display    = 'flex';
}
async function rateTranslate(q, encodedSentence) {
  // Aggiorna SRS per i caratteri della frase che sono noti
  const sentence = decodeURIComponent(encodedSentence);
  const chars = [...sentence].filter(ch => {
    const c = HANZI_DB.find(x => x.char === ch);
    return c && knownSet.has(c.id);
  });
  for (const ch of chars) {
    const c = HANZI_DB.find(x => x.char === ch);
    if (c) await updateSRS(c.id, q);
  }
  reviewIdx++;
  const knownChars = HANZI_DB.filter(c => knownSet.has(c.id));
  await nextReviewExercise([...knownSet]);
}

// ── Esercizio B: Pinyin ──
function renderPinyinExercise(pool, knownChars) {
  const id = pool[reviewIdx % pool.length];
  const c  = HANZI_DB.find(x => x.id === id);
  if (!c) { reviewIdx++; nextReviewExercise(pool); return; }

  const wrap = document.getElementById('review-session');
  wrap.innerHTML = `
    ${progressHTML()}
    <div class="exercise-card">
      <div class="exercise-type">Scrivi il Pinyin</div>
      <div class="char-study">${c.char}</div>
      <input type="text" class="answer-input" id="ex-pinyin-input" placeholder="es. nǐ" autocomplete="off"
        onkeydown="if(event.key==='Enter')checkPinyin(${c.id},'${escapePy(c.pinyin)}')">
      <div class="answer-reveal" id="ex-reveal">
        <div class="label">Pinyin corretto:</div>
        <div class="value">${c.pinyin} — ${c.it}</div>
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="checkPinyin(${c.id},'${escapePy(c.pinyin)}')">Controlla</button>
      <div class="rating-row" id="ex-rating" style="display:none">
        <button class="rating-btn" onclick="ratePinyin(${c.id},1)">😕</button>
        <button class="rating-btn" onclick="ratePinyin(${c.id},3)">🤔</button>
        <button class="rating-btn" onclick="ratePinyin(${c.id},5)">😊</button>
      </div>
    </div>`;
}

function escapePy(s) { return s.replace(/'/g, "\\'"); }

function normalizePinyin(s) {
  return s.toLowerCase()
    .replace(/[āáǎà]/g,'a').replace(/[ēéěè]/g,'e').replace(/[īíǐì]/g,'i')
    .replace(/[ōóǒò]/g,'o').replace(/[ūúǔù]/g,'u').replace(/[ǖǘǚǜü]/g,'u')
    .replace(/\s+/g,'');
}

async function checkPinyin(id, correct) {
  const input = document.getElementById('ex-pinyin-input').value.trim();
  const ok    = normalizePinyin(input) === normalizePinyin(correct);
  document.getElementById('ex-reveal').classList.add('visible');
  document.querySelector(`#review-session .btn.btn-primary`).style.display = 'none';
  document.getElementById('ex-rating').style.display = 'flex';
  if (ok) showToast('✓ Corretto!');
}
async function ratePinyin(id, q) {
  await updateSRS(id, q);
  reviewIdx++;
  await nextReviewExercise([...knownSet]);
}

// ── Esercizio C: Fill-in-the-blank ──
async function renderFillExercise(knownChars) {
  if (knownChars.length < 4) { renderPinyinExercise([...knownSet], knownChars); return; }
  const data    = await generateFillBlank(knownChars);
  const correct = data.answer;
  // 3 distrattori
  const pool3 = knownChars.filter(c => c.char !== correct).sort(() => Math.random() - .5).slice(0, 3);
  const options = [correct, ...pool3.map(c => c.char)].sort(() => Math.random() - .5);

  const wrap = document.getElementById('review-session');
  wrap.innerHTML = `
    ${progressHTML()}
    <div class="exercise-card">
      <div class="exercise-type">Completa la frase</div>
      <div class="sentence-blank">${data.sentence_with_blank.replace('___','<span class="blank-slot">___</span>')}</div>
      <div style="font-size:13px;color:var(--text2);text-align:center;margin-bottom:12px">${data.pinyin}</div>
      <div class="choices-grid" id="choices-grid">
        ${options.map(ch => `
          <button class="choice-btn" onclick="checkFill(this,'${ch}','${correct}',${data.targetId||0})">${ch}</button>
        `).join('')}
      </div>
      <div class="answer-reveal" id="ex-reveal" style="display:none">
        <div class="label">Traduzione:</div>
        <div class="value">${data.translation_it}</div>
      </div>
    </div>`;
}

async function checkFill(btn, chosen, correct, targetId) {
  document.querySelectorAll('.choice-btn').forEach(b => b.classList.add('disabled'));
  if (chosen === correct) {
    btn.classList.add('correct');
    showToast('✓ Corretto!');
  } else {
    btn.classList.add('wrong');
    document.querySelectorAll('.choice-btn').forEach(b => {
      if (b.textContent === correct) b.classList.add('correct');
    });
    showToast('✗ Sbagliato');
  }
  document.getElementById('ex-reveal').style.display = 'block';
  document.getElementById('ex-reveal').classList.add('visible');

  const q = chosen === correct ? 5 : 1;
  if (targetId) await updateSRS(targetId, q);
  reviewIdx++;
  setTimeout(() => nextReviewExercise([...knownSet]), 1800);
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
      <button class="btn btn-primary btn-full" style="margin-top:8px" onclick="learnNext()">
        ${learnIdx < learnChars.length - 1 ? 'Prossimo →' : 'Inizia esercizi →'}
      </button>
    </div>`;
}

function learnNext() {
  learnIdx++;
  renderLearnPresent();
}

async function renderLearnExercise() {
  const allChars   = [...HANZI_DB.filter(c => knownSet.has(c.id)), ...learnChars];
  const maxEx      = learnChars.length * 2;
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
      <p>Seleziona i caratteri da aggiungere ai tuoi noti:</p>
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
            <button class="btn btn-success" onclick="addToKnown(${c.id})">✓ Noto</button>
            <button class="btn btn-secondary" onclick="skipNew(${c.id})">↩ Dopo</button>
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
  document.getElementById('set-model').value    = await getSetting('gemini_model', 'gemini-1.5-flash');
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

init();
