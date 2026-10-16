'use strict';
// 6단계(잼컨) 통합 테스트: 오늘의 운세·연속 출석 · 업적·칭호 · 소모품 · 항아리 흔들기/쿨타임
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const X = require('../economy');
const ROOT = path.join(__dirname, '..');
const PORT = 4900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-fun-'));
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

// ---- 순수 함수 ----
console.log('[운세 계산]');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'economy.json'), 'utf8'));
const t0 = Date.UTC(2026, 9, 16, 14, 59); // 한국 시간 23:59
check('날짜는 한국 시간 기준 (UTC 14:59 → 같은 날, 15:00 → 다음 날)', X.dayKey(base, t0) === '2026-10-16' && X.dayKey(base, t0 + 60000) === '2026-10-17');
check('어제 날짜', X.prevDayKey(base, t0 + 60000) === '2026-10-16');
const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
let f = X.rollFortune(seq([0]), base, 3);
check('연속 3일 → 보너스 골드 = streakGold × 3', f.streakGold === base.daily.streakGold * 3 && f.streakItem === null, f);
f = X.rollFortune(seq([0]), base, 30);
check('보너스 골드는 streakCap 일까지만', f.streakGold === base.daily.streakGold * base.daily.streakCap);
f = X.rollFortune(seq([0]), base, 7);
check('7일째에는 연속 출석 아이템', f.streakItem === base.daily.streakItem);
const badEco = JSON.parse(JSON.stringify(base));
badEco.achievements.push({ id: 'zz', name: '이상한', desc: '', counter: 'nope', goal: 0, gold: 1 });
badEco.daily.fortunes[0].gold = [5, 1];
let msg = '';
try { X.validateEconomy(badEco, {}, { quests: [] }); } catch (e) { msg = e.message; }
check('잘못된 업적 counter·goal, 운세 gold 를 한국어로 알려줌', /모르는 counter "nope"/.test(msg) && /goal 은 1 이상/.test(msg) && /운세 great: gold/.test(msg), msg);

// ---- 테스트 전용 콘텐츠: 운세는 항상 대길(효과 크게), 업적은 낮은 목표 ----
const eco = JSON.parse(JSON.stringify(base));
eco.daily.fortunes = [{ id: 'great', name: '대길', weight: 1, announce: true, gold: [10, 10], stamina: 3, craftBonus: 30, farmDouble: 100, texts: ['테스트 운세'] }];
eco.spots.push({ id: 'sure-spot', name: '확정 채집지', minLevel: 1, cost: 1, desc: 't', drops: [{ item: 'herb', weight: 1 }] });
eco.recipes.push({ id: 't-hard', name: '어려운 제작', output: 'herb-tea', inputs: { herb: 1 }, gold: 0, stat: 'int', dc: 25 });
eco.jars.push({ id: 'gold-jar', name: '금 항아리', price: 10, desc: 't', prizes: [{ gold: [50, 50], weight: 1 }] });
eco.settings.jarCooldownSec = 3; eco.settings.jarShakeSec = 1;
eco.achievements = [
  { id: 'farm-2', name: '두번채집', desc: '채집 2번', counter: 'farm', goal: 2, gold: 7 },
  { id: 'secret', name: '비밀', desc: '숨김', counter: 'craft_fumble', goal: 99, gold: 0, hidden: true },
  { id: 'liked', name: '하트둘', desc: '하트 2개', counter: 'like_received', goal: 2, gold: 0 },
  { id: 'luck', name: '대길한번', desc: '대길', counter: 'fortune_great', goal: 1, gold: 0, quiet: true },
  { id: 'jar1', name: '항아리한번', desc: '항아리', counter: 'jar', goal: 1, gold: 0, quiet: true },
];
const EFILE = path.join(DATA_DIR, 'eco.json'); fs.writeFileSync(EFILE, JSON.stringify(eco));

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'test-admin-pass',
    AUTH_RATE_MAX: '500', ECONOMY_FILE: EFILE, CHAT_RATE_MAX: '100', RNG_SEED: '9', ECON_RATE_MAX: '150' } });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 60 && !out.includes('서버 실행 중'); i++) await sleep(100);
  check('서버 기동', out.includes('서버 실행 중'), out);
  try {
    const adminC = (await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } })).cookie;
    const codes = (await req('POST', '/api/admin/invites', { cookie: adminC, body: { count: 3 } })).data.codes;
    const mk = async (i, name) => (await req('POST', '/api/register', { body: { username: 'ff' + i, password: 'password123', inviteCode: codes[i], charName: name } })).cookie;
    const A = await mk(0, '운세A'), B = await mk(1, '하트B'), C = await mk(2, '하트C');
    const post = (c, p, body) => req('POST', p, { cookie: c, body });
    const inv = async (c) => (await req('GET', '/api/inventory', { cookie: c })).data.inv;
    const qty = (iv, id) => (iv.items.find((x) => x.id === id) || { qty: 0 }).qty;
    const feedText = async () => (await req('GET', '/api/feed', { cookie: A })).data.posts.map((p) => p.body).join('\n');

    console.log('\n[오늘의 운세]');
    let d = (await req('GET', '/api/daily', { cookie: A })).data;
    check('처음엔 오늘 운세 없음', d.today === null && d.streak === 0, d);
    // 체력 3 소모 → 운세로 3 회복되는지 보기 위해 먼저 채집 (운세 전이라 2배 없음)
    for (let i = 0; i < 3; i++) await post(A, '/api/farm', { spotId: 'sure-spot' });
    let iv = await inv(A);
    check('운세 전 채집은 1개씩', qty(iv, 'herb') === 3, iv.items);
    const g0 = iv.gold, s0 = iv.stamina.cur;
    let r = await post(A, '/api/daily');
    check('운세 뽑기 → 대길, 연속 1일', r.status === 200 && r.data.result.name === '대길' && r.data.result.streak === 1, r.data);
    check('골드(운세 10 + 연속 보너스) 지급', r.data.inv.gold === g0 + 10 + eco.daily.streakGold, { before: g0, after: r.data.inv.gold });
    check('체력 +3 회복', r.data.inv.stamina.cur === s0 + 3, { s0, s1: r.data.inv.stamina.cur });
    r = await post(A, '/api/daily');
    check('하루 두 번은 안 됨', r.status === 400 && /이미/.test(r.data.error), r.data);
    d = (await req('GET', '/api/daily', { cookie: A })).data;
    check('오늘 운세가 남아 있음 (효과 표시 포함)', d.today && d.today.name === '대길' && d.today.craftBonus === 30 && d.streak === 1, d);
    check('대길은 타임라인에 #운세 로 공지', /운세A의 오늘 운세는 【대길】/.test(await feedText()));

    console.log('\n[운세 효과]');
    r = await post(A, '/api/farm', { spotId: 'sure-spot' });
    check('채집 2배 확률 100% → 2개, lucky 표시', r.data.result.qty === 2 && r.data.result.lucky === true, r.data.result);
    r = await post(A, '/api/craft', { recipeId: 't-hard' });
    check('제작 판정에 운세 보너스 +30 반영', r.status === 200 && r.data.result.roll.bonus >= 30, r.data);
    // 소모품 테스트용 약초차 확보 (주사위 1 대실패만 아니면 성공)
    for (let i = 0; i < 4 && !r.data.result.qty; i++) r = await post(A, '/api/craft', { recipeId: 't-hard' });

    console.log('\n[업적·칭호]');
    let a = (await req('GET', '/api/achievements', { cookie: A })).data;
    const ach = (id) => a.achievements.find((x) => x.id === id);
    check('채집 2번 업적 달성 (진행도 2/2)', ach('farm-2').earned && ach('farm-2').progress === 2 && ach('farm-2').holders === 1, ach('farm-2'));
    check('운세 업적(fortune_great) 달성', ach('luck').earned);
    check('숨겨진 업적은 이름·설명 숨김', ach('secret').name === '???' && !ach('secret').earned);
    const notifs = (await req('GET', '/api/notifications', { cookie: A })).data.items;
    check('업적 알림', notifs.some((n) => n.type === 'achievement' && /두번채집/.test(n.text)), notifs);
    const ft = await feedText();
    check('업적 공지(#업적), quiet 업적은 공지 안 함', /업적 「두번채집」/.test(ft) && !/대길한번/.test(ft));
    r = await post(A, '/api/character/badge', { id: 'secret' });
    check('못 얻은 칭호는 못 닮', r.status === 400, r.data);
    r = await post(A, '/api/character/badge', { id: 'nope' });
    check('없는 칭호 거부', r.status === 400);
    r = await post(A, '/api/character/badge', { id: 'farm-2' });
    check('얻은 칭호 달기', r.status === 200 && r.data.badge === 'farm-2');
    const me = (await req('GET', '/api/me', { cookie: A })).data.character;
    check('프로필에 칭호 표시', me.badge === '두번채집', me.badge);
    const pr = await post(A, '/api/posts', { body: '칭호 자랑' });
    check('타임라인 글에도 칭호', pr.data.post.user.badge === '두번채집', pr.data.post.user);
    const other = (await req('GET', `/api/characters/${me.id}/achievements`, { cookie: B })).data;
    check('다른 사람은 얻은 업적만 봄', other.achievements.some((x) => x.id === 'farm-2') && !other.achievements.some((x) => x.id === 'secret') && other.total === 5, other);
    await post(A, '/api/character/badge', { id: '' });
    check('칭호 떼기', (await req('GET', '/api/me', { cookie: A })).data.character.badge === '');

    console.log('\n[하트 업적: 껐다 켜기 어뷰징 방지]');
    const pid = pr.data.post.id;
    for (let i = 0; i < 3; i++) await post(B, `/api/posts/${pid}/like`);
    a = (await req('GET', '/api/achievements', { cookie: A })).data;
    check('같은 사람이 하트를 껐다 켜도 1개로 셈', ach('liked').progress === 1 && !ach('liked').earned, ach('liked'));
    await post(C, `/api/posts/${pid}/like`);
    a = (await req('GET', '/api/achievements', { cookie: A })).data;
    check('다른 사람 하트로 2개 → 달성', ach('liked').earned);

    console.log('\n[소모품]');
    r = await post(B, '/api/use', { itemId: 'herb-tea' });
    check('없는 소모품 사용 거부', r.status === 400);
    r = await post(A, '/api/use', { itemId: 'herb' });
    check('소모품이 아닌 것 사용 거부', r.status === 400 && /사용할 수 없는/.test(r.data.error));
    iv = await inv(A);
    if (qty(iv, 'herb-tea') > 0) {
      const before = iv.stamina.cur;
      r = await post(A, '/api/use', { itemId: 'herb-tea' });
      check('약초차 사용 → 체력 회복, 1개 소모', r.status === 200 && r.data.inv.stamina.cur === Math.min(iv.stamina.max, before + 2) && qty(r.data.inv, 'herb-tea') === qty(iv, 'herb-tea') - 1, r.data);
    } else check('제작한 약초차가 가방에 있음', false, iv.items);

    console.log('\n[도박항아리: 흔들기 + 쿨타임]');
    const gb = (await inv(B)).gold;
    r = await post(B, '/api/jar', { jarId: 'gold-jar' });
    check('깨면 결과 대신 흔드는 중(pending)', r.status === 200 && r.data.pending && r.data.result === undefined && r.data.inv.gold === gb - 10, r.data);
    let st = (await req('GET', '/api/jar/state', { cookie: C })).data;
    check('다른 사람에게도 "흔드는 중" 보임', st.shaking.some((x) => x.name === '하트B' && x.jarName === '금 항아리'), st);
    r = await post(B, '/api/jar', { jarId: 'gold-jar' });
    check('흔드는 중에는 또 못 깸', r.status === 400 && /흔들고/.test(r.data.error), r.data);
    check('흔드는 동안은 골드 미지급', (await inv(B)).gold === gb - 10);
    await sleep(1300);
    st = (await req('GET', '/api/jar/state', { cookie: B })).data;
    check('시간이 지나면 결과 공개', st.mine.last && st.mine.last.gold === 50 && !st.shaking.length, st);
    check('결과 골드 지급', (await inv(B)).gold === gb - 10 + 50);
    r = await post(B, '/api/jar', { jarId: 'gold-jar' });
    check('쿨타임 중에는 못 깸 (남은 시간 안내)', r.status === 400 && /한 번만/.test(r.data.error) && st.cooldownLeftSec > 0, r.data);
    a = (await req('GET', '/api/achievements', { cookie: B })).data;
    check('항아리 업적 카운트', ach('jar1').earned);
    await sleep(2000);
    r = await post(B, '/api/jar', { jarId: 'gold-jar' });
    check('쿨타임이 지나면 다시 깰 수 있음', r.status === 200 && r.data.pending, r.data);
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
