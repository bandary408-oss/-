'use strict';
// 잼컨: 오늘의 운세(하루 한 번 + 연속 출석) · 업적과 칭호.
// 숫자는 전부 content/economy.json 의 daily / achievements 에 있어 관리자 [밸런스] 탭에서 바꿀 수 있어요.
const express = require('express');
const X = require('./economy');

function createFun(ctx) {
  const { db, eco, auth, now, rng, announce, notify, emitToUser } = ctx;
  const town = () => ctx.town();
  const achById = (id) => (eco.achievements || []).find((a) => a.id === id);
  const fortuneById = (id) => ((eco.daily && eco.daily.fortunes) || []).find((f) => f.id === id);

  // ---------- 카운터 ----------
  const getCounter = (uid, key) => (db.prepare('SELECT n FROM user_counters WHERE user_id = ? AND key = ?').get(uid, key) || { n: 0 }).n;
  const bumpStmt = db.prepare('INSERT INTO user_counters (user_id, key, n) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET n = n + excluded.n');
  const maxStmt = db.prepare('INSERT INTO user_counters (user_id, key, n) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET n = MAX(n, excluded.n)');
  const setStmt = db.prepare('INSERT INTO user_counters (user_id, key, n) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET n = excluded.n');
  const isPlayer = (uid) => { const u = db.prepare('SELECT is_system FROM users WHERE id = ?').get(uid); return !!u && !u.is_system; };

  // 행동 기록 (+n). 업적 조건을 넘으면 바로 달성 처리
  function track(uid, key, n = 1) {
    if (!uid || !n || !isPlayer(uid)) return;
    bumpStmt.run(uid, key, n);
    check(uid, key);
  }
  // 최고 기록 (연속 출석, 연속 꽝 같은 것)
  function trackMax(uid, key, v) {
    if (!uid || !isPlayer(uid)) return;
    maxStmt.run(uid, key, v);
    check(uid, key);
  }
  const setCounter = (uid, key, v) => setStmt.run(uid, key, v);

  function check(uid, key) {
    for (const a of eco.achievements || []) {
      if (key && a.counter !== key) continue;
      if (getCounter(uid, a.counter) < a.goal) continue;
      unlock(uid, a);
    }
  }
  function unlock(uid, a) {
    const t = now();
    const got = db.transaction(() => {
      const info = db.prepare('INSERT OR IGNORE INTO user_achievements (user_id, ach_id, created_at) VALUES (?, ?, ?)').run(uid, a.id, t);
      if (!info.changes) return false;
      if (a.gold) town().addGold(uid, a.gold);
      return true;
    })();
    if (!got) return;
    const c = db.prepare('SELECT name FROM characters WHERE user_id = ?').get(uid);
    notify(uid, 'achievement', { text: `「${a.name}」${a.gold ? ` (+${a.gold}G)` : ''}` });
    emitToUser(uid, 'achievement', { id: a.id, name: a.name, desc: a.desc, gold: a.gold });
    if (!a.quiet && c) announce(`🏅 ${c.name}이(가) 업적 「${a.name}」을(를) 달성했다! — ${a.desc} #업적`);
  }

  // ---------- 오늘의 운세 ----------
  function todayRow(uid) {
    return db.prepare('SELECT * FROM daily_draws WHERE user_id = ? AND day = ?').get(uid, X.dayKey(eco, now()));
  }
  // 오늘 운세가 주는 하루짜리 효과 (밸런스 조정이 바로 반영되도록 운세 정의에서 읽음)
  function buffOf(uid) {
    const row = eco.daily ? todayRow(uid) : null;
    const f = row && fortuneById(row.fortune_id);
    return { craftBonus: (f && f.craftBonus) || 0, farmDouble: Math.max(0, Math.min(100, (f && f.farmDouble) || 0)) };
  }
  function streakNow(uid) {
    const t = now();
    const row = db.prepare('SELECT day, streak FROM daily_draws WHERE user_id = ? ORDER BY day DESC LIMIT 1').get(uid);
    if (!row) return 0;
    return row.day === X.dayKey(eco, t) || row.day === X.prevDayKey(eco, t) ? row.streak : 0;
  }
  function dailyView(uid) {
    const row = todayRow(uid);
    const f = row && fortuneById(row.fortune_id);
    return {
      today: row ? { ...JSON.parse(row.result), craftBonus: (f && f.craftBonus) || 0, farmDouble: (f && f.farmDouble) || 0 } : null,
      streak: streakNow(uid),
      fortunes: eco.daily.fortunes.map((x) => ({ id: x.id, name: x.name })),
    };
  }

  const r = express.Router();
  const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });

  r.get('/daily', auth, (req, res) => {
    if (!eco.daily) return fail(res, '오늘의 운세가 꺼져 있어요.', 404);
    res.json(dailyView(req.user.id));
  });
  r.post('/daily', auth, (req, res) => {
    if (!eco.daily) return fail(res, '오늘의 운세가 꺼져 있어요.', 404);
    const uid = req.user.id, t = now();
    const day = X.dayKey(eco, t);
    let out = null;
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM daily_draws WHERE user_id = ? AND day = ?').get(uid, day)) return;
      const prev = db.prepare('SELECT streak FROM daily_draws WHERE user_id = ? AND day = ?').get(uid, X.prevDayKey(eco, t));
      const streak = prev ? prev.streak + 1 : 1;
      const x = X.rollFortune(rng, eco, streak);
      const c = db.prepare('SELECT * FROM characters WHERE user_id = ?').get(uid);
      // 체력 회복 (최대치까지)
      let stamina = 0;
      if (x.stamina) {
        const st = X.staminaNow(eco, c, t);
        stamina = Math.min(st.max, st.cur + x.stamina) - st.cur;
        if (stamina > 0) db.prepare('UPDATE characters SET stamina = ?, stamina_at = ? WHERE user_id = ?').run(st.cur + stamina, st.since, uid);
      }
      const gold = x.gold + x.streakGold;
      if (gold) town().addGold(uid, gold);
      if (x.streakItem) town().addItem(uid, x.streakItem, 1);
      out = { ...x, stamina, totalGold: gold, streak, streakItemName: x.streakItem ? town().itemName(x.streakItem) : '' };
      db.prepare('INSERT INTO daily_draws (user_id, day, fortune_id, streak, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uid, day, x.fortune, streak, JSON.stringify(out), t);
    })();
    if (!out) return fail(res, '오늘의 운세는 이미 뽑았어요. 내일 다시 오세요!');
    track(uid, 'daily');
    track(uid, 'fortune_' + out.fortune);
    trackMax(uid, 'daily_streak', out.streak);
    const f = fortuneById(out.fortune);
    if (f && f.announce) {
      const c = db.prepare('SELECT name FROM characters WHERE user_id = ?').get(uid);
      announce(`🔮 ${c.name}의 오늘 운세는 【${out.name}】! “${out.text}” #운세`);
    }
    res.json({ ok: true, result: out, ...dailyView(uid), inv: town().invView(uid) });
  });

  // ---------- 업적·칭호 ----------
  function holders() {
    return Object.fromEntries(db.prepare(`SELECT a.ach_id, COUNT(*) AS n FROM user_achievements a JOIN users u ON u.id = a.user_id
      WHERE u.banned = 0 GROUP BY a.ach_id`).all().map((x) => [x.ach_id, x.n]));
  }
  r.get('/achievements', auth, (req, res) => {
    const uid = req.user.id;
    check(uid, null); // 목표치가 밸런스 탭에서 낮아졌을 수도 있으니 한 번 더 확인
    const got = Object.fromEntries(db.prepare('SELECT ach_id, created_at FROM user_achievements WHERE user_id = ?').all(uid).map((x) => [x.ach_id, x.created_at]));
    const hs = holders();
    const badge = db.prepare('SELECT badge FROM characters WHERE user_id = ?').get(uid).badge;
    res.json({
      badge,
      achievements: (eco.achievements || []).map((a) => {
        const earned = got[a.id] !== undefined;
        const secret = a.hidden && !earned;
        return { id: a.id, name: secret ? '???' : a.name, desc: secret ? '숨겨진 업적' : a.desc, goal: a.goal, gold: a.gold, hidden: !!a.hidden,
          progress: Math.min(a.goal, getCounter(uid, a.counter)), earned, earnedAt: got[a.id] || null, holders: hs[a.id] || 0 };
      }),
    });
  });
  r.get('/characters/:id/achievements', auth, (req, res) => {
    const c = db.prepare('SELECT user_id FROM characters WHERE id = ?').get(Number(req.params.id));
    if (!c) return fail(res, '캐릭터를 찾을 수 없습니다.', 404);
    const rows = db.prepare('SELECT ach_id, created_at FROM user_achievements WHERE user_id = ? ORDER BY created_at').all(c.user_id);
    res.json({ achievements: rows.map((x) => achById(x.ach_id)).filter(Boolean).map((a) => ({ id: a.id, name: a.name, desc: a.desc })),
      total: (eco.achievements || []).length });
  });
  r.post('/character/badge', auth, (req, res) => {
    const id = (req.body || {}).id;
    if (id === '' || id === null || id === undefined) {
      db.prepare("UPDATE characters SET badge = '' WHERE user_id = ?").run(req.user.id);
      return res.json({ ok: true, badge: '' });
    }
    if (typeof id !== 'string' || !achById(id)) return fail(res, '없는 칭호예요.');
    if (!db.prepare('SELECT 1 FROM user_achievements WHERE user_id = ? AND ach_id = ?').get(req.user.id, id)) return fail(res, '아직 얻지 못한 칭호예요.');
    db.prepare('UPDATE characters SET badge = ? WHERE user_id = ?').run(id, req.user.id);
    res.json({ ok: true, badge: id });
  });

  // 칭호 이름 (업적이 콘텐츠에서 지워졌으면 빈칸)
  const badgeName = (id) => { const a = id && achById(id); return a ? a.name : ''; };

  return { router: r, track, trackMax, setCounter, getCounter, buffOf, badgeName };
}

module.exports = { createFun };
