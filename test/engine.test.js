'use strict';
const assert = require('assert');
const E = require('../engine');
const rules = require('../content/rules.json');
const quests = require('../content/quests.json').quests;
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  PASS ' + name); } catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); process.exitCode = 1; } };
const fixed = (...v) => { let i = 0; return () => v[i++ % v.length]; }; // rng 고정 (0.0~0.999)
const dieAt = (n, sides) => (n - 1) / sides + 0.001; // 원하는 눈이 나오게 하는 rng 값
const mk = (cls, extra = {}) => { const s = E.sheet(rules, { class: cls, level: 1 }); return { userId: 1, name: '가', cls, hp: s.maxHp, maxHp: s.maxHp, stats: s.stats, ac: s.ac, ...extra }; };
const state = (cls, enemyOver = {}, mods) => {
  const q = JSON.parse(JSON.stringify(quests[0]));
  Object.assign(q.combat.enemies[0], enemyOver);
  return E.makeCombatState({ quest: q, players: [mk(cls)], mods });
};

console.log('엔진 단위 테스트');
t('콘텐츠 검사 통과', () => E.validateContent(rules, { quests }));
t('잘못된 콘텐츠는 한국어 오류', () => {
  const bad = JSON.parse(JSON.stringify(quests)); bad[0].investigation.choices[0].stat = 'luck'; bad[0].combat.enemies[0].intents = [];
  assert.throws(() => E.validateContent(rules, { quests: bad }), /stat 은 str\/dex\/int\/cha|intents 가 비어/);
});
t('레벨/HP/시트', () => {
  assert.strictEqual(E.levelFromXp(rules, 0), 1); assert.strictEqual(E.levelFromXp(rules, 30), 2); assert.strictEqual(E.levelFromXp(rules, 9999), 5);
  assert.strictEqual(E.maxHp(rules, 1), 25);
  const s = E.sheet(rules, { class: '전사', level: 1, a_str: 5 });
  assert.strictEqual(s.stats.str, 4); // 상한
  assert.strictEqual(s.ac, 11);
});
t('경험치/레벨업', () => { const r = E.applyXp(rules, { xp: 20, level: 1 }, 15); assert.strictEqual(r.level, 2); assert.strictEqual(r.statPointsGained, 1); });
t('d20 판정: 20 대성공, 1 대실패', () => {
  assert.ok(E.check({ rng: fixed(dieAt(20, 20)), bonus: -5, dc: 30 }).success);
  assert.ok(!E.check({ rng: fixed(dieAt(1, 20)), bonus: 30, dc: 5 }).success);
  assert.ok(E.check({ rng: fixed(dieAt(10, 20)), bonus: 4, dc: 14 }).success);
});
t('공격 명중 + 데미지', () => {
  // 전사 공격: d20=15, 힘+3 → 18 ≥ 12 명중. 데미지 d8=5 +3 = 8
  const r = E.resolveRound({ rules, state: state('전사'), actions: { 1: { action: 'attack' } }, rng: fixed(dieAt(15, 20), dieAt(5, 8), dieAt(1, 20), 0.5) });
  assert.strictEqual(r.state.enemies[0].hp, 26 - 8);
});
t('자연 1은 항상 빗나감, 자연 20은 치명타(×2)', () => {
  let r = E.resolveRound({ rules, state: state('전사'), actions: { 1: { action: 'attack' } }, rng: fixed(dieAt(1, 20), dieAt(1, 20), 0.5, 0.5) });
  assert.strictEqual(r.state.enemies[0].hp, 26);
  r = E.resolveRound({ rules, state: state('전사'), actions: { 1: { action: 'attack' } }, rng: fixed(dieAt(20, 20), dieAt(4, 8), dieAt(1, 20), 0.5) });
  assert.strictEqual(r.state.enemies[0].hp, 26 - (4 + 3) * 2);
});
t('조사 보정: 적 방어도 -2 가 명중에 반영', () => {
  // d20=9 +3 = 12: 방어도 12면 명중, 보정 없이 +0 → 명중, 적 AC 14 로 올려서 비교
  const base = state('전사', { ac: 13 }), eased = state('전사', { ac: 13 }, { enemyAc: -2 });
  const rng = () => fixed(dieAt(9, 20), dieAt(3, 8), dieAt(1, 20), 0.5);
  assert.strictEqual(E.resolveRound({ rules, state: base, actions: { 1: { action: 'attack' } }, rng: rng() }).state.enemies[0].hp, 26);
  assert.ok(E.resolveRound({ rules, state: eased, actions: { 1: { action: 'attack' } }, rng: rng() }).state.enemies[0].hp < 26);
});
t('스킬 쿨타임: 사용 후 3, 쿨 중이면 방어로 대체', () => {
  let r = E.resolveRound({ rules, state: state('마법사'), actions: { 1: { action: 'skill' } }, rng: fixed(0.5, 0.5, 0.01) });
  assert.strictEqual(r.state.players[0].cd, 3);
  r = E.resolveRound({ rules, state: r.state, actions: { 1: { action: 'skill' } }, rng: fixed(0.5, 0.5, 0.01) });
  assert.strictEqual(r.state.players[0].cd, 2); // 사용 못 했으니 쿨타임 감소
  assert.ok(r.rollLines.some((l) => l.includes('방어 태세')));
});
t('화염구는 굴림 없이 명중', () => {
  const r = E.resolveRound({ rules, state: state('마법사'), actions: { 1: { action: 'skill' } }, rng: fixed(dieAt(1, 6), 0.5, 0.01) });
  assert.strictEqual(r.state.enemies[0].hp, 26 - (1 + 3));
});
t('치유는 최대 HP 를 넘지 않음', () => {
  const st = state('성직자'); st.players[0].hp = 24;
  const r = E.resolveRound({ rules, state: st, actions: { 1: { action: 'skill', targetUserId: 1 } }, rng: fixed(dieAt(8, 8), dieAt(1, 20), 0.5) });
  assert.ok(r.state.players[0].hp <= 25);
});
t('응원은 명중 굴림에 +1 (대상당 최대 +2)', () => {
  const run = (c) => E.resolveRound({ rules, state: state('전사'), actions: { 1: { action: 'attack' } }, cheers: { 1: c }, rng: fixed(dieAt(8, 20), dieAt(3, 8), dieAt(1, 20), 0.5) });
  assert.ok(run(0).rollLines[0].includes('=11') && run(2).rollLines[0].includes('=13'));
  assert.ok(run(9).rollLines[0].includes('=13')); // 상한
});
t('전투불능: HP 0 → ko, 전원 ko 면 패배', () => {
  const st = state('전사', { attackBonus: 30 }); st.players[0].hp = 1;
  const r = E.resolveRound({ rules, state: st, actions: { 1: { action: 'defend' } }, rng: fixed(dieAt(15, 20), 0.5, 0.5, 0.5) });
  const p = r.state.players[0];
  assert.ok(p.hp === 0 && p.status === 'ko'); assert.strictEqual(r.outcome, 'defeat'); assert.deepStrictEqual(r.koUsers, [1]);
});
t('승리 시 적 행동 없이 종료', () => {
  const r = E.resolveRound({ rules, state: state('전사', { hp: 1 }), actions: { 1: { action: 'attack' } }, rng: fixed(dieAt(15, 20), dieAt(5, 8)) });
  assert.strictEqual(r.outcome, 'victory');
});
t('기습: 플레이어 행동 없이 적만 행동, 라운드 유지', () => {
  const r = E.resolveRound({ rules, state: state('전사'), rng: fixed(dieAt(15, 20), dieAt(3, 6)), ambush: true });
  assert.strictEqual(r.state.round, 1); assert.ok(r.summary.includes('기습 결과'));
});
t('로그는 적HP·유저HP·다음 행동 3줄 형식', () => {
  const r = E.resolveRound({ rules, state: state('전사'), actions: { 1: { action: 'attack' } }, rng: fixed(dieAt(15, 20), dieAt(5, 8), dieAt(1, 20), 0.5) });
  const lines = r.summary.split('\n');
  assert.ok(lines[1].startsWith('👹') && lines[2].startsWith('🧑') && lines[3].startsWith('👁 다음 행동'));
});
t('같은 시드면 결과가 같다', () => {
  const go = () => { let st = state('도적'); const rng = E.mulberry32(5); const out = []; for (let i = 0; i < 4; i++) { const r = E.resolveRound({ rules, state: st, actions: { 1: { action: 'attack' } }, rng }); st = r.state; out.push(r.summary); if (r.outcome !== 'continue') break; } return out.join('|'); };
  assert.strictEqual(go(), go());
});
console.log(`\n${pass} 개 통과`);
