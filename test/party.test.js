'use strict';
// 5단계 통합 테스트: 파티 모집 → 참가/나가기/내보내기 → 출발 → 함께 전투(적 HP 증가) → 전투불능 경험치 절반
//                   레이드: 관리자가 열기 → 인원 제한 없음 → 2페이즈 → 주간 보상 감소
// 실행: npm run test:party
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 5100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-party-'));
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

// 테스트 전용 의뢰
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'rules.json'), 'utf8'));
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'quests.json'), 'utf8'));
const combat = (enemy) => ({ intro: '⚔ 전투', ambushText: '💥 기습', enemies: [enemy], victoryText: '승리!', defeatText: '쓰러졌다…' });
real.quests.push(
  // 2인 파티: 첫 라운드에 HP 가 가장 낮은(동률이면 첫 참가자) 1명을 반드시 쓰러뜨리고, 이후엔 가만히 있는 적
  { id: 'duo', title: '둘이서', mode: 'party', minPlayers: 2, maxPlayers: 2, recommendedLevel: 1, summary: '둘', reward: { xp: 40, gold: 10 }, intro: '📜 둘이서',
    combat: combat({ id: 'brute', name: '난폭자', hp: 10, ac: -20, attackBonus: 40,
      intents: [{ type: 'strike', target: 'lowest_hp', dice: '2d20', bonus: 40, label: '내려친다' }, ...Array(6).fill({ type: 'guard', label: '숨 고르기' })] }) },
  // 레이드: 해가 없는 보스. HP 90% 아래면 2페이즈
  { id: 'mini-raid', title: '작은 레이드', mode: 'raid', recommendedLevel: 1, summary: '레이드', reward: { xp: 40, gold: 40, items: [{ id: 'herb', qty: 1 }] }, intro: '🐉 작은 레이드',
    combat: combat({ id: 'golem', name: '골렘', hp: 30, ac: -20, attackBonus: 0,
      intents: [{ type: 'guard', label: '버틴다' }], phase2: { at: 0.9, text: '눈이 붉게 빛난다!', intents: [{ type: 'guard', label: '분노하며 버틴다' }] } }) },
);
const QFILE = path.join(DATA_DIR, 'quests.test.json');
fs.writeFileSync(QFILE, JSON.stringify(real));

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'test-admin-pass', AUTH_RATE_MAX: '500',
      QUESTS_FILE: QFILE, RNG_SEED: '777', ROUND_DEADLINE_SEC: '60', ROUND_MIN_SEC: '0', CHAT_RATE_MAX: '100', ECON_RATE_MAX: '500' } });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 60 && !out.includes('서버 실행 중'); i++) await sleep(100);
  check('서버 기동', out.includes('서버 실행 중'), out);

  try {
    const adminC = (await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } })).cookie;
    const codes = (await req('POST', '/api/admin/invites', { cookie: adminC, body: { count: 6 } })).data.codes;
    const names = ['방장', '동료', '무직', '구경', '넷째', '다섯째'];
    const classes = ['전사', '전사', null, '성직자', '도적', '마법사'];
    const U = [];
    for (let i = 0; i < 6; i++) {
      const c = (await req('POST', '/api/register', { body: { username: 'pp' + i, password: 'password123', inviteCode: codes[i], charName: names[i] } })).cookie;
      if (classes[i]) await req('PUT', '/api/character', { cookie: c, body: { name: names[i], class: classes[i] } });
      U.push(c);
    }
    const [A, B, C, D, E5, F] = U;
    const me = async (c) => (await req('GET', '/api/me', { cookie: c })).data;
    const view = async (id, c = A) => (await req('GET', `/api/runs/${id}`, { cookie: c })).data.run;
    const msgs = async (tid) => (await req('GET', `/api/threads/${tid}/messages`, { cookie: D })).data.messages.map((m) => m.body);

    console.log('\n[파티 모집]');
    let r = await req('GET', '/api/quests', { cookie: A });
    const duoQ = r.data.quests.find((q) => q.id === 'duo');
    check('의뢰 목록에 모드·인원 표시', duoQ.mode === 'party' && duoQ.minPlayers === 2 && duoQ.maxPlayers === 2 && r.data.quests.find((q) => q.id === 'mini-raid').maxPlayers === null, duoQ);
    r = await req('POST', '/api/quests/duo/start', { cookie: A });
    check('파티 의뢰 시작 → 모집 방 생성', r.status === 200 && r.data.runId, r.data);
    const pRun = r.data.runId, pThread = r.data.threadId;
    let v = await view(pRun);
    check('모집 중 상태, 방장 1명', v.phase === 'recruiting' && v.members.length === 1 && v.isOwner && v.recruiting.canDepart === false, v);
    r = await req('GET', '/api/feed', { cookie: B });
    check('타임라인에 모집 소식', r.data.posts.some((p) => p.isSystem && /파티원을 모집/.test(p.body) && /#의뢰/.test(p.body)));
    r = await req('POST', '/api/quests/lost-cart/start', { cookie: A });
    check('모집 중엔 다른 의뢰 시작 불가(409)', r.status === 409);
    r = await req('POST', `/api/runs/${pRun}/depart`, { cookie: A });
    check('최소 인원 미달이면 출발 불가', r.status === 400 && /최소 2명/.test(r.data.error), r.data);
    v = await view(pRun, B);
    check('다른 사람에게는 참가 가능으로 보임', v.recruiting.canJoin && !v.isPlayer, v.recruiting);
    r = await req('POST', `/api/runs/${pRun}/join`, { cookie: C });
    check('클래스 없으면 참가 불가', r.status === 400 && /클래스/.test(r.data.error), r.data);
    r = await req('POST', `/api/runs/${pRun}/join`, { cookie: B });
    check('참가', r.status === 200, r.data);
    r = await req('POST', `/api/runs/${pRun}/join`, { cookie: B });
    check('중복 참가 불가', r.status === 400);
    r = await req('POST', `/api/runs/${pRun}/join`, { cookie: E5 });
    check('정원(2명)이 차면 참가 불가(409)', r.status === 409 && /정원/.test(r.data.error), r.data);
    r = await req('POST', '/api/quests/lost-cart/start', { cookie: B });
    check('참가자도 다른 의뢰 시작 불가(409)', r.status === 409);
    r = await req('POST', `/api/runs/${pRun}/depart`, { cookie: B });
    check('방장이 아니면 출발 불가(403)', r.status === 403);
    r = await req('POST', `/api/runs/${pRun}/kick`, { cookie: B, body: { userId: v.members[0].userId } });
    check('방장이 아니면 내보내기 불가(403)', r.status === 403);
    r = await req('POST', `/api/runs/${pRun}/leave`, { cookie: B });
    check('출발 전 나가기', r.status === 200 && (await view(pRun)).members.length === 1);
    await req('POST', `/api/runs/${pRun}/join`, { cookie: E5 });
    const eId = (await me(E5)).user.id;
    r = await req('POST', `/api/runs/${pRun}/kick`, { cookie: A, body: { userId: eId } });
    check('방장이 내보내기', r.status === 200 && (await view(pRun)).members.length === 1);
    r = await req('PUT', '/api/character', { cookie: E5, body: { name: '넷째', class: '전사' } });
    check('모집만 했다 빠진 사람은 클래스 변경 가능', r.status === 200, r.data);
    await req('POST', `/api/runs/${pRun}/join`, { cookie: B });
    const bodies = await msgs(pThread);
    check('참가·나가기·내보내기가 방에 기록', bodies.some((b) => /동료\(전사 Lv\.1\) 참가/.test(b)) && bodies.some((b) => /빠졌다/.test(b)) && bodies.some((b) => /제외되었다/.test(b)));

    console.log('\n[파티 전투]');
    r = await req('POST', `/api/runs/${pRun}/depart`, { cookie: A });
    check('출발 → 전투', r.status === 200 && (await view(pRun)).phase === 'combat', r.data);
    v = await view(pRun, B);
    check('적 HP 가 인원수에 맞춰 증가', v.combat.enemies[0].maxHp === Math.round(10 * (1 + RULES.party.hpScalePerPlayer)), v.combat.enemies[0]);
    check('비방장 참가자도 행동 가능', v.isPlayer && v.combat.me && v.combat.me.status === 'active', v.combat.me);
    r = await req('POST', `/api/runs/${pRun}/join`, { cookie: F });
    check('출발 후엔 참가 불가', r.status === 400);
    const aId = (await me(A)).user.id, bId = (await me(B)).user.id;
    r = await req('POST', `/api/runs/${pRun}/cheer`, { cookie: B, body: { targetUserId: aId } });
    check('싸우는 참가자는 응원 불가', r.status === 400 && /싸우는 중/.test(r.data.error), r.data);
    r = await req('POST', `/api/runs/${pRun}/cheer`, { cookie: D, body: { targetUserId: bId } });
    check('구경꾼은 응원 가능', r.status === 200, r.data);
    await req('POST', `/api/runs/${pRun}/act`, { cookie: A, body: { action: 'defend' } });
    v = await view(pRun);
    check('한 명만 고르면 라운드가 진행되지 않음', v.combat.round === 1 && v.combat.players.find((p) => p.userId === aId).submitted, v.combat.players);
    await req('POST', `/api/runs/${pRun}/act`, { cookie: B, body: { action: 'defend', rush: true } });
    v = await view(pRun);
    const koP = v.combat.players.find((p) => p.status === 'ko');
    check('모두 고르면 진행, 한 명 전투불능', v.combat.round === 2 && !!koP && v.phase === 'combat', v.combat.players);
    const survivor = koP.userId === aId ? B : A, fallen = koP.userId === aId ? A : B;
    r = await req('POST', `/api/runs/${pRun}/act`, { cookie: fallen, body: { action: 'attack' } });
    check('전투불능자는 행동 불가', r.status === 400);
    const before = { s: (await me(survivor)).character.xp, f: (await me(fallen)).character.xp };
    for (let i = 0; i < 8 && (await view(pRun)).phase === 'combat'; i++) await req('POST', `/api/runs/${pRun}/act`, { cookie: survivor, body: { action: 'attack', rush: true } });
    v = await view(pRun);
    check('남은 사람이 이기면 파티 승리', v.phase === 'won', v.phase);
    const after = { s: (await me(survivor)).character.xp, f: (await me(fallen)).character.xp };
    check('보상은 각자 전액, 전투불능자는 경험치 절반', after.s - before.s === 40 && after.f - before.f === 20, { before, after });
    r = await req('GET', '/api/feed', { cookie: D });
    check('완료 소식에 파티원 이름이 모두', r.data.posts.some((p) => p.isSystem && /방장/.test(p.body) && /동료/.test(p.body) && /완료했다/.test(p.body)));
    r = await req('POST', '/api/quests/lost-cart/start', { cookie: fallen });
    check('끝난 뒤엔 다른 의뢰 시작 가능', r.status === 200, r.data);
    await req('POST', `/api/runs/${r.data.runId}/abandon`, { cookie: fallen });

    console.log('\n[파티 조사·이탈]');
    r = await req('POST', '/api/quests/black-moon-warehouse/start', { cookie: A });
    const wRun = r.data.runId;
    await req('POST', `/api/runs/${wRun}/join`, { cookie: B });
    await req('POST', `/api/runs/${wRun}/depart`, { cookie: A });
    v = await view(wRun, B);
    check('조사 행동 수 = 기본 + (인원-1)', v.phase === 'investigation' && v.investigation.maxActions === RULES.investigation.maxActions + 1, v.investigation);
    r = await req('POST', `/api/runs/${wRun}/investigate`, { cookie: B, body: { choiceId: 'dockhand' } });
    check('방장이 아닌 참가자도 조사 가능', r.status === 200, r.data);
    r = await req('POST', `/api/runs/${wRun}/investigate`, { cookie: D, body: { choiceId: 'guards' } });
    check('구경꾼은 조사 불가(403)', r.status === 403);
    r = await req('POST', `/api/runs/${wRun}/advance`, { cookie: B });
    check('파티에서 전투 돌입은 방장만', r.status === 403);
    r = await req('POST', `/api/runs/${wRun}/leave`, { cookie: A });
    check('방장은 이탈 불가(포기만)', r.status === 400);
    r = await req('POST', `/api/runs/${wRun}/leave`, { cookie: B });
    check('참가자 이탈', r.status === 200 && (await view(wRun)).members.length === 1);
    r = await req('POST', `/api/runs/${wRun}/abandon`, { cookie: A });
    check('방장 포기 → 의뢰 종료', r.status === 200 && (await view(wRun)).phase === 'abandoned');

    console.log('\n[레이드]');
    r = await req('POST', '/api/quests/mini-raid/start', { cookie: A });
    check('유저는 레이드를 직접 시작 못 함(403)', r.status === 403);
    r = await req('GET', '/api/admin/raids', { cookie: adminC });
    check('관리자 레이드 목록', r.status === 200 && r.data.raids.some((x) => x.id === 'mini-raid' && !x.open), r.data);
    r = await req('GET', '/api/admin/raids', { cookie: A });
    check('일반 유저는 관리자 API 불가', r.status === 403);
    r = await req('POST', '/api/admin/raids/mini-raid/open', { cookie: adminC });
    check('관리자가 레이드 열기', r.status === 200 && r.data.runId, r.data);
    const rRun = r.data.runId, rThread = r.data.threadId;
    r = await req('POST', '/api/admin/raids/mini-raid/open', { cookie: adminC });
    check('같은 레이드 중복 열기 불가(409)', r.status === 409);
    r = await req('POST', '/api/admin/raids/duo/open', { cookie: adminC });
    check('레이드가 아닌 의뢰는 열 수 없음', r.status === 404);
    r = await req('GET', '/api/feed', { cookie: B });
    check('타임라인에 레이드 공지 #레이드', r.data.posts.some((p) => p.isSystem && /레이드/.test(p.body) && /#레이드/.test(p.body)));
    r = await req('GET', '/api/runs', { cookie: B });
    check('목록 맨 위에 모집 중 레이드', r.data.runs[0].id === rRun && r.data.runs[0].phase === 'recruiting' && r.data.runs[0].owner === '레이드', r.data.runs[0]);
    for (const c of [A, B]) await req('POST', `/api/runs/${rRun}/join`, { cookie: c });
    r = await req('POST', `/api/runs/${rRun}/depart`, { cookie: adminC });
    check('레이드 최소 3명 미달이면 출발 불가', r.status === 400 && /최소 3명/.test(r.data.error), r.data);
    for (const c of [D, E5, F]) await req('POST', `/api/runs/${rRun}/join`, { cookie: c });
    v = await view(rRun, B);
    check('레이드는 인원 제한 없이 5명 참가', v.members.length === 5 && v.maxPlayers === null && !v.recruiting.full, v.recruiting);
    r = await req('POST', `/api/runs/${rRun}/depart`, { cookie: A });
    check('레이드 출발은 관리자만', r.status === 403);
    r = await req('POST', `/api/runs/${rRun}/depart`, { cookie: adminC });
    check('관리자가 출발', r.status === 200, r.data);
    v = await view(rRun, B);
    check('레이드 보스 HP 가 5명에 맞춰 증가', v.combat.enemies[0].maxHp === Math.round(30 * (1 + RULES.party.hpScalePerPlayer * 4)), v.combat.enemies[0]);
    const xp0 = (await me(B)).character.xp;
    const players = [A, B, D, E5, F];
    for (let i = 0; i < 10 && (await view(rRun)).phase === 'combat'; i++) {
      for (const [k, c] of players.entries()) await req('POST', `/api/runs/${rRun}/act`, { cookie: c, body: { action: 'attack', rush: k === players.length - 1 } });
    }
    v = await view(rRun);
    const log = await msgs(rThread);
    check('레이드 승리', v.phase === 'won', v.phase);
    check('보스 2페이즈 전환이 로그에', log.some((b) => /골렘 — 2페이즈! 눈이 붉게 빛난다!/.test(b)), log.slice(-6));
    const xp1 = (await me(B)).character.xp;
    check('레이드 첫 클리어 보상 전액', xp1 - xp0 === 40, { xp0, xp1 });
    r = await req('GET', '/api/feed', { cookie: D });
    check('레이드 완료 소식', r.data.posts.some((p) => p.isSystem && /레이드를 완료했다/.test(p.body)));

    // 같은 주에 다시
    r = await req('POST', '/api/admin/raids/mini-raid/open', { cookie: adminC });
    const again = (await req('GET', '/api/runs', { cookie: B })).data.runs[0].id;
    for (const c of [B, D, E5]) await req('POST', `/api/runs/${again}/join`, { cookie: c });
    const gold0 = (await req('GET', '/api/inventory', { cookie: B })).data.inv.gold;
    await req('POST', `/api/runs/${again}/depart`, { cookie: adminC });
    for (let i = 0; i < 10 && (await view(again)).phase === 'combat'; i++) {
      for (const [k, c] of [B, D, E5].entries()) await req('POST', `/api/runs/${again}/act`, { cookie: c, body: { action: 'attack', rush: k === 2 } });
    }
    const xp2 = (await me(B)).character.xp;
    const gold1 = (await req('GET', '/api/inventory', { cookie: B })).data.inv.gold;
    check('같은 주 재클리어: 경험치·골드 감소', (await view(again)).phase === 'won' && xp2 - xp1 === Math.round(40 * RULES.repeatXpRatio) && gold1 - gold0 === Math.round(40 * RULES.repeatXpRatio), { xp1, xp2, gold0, gold1 });
    check('감소 안내 메시지', (await msgs((await view(again)).threadId)).some((b) => /이번 주에 이미 클리어/.test(b)));

    // 모집 중 관리자 취소
    await req('POST', '/api/admin/raids/mini-raid/open', { cookie: adminC });
    const third = (await req('GET', '/api/runs', { cookie: B })).data.runs[0].id;
    await req('POST', `/api/runs/${third}/join`, { cookie: B });
    r = await req('POST', `/api/runs/${third}/abandon`, { cookie: adminC });
    check('관리자가 레이드 모집 취소', r.status === 200 && (await view(third)).phase === 'cancelled', r.data);
    r = await req('POST', '/api/quests/lost-cart/start', { cookie: B });
    check('취소되면 참가자가 풀려남', r.status === 200, r.data);
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
