'use strict';
// 타임라인 통합 테스트: 글·답글·하트·인용·멘션·해시태그·알림·삭제·신고·뮤트
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { io: ioClient } = require('socket.io-client');
const ROOT = path.join(__dirname, '..');
const PORT = 4600 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-feed-'));
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
const waitEvent = (s, ev, ms = 2500) => new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); s.once(ev, (d) => { clearTimeout(t); resolve(d === undefined ? true : d); }); });

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'test-admin-pass', AUTH_RATE_MAX: '500', CHAT_RATE_MAX: '1000' } });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 60 && !out.includes('서버 실행 중'); i++) await sleep(100);
  check('서버 기동', out.includes('서버 실행 중'), out);
  try {
    const adminC = (await req('POST', '/api/login', { body: { username: 'boss', password: 'test-admin-pass' } })).cookie;
    const codes = (await req('POST', '/api/admin/invites', { cookie: adminC, body: { count: 3 } })).data.codes;
    const mk = async (i, name) => (await req('POST', '/api/register', { body: { username: 'ff' + i, password: 'password123', inviteCode: codes[i], charName: name } })).cookie;
    const A = await mk(0, '아린'), B = await mk(1, '보리'), C = await mk(2, '채원');
    const post = (c, body) => req('POST', '/api/posts', { cookie: c, body });
    const notifs = async (c) => (await req('GET', '/api/notifications', { cookie: c })).data;

    console.log('\n[글쓰기]');
    check('비로그인 불가', (await req('GET', '/api/feed')).status === 401);
    let r = await post(A, { body: '' });
    check('빈 글 거부', r.status === 400);
    r = await post(A, { body: '   \n  ' });
    check('공백뿐인 글 거부', r.status === 400);
    r = await post(A, { body: '가'.repeat(300) });
    check('280자 초과는 280자로 잘림', r.status === 200 && r.data.post.body.length === 280, r.data.post && r.data.post.body.length);
    r = await post(A, { body: '첫 글입니다 #첫글 #모험', kind: 'act' });
    const p1 = r.data.post;
    check('글 작성: 작성자·종류·시간·초기 카운트', r.status === 200 && p1.user.name === '아린' && p1.kind === 'act' && p1.likeCount === 0 && p1.replyCount === 0 && !p1.liked, p1);
    r = await post(A, { body: '<script>alert(1)</script> & "인용"' });
    check('HTML 은 그대로 문자열로 저장(화면은 textContent 로만 출력)', r.data.post.body.startsWith('<script>'));
    r = await req('GET', '/api/feed', { cookie: B });
    check('타임라인은 최신순, 최상위 글만', r.data.posts[0].body.startsWith('<script>') && r.data.posts.every((x) => x.parentId === null), r.data.posts.map((x) => x.id));

    console.log('\n[페이지네이션]');
    for (let i = 0; i < 32; i++) await post(B, { body: `글 ${i}` });
    r = await req('GET', '/api/feed', { cookie: C });
    check('한 페이지 30개 + hasMore', r.data.posts.length === 30 && r.data.hasMore === true);
    const last = r.data.posts[29].id;
    const r2 = await req('GET', `/api/feed?before=${last}`, { cookie: C });
    check('before 로 다음 페이지(겹침 없음)', r2.data.posts.length > 0 && r2.data.posts.every((x) => x.id < last), r2.data.posts.length);

    console.log('\n[답글]');
    const rt = (await post(A, { body: '답글 받을 글' })).data.post;
    const ev = waitEvent(await connect(C), 'post:new');
    r = await post(B, { body: '보리의 답글', parentId: rt.id });
    check('답글 작성: replyTo 이름', r.status === 200 && r.data.post.replyTo === '아린' && r.data.post.rootId === rt.id, r.data);
    const reply1 = r.data.post;
    r = await post(C, { body: '답글에 답글', parentId: reply1.id });
    check('답글의 답글도 최상위 글(root)에 평평하게 속함', r.data.post.rootId === rt.id && r.data.post.parentId === reply1.id && r.data.post.replyTo === '보리');
    r = await req('GET', `/api/posts/${rt.id}`, { cookie: A });
    check('상세: 최상위 글 + 답글 2개 시간순, replyCount 2', r.data.root.replyCount === 2 && r.data.replies.length === 2 && r.data.replies[0].id === reply1.id, r.data);
    r = await req('GET', `/api/posts/${reply1.id}`, { cookie: A });
    check('답글 id 로 열어도 최상위 글 기준으로 보여줌', r.data.root.id === rt.id && r.data.focusId === reply1.id);
    check('답글은 타임라인에 따로 나오지 않음', !(await req('GET', '/api/feed', { cookie: A })).data.posts.some((x) => x.id === reply1.id));
    check('답글 알림이 원글 작성자에게', (await notifs(A)).items.some((n) => n.type === 'reply' && n.actor === '보리'));
    check('없는 글에 답글 거부', (await post(A, { body: 'x', parentId: 99999 })).status === 400);
    check('실시간 post:new 이벤트(rootId 포함)', (await ev) !== null);

    console.log('\n[하트]');
    r = await req('POST', `/api/posts/${rt.id}/like`, { cookie: B });
    check('하트: liked + 개수 1', r.data.liked === true && r.data.likeCount === 1, r.data);
    check('내 화면에서 liked 표시', (await req('GET', `/api/posts/${rt.id}`, { cookie: B })).data.root.liked === true && (await req('GET', `/api/posts/${rt.id}`, { cookie: C })).data.root.liked === false);
    check('하트 알림', (await notifs(A)).items.filter((n) => n.type === 'like').length === 1);
    r = await req('POST', `/api/posts/${rt.id}/like`, { cookie: B });
    check('다시 누르면 취소', r.data.liked === false && r.data.likeCount === 0);
    await req('POST', `/api/posts/${rt.id}/like`, { cookie: B });
    check('취소 후 재하트해도 알림은 중복되지 않음', (await notifs(A)).items.filter((n) => n.type === 'like' && n.actor === '보리').length === 1);
    const before = (await notifs(A)).items.length;
    await req('POST', `/api/posts/${rt.id}/like`, { cookie: A });
    check('내 글에 내가 하트해도 알림 없음', (await notifs(A)).items.length === before);
    check('없는 글 하트 404', (await req('POST', '/api/posts/99999/like', { cookie: A })).status === 404);

    console.log('\n[리포스트/인용]');
    r = await post(C, { body: '이거 봐요', quoteId: rt.id });
    const qp = r.data.post;
    check('인용 글: 원문 카드 포함', r.status === 200 && qp.quote && qp.quote.id === rt.id && qp.quote.user.name === '아린', qp);
    r = await post(B, { body: '', quoteId: rt.id });
    check('본문 없는 순수 리포스트 허용', r.status === 200 && r.data.post.body === '' && r.data.post.quote.id === rt.id);
    const pure = r.data.post;
    r = await post(A, { body: '', quoteId: pure.id });
    check('리포스트의 리포스트는 원본을 가리킴', r.data.post.quote.id === rt.id, r.data.post.quote);
    check('원글의 repostCount 반영', (await req('GET', `/api/posts/${rt.id}`, { cookie: A })).data.root.repostCount === 3);
    check('인용 알림', (await notifs(A)).items.some((n) => n.type === 'repost' && n.actor === '채원'));
    check('답글+인용 동시 거부', (await post(A, { body: 'x', parentId: rt.id, quoteId: rt.id })).status === 400);
    check('없는 글 인용 거부', (await post(A, { body: 'x', quoteId: 99999 })).status === 400);

    console.log('\n[멘션/해시태그]');
    r = await post(A, { body: '@보리 안녕! 그리고 @채원, @없는사람 #여행 #Travel' });
    check('멘션 알림(문장부호 뒤따라도 인식)', (await notifs(B)).items.some((n) => n.type === 'mention' && n.actor === '아린') && (await notifs(C)).items.some((n) => n.type === 'mention' && n.actor === '아린'));
    r = await post(A, { body: '@아린 나한테 멘션' });
    check('자기 멘션은 알림 없음', !(await notifs(A)).items.some((n) => n.type === 'mention'));
    r = await req('GET', '/api/feed?tag=여행', { cookie: B });
    check('해시태그 피드', r.data.posts.length === 1 && r.data.posts[0].body.includes('#여행'), r.data.posts.length);
    r = await req('GET', '/api/feed?tag=%23travel', { cookie: B });
    check('태그는 대소문자 무시, # 접두 허용', r.data.posts.length === 1);
    r = await req('GET', '/api/tags', { cookie: B });
    check('인기 태그 목록', r.data.tags.some((t) => t.tag === '여행'), r.data);

    console.log('\n[삭제/신고/관리]');
    r = await req('DELETE', `/api/posts/${p1.id}`, { cookie: B });
    check('남의 글은 못 지움(403)', r.status === 403);
    r = await req('DELETE', `/api/posts/${reply1.id}`, { cookie: B });
    check('내 답글 삭제', r.status === 200);
    r = await req('GET', `/api/posts/${rt.id}`, { cookie: A });
    check('삭제된 답글은 안 보이고 replyCount 감소', r.data.root.replyCount === 1 && r.data.replies.length === 1, r.data.root.replyCount);
    r = await req('DELETE', `/api/posts/${reply1.id}`, { cookie: B });
    check('이미 지운 글 404', r.status === 404);
    r = await req('POST', `/api/posts/${qp.id}/report`, { cookie: A, body: { reason: '테스트 신고' } });
    check('글 신고', r.status === 200);
    r = await req('GET', '/api/admin/post-reports', { cookie: adminC });
    check('관리자 글 신고 목록', r.data.reports.length === 1 && r.data.reports[0].reason === '테스트 신고' && r.data.reports[0].author === '채원', r.data);
    check('일반 유저는 관리자 목록 접근 불가', (await req('GET', '/api/admin/post-reports', { cookie: A })).status === 403);
    r = await req('GET', '/api/admin/posts', { cookie: adminC });
    check('관리자 최근 글 목록', r.data.posts.length > 5);
    r = await req('DELETE', `/api/posts/${rt.id}`, { cookie: adminC });
    check('관리자는 남의 글 삭제 가능', r.status === 200);
    r = await req('GET', '/api/feed', { cookie: A });
    check('삭제된 글은 타임라인에서 사라짐', !r.data.posts.some((x) => x.id === rt.id));
    r = await req('GET', `/api/posts/${qp.id}`, { cookie: A });
    check('삭제된 원글을 인용한 카드는 내용 숨김(deleted)', r.data.root.quote.deleted === true && r.data.root.quote.body === '', r.data.root.quote);
    check('삭제된 글에는 답글 불가', (await post(A, { body: 'x', parentId: rt.id })).status === 400);
    r = await req('GET', `/api/posts/${rt.id}`, { cookie: A });
    check('삭제된 글 상세는 본문 비어 있음', r.data.root.deleted === true && r.data.root.body === '');

    console.log('\n[알림]');
    r = await notifs(B);
    check('안 읽은 알림 수', r.unread > 0, r.unread);
    check('/api/me 에도 안 읽은 알림 수', (await req('GET', '/api/me', { cookie: B })).data.unreadNotifications === r.unread);
    await req('POST', '/api/notifications/read', { cookie: B });
    check('모두 읽음 처리', (await notifs(B)).unread === 0);

    console.log('\n[프로필 글/제재]');
    const aChar = (await req('GET', '/api/me', { cookie: A })).data.character;
    r = await req('GET', `/api/characters/${aChar.id}/posts`, { cookie: B });
    check('캐릭터별 글 목록(삭제 글 제외)', r.status === 200 && r.data.posts.every((x) => x.user.name === '아린') && !r.data.posts.some((x) => x.deleted), r.data.posts.length);
    const cId = (await req('GET', '/api/me', { cookie: C })).data.user.id;
    await req('POST', `/api/admin/users/${cId}/mute`, { cookie: adminC, body: { minutes: 5 } });
    r = await post(C, { body: '뮤트 중 글' });
    check('뮤트된 유저는 글 못 씀', r.status === 400 && /제한/.test(r.data.error), r.data);
    await req('POST', `/api/admin/users/${cId}/unmute`, { cookie: adminC });
    check('뮤트 해제 후 글 가능', (await post(C, { body: '다시 씀' })).status === 200);
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
function connect(cookie) { return new Promise((res, rej) => { const s = ioClient(BASE, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); }); }
