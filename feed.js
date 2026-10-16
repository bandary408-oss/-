'use strict';
// 트위터식 타임라인: 글 · 답글 · 하트 · 리포스트/인용 · 멘션 · 해시태그 · 알림
const express = require('express');

const TAG_RE = /#([\p{L}\p{N}_]{1,30})/gu;
const MENTION_RE = /@([^\s@#]{2,13})/g;
const PAGE = 30;

function createFeed(ctx) {
  const { db, auth, now, cleanText, blockReason, io, emitToUser, systemUserId, maxLen } = ctx;

  const postSelect = `SELECT p.*, c.name AS char_name, c.image AS char_image, c.id AS char_id, c.class AS char_class
    FROM posts p JOIN characters c ON c.user_id = p.user_id`;
  const getPost = (id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  const img = (f) => (f ? `/uploads/${f}` : '');
  const userView = (r) => ({ id: r.user_id, charId: r.char_id, name: r.char_name, image: img(r.char_image), class: r.char_class || '' });

  // 글 목록을 화면용으로 (하트 여부, 인용 글, 답글 대상 이름을 한꺼번에 채움)
  function views(rows, viewerId) {
    if (!rows.length) return [];
    const qs = (arr) => arr.map(() => '?').join(',');
    const ids = rows.map((r) => r.id);
    const liked = new Set(db.prepare(`SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN (${qs(ids)})`).all(viewerId, ...ids).map((x) => x.post_id));
    const quoteIds = [...new Set(rows.map((r) => r.quote_id).filter(Boolean))];
    const quotes = {};
    if (quoteIds.length) db.prepare(`${postSelect} WHERE p.id IN (${qs(quoteIds)})`).all(...quoteIds).forEach((q) => { quotes[q.id] = q; });
    const parentIds = [...new Set(rows.map((r) => r.parent_id).filter(Boolean))];
    const parents = {};
    if (parentIds.length) db.prepare(`SELECT p.id, c.name FROM posts p JOIN characters c ON c.user_id = p.user_id WHERE p.id IN (${qs(parentIds)})`).all(...parentIds).forEach((x) => { parents[x.id] = x.name; });
    const reposts = {};
    db.prepare(`SELECT quote_id, COUNT(*) AS n FROM posts WHERE quote_id IN (${qs(ids)}) AND deleted = 0 GROUP BY quote_id`).all(...ids).forEach((x) => { reposts[x.quote_id] = x.n; });
    return rows.map((r) => {
      const q = r.quote_id ? quotes[r.quote_id] : null;
      return {
        id: r.id, user: userView(r), kind: r.kind, deleted: !!r.deleted, body: r.deleted ? '' : r.body, createdAt: r.created_at,
        parentId: r.parent_id, rootId: r.root_id, replyTo: r.parent_id ? (parents[r.parent_id] || '') : '',
        replyCount: r.reply_count, likeCount: r.like_count, repostCount: reposts[r.id] || 0, liked: liked.has(r.id),
        isSystem: r.user_id === systemUserId,
        quote: q ? { id: q.id, user: userView(q), kind: q.kind, deleted: !!q.deleted, body: q.deleted ? '' : q.body, createdAt: q.created_at } : null,
      };
    });
  }
  const viewOne = (id, viewerId) => views(db.prepare(`${postSelect} WHERE p.id = ?`).all(Number(id)), viewerId)[0];

  // ---------- 알림 ----------
  function notify(userId, type, { actorId = null, postId = null, text = '' } = {}) {
    if (!userId || userId === actorId) return;
    const info = db.prepare('INSERT OR IGNORE INTO notifications (user_id, type, actor_id, post_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, type, actorId, postId, text, now());
    if (info.changes) emitToUser(userId, 'notify', { type });
  }
  const unreadCount = (uid) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(uid).n;

  // ---------- 글 만들기 (일반 글/답글/인용/시스템 공용) ----------
  function insertPost({ userId, body, kind, parent, quote }) {
    const t = now();
    const rootId = parent ? (parent.root_id || parent.id) : null;
    const id = db.transaction(() => {
      const mid = Number(db.prepare('INSERT INTO posts (user_id, parent_id, root_id, quote_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(userId, parent ? parent.id : null, rootId, quote ? quote.id : null, kind, body, t).lastInsertRowid);
      if (rootId) db.prepare('UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?').run(rootId);
      const tags = new Set([...body.matchAll(TAG_RE)].map((m) => m[1].toLowerCase()));
      tags.forEach((tag) => db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)').run(mid, tag));
      return mid;
    })();
    // 알림: 답글 → 원글 작성자, 인용 → 인용된 글 작성자, 멘션 → 불린 사람
    const done = new Set();
    if (parent) { notify(parent.user_id, 'reply', { actorId: userId, postId: id }); done.add(parent.user_id); }
    if (quote) { notify(quote.user_id, 'repost', { actorId: userId, postId: id }); done.add(quote.user_id); }
    for (const m of body.matchAll(MENTION_RE)) {
      const name = m[1].replace(/[.,!?~…)\]」』"']+$/u, '');
      const u = name ? db.prepare('SELECT c.user_id FROM characters c JOIN users u ON u.id = c.user_id WHERE c.name = ? COLLATE NOCASE AND u.banned = 0').get(name) : null;
      if (u && !done.has(u.user_id)) { notify(u.user_id, 'mention', { actorId: userId, postId: id }); done.add(u.user_id); }
    }
    io().emit('post:new', { id, parentId: parent ? parent.id : null, rootId, userId });
    return id;
  }
  // 공식 소식 (시스템 계정): 클리어, 희귀 드롭, 선물 등이 타임라인에 올라감
  function systemPost(body) {
    try { return insertPost({ userId: systemUserId, body: String(body).slice(0, 500), kind: 'sys', parent: null, quote: null }); }
    catch (e) { console.error('[systemPost]', e.message); return null; }
  }

  const r = express.Router();
  const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });

  r.get('/feed', auth, (req, res) => {
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const tag = typeof req.query.tag === 'string' ? req.query.tag.replace(/^#/, '').toLowerCase() : '';
    const rows = db.prepare(`${postSelect} WHERE p.parent_id IS NULL AND p.deleted = 0 AND p.id < @before
      ${tag ? 'AND p.id IN (SELECT post_id FROM post_tags WHERE tag = @tag)' : ''} ORDER BY p.id DESC LIMIT @lim`)
      .all({ before, lim: PAGE + 1, ...(tag ? { tag } : {}) });
    res.json({ posts: views(rows.slice(0, PAGE), req.user.id), hasMore: rows.length > PAGE });
  });

  // 글 하나 + 그 글(또는 답글이 속한 최상위 글)의 답글들
  r.get('/posts/:id', auth, (req, res) => {
    const p = getPost(req.params.id);
    if (!p) return fail(res, '글을 찾을 수 없어요.', 404);
    const rootId = p.root_id || p.id;
    const root = viewOne(rootId, req.user.id);
    const rows = db.prepare(`${postSelect} WHERE p.root_id = ? AND p.deleted = 0 ORDER BY p.id ASC LIMIT 300`).all(rootId);
    res.json({ root, replies: views(rows, req.user.id), focusId: p.id });
  });

  r.post('/posts', auth, (req, res) => {
    const b = req.body || {};
    const body = cleanText(b.body, maxLen, { multiline: true });
    const kind = b.kind === 'act' ? 'act' : 'say';
    let parent = null, quote = null;
    if (b.parentId) {
      parent = getPost(b.parentId);
      if (!parent || parent.deleted) return fail(res, '답글을 달 글이 없어요.');
    }
    if (b.quoteId) {
      if (parent) return fail(res, '답글과 인용은 함께 할 수 없어요.');
      quote = getPost(b.quoteId);
      if (quote && quote.quote_id && !quote.body) quote = getPost(quote.quote_id); // 리포스트의 리포스트는 원본을 가리킴
      if (!quote || quote.deleted) return fail(res, '인용할 글이 없어요.');
    }
    if (!body && !quote) return fail(res, '내용을 입력해주세요.');
    const block = blockReason(req.user, true);
    if (block) return fail(res, block);
    const id = insertPost({ userId: req.user.id, body, kind, parent, quote });
    res.json({ ok: true, post: viewOne(id, req.user.id) });
  });

  r.delete('/posts/:id', auth, (req, res) => {
    const p = getPost(req.params.id);
    if (!p || p.deleted) return fail(res, '글을 찾을 수 없어요.', 404);
    if (p.user_id !== req.user.id && !req.user.is_admin) return fail(res, '내 글만 지울 수 있어요.', 403);
    db.transaction(() => {
      db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').run(p.id);
      if (p.root_id) db.prepare('UPDATE posts SET reply_count = MAX(0, reply_count - 1) WHERE id = ?').run(p.root_id);
      db.prepare('UPDATE post_reports SET resolved = 1 WHERE post_id = ?').run(p.id);
    })();
    io().emit('post:deleted', { id: p.id, rootId: p.root_id });
    res.json({ ok: true });
  });

  r.post('/posts/:id/like', auth, (req, res) => {
    const p = getPost(req.params.id);
    if (!p || p.deleted) return fail(res, '글을 찾을 수 없어요.', 404);
    const had = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(p.id, req.user.id);
    db.transaction(() => {
      if (had) db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(p.id, req.user.id);
      else db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(p.id, req.user.id);
      db.prepare('UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = ?) WHERE id = ?').run(p.id, p.id);
    })();
    if (!had) notify(p.user_id, 'like', { actorId: req.user.id, postId: p.id });
    const likeCount = getPost(p.id).like_count;
    io().emit('post:update', { id: p.id, likeCount });
    res.json({ ok: true, liked: !had, likeCount });
  });

  r.post('/posts/:id/report', auth, (req, res) => {
    const p = getPost(req.params.id);
    if (!p || p.deleted) return fail(res, '글을 찾을 수 없어요.', 404);
    db.prepare('INSERT OR IGNORE INTO post_reports (post_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(p.id, req.user.id, cleanText(req.body && req.body.reason, 200), now());
    res.json({ ok: true });
  });

  // 캐릭터별 글 (프로필의 "내가 쓴 글")
  r.get('/characters/:id/posts', auth, (req, res) => {
    const c = db.prepare('SELECT user_id FROM characters WHERE id = ?').get(Number(req.params.id));
    if (!c) return fail(res, '캐릭터를 찾을 수 없어요.', 404);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`${postSelect} WHERE p.user_id = ? AND p.deleted = 0 AND p.id < ? ORDER BY p.id DESC LIMIT ?`).all(c.user_id, before, 21);
    res.json({ posts: views(rows.slice(0, 20), req.user.id), hasMore: rows.length > 20 });
  });

  r.get('/tags', auth, (req, res) => {
    const rows = db.prepare(`SELECT t.tag, COUNT(*) AS n FROM post_tags t JOIN posts p ON p.id = t.post_id
      WHERE p.deleted = 0 AND p.created_at > ? GROUP BY t.tag ORDER BY n DESC, MAX(t.post_id) DESC LIMIT 8`).all(now() - 3 * 86400000);
    res.json({ tags: rows.map((x) => ({ tag: x.tag, count: x.n })) });
  });

  r.get('/notifications', auth, (req, res) => {
    const rows = db.prepare(`SELECT n.*, c.name AS actor_name, p.body AS post_body, p.root_id AS post_root, p.deleted AS post_deleted
      FROM notifications n LEFT JOIN characters c ON c.user_id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id
      WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`).all(req.user.id);
    res.json({ unread: unreadCount(req.user.id), items: rows.map((n) => ({
      id: n.id, type: n.type, actor: n.actor_name || '', postId: n.post_id, text: n.text, read: !!n.is_read, createdAt: n.created_at,
      snippet: n.post_deleted ? '' : (n.post_body || '').slice(0, 80) })) });
  });
  r.post('/notifications/read', auth, (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
    res.json({ ok: true });
  });

  // 관리자: 최근 글 / 글 신고
  function registerAdmin(admin) {
    admin.get('/posts', (req, res) => {
      const rows = db.prepare(`${postSelect} WHERE p.deleted = 0 ORDER BY p.id DESC LIMIT 100`).all();
      res.json({ posts: views(rows, req.user.id) });
    });
    admin.get('/post-reports', (req, res) => {
      const rows = db.prepare(`SELECT r.id, r.reason, r.created_at, r.post_id, p.body, p.deleted, c.name AS author, ru.username AS reporter
        FROM post_reports r JOIN posts p ON p.id = r.post_id JOIN characters c ON c.user_id = p.user_id JOIN users ru ON ru.id = r.reporter_id
        WHERE r.resolved = 0 ORDER BY r.id DESC LIMIT 100`).all();
      res.json({ reports: rows.map((x) => ({ id: x.id, reason: x.reason, createdAt: x.created_at, postId: x.post_id, body: x.body, deleted: !!x.deleted, author: x.author, reporter: x.reporter })) });
    });
    admin.post('/post-reports/:id/resolve', (req, res) => {
      db.prepare('UPDATE post_reports SET resolved = 1 WHERE id = ?').run(Number(req.params.id));
      res.json({ ok: true });
    });
  }

  return { router: r, notify, systemPost, unreadCount, registerAdmin, insertPost };
}

module.exports = { createFeed };
