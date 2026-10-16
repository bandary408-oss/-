'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'game.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 스키마: 계정 / 캐릭터(계정당 1개) / 세션 / 초대코드 / 채팅 로그
// 앞으로 인벤토리, 스레드, 의뢰 등은 같은 방식으로 테이블을 추가하면 됩니다.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  muted_until   INTEGER NOT NULL DEFAULT 0,   -- epoch ms, 0이면 뮤트 아님
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 계정당 캐릭터 1개 (user_id UNIQUE). 1인 다캐로 바꾸고 싶으면 UNIQUE만 풀면 됩니다.
CREATE TABLE IF NOT EXISTS characters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  class       TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',   -- 한 줄 소개
  bio         TEXT NOT NULL DEFAULT '',   -- 설정글
  appearance  TEXT NOT NULL DEFAULT '',   -- 외형 설명
  image       TEXT NOT NULL DEFAULT '',   -- uploads 폴더 안의 파일명
  updated_at  INTEGER NOT NULL
);

-- 캐릭터 이름 중복 방지 (사칭 방지, 대소문자 무시)
CREATE UNIQUE INDEX IF NOT EXISTS idx_char_name ON characters(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at     INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL DEFAULT 'global',
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'say',   -- say(대사) / act(지문)
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, id);

CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(message_id, reporter_id)
);
`);

// ---- 2단계: 채널/스레드 ----
// threads 한 테이블에 고정 채널(kind='channel')과 유저 스레드(kind='thread')를 같이 둡니다.
db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL DEFAULT 'thread',   -- channel(고정 채널) / thread(유저 스레드)
  slug             TEXT UNIQUE,                      -- 고정 채널만 사용 (예: global)
  title            TEXT NOT NULL,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  last_message_id  INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER NOT NULL DEFAULT 0,
  message_count    INTEGER NOT NULL DEFAULT 0,
  locked           INTEGER NOT NULL DEFAULT 0,
  deleted          INTEGER NOT NULL DEFAULT 0,
  position         INTEGER NOT NULL DEFAULT 0        -- 고정 채널 정렬 순서
);

-- 유저별 읽은 위치와 "참여한 스레드" 표시
CREATE TABLE IF NOT EXISTS thread_reads (
  thread_id     INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id  INTEGER NOT NULL DEFAULT 0,
  participated  INTEGER NOT NULL DEFAULT 0,          -- 글을 쓰거나 스레드를 만들면 1
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reads_user ON thread_reads(user_id, participated);
`);

// 고정 채널 시드 (처음 한 번)
const DEFAULT_CHANNELS = [
  ['global', '전체'],
  ['chat', '잡담'],
  ['quests', '의뢰 게시판'],
  ['events', '이벤트'],
];
if (!db.prepare("SELECT 1 FROM threads WHERE kind = 'channel' LIMIT 1").get()) {
  const ins = db.prepare("INSERT INTO threads (kind, slug, title, created_at, position) VALUES ('channel', ?, ?, ?, ?)");
  DEFAULT_CHANNELS.forEach(([slug, title], i) => ins.run(slug, title, Date.now(), i));
}

// messages 에 thread_id 추가 (1단계 DB 에서 올라온 경우 기존 채팅은 '전체' 채널로 이관)
const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!msgCols.includes('thread_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN thread_id INTEGER REFERENCES threads(id)');
}
const GLOBAL_ID = db.prepare("SELECT id FROM threads WHERE slug = 'global'").get().id;
db.prepare('UPDATE messages SET thread_id = ? WHERE thread_id IS NULL').run(GLOBAL_ID);
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id)');
// 채널 카운터 보정 (이관 직후, 혹은 불일치가 있을 때)
db.exec(`
UPDATE threads SET
  last_message_id = COALESCE((SELECT MAX(id) FROM messages m WHERE m.thread_id = threads.id AND m.deleted = 0), 0),
  last_message_at = COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.thread_id = threads.id AND m.deleted = 0), 0),
  message_count   = (SELECT COUNT(*) FROM messages m WHERE m.thread_id = threads.id AND m.deleted = 0)
WHERE kind = 'channel'`);

// ---- 3단계: 레벨/스탯, 의뢰 진행(runs), 응원, 클리어 기록, 단서 ----
function addColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('characters', 'level', 'INTEGER NOT NULL DEFAULT 1');
addColumn('characters', 'xp', 'INTEGER NOT NULL DEFAULT 0');
addColumn('characters', 'stat_points', 'INTEGER NOT NULL DEFAULT 0');
for (const s of ['str', 'dex', 'int', 'cha']) addColumn('characters', 'a_' + s, 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'is_system', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
-- 의뢰 한 판. 솔로는 참가자 1명, 파티/레이드(5단계)는 여러 명이 run_players 에 들어옵니다.
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  quest_id       TEXT NOT NULL,
  thread_id      INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phase          TEXT NOT NULL,                 -- recruiting(모집 중) / investigation / combat / won / lost / abandoned / cancelled(모집 취소)
  state          TEXT NOT NULL DEFAULT '{}',    -- 조사·전투 상태 (JSON)
  round_started  INTEGER NOT NULL DEFAULT 0,    -- 현재 라운드 시작 시각 (ms)
  deadline       INTEGER NOT NULL DEFAULT 0,    -- 라운드 마감 시각 (ms), 0이면 없음
  created_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(phase, deadline);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);

CREATE TABLE IF NOT EXISTS run_players (
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'active',    -- active / ko / left
  PRIMARY KEY (run_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_run_players_user ON run_players(user_id, status);

-- 구경꾼의 응원: 라운드마다 한 사람이 한 번, 대상 1명에게
CREATE TABLE IF NOT EXISTS run_cheers (
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  round        INTEGER NOT NULL,
  from_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, round, from_user)
);

CREATE TABLE IF NOT EXISTS quest_clears (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id  TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, quest_id)
);

CREATE TABLE IF NOT EXISTS user_clues (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clue        TEXT NOT NULL,
  quest_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, clue)
);
`);

// ---- 5단계: 파티·레이드 (레이드 주간 보상 판단용 마지막 클리어 시각) ----
addColumn('quest_clears', 'last_at', 'INTEGER NOT NULL DEFAULT 0');

// ---- 4단계: 골드·스태미나, 인벤토리, 장비, 선물, 마을 채널 ----
addColumn('characters', 'gold', 'INTEGER NOT NULL DEFAULT 100');
addColumn('characters', 'stamina', 'INTEGER NOT NULL DEFAULT 8');
addColumn('characters', 'stamina_at', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS inventory (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL,
  qty      INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (user_id, item_id)
);
-- 장착 중인 장비 (인벤토리 수량에서는 빠져 있음)
CREATE TABLE IF NOT EXISTS equipment (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot     TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  PRIMARY KEY (user_id, slot)
);
CREATE TABLE IF NOT EXISTS gifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT,
  qty         INTEGER NOT NULL DEFAULT 0,
  gold        INTEGER NOT NULL DEFAULT 0,
  message     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gifts_to ON gifts(to_user, id);
CREATE INDEX IF NOT EXISTS idx_gifts_from ON gifts(from_user, created_at);
`);
// 마을 장터 채널 (이미 있는 DB 에도 한 번만 추가)
if (!db.prepare("SELECT 1 FROM threads WHERE slug = 'town'").get()) {
  const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM threads WHERE kind = 'channel'").get().p;
  db.prepare("INSERT INTO threads (kind, slug, title, created_at, position) VALUES ('channel', 'town', '마을 장터', ?, ?)").run(Date.now(), pos);
}

// ---- 5단계(타임라인): 글, 하트, 해시태그, 알림 ----
// 일반 대화는 트위터식 타임라인으로 옮겨갔습니다. 의뢰 방(threads/messages)은 실시간 채팅용으로 그대로 씁니다.
db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES posts(id),      -- 답글 대상 (없으면 일반 글)
  root_id     INTEGER REFERENCES posts(id),      -- 답글이 속한 최상위 글
  quote_id    INTEGER REFERENCES posts(id),      -- 리포스트/인용 대상
  kind        TEXT NOT NULL DEFAULT 'say',       -- say(대사) / act(지문) / sys(공식 소식)
  body        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,        -- 최상위 글에서는 달린 답글 전체 수
  like_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(parent_id, deleted, id);
CREATE INDEX IF NOT EXISTS idx_posts_root ON posts(root_id, id);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id);
CREATE INDEX IF NOT EXISTS idx_posts_quote ON posts(quote_id);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_tags (
  post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag, post_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- 받는 사람
  type        TEXT NOT NULL,        -- reply / mention / like / repost / gift
  actor_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  text        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  is_read     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);
-- 하트 알림은 같은 사람이 같은 글에 여러 번 보내지 않도록
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_like ON notifications(user_id, post_id, actor_id) WHERE type = 'like';

CREATE TABLE IF NOT EXISTS post_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(post_id, reporter_id)
);
`);

// 시스템 메시지를 올리는 보이지 않는 계정 (로그인 불가, 명단·관리자 목록에서 제외)
let sys = db.prepare('SELECT id FROM users WHERE is_system = 1').get();
if (!sys) {
  const now = Date.now();
  const id = db.prepare("INSERT INTO users (username, password_hash, password_salt, banned, is_system, created_at) VALUES ('_system', '!', '!', 1, 1, ?)").run(now).lastInsertRowid;
  db.prepare("INSERT INTO characters (user_id, name, class, updated_at) VALUES (?, '시스템', '', ?)").run(id, now);
  sys = { id };
}
const SYSTEM_USER_ID = sys.id;

module.exports = { db, DATA_DIR, UPLOAD_DIR, GLOBAL_ID, SYSTEM_USER_ID };
