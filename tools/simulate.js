'use strict';
// 밸런스 시뮬레이션: node tools/simulate.js [횟수] [의뢰id] [레벨]
// 클래스별로 솔로 전투를 수천 번 돌려 승률/평균 라운드를 보여줍니다. 조사 보너스 유무도 비교해요.
const path = require('path');
const E = require('../engine');
const rules = require('../content/rules.json');
const quests = require('../content/quests.json').quests;
E.validateContent(rules, { quests });

const N = Number(process.argv[2]) || 5000;
const quest = quests.find((q) => q.id === (process.argv[3] || quests[0].id));
const level = Number(process.argv[4]) || 1;

function playerFor(cls, lvl) {
  const row = { class: cls, level: lvl, xp: 0 };
  const sh = E.sheet(rules, row);
  return { userId: 1, name: cls, cls, hp: sh.maxHp, maxHp: sh.maxHp, stats: sh.stats, ac: sh.ac };
}

// 단순 AI: 50% 미만이면 (성직자) 치유, 스킬이 있으면 사용, 아니면 공격. 위험하면 방어.
function decide(rules, st) {
  const p = st.players[0];
  const cls = rules.classes[p.cls];
  const ready = p.cd === 0;
  if (ready && cls.skill.id === 'heal' && p.hp <= p.maxHp * 0.5) return { action: 'skill', targetUserId: p.userId };
  if (ready && cls.skill.id === 'shield' && p.hp <= p.maxHp * 0.6) return { action: 'skill', targetUserId: p.userId };
  if (ready && (cls.skill.id === 'fireball' || cls.skill.id === 'backstab')) return { action: 'skill' };
  return { action: 'attack' };
}

function run(cls, seed, mods) {
  const rng = E.mulberry32(seed);
  let st = E.makeCombatState({ quest, players: [playerFor(cls, level)], mods });
  for (let i = 0; i < 40; i++) {
    const r = E.resolveRound({ rules, state: st, actions: { 1: decide(rules, st) }, rng });
    st = r.state;
    if (r.outcome !== 'continue') return { win: r.outcome === 'victory', rounds: st.round, hp: st.players[0].hp };
  }
  return { win: false, rounds: 40, hp: st.players[0].hp };
}

const scenarios = [
  ['조사 보너스 없음', {}],
  ['방어도 -2', { enemyAc: -2 }],
  ['명중 +1', { attackBonus: 1 }],
  ['둘 다', { enemyAc: -2, attackBonus: 1 }],
];
console.log(`의뢰 ${quest.id} · 레벨 ${level} · 솔로 ${N}회씩`);
for (const [label, mods] of scenarios) {
  console.log(`\n[${label}]`);
  for (const cls of Object.keys(rules.classes)) {
    let w = 0, rs = 0;
    for (let i = 0; i < N; i++) { const r = run(cls, i + 1, mods); if (r.win) { w++; rs += r.rounds; } }
    console.log(`  ${cls.padEnd(4)} 승률 ${(w / N * 100).toFixed(1).padStart(5)}%  승리 시 평균 ${(w ? rs / w : 0).toFixed(1)}라운드`);
  }
}
