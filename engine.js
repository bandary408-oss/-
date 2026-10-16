'use strict';
// d20 판정 엔진. DB·네트워크를 전혀 모르는 순수 함수만 들어 있어서 테스트와 밸런스 시뮬레이션에 그대로 씁니다.
const crypto = require('crypto');

const STATS = ['str', 'dex', 'int', 'cha'];
const SKILL_IDS = ['shield', 'backstab', 'fireball', 'heal'];
const EFFECT_TYPES = ['enemy_ac', 'attack_bonus', 'alert'];
const TARGET_RULES = ['lowest_hp', 'highest_hp', 'random', 'all'];
const MODES = ['solo', 'party', 'raid'];
// 모드별 기본 인원 (quests.json 에서 minPlayers/maxPlayers 로 바꿀 수 있음. 레이드는 최대 인원 제한 없음)
const MODE_DEFAULTS = { solo: { min: 1, max: 1 }, party: { min: 2, max: 4 }, raid: { min: 3, max: null } };

// ---------- 난수 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function secureRng() { return crypto.randomBytes(4).readUInt32BE(0) / 4294967296; }
function rollDie(rng, sides) { return 1 + Math.floor(rng() * sides); }
function rollDice(rng, expr) {
  const m = /^(\d*)d(\d+)$/.exec(expr);
  if (!m) throw new Error(`잘못된 주사위 표기: ${expr}`);
  const n = m[1] ? Number(m[1]) : 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rollDie(rng, Number(m[2]));
  return sum;
}
const isDice = (s) => typeof s === 'string' && /^\d*d\d+$/.test(s);
const clone = (o) => JSON.parse(JSON.stringify(o));
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

// ---------- 콘텐츠 검사 (기획자가 JSON 을 고치다 실수해도 시작할 때 바로 알려줌) ----------
function validateContent(rules, questsDoc) {
  const errs = [];
  const bad = (m) => errs.push(m);
  if (!rules || typeof rules !== 'object') throw new Error('rules.json 을 읽을 수 없습니다.');

  for (const s of STATS) if (!rules.statNames || typeof rules.statNames[s] !== 'string') bad(`rules.statNames.${s} 가 없습니다.`);
  if (!Number.isInteger(rules.statCap) || rules.statCap < 0) bad('rules.statCap 은 0 이상의 정수여야 합니다.');

  const classes = rules.classes || {};
  if (!Object.keys(classes).length) bad('rules.classes 가 비어 있습니다.');
  for (const [name, c] of Object.entries(classes)) {
    for (const s of STATS) if (!c.base || !Number.isInteger(c.base[s])) bad(`클래스 "${name}" 의 base.${s} 가 정수가 아닙니다.`);
    if (!STATS.includes(c.attackStat)) bad(`클래스 "${name}" 의 attackStat 은 ${STATS.join('/')} 중 하나여야 합니다.`);
    if (!isDice(c.weapon)) bad(`클래스 "${name}" 의 weapon 은 d6 같은 주사위 표기여야 합니다.`);
    if (!c.skill || !SKILL_IDS.includes(c.skill.id)) bad(`클래스 "${name}" 의 skill.id 는 ${SKILL_IDS.join('/')} 중 하나여야 합니다.`);
    else if (!Number.isInteger(c.skill.cooldown) || c.skill.cooldown < 0) bad(`클래스 "${name}" 의 skill.cooldown 이 올바르지 않습니다.`);
  }

  const pt = rules.party || {};
  if (typeof pt.hpScalePerPlayer !== 'number' || pt.hpScalePerPlayer < 0) bad('rules.party.hpScalePerPlayer 는 0 이상의 숫자여야 합니다.');
  if (typeof pt.koXpRatio !== 'number' || pt.koXpRatio < 0 || pt.koXpRatio > 1) bad('rules.party.koXpRatio 는 0~1 사이 숫자여야 합니다.');

  const lv = rules.level || {};
  if (!Array.isArray(lv.xp) || lv.xp.length !== lv.max || lv.xp[0] !== 0 || lv.xp.some((v, i) => i && v <= lv.xp[i - 1])) {
    bad('rules.level.xp 는 0 으로 시작하고 점점 커지는 숫자 배열이며, 길이가 level.max 와 같아야 합니다.');
  }
  for (const k of ['hpBase', 'hpPerLevel']) if (!Number.isInteger(lv[k])) bad(`rules.level.${k} 가 정수가 아닙니다.`);
  for (const [k, d] of Object.entries(rules.difficulty || {})) if (!Number.isInteger(d.dc) || typeof d.label !== 'string') bad(`난이도 "${k}" 에는 dc(정수)와 label 이 필요합니다.`);
  if (!Object.keys(rules.difficulty || {}).length) bad('rules.difficulty 가 비어 있습니다.');
  for (const k of ['baseAc', 'defendAc', 'guardAc', 'shieldReduce', 'backstabBonus', 'critMultiplier']) {
    if (!Number.isInteger((rules.combat || {})[k])) bad(`rules.combat.${k} 가 정수가 아닙니다.`);
  }
  for (const [path, v] of [['investigation.maxActions', (rules.investigation || {}).maxActions], ['investigation.alertLimit', (rules.investigation || {}).alertLimit],
    ['round.deadlineSec', (rules.round || {}).deadlineSec], ['round.minSec', (rules.round || {}).minSec],
    ['cheer.perCheer', (rules.cheer || {}).perCheer], ['cheer.maxPerTarget', (rules.cheer || {}).maxPerTarget]]) {
    if (!Number.isInteger(v) || v < 0) bad(`rules.${path} 는 0 이상의 정수여야 합니다.`);
  }

  const quests = (questsDoc && questsDoc.quests) || [];
  const ids = new Set();
  quests.forEach((q, qi) => {
    const where = `의뢰 #${qi + 1}(${q.id || '이름 없음'})`;
    if (!/^[a-z0-9-]+$/.test(q.id || '')) bad(`${where}: id 는 영문 소문자/숫자/하이픈이어야 합니다.`);
    if (ids.has(q.id)) bad(`${where}: id 가 중복됩니다.`);
    ids.add(q.id);
    if (typeof q.title !== 'string' || !q.title) bad(`${where}: title 이 없습니다.`);
    if (!MODES.includes(q.mode)) bad(`${where}: mode 는 ${MODES.join('/')} 중 하나여야 합니다.`);
    else {
      const pc = partySize(q);
      if (!Number.isInteger(pc.min) || pc.min < 1) bad(`${where}: minPlayers 는 1 이상의 정수여야 합니다.`);
      if (pc.max !== null && (!Number.isInteger(pc.max) || pc.max < pc.min)) bad(`${where}: maxPlayers 는 minPlayers 이상의 정수여야 합니다.`);
    }
    if (!q.reward || !Number.isInteger(q.reward.xp)) bad(`${where}: reward.xp 가 정수가 아닙니다.`);
    if (q.investigation) {
      const cids = new Set();
      (q.investigation.choices || []).forEach((c) => {
        if (!c.id || cids.has(c.id)) bad(`${where}: 조사 선택지 id 가 비었거나 중복됩니다. (${c.id})`);
        cids.add(c.id);
        if (!STATS.includes(c.stat)) bad(`${where}/${c.id}: stat 은 ${STATS.join('/')} 중 하나여야 합니다.`);
        if (!(rules.difficulty || {})[c.difficulty]) bad(`${where}/${c.id}: difficulty "${c.difficulty}" 는 rules.difficulty 에 없습니다.`);
        if (!c.success || typeof c.success.text !== 'string') bad(`${where}/${c.id}: success.text 가 없습니다.`);
        if (!c.fail || typeof c.fail.text !== 'string') bad(`${where}/${c.id}: fail.text 가 없습니다.`);
        const ef = c.success && c.success.effect;
        if (ef && (!EFFECT_TYPES.includes(ef.type) || !Number.isInteger(ef.value))) bad(`${where}/${c.id}: effect 는 type(${EFFECT_TYPES.join('/')})과 정수 value 가 필요합니다.`);
      });
      if (!cids.size) bad(`${where}: 조사 선택지가 하나도 없습니다.`);
    }
    const cb = q.combat;
    if (!cb || !Array.isArray(cb.enemies) || !cb.enemies.length) { bad(`${where}: combat.enemies 가 비어 있습니다.`); return; }
    const eids = new Set();
    cb.enemies.forEach((e) => {
      if (!e.id || eids.has(e.id)) bad(`${where}: 적 id 가 비었거나 중복됩니다. (${e.id})`);
      eids.add(e.id);
      for (const k of ['hp', 'ac', 'attackBonus']) if (!Number.isInteger(e[k])) bad(`${where}/${e.id}: ${k} 가 정수가 아닙니다.`);
      if (!Array.isArray(e.intents) || !e.intents.length) bad(`${where}/${e.id}: intents 가 비어 있습니다.`);
      const p2 = e.phase2;
      if (p2 !== undefined) {
        if (!p2 || typeof p2.at !== 'number' || p2.at <= 0 || p2.at >= 1) bad(`${where}/${e.id}: phase2.at 은 0~1 사이 숫자여야 합니다. (예: 0.5 = HP 절반)`);
        if (!p2 || !Array.isArray(p2.intents) || !p2.intents.length) bad(`${where}/${e.id}: phase2.intents 가 비어 있습니다.`);
      }
      [...(e.intents || []), ...((p2 && Array.isArray(p2.intents)) ? p2.intents : [])].forEach((it, i) => {
        if (it.type !== 'strike' && it.type !== 'guard') bad(`${where}/${e.id}: intents[${i}].type 은 strike 또는 guard 여야 합니다.`);
        if (typeof it.label !== 'string') bad(`${where}/${e.id}: intents[${i}].label 이 없습니다.`);
        if (it.type === 'strike') {
          if (!TARGET_RULES.includes(it.target)) bad(`${where}/${e.id}: intents[${i}].target 은 ${TARGET_RULES.join('/')} 중 하나여야 합니다.`);
          if (!isDice(it.dice)) bad(`${where}/${e.id}: intents[${i}].dice 가 d6 같은 표기가 아닙니다.`);
        }
      });
    });
  });

  if (errs.length) throw new Error('콘텐츠(JSON) 오류:\n - ' + errs.join('\n - '));
}

// ---------- 캐릭터 시트 ----------
function statBonus(rules, row, stat) {
  const cls = rules.classes[row.class];
  const base = cls ? cls.base[stat] : 0;
  return Math.min(rules.statCap, base + (row['a_' + stat] || 0));
}
function levelFromXp(rules, xp) {
  let lv = 1;
  rules.level.xp.forEach((need, i) => { if (xp >= need) lv = i + 1; });
  return Math.min(lv, rules.level.max);
}
function maxHp(rules, level) { return rules.level.hpBase + rules.level.hpPerLevel * level; }
function sheet(rules, row) {
  const level = row.level || 1;
  const stats = {};
  STATS.forEach((s) => { stats[s] = statBonus(rules, row, s); });
  const next = rules.level.xp[level]; // level 이 곧 다음 레벨의 인덱스
  return {
    level, xp: row.xp || 0, nextXp: level >= rules.level.max ? null : next,
    maxHp: maxHp(rules, level), stats, statPoints: row.stat_points || 0,
    ac: rules.combat.baseAc + stats.dex,
  };
}
// 경험치를 더하고 레벨업을 계산
function applyXp(rules, row, gain) {
  const xp = (row.xp || 0) + gain;
  const oldLevel = row.level || 1;
  const level = Math.max(oldLevel, levelFromXp(rules, xp));
  return { xp, level, levelsGained: level - oldLevel, statPointsGained: level - oldLevel };
}

// ---------- 판정 ----------
function check({ rng, bonus, dc }) {
  const nat = rollDie(rng, 20);
  const total = nat + bonus;
  const crit = nat === 20;
  const fumble = nat === 1;
  return { nat, bonus, total, dc, crit, fumble, success: crit || (!fumble && total >= dc) };
}
const checkLabel = (r) => (r.crit ? '대성공' : r.fumble ? '대실패' : r.success ? '성공' : '실패');

// ---------- 전투 ----------
const intentFor = (enemy, round) => enemy.intents[(round - 1) % enemy.intents.length];

// 의뢰의 인원 제한 { min, max }  (max 가 null 이면 제한 없음)
function partySize(quest) {
  const d = MODE_DEFAULTS[quest.mode] || MODE_DEFAULTS.solo;
  return {
    min: quest.minPlayers !== undefined ? quest.minPlayers : d.min,
    max: quest.mode === 'solo' ? 1 : (quest.maxPlayers !== undefined ? quest.maxPlayers : d.max),
  };
}
// 인원수에 맞춘 적 HP: 기본 HP × (1 + 배율 × (인원 - 1))
function scaledHp(rules, hp, count) {
  const per = (rules && rules.party && rules.party.hpScalePerPlayer) || 0;
  return Math.max(1, Math.round(hp * (1 + per * Math.max(0, count - 1))));
}

function makeCombatState({ quest, players, mods, rules }) {
  return {
    round: 1,
    players: players.map((p) => ({ ...p, status: 'active', cd: 0 })),
    enemies: quest.combat.enemies.map((e) => {
      const hp = scaledHp(rules, e.hp, players.length);
      const out = { id: e.id, name: e.name, hp, maxHp: hp, ac: e.ac, attackBonus: e.attackBonus, intents: e.intents };
      if (e.phase2) out.phase2 = { at: e.phase2.at, text: e.phase2.text || '', intents: e.phase2.intents, on: false };
      return out;
    }),
    mods: { enemyAc: (mods && mods.enemyAc) || 0, attackBonus: (mods && mods.attackBonus) || 0 },
  };
}

function describeIntents(state) {
  const alive = state.enemies.filter((e) => e.hp > 0);
  return alive.map((e) => {
    const it = intentFor(e, state.round);
    const dmg = it.type === 'strike' ? ` (${it.dice}${it.bonus ? signed(it.bonus) : ''})` : '';
    const who = alive.length > 1 ? `${e.name}: ` : '';
    return `👁 다음 행동: ${who}${it.label}${dmg}`;
  });
}

function buildSummary(title, before, s, outcome) {
  const out = [`━ ${title} ━`];
  s.enemies.forEach((e) => {
    const b = before.enemies[e.id];
    out.push(b !== e.hp ? `👹 ${e.name}  HP ${b} → ${e.hp} (${e.hp - b})${e.hp === 0 ? ' ☠' : ''}` : `👹 ${e.name}  HP ${e.hp}`);
  });
  out.push('🧑 ' + s.players.map((p) => {
    const b = before.players[p.userId];
    if (p.status === 'ko') return `${p.name} 💀`;
    return b.hp !== p.hp ? `${p.name} ${b.hp} → ${p.hp} (${signed(p.hp - b.hp)})` : `${p.name} ${p.hp}`;
  }).join(' · '));
  if (outcome === 'continue') out.push(...describeIntents(s));
  return out.join('\n');
}

const snapshot = (s) => ({
  players: Object.fromEntries(s.players.map((p) => [p.userId, { hp: p.hp, status: p.status }])),
  enemies: Object.fromEntries(s.enemies.map((e) => [e.id, e.hp])),
});

// 적 행동 단계 (정상 라운드와 기습에서 공통으로 사용)
function enemyPhase(s, rules, rng, ctx) {
  const C = rules.combat;
  const koUsers = [];
  for (const e of s.enemies.filter((x) => x.hp > 0)) {
    const it = intentFor(e, s.round);
    if (it.type !== 'strike') continue;
    const alive = s.players.filter((p) => p.status === 'active');
    if (!alive.length) break;
    let targets;
    if (it.target === 'all') targets = alive.slice();
    else if (it.target === 'random') targets = [alive[Math.floor(rng() * alive.length)]];
    else {
      const sorted = alive.slice().sort((a, b) => (it.target === 'lowest_hp' ? a.hp - b.hp : b.hp - a.hp));
      targets = [sorted[0]];
    }
    for (const p of targets) {
      if (p.status !== 'active') continue;
      const nat = rollDie(rng, 20);
      const total = nat + e.attackBonus;
      const ac = p.ac + (ctx.defending[p.userId] ? C.defendAc : 0);
      const hit = nat === 20 || (nat !== 1 && total >= ac);
      const head = `⚔ ${e.name} → ${p.name}: d20(${nat})${signed(e.attackBonus)}=${total} vs 방어도 ${ac}`;
      if (!hit) { ctx.lines.push(`${head} → ${nat === 1 ? '헛스윙' : '빗나감'}`); continue; }
      let dmg = rollDice(rng, it.dice) + (it.bonus || 0);
      if (nat === 20) dmg *= C.critMultiplier;
      let note = nat === 20 ? '치명타! ' : '';
      if (ctx.shield[p.userId]) { dmg = Math.max(0, dmg - C.shieldReduce); note += `방패막기로 -${C.shieldReduce} `; }
      p.hp = Math.max(0, p.hp - dmg);
      ctx.lines.push(`${head} → ${note}${dmg} 피해`);
      if (p.hp === 0) { p.status = 'ko'; koUsers.push(p.userId); ctx.lines.push(`💀 ${p.name} 전투불능!`); }
    }
  }
  return koUsers;
}

// 라운드 하나를 해결한다.
//  actions: { [userId]: { action:'attack'|'skill'|'defend', targetUserId?, targetEnemyId?, line? } }  (없으면 방어)
//  cheers : { [userId]: 응원 횟수 }
//  ambush : true 면 플레이어 행동 없이 적만 먼저 움직임 (조사에서 경계도가 가득 찼을 때)
function resolveRound({ rules, state, actions = {}, cheers = {}, rng, ambush = false }) {
  const s = clone(state);
  const C = rules.combat;
  const before = snapshot(s);
  const ctx = { lines: [], defending: {}, shield: {} };
  const used = {};

  const guardUp = {};
  s.enemies.forEach((e) => { if (e.hp > 0 && intentFor(e, s.round).type === 'guard') guardUp[e.id] = true; });
  const aliveEnemies = () => s.enemies.filter((e) => e.hp > 0);
  const findAlly = (id, self) => s.players.find((p) => p.userId === id && p.status === 'active') || self;
  const findEnemy = (id) => aliveEnemies().find((e) => e.id === id) || aliveEnemies()[0];

  if (!ambush) {
    for (const p of s.players) {
      if (p.status !== 'active') continue;
      if (!aliveEnemies().length) break; // 앞사람이 마지막 적을 쓰러뜨림 (파티·레이드)
      const cls = rules.classes[p.cls];
      const a = actions[p.userId] || { action: 'defend' };
      const cheer = Math.min(cheers[p.userId] || 0, rules.cheer.maxPerTarget) * rules.cheer.perCheer;
      const cheerNote = cheer ? ` (응원 ${signed(cheer)})` : '';
      const narr = a.line ? `‘${a.line}’ ` : '';
      const sb = p.stats[cls.attackStat];

      const attack = (extra, label) => {
        const e = findEnemy(a.targetEnemyId);
        const nat = rollDie(rng, 20);
        const bonus = sb + (p.attackBonus || 0) + s.mods.attackBonus + cheer + extra; // 장비 보너스 포함
        const total = nat + bonus;
        const ac = e.ac + s.mods.enemyAc + (guardUp[e.id] ? C.guardAc : 0);
        const hit = nat === 20 || (nat !== 1 && total >= ac);
        const head = `🎲 ${p.name} ${narr}${label} → ${e.name}: d20(${nat})${signed(bonus)}=${total} vs 방어도 ${ac}${cheerNote}`;
        if (!hit) { ctx.lines.push(`${head} → ${nat === 1 ? '헛스윙' : '빗나감'}`); return; }
        let dmg = Math.max(1, rollDice(rng, cls.weapon) + sb);
        if (nat === 20) dmg *= C.critMultiplier;
        e.hp = Math.max(0, e.hp - dmg);
        ctx.lines.push(`${head} → ${nat === 20 ? '치명타! ' : ''}${dmg} 피해`);
      };

      let act = a.action;
      if (act === 'skill' && p.cd > 0) act = 'defend'; // 쿨타임 중이면 방어로 대체 (서버가 미리 막지만 안전장치)
      if (act === 'attack') attack(0, '공격');
      else if (act === 'skill') {
        used[p.userId] = true;
        p.cd = cls.skill.cooldown;
        switch (cls.skill.id) {
          case 'shield': {
            const t = findAlly(a.targetUserId, p);
            ctx.shield[t.userId] = true;
            ctx.lines.push(`🛡 ${p.name} ${narr}방패막기 → ${t.name} (이번 라운드 받는 피해 -${C.shieldReduce})`);
            break;
          }
          case 'backstab': attack(C.backstabBonus, '급소 찌르기'); break;
          case 'fireball':
            for (const e of aliveEnemies()) {
              const dmg = Math.max(1, rollDice(rng, 'd6') + sb + cheer);
              e.hp = Math.max(0, e.hp - dmg);
              ctx.lines.push(`🔥 ${p.name} ${narr}화염구 → ${e.name}: ${dmg} 피해 (굴림 없이 명중)${cheerNote}`);
            }
            break;
          case 'heal': {
            const t = findAlly(a.targetUserId, p);
            const amt = Math.max(1, rollDice(rng, 'd8') + sb + cheer);
            const real = Math.min(amt, t.maxHp - t.hp);
            t.hp += real;
            ctx.lines.push(`✨ ${p.name} ${narr}치유 → ${t.name}: HP +${real}${cheerNote}`);
            break;
          }
          default: break;
        }
      } else {
        ctx.defending[p.userId] = true;
        ctx.lines.push(`🛡 ${p.name} ${narr}방어 태세 (방어도 +${C.defendAc})`);
      }
    }
    if (!aliveEnemies().length) {
      return { state: s, rollLines: ctx.lines, summary: buildSummary(`${s.round}라운드 결과`, before, s, 'victory'), outcome: 'victory', koUsers: [] };
    }
  }

  const koUsers = enemyPhase(s, rules, rng, ctx);
  const phaseLines = enterPhase2(s);
  const anyActive = s.players.some((p) => p.status === 'active');
  const outcome = anyActive ? 'continue' : 'defeat';

  if (!ambush) {
    s.players.forEach((p) => { if (p.status === 'active' && !used[p.userId]) p.cd = Math.max(0, p.cd - 1); });
    if (outcome === 'continue') s.round += 1;
  }
  const title = ambush ? '기습 결과' : `${state.round}라운드 결과`;
  const summary = [...phaseLines, buildSummary(title, before, s, outcome)].join('\n');
  return { state: s, rollLines: ctx.lines, summary, outcome, koUsers };
}

// 보스 2페이즈: HP 가 phase2.at 비율 이하로 떨어지면 다음 라운드부터 행동 패턴이 바뀐다.
function enterPhase2(s) {
  const lines = [];
  for (const e of s.enemies) {
    if (!e.phase2 || e.phase2.on || e.hp <= 0 || e.hp > e.maxHp * e.phase2.at) continue;
    e.phase2.on = true;
    e.intents = e.phase2.intents;
    lines.push(`🔥 ${e.name} — 2페이즈! ${e.phase2.text}`.trim());
  }
  return lines;
}

module.exports = {
  STATS, SKILL_IDS, MODES, partySize, scaledHp, mulberry32, secureRng, rollDie, rollDice, validateContent,
  statBonus, levelFromXp, maxHp, sheet, applyXp, check, checkLabel,
  intentFor, makeCombatState, describeIntents, resolveRound, signed,
};
