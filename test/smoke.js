'use strict';
// 간단한 통합 테스트: 임시 DB 로 서버를 띄우고 주요 흐름을 검사합니다.
// 실행: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { io: ioClient } = require('socket.io-client');

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-test-'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, { body, cookie, form, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (cookie) opts.headers.cookie = cookie;
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, opts);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json();
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : null;
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null, res };
}

function connectSocket(cookie) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => { s.close(); reject(e); });
  });
}
const waitEvent = (s, ev, ms = 2000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  s.once(ev, (d) => { clearTimeout(t); resolve(d === undefined ? true : d); });
});
const send = (s, payload) => new Promise((resolve) => s.emit('chat:send', payload, resolve));

async function run() {
  // ---- 서버 기동 ----
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'test-admin-pass', MAX_IMAGE_MB: '1', AUTH_RATE_MAX: '500' },
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !out.includes('서버 실행 중'); i++) await sleep(100);
  check('서버 기동', out.includes('서버 실행 중'), out);
  check('초기 초대코드 생성', /초대코드 5개 생성/.test(out));

  try {
    // ---- 인증 ----
    console.log('\n[인증]');
    let r = await req('GET', '/api/me');
    check('비로그인 /api/me → 401', r.status === 401);

    r = await req('POST', '/api/login', { body: { username: 'boss', password: 'wrong' } });
    check('관리자 잘못된 비번 → 401', r.status === 401);
    r = await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } });
    check('관리자 로그인', r.status === 200 && r.cookie);
    const adminCookie = r.cookie;

    r = await req('GET', '/api/me', { cookie: adminCookie });
    check('관리자 /api/me isAdmin', r.data.user.isAdmin === true);

    r = await req('POST', '/api/admin/invites', { cookie: adminCookie, body: { count: 6 } });
    const codes = r.data.codes;
    check('초대코드 6개 추가 발급', codes && codes.length === 6, r.data);

    const reg = (n, extra = {}) => req('POST', '/api/register', {
      body: { username: 'user' + n, password: 'password' + n + n, inviteCode: codes[n], charName: '용병' + n, ...extra },
    });

    r = await reg(0, { inviteCode: 'NOPE-NOPE' });
    check('잘못된 초대코드 가입 거부', r.status === 400);
    r = await reg(0, { password: 'short' });
    check('짧은 비밀번호 거부', r.status === 400);
    r = await reg(0, { username: 'a b' });
    check('이상한 아이디 거부', r.status === 400);
    r = await reg(0, { charName: 'x' });
    check('너무 짧은 캐릭터 이름 거부', r.status === 400);

    r = await reg(0);
    check('유저0 가입 + 세션 발급', r.status === 200 && r.cookie, r.data);
    const c0 = r.cookie;
    r = await reg(0);
    check('사용된 초대코드 재사용 거부', r.status === 400);
    r = await req('POST', '/api/register', { body: { username: 'user0', password: 'password00', inviteCode: codes[1], charName: '다른이름' } });
    check('중복 아이디 거부', r.status === 400);
    r = await req('POST', '/api/register', { body: { username: 'dupname', password: 'password00', inviteCode: codes[1], charName: '용병0' } });
    check('중복 캐릭터 이름 거부', r.status === 400);
    r = await req('GET', '/api/admin/invites', { cookie: adminCookie });
    check('실패한 가입이 초대코드를 소모하지 않음', r.data.invites.find((i) => i.code === codes[1] && !i.usedBy) !== undefined);

    r = await reg(1); const c1 = r.cookie;
    r = await reg(2); const c2 = r.cookie;
    check('유저1, 유저2 가입', c1 && c2);

    r = await req('GET', '/api/admin/users', { cookie: c0 });
    check('일반 유저의 관리자 API 접근 → 403', r.status === 403);
    r = await req('POST', '/api/register', { body: {}, headers: { origin: 'http://evil.example' } });
    check('다른 Origin 의 POST 거부 → 403', r.status === 403);

    // ---- 프로필 ----
    console.log('\n[프로필]');
    const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    r = await req('PUT', '/api/character', { cookie: c0, body: { name: '카이런', class: '전사', title: '빚쟁이 기사', bio: xss, appearance: '붉은 머리' } });
    check('프로필 저장', r.status === 200 && r.data.character.name === '카이런', r.data);
    check('클래스 저장', r.data.character.class === '전사');
    r = await req('PUT', '/api/character', { cookie: c0, body: { name: '카이런', class: '해적왕', title: '' } });
    check('허용되지 않은 클래스는 빈 값으로', r.data.character.class === '');
    r = await req('PUT', '/api/character', { cookie: c0, body: { name: 'a'.repeat(13) } });
    check('이름 길이 초과 거부', r.status === 400);
    r = await req('PUT', '/api/character', { cookie: c1, body: { name: '카이런' } });
    check('다른 유저와 같은 이름 거부 (대소문자 무시 포함)', r.status === 400);
    r = await req('PUT', '/api/character', { cookie: c0, body: { name: '카​이런' } });
    check('보이지 않는 문자가 든 이름 거부', r.status === 400);
    r = await req('PUT', '/api/character', { cookie: c0, body: { name: '카이런', class: '전사', title: '빚쟁이 기사', bio: 'z'.repeat(5000) } });
    check('설정글 길이 상한 적용', r.data.character.bio.length === 2000);
    r = await req('PUT', '/api/character', { cookie: c0, body: { name: '카이런', class: '전사', title: '빚쟁이 기사', bio: xss, appearance: '붉은 머리' } });
    r = await req('GET', '/api/characters/' + r.data.character.id, { cookie: c1 });
    check('다른 유저 프로필 조회', r.status === 200 && r.data.character.bio === xss);
    r = await req('GET', '/api/characters', { cookie: c1 });
    check('명단 조회 (3명 이상)', r.data.characters.length >= 3);

    // ---- 이미지 ----
    console.log('\n[이미지]');
    const withExif = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#a33' } })
      .jpeg().withExif({ IFD0: { Copyright: 'SECRET-LOCATION-TEST' } }).toBuffer();
    let form = new FormData();
    form.append('image', new Blob([withExif], { type: 'image/jpeg' }), 'me.jpg');
    r = await req('POST', '/api/character/image', { cookie: c0, form });
    check('JPEG 업로드 성공', r.status === 200 && r.data.image.endsWith('.webp'), r.data);
    const imgUrl = r.data.image;
    const imgRes = await fetch(BASE + imgUrl);
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());
    const meta = await sharp(imgBuf).metadata();
    check('이미지가 webp 512x512 로 변환됨', meta.format === 'webp' && meta.width === 512 && meta.height === 512, meta);
    check('EXIF 메타데이터 제거됨', !meta.exif && !imgBuf.includes(Buffer.from('SECRET-LOCATION-TEST')));
    check('업로드 이미지 제공 (content-type)', (imgRes.headers.get('content-type') || '').includes('image/webp'));

    form = new FormData();
    form.append('image', new Blob([Buffer.from('<?php echo 1; ?> not an image')], { type: 'image/png' }), 'evil.png');
    r = await req('POST', '/api/character/image', { cookie: c0, form });
    check('이미지로 위장한 텍스트 파일 거부', r.status === 400, r.data);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    form = new FormData();
    form.append('image', new Blob([svg], { type: 'image/png' }), 'x.png');
    r = await req('POST', '/api/character/image', { cookie: c0, form });
    check('SVG 업로드 거부', r.status === 400, r.data);

    form = new FormData();
    form.append('image', new Blob([Buffer.alloc(2 * 1024 * 1024, 1)], { type: 'image/png' }), 'big.png');
    r = await req('POST', '/api/character/image', { cookie: c0, form });
    check('용량 초과(1MB 제한) 거부', r.status === 400, r.data);

    const filesBefore = fs.readdirSync(path.join(DATA_DIR, 'uploads')).length;
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#36a' } }).png().toBuffer();
    form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'b.png');
    r = await req('POST', '/api/character/image', { cookie: c0, form });
    const filesAfter = fs.readdirSync(path.join(DATA_DIR, 'uploads')).length;
    check('이미지 교체 시 이전 파일 삭제', r.status === 200 && filesAfter === filesBefore);
    r = await req('DELETE', '/api/character/image', { cookie: c0 });
    await sleep(100);
    check('이미지 삭제', r.status === 200 && fs.readdirSync(path.join(DATA_DIR, 'uploads')).length === filesBefore - 1);

    // ---- 채팅 ----
    console.log('\n[채팅]');
    let bad = null;
    try { await connectSocket(''); } catch (e) { bad = e; }
    check('비로그인 소켓 연결 거부', bad && bad.message === 'unauthorized');

    const s0 = await connectSocket(c0);
    const s1 = await connectSocket(c1);
    const s2 = await connectSocket(c2);
    check('소켓 3개 연결', s0.connected && s1.connected && s2.connected);

    let p = waitEvent(s1, 'chat:message');
    let ack = await send(s0, { kind: 'say', body: '  안녕, 용병단!  ' });
    let got = await p;
    check('채팅 전송 ack', ack && ack.ok === true, ack);
    check('다른 유저가 메시지 수신 (공백 제거, 이름 포함)', got && got.body === '안녕, 용병단!' && got.user.name === '카이런' && got.kind === 'say', got);

    p = waitEvent(s1, 'chat:message');
    await send(s0, { kind: 'act', body: '칼자루를 고쳐 쥔다' });
    got = await p;
    check('지문(act) 종류 전송', got && got.kind === 'act');

    p = waitEvent(s1, 'chat:message');
    await send(s0, { kind: 'hack', body: xss });
    got = await p;
    check('알 수 없는 kind 는 say 로 처리, 본문은 원문 그대로 전달', got && got.kind === 'say' && got.body === xss);

    ack = await send(s0, { kind: 'say', body: '   ' });
    check('빈 메시지 거부', ack.error);

    p = waitEvent(s1, 'chat:message');
    await send(s0, { kind: 'say', body: 'a\n\nb' });
    got = await p;
    check('줄바꿈은 공백으로 정리', got && got.body === 'a  b', got);

    p = waitEvent(s1, 'chat:message');
    await send(s0, { kind: 'say', body: 'x'.repeat(900) });
    got = await p;
    check('채팅 길이 500자 제한', got && got.body.length === 500);

    // 도배 제한: s2 가 빠르게 연속 전송
    let limited = 0;
    for (let i = 0; i < 10; i++) { const a = await send(s2, { kind: 'say', body: 'spam ' + i }); if (a.error) limited++; }
    check('도배 제한 작동 (6개 초과분 거절)', limited === 4, limited);

    // 접속자 목록
    r = await req('GET', '/api/characters', { cookie: adminCookie });
    check('접속자 표시', r.data.characters.filter((c) => c.online).length === 3);
    p = waitEvent(s1, 'presence');
    s2.close();
    const pres = await p;
    check('접속 종료 시 presence 갱신', Array.isArray(pres) && !pres.find((x) => x.name === '용병2'), pres);

    // 기록
    r = await req('GET', '/api/threads', { cookie: c1 });
    const GID = r.data.globalId;
    r = await req('GET', `/api/threads/${GID}/messages`, { cookie: c1 });
    check('채팅 기록 조회', r.data.messages.length >= 6 && r.data.messages[0].id < r.data.messages[1].id);
    check('기록의 메시지에 threadId 포함', r.data.messages.every((m) => m.threadId === GID));
    const target = r.data.messages.find((m) => m.body === '안녕, 용병단!');

    // ---- 채널 / 스레드 ----
    console.log('\n[채널·스레드]');
    r = await req('GET', '/api/threads', { cookie: c1 });
    const chans = r.data.threads.filter((t) => t.kind === 'channel');
    check('고정 채널 5개가 순서대로 존재', chans.map((t) => t.title).join(',') === '전체,잡담,의뢰 게시판,이벤트,마을 장터', chans.map((t) => t.title));

    r = await reg(3); const c3 = r.cookie;
    r = await reg(4); const c4 = r.cookie;
    check('유저3, 유저4 가입', c3 && c4);
    r = await req('GET', '/api/threads', { cookie: c3 });
    check('가입 전에 쌓인 채팅은 안 읽음으로 세지 않음', r.data.threads.every((t) => t.unread === 0), r.data.threads.map((t) => t.unread));

    r = await req('POST', '/api/threads', { cookie: c3, body: { title: 'x' } });
    check('너무 짧은 스레드 제목 거부', r.status === 400);
    r = await req('POST', '/api/threads', { cookie: c3, body: { title: '첫 의뢰 이야기', body: '다들 어떻게 생각해?' } });
    check('스레드 생성 (첫 글 포함)', r.status === 200 && r.data.id > 0, r.data);
    const T1 = r.data.id;

    r = await req('GET', '/api/threads', { cookie: c4 });
    let t1 = r.data.threads.find((t) => t.id === T1);
    check('다른 유저에게 새 스레드가 목록에 나타남 (안 읽음 1, 아직 미참여)', t1 && t1.unread === 1 && !t1.participated && t1.creator === '용병3', t1);
    check('고정 채널이 스레드보다 앞에 정렬', r.data.threads.findIndex((t) => t.kind === 'thread') > r.data.threads.map((t) => t.kind).lastIndexOf('channel'));
    r = await req('GET', '/api/threads', { cookie: c3 });
    t1 = r.data.threads.find((t) => t.id === T1);
    check('만든 사람은 참여자 + 안 읽음 0', t1.participated === true && t1.unread === 0, t1);

    const s3 = await connectSocket(c3);
    const s4 = await connectSocket(c4);
    p = waitEvent(s3, 'chat:message');
    ack = await send(s4, { threadId: T1, kind: 'say', body: '나는 반대야' });
    got = await p;
    check('스레드에 글쓰기 + 실시간 수신 (threadId 포함)', ack.ok && got && got.threadId === T1 && got.body === '나는 반대야', got);

    r = await req('GET', '/api/threads', { cookie: c3 });
    t1 = r.data.threads.find((t) => t.id === T1);
    check('상대 글은 안 읽음 1로 집계', t1.unread === 1 && t1.messageCount === 2, t1);
    r = await req('GET', '/api/threads', { cookie: c4 });
    t1 = r.data.threads.find((t) => t.id === T1);
    check('글을 쓴 유저는 참여자가 되고 그때까지 읽은 것으로 처리', t1.participated === true && t1.unread === 0, t1);

    r = await req('POST', `/api/threads/${T1}/read`, { cookie: c3, body: { lastId: 999999999 } });
    r = await req('GET', '/api/threads', { cookie: c3 });
    check('읽음 처리 후 안 읽음 0', r.data.threads.find((t) => t.id === T1).unread === 0);

    r = await req('GET', `/api/threads/${T1}/messages`, { cookie: c4 });
    check('스레드 기록에는 그 스레드 글만 (2개)', r.data.messages.length === 2 && r.data.messages.every((m) => m.threadId === T1), r.data.messages.length);
    r = await req('GET', `/api/threads/${GID}/messages`, { cookie: c4 });
    check('스레드 글이 전체 채널 기록에 섞이지 않음', !r.data.messages.find((m) => m.body === '나는 반대야'));

    ack = await send(s3, { threadId: 999999, kind: 'say', body: '없는 곳' });
    check('없는 스레드에 글쓰기 거부', ack.error);
    r = await req('GET', '/api/threads/999999/messages', { cookie: c3 });
    check('없는 스레드 기록 조회 → 404', r.status === 404);

    r = await req('POST', '/api/threads', { cookie: c3, body: { title: '두번째 스레드' } });
    const T2 = r.data.id;
    r = await req('POST', '/api/threads', { cookie: c3, body: { title: '세번째 스레드' } });
    r = await req('POST', '/api/threads', { cookie: c3, body: { title: '네번째 스레드' } });
    check('스레드 생성 속도 제한 (시간당 3개)', r.status === 429, r.data);
    r = await req('GET', '/api/threads', { cookie: c3 });
    check('글 없이 만든 스레드도 참여 스레드로 표시', r.data.threads.find((t) => t.id === T2).participated === true);
    check('참여한 스레드 목록 (kind=thread, participated)이 3개', r.data.threads.filter((t) => t.kind === 'thread' && t.participated).length === 3);

    // 잠금
    r = await req('POST', `/api/admin/threads/${T1}/lock`, { cookie: c4, body: { locked: true } });
    check('일반 유저는 스레드 잠금 불가', r.status === 403);
    p = waitEvent(s3, 'threads:changed');
    r = await req('POST', `/api/admin/threads/${T1}/lock`, { cookie: adminCookie, body: { locked: true } });
    check('관리자가 스레드 잠금 + 변경 이벤트', r.status === 200 && (await p) === true);
    ack = await send(s4, { threadId: T1, kind: 'say', body: '잠겼는데 쓴다' });
    check('잠긴 스레드에는 일반 유저 글쓰기 불가', ack.error && ack.error.includes('잠긴'), ack);
    const sa = await connectSocket(adminCookie);
    ack = await send(sa, { threadId: T1, kind: 'say', body: '운영자 공지' });
    check('잠긴 스레드에도 관리자는 글쓰기 가능', ack.ok === true, ack);
    await req('POST', `/api/admin/threads/${T1}/lock`, { cookie: adminCookie, body: { locked: false } });
    ack = await send(s4, { threadId: T1, kind: 'say', body: '풀렸다' });
    check('잠금 해제 후 글쓰기 가능', ack.ok === true, ack);

    // 삭제 / 채널
    r = await req('DELETE', `/api/admin/threads/${T1}`, { cookie: c4 });
    check('일반 유저는 스레드 삭제 불가', r.status === 403);
    r = await req('DELETE', `/api/admin/threads/${chans[1].id}`, { cookie: adminCookie });
    check('고정 채널은 삭제 불가', r.status === 400);
    r = await req('DELETE', `/api/admin/threads/${T1}`, { cookie: adminCookie });
    check('관리자 스레드 삭제', r.status === 200);
    r = await req('GET', '/api/threads', { cookie: c3 });
    check('삭제된 스레드는 목록에서 사라짐', !r.data.threads.find((t) => t.id === T1));
    r = await req('GET', `/api/threads/${T1}/messages`, { cookie: c3 });
    check('삭제된 스레드 기록 조회 → 404', r.status === 404);
    ack = await send(s3, { threadId: T1, kind: 'say', body: '삭제된 곳' });
    check('삭제된 스레드에 글쓰기 거부', ack.error);

    r = await req('POST', '/api/admin/channels', { cookie: c3, body: { title: '던전 정보' } });
    check('일반 유저는 채널 생성 불가', r.status === 403);
    r = await req('POST', '/api/admin/channels', { cookie: adminCookie, body: { title: '던전 정보' } });
    check('관리자 채널 생성', r.status === 200);
    r = await req('GET', '/api/threads', { cookie: c3 });
    const chans2 = r.data.threads.filter((t) => t.kind === 'channel');
    check('새 채널이 고정 채널 끝에 추가됨', chans2.length === 6 && chans2[5].title === '던전 정보');
    ack = await send(s3, { threadId: chans2[1].id, kind: 'say', body: '잡담 채널 테스트' });
    check('다른 고정 채널에도 글쓰기 가능', ack.ok === true, ack);
    [s3, s4, sa].forEach((s) => s.close());

    // ---- 신고 / 삭제 ----
    console.log('\n[신고·관리]');
    r = await req('POST', '/api/report', { cookie: c1, body: { messageId: target.id, reason: '테스트 신고' } });
    check('신고 접수', r.status === 200);
    r = await req('POST', '/api/report', { cookie: c1, body: { messageId: target.id, reason: '중복' } });
    check('같은 메시지 중복 신고도 에러 없이 처리', r.status === 200);
    r = await req('GET', '/api/admin/reports', { cookie: adminCookie });
    check('관리자가 신고 목록 확인 (1건)', r.data.reports.length === 1 && r.data.reports[0].reason === '테스트 신고', r.data);

    p = waitEvent(s1, 'chat:deleted');
    r = await req('DELETE', '/api/admin/messages/' + target.id, { cookie: adminCookie });
    got = await p;
    check('관리자 메시지 삭제 + 실시간 반영', r.status === 200 && got && got.id === target.id);
    r = await req('GET', `/api/threads/${GID}/messages`, { cookie: c1 });
    check('삭제된 메시지는 기록에서 제외', !r.data.messages.find((m) => m.id === target.id));
    r = await req('GET', '/api/threads', { cookie: c1 });
    check('삭제 후 채널 메시지 수 갱신', r.data.threads.find((t) => t.id === GID).messageCount === (await req('GET', `/api/threads/${GID}/messages`, { cookie: c1 })).data.messages.length);
    r = await req('GET', '/api/admin/reports', { cookie: adminCookie });
    check('삭제하면 신고도 처리됨', r.data.reports.length === 0);
    r = await req('DELETE', '/api/admin/messages/' + target.id, { cookie: c1 });
    check('일반 유저는 메시지 삭제 불가', r.status === 403);

    // 뮤트
    r = await req('GET', '/api/admin/users', { cookie: adminCookie });
    const u0 = r.data.users.find((u) => u.username === 'user0');
    r = await req('POST', `/api/admin/users/${u0.id}/mute`, { cookie: adminCookie, body: { minutes: 5 } });
    ack = await send(s0, { kind: 'say', body: '뮤트 중인데 말해본다' });
    check('뮤트된 유저는 채팅 불가', r.status === 200 && ack.error && ack.error.includes('제한'), ack);
    await req('POST', `/api/admin/users/${u0.id}/unmute`, { cookie: adminCookie });
    await sleep(100);
    ack = await send(s0, { kind: 'say', body: '뮤트 해제 후' });
    check('뮤트 해제 후 채팅 가능 (또는 도배 제한 중)', ack.ok === true || (ack.error && ack.error.includes('빠르게')), ack);

    // 정지
    r = await req('GET', '/api/admin/users', { cookie: adminCookie });
    const u1 = r.data.users.find((u) => u.username === 'user1');
    p = waitEvent(s1, 'kicked');
    r = await req('POST', `/api/admin/users/${u1.id}/ban`, { cookie: adminCookie });
    got = await p;
    check('정지 시 접속 중이던 소켓이 즉시 끊김', r.status === 200 && got === true);
    r = await req('GET', '/api/me', { cookie: c1 });
    check('정지된 유저의 기존 세션 무효화', r.status === 401);
    r = await req('POST', '/api/login', { body: { username: 'user1', password: 'password11' } });
    check('정지된 유저 로그인 거부', r.status === 403);
    r = await req('GET', '/api/characters', { cookie: adminCookie });
    check('정지된 유저는 명단에서 숨김', !r.data.characters.find((c) => c.name === '용병1'));
    r = await req('POST', `/api/admin/users/${u1.id}/unban`, { cookie: adminCookie });
    r = await req('POST', '/api/login', { body: { username: 'user1', password: 'password11' } });
    check('정지 해제 후 로그인 가능', r.status === 200);

    // 관리자 자기 보호
    r = await req('GET', '/api/admin/users', { cookie: adminCookie });
    const adminRow = r.data.users.find((u) => u.isAdmin);
    r = await req('POST', `/api/admin/users/${adminRow.id}/ban`, { cookie: adminCookie });
    check('관리자는 자기 자신을 정지할 수 없음', r.status === 400);

    // 로그아웃
    r = await req('POST', '/api/logout', { cookie: c0 });
    r = await req('GET', '/api/me', { cookie: c0 });
    check('로그아웃 후 세션 무효', r.status === 401);

    // 정적 페이지
    r = await req('GET', '/');
    check('메인 페이지 제공', r.status === 200 && (r.res.headers.get('content-security-policy') || '').includes("script-src 'self'"));
    r = await req('GET', '/admin.html');
    check('관리자 페이지 제공', r.status === 200);

    [s0, s1].forEach((s) => s.close());
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
