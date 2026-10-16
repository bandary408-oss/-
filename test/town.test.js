'use strict';
// 4단계 통합 테스트: 채집·제작·항아리·판매·장비·선물 (돈/아이템 복사·음수 어뷰징 포함)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 4700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-town-'));
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, p, { body, cookie } = {}) {
  const h = {}; if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : null;
  return { status: res.status, data: ct.includes('json') ? await res.json() : null, cookie: sc ? sc.split(';')[0] : null };
}

// 테스트 전용 콘텐츠
const eco = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'economy.json'), 'utf8'));
eco.spots.push({ id: 'sure-spot', name: '확정 채집지', minLevel: 1, cost: 1, desc: 't', drops: [{ item: 'mana-crystal', weight: 1 }] });
const jar = (id, price, prize) => ({ id, name: id, price, desc: 't', prizes: [{ ...prize, weight: 1 }] });
eco.jars.push(jar('junk-jar', 1, { item: 'rusty-nail', qty: [3, 3] }), jar('gold-jar', 10, { gold: [30, 30] }),
  jar('cuirass-jar', 1, { item: 'iron-cuirass' }), jar('vest-jar', 1, { item: 'quilted-vest' }), jar('foot-jar', 1, { item: 'rabbit-foot' }),
  jar('nail2-jar', 1, { item: 'rusty-nail' }));
eco.items['rusty-nail'].type = 'junk';
eco.recipes.push({ id: 't-craft', name: '테스트 제작', output: 'steel-sword', inputs: { 'rusty-nail': 2 }, gold: 5, stat: 'str', dc: 1 });
const EFILE = path.join(DATA_DIR, 'eco.json'); fs.writeFileSync(EFILE, JSON.stringify(eco));
const quests = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'quests.json'), 'utf8'));
quests.quests.push({ id: 'easy', title: '허수아비', mode: 'solo', recommendedLevel: 1, summary: 't', reward: { xp: 10, gold: 30, items: [{ id: 'herb', qty: 1 }] }, intro: 'i',
  combat: { intro: 'c', ambushText: 'a', enemies: [{ id: 'd', name: '허수아비', hp: 1, ac: 1, attackBonus: 0, intents: [{ type: 'guard', label: '서 있다' }] }], victoryText: 'v', defeatText: 'd' } });
const QFILE = path.join(DATA_DIR, 'q.json'); fs.writeFileSync(QFILE, JSON.stringify(quests));

(async () => {
  const bad = JSON.parse(JSON.stringify(eco)); bad.recipes[0].output = 'nope';
  const BADF = path.join(DATA_DIR, 'bad.json'); fs.writeFileSync(BADF, JSON.stringify(bad));
  const br = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, encoding: 'utf8', timeout: 8000, env: { ...process.env, PORT: String(PORT + 100), DATA_DIR: path.join(DATA_DIR, 'bad'), ECONOMY_FILE: BADF } });
  check('잘못된 economy.json → 시작 거부 + 한국어 오류', br.status !== 0 && /경제 콘텐츠\(economy\.json\) 오류/.test(br.stderr || ''), (br.stderr || '').slice(0, 160));

  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'test-admin-pass',
    AUTH_RATE_MAX: '500', ECONOMY_FILE: EFILE, QUESTS_FILE: QFILE, CHAT_RATE_MAX: '100', ROUND_MIN_SEC: '0', RNG_SEED: '5', ECON_RATE_MAX: '150' } });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 60 && !out.includes('서버 실행 중'); i++) await sleep(100);
  check('서버 기동', out.includes('서버 실행 중'), out);
  try {
    const adminC = (await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } })).cookie;
    const codes = (await req('POST', '/api/admin/invites', { cookie: adminC, body: { count: 3 } })).data.codes;
    const mk = async (i, name) => (await req('POST', '/api/register', { body: { username: 'tt' + i, password: 'password123', inviteCode: codes[i], charName: name } })).cookie;
    const A = await mk(0, '상인A'), B = await mk(1, '친구B'), C = await mk(2, '제3자');
    const inv = async (c) => (await req('GET', '/api/inventory', { cookie: c })).data.inv;
    const qty = (iv, id) => (iv.items.find((x) => x.id === id) || { qty: 0 }).qty;
    const post = (c, p, body) => req('POST', p, { cookie: c, body });
    const idOf = async (c) => (await req('GET', '/api/me', { cookie: c })).data.user.id;
    const aId = await idOf(A), bId = await idOf(B), cId = await idOf(C);

    console.log('\n[시작 상태]');
    let iv = await inv(A);
    check('시작 골드 100, 스태미나 가득', iv.gold === 100 && iv.stamina.cur === iv.stamina.max, iv);
    const me = (await req('GET', '/api/me', { cookie: A })).data;
    check('/api/me 에 경제 정의 포함', me.game.economy.items['steel-sword'] && me.game.economy.spots.length >= 3 && me.game.economy.jars[0].prizes.length > 0);
    check('비로그인 접근 불가', (await req('POST', '/api/farm', { body: { spotId: 'forest-edge' } })).status === 401);

    console.log('\n[채집]');
    check('없는 장소 400', (await post(A, '/api/farm', { spotId: 'x' })).status === 400);
    const lv = await post(A, '/api/farm', { spotId: 'old-mine' });
    check('레벨 부족 장소 거부', lv.status === 400 && /레벨 2/.test(lv.data.error), lv.data);
    const max = iv.stamina.max;
    for (let i = 0; i < max; i++) await post(A, '/api/farm', { spotId: 'sure-spot' });
    iv = await inv(A);
    check(`스태미나 ${max} 소모 후 확정 아이템 ${max}개`, qty(iv, 'mana-crystal') === max && iv.stamina.cur === 0 && iv.stamina.nextInSec > 0, iv);
    const nf = await post(A, '/api/farm', { spotId: 'sure-spot' });
    check('스태미나 0 이면 거부', nf.status === 400 && /체력/.test(nf.data.error) && qty(await inv(A), 'mana-crystal') === max, nf.data);
    const feedPosts = (await req('GET', '/api/feed', { cookie: A })).data.posts;
    check('희귀 이상 드롭은 타임라인에 공식 소식(#장터)으로 공지', feedPosts.filter((m) => m.isSystem && /마력 결정/.test(m.body) && /#장터/.test(m.body)).length === max, feedPosts.map((m) => m.body));

    console.log('\n[판매]');
    let r = await post(A, '/api/sell', { itemId: 'mana-crystal', qty: 0 });
    check('수량 0 거부', r.status === 400);
    r = await post(A, '/api/sell', { itemId: 'mana-crystal', qty: -5 });
    check('음수 수량 거부(골드 복사 방지)', r.status === 400 && (await inv(A)).gold === 100);
    r = await post(A, '/api/sell', { itemId: 'mana-crystal', qty: 1.5 });
    check('소수 수량 거부', r.status === 400);
    r = await post(A, '/api/sell', { itemId: 'mana-crystal', qty: max + 1 });
    check('가진 것보다 많이 못 팜', r.status === 400);
    r = await post(A, '/api/sell', { itemId: 'mana-crystal', qty: 2 });
    check('2개 판매 → 골드 +80', r.status === 200 && r.data.inv.gold === 180 && qty(r.data.inv, 'mana-crystal') === max - 2, r.data);
    r = await post(A, '/api/sell', { itemId: 'ghost', qty: 1 });
    check('없는 아이템 판매 거부', r.status === 400);

    console.log('\n[항아리]');
    r = await post(B, '/api/jar', { jarId: 'old-jar' });
    const bGold = r.data && r.data.inv ? r.data.inv.gold : (await inv(B)).gold;
    check('항아리 구매 → 골드 차감 후 결과', r.status === 200 && (r.data.result.item || r.data.result.gold !== undefined), r.data);
    r = await post(A, '/api/jar', { jarId: 'nope' });
    check('없는 항아리 400', r.status === 400);
    r = await post(A, '/api/jar', { jarId: 'junk-jar' });
    check('잡템 항아리: 녹슨 못 ×3', r.status === 200 && r.data.result.item === 'rusty-nail' && qty(r.data.inv, 'rusty-nail') === 3 && r.data.inv.gold === 179, r.data);
    r = await post(A, '/api/jar', { jarId: 'gold-jar' });
    check('골드 항아리: 10G 내고 30G 받음', r.status === 200 && r.data.inv.gold === 199, r.data);
    const poor = await mk2();
    async function mk2() { const cs = (await req('POST', '/api/admin/invites', { cookie: adminC, body: { count: 1 } })).data.codes; return (await req('POST', '/api/register', { body: { username: 'tt9', password: 'password123', inviteCode: cs[0], charName: '가난뱅이' } })).cookie; }
    for (let i = 0; i < 12; i++) await post(poor, '/api/jar', { jarId: 'gilded-jar' }); // 60G 항아리, 100G 로는 많아야 몇 번
    check('골드가 모자라면 항아리 구매 불가(음수 골드 없음)', (await inv(poor)).gold >= 0);
    r = await post(poor, '/api/sell', { itemId: 'mana-crystal', all: true });
    check('가진 게 없으면 전부 판매도 실패', r.status === 400);

    console.log('\n[제작]');
    r = await post(B, '/api/craft', { recipeId: 't-craft' });
    check('재료 부족 거부', r.status === 400 && /재료/.test(r.data.error), r.data);
    r = await post(A, '/api/craft', { recipeId: 'nope' });
    check('없는 제작법 400', r.status === 400);
    let swordMade = false, conserved = true;
    for (let i = 0; i < 25 && !swordMade; i++) {
      const before = await inv(A);
      if (qty(before, 'rusty-nail') < 2) await post(A, '/api/jar', { jarId: 'junk-jar' });
      const b2 = await inv(A);
      r = await post(A, '/api/craft', { recipeId: 't-craft' });
      if (r.status !== 200) { conserved = false; break; }
      const res = r.data.result, a = r.data.inv;
      const nailsExpected = qty(b2, 'rusty-nail') - (res.roll.success ? 2 : res.roll.fumble ? 1 : 0);
      if (qty(a, 'rusty-nail') !== nailsExpected || a.gold !== b2.gold - 5) conserved = false;
      if (res.roll.success) swordMade = qty(a, 'steel-sword') >= 1;
    }
    check('제작: 성공/실패/대실패에 따라 재료·수수료가 정확히 변함', swordMade && conserved);

    console.log('\n[장비]');
    r = await post(A, '/api/equip', { itemId: 'rusty-nail' });
    check('장비가 아닌 것은 장착 불가', r.status === 400);
    r = await post(A, '/api/equip', { itemId: 'iron-cuirass' });
    check('없는 장비 장착 불가', r.status === 400);
    const ac0 = (await req('GET', '/api/me', { cookie: A })).data.character.ac;
    await post(A, '/api/jar', { jarId: 'cuirass-jar' }); await post(A, '/api/jar', { jarId: 'vest-jar' }); await post(A, '/api/jar', { jarId: 'foot-jar' });
    r = await post(A, '/api/equip', { itemId: 'iron-cuirass' });
    check('방어구 장착 → 인벤토리에서 빠짐', r.status === 200 && r.data.inv.equipment.armor === 'iron-cuirass' && qty(r.data.inv, 'iron-cuirass') === 0, r.data);
    let ch = (await req('GET', '/api/me', { cookie: A })).data.character;
    check('방어도 +2 반영, 장비가 프로필에 노출', ch.ac === ac0 + 2 && ch.equipment.armor.name === '철 흉갑', ch);
    r = await post(A, '/api/equip', { itemId: 'quilted-vest' });
    check('같은 슬롯 교체 → 이전 장비는 인벤토리로', r.status === 200 && r.data.inv.equipment.armor === 'quilted-vest' && qty(r.data.inv, 'iron-cuirass') === 1, r.data);
    await post(A, '/api/equip', { itemId: 'rabbit-foot' });
    ch = (await req('GET', '/api/me', { cookie: A })).data.character;
    check('최대 HP +3 반영', ch.maxHp === 25 + 3, ch.maxHp);
    const other = (await req('GET', `/api/characters/${ch.id}`, { cookie: B })).data.character;
    check('다른 사람도 장착 장비를 볼 수 있음', other.equipment.trinket && other.equipment.trinket.name === '행운의 토끼발');
    r = await post(A, '/api/unequip', { slot: 'weapon' });
    check('장착 안 한 슬롯 해제 거부', r.status === 400);

    console.log('\n[선물]');
    const gift = (c, body) => post(c, '/api/gift', body);
    check('자기 자신 거부', (await gift(A, { toUserId: aId, gold: 5 })).status === 400);
    check('없는 사람 거부', (await gift(A, { toUserId: 99999, gold: 5 })).status === 400);
    check('시스템 계정에는 못 보냄', (await gift(A, { toUserId: 1, gold: 5 })).status === 400);
    check('빈 선물 거부', (await gift(A, { toUserId: bId })).status === 400);
    check('음수 골드 거부(복사 방지)', (await gift(A, { toUserId: bId, gold: -50 })).status === 400);
    check('소수 골드 거부', (await gift(A, { toUserId: bId, gold: 1.5 })).status === 400);
    check('문자열 골드 거부', (await gift(A, { toUserId: bId, gold: '50' })).status === 400);
    check('상한 초과 골드 거부', (await gift(A, { toUserId: bId, gold: 999999 })).status === 400);
    check('0 수량 아이템 거부', (await gift(A, { toUserId: bId, itemId: 'iron-cuirass', qty: 0 })).status === 400);
    check('가진 것보다 많은 골드 거부', (await gift(A, { toUserId: bId, gold: 4999 })).status === 400);
    r = await gift(A, { toUserId: bId, itemId: 'quilted-vest', qty: 1 });
    check('장착 중인 장비는 선물 불가', r.status === 400 && /해제/.test(r.data.error), r.data);
    const aBefore = await inv(A), bBefore = await inv(B);
    r = await gift(A, { toUserId: bId, itemId: 'iron-cuirass', qty: 1, gold: 20, message: '  힘내라!  ' });
    const aAfter = await inv(A), bAfter = await inv(B);
    check('아이템+골드 선물: 보낸 쪽 감소, 받는 쪽 증가(총량 보존)',
      r.status === 200 && aAfter.gold === aBefore.gold - 20 && bAfter.gold === bBefore.gold + 20 && qty(aAfter, 'iron-cuirass') === 0 && qty(bAfter, 'iron-cuirass') === 1, { aBefore, aAfter, bBefore, bAfter });
    const feed2 = (await req('GET', '/api/feed', { cookie: C })).data.posts;
    check('선물이 타임라인에 공개 공지', feed2.some((m) => m.isSystem && m.body.includes('🎁') && m.body.includes('상인A → 친구B') && m.body.includes('“힘내라!”')), feed2.slice(0, 2));
    const notif = (await req('GET', '/api/notifications', { cookie: B })).data;
    check('받는 사람에게 선물 알림', notif.items.some((n) => n.type === 'gift' && n.actor === '상인A' && /철 흉갑/.test(n.text)), notif);
    const hist = (await req('GET', '/api/gifts', { cookie: B })).data.gifts;
    check('선물 기록: 받은 선물 표시', hist[0].mine === 'received' && hist[0].from === '상인A' && /철 흉갑/.test(hist[0].what), hist);
    // 동시에 같은 골드를 여러 번 보내도 잔액 이상은 못 나감
    const bal = (await inv(B)).gold;
    const par = await Promise.all(Array.from({ length: 8 }, () => gift(B, { toUserId: (aId), gold: Math.floor(bal / 2) + 1 })));
    const okN = par.filter((x) => x.status === 200).length;
    const bEnd = await inv(B);
    check('동시 선물 8건: 잔액을 넘겨 보낼 수 없고 음수가 되지 않음', okN <= 1 && bEnd.gold >= 0 && bEnd.gold === bal - okN * (Math.floor(bal / 2) + 1), { okN, bal, end: bEnd.gold });
    await req('POST', `/api/admin/users/${cId}/ban`, { cookie: adminC });
    check('정지된 유저에게는 선물 불가', (await gift(A, { toUserId: cId, gold: 1 })).status === 400);

    console.log('\n[의뢰 보상 + 장비 효과]');
    await post(A, '/api/equip', { itemId: 'rabbit-foot' });
    await req('PUT', '/api/character', { cookie: A, body: { name: '상인A', class: '전사' } });
    const st = await req('POST', '/api/quests/easy/start', { cookie: A });
    check('(준비) 의뢰 시작', st.status === 200, st.data);
    const run = (await req('GET', `/api/runs/${st.data.runId}`, { cookie: A })).data.run;
    check('전투 참가자의 최대 HP 에 장비 보너스(+3) 반영', run.combat.players[0].maxHp === 28, run.combat && run.combat.players[0]);
    const g0 = (await inv(A)), h0 = qty(g0, 'herb');
    for (let i = 0; i < 10; i++) {
      const v = (await req('GET', `/api/runs/${st.data.runId}`, { cookie: A })).data.run;
      if (v.phase !== 'combat') break;
      await req('POST', `/api/runs/${st.data.runId}/act`, { cookie: A, body: { action: 'attack', rush: true } });
    }
    const g1 = await inv(A);
    check('의뢰 완료 보상: 골드 +30, 아이템 지급', g1.gold === g0.gold + 30 && qty(g1, 'herb') === h0 + 1, { before: g0.gold, after: g1.gold });
    const log = (await req('GET', `/api/threads/${st.data.threadId}/messages`, { cookie: A })).data.messages.map((m) => m.body).join('\n');
    check('보상 메시지에 골드·아이템 표시', /💰 30G/.test(log) && /약초 ×1/.test(log), log.slice(-200));

    console.log('\n[남용 방지]');
    let limited = 0;
    for (let i = 0; i < 160; i++) { const x = await post(B, '/api/sell', { itemId: 'ghost', qty: 1 }); if (x.status === 429) limited++; }
    check('경제 행동 도배는 429 로 제한', limited > 0, limited);
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
