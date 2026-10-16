'use strict';
// 밸런스 조정: 관리자가 화면에서 content/*.json 의 숫자(와 주사위·난이도)를 바꾸면
// 검증 → 즉시 반영(서버 재시작 없음) → DATA_DIR/balance.json 에 이력과 함께 저장합니다.
// content 파일 자체는 건드리지 않아요. 새 버전 코드(zip)로 덮어써도 조정값은 data 폴더에 남아 다시 적용됩니다.
const fs = require('fs');
const path = require('path');

const HISTORY_MAX = 50;
const DOC_NAMES = { rules: '게임 규칙', quests: '의뢰', economy: '경제·장터' };
const DICE = /^(\d*)d(\d+)$/;

// 화면에 보여줄 한국어 이름 (없는 키는 그대로 표시)
const KEY_LABELS = {
  classes: '클래스', base: '기본 능력치', str: '힘', dex: '민첩', int: '지능', cha: '매력',
  weapon: '무기 주사위', skill: '스킬', cooldown: '쿨타임(라운드)', dice: '주사위',
  statCap: '능력치 최대 보너스', level: '레벨', max: '최대', xp: '경험치', hpBase: '기본 HP', hpPerLevel: '레벨당 HP',
  difficulty: '난이도', dc: '목표값(DC)', combat: '전투', baseAc: '기본 방어도', defendAc: '방어 태세 방어도',
  guardAc: '적 방어 태세 방어도', shieldReduce: '방패막기 피해 감소', backstabBonus: '급소 찌르기 명중 보너스',
  critMultiplier: '치명타 배율', investigation: '조사', maxActions: '조사 행동 횟수', alertLimit: '경계도 한계',
  round: '라운드', deadlineSec: '제한 시간(초)', minSec: '최소 대기(초)', cheer: '응원', perCheer: '응원 1회 보너스',
  maxPerTarget: '1명당 응원 최대', repeatXpRatio: '반복 클리어 경험치 비율',
  recommendedLevel: '권장 레벨', reward: '보상', gold: '골드', items: '아이템', qty: '수량',
  choices: '선택지', success: '성공 시', effect: '효과', value: '값', enemies: '적', hp: 'HP', ac: '방어도',
  attackBonus: '명중 보너스', intents: '행동 패턴', bonus: '추가값',
  settings: '기본 설정', startGold: '시작 골드', staminaMax: '최대 체력', staminaRegenMin: '체력 1 회복(분)',
  announceRarity: '소식에 올릴 최소 등급', giftMaxGold: '선물 골드 최대',
  attack: '명중', spots: '채집', minLevel: '최소 레벨', cost: '체력 소모', nothing: '꽝', weight: '확률 가중치',
  drops: '나오는 것', recipes: '제작', inputs: '재료', jars: '도박항아리', price: '가격', prizes: '상품',
  party: '파티·레이드', hpScalePerPlayer: '1명 늘 때 적 HP 증가 비율', koXpRatio: '전투불능 시 경험치 비율',
  minPlayers: '최소 인원', maxPlayers: '최대 인원', phase2: '2페이즈', at: '시작 HP 비율',
};
// 이 값들은 0(또는 1) 미만으로 내릴 수 없어요
const MIN_BY_KEY = { hp: 1, maxActions: 1, alertLimit: 1, max: 1, price: 1, critMultiplier: 1 };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (o) => JSON.parse(JSON.stringify(o));
const nameOf = (v) => (isObj(v) ? v.name || v.title || v.label || '' : '');

// 배열 원소는 id 가 있으면 id 로, 없으면 순번으로 가리킵니다 (원소 순서가 바뀌어도 id 로 찾아감)
function segOf(arr, i) {
  const el = arr[i];
  if (isObj(el) && typeof el.id === 'string' && el.id && arr.filter((x) => isObj(x) && x.id === el.id).length === 1) return el.id;
  return String(i);
}
function child(node, seg) {
  if (Array.isArray(node)) {
    const byId = node.find((x) => isObj(x) && x.id === seg);
    if (byId) return { ok: true, value: byId, key: node.indexOf(byId) };
    if (/^\d+$/.test(seg) && Number(seg) < node.length) return { ok: true, value: node[Number(seg)], key: Number(seg) };
    return { ok: false };
  }
  if (isObj(node) && Object.prototype.hasOwnProperty.call(node, seg)) return { ok: true, value: node[seg], key: seg };
  return { ok: false };
}
function resolve(root, segs) {
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const c = child(node, segs[i]);
    if (!c.ok) return null;
    node = c.value;
  }
  const last = child(node, segs[segs.length - 1]);
  return last.ok ? { parent: node, key: last.key, value: last.value } : null;
}

// 조정할 수 있는 칸 목록: 숫자, 주사위(d6 등), 조사 선택지 난이도
function collectFields(doc, docName, rules, itemNames = {}) {
  const out = [];
  const diffKeys = Object.keys((rules && rules.difficulty) || {});
  const elemName = (v) => nameOf(v) || (isObj(v) && (itemNames[v.item] || itemNames[v.id] || v.item || v.id)) ||
    (isObj(v) && v.gold !== undefined ? '골드' : '');
  const walk = (node, segs, labels) => {
    const entries = Array.isArray(node) ? node.map((v, i) => [segOf(node, i), v, i]) : Object.entries(node).map(([k, v]) => [k, v, k]);
    for (const [seg, v, rawKey] of entries) {
      if (typeof rawKey === 'string' && rawKey.startsWith('_')) continue;
      let label;
      const parentKey = segs[segs.length - 1];
      if (Array.isArray(node) && node.length === 2 && (parentKey === 'qty' || parentKey === 'gold')) label = rawKey === 0 ? '최소' : '최대';
      else if (Array.isArray(node)) label = elemName(v) || `${Number(rawKey) + 1}번`;
      else if (rawKey === 'value' && segs[0] === 'items') label = '판매가';
      else if (rawKey === 'bonus') label = segs.includes('intents') ? '추가 피해' : '장비 보너스';
      else if (KEY_LABELS[rawKey]) label = nameOf(v) ? `${KEY_LABELS[rawKey]} · ${nameOf(v)}` : KEY_LABELS[rawKey];
      else label = nameOf(v) || itemNames[rawKey] || rawKey;
      const s2 = [...segs, seg];
      const l2 = [...labels, label];
      if (isObj(v) || Array.isArray(v)) { walk(v, s2, l2); continue; }
      let kind = null; let options;
      if (typeof v === 'number') kind = 'number';
      else if (typeof v === 'string' && DICE.test(v)) kind = 'dice';
      else if (rawKey === 'difficulty' && diffKeys.includes(v)) { kind = 'choice'; options = diffKeys; }
      if (!kind) continue;
      out.push({ key: `${docName}:${s2.join('/')}`, doc: docName, segs: s2, labels: l2, value: v, kind, options, field: String(rawKey),
        optionLabels: options && Object.fromEntries(options.map((o) => [o, rules.difficulty[o].label || o])) });
    }
  };
  walk(doc, [], []);
  // 묶음(화면의 접는 단위): 의뢰는 의뢰별, 나머지는 최상위 항목(목록이면 원소별)
  for (const f of out) {
    const ls = docName === 'quests' ? f.labels.slice(1) : f.labels;
    let gn = 1;
    if (docName !== 'quests') {
      const top = doc[f.segs[0]];
      if (Array.isArray(top) || (isObj(top) && Object.values(top).every((x) => isObj(x)) && f.segs.length > 2)) gn = 2;
    }
    if (ls.length === 1) { f.group = `${DOC_NAMES[docName]} › 기본`; f.label = ls[0]; continue; }
    f.group = `${DOC_NAMES[docName]} › ${ls.slice(0, gn).join(' › ')}`;
    f.label = ls.slice(gn).join(' › ') || ls[ls.length - 1];
  }
  return out;
}

function parseValue(f, raw) {
  const minOf = MIN_BY_KEY[f.field];
  if (f.kind === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (String(raw).trim() === '' || !Number.isFinite(n)) return { error: '숫자를 입력하세요.' };
    if (Math.abs(n) > 1000000) return { error: '너무 큰 숫자예요.' };
    if (Number.isInteger(f.base) && !Number.isInteger(n) && f.field !== 'weight' && f.field !== 'repeatXpRatio') return { error: '정수로 입력하세요.' };
    if (f.base >= 0 && n < 0) return { error: '음수로 바꿀 수 없어요.' };
    if (minOf !== undefined && n < minOf) return { error: `${minOf} 이상이어야 해요.` };
    return { value: n };
  }
  if (f.kind === 'dice') {
    const s = String(raw).trim().toLowerCase();
    const m = DICE.exec(s);
    if (!m) return { error: 'd6, 2d4 같은 주사위 표기로 입력하세요.' };
    const cnt = m[1] ? Number(m[1]) : 1; const sides = Number(m[2]);
    if (cnt < 1 || cnt > 20 || sides < 2 || sides > 100) return { error: '주사위는 1~20개, 2~100면까지만 돼요.' };
    return { value: s };
  }
  if (f.kind === 'choice') {
    if (!f.options.includes(raw)) return { error: `${f.options.join('/')} 중에서 고르세요.` };
    return { value: raw };
  }
  return { error: '바꿀 수 없는 칸이에요.' };
}

/**
 * opts.base:  { rules, quests, economy } 원본(content 파일) — 바뀌지 않음
 * opts.live:  { rules, quests, economy } 서버가 실제로 쓰는 객체 — 값만 제자리에서 바뀜 (참조 유지)
 * opts.validate(docs): 오류면 throw (한국어 메시지)
 * opts.onApply(): 반영 직후 호출 (파생 설정 갱신용)
 */
function createBalance({ dataDir, base, live, validate, onApply = () => {}, now = Date.now, log = console }) {
  const file = path.join(dataDir, 'balance.json');
  const baseDocs = clone(base);
  let state = { overrides: {}, history: [] };
  let warnings = [];

  const fieldsOf = (docs) => {
    const names = Object.fromEntries(Object.entries((docs.economy && docs.economy.items) || {}).map(([id, it]) => [id, it.name]));
    return [
      ...collectFields(docs.rules, 'rules', docs.rules, names),
      ...collectFields(docs.quests, 'quests', docs.rules, names),
      ...collectFields(docs.economy, 'economy', docs.rules, names),
    ];
  };
  const baseFields = fieldsOf(baseDocs);
  const baseByKey = new Map(baseFields.map((f) => [f.key, { ...f, base: f.value }]));

  function build(overrides) {
    const docs = clone(baseDocs);
    const skipped = [];
    for (const [key, v] of Object.entries(overrides)) {
      const f = baseByKey.get(key);
      const r = f && resolve(docs[f.doc], f.segs);
      if (!r) { skipped.push(key); continue; }
      r.parent[r.key] = v;
    }
    return { docs, skipped };
  }
  // 바뀐 값만 live 객체에 덮어씀 (구조는 그대로라 다른 모듈이 쥔 참조가 계속 유효)
  function pushLive(docs) {
    for (const f of baseFields) {
      const src = resolve(docs[f.doc], f.segs);
      const dst = resolve(live[f.doc], f.segs);
      if (src && dst) dst.parent[dst.key] = src.value;
    }
    onApply();
  }
  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, file);
  }

  // 서버 시작 시: 저장된 조정값을 다시 적용 (맞지 않으면 경고만 남기고 원본으로 시작)
  function init() {
    warnings = [];
    if (fs.existsSync(file)) {
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        warnings.push(`balance.json 을 읽지 못해 조정값 없이 시작했어요: ${e.message}`);
        state = { overrides: {}, history: [] };
      }
      state.overrides = state.overrides || {};
      state.history = state.history || [];
    }
    const { docs, skipped } = build(state.overrides);
    if (skipped.length) warnings.push(`콘텐츠에서 사라진 항목이라 적용하지 못한 조정값: ${skipped.join(', ')}`);
    try { validate(docs); } catch (e) {
      warnings.push(`저장된 조정값이 지금 콘텐츠와 맞지 않아 적용하지 않았어요.\n${e.message}`);
      warnings.forEach((w) => log.warn('[밸런스] ' + w));
      return;
    }
    pushLive(docs);
    const n = Object.keys(state.overrides).length - skipped.length;
    if (n > 0) log.log(`[밸런스] 관리자 조정값 ${n}개 적용`);
    warnings.forEach((w) => log.warn('[밸런스] ' + w));
  }

  function view() {
    const fields = baseFields.map((f) => {
      const has = Object.prototype.hasOwnProperty.call(state.overrides, f.key);
      return { key: f.key, group: f.group, label: f.label, kind: f.kind, options: f.options, optionLabels: f.optionLabels,
        base: f.value, value: has ? state.overrides[f.key] : f.value, changed: has };
    });
    const history = state.history.slice().reverse().map((h) => ({
      id: h.id, at: h.at, by: h.by, note: h.note, changes: h.changes,
    }));
    return { fields, history, warnings };
  }

  // 새 조정값 후보를 검증하고 통과하면 반영·저장
  function commit(next, entry) {
    const { docs } = build(next);
    validate(docs); // 실패하면 throw → 아무것도 안 바뀜
    const changes = [];
    for (const f of baseFields) {
      const before = Object.prototype.hasOwnProperty.call(state.overrides, f.key) ? state.overrides[f.key] : f.value;
      const after = Object.prototype.hasOwnProperty.call(next, f.key) ? next[f.key] : f.value;
      if (before !== after) changes.push({ key: f.key, label: `${f.group} › ${f.label}`, from: before, to: after });
    }
    if (!changes.length) return { changed: 0 };
    const id = (state.history.length ? state.history[state.history.length - 1].id : 0) + 1;
    state.history.push({ id, at: now(), ...entry, changes, before: state.overrides, overrides: next });
    if (state.history.length > HISTORY_MAX) state.history = state.history.slice(-HISTORY_MAX);
    state.overrides = next;
    save();
    pushLive(docs);
    warnings = [];
    return { changed: changes.length };
  }

  function update(changes, { by = '', note = '' } = {}) {
    if (!isObj(changes) || !Object.keys(changes).length) throw new Error('바꿀 값이 없어요.');
    const next = { ...state.overrides };
    const errs = [];
    for (const [key, raw] of Object.entries(changes)) {
      const f = baseByKey.get(key);
      if (!f) { errs.push(`알 수 없는 항목: ${key}`); continue; }
      const p = parseValue(f, raw);
      if (p.error) { errs.push(`${f.group} › ${f.label}: ${p.error}`); continue; }
      if (p.value === f.base) delete next[key]; else next[key] = p.value;
    }
    if (errs.length) throw new Error(errs.join('\n'));
    return commit(next, { by, note: String(note || '').slice(0, 100) });
  }
  function revert(versionId, { by = '' } = {}) {
    const h = state.history.find((x) => x.id === Number(versionId));
    if (!h) throw new Error('그 기록을 찾을 수 없어요.');
    // 기록 #N 이 저장된 직후의 상태로 돌아감
    return commit({ ...h.overrides }, { by, note: `#${h.id} 시점으로 되돌림` });
  }
  function revertBefore(versionId, { by = '' } = {}) {
    const h = state.history.find((x) => x.id === Number(versionId));
    if (!h) throw new Error('그 기록을 찾을 수 없어요.');
    // 기록 #N 이 저장되기 직전 상태로 돌아감
    return commit({ ...(h.before || {}) }, { by, note: `#${h.id} 이전으로 되돌림` });
  }
  function reset({ by = '' } = {}) { return commit({}, { by, note: '모두 기본값으로' }); }
  function effective() { return build(state.overrides).docs; }

  return { init, view, update, revert, revertBefore, reset, effective, file };
}

module.exports = { createBalance, collectFields, parseValue };
