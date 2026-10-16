'use strict';
// 경제 규칙: 채집/제작/항아리 굴림과 검증. DB 를 모르는 순수 함수라 테스트와 시뮬레이션에 그대로 씁니다.
const { STATS, rollDie } = require('./engine');

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic'];
const ITEM_TYPES = ['junk', 'material', 'equipment'];
const BONUS_KEYS = ['attack', 'ac', 'hp'];

function validateEconomy(eco, rules, questsDoc) {
  const errs = [];
  const bad = (m) => errs.push(m);
  const st = eco.settings || {};
  for (const k of ['startGold', 'staminaMax', 'staminaRegenMin', 'giftMaxGold']) if (!Number.isInteger(st[k]) || st[k] < 0) bad(`settings.${k} 는 0 이상의 정수여야 합니다.`);
  if (!(st.staminaMax > 0) || !(st.staminaRegenMin > 0)) bad('settings.staminaMax / staminaRegenMin 은 1 이상이어야 합니다.');
  const rar = eco.rarities || {};
  if (!RARITY_ORDER.every((r) => typeof rar[r] === 'string')) bad(`rarities 에 ${RARITY_ORDER.join('/')} 이름이 모두 있어야 합니다.`);
  if (!RARITY_ORDER.includes(st.announceRarity)) bad(`settings.announceRarity 는 ${RARITY_ORDER.join('/')} 중 하나여야 합니다.`);
  const slots = eco.slots || {};
  if (!Object.keys(slots).length) bad('slots 가 비어 있습니다.');

  const items = eco.items || {};
  for (const [id, it] of Object.entries(items)) {
    if (!/^[a-z0-9-]+$/.test(id)) bad(`아이템 id "${id}" 는 영문 소문자/숫자/하이픈이어야 합니다.`);
    if (typeof it.name !== 'string' || !it.name) bad(`아이템 ${id}: name 이 없습니다.`);
    if (!ITEM_TYPES.includes(it.type)) bad(`아이템 ${id}: type 은 ${ITEM_TYPES.join('/')} 중 하나여야 합니다.`);
    if (!RARITY_ORDER.includes(it.rarity)) bad(`아이템 ${id}: rarity 는 ${RARITY_ORDER.join('/')} 중 하나여야 합니다.`);
    if (!Number.isInteger(it.value) || it.value < 0) bad(`아이템 ${id}: value(판매가)는 0 이상의 정수여야 합니다.`);
    if (it.type === 'equipment') {
      if (!slots[it.slot]) bad(`아이템 ${id}: slot 은 ${Object.keys(slots).join('/')} 중 하나여야 합니다.`);
      const b = it.bonus || {};
      if (!Object.keys(b).length) bad(`아이템 ${id}: 장비에는 bonus 가 필요합니다.`);
      for (const [k, v] of Object.entries(b)) if (!BONUS_KEYS.includes(k) || !Number.isInteger(v)) bad(`아이템 ${id}: bonus.${k} 는 ${BONUS_KEYS.join('/')} 중 하나이고 값은 정수여야 합니다.`);
    }
  }
  const hasItem = (id) => !!items[id];
  const rangeOk = (r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1 && r[1] >= r[0];

  const spotIds = new Set();
  (eco.spots || []).forEach((s) => {
    if (!s.id || spotIds.has(s.id)) bad(`채집 장소 id 가 비었거나 중복됩니다. (${s.id})`);
    spotIds.add(s.id);
    if (!Number.isInteger(s.minLevel) || s.minLevel < 1) bad(`채집 ${s.id}: minLevel 이 1 이상의 정수가 아닙니다.`);
    if (!Number.isInteger(s.cost) || s.cost < 0) bad(`채집 ${s.id}: cost 가 정수가 아닙니다.`);
    if (!s.drops || !s.drops.length) bad(`채집 ${s.id}: drops 가 비어 있습니다.`);
    if (s.nothing && (!(s.nothing.weight >= 0) || !Array.isArray(s.nothing.texts) || !s.nothing.texts.length)) bad(`채집 ${s.id}: nothing 에는 weight 와 texts 가 필요합니다.`);
    (s.drops || []).forEach((d) => {
      if (!hasItem(d.item)) bad(`채집 ${s.id}: 없는 아이템 id "${d.item}"`);
      if (!(d.weight > 0)) bad(`채집 ${s.id}/${d.item}: weight 는 0 보다 커야 합니다.`);
      if (d.qty && !rangeOk(d.qty)) bad(`채집 ${s.id}/${d.item}: qty 는 [최소, 최대] 정수 두 개여야 합니다.`);
    });
  });

  const rids = new Set();
  (eco.recipes || []).forEach((r) => {
    if (!r.id || rids.has(r.id)) bad(`제작법 id 가 비었거나 중복됩니다. (${r.id})`);
    rids.add(r.id);
    if (!hasItem(r.output)) bad(`제작법 ${r.id}: 없는 결과물 id "${r.output}"`);
    if (!r.inputs || !Object.keys(r.inputs).length) bad(`제작법 ${r.id}: inputs 가 비어 있습니다.`);
    for (const [id, n] of Object.entries(r.inputs || {})) {
      if (!hasItem(id)) bad(`제작법 ${r.id}: 없는 재료 id "${id}"`);
      if (!Number.isInteger(n) || n < 1) bad(`제작법 ${r.id}: 재료 ${id} 수량이 1 이상의 정수가 아닙니다.`);
    }
    if (!Number.isInteger(r.gold) || r.gold < 0) bad(`제작법 ${r.id}: gold 가 0 이상의 정수가 아닙니다.`);
    if (!STATS.includes(r.stat)) bad(`제작법 ${r.id}: stat 은 ${STATS.join('/')} 중 하나여야 합니다.`);
    if (!Number.isInteger(r.dc)) bad(`제작법 ${r.id}: dc 가 정수가 아닙니다.`);
  });

  const jids = new Set();
  (eco.jars || []).forEach((j) => {
    if (!j.id || jids.has(j.id)) bad(`항아리 id 가 비었거나 중복됩니다. (${j.id})`);
    jids.add(j.id);
    if (!Number.isInteger(j.price) || j.price < 1) bad(`항아리 ${j.id}: price 가 1 이상의 정수가 아닙니다.`);
    if (!j.prizes || !j.prizes.length) bad(`항아리 ${j.id}: prizes 가 비어 있습니다.`);
    (j.prizes || []).forEach((p, i) => {
      if (!(p.weight > 0)) bad(`항아리 ${j.id} #${i + 1}: weight 는 0 보다 커야 합니다.`);
      if (p.gold !== undefined) { if (!rangeOk(p.gold)) bad(`항아리 ${j.id} #${i + 1}: gold 는 [최소, 최대] 정수 두 개여야 합니다.`); }
      else if (!hasItem(p.item)) bad(`항아리 ${j.id} #${i + 1}: 없는 아이템 id "${p.item}"`);
      if (p.qty && !rangeOk(p.qty)) bad(`항아리 ${j.id} #${i + 1}: qty 는 [최소, 최대] 정수 두 개여야 합니다.`);
    });
  });

  // 의뢰 보상으로 주는 아이템/골드
  ((questsDoc && questsDoc.quests) || []).forEach((q) => {
    const r = q.reward || {};
    if (r.gold !== undefined && (!Number.isInteger(r.gold) || r.gold < 0)) bad(`의뢰 ${q.id}: reward.gold 가 0 이상의 정수가 아닙니다.`);
    (r.items || []).forEach((x) => {
      if (!hasItem(x.id)) bad(`의뢰 ${q.id}: reward.items 에 없는 아이템 id "${x.id}"`);
      if (!Number.isInteger(x.qty) || x.qty < 1) bad(`의뢰 ${q.id}: reward.items 수량이 1 이상의 정수가 아닙니다.`);
    });
  });
  void rules;
  if (errs.length) throw new Error('경제 콘텐츠(economy.json) 오류:\n - ' + errs.join('\n - '));
}

// ---------- 굴림 ----------
function rollRange(rng, r) { return r[0] + Math.floor(rng() * (r[1] - r[0] + 1)); }
function weightedPick(rng, entries) {
  const total = entries.reduce((n, e) => n + e.weight, 0);
  let x = rng() * total;
  for (const e of entries) { x -= e.weight; if (x < 0) return e; }
  return entries[entries.length - 1];
}
// 채집: { nothing:true, text } 또는 { item, qty }
function rollSpot(rng, spot) {
  const entries = [...(spot.nothing ? [{ nothing: true, weight: spot.nothing.weight }] : []), ...spot.drops];
  const e = weightedPick(rng, entries);
  if (e.nothing) return { nothing: true, text: spot.nothing.texts[Math.floor(rng() * spot.nothing.texts.length)] };
  return { item: e.item, qty: e.qty ? rollRange(rng, e.qty) : 1 };
}
// 항아리: { gold } 또는 { item, qty }
function rollJar(rng, jar) {
  const p = weightedPick(rng, jar.prizes);
  if (p.gold !== undefined) return { gold: rollRange(rng, p.gold) };
  return { item: p.item, qty: p.qty ? rollRange(rng, p.qty) : 1 };
}
// 항아리 기댓값(판매가 기준) — 가격 대비 얼마나 돌려받는지 확인용
function jarExpectedValue(eco, jar) {
  const total = jar.prizes.reduce((n, p) => n + p.weight, 0);
  return jar.prizes.reduce((sum, p) => {
    const v = p.gold !== undefined ? (p.gold[0] + p.gold[1]) / 2 : eco.items[p.item].value * (p.qty ? (p.qty[0] + p.qty[1]) / 2 : 1);
    return sum + (p.weight / total) * v;
  }, 0);
}

// 제작 판정: d20 + 스탯 vs DC. 대실패(1)는 재료 절반 손실, 실패는 수수료만 손실
function rollCraft(rng, recipe, bonus) {
  const nat = rollDie(rng, 20);
  const total = nat + bonus;
  const crit = nat === 20, fumble = nat === 1;
  return { nat, bonus, total, dc: recipe.dc, crit, fumble, success: crit || (!fumble && total >= recipe.dc) };
}

// ---------- 스태미나 (저장값 + 시각으로 계산, 타이머 불필요) ----------
function staminaNow(eco, row, at) {
  const max = eco.settings.staminaMax, regen = eco.settings.staminaRegenMin * 60000;
  let cur = row.stamina, since = row.stamina_at;
  if (cur >= max) return { cur: max, max, nextInSec: 0, since: at };
  const gained = Math.floor((at - since) / regen);
  if (gained > 0) { cur = Math.min(max, cur + gained); since = cur >= max ? at : since + gained * regen; }
  return { cur, max, nextInSec: cur >= max ? 0 : Math.max(0, Math.ceil((since + regen - at) / 1000)), since };
}

// 장착 중인 장비들의 합산 보너스
function gearBonus(eco, equippedIds) {
  const total = { attack: 0, ac: 0, hp: 0 };
  for (const id of equippedIds) {
    const it = eco.items[id];
    if (it && it.bonus) for (const k of BONUS_KEYS) total[k] += it.bonus[k] || 0;
  }
  return total;
}
const rarityAtLeast = (a, min) => RARITY_ORDER.indexOf(a) >= RARITY_ORDER.indexOf(min);

module.exports = { validateEconomy, rollSpot, rollJar, rollCraft, jarExpectedValue, staminaNow, gearBonus, weightedPick, rarityAtLeast, RARITY_ORDER };
