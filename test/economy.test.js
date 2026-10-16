'use strict';
const assert = require('assert');
const E = require('../engine');
const X = require('../economy');
const rules = require('../content/rules.json');
const quests = require('../content/quests.json');
const eco = JSON.parse(JSON.stringify(require('../content/economy.json')));
let pass = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  PASS ' + n); } catch (e) { console.log('  FAIL ' + n + ' -> ' + e.message); process.exitCode = 1; } };
const fixed = (...v) => { let i = 0; return () => v[i++ % v.length]; };

console.log('경제 단위 테스트');
t('기본 콘텐츠 검사 통과', () => X.validateEconomy(eco, rules, quests));
t('잘못된 콘텐츠는 한국어 오류(없는 아이템/제작법/항아리/장비)', () => {
  const bad = JSON.parse(JSON.stringify(eco));
  bad.spots[0].drops[0].item = 'nope';
  bad.recipes[0].inputs = { ghost: 1 };
  bad.jars[0].prizes[0] = { item: 'xx', weight: 1 };
  bad.items['steel-sword'].slot = 'head';
  assert.throws(() => X.validateEconomy(bad, rules, quests), (e) => /없는 아이템 id "nope"/.test(e.message) && /없는 재료 id "ghost"/.test(e.message) && /없는 아이템 id "xx"/.test(e.message) && /slot/.test(e.message));
});
t('의뢰 보상의 없는 아이템도 잡아냄', () => {
  const q = JSON.parse(JSON.stringify(quests)); q.quests[0].reward.items = [{ id: 'zzz', qty: 1 }];
  assert.throws(() => X.validateEconomy(eco, rules, q), /reward\.items 에 없는 아이템 id "zzz"/);
});
t('항아리 기댓값은 가격의 60~90% (골드 시스템 안정)', () => {
  for (const j of eco.jars) { const r = X.jarExpectedValue(eco, j) / j.price; assert.ok(r > 0.6 && r < 0.9, `${j.name} ${r.toFixed(2)}`); }
});
t('가중치 뽑기: 같은 시드면 같은 결과, 분포가 가중치를 따름', () => {
  const rng = E.mulberry32(3); const counts = { a: 0, b: 0 };
  for (let i = 0; i < 4000; i++) counts[X.weightedPick(rng, [{ k: 'a', weight: 3 }, { k: 'b', weight: 1 }]).k]++;
  assert.ok(counts.a / counts.b > 2.6 && counts.a / counts.b < 3.5, JSON.stringify(counts));
});
t('채집: 낮은 값은 꽝(nothing), 수량 범위 준수', () => {
  const spot = eco.spots[0];
  assert.ok(X.rollSpot(fixed(0.0), spot).nothing);
  const r = X.rollSpot(fixed(0.3, 0.999), spot); assert.ok(r.item && r.qty >= 1 && r.qty <= 2);
});
t('항아리: 골드 상품은 범위 안', () => {
  const g = X.rollJar(fixed(0.0, 0.5), eco.jars[0]); assert.ok(g.gold >= 10 && g.gold <= 25, JSON.stringify(g));
});
t('제작 판정: 1 대실패, 20 대성공', () => {
  const rc = { dc: 99 };
  assert.ok(X.rollCraft(fixed(0.999), rc, 0).success && X.rollCraft(fixed(0.999), rc, 0).crit);
  const f = X.rollCraft(fixed(0.0), { dc: 1 }, 20); assert.ok(f.fumble && !f.success);
});
t('스태미나: 시간이 지나면 회복, 가득 차면 멈춤, 남은 시간 계산', () => {
  const T = 1e9, reg = eco.settings.staminaRegenMin * 60000;
  let s = X.staminaNow(eco, { stamina: 2, stamina_at: T }, T + reg * 3 + 1000);
  assert.strictEqual(s.cur, 5); assert.ok(s.nextInSec > 0 && s.nextInSec <= eco.settings.staminaRegenMin * 60);
  s = X.staminaNow(eco, { stamina: 2, stamina_at: T }, T + reg * 99);
  assert.strictEqual(s.cur, eco.settings.staminaMax); assert.strictEqual(s.nextInSec, 0);
  s = X.staminaNow(eco, { stamina: 0, stamina_at: T }, T + 1000);
  assert.strictEqual(s.cur, 0); assert.ok(Math.abs(s.nextInSec - (reg - 1000) / 1000) < 1.1);
});
t('장비 보너스 합산 (슬롯별)', () => {
  assert.deepStrictEqual(X.gearBonus(eco, ['mana-staff', 'iron-cuirass', 'merc-seal']), { attack: 2, ac: 3, hp: 5 });
});
t('장비 명중 보너스가 전투 굴림에 반영', () => {
  const q = JSON.parse(JSON.stringify(quests.quests[0]));
  const mk = (atk) => { const s = E.sheet(rules, { class: '전사', level: 1 }); return E.makeCombatState({ quest: q, players: [{ userId: 1, name: '가', cls: '전사', hp: 25, maxHp: 25, stats: s.stats, ac: s.ac, attackBonus: atk }] }); };
  const line = (atk) => E.resolveRound({ rules, state: mk(atk), actions: { 1: { action: 'attack' } }, rng: fixed(0.5, 0.5, 0.5, 0.5) }).rollLines[0];
  assert.ok(line(0).includes('=14') && line(2).includes('=16'), line(0) + ' / ' + line(2));
});
console.log(`\n${pass} 개 통과`);
