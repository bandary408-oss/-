'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- .env 로더 (의존성 없이 간단하게) ----
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const express = require('express');
const http = require('http');
const multer = require('multer');
const sharp = require('sharp');
const { Server } = require('socket.io');
const { db, DATA_DIR, UPLOAD_DIR, GLOBAL_ID, SYSTEM_USER_ID } = require('./db');
const E = require('./engine');
const { createRuns } = require('./runs');
const { createTown } = require('./town');
const { createFeed } = require('./feed');
const X = require('./economy');
const { createBalance } = require('./balance');

// ---- 게임 콘텐츠 (content/*.json 을 고치면 서버 재시작 때 반영, 숫자는 관리자 [밸런스] 탭에서 즉시 조정) ----
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'content', 'rules.json'), 'utf8'));
const QUESTS_FILE = process.env.QUESTS_FILE || path.join(__dirname, 'content', 'quests.json');
const QUESTS = JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf8')).quests || [];
const ECONOMY_FILE = process.env.ECONOMY_FILE || path.join(__dirname, 'content', 'economy.json');
const ECO = JSON.parse(fs.readFileSync(ECONOMY_FILE, 'utf8'));
E.validateContent(RULES, { quests: QUESTS }); // 오류가 있으면 한국어 메시지와 함께 여기서 멈춤
X.validateEconomy(ECO, RULES, { quests: QUESTS });
// 스킬 설명의 {shieldReduce}, {dice} 같은 칸을 현재 수치로 채움 (밸런스 조정 때마다 다시 채움)
const SKILL_DESC_TEMPLATES = Object.fromEntries(Object.entries(RULES.classes).map(([k, c]) => [k, c.skill.desc]));
function fillSkillDescs() {
  for (const [k, c] of Object.entries(RULES.classes)) {
    c.skill.desc = String(SKILL_DESC_TEMPLATES[k] || '').replace(/\{(\w+)\}/g, (m, key) => {
      const v = c.skill[key] !== undefined ? c.skill[key] : (RULES.combat || {})[key];
      return v !== undefined ? String(v) : m;
    });
  }
}

// ---- 설정 ----
const PORT = Number(process.env.PORT || 3000);
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 2);
const RATE_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_SEC || 10) * 1000;
const RATE_MAX = Number(process.env.CHAT_RATE_MAX || 6);
const SESSION_DAYS = 30;
const AUTH_RATE_MAX = Number(process.env.AUTH_RATE_MAX || 15); // IP당 5분에 로그인/가입 시도 허용 횟수
const CLASSES = Object.keys(RULES.classes);
const LIMITS = { name: [2, 12], title: 40, bio: 2000, appearance: 500, link: 300, chat: 500, threadTitle: 60, post: 280 };
const HISTORY_SIZE = 50;
const THREAD_LIMIT_PER_HOUR = 3; // 일반 유저가 한 시간에 만들 수 있는 스레드 수
// 라운드 시간: 환경변수가 있으면 그게 우선, 없으면 rules.round (밸런스 조정 시 갱신)
const ROUND = {};
function refreshRound() {
  ROUND.deadlineSec = Number(process.env.ROUND_DEADLINE_SEC || RULES.round.deadlineSec);
  ROUND.minSec = Number(process.env.ROUND_MIN_SEC !== undefined ? process.env.ROUND_MIN_SEC : RULES.round.minSec);
}

// 관리자 밸런스 조정값(DATA_DIR/balance.json)을 원본 위에 덮어씀
const balance = createBalance({
  dataDir: DATA_DIR,
  base: { rules: RULES, quests: { quests: QUESTS }, economy: ECO },
  live: { rules: RULES, quests: { quests: QUESTS }, economy: ECO },
  validate: (d) => { E.validateContent(d.rules, d.quests); X.validateEconomy(d.economy, d.rules, d.quests); },
  onApply: () => { fillSkillDescs(); refreshRound(); },
});
fillSkillDescs();
refreshRound();
balance.init();

// ---- 유틸 ----
const now = () => Date.now();
// 제어문자·보이지 않는 문자 범위 (소스에 특수문자를 직접 쓰지 않도록 코드포인트로 조립)
const INVISIBLE = [[0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x2060], [0xfeff, 0xfeff]];
const rangeClass = (ranges) => ranges.map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('');
// 이름 검증용: 모든 제어문자(줄바꿈 포함) + 보이지 않는 문자
const BAD_CHARS = new RegExp('[' + rangeClass([[0x00, 0x1f], [0x7f, 0x7f], ...INVISIBLE]) + ']');
// 본문 정리용: 줄바꿈(0x0a)만 남기고 제거
const STRIP_CHARS = new RegExp('[' + rangeClass([[0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x7f], ...INVISIBLE]) + ']', 'g');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  const calc = crypto.scryptSync(password, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return calc.length === orig.length && crypto.timingSafeEqual(calc, orig);
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function genInviteCode() {
  // 헷갈리는 문자(0,O,1,I) 제외
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
}

// ---- 세션 ----
const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
  charByUser: db.prepare('SELECT * FROM characters WHERE user_id = ?'),
  charById: db.prepare('SELECT * FROM characters WHERE id = ?'),
};

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, now() + SESSION_DAYS * 86400000);
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = q.sessionByToken.get(token, now());
  if (!s) return null;
  const u = q.userById.get(s.user_id);
  if (!u || u.banned) return null;
  return u;
}

// ---- 초기 데이터 (관리자 계정, 초대코드) ----
function seed() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
  if (!admin) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'change-me-now';
    const { hash, salt } = hashPassword(password);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, password_salt, is_admin, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run(username, hash, salt, now());
    db.prepare('INSERT INTO characters (user_id, name, class, title, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(info.lastInsertRowid, '운영자', '', '용병단 운영진', now());
    console.log(`[seed] 관리자 계정 생성: ${username}`);
    if (password === 'change-me-now') {
      console.warn('[경고] 기본 관리자 비밀번호입니다. .env 의 ADMIN_PASSWORD 를 꼭 바꾸세요.');
    }
  }
  const unused = db.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL').get().n;
  if (unused === 0) {
    const ins = db.prepare('INSERT INTO invites (code, created_at) VALUES (?, ?)');
    const codes = [];
    for (let i = 0; i < 5; i++) { const c = genInviteCode(); ins.run(c, now()); codes.push(c); }
    console.log('[seed] 초대코드 5개 생성:', codes.join('  '));
  }
}
seed();

// ---- Express ----
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

// 기본 보안 헤더
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:");
  next();
});

// CSRF 보조: 변경 요청은 Origin 이 있으면 같은 호스트여야 함
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: '잘못된 요청 출처입니다.' });
    } catch { return res.status(403).json({ error: '잘못된 요청 출처입니다.' }); }
  }
  next();
});

// 인증 미들웨어
function auth(req, res, next) {
  const token = parseCookies(req.headers.cookie).sid;
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = user;
  req.token = token;
  next();
}
function adminOnly(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  next();
}

// 로그인/가입 시도 제한 (IP당 5분에 15회)
const attempts = new Map();
function limitAttempts(req, res, next) {
  const key = req.ip;
  const t = now();
  const arr = (attempts.get(key) || []).filter((x) => t - x < 300000);
  if (arr.length >= AUTH_RATE_MAX) return res.status(429).json({ error: '시도가 너무 많습니다. 잠시 후 다시 해주세요.' });
  arr.push(t);
  attempts.set(key, arr);
  next();
}

function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

// 캐릭터를 클라이언트에 내려줄 형태로
function publicChar(c) {
  if (!c) return null;
  return {
    id: c.id, userId: c.user_id, name: c.name, class: c.class, title: c.title,
    bio: c.bio, appearance: c.appearance, link: c.link || '', image: c.image ? `/uploads/${c.image}` : '',
    ...sheetWithGear(c),
  };
}
// 능력치 시트 + 장착 장비 보너스 (HP·방어도·명중에 반영)
function sheetWithGear(c) {
  const sh = E.sheet(RULES, c);
  const ids = town.equippedIds(c.user_id);
  const gear = X.gearBonus(ECO, ids);
  const equipment = {};
  ids.forEach((id) => { equipment[ECO.items[id].slot] = { id, name: ECO.items[id].name, rarity: ECO.items[id].rarity }; });
  return { ...sh, maxHp: sh.maxHp + gear.hp, ac: sh.ac + gear.ac, attackBonus: gear.attack, equipment };
}
// 클라이언트가 규칙을 그리는 데 필요한 정보 (스킬 설명, 스탯 이름 등)
function gameInfo() {
  return {
    statNames: RULES.statNames, statCap: RULES.statCap, minSec: ROUND.minSec, deadlineSec: ROUND.deadlineSec,
    economy: town.defs(),
    classes: Object.fromEntries(Object.entries(RULES.classes).map(([k, c]) => [k, { base: c.base, attackStat: c.attackStat, weapon: c.weapon, skill: c.skill }])),
  };
}

// ---- 입력 검증 ----
// 프로필 링크: 비우면 '', http/https 주소만 허용 (javascript: 같은 건 거부)
function cleanLink(v) {
  if (v == null) return '';
  if (typeof v !== 'string') return null;
  const s = v.replace(STRIP_CHARS, '').trim();
  if (!s) return '';
  if (s.length > LIMITS.link) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname) return null;
  return u.href.length > LIMITS.link ? null : u.href;
}
function cleanText(v, max, { multiline = false } = {}) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/\r\n/g, '\n');
  if (!multiline) s = s.replace(/\n/g, ' ');
  // 줄바꿈(\n)만 허용, 나머지 제어문자·보이지 않는 문자 제거
  s = s.replace(STRIP_CHARS, '');
  return s.trim().slice(0, max);
}
function validateName(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length < LIMITS.name[0] || s.length > LIMITS.name[1]) return `캐릭터 이름은 ${LIMITS.name[0]}~${LIMITS.name[1]}자여야 합니다.`;
  if (BAD_CHARS.test(s)) return '캐릭터 이름에 사용할 수 없는 문자가 있습니다.';
  return null;
}

// ---- 인증 API ----
app.post('/api/register', limitAttempts, (req, res) => {
  const { username, password, inviteCode, charName } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(username))
    return res.status(400).json({ error: '아이디는 영문/숫자/밑줄 3~16자여야 합니다.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 100)
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  const nameErr = validateName(charName);
  if (nameErr) return res.status(400).json({ error: nameErr });
  const code = typeof inviteCode === 'string' ? inviteCode.trim().toUpperCase() : '';

  try {
    const result = db.transaction(() => {
      const invite = db.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL').get(code);
      if (!invite) throw new Error('INVITE');
      const { hash, salt } = hashPassword(password);
      const u = db.prepare(
        'INSERT INTO users (username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)'
      ).run(username, hash, salt, now());
      db.prepare('INSERT INTO characters (user_id, name, gold, updated_at) VALUES (?, ?, ?, ?)')
        .run(u.lastInsertRowid, charName.trim(), ECO.settings.startGold, now());
      db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?')
        .run(u.lastInsertRowid, now(), code);
      return u.lastInsertRowid;
    })();
    const token = createSession(result);
    setSessionCookie(req, res, token);
    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'INVITE') return res.status(400).json({ error: '유효하지 않거나 이미 사용된 초대코드입니다.' });
    if (String(e.message).includes('users.username')) return res.status(400).json({ error: '이미 사용 중인 아이디입니다.' });
    if (String(e.message).includes('characters.name') || String(e.message).includes('idx_char_name'))
      return res.status(400).json({ error: '이미 사용 중인 캐릭터 이름입니다.' });
    console.error(e);
    res.status(500).json({ error: '가입 중 오류가 발생했습니다.' });
  }
});

app.post('/api/login', limitAttempts, (req, res) => {
  const { username, password } = req.body || {};
  const u = typeof username === 'string' ? q.userByName.get(username) : null;
  // 존재하지 않는 계정이어도 같은 시간 걸리도록 더미 해시 계산
  const ok = u
    ? verifyPassword(String(password || ''), u.password_hash, u.password_salt)
    : (hashPassword(String(password || '')), false);
  if (!u || !ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  if (u.banned) return res.status(403).json({ error: '이용이 정지된 계정입니다.' });
  setSessionCookie(req, res, createSession(u.id));
  res.json({ ok: true });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({
    user: { id: u.id, username: u.username, isAdmin: !!u.is_admin, mutedUntil: u.muted_until },
    unreadNotifications: feed.unreadCount(u.id),
    character: publicChar(q.charByUser.get(u.id)),
    classes: CLASSES,
    game: gameInfo(),
    limits: LIMITS,
    maxImageMb: MAX_IMAGE_MB,
  });
});

// ---- 캐릭터 ----
app.put('/api/character', auth, (req, res) => {
  const b = req.body || {};
  const nameErr = validateName(b.name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  let cls = CLASSES.includes(b.class) ? b.class : '';
  const cur = q.charByUser.get(req.user.id);
  if (cur && cur.class !== cls && runs.hasRun(req.user.id))
    return res.status(400).json({ error: '의뢰를 한 번이라도 시작한 뒤에는 클래스를 바꿀 수 없어요.' });
  // link 를 안 보내면 기존 값 유지
  const link = b.link === undefined ? (cur ? cur.link : '') : cleanLink(b.link);
  if (link === null) return res.status(400).json({ error: '링크는 http:// 또는 https:// 로 시작하는 주소만 넣을 수 있어요.' });
  try {
    db.prepare(
      'UPDATE characters SET name = ?, class = ?, title = ?, bio = ?, appearance = ?, link = ?, updated_at = ? WHERE user_id = ?'
    ).run(
      b.name.trim(), cls,
      cleanText(b.title, LIMITS.title),
      cleanText(b.bio, LIMITS.bio, { multiline: true }),
      cleanText(b.appearance, LIMITS.appearance, { multiline: true }),
      link, now(), req.user.id
    );
  } catch (e) {
    if (String(e.message).includes('idx_char_name') || String(e.message).includes('characters.name'))
      return res.status(400).json({ error: '이미 사용 중인 캐릭터 이름입니다.' });
    throw e;
  }
  res.json({ ok: true, character: publicChar(q.charByUser.get(req.user.id)) });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: 1 } });

function removeImageFile(filename) {
  if (!filename) return;
  const p = path.join(UPLOAD_DIR, path.basename(filename));
  fs.promises.unlink(p).catch(() => {});
}

app.post('/api/character/stat', auth, (req, res) => {
  const stat = (req.body || {}).stat;
  if (!E.STATS.includes(stat)) return res.status(400).json({ error: '올릴 스탯을 골라주세요.' });
  const c = q.charByUser.get(req.user.id);
  if (!c.class) return res.status(400).json({ error: '클래스를 먼저 골라주세요.' });
  if (c.stat_points <= 0) return res.status(400).json({ error: '남은 스탯 포인트가 없어요.' });
  if (E.statBonus(RULES, c, stat) >= RULES.statCap) return res.status(400).json({ error: `${RULES.statNames[stat]}은(는) 이미 최대(+${RULES.statCap})예요.` });
  db.prepare(`UPDATE characters SET a_${stat} = a_${stat} + 1, stat_points = stat_points - 1, updated_at = ? WHERE user_id = ?`).run(now(), req.user.id);
  res.json({ ok: true, character: publicChar(q.charByUser.get(req.user.id)) });
});

app.post('/api/character/image', auth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `이미지는 ${MAX_IMAGE_MB}MB 이하여야 합니다.` : '업로드에 실패했습니다.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: '이미지 파일이 없습니다.' });
    try {
      // 실제 내용으로 형식 검사 (확장자/MIME 은 믿지 않음)
      const meta = await sharp(req.file.buffer, { limitInputPixels: 40e6 }).metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format))
        return res.status(400).json({ error: 'jpg, png, webp 형식만 올릴 수 있습니다.' });
      const filename = crypto.randomBytes(12).toString('hex') + '.webp';
      // rotate(): EXIF 방향 반영 후 메타데이터(위치정보 등)는 재인코딩으로 제거됨
      await sharp(req.file.buffer, { limitInputPixels: 40e6 })
        .rotate()
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 82 })
        .toFile(path.join(UPLOAD_DIR, filename));
      const old = q.charByUser.get(req.user.id);
      db.prepare('UPDATE characters SET image = ?, updated_at = ? WHERE user_id = ?').run(filename, now(), req.user.id);
      removeImageFile(old && old.image);
      res.json({ ok: true, image: `/uploads/${filename}` });
    } catch (e) {
      console.error('image error', e.message);
      res.status(400).json({ error: '이미지를 처리할 수 없습니다. 다른 파일로 시도해주세요.' });
    }
  });
});

app.delete('/api/character/image', auth, (req, res) => {
  const c = q.charByUser.get(req.user.id);
  db.prepare("UPDATE characters SET image = '', updated_at = ? WHERE user_id = ?").run(now(), req.user.id);
  removeImageFile(c && c.image);
  res.json({ ok: true });
});

app.get('/api/characters', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT c.*, u.banned FROM characters c JOIN users u ON u.id = c.user_id WHERE u.banned = 0 ORDER BY c.name COLLATE NOCASE'
  ).all();
  res.json({ characters: rows.map((c) => ({ ...publicChar(c), online: onlineUsers.has(c.user_id) })) });
});

app.get('/api/characters/:id', auth, (req, res) => {
  const c = q.charById.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: '캐릭터를 찾을 수 없습니다.' });
  res.json({ character: { ...publicChar(c), online: onlineUsers.has(c.user_id) } });
});

// 업로드 이미지 (파일명이 랜덤이라 추측 불가, 로그인 없이 <img> 로 쓸 수 있음)
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false, dotfiles: 'deny' }));

// ---- 채널 / 스레드 / 채팅 ----
const msgSelect = `
  SELECT m.id, m.thread_id, m.kind, m.body, m.created_at, m.user_id,
         c.name AS char_name, c.image AS char_image, c.id AS char_id
  FROM messages m
  JOIN characters c ON c.user_id = m.user_id`;
function toClientMsg(r) {
  return {
    id: r.id, threadId: r.thread_id, kind: r.kind, body: r.body, createdAt: r.created_at,
    user: { id: r.user_id, charId: r.char_id, name: r.char_name, image: r.char_image ? `/uploads/${r.char_image}` : '' },
  };
}

const getThread = (id) => db.prepare('SELECT * FROM threads WHERE id = ? AND deleted = 0').get(Number(id));

function threadToClient(r) {
  return {
    id: r.id, kind: r.kind, slug: r.slug, title: r.title, creator: r.creator_name || '',
    createdAt: r.created_at, lastMessageAt: r.last_message_at || r.created_at,
    messageCount: r.message_count, locked: !!r.locked,
    unread: r.unread || 0, participated: !!r.participated,
    runId: r.run_id || null, runPhase: r.run_phase || null,
  };
}

// 유저 기준의 스레드 목록 (안 읽은 개수 포함)
// - 내가 쓴 글은 안 읽은 글로 세지 않음
// - 읽은 기록이 없는 스레드: 내 가입 이후에 생긴 스레드면 전부 새 글, 그 전에 생긴 것·고정 채널은 0 에서 시작
function listThreadsFor(user) {
  const rows = db.prepare(`
    SELECT t.*, cu.name AS creator_name, r.participated, ru.id AS run_id, ru.phase AS run_phase,
      (SELECT COUNT(*) FROM messages m
        WHERE m.thread_id = t.id AND m.deleted = 0 AND m.user_id != @uid
          AND m.id > COALESCE(r.last_read_id,
                CASE WHEN t.kind = 'thread' AND t.created_at >= @since THEN 0 ELSE t.last_message_id END)) AS unread
    FROM threads t
    LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = @uid
    LEFT JOIN characters cu ON cu.user_id = t.created_by
    LEFT JOIN runs ru ON ru.thread_id = t.id
    WHERE t.deleted = 0
    ORDER BY (t.kind = 'channel') DESC, t.position ASC,
             COALESCE(NULLIF(t.last_message_at, 0), t.created_at) DESC, t.id DESC`)
    .all({ uid: user.id, since: user.created_at });
  return rows.map(threadToClient);
}

const upsertRead = db.prepare(`
  INSERT INTO thread_reads (thread_id, user_id, last_read_id, participated, joined_at)
  VALUES (@tid, @uid, @last, @part, @at)
  ON CONFLICT(thread_id, user_id) DO UPDATE SET
    last_read_id = MAX(last_read_id, excluded.last_read_id),
    participated = MAX(participated, excluded.participated)`);

app.get('/api/threads', auth, (req, res) => {
  res.json({ threads: listThreadsFor(req.user), globalId: GLOBAL_ID });
});

app.get('/api/threads/:id/messages', auth, (req, res) => {
  const t = getThread(req.params.id);
  if (!t) return res.status(404).json({ error: '존재하지 않는 스레드입니다.' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`${msgSelect} WHERE m.thread_id = ? AND m.deleted = 0 AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
    .all(t.id, before, HISTORY_SIZE);
  res.json({ messages: rows.reverse().map(toClientMsg), locked: !!t.locked });
});

app.post('/api/threads/:id/read', auth, (req, res) => {
  const t = getThread(req.params.id);
  if (!t) return res.status(404).json({ error: '존재하지 않는 스레드입니다.' });
  const last = Math.min(Math.max(Number((req.body || {}).lastId) || 0, 0), t.last_message_id);
  upsertRead.run({ tid: t.id, uid: req.user.id, last, part: 0, at: now() });
  res.json({ ok: true });
});

app.post('/api/threads', auth, (req, res) => {
  const u = req.user;
  const title = cleanText((req.body || {}).title, LIMITS.threadTitle);
  if (title.length < 2) return res.status(400).json({ error: '스레드 제목은 2자 이상 적어주세요.' });
  const firstBody = cleanText((req.body || {}).body, LIMITS.chat);
  if (!u.is_admin) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM threads WHERE created_by = ? AND kind = 'thread' AND created_at > ? AND id NOT IN (SELECT thread_id FROM runs)")
      .get(u.id, now() - 3600000).n;
    if (n >= THREAD_LIMIT_PER_HOUR) return res.status(429).json({ error: `스레드는 한 시간에 ${THREAD_LIMIT_PER_HOUR}개까지 만들 수 있어요.` });
  }
  const block = blockReason(u, false); // 뮤트·도배 상태면 스레드도 만들 수 없음 (아직 소모하지 않음)
  if (block) return res.status(400).json({ error: block });

  const info = db.prepare("INSERT INTO threads (kind, title, created_by, created_at) VALUES ('thread', ?, ?, ?)")
    .run(title, u.id, now());
  const threadId = Number(info.lastInsertRowid);
  upsertRead.run({ tid: threadId, uid: u.id, last: 0, part: 1, at: now() });
  if (firstBody) postMessage(u, threadId, 'say', firstBody);
  io.emit('threads:changed');
  res.json({ ok: true, id: threadId });
});

app.post('/api/report', auth, (req, res) => {
  const id = Number((req.body || {}).messageId);
  const reason = cleanText((req.body || {}).reason, 200);
  const m = db.prepare('SELECT id FROM messages WHERE id = ? AND deleted = 0').get(id);
  if (!m) return res.status(404).json({ error: '메시지를 찾을 수 없습니다.' });
  db.prepare('INSERT OR IGNORE INTO reports (message_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, reason, now());
  res.json({ ok: true });
});

// ---- 관리자 API ----
// 타임라인(글·답글·하트·멘션·알림) API
const feed = createFeed({
  db, auth, now, cleanText, blockReason, io: () => io, emitToUser, systemUserId: SYSTEM_USER_ID, maxLen: LIMITS.post,
});
app.use('/api', feed.router);

// 마을 장터(채집·제작·항아리·선물) API
const town = createTown({
  announce: feed.systemPost, notify: feed.notify,
  db, eco: ECO, rules: RULES, auth, now, rng: process.env.RNG_SEED ? E.mulberry32(Number(process.env.RNG_SEED) + 7) : E.secureRng,
  say: systemSay, emitToUser, cleanText, townChannelId: () => db.prepare("SELECT id FROM threads WHERE slug = 'town'").get().id,
});
app.use('/api', town.router);

// 의뢰(조사·전투) API
const runs = createRuns({
  town, post: feed.systemPost,
  db, rules: RULES, quests: QUESTS, auth, now, io: () => io, emitToUser, say: systemSay, upsertRead,
  cleanText, questsChannelId: () => db.prepare("SELECT id FROM threads WHERE slug = 'quests'").get().id,
  config: ROUND,
});
app.use('/api', runs.router);

const admin = express.Router();
admin.use(auth, adminOnly);

admin.get('/users', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.muted_until, u.banned, u.created_at,
           c.name AS char_name, c.image AS char_image
    FROM users u LEFT JOIN characters c ON c.user_id = u.id WHERE u.is_system = 0 ORDER BY u.id`).all();
  res.json({
    users: rows.map((r) => ({
      id: r.id, username: r.username, isAdmin: !!r.is_admin, mutedUntil: r.muted_until,
      banned: !!r.banned, createdAt: r.created_at, charName: r.char_name,
      image: r.char_image ? `/uploads/${r.char_image}` : '', online: onlineUsers.has(r.id),
    })),
  });
});

function targetUser(req, res) {
  const u = q.userById.get(Number(req.params.id));
  if (!u) { res.status(404).json({ error: '유저를 찾을 수 없습니다.' }); return null; }
  if (u.is_admin && u.id !== req.user.id) { res.status(400).json({ error: '다른 관리자는 제재할 수 없습니다.' }); return null; }
  return u;
}

admin.post('/users/:id/mute', (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const minutes = Math.min(Math.max(Number((req.body || {}).minutes) || 10, 1), 60 * 24 * 30);
  db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(now() + minutes * 60000, u.id);
  res.json({ ok: true });
});
admin.post('/users/:id/unmute', (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  db.prepare('UPDATE users SET muted_until = 0 WHERE id = ?').run(u.id);
  res.json({ ok: true });
});
admin.post('/users/:id/ban', (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  if (u.id === req.user.id) return res.status(400).json({ error: '자기 자신은 정지할 수 없습니다.' });
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  kickUser(u.id);
  res.json({ ok: true });
});
admin.post('/users/:id/unban', (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(u.id);
  res.json({ ok: true });
});
admin.post('/users/:id/password', (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const pw = (req.body || {}).password;
  if (typeof pw !== 'string' || pw.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  const { hash, salt } = hashPassword(pw);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  kickUser(u.id);
  res.json({ ok: true });
});
admin.delete('/users/:id/image', (req, res) => {
  const c = q.charByUser.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: '캐릭터를 찾을 수 없습니다.' });
  db.prepare("UPDATE characters SET image = '', updated_at = ? WHERE id = ?").run(now(), c.id);
  removeImageFile(c.image);
  res.json({ ok: true });
});

admin.get('/invites', (req, res) => {
  const rows = db.prepare(`
    SELECT i.code, i.created_at, i.used_at, u.username AS used_by
    FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC, i.code`).all();
  res.json({ invites: rows.map((r) => ({ code: r.code, createdAt: r.created_at, usedAt: r.used_at, usedBy: r.used_by })) });
});
admin.post('/invites', (req, res) => {
  const count = Math.min(Math.max(Number((req.body || {}).count) || 1, 1), 30);
  const ins = db.prepare('INSERT INTO invites (code, created_at) VALUES (?, ?)');
  const codes = [];
  for (let i = 0; i < count; i++) { const c = genInviteCode(); ins.run(c, now()); codes.push(c); }
  res.json({ codes });
});
admin.delete('/invites/:code', (req, res) => {
  db.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').run(req.params.code);
  res.json({ ok: true });
});

admin.get('/reports', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.reason, r.created_at, r.message_id, m.body, m.deleted,
           mc.name AS author, ru.username AS reporter
    FROM reports r
    JOIN messages m ON m.id = r.message_id
    JOIN characters mc ON mc.user_id = m.user_id
    JOIN users ru ON ru.id = r.reporter_id
    WHERE r.resolved = 0 ORDER BY r.id DESC LIMIT 100`).all();
  res.json({ reports: rows.map((r) => ({
    id: r.id, reason: r.reason, createdAt: r.created_at, messageId: r.message_id,
    body: r.body, deleted: !!r.deleted, author: r.author, reporter: r.reporter,
  })) });
});
admin.post('/reports/:id/resolve', (req, res) => {
  db.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
admin.delete('/messages/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: '메시지를 찾을 수 없습니다.' });
  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(id);
  db.prepare('UPDATE reports SET resolved = 1 WHERE message_id = ?').run(id);
  db.prepare('UPDATE threads SET message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ? AND deleted = 0) WHERE id = ?')
    .run(m.thread_id, m.thread_id);
  io.emit('chat:deleted', { id, threadId: m.thread_id });
  res.json({ ok: true });
});

// 스레드/채널 관리
admin.get('/threads', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, cu.name AS creator_name FROM threads t
    LEFT JOIN characters cu ON cu.user_id = t.created_by
    WHERE t.deleted = 0
    ORDER BY (t.kind = 'channel') DESC, t.position ASC, COALESCE(NULLIF(t.last_message_at, 0), t.created_at) DESC`).all();
  res.json({ threads: rows.map(threadToClient) });
});
admin.post('/threads/:id/lock', (req, res) => {
  const t = getThread(req.params.id);
  if (!t) return res.status(404).json({ error: '존재하지 않는 스레드입니다.' });
  db.prepare('UPDATE threads SET locked = ? WHERE id = ?').run((req.body || {}).locked ? 1 : 0, t.id);
  io.emit('threads:changed');
  res.json({ ok: true });
});
admin.delete('/threads/:id', (req, res) => {
  const t = getThread(req.params.id);
  if (!t) return res.status(404).json({ error: '존재하지 않는 스레드입니다.' });
  if (t.kind === 'channel') return res.status(400).json({ error: '고정 채널은 삭제할 수 없습니다. (잠금은 가능)' });
  db.prepare('UPDATE threads SET deleted = 1 WHERE id = ?').run(t.id);
  runs.onThreadDeleted(t.id);
  io.emit('threads:changed');
  res.json({ ok: true });
});
admin.post('/channels', (req, res) => {
  const title = cleanText((req.body || {}).title, LIMITS.threadTitle);
  if (title.length < 2) return res.status(400).json({ error: '채널 이름은 2자 이상 적어주세요.' });
  const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM threads WHERE kind = 'channel'").get().p;
  const info = db.prepare("INSERT INTO threads (kind, title, created_by, created_at, position) VALUES ('channel', ?, ?, ?, ?)")
    .run(title, req.user.id, now(), pos);
  io.emit('threads:changed');
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
// 밸런스 조정 (숫자·주사위·난이도). 검증 통과 시 즉시 반영, 이력은 DATA_DIR/balance.json
const balanceDo = (fn) => (req, res) => {
  try {
    const r = fn(req);
    if (r.changed) console.log(`[밸런스] ${req.user.username} 님이 ${r.changed}개 값을 바꿈`);
    res.json({ ok: true, ...r, ...balance.view() });
  } catch (e) { res.status(400).json({ error: e.message }); }
};
admin.get('/balance', (req, res) => res.json(balance.view()));
admin.post('/balance', balanceDo((req) => balance.update((req.body || {}).changes, { by: req.user.username, note: (req.body || {}).note })));
admin.post('/balance/revert', balanceDo((req) => {
  const b = req.body || {};
  return b.mode === 'before' ? balance.revertBefore(b.id, { by: req.user.username }) : balance.revert(b.id, { by: req.user.username });
}));
admin.post('/balance/reset', balanceDo((req) => balance.reset({ by: req.user.username })));
admin.get('/balance/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="balance-content.json"');
  res.json(balance.effective());
});
feed.registerAdmin(admin);
// 레이드 열기 (5단계): 레이드 의뢰 목록과 지금 열려 있는지
admin.get('/raids', (req, res) => {
  const open = Object.fromEntries(db.prepare(`SELECT r.quest_id, r.id, r.thread_id, r.phase FROM runs r JOIN threads t ON t.id = r.thread_id AND t.deleted = 0
    WHERE r.phase IN ('recruiting','investigation','combat')`).all().map((x) => [x.quest_id, x]));
  res.json({ raids: QUESTS.filter((q) => q.mode === 'raid').map((q) => ({
    id: q.id, title: q.title, summary: q.summary, minPlayers: E.partySize(q).min,
    open: open[q.id] ? { runId: open[q.id].id, threadId: open[q.id].thread_id, phase: open[q.id].phase } : null,
  })) });
});
admin.post('/raids/:questId/open', (req, res) => {
  const out = runs.openRaid(req.user.id, req.params.questId);
  if (out.status !== 200) return res.status(out.status).json({ error: out.error, runId: out.runId });
  res.json({ ok: true, runId: out.runId, threadId: out.threadId });
});

app.use('/api/admin', admin);

// 정적 파일 (프론트)
app.use(express.static(path.join(__dirname, 'public')));

// JSON 에러 핸들러
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: '잘못된 요청 형식입니다.' });
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// ---- Socket.IO ----
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024,
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true);
    try { cb(null, new URL(origin).host === req.headers.host); } catch { cb(null, false); }
  },
});

const onlineUsers = new Map(); // userId -> Set(socketId)
const chatTimes = new Map();   // userId -> [timestamps]

function presenceList() {
  const ids = [...onlineUsers.keys()];
  if (!ids.length) return [];
  const rows = db.prepare(
    `SELECT user_id, id, name, image FROM characters WHERE user_id IN (${ids.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE`
  ).all(...ids);
  return rows.map((c) => ({ userId: c.user_id, charId: c.id, name: c.name, image: c.image ? `/uploads/${c.image}` : '' }));
}
function broadcastPresence() { io.emit('presence', presenceList()); }

// 뮤트·도배 검사. consume=true 면 이번 전송을 도배 카운트에 넣음
function blockReason(user, consume) {
  if (user.muted_until > now()) {
    const left = Math.ceil((user.muted_until - now()) / 60000);
    return `채팅이 제한되었습니다. (약 ${left}분 남음)`;
  }
  const t = now();
  const arr = (chatTimes.get(user.id) || []).filter((x) => t - x < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { chatTimes.set(user.id, arr); return '너무 빠르게 입력하고 있어요. 잠시 후 다시 해주세요.'; }
  if (consume) arr.push(t);
  chatTimes.set(user.id, arr);
  return null;
}

// 메시지 저장 + 전송 (검사 없음). participate=true 면 글쓴이를 그 스레드의 "참여자"로 기록
function insertMessage(userId, threadId, kind, body, participate) {
  const thread = getThread(threadId);
  const t = now();
  const id = db.transaction(() => {
    const info = db.prepare('INSERT INTO messages (channel, thread_id, user_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(thread.slug || String(thread.id), thread.id, userId, kind, body, t);
    const mid = Number(info.lastInsertRowid);
    db.prepare('UPDATE threads SET last_message_id = ?, last_message_at = ?, message_count = message_count + 1 WHERE id = ?')
      .run(mid, t, thread.id);
    if (participate) upsertRead.run({ tid: thread.id, uid: userId, last: mid, part: 1, at: t }); // 쓴 시점까지 읽은 것으로
    return mid;
  })();
  const row = db.prepare(`${msgSelect} WHERE m.id = ?`).get(id);
  io.emit('chat:message', toClientMsg(row));
  return id;
}
// 진행 로그 같은 시스템 메시지 (잠금·뮤트·도배 제한 없음)
function systemSay(threadId, kind, body) { return insertMessage(SYSTEM_USER_ID, threadId, kind, body, false); }
function emitToUser(userId, event, payload) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}

// 채널·스레드 공통 유저 메시지: 잠금·전투불능·뮤트·도배 검사 후 저장
function postMessage(user, threadId, kind, body) {
  const thread = getThread(threadId);
  if (!thread) return { error: '존재하지 않는 스레드입니다.' };
  if (thread.locked && !user.is_admin) return { error: '잠긴 스레드라 글을 쓸 수 없어요.' };
  if (!user.is_admin && runs.isSilenced(user.id, thread.id)) return { error: '전투불능 상태라 이 의뢰 스레드에서는 발언할 수 없어요. (구경과 응원은 가능)' };
  const block = blockReason(user, true);
  if (block) return { error: block };
  insertMessage(user.id, thread.id, kind, body, true);
  return { ok: true };
}

function kickUser(userId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  for (const sid of set) {
    const s = io.sockets.sockets.get(sid);
    if (s) { s.emit('kicked'); s.disconnect(true); }
  }
}

io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie).sid;
  const user = userFromToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  socket.data.token = token;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);
  broadcastPresence();

  socket.on('chat:send', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    // 매 메시지마다 세션/제재 상태를 다시 확인 (밴·뮤트 즉시 반영)
    const user = userFromToken(socket.data.token);
    if (!user) { socket.disconnect(true); return; }
    const threadId = Number(payload && payload.threadId) || GLOBAL_ID;
    const kind = payload && payload.kind === 'act' ? 'act' : 'say';
    const body = cleanText(payload && payload.body, LIMITS.chat);
    if (!body) return reply({ error: '내용을 입력해주세요.' });
    const r = postMessage(user, threadId, kind, body);
    reply(r.error ? { error: r.error } : { ok: true });
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(userId);
    if (set) {
      set.delete(socket.id);
      if (!set.size) onlineUsers.delete(userId);
    }
    broadcastPresence();
  });
});

if (require.main === module) {
  runs.start();
  server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
}
module.exports = { app, server, io };
