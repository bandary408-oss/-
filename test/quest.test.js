'use strict';
// 3단계 통합 테스트: 의뢰 시작 → 조사 → 전투 → 응원 → 타이머 → 전투불능(발언 차단/강제 귀환) → 보상/레벨업
// 실행: npm run test:quest   (smoke.js 와 별도의 임시 서버를 띄웁니다)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { io: ioClient } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 4900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-quest-'));
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
const connect = (cookie) => new Promise((resolve, reject) => {
  const s = ioClient(BASE, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false });
  s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});
const waitEvent = (s, ev, ms = 3000) => new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); s.once(ev, (d) => { clearTimeout(t); resolve(d === undefined ? true : d); }); });
const sendChat = (s, payload) => new Promise((resolve) => s.emit('chat:send', payload, resolve));

// 테스트 전용 의뢰: 진짜 의뢰 + 즉사급 적(deadly) + 허수아비(easy)
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'quests.json'), 'utf8'));
const mkQuest = (id, title, enemy, xp) => ({
  id, title, mode: 'solo', recommendedLevel: 1, summary: title, reward: { xp },
  intro: `📜 ${title}`,
  combat: { intro: '⚔ 전투', ambushText: '💥 기습', enemies: [enemy], victoryText: '승리!', defeatText: '쓰러졌다…' },
});
real.quests.push(
  mkQuest('deadly', '즉사 함정', { id: 'ogre', name: '식인귀', hp: 999, ac: 5, attackBonus: 30, intents: [{ type: 'strike', target: 'lowest_hp', dice: '2d20', bonus: 10, label: '내려친다' }] }, 10),
  mkQuest('easy', '허수아비', { id: 'dummy', name: '허수아비', hp: 1, ac: 1, attackBonus: 0, intents: [{ type: 'guard', label: '멍하니 서 있다' }] }, 40),
);
const QFILE = path.join(DATA_DIR, 'quests.test.json');
fs.writeFileSync(QFILE, JSON.stringify(real));

(async () => {
  // 잘못된 콘텐츠면 시작 단계에서 한국어로 멈추는지
  const badFile = path.join(DATA_DIR, 'bad.json');
  const bad = JSON.parse(JSON.stringify(real)); bad.quests[0].combat.enemies[0].hp = 'x';
  fs.writeFileSync(badFile, JSON.stringify(bad));
  const badRun = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, encoding: 'utf8', timeout: 8000,
    env: { ...process.env, PORT: String(PORT + 100), DATA_DIR: path.join(DATA_DIR, 'bad'), QUESTS_FILE: badFile } });
  check('잘못된 의뢰 JSON → 시작 거부 + 한국어 오류', badRun.status !== 0 && /콘텐츠\(JSON\) 오류/.test(badRun.stderr || ''), (badRun.stderr || '').slice(0, 200));

  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'test-admin-pass', AUTH_RATE_MAX: '500',
      QUESTS_FILE: QFILE, RNG_SEED: '12345', ROUND_DEADLINE_SEC: '2', ROUND_MIN_SEC: '0', CHAT_RATE_MAX: '100' } });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 60 && !out.includes('서버 실행 중'); i++) await sleep(100);
  check('서버 기동', out.includes('서버 실행 중'), out);

  try {
    let r = await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } });
    const adminC = r.cookie;
    const codes = (await req('POST', '/api/admin/invites', { cookie: adminC, body: { count: 4 } })).data.codes;
    const mk = async (i, name) => (await req('POST', '/api/register', { body: { username: 'qq' + i, password: 'password123', inviteCode: codes[i], charName: name } })).cookie;
    const A = await mk(0, '카이런'), B = await mk(1, '구경꾼'), C = await mk(2, '불운이'), D = await mk(3, '벼락부자');
    const me = async (c) => (await req('GET', '/api/me', { cookie: c })).data;

    console.log('\n[시작 조건]');
    const m0 = await me(A);
    check('캐릭터 시트: 레벨1·HP25·스탯', m0.character.level === 1 && m0.character.maxHp === 25 && m0.game.classes['전사'], m0.character);
    r = await req('POST', '/api/quests/lost-cart/start', { cookie: A });
    check('클래스 없이 시작 → 400', r.status === 400, r.data);
    r = await req('PUT', '/api/character', { cookie: A, body: { name: '카이런', class: '전사' } });
    check('클래스 선택', r.status === 200 && r.data.character.stats.str === 3, r.data);
    r = await req('POST', '/api/quests/nope/start', { cookie: A });
    check('없는 의뢰 → 404', r.status === 404);

    console.log('\n[조사]');
    const sA = await connect(A), sB = await connect(B), sC = await connect(C);
    r = await req('POST', '/api/quests/lost-cart/start', { cookie: A });
    check('의뢰 시작', r.status === 200 && r.data.runId && r.data.threadId, r.data);
    const { runId, threadId } = r.data;
    r = await req('POST', '/api/quests/lost-cart/start', { cookie: A });
    check('진행 중인 의뢰가 있으면 다시 시작 불가(409)', r.status === 409 && r.data.runId === runId, r.data);
    r = await req('PUT', '/api/character', { cookie: A, body: { name: '카이런', class: '도적' } });
    check('의뢰 시작 후 클래스 변경 불가', r.status === 400 && /클래스/.test(r.data.error), r.data);
    r = await req('PUT', '/api/character', { cookie: A, body: { name: '카이런', class: '전사', title: '한 줄' } });
    check('같은 클래스로 프로필 수정은 가능', r.status === 200);

    r = await req('GET', `/api/runs/${runId}`, { cookie: B });
    const v0 = r.data.run;
    check('구경꾼도 의뢰 상태를 볼 수 있음(참가자 아님)', v0.phase === 'investigation' && !v0.isPlayer && v0.investigation.choices.length === 4, v0);
    check('조사 선택지에 스탯·난이도 표시', v0.investigation.choices[0].statName === '지능' && v0.investigation.choices[0].diffLabel === '보통');
    r = await req('POST', `/api/runs/${runId}/investigate`, { cookie: B, body: { choiceId: 'tracks' } });
    check('구경꾼은 조사 불가(403)', r.status === 403);
    r = await req('POST', `/api/runs/${runId}/act`, { cookie: A, body: { action: 'attack' } });
    check('조사 중엔 전투 행동 불가(400)', r.status === 400);
    r = await req('POST', `/api/runs/${runId}/investigate`, { cookie: A, body: { choiceId: 'zzz' } });
    check('없는 선택지 400', r.status === 400);

    const evUpdate = waitEvent(sB, 'run:update');
    r = await req('POST', `/api/runs/${runId}/investigate`, { cookie: A, body: { choiceId: 'tracks', line: '발자국을 살핀다' } });
    check('조사 성공 응답', r.status === 200);
    check('구경꾼에게 run:update 이벤트', (await evUpdate) && true);
    r = await req('POST', `/api/runs/${runId}/investigate`, { cookie: A, body: { choiceId: 'tracks' } });
    check('같은 선택지 반복 불가', r.status === 400);
    r = await req('GET', `/api/threads/${threadId}/messages`, { cookie: B });
    const kinds = r.data.messages.map((m) => m.kind);
    check('스레드에 시스템 안내·굴림 로그가 흐름', kinds.includes('sys') && kinds.includes('roll'), kinds);
    const rollMsg = r.data.messages.find((m) => m.kind === 'roll');
    check('굴림 로그에 d20 과 서술이 보임', /d20\(\d+\)/.test(rollMsg.body) && rollMsg.body.includes('발자국을 살핀다'), rollMsg.body);
    check('시스템 메시지는 ‘시스템’ 이름으로', r.data.messages[0].user.name === '시스템');

    console.log('\n[조사 → 전투, 응원, 타이머]');
    // 조사 중에도 구경꾼이 채팅 가능
    let ack = await sendChat(sB, { threadId, body: '파이팅!' });
    check('구경꾼이 의뢰 스레드에서 수다 가능', ack.ok, ack);
    r = await req('POST', `/api/runs/${runId}/advance`, { cookie: A });
    check('조사를 마치고 전투로', r.status === 200);
    let v = (await req('GET', `/api/runs/${runId}`, { cookie: A })).data.run;
    check('전투 상태: 적 HP·다음 행동 예고·내 스킬', v.phase === 'combat' && v.combat.enemies[0].hp > 0 && v.combat.enemies[0].intent && v.combat.me.skill.name === '방패막기', v.combat);
    r = await req('POST', `/api/runs/${runId}/cheer`, { cookie: A, body: { targetUserId: v.combat.players[0].userId } });
    check('자기 응원 불가', r.status === 400);
    const tid = v.combat.players[0].userId;
    r = await req('POST', `/api/runs/${runId}/cheer`, { cookie: B, body: { targetUserId: tid } });
    check('구경꾼 응원 성공', r.status === 200, r.data);
    r = await req('POST', `/api/runs/${runId}/cheer`, { cookie: B, body: { targetUserId: tid } });
    check('같은 라운드 중복 응원 불가', r.status === 400);
    r = await req('POST', `/api/runs/${runId}/cheer`, { cookie: C, body: { targetUserId: tid } });
    r = await req('POST', `/api/runs/${runId}/cheer`, { cookie: D, body: { targetUserId: tid } });
    check('대상당 응원 상한(2)', r.status === 400, r.data);
    v = (await req('GET', `/api/runs/${runId}`, { cookie: B })).data.run;
    check('응원 수가 상태에 표시', v.combat.players[0].cheers === 2 && v.combat.myCheer === tid, v.combat.players[0]);
    r = await req('POST', `/api/runs/${runId}/act`, { cookie: A, body: { action: 'skill', targetUserId: tid } });
    check('스킬 선택(방패막기)', r.status === 200);
    r = await req('POST', `/api/runs/${runId}/act`, { cookie: B, body: { action: 'attack' } });
    check('구경꾼은 행동 불가', r.status === 403);
    r = await req('POST', `/api/runs/${runId}/act`, { cookie: A, body: { action: 'attack', line: '검을 휘두른다', rush: true } });
    check('행동 + 바로 진행(rush)', r.status === 200);
    r = await req('GET', `/api/threads/${threadId}/messages`, { cookie: B });
    const summaries = r.data.messages.filter((m) => m.kind === 'sys' && m.body.startsWith('━ 1라운드 결과'));
    check('라운드 결과가 3줄 요약(적HP/유저HP/다음 행동)으로 올라옴', summaries.length === 1 && /👹/.test(summaries[0].body) && /🧑/.test(summaries[0].body), summaries.map((s) => s.body));
    check('응원이 굴림 로그에 반영', r.data.messages.some((m) => m.kind === 'roll' && m.body.includes('응원 +2')), r.data.messages.filter((m) => m.kind === 'roll').map((m) => m.body));
    v = (await req('GET', `/api/runs/${runId}`, { cookie: B })).data.run;
    if (v.phase === 'combat') {
      check('다음 라운드로 넘어가고 응원이 초기화', v.combat.round === 2 && v.combat.players[0].cheers === 0 && v.combat.myCheer === null, v.combat);
      // 타이머: 행동 없이 마감(2초) 지나면 자동 진행
      await sleep(3500);
      v = (await req('GET', `/api/runs/${runId}`, { cookie: B })).data.run;
      check('시간 초과 시 자동 진행(방어)', v.combat.round >= 3 || v.phase !== 'combat', v.combat && v.combat.round);
      r = await req('POST', `/api/runs/${runId}/abandon`, { cookie: A });
      check('의뢰 포기', r.status === 200 || r.status === 400);
    } else check('(첫 라운드에 끝남 — 다음 검사 생략)', true);

    console.log('\n[전투불능: 발언 차단 + 강제 귀환]');
    r = await req('PUT', '/api/character', { cookie: C, body: { name: '불운이', class: '마법사' } });
    r = await req('POST', '/api/quests/deadly/start', { cookie: C });
    check('즉사 함정 시작(조사 없이 바로 전투)', r.status === 200, r.data);
    const dRun = r.data.runId, dThread = r.data.threadId;
    ack = await sendChat(sC, { threadId: dThread, body: '으악 큰일났다' });
    check('전투불능 전에는 발언 가능', ack.ok, ack);
    const koEv = waitEvent(sC, 'run:ko', 8000);
    for (let i = 0; i < 6; i++) {
      v = (await req('GET', `/api/runs/${dRun}`, { cookie: C })).data.run;
      if (v.phase !== 'combat') break;
      await req('POST', `/api/runs/${dRun}/act`, { cookie: C, body: { action: 'defend', rush: true } });
    }
    v = (await req('GET', `/api/runs/${dRun}`, { cookie: C })).data.run;
    check('전원 전투불능 → 의뢰 실패(lost)', v.phase === 'lost' && v.myStatus === 'ko', v);
    const ko = await koEv;
    const channels = (await req('GET', '/api/threads', { cookie: C })).data.threads;
    const questsCh = channels.find((t) => t.slug === 'quests');
    check('run:ko 이벤트로 의뢰 게시판 귀환 지시', ko && ko.threadId === dThread && ko.returnThreadId === questsCh.id, ko);
    ack = await sendChat(sC, { threadId: dThread, body: '억울해' });
    check('전투불능자는 그 스레드에서 발언 불가', !!ack.error && /전투불능/.test(ack.error), ack);
    ack = await sendChat(sC, { threadId: questsCh.id, body: '다른 곳에선 말할 수 있음' });
    check('다른 채널에서는 발언 가능', ack.ok, ack);
    ack = await sendChat(sB, { threadId: dThread, body: '위로의 한마디' });
    check('다른 사람은 그 스레드에서 계속 발언 가능', ack.ok, ack);
    r = await req('GET', `/api/threads/${dThread}/messages`, { cookie: C });
    check('전투불능자도 스레드 내용은 읽을 수 있음', r.status === 200 && r.data.messages.length > 3);
    r = await req('POST', '/api/quests/easy/start', { cookie: C });
    check('실패 후 다른 의뢰 시작 가능', r.status === 200);
    await req('POST', `/api/runs/${r.data.runId}/abandon`, { cookie: C });

    console.log('\n[보상/레벨업/스탯]');
    r = await req('PUT', '/api/character', { cookie: D, body: { name: '벼락부자', class: '성직자' } });
    async function clearEasy() {
      const st = await req('POST', '/api/quests/easy/start', { cookie: D });
      for (let i = 0; i < 10; i++) {
        const vv = (await req('GET', `/api/runs/${st.data.runId}`, { cookie: D })).data.run;
        if (vv.phase !== 'combat') return vv.phase;
        await req('POST', `/api/runs/${st.data.runId}/act`, { cookie: D, body: { action: 'attack', rush: true } });
      }
      return 'timeout';
    }
    check('허수아비 처치(승리)', (await clearEasy()) === 'won');
    let ch = (await me(D)).character;
    check('첫 클리어 경험치 40 → 레벨2, 스탯 포인트 +1', ch.xp === 40 && ch.level === 2 && ch.statPoints === 1 && ch.maxHp === 30, ch);
    r = await req('POST', '/api/character/stat', { cookie: D, body: { stat: 'dex' } });
    check('스탯 분배', r.status === 200 && r.data.character.stats.dex === 1 && r.data.character.statPoints === 0, r.data);
    r = await req('POST', '/api/character/stat', { cookie: D, body: { stat: 'dex' } });
    check('포인트 없으면 거부', r.status === 400);
    check('반복 클리어는 경험치 25%', (await clearEasy()) === 'won' && (await me(D)).character.xp === 50);
    r = await req('GET', '/api/quests', { cookie: D });
    check('의뢰 목록에 클리어 횟수', r.data.quests.find((x) => x.id === 'easy').clears === 2 && r.data.active === null, r.data);

    r = await req('GET', '/api/feed', { cookie: A });
    check('의뢰 완료/실패가 타임라인에 공식 소식으로 올라감', r.data.posts.some((p) => p.isSystem && /완료했다/.test(p.body) && /#의뢰/.test(p.body)) && r.data.posts.some((p) => p.isSystem && /쓰러졌다/.test(p.body)), r.data.posts.map((p) => p.body));
    r = await req('GET', '/api/runs', { cookie: B });
    check('진행·최근 의뢰 목록(구경용)', r.status === 200 && r.data.runs.length >= 3 && r.data.runs[0].threadId && r.data.runs[0].owner, r.data);
    console.log('\n[기타]');
    r = await req('GET', '/api/admin/users', { cookie: adminC });
    check('관리자 유저 목록에 시스템 계정 없음', !r.data.users.some((u) => u.username === '_system'));
    r = await req('GET', '/api/characters', { cookie: A });
    check('명단에 시스템 캐릭터 없음', !r.data.characters.some((c) => c.name === '시스템'));
    r = await req('POST', '/api/login', { body: { username: '_system', password: 'x' } });
    check('시스템 계정 로그인 불가', r.status === 401 || r.status === 403);
    // 서버 재시작 후 이어지는지: 진행 중인 의뢰를 만들어 두고 재기동
    r = await req('POST', '/api/quests/deadly/start', { cookie: A });
    const keepRun = r.data.runId;
    [sA, sB, sC].forEach((s) => s.close());
    server.kill(); await sleep(300);
    const s2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR, QUESTS_FILE: QFILE, RNG_SEED: '1', ROUND_DEADLINE_SEC: '2', ROUND_MIN_SEC: '0', AUTH_RATE_MAX: '500' } });
    let o2 = ''; s2.stdout.on('data', (d) => (o2 += d)); s2.stderr.on('data', (d) => (o2 += d));
    for (let i = 0; i < 60 && !o2.includes('서버 실행 중'); i++) await sleep(100);
    r = await req('GET', `/api/runs/${keepRun}`, { cookie: (await req('POST', '/api/login', { body: { username: 'qq0', password: 'password123' } })).cookie });
    check('재시작 후에도 진행 중 의뢰가 그대로', r.data && r.data.run && r.data.run.phase === 'combat', r.data);
    await sleep(3500);
    r = await req('GET', `/api/runs/${keepRun}`, { cookie: (await req('POST', '/api/login', { body: { username: 'qq0', password: 'password123' } })).cookie });
    check('재시작 후에도 타이머가 이어져 자동 진행', r.data.run.phase !== 'combat' || r.data.run.combat.round >= 2, r.data.run.combat);
    s2.kill();
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
