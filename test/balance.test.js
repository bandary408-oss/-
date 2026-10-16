'use strict';
// 밸런스 조정(관리자 [밸런스] 탭) 테스트: 검증·즉시 반영·저장·재시작 후 유지·되돌리기
// 실행: npm run test:balance
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const E = require('../engine');
const X = require('../economy');
const { createBalance } = require('../balance');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));
const validate = (d) => { E.validateContent(d.rules, d.quests); X.validateEconomy(d.economy, d.rules, d.quests); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

function unit() {
  console.log('[모듈]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-bal-'));
  const mk = () => {
    const live = { rules: load('rules.json'), quests: load('quests.json'), economy: load('economy.json') };
    let applied = 0;
    const logs = [];
    const b = createBalance({ dataDir: dir, base: live, live, validate, onApply: () => applied++, log: { log: (m) => logs.push(m), warn: (m) => logs.push(m) } });
    b.init();
    return { b, live, applied: () => applied, logs };
  };
  const { b, live } = mk();
  const settingsRef = live.economy.settings;
  const enemyRef = live.quests.quests[0].combat.enemies[0];
  const v = b.view();
  const keys = new Set(v.fields.map((f) => f.key));
  check('적 HP·스킬 쿨타임·주사위·항아리 가격이 조정 목록에 있음',
    ['quests:quests/lost-cart/combat/enemies/boss/hp', 'rules:classes/전사/skill/cooldown', 'rules:classes/마법사/skill/dice',
      'economy:jars/old-jar/price', 'economy:spots/forest-edge/drops/0/weight'].every((k) => keys.has(k)));
  check('파티·레이드 수치(인원, HP 배율, 보스 2페이즈)도 목록에 있음',
    ['rules:party/hpScalePerPlayer', 'rules:party/koXpRatio', 'quests:quests/black-moon-warehouse/maxPlayers',
      'quests:quests/moon-serpent/minPlayers', 'quests:quests/moon-serpent/combat/enemies/serpent/phase2/at'].every((k) => keys.has(k)));
  check('2페이즈 시작 비율 1 은 규칙 검사로 거부', /phase2\.at/.test(throws(() => b.update({ 'quests:quests/moon-serpent/combat/enemies/serpent/phase2/at': 1 }))));
  check('설명 문구(_설명)·이름은 목록에 없음', ![...keys].some((k) => k.includes('_설명') || k.endsWith('/name')));
  check('조사 선택지 난이도는 고르기 칸', v.fields.find((f) => f.key.endsWith('choices/tracks/difficulty')).kind === 'choice');

  check('HP 0 은 거부', /1 이상/.test(throws(() => b.update({ 'quests:quests/lost-cart/combat/enemies/boss/hp': 0 }))));
  check('음수는 거부', /음수/.test(throws(() => b.update({ 'economy:settings/startGold': -5 }))));
  check('글자는 거부', /숫자/.test(throws(() => b.update({ 'economy:settings/startGold': 'abc' }))));
  check('주사위 표기 아니면 거부', /주사위/.test(throws(() => b.update({ 'rules:classes/전사/weapon': '8' }))));
  check('없는 항목은 거부', /알 수 없는/.test(throws(() => b.update({ 'rules:nope': 1 }))));
  check('규칙 검사 실패(경험치 순서 뒤집힘)도 거부', /level\.xp/.test(throws(() => b.update({ 'rules:level/xp/2': 10 }))));
  check('거부되면 아무것도 안 바뀜', enemyRef.hp === 26 && settingsRef.startGold === 100 && !fs.existsSync(b.file));

  const r = b.update({ 'quests:quests/lost-cart/combat/enemies/boss/hp': '40', 'economy:settings/startGold': 250, 'rules:classes/마법사/skill/dice': '2D6' }, { by: 'boss', note: '테스트' });
  check('정상 값은 저장되고 개수 반환', r.changed === 3, r);
  check('즉시 반영: 같은 객체의 값이 바뀜(참조 유지)', live.economy.settings === settingsRef && settingsRef.startGold === 250 && enemyRef.hp === 40);
  check('주사위는 소문자로 정리', live.rules.classes['마법사'].skill.dice === '2d6');
  check('data 폴더에 저장됨', fs.existsSync(b.file));
  check('content 파일은 그대로', load('economy.json').settings.startGold === 100);
  const v2 = b.view();
  const hpF = v2.fields.find((f) => f.key.endsWith('boss/hp'));
  check('화면: 현재값·기본값·조정됨 표시', hpF.value === 40 && hpF.base === 26 && hpF.changed === true);
  check('기록 #1 에 바뀐 내용', v2.history[0].id === 1 && v2.history[0].changes.length === 3 && v2.history[0].note === '테스트');

  b.update({ 'economy:settings/startGold': 100 });
  check('기본값과 같게 바꾸면 조정 해제', !b.view().fields.find((f) => f.key === 'economy:settings/startGold').changed);

  // 재시작 흉내: 새 인스턴스가 저장된 값을 다시 적용
  const two = mk();
  check('재시작 후에도 조정값 유지', two.live.quests.quests[0].combat.enemies[0].hp === 40 && two.live.economy.settings.startGold === 100);
  check('재시작 로그', two.logs.some((m) => /조정값 2개 적용/.test(m)), two.logs);

  two.b.revertBefore(2);
  check('#2 이전으로 되돌리기 → 시작 골드 250', two.live.economy.settings.startGold === 250);
  two.b.revert(1);
  check('#1 시점으로 맞추기', two.live.economy.settings.startGold === 250 && two.live.quests.quests[0].combat.enemies[0].hp === 40);
  two.b.reset();
  check('모두 기본값으로', two.live.economy.settings.startGold === 100 && two.live.quests.quests[0].combat.enemies[0].hp === 26 && two.live.rules.classes['마법사'].skill.dice === 'd6');
  check('기록은 남음 (같은 상태로 맞추기는 기록 안 함)', two.b.view().history.length === 4);

  // 콘텐츠가 바뀌어 맞지 않는 조정값: 경고만 남기고 원본으로 시작
  fs.writeFileSync(two.b.file, JSON.stringify({ overrides: { 'rules:level/xp/2': 5, 'rules:gone/away': 3 }, history: [] }));
  const three = mk();
  check('맞지 않는 조정값 → 경고 + 원본 유지', three.live.rules.level.xp[2] === 80 && three.b.view().warnings.length === 2, three.b.view().warnings);
}

async function server() {
  console.log('[서버]');
  const PORT = 5100 + Math.floor(Math.random() * 400);
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-bals-'));
  async function req(method, p, { body, cookie } = {}) {
    const h = {}; if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : null;
    return { status: res.status, data: ct.includes('json') ? await res.json() : null, cookie: sc ? sc.split(';')[0] : null, headers: res.headers };
  }
  const start = async () => {
    const sv = spawn(process.execPath, ['server.js'], { cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'test-admin-pass', AUTH_RATE_MAX: '500' } });
    sv.out = ''; sv.stdout.on('data', (d) => (sv.out += d)); sv.stderr.on('data', (d) => (sv.out += d));
    for (let i = 0; i < 60 && !sv.out.includes('서버 실행 중'); i++) await sleep(100);
    return sv;
  };
  const stop = (sv) => new Promise((r) => { sv.once('exit', r); sv.kill(); });

  let sv = await start();
  check('서버 기동', sv.out.includes('서버 실행 중'), sv.out);
  try {
    const adminC = (await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } })).cookie;
    const codes = (await req('POST', '/api/admin/invites', { cookie: adminC, body: { count: 3 } })).data.codes;
    const mk = async (i) => (await req('POST', '/api/register', { body: { username: 'bal' + i, password: 'password123', inviteCode: codes[i], charName: '밸런스' + i } })).cookie;
    const U = await mk(0);

    check('일반 유저는 밸런스 API 접근 불가', (await req('GET', '/api/admin/balance', { cookie: U })).status === 403);
    check('일반 유저는 변경 불가', (await req('POST', '/api/admin/balance', { cookie: U, body: { changes: { 'economy:settings/startGold': 9 } } })).status === 403);
    const g = await req('GET', '/api/admin/balance', { cookie: adminC });
    check('관리자 목록 조회', g.status === 200 && g.data.fields.length > 100);

    let me = (await req('GET', '/api/me', { cookie: U })).data;
    check('스킬 설명 칸이 수치로 채워짐', me.game.classes['전사'].skill.desc.includes('피해를 6 줄인다') && me.game.classes['마법사'].skill.desc.includes('d6+지능'), me.game.classes);

    let r = await req('POST', '/api/admin/balance', { cookie: adminC, body: { changes: { 'quests:quests/lost-cart/combat/enemies/boss/hp': 0 } } });
    check('잘못된 값 → 400 + 한국어 이유', r.status === 400 && /1 이상/.test(r.data.error), r.data);

    r = await req('POST', '/api/admin/balance', { cookie: adminC, body: { note: '시작 골드 올림', changes: {
      'economy:settings/startGold': 333, 'rules:combat/shieldReduce': 9, 'rules:classes/마법사/skill/dice': '2d4',
      'quests:quests/lost-cart/reward/xp': 55, 'rules:round/deadlineSec': 120 } } });
    check('저장 성공', r.status === 200 && r.data.changed === 5, r.data);
    const U2 = await mk(1);
    check('재시작 없이 반영: 새 가입자 시작 골드', (await req('GET', '/api/inventory', { cookie: U2 })).data.inv.gold === 333);
    me = (await req('GET', '/api/me', { cookie: U })).data;
    check('스킬 설명도 새 수치로', me.game.classes['전사'].skill.desc.includes('9 줄인다') && me.game.classes['마법사'].skill.desc.includes('2d4+지능'));
    check('라운드 제한 시간 반영', me.game.deadlineSec === 120);
    const qs = (await req('GET', '/api/quests', { cookie: U })).data.quests;
    check('의뢰 보상 반영', qs.find((x) => x.id === 'lost-cart').rewardXp === 55);
    const ex = await req('GET', '/api/admin/balance/export', { cookie: adminC });
    check('현재 수치 내려받기', ex.status === 200 && ex.data.economy.settings.startGold === 333 && /attachment/.test(ex.headers.get('content-disposition') || ''));

    await stop(sv);
    sv = await start();
    check('재시작 후 다시 적용 로그', /조정값 5개 적용/.test(sv.out), sv.out);
    const U3 = await mk(2);
    check('재시작 후에도 시작 골드 유지', (await req('GET', '/api/inventory', { cookie: U3 })).data.inv.gold === 333);
    const adminC2 = (await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } })).cookie;
    r = await req('POST', '/api/admin/balance/revert', { cookie: adminC2, body: { id: 1, mode: 'before' } });
    check('되돌리기', r.status === 200 && r.data.fields.find((f) => f.key === 'economy:settings/startGold').value === 100);
    me = (await req('GET', '/api/me', { cookie: U })).data;
    check('되돌린 뒤 설명도 원래대로', me.game.classes['전사'].skill.desc.includes('6 줄인다') && me.game.deadlineSec === 90);
    check('기록 2개 (변경 + 되돌림)', r.data.history.length === 2 && r.data.history[0].by === 'boss');
  } finally {
    await stop(sv);
  }
}

(async () => {
  try { unit(); await server(); } catch (e) { failed++; console.error(e); }
  console.log(`결과: ${passed} 통과, ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})();
