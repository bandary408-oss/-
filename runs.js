'use strict';
// 의뢰 진행(조사 → 전투). 상태는 전부 DB(runs.state)에 있어서 서버를 껐다 켜도 이어집니다.
// 진행 로그는 의뢰 스레드의 채팅에 시스템 메시지로 흐르고, 구경꾼은 같은 스레드에서 떠들고 응원합니다.
// 모드: solo(혼자) / party(방장이 모집, 2~4명) / raid(관리자가 엶, 최소 3명·최대 제한 없음)
//  파티·레이드는 'recruiting'(모집 중) 단계에서 참가자를 모은 뒤 출발합니다.
const express = require('express');
const E = require('./engine');

function createRuns(ctx) {
  const { town, post, db, rules, quests, auth, now, io, emitToUser, say, upsertRead, cleanText, questsChannelId, config } = ctx;
  const questsById = Object.fromEntries(quests.map((x) => [x.id, x]));
  const seedEnv = process.env.RNG_SEED;
  const rng = seedEnv !== undefined && seedEnv !== '' ? E.mulberry32(Number(seedEnv)) : E.secureRng;
  const ACTIVE = "('investigation','combat')";
  const BUSY = "('recruiting','investigation','combat')"; // 이 단계의 의뢰에 들어가 있으면 다른 의뢰를 못 함
  const MODE_LABEL = { solo: '솔로', party: '파티', raid: '레이드' };
  const KST = 9 * 3600 * 1000;
  // 이번 주 월요일 0시(한국 시간)
  const weekStart = (t) => { const d = new Date(t + KST); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86400000 - KST; };
  const sys = (tid, body) => say(tid, 'sys', body);
  const track = (uid, key) => { if (ctx.track) ctx.track(uid, key); };
  const roll = (tid, body) => say(tid, 'roll', body);
  const statName = (s) => rules.statNames[s];

  // ---------- 저장/로드 ----------
  function loadRun(id) {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(id));
    if (!r) return null;
    r.state = JSON.parse(r.state || '{}');
    return r;
  }
  function saveRun(r) {
    db.prepare('UPDATE runs SET phase = ?, state = ?, round_started = ?, deadline = ?, ended_at = ? WHERE id = ?')
      .run(r.phase, JSON.stringify(r.state), r.round_started, r.deadline, r.ended_at, r.id);
  }
  const charOf = (uid) => db.prepare('SELECT * FROM characters WHERE user_id = ?').get(uid);
  function playerFromChar(c) {
    const sh = E.sheet(rules, c);
    const gear = town.gearOf(c.user_id); // 장비 보너스: 최대 HP·방어도·명중
    return { userId: c.user_id, name: c.name, cls: c.class, hp: sh.maxHp + gear.hp, maxHp: sh.maxHp + gear.hp, stats: sh.stats, ac: sh.ac + gear.ac, attackBonus: gear.attack };
  }
  const notify = (run) => { io().emit('run:update', { runId: run.id, threadId: run.thread_id }); };
  const playersOf = (runId) => db.prepare("SELECT user_id, status FROM run_players WHERE run_id = ? AND status != 'left' ORDER BY rowid").all(runId);
  const isAdminUser = (uid) => !!(db.prepare('SELECT is_admin FROM users WHERE id = ?').get(uid) || {}).is_admin;
  // 지금 들어가 있는 의뢰(모집 중 포함). KO·이탈한 의뢰는 끝난 것으로 봄.
  const busyRun = (uid) => db.prepare(`SELECT r.id, r.thread_id, r.quest_id FROM runs r
    JOIN run_players rp ON rp.run_id = r.id AND rp.user_id = ? AND rp.status = 'active'
    JOIN threads t ON t.id = r.thread_id AND t.deleted = 0
    WHERE r.phase IN ${BUSY} ORDER BY r.id DESC`).get(uid);
  const nameList = (runId) => playersOf(runId).map((p) => charOf(p.user_id).name).join(', ') || '용병단';

  // ---------- 라운드 시계 ----------
  function startRoundClock(run, announce = true) {
    const st = run.state;
    st.pending = {};
    st.readyAt = 0;
    run.round_started = now();
    run.deadline = now() + config.deadlineSec * 1000;
    if (announce) sys(run.thread_id, `⏱ ${st.combat.round}라운드 — 행동을 고르세요. (${config.deadlineSec}초 안에 고르지 않으면 방어)\n구경하는 사람은 💬 채팅으로 떠들고, 📣 응원 버튼으로 힘을 보탤 수 있어요.`);
  }

  function enemyLines(combat, mods) {
    return combat.enemies.filter((e) => e.hp > 0).map((e) => `👹 ${e.name}  HP ${e.hp}/${e.maxHp} · 방어도 ${e.ac + (mods.enemyAc || 0)}`);
  }

  function beginCombat(run, ambush) {
    const quest = questsById[run.quest_id];
    const st = run.state;
    const players = playersOf(run.id).map((p) => playerFromChar(charOf(p.user_id)));
    st.combat = E.makeCombatState({ quest, players, mods: st.mods, rules });
    run.phase = 'combat';
    const notes = [];
    if (st.mods.enemyAc) notes.push(`적 방어도 ${E.signed(st.mods.enemyAc)}`);
    if (st.mods.attackBonus) notes.push(`명중 굴림 ${E.signed(st.mods.attackBonus)}`);
    sys(run.thread_id, [quest.combat.intro, ...enemyLines(st.combat, st.mods), notes.length ? `🔎 조사 효과: ${notes.join(', ')}` : ''].filter(Boolean).join('\n'));
    if (ambush) {
      sys(run.thread_id, quest.combat.ambushText || '💥 기습!');
      const r = E.resolveRound({ rules, state: st.combat, rng, ambush: true });
      applyResolution(run, r, true);
      return;
    }
    startRoundClock(run);
    saveRun(run);
  }

  function resolveCurrent(run) {
    const st = run.state;
    const rows = db.prepare('SELECT target_user, COUNT(*) AS n FROM run_cheers WHERE run_id = ? AND round = ? GROUP BY target_user').all(run.id, st.combat.round);
    const cheers = Object.fromEntries(rows.map((r) => [r.target_user, r.n]));
    const r = E.resolveRound({ rules, state: st.combat, actions: st.pending || {}, cheers, rng });
    applyResolution(run, r, false);
  }

  function applyResolution(run, r, ambush) {
    const st = run.state;
    const quest = questsById[run.quest_id];
    st.combat = r.state;
    if (r.rollLines.length) roll(run.thread_id, r.rollLines.join('\n'));
    sys(run.thread_id, r.summary);
    for (const uid of r.koUsers) {
      db.prepare("UPDATE run_players SET status = 'ko' WHERE run_id = ? AND user_id = ?").run(run.id, uid);
      track(uid, 'quest_ko');
    }
    if (r.outcome === 'victory') finish(run, 'won');
    else if (r.outcome === 'defeat') finish(run, 'lost');
    else {
      startRoundClock(run);
      saveRun(run);
    }
    // 전투불능 → 해당 스레드 발언 금지(서버가 막음) + 강제 귀환(클라이언트가 의뢰 게시판으로 이동)
    for (const uid of r.koUsers) emitToUser(uid, 'run:ko', { runId: run.id, threadId: run.thread_id, returnThreadId: questsChannelId() });
    notify(run);
    io().emit('threads:changed');
    void ambush; void quest;
  }

  function finish(run, phase) {
    const quest = questsById[run.quest_id];
    run.phase = phase;
    run.ended_at = now();
    run.deadline = 0;
    run.state.readyAt = 0;
    const tag = quest.mode === 'raid' ? '#의뢰 #레이드' : '#의뢰';
    if (phase === 'won') {
      sys(run.thread_id, `🏆 ${quest.combat.victoryText}`);
      for (const p of playersOf(run.id)) { reward(run, quest, p.user_id, p.status === 'ko'); track(p.user_id, 'quest_win'); }
      post(`🏆 ${nameList(run.id)} 이(가) 「${quest.title}」 ${quest.mode === 'raid' ? '레이드' : '의뢰'}를 완료했다! ${tag}`);
    } else if (phase === 'lost') {
      post(`💀 ${nameList(run.id)} 이(가) 「${quest.title}」 ${quest.mode === 'raid' ? '레이드' : '의뢰'} 중 쓰러졌다… ${tag}`);
      sys(run.thread_id, `☠ ${quest.combat.defeatText}\n의뢰에 실패했습니다. 경험치는 없지만, 다시 도전할 수 있어요. (조사 단서는 남습니다)`);
    }
    saveRun(run);
  }

  // 보상은 나눠 갖지 않고 각자 전액. 전투불능으로 끝난 사람은 경험치만 rules.party.koXpRatio 배.
  // 레이드는 같은 주(월요일 0시 기준)에 두 번째부터 경험치·골드가 줄고 아이템이 없어요.
  function reward(run, quest, userId, wasKo) {
    const c = charOf(userId);
    const t = now();
    const row = db.prepare('SELECT count, last_at FROM quest_clears WHERE user_id = ? AND quest_id = ?').get(userId, quest.id);
    const prior = quest.mode === 'raid' ? !!row && row.last_at >= weekStart(t) : !!row;
    let xp = prior ? Math.round(quest.reward.xp * rules.repeatXpRatio) : quest.reward.xp;
    if (wasKo) xp = Math.round(xp * rules.party.koXpRatio);
    db.prepare(`INSERT INTO quest_clears (user_id, quest_id, count, first_at, last_at) VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(user_id, quest_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).run(userId, quest.id, t, t);
    const a = E.applyXp(rules, c, xp);
    db.prepare('UPDATE characters SET xp = ?, level = ?, stat_points = stat_points + ? WHERE user_id = ?')
      .run(a.xp, a.level, a.statPointsGained, userId);
    const notes = [];
    if (prior) notes.push(quest.mode === 'raid' ? '이번 주에 이미 클리어해서 보상이 줄었어요' : '반복 의뢰라 보상이 줄었어요');
    if (wasKo) notes.push('전투불능이라 경험치 절반');
    let msg = `✨ ${c.name} 경험치 +${xp}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    if (a.levelsGained > 0) msg += `\n🎉 레벨 ${a.level} 달성! 최대 HP 증가, 스탯 포인트 +${a.statPointsGained} (프로필에서 분배)`;
    const base = quest.reward || {};
    const rw = quest.mode === 'raid' && prior ? { gold: Math.round((base.gold || 0) * rules.repeatXpRatio), items: [] } : base;
    if (rw.gold || (rw.items && rw.items.length)) {
      town.grant(userId, { gold: rw.gold || 0, items: rw.items || [] });
      const names = (rw.items || []).map((x) => `${town.itemName(x.id)} ×${x.qty}`);
      msg += '\n💰 ' + [rw.gold ? `${rw.gold}G` : '', ...names].filter(Boolean).join(' · ');
    }
    sys(run.thread_id, msg);
  }

  // ---------- 화면용 상태 ----------
  function view(run, viewerId) {
    const quest = questsById[run.quest_id];
    const st = run.state;
    const players = playersOf(run.id);
    const mine = players.find((p) => p.user_id === viewerId);
    const size = E.partySize(quest);
    const v = {
      id: run.id, threadId: run.thread_id, questId: quest.id, title: quest.title, phase: run.phase,
      mode: quest.mode, modeLabel: MODE_LABEL[quest.mode], minPlayers: size.min, maxPlayers: size.max,
      ownerId: run.owner_id, isOwner: run.owner_id === viewerId, isPlayer: !!mine && mine.status !== 'left', myStatus: mine ? mine.status : null,
      active: run.phase === 'investigation' || run.phase === 'combat',
      members: players.filter((p) => p.status !== 'left').map((p) => { const c = charOf(p.user_id); return { userId: p.user_id, name: c.name, cls: c.class, level: c.level, status: p.status }; }),
    };
    if (run.phase === 'recruiting') {
      const busy = busyRun(viewerId);
      const c = charOf(viewerId);
      const count = v.members.length;
      v.recruiting = {
        count, full: size.max !== null && count >= size.max, canDepart: count >= size.min,
        canJoin: !mine && !busy && !!c && !!rules.classes[c.class] && (size.max === null || count < size.max),
        joinBlock: mine ? '' : busy ? '이미 다른 의뢰에 들어가 있어요.' : (!c || !rules.classes[c.class]) ? '프로필에서 클래스를 먼저 골라주세요.' : (size.max !== null && count >= size.max) ? '정원이 찼어요.' : '',
      };
    }
    if (run.phase === 'investigation') {
      const stats = E.sheet(rules, charOf(viewerId) || {}).stats;
      const maxActions = st.inv.max || rules.investigation.maxActions;
      v.investigation = {
        actionsLeft: maxActions - st.inv.actions, maxActions,
        alert: st.inv.alert, alertLimit: rules.investigation.alertLimit,
        choices: quest.investigation.choices.map((c) => ({
          id: c.id, label: c.label, stat: c.stat, statName: statName(c.stat), difficulty: c.difficulty,
          diffLabel: rules.difficulty[c.difficulty].label, dc: rules.difficulty[c.difficulty].dc,
          bonus: stats[c.stat], done: st.inv.used.includes(c.id),
        })),
      };
    }
    if (st.combat && (run.phase === 'combat' || run.phase === 'won' || run.phase === 'lost')) {
      const cb = st.combat;
      const cheerRows = db.prepare('SELECT target_user, COUNT(*) AS n FROM run_cheers WHERE run_id = ? AND round = ? GROUP BY target_user').all(run.id, cb.round);
      const cheers = Object.fromEntries(cheerRows.map((r) => [r.target_user, r.n]));
      const myCheer = db.prepare('SELECT target_user FROM run_cheers WHERE run_id = ? AND round = ? AND from_user = ?').get(run.id, cb.round, viewerId);
      v.combat = {
        round: cb.round, deadline: run.deadline, readyAt: st.readyAt || 0, minSec: config.minSec, serverNow: now(),
        mods: st.mods, cheerMax: rules.cheer.maxPerTarget, myCheer: myCheer ? myCheer.target_user : null,
        enemies: cb.enemies.map((e) => {
          const it = E.intentFor(e, cb.round);
          return { id: e.id, name: e.name, hp: e.hp, maxHp: e.maxHp, ac: e.ac + (cb.mods.enemyAc || 0),
            intent: e.hp > 0 ? it.label + (it.type === 'strike' ? ` (${it.dice}${it.bonus ? E.signed(it.bonus) : ''})` : '') : '',
            guarding: e.hp > 0 && it.type === 'guard' };
        }),
        players: cb.players.map((p) => ({
          userId: p.userId, name: p.name, cls: p.cls, hp: p.hp, maxHp: p.maxHp, status: p.status, cd: p.cd,
          cheers: cheers[p.userId] || 0, submitted: !!(st.pending && st.pending[p.userId]),
        })),
      };
      const me = cb.players.find((p) => p.userId === viewerId);
      if (me && run.phase === 'combat') {
        const sk = rules.classes[me.cls].skill;
        v.combat.me = { cd: me.cd, status: me.status, skill: { id: sk.id, name: sk.name, desc: sk.desc, cooldown: sk.cooldown, target: sk.target },
          pending: (st.pending && st.pending[viewerId]) || null };
      }
    }
    return v;
  }

  // ---------- 라우터 ----------
  const r = express.Router();

  r.get('/quests', auth, (req, res) => {
    const clears = Object.fromEntries(db.prepare('SELECT quest_id, count FROM quest_clears WHERE user_id = ?').all(req.user.id).map((x) => [x.quest_id, x.count]));
    const active = busyRun(req.user.id);
    res.json({
      quests: quests.map((x) => ({
        id: x.id, title: x.title, summary: x.summary, mode: x.mode, modeLabel: MODE_LABEL[x.mode], recommendedLevel: x.recommendedLevel,
        minPlayers: E.partySize(x).min, maxPlayers: E.partySize(x).max,
        rewardXp: x.reward.xp, rewardGold: x.reward.gold || 0, clears: clears[x.id] || 0,
      })),
      active: active ? { runId: active.id, threadId: active.thread_id, questId: active.quest_id } : null,
    });
  });

  r.post('/quests/:id/start', auth, (req, res) => {
    const quest = questsById[req.params.id];
    if (!quest) return res.status(404).json({ error: '존재하지 않는 의뢰입니다.' });
    if (quest.mode === 'raid') return res.status(403).json({ error: '레이드는 관리자가 열어요. 열리면 의뢰 게시판에서 참가할 수 있어요.' });
    const c = charOf(req.user.id);
    if (!c || !rules.classes[c.class]) return res.status(400).json({ error: '프로필에서 클래스를 먼저 골라주세요.' });
    const active = busyRun(req.user.id);
    if (active) return res.status(409).json({ error: '이미 진행 중인 의뢰가 있어요.', runId: active.id, threadId: active.thread_id });
    const out = createRun(quest, req.user.id, `📜 ${quest.title} — ${c.name}`, req.user.id);
    const run = loadRun(out.runId);
    if (quest.mode === 'party') {
      const size = E.partySize(quest);
      sys(run.thread_id, `${quest.intro}\n\n🧭 파티 모집 중 — ${size.min}~${size.max}명. 참가자가 모이면 방장(${c.name})이 출발을 눌러요.`);
      post(`🧭 ${c.name} 이(가) 「${quest.title}」 파티원을 모집합니다! (${size.min}~${size.max}명) 의뢰 게시판에서 참가하세요. #의뢰`);
    } else beginRun(run);
    notify(run);
    io().emit('threads:changed');
    res.json({ ok: true, ...out });
  });

  // 의뢰 방(스레드) + 의뢰 기록을 만든다. 파티·레이드는 모집 중으로, 솔로는 바로 진행 단계로.
  function createRun(quest, ownerId, title, firstPlayerId) {
    const t = now();
    return db.transaction(() => {
      const th = Number(db.prepare("INSERT INTO threads (kind, title, created_by, created_at) VALUES ('thread', ?, ?, ?)").run(title.slice(0, 60), ownerId, t).lastInsertRowid);
      const state = { inv: { used: [], actions: 0, alert: 0, max: rules.investigation.maxActions }, mods: { enemyAc: 0, attackBonus: 0 }, pending: {}, readyAt: 0, combat: null };
      const phase = quest.mode === 'solo' ? (quest.investigation ? 'investigation' : 'combat') : 'recruiting';
      const runId = Number(db.prepare('INSERT INTO runs (quest_id, thread_id, owner_id, phase, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(quest.id, th, ownerId, phase, JSON.stringify(state), t).lastInsertRowid);
      if (firstPlayerId) db.prepare('INSERT INTO run_players (run_id, user_id) VALUES (?, ?)').run(runId, firstPlayerId);
      upsertRead.run({ tid: th, uid: ownerId, last: 0, part: 1, at: t });
      return { runId, threadId: th };
    })();
  }

  // 출발: 조사(있으면) 또는 바로 전투. 조사 행동 수 = 기본 + (인원 - 1)
  function beginRun(run) {
    const quest = questsById[run.quest_id];
    const n = playersOf(run.id).length;
    run.state.inv.max = rules.investigation.maxActions + Math.max(0, n - 1);
    run.phase = quest.investigation ? 'investigation' : 'combat';
    const intro = quest.mode === 'solo' ? quest.intro : `🚩 출발! 참가자: ${nameList(run.id)}`;
    const invIntro = quest.investigation ? '\n\n' + quest.investigation.intro + (n > 1 ? `\n(파티 인원 ${n}명 → 조사 행동 ${run.state.inv.max}회. 참가자 누구나 고를 수 있어요.)` : '') : '';
    sys(run.thread_id, intro + invIntro);
    if (quest.investigation) saveRun(run);
    else beginCombat(run, false);
  }

  // 관리자가 레이드를 연다 (server.js 의 관리자 API 에서 호출)
  function openRaid(adminId, questId) {
    const quest = questsById[questId];
    if (!quest || quest.mode !== 'raid') return { status: 404, error: '레이드 의뢰가 아닙니다.' };
    const open = db.prepare(`SELECT r.id FROM runs r JOIN threads t ON t.id = r.thread_id AND t.deleted = 0
      WHERE r.quest_id = ? AND r.phase IN ${BUSY}`).get(quest.id);
    if (open) return { status: 409, error: '이 레이드는 이미 열려 있어요.', runId: open.id };
    const out = createRun(quest, adminId, `🐉 레이드: ${quest.title}`, null);
    const run = loadRun(out.runId);
    const size = E.partySize(quest);
    sys(run.thread_id, `${quest.intro}\n\n🐉 레이드 참가자 모집 중 — 최소 ${size.min}명${size.max ? `, 최대 ${size.max}명` : ', 인원 제한 없음'}. 모이면 관리자가 출발시켜요.`);
    post(`🐉 레이드 「${quest.title}」 이(가) 열렸습니다! 의뢰 게시판에서 참가하세요. (최소 ${size.min}명) #의뢰 #레이드`);
    notify(run);
    io().emit('threads:changed');
    return { status: 200, ...out };
  }

  // ---------- 모집 (파티·레이드) ----------
  function recruitingRun(req, res) {
    const run = loadRun(req.params.id);
    if (!run) { res.status(404).json({ error: '존재하지 않는 의뢰입니다.' }); return null; }
    if (run.phase !== 'recruiting') { res.status(400).json({ error: '모집 중인 의뢰가 아니에요.' }); return null; }
    return run;
  }
  const isRunAdmin = (run, uid) => run.owner_id === uid || (questsById[run.quest_id].mode === 'raid' && isAdminUser(uid));

  r.post('/runs/:id/join', auth, (req, res) => {
    const run = recruitingRun(req, res); if (!run) return;
    const quest = questsById[run.quest_id];
    const c = charOf(req.user.id);
    if (!c || !rules.classes[c.class]) return res.status(400).json({ error: '프로필에서 클래스를 먼저 골라주세요.' });
    const size = E.partySize(quest);
    const joined = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM run_players WHERE run_id = ? AND user_id = ?').get(run.id, req.user.id)) return '이미 참가했어요.';
      if (busyRun(req.user.id)) return '이미 다른 의뢰에 들어가 있어요.';
      if (size.max !== null && playersOf(run.id).length >= size.max) return '정원이 찼어요.';
      db.prepare('INSERT INTO run_players (run_id, user_id) VALUES (?, ?)').run(run.id, req.user.id);
      upsertRead.run({ tid: run.thread_id, uid: req.user.id, last: 0, part: 1, at: now() });
      return '';
    })();
    if (joined) return res.status(joined === '정원이 찼어요.' ? 409 : 400).json({ error: joined });
    const n = playersOf(run.id).length;
    sys(run.thread_id, `🙋 ${c.name}(${c.class} Lv.${c.level}) 참가! (${n}${size.max ? `/${size.max}` : ''}명)`);
    notify(run);
    res.json({ ok: true });
  });

  r.post('/runs/:id/leave', auth, (req, res) => {
    const run = loadRun(req.params.id);
    if (!run) return res.status(404).json({ error: '존재하지 않는 의뢰입니다.' });
    const me = db.prepare('SELECT status FROM run_players WHERE run_id = ? AND user_id = ?').get(run.id, req.user.id);
    if (!me || me.status !== 'active') return res.status(400).json({ error: '참가 중인 의뢰가 아니에요.' });
    const name = charOf(req.user.id).name;
    if (run.phase === 'recruiting') {
      if (run.owner_id === req.user.id) return cancelRecruit(run, res, `🏳 방장 ${name} 이(가) 모집을 취소했다.`);
      db.prepare('DELETE FROM run_players WHERE run_id = ? AND user_id = ?').run(run.id, req.user.id);
      sys(run.thread_id, `👋 ${name} 이(가) 파티에서 빠졌다.`);
      notify(run);
      return res.json({ ok: true });
    }
    if (run.phase !== 'investigation' && run.phase !== 'combat') return res.status(400).json({ error: '이미 끝난 의뢰예요.' });
    if (run.owner_id === req.user.id && questsById[run.quest_id].mode !== 'raid') return res.status(400).json({ error: '방장은 빠질 수 없어요. 포기하면 의뢰 전체가 끝나요.' });
    dropOut(run, req.user.id, `🏃 ${name} 이(가) 대열에서 이탈했다. (보상 없음)`);
    res.json({ ok: true });
  });

  // 진행 중 이탈: 전투에서 빠지고, 남은 사람이 없으면 실패
  function dropOut(run, uid, text) {
    db.prepare("UPDATE run_players SET status = 'left' WHERE run_id = ? AND user_id = ?").run(run.id, uid);
    sys(run.thread_id, text);
    const st = run.state;
    if (st.combat) {
      const p = st.combat.players.find((x) => x.userId === uid);
      if (p) p.status = 'left';
      if (st.pending) delete st.pending[uid];
    }
    const left = playersOf(run.id).filter((p) => p.status === 'active').length;
    if (!left) {
      if (run.phase === 'combat') finish(run, 'lost');
      else { run.phase = 'abandoned'; run.ended_at = now(); run.deadline = 0; saveRun(run); sys(run.thread_id, '🏳 남은 참가자가 없어 의뢰가 끝났다.'); }
      io().emit('threads:changed');
    } else {
      if (run.phase === 'combat') {
        const activeIds = st.combat.players.filter((p) => p.status === 'active').map((p) => p.userId);
        if (activeIds.every((id) => st.pending[id])) st.readyAt = Math.min(run.deadline, Math.max(now(), run.round_started + config.minSec * 1000));
      }
      saveRun(run);
    }
    notify(run);
  }

  function cancelRecruit(run, res, text) {
    run.phase = 'cancelled'; run.ended_at = now();
    saveRun(run);
    sys(run.thread_id, text);
    notify(run);
    io().emit('threads:changed');
    return res.json({ ok: true });
  }

  r.post('/runs/:id/kick', auth, (req, res) => {
    const run = recruitingRun(req, res); if (!run) return;
    if (!isRunAdmin(run, req.user.id)) return res.status(403).json({ error: '방장만 할 수 있어요.' });
    const uid = Number((req.body || {}).userId);
    if (uid === run.owner_id) return res.status(400).json({ error: '방장은 내보낼 수 없어요.' });
    const del = db.prepare('DELETE FROM run_players WHERE run_id = ? AND user_id = ?').run(run.id, uid);
    if (!del.changes) return res.status(400).json({ error: '참가자가 아니에요.' });
    sys(run.thread_id, `🚪 ${charOf(uid).name} 이(가) 파티에서 제외되었다.`);
    notify(run);
    res.json({ ok: true });
  });

  r.post('/runs/:id/depart', auth, (req, res) => {
    const run = recruitingRun(req, res); if (!run) return;
    if (!isRunAdmin(run, req.user.id)) return res.status(403).json({ error: '방장만 출발시킬 수 있어요.' });
    const size = E.partySize(questsById[run.quest_id]);
    const n = playersOf(run.id).length;
    if (n < size.min) return res.status(400).json({ error: `최소 ${size.min}명이 필요해요. (지금 ${n}명)` });
    beginRun(run);
    notify(run);
    io().emit('threads:changed');
    res.json({ ok: true });
  });

  // 진행 중인 의뢰 + 최근 끝난 의뢰 (구경하러 들어갈 수 있게)
  r.get('/runs', auth, (req, res) => {
    const rows = db.prepare(`SELECT r.id, r.thread_id, r.quest_id, r.phase, r.created_at, r.state, c.name AS owner,
        (SELECT COUNT(*) FROM run_players rp WHERE rp.run_id = r.id AND rp.status != 'left') AS players,
        EXISTS(SELECT 1 FROM run_players rp WHERE rp.run_id = r.id AND rp.user_id = @uid AND rp.status != 'left') AS mine
      FROM runs r JOIN threads t ON t.id = r.thread_id AND t.deleted = 0 LEFT JOIN characters c ON c.user_id = r.owner_id
      WHERE r.phase != 'cancelled'
      ORDER BY (r.phase = 'recruiting') DESC, (r.phase IN ${ACTIVE}) DESC, r.id DESC LIMIT 15`).all({ uid: req.user.id });
    res.json({ runs: rows.map((x) => {
      const st = JSON.parse(x.state || '{}');
      const q = questsById[x.quest_id];
      const size = q ? E.partySize(q) : { min: 1, max: 1 };
      return { id: x.id, threadId: x.thread_id, title: q ? q.title : x.quest_id, phase: x.phase,
        mode: q ? q.mode : 'solo', modeLabel: q ? MODE_LABEL[q.mode] : '', players: x.players, minPlayers: size.min, maxPlayers: size.max, mine: !!x.mine,
        owner: q && q.mode === 'raid' ? '레이드' : (x.owner || '?'), createdAt: x.created_at, round: st.combat ? st.combat.round : 0 };
    }) });
  });

  r.get('/runs/:id', auth, (req, res) => {
    const run = loadRun(req.params.id);
    if (!run) return res.status(404).json({ error: '존재하지 않는 의뢰입니다.' });
    res.json({ run: view(run, req.user.id) });
  });

  // 참가 중(전투불능·이탈 제외)인 사람만. ownerOnly 면 방장(레이드는 관리자)만.
  function ownedRun(req, res, phase, ownerOnly) {
    const run = loadRun(req.params.id);
    if (!run) { res.status(404).json({ error: '존재하지 않는 의뢰입니다.' }); return null; }
    if (ownerOnly) {
      if (!isRunAdmin(run, req.user.id)) { res.status(403).json({ error: '방장만 할 수 있어요.' }); return null; }
    } else {
      const me = db.prepare('SELECT status FROM run_players WHERE run_id = ? AND user_id = ?').get(run.id, req.user.id);
      if (!me || me.status === 'left') { res.status(403).json({ error: '이 의뢰의 참가자만 할 수 있어요.' }); return null; }
    }
    if (phase && run.phase !== phase) { res.status(400).json({ error: '지금은 할 수 없는 행동이에요.' }); return null; }
    return run;
  }
  const lineOf = (body) => cleanText((body || {}).line, 60);

  r.post('/runs/:id/investigate', auth, (req, res) => {
    const run = ownedRun(req, res, 'investigation'); if (!run) return;
    const quest = questsById[run.quest_id];
    const inv = run.state.inv;
    const choice = quest.investigation.choices.find((c) => c.id === (req.body || {}).choiceId);
    if (!choice) return res.status(400).json({ error: '없는 선택지입니다.' });
    if (inv.used.includes(choice.id)) return res.status(400).json({ error: '이미 한 행동이에요.' });
    const maxActions = inv.max || rules.investigation.maxActions;
    if (inv.actions >= maxActions) return res.status(400).json({ error: '조사 행동을 모두 썼어요.' });
    const c = charOf(req.user.id);
    const stats = E.sheet(rules, c).stats;
    const dcInfo = rules.difficulty[choice.difficulty];
    const out = E.check({ rng, bonus: stats[choice.stat], dc: dcInfo.dc });
    const line = lineOf(req.body);
    roll(run.thread_id, `🎲 ${c.name} ${line ? `‘${line}’ ` : ''}— ${choice.label} (${statName(choice.stat)} · ${dcInfo.label})\nd20(${out.nat})${E.signed(out.bonus)}=${out.total} vs 목표 ${out.dc} → ${E.checkLabel(out)}`);
    const lines = [];
    if (out.success) {
      lines.push(choice.success.text);
      const ef = choice.success.effect;
      if (ef) {
        if (ef.type === 'enemy_ac') run.state.mods.enemyAc += ef.value;
        else if (ef.type === 'attack_bonus') run.state.mods.attackBonus += ef.value;
        else if (ef.type === 'alert') inv.alert = Math.max(0, inv.alert + ef.value);
        lines.push(`✔ ${ef.label || '효과 적용'}`);
      }
      if (choice.success.clue) { // 단서는 파티 전원이 함께 얻음
        for (const p of playersOf(run.id)) db.prepare('INSERT OR IGNORE INTO user_clues (user_id, clue, quest_id, created_at) VALUES (?, ?, ?, ?)').run(p.user_id, choice.success.clue, quest.id, now());
        lines.push(`🧩 단서 획득: ${choice.success.clueLabel || choice.success.clue}`);
      }
    } else {
      lines.push(choice.fail.text);
      inv.alert += out.fumble ? 2 : 1;
      lines.push(`⚠ 경계도 ${Math.min(inv.alert, rules.investigation.alertLimit)}/${rules.investigation.alertLimit}${out.fumble ? ' (대실패!)' : ''}`);
    }
    inv.used.push(choice.id);
    inv.actions += 1;
    const left = maxActions - inv.actions;
    const ambush = inv.alert >= rules.investigation.alertLimit;
    const done = left <= 0 || inv.used.length >= quest.investigation.choices.length;
    if (!ambush && !done) lines.push(`🔎 남은 조사 행동 ${left}회 · 경계도 ${inv.alert}/${rules.investigation.alertLimit}`);
    sys(run.thread_id, lines.join('\n'));
    if (ambush) { sys(run.thread_id, '🚨 경계도가 가득 찼다! 적이 먼저 움직인다.'); beginCombat(run, true); }
    else if (done) { sys(run.thread_id, '🔎 조사를 마쳤다. 전투가 시작된다.'); beginCombat(run, false); }
    else saveRun(run);
    notify(run);
    res.json({ ok: true });
  });

  r.post('/runs/:id/advance', auth, (req, res) => {
    const run = ownedRun(req, res, 'investigation'); if (!run) return;
    // 파티는 방장만, 레이드는 관리자가 자리에 없을 수 있어 참가자 누구나
    if (questsById[run.quest_id].mode !== 'raid' && run.owner_id !== req.user.id) return res.status(403).json({ error: '방장만 할 수 있어요.' });
    sys(run.thread_id, '🔎 조사를 서둘러 마치고 적에게 향한다.');
    beginCombat(run, false);
    notify(run);
    res.json({ ok: true });
  });

  r.post('/runs/:id/act', auth, (req, res) => {
    const run = ownedRun(req, res, 'combat'); if (!run) return;
    const cb = run.state.combat;
    const me = cb.players.find((p) => p.userId === req.user.id);
    if (!me || me.status !== 'active') return res.status(400).json({ error: '전투불능 상태예요.' });
    const b = req.body || {};
    const action = ['attack', 'skill', 'defend'].includes(b.action) ? b.action : null;
    if (!action) return res.status(400).json({ error: '행동을 골라주세요.' });
    const a = { action, line: lineOf(b) };
    if (action === 'skill') {
      const sk = rules.classes[me.cls].skill;
      if (me.cd > 0) return res.status(400).json({ error: `스킬이 아직 쿨타임이에요. (${me.cd}라운드 남음)` });
      if (sk.target === 'ally') {
        const tid = Number(b.targetUserId) || me.userId;
        if (!cb.players.some((p) => p.userId === tid && p.status === 'active')) return res.status(400).json({ error: '대상을 고를 수 없어요.' });
        a.targetUserId = tid;
      }
    }
    if (action === 'attack' || (action === 'skill' && rules.classes[me.cls].skill.target === 'enemy')) {
      const alive = cb.enemies.filter((e) => e.hp > 0);
      const te = alive.find((e) => e.id === b.targetEnemyId) || alive[0];
      a.targetEnemyId = te.id;
    }
    const st = run.state;
    st.pending = st.pending || {};
    st.pending[me.userId] = a;
    const activeIds = cb.players.filter((p) => p.status === 'active').map((p) => p.userId);
    const allIn = activeIds.every((id) => st.pending[id]);
    if (allIn && b.rush) {
      resolveCurrent(run);
    } else {
      if (allIn) st.readyAt = Math.min(run.deadline, Math.max(now(), run.round_started + config.minSec * 1000));
      saveRun(run);
    }
    notify(run);
    res.json({ ok: true });
  });

  r.post('/runs/:id/cheer', auth, (req, res) => {
    const run = loadRun(req.params.id);
    if (!run) return res.status(404).json({ error: '존재하지 않는 의뢰입니다.' });
    if (run.phase !== 'combat') return res.status(400).json({ error: '전투 중에만 응원할 수 있어요.' });
    const target = Number((req.body || {}).targetUserId);
    const cb = run.state.combat;
    if (target === req.user.id) return res.status(400).json({ error: '자기 자신은 응원할 수 없어요.' });
    if (cb.players.some((p) => p.userId === req.user.id && p.status === 'active')) return res.status(400).json({ error: '싸우는 중엔 응원할 수 없어요. 응원은 구경꾼과 쓰러진 동료의 몫!' });
    if (!cb.players.some((p) => p.userId === target && p.status === 'active')) return res.status(400).json({ error: '응원할 수 없는 대상이에요.' });
    const n = db.prepare('SELECT COUNT(*) AS n FROM run_cheers WHERE run_id = ? AND round = ? AND target_user = ?').get(run.id, cb.round, target).n;
    if (n >= rules.cheer.maxPerTarget) return res.status(400).json({ error: '이미 충분히 응원받고 있어요!' });
    try {
      db.prepare('INSERT INTO run_cheers (run_id, round, from_user, target_user, created_at) VALUES (?, ?, ?, ?, ?)').run(run.id, cb.round, req.user.id, target, now());
    } catch { return res.status(400).json({ error: '이번 라운드에는 이미 응원했어요.' }); }
    const from = charOf(req.user.id);
    const tp = cb.players.find((p) => p.userId === target);
    sys(run.thread_id, `📣 ${from.name} → ${tp.name} 응원! (이번 라운드 명중·위력 ${E.signed(rules.cheer.perCheer)})`);
    notify(run);
    res.json({ ok: true });
  });

  r.post('/runs/:id/abandon', auth, (req, res) => {
    const run = ownedRun(req, res, null, true); if (!run) return;
    const who = (charOf(req.user.id) || { name: '관리자' }).name;
    if (run.phase === 'recruiting') return cancelRecruit(run, res, `🏳 ${who} 이(가) 모집을 취소했다.`);
    if (run.phase !== 'investigation' && run.phase !== 'combat') return res.status(400).json({ error: '이미 끝난 의뢰예요.' });
    sys(run.thread_id, `🏳 ${who} 은(는) 의뢰를 포기하고 물러났다.`);
    run.phase = 'abandoned'; run.ended_at = now(); run.deadline = 0; run.state.readyAt = 0;
    saveRun(run);
    notify(run);
    io().emit('threads:changed');
    res.json({ ok: true });
  });

  // ---------- 밖에서 쓰는 것들 ----------
  function sweep() {
    const rows = db.prepare("SELECT id FROM runs WHERE phase = 'combat'").all();
    for (const { id } of rows) {
      try {
        const run = loadRun(id);
        const due = run.state.readyAt || run.deadline;
        if (due && now() >= due) resolveCurrent(run);
      } catch (e) { console.error('[sweep]', e); }
    }
  }
  let timer = null;
  return {
    router: r,
    start() { if (!timer) { timer = setInterval(sweep, 1000); timer.unref(); } },
    sweep,
    // 이 스레드에서 발언이 막힌 사람인가? (전투불능)
    isSilenced(userId, threadId) {
      const row = db.prepare(`SELECT rp.status FROM runs r JOIN run_players rp ON rp.run_id = r.id
        WHERE r.thread_id = ? AND rp.user_id = ?`).get(threadId, userId);
      return !!row && row.status === 'ko';
    },
    onThreadDeleted(threadId) {
      const run = db.prepare(`SELECT * FROM runs WHERE thread_id = ? AND phase IN ${BUSY}`).get(threadId);
      if (run) db.prepare("UPDATE runs SET phase = 'abandoned', ended_at = ?, deadline = 0 WHERE id = ?").run(now(), run.id);
    },
    // 출발한 의뢰에 한 번이라도 참가했나? (클래스 잠금 판단)
    hasRun(userId) {
      return !!db.prepare(`SELECT 1 FROM run_players rp JOIN runs r ON r.id = rp.run_id
        WHERE rp.user_id = ? AND r.phase NOT IN ('recruiting','cancelled')`).get(userId);
    },
    openRaid,
  };
}

module.exports = { createRuns };
