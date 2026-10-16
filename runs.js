'use strict';
// 의뢰 진행(조사 → 전투). 상태는 전부 DB(runs.state)에 있어서 서버를 껐다 켜도 이어집니다.
// 진행 로그는 의뢰 스레드의 채팅에 시스템 메시지로 흐르고, 구경꾼은 같은 스레드에서 떠들고 응원합니다.
const express = require('express');
const E = require('./engine');

function createRuns(ctx) {
  const { town, post, db, rules, quests, auth, now, io, emitToUser, say, upsertRead, cleanText, questsChannelId, config } = ctx;
  const questsById = Object.fromEntries(quests.map((x) => [x.id, x]));
  const seedEnv = process.env.RNG_SEED;
  const rng = seedEnv !== undefined && seedEnv !== '' ? E.mulberry32(Number(seedEnv)) : E.secureRng;
  const ACTIVE = "('investigation','combat')";
  const sys = (tid, body) => say(tid, 'sys', body);
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
  const playersOf = (runId) => db.prepare('SELECT user_id, status FROM run_players WHERE run_id = ?').all(runId);

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
    st.combat = E.makeCombatState({ quest, players, mods: st.mods });
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
    if (phase === 'won') {
      sys(run.thread_id, `🏆 ${quest.combat.victoryText}`);
      for (const p of playersOf(run.id)) reward(run, quest, p.user_id);
      const names = playersOf(run.id).map((p) => charOf(p.user_id).name).join(', ');
      post(`🏆 ${names} 이(가) 「${quest.title}」 의뢰를 완료했다! #의뢰`);
    } else if (phase === 'lost') {
      post(`💀 ${playersOf(run.id).map((p) => charOf(p.user_id).name).join(', ')} 이(가) 「${quest.title}」 의뢰 중 쓰러졌다… #의뢰`);
      sys(run.thread_id, `☠ ${quest.combat.defeatText}\n의뢰에 실패했습니다. 경험치는 없지만, 다시 도전할 수 있어요. (조사 단서는 남습니다)`);
    }
    saveRun(run);
  }

  function reward(run, quest, userId) {
    const c = charOf(userId);
    const prior = db.prepare('SELECT count FROM quest_clears WHERE user_id = ? AND quest_id = ?').get(userId, quest.id);
    const xp = prior ? Math.round(quest.reward.xp * rules.repeatXpRatio) : quest.reward.xp;
    db.prepare(`INSERT INTO quest_clears (user_id, quest_id, count, first_at) VALUES (?, ?, 1, ?)
                ON CONFLICT(user_id, quest_id) DO UPDATE SET count = count + 1`).run(userId, quest.id, now());
    const a = E.applyXp(rules, c, xp);
    db.prepare('UPDATE characters SET xp = ?, level = ?, stat_points = stat_points + ? WHERE user_id = ?')
      .run(a.xp, a.level, a.statPointsGained, userId);
    let msg = `✨ ${c.name} 경험치 +${xp}${prior ? ' (반복 의뢰라 보상이 줄었어요)' : ''}`;
    if (a.levelsGained > 0) msg += `\n🎉 레벨 ${a.level} 달성! 최대 HP 증가, 스탯 포인트 +${a.statPointsGained} (프로필에서 분배)`;
    const rw = quest.reward || {};
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
    const v = {
      id: run.id, threadId: run.thread_id, questId: quest.id, title: quest.title, phase: run.phase,
      ownerId: run.owner_id, isOwner: run.owner_id === viewerId, isPlayer: !!mine, myStatus: mine ? mine.status : null,
      active: run.phase === 'investigation' || run.phase === 'combat',
    };
    if (run.phase === 'investigation') {
      const stats = E.sheet(rules, charOf(viewerId) || {}).stats;
      v.investigation = {
        actionsLeft: rules.investigation.maxActions - st.inv.actions, maxActions: rules.investigation.maxActions,
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
    const active = db.prepare(`SELECT r.id, r.thread_id, r.quest_id FROM runs r JOIN threads t ON t.id = r.thread_id
      WHERE r.owner_id = ? AND r.phase IN ${ACTIVE} AND t.deleted = 0`).get(req.user.id);
    res.json({
      quests: quests.map((x) => ({
        id: x.id, title: x.title, summary: x.summary, mode: x.mode, recommendedLevel: x.recommendedLevel,
        rewardXp: x.reward.xp, rewardGold: x.reward.gold || 0, clears: clears[x.id] || 0,
      })),
      active: active ? { runId: active.id, threadId: active.thread_id, questId: active.quest_id } : null,
    });
  });

  r.post('/quests/:id/start', auth, (req, res) => {
    const quest = questsById[req.params.id];
    if (!quest) return res.status(404).json({ error: '존재하지 않는 의뢰입니다.' });
    const c = charOf(req.user.id);
    if (!c || !rules.classes[c.class]) return res.status(400).json({ error: '프로필에서 클래스를 먼저 골라주세요.' });
    const active = db.prepare(`SELECT r.id, r.thread_id FROM runs r JOIN threads t ON t.id = r.thread_id
      WHERE r.owner_id = ? AND r.phase IN ${ACTIVE} AND t.deleted = 0`).get(req.user.id);
    if (active) return res.status(409).json({ error: '이미 진행 중인 의뢰가 있어요.', runId: active.id, threadId: active.thread_id });
    const t = now();
    const out = db.transaction(() => {
      const title = `📜 ${quest.title} — ${c.name}`.slice(0, 60);
      const th = Number(db.prepare("INSERT INTO threads (kind, title, created_by, created_at) VALUES ('thread', ?, ?, ?)").run(title, req.user.id, t).lastInsertRowid);
      const state = { inv: { used: [], actions: 0, alert: 0 }, mods: { enemyAc: 0, attackBonus: 0 }, pending: {}, readyAt: 0, combat: null };
      const phase = quest.investigation ? 'investigation' : 'combat';
      const runId = Number(db.prepare('INSERT INTO runs (quest_id, thread_id, owner_id, phase, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(quest.id, th, req.user.id, phase, JSON.stringify(state), t).lastInsertRowid);
      db.prepare('INSERT INTO run_players (run_id, user_id) VALUES (?, ?)').run(runId, req.user.id);
      upsertRead.run({ tid: th, uid: req.user.id, last: 0, part: 1, at: t });
      return { runId, threadId: th };
    })();
    const run = loadRun(out.runId);
    sys(run.thread_id, quest.intro + (quest.investigation ? '\n\n' + quest.investigation.intro : ''));
    if (!quest.investigation) beginCombat(run, false);
    notify(run);
    io().emit('threads:changed');
    res.json({ ok: true, ...out });
  });

  // 진행 중인 의뢰 + 최근 끝난 의뢰 (구경하러 들어갈 수 있게)
  r.get('/runs', auth, (req, res) => {
    const rows = db.prepare(`SELECT r.id, r.thread_id, r.quest_id, r.phase, r.created_at, r.state, c.name AS owner
      FROM runs r JOIN threads t ON t.id = r.thread_id AND t.deleted = 0 JOIN characters c ON c.user_id = r.owner_id
      ORDER BY (r.phase IN ${ACTIVE}) DESC, r.id DESC LIMIT 12`).all();
    res.json({ runs: rows.map((x) => {
      const st = JSON.parse(x.state || '{}');
      return { id: x.id, threadId: x.thread_id, title: questsById[x.quest_id] ? questsById[x.quest_id].title : x.quest_id, phase: x.phase,
        owner: x.owner, createdAt: x.created_at, round: st.combat ? st.combat.round : 0 };
    }) });
  });

  r.get('/runs/:id', auth, (req, res) => {
    const run = loadRun(req.params.id);
    if (!run) return res.status(404).json({ error: '존재하지 않는 의뢰입니다.' });
    res.json({ run: view(run, req.user.id) });
  });

  function ownedRun(req, res, phase) {
    const run = loadRun(req.params.id);
    if (!run) { res.status(404).json({ error: '존재하지 않는 의뢰입니다.' }); return null; }
    if (run.owner_id !== req.user.id) { res.status(403).json({ error: '이 의뢰의 참가자만 할 수 있어요.' }); return null; }
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
    if (inv.actions >= rules.investigation.maxActions) return res.status(400).json({ error: '조사 행동을 모두 썼어요.' });
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
      if (choice.success.clue) {
        db.prepare('INSERT OR IGNORE INTO user_clues (user_id, clue, quest_id, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, choice.success.clue, quest.id, now());
        lines.push(`🧩 단서 획득: ${choice.success.clueLabel || choice.success.clue}`);
      }
    } else {
      lines.push(choice.fail.text);
      inv.alert += out.fumble ? 2 : 1;
      lines.push(`⚠ 경계도 ${Math.min(inv.alert, rules.investigation.alertLimit)}/${rules.investigation.alertLimit}${out.fumble ? ' (대실패!)' : ''}`);
    }
    inv.used.push(choice.id);
    inv.actions += 1;
    const left = rules.investigation.maxActions - inv.actions;
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
    const run = ownedRun(req, res, null); if (!run) return;
    if (run.phase !== 'investigation' && run.phase !== 'combat') return res.status(400).json({ error: '이미 끝난 의뢰예요.' });
    sys(run.thread_id, `🏳 ${charOf(req.user.id).name} 은(는) 의뢰를 포기하고 물러났다.`);
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
      const run = db.prepare(`SELECT * FROM runs WHERE thread_id = ? AND phase IN ${ACTIVE}`).get(threadId);
      if (run) db.prepare("UPDATE runs SET phase = 'abandoned', ended_at = ?, deadline = 0 WHERE id = ?").run(now(), run.id);
    },
    hasRun(userId) { return !!db.prepare('SELECT 1 FROM runs WHERE owner_id = ?').get(userId); },
  };
}

module.exports = { createRuns };
