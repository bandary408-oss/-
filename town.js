'use strict';
// 마을 장터: 채집(파밍) · 제작 · 도박항아리 · 판매 · 장비 · 소모품 · 선물. 모든 변경은 트랜잭션 안에서 처리합니다.
const express = require('express');
const E = require('./engine');
const X = require('./economy');

function createTown(ctx) {
  const { db, eco, rules, auth, now, rng, say, emitToUser, cleanText, townChannelId } = ctx;
  const S = eco.settings;
  // 업적 기록·운세 효과 (fun.js). 테스트 등에서 없으면 아무 일도 안 함
  const fun = () => (ctx.fun && ctx.fun()) || { track() {}, trackMax() {}, setCounter() {}, getCounter: () => 0, buffOf: () => ({ craftBonus: 0, farmDouble: 0 }) };
  const itemName = (id) => (eco.items[id] ? eco.items[id].name : id);
  const rarityName = (id) => eco.rarities[eco.items[id].rarity];

  // ---------- 저장소 ----------
  const charOf = (uid) => db.prepare('SELECT * FROM characters WHERE user_id = ?').get(uid);
  function addItem(uid, id, qty) {
    db.prepare('INSERT INTO inventory (user_id, item_id, qty) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + excluded.qty').run(uid, id, qty);
  }
  function removeItem(uid, id, qty) {
    const row = db.prepare('SELECT qty FROM inventory WHERE user_id = ? AND item_id = ?').get(uid, id);
    if (!row || row.qty < qty) return false;
    if (row.qty === qty) db.prepare('DELETE FROM inventory WHERE user_id = ? AND item_id = ?').run(uid, id);
    else db.prepare('UPDATE inventory SET qty = qty - ? WHERE user_id = ? AND item_id = ?').run(qty, uid, id);
    return true;
  }
  const addGold = (uid, n) => db.prepare('UPDATE characters SET gold = gold + ? WHERE user_id = ?').run(n, uid);
  const haveQty = (uid, id) => (db.prepare('SELECT qty FROM inventory WHERE user_id = ? AND item_id = ?').get(uid, id) || { qty: 0 }).qty;
  const equippedIds = (uid) => db.prepare('SELECT item_id FROM equipment WHERE user_id = ?').all(uid).map((r) => r.item_id);
  const gearOf = (uid) => X.gearBonus(eco, equippedIds(uid));

  function invView(uid) {
    const c = charOf(uid);
    const stam = X.staminaNow(eco, c, now());
    const eq = {};
    db.prepare('SELECT slot, item_id FROM equipment WHERE user_id = ?').all(uid).forEach((r) => { eq[r.slot] = r.item_id; });
    return {
      gold: c.gold,
      stamina: { cur: stam.cur, max: stam.max, nextInSec: stam.nextInSec },
      items: db.prepare('SELECT item_id, qty FROM inventory WHERE user_id = ? ORDER BY item_id').all(uid).map((r) => ({ id: r.item_id, qty: r.qty })),
      equipment: eq, bonus: X.gearBonus(eco, Object.values(eq)),
    };
  }

  // 의뢰 보상 지급 (runs.js 에서 사용)
  function grant(uid, { gold = 0, items = [] }) {
    if (gold) addGold(uid, gold);
    for (const it of items) addItem(uid, it.id, it.qty);
  }

  // 공식 소식은 타임라인에 시스템 글로 올라감 (#장터 태그)
  function announce(text) { ctx.announce(`${text} #장터`); }
  const worthAnnouncing = (id) => X.rarityAtLeast(eco.items[id].rarity, S.announceRarity);

  // ---------- 라우터 ----------
  const r = express.Router();
  // 경제 행동 도배 방지: 사람당 1분에 ECON_RATE_MAX(기본 40)회
  const RATE_MAX = Number(process.env.ECON_RATE_MAX || 40);
  const hits = new Map();
  function limit(req, res, next) {
    const t = now();
    const arr = (hits.get(req.user.id) || []).filter((x) => t - x < 60000);
    if (arr.length >= RATE_MAX) return res.status(429).json({ error: '너무 빠르게 하고 있어요. 잠시 후 다시 해주세요.' });
    arr.push(t); hits.set(req.user.id, arr);
    next();
  }
  const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
  const posInt = (v, max = 100000) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);

  r.get('/inventory', auth, (req, res) => { settleJars(req.user.id); res.json({ inv: invView(req.user.id) }); });

  r.post('/farm', auth, limit, (req, res) => {
    const spot = eco.spots.find((s) => s.id === (req.body || {}).spotId);
    if (!spot) return fail(res, '없는 장소예요.');
    const c = charOf(req.user.id);
    if (c.level < spot.minLevel) return fail(res, `레벨 ${spot.minLevel} 이상부터 갈 수 있어요.`);
    let result;
    const err = db.transaction(() => {
      const st = X.staminaNow(eco, c, now());
      if (st.cur < spot.cost) return `체력이 부족해요. (다음 회복까지 약 ${Math.ceil(st.nextInSec / 60)}분)`;
      db.prepare('UPDATE characters SET stamina = ?, stamina_at = ? WHERE user_id = ?').run(st.cur - spot.cost, st.since, req.user.id);
      result = X.rollSpot(rng, spot);
      // 오늘의 운세 효과: farmDouble% 확률로 수량 2배
      const buff = fun().buffOf(req.user.id);
      if (!result.nothing && buff.farmDouble && rng() * 100 < buff.farmDouble) { result.qty *= 2; result.lucky = true; }
      if (!result.nothing) addItem(req.user.id, result.item, result.qty);
      return null;
    })();
    if (err) return fail(res, err);
    if (!result.nothing && worthAnnouncing(result.item)) announce(`✨ ${c.name}이(가) ${spot.name}에서 ${rarityName(result.item)} ${itemName(result.item)}${result.qty > 1 ? ` ×${result.qty}` : ''}을(를) 발견했다!`);
    const F = fun();
    F.track(req.user.id, 'farm'); F.track(req.user.id, 'farm_' + spot.id);
    if (result.nothing) F.track(req.user.id, 'farm_nothing');
    else if (X.rarityAtLeast(eco.items[result.item].rarity, 'rare')) F.track(req.user.id, 'farm_rare');
    res.json({ ok: true, result, inv: invView(req.user.id) });
  });

  r.post('/craft', auth, limit, (req, res) => {
    const rc = eco.recipes.find((x) => x.id === (req.body || {}).recipeId);
    if (!rc) return fail(res, '없는 제작법이에요.');
    const c = charOf(req.user.id);
    let out = null, err = null;
    db.transaction(() => {
      const me = charOf(req.user.id);
      if (me.gold < rc.gold) { err = '골드가 부족해요.'; return; }
      for (const [id, n] of Object.entries(rc.inputs)) if (haveQty(req.user.id, id) < n) { err = `재료가 부족해요. (${itemName(id)})`; return; }
      const bonus = E.sheet(rules, me).stats[rc.stat] + fun().buffOf(req.user.id).craftBonus;
      const roll = X.rollCraft(rng, rc, bonus);
      addGold(req.user.id, -rc.gold);
      let qty = 0;
      if (roll.success) {
        for (const [id, n] of Object.entries(rc.inputs)) removeItem(req.user.id, id, n);
        qty = roll.crit ? 2 : 1;
        addItem(req.user.id, rc.output, qty);
      } else if (roll.fumble) {
        for (const [id, n] of Object.entries(rc.inputs)) removeItem(req.user.id, id, Math.ceil(n / 2));
      }
      out = { roll, qty, lostHalf: roll.fumble };
    })();
    if (err) return fail(res, err);
    if (out.roll.success) fun().track(req.user.id, 'craft_success');
    if (out.roll.crit) fun().track(req.user.id, 'craft_crit');
    if (out.roll.fumble) fun().track(req.user.id, 'craft_fumble');
    if (out.qty && worthAnnouncing(rc.output)) announce(`🔨 ${c.name}이(가) ${itemName(rc.output)}${out.roll.crit ? ' ×2 (대성공!)' : ''}을(를) 만들어냈다!`);
    res.json({ ok: true, result: { ...out, output: rc.output, stat: rc.stat }, inv: invView(req.user.id) });
  });

  // ----- 도박항아리: 쿨타임(jarCooldownSec) + 흔드는 시간(jarShakeSec) 뒤에 결과 공개 -----
  // 굴림은 깨는 순간 정해지지만, 흔드는 동안은 결과를 숨겼다가 시간이 되면 지급해요 (창을 닫아도 지급됨)
  const jarView = (row) => {
    const jar = eco.jars.find((x) => x.id === row.jar_id);
    return { id: row.id, jarId: row.jar_id, jarName: jar ? jar.name : row.jar_id, price: row.price, ...JSON.parse(row.result) };
  };
  function settleJars(uid) {
    const rows = uid
      ? db.prepare('SELECT * FROM jar_pulls WHERE settled = 0 AND reveal_at <= ? AND user_id = ?').all(now(), uid)
      : db.prepare('SELECT * FROM jar_pulls WHERE settled = 0 AND reveal_at <= ?').all(now());
    for (const row of rows) {
      const result = JSON.parse(row.result);
      const ok = db.transaction(() => {
        if (!db.prepare('UPDATE jar_pulls SET settled = 1 WHERE id = ? AND settled = 0').run(row.id).changes) return false;
        if (result.gold !== undefined) addGold(row.user_id, result.gold);
        else if (eco.items[result.item]) addItem(row.user_id, result.item, result.qty);
        return true;
      })();
      if (!ok) continue;
      const c = charOf(row.user_id);
      const v = jarView(row);
      if (result.gold !== undefined) { if (result.gold >= row.price * 3) announce(`💰 ${c.name}이(가) ${v.jarName}에서 ${result.gold}G 대박을 터뜨렸다!`); }
      else if (eco.items[result.item] && worthAnnouncing(result.item)) announce(`🏺 ${c.name}이(가) ${v.jarName}에서 ${rarityName(result.item)} ${itemName(result.item)}을(를) 깨냈다!`);
      // 업적: 횟수, 대박, 연속 손해(판매가 기준으로 가격보다 적게 건짐)
      const F = fun();
      const worth = result.gold !== undefined ? result.gold : (eco.items[result.item] ? eco.items[result.item].value * result.qty : 0);
      F.track(row.user_id, 'jar');
      if (result.gold !== undefined && result.gold >= row.price * 3) F.track(row.user_id, 'jar_jackpot');
      if (worth < row.price) { const cur = F.getCounter(row.user_id, 'jar_bust_cur') + 1; F.setCounter(row.user_id, 'jar_bust_cur', cur); F.trackMax(row.user_id, 'jar_bust_streak', cur); }
      else F.setCounter(row.user_id, 'jar_bust_cur', 0);
      emitToUser(row.user_id, 'jar:result', v);
      if (ctx.broadcast) ctx.broadcast('jar:done', { id: row.id });
    }
  }
  function jarState(uid) {
    settleJars(uid);
    const t = now();
    const shaking = db.prepare(`SELECT j.id, j.user_id, j.jar_id, j.reveal_at, c.name FROM jar_pulls j JOIN characters c ON c.user_id = j.user_id
      WHERE j.settled = 0 ORDER BY j.id`).all().map((x) => ({ id: x.id, userId: x.user_id, name: x.name,
      jarName: (eco.jars.find((j) => j.id === x.jar_id) || { name: x.jar_id }).name, revealInMs: Math.max(0, x.reveal_at - t) }));
    const last = db.prepare('SELECT * FROM jar_pulls WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
    const cd = last ? Math.max(0, Math.ceil((last.started_at + S.jarCooldownSec * 1000 - t) / 1000)) : 0;
    return { shaking, mine: last ? (last.settled ? { last: jarView(last) } : { pending: { id: last.id, jarId: last.jar_id, revealInMs: Math.max(0, last.reveal_at - t) } }) : {},
      cooldownLeftSec: cd, cooldownSec: S.jarCooldownSec, shakeSec: S.jarShakeSec };
  }
  const fmtLeft = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`);

  r.get('/jar/state', auth, (req, res) => res.json(jarState(req.user.id)));

  r.post('/jar', auth, limit, (req, res) => {
    const jar = eco.jars.find((x) => x.id === (req.body || {}).jarId);
    if (!jar) return fail(res, '없는 항아리예요.');
    const uid = req.user.id;
    settleJars(uid);
    let pull = null, err = null;
    db.transaction(() => {
      const t = now();
      const last = db.prepare('SELECT * FROM jar_pulls WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
      if (last && !last.settled) { err = '이미 항아리를 흔들고 있어요!'; return; }
      if (last && S.jarCooldownSec > 0 && t - last.started_at < S.jarCooldownSec * 1000) {
        err = `항아리는 ${fmtLeft(S.jarCooldownSec)}에 한 번만 깰 수 있어요. (${fmtLeft(Math.ceil((last.started_at + S.jarCooldownSec * 1000 - t) / 1000))} 남음)`; return;
      }
      if (charOf(uid).gold < jar.price) { err = '골드가 부족해요.'; return; }
      addGold(uid, -jar.price);
      const result = X.rollJar(rng, jar);
      const id = Number(db.prepare('INSERT INTO jar_pulls (user_id, jar_id, price, result, started_at, reveal_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uid, jar.id, jar.price, JSON.stringify(result), t, t + S.jarShakeSec * 1000).lastInsertRowid);
      pull = { id, revealInMs: S.jarShakeSec * 1000 };
    })();
    if (err) return fail(res, err);
    if (S.jarShakeSec <= 0) { // 흔들기 없음: 바로 결과
      settleJars(uid);
      const row = db.prepare('SELECT * FROM jar_pulls WHERE id = ?').get(pull.id);
      const v = jarView(row);
      return res.json({ ok: true, result: v.gold !== undefined ? { gold: v.gold } : { item: v.item, qty: v.qty }, inv: invView(uid) });
    }
    const c = charOf(uid);
    if (ctx.broadcast) ctx.broadcast('jar:shaking', { id: pull.id, userId: uid, name: c.name, jarName: jar.name, revealInMs: pull.revealInMs });
    res.json({ ok: true, pending: { id: pull.id, jarId: jar.id, revealInMs: pull.revealInMs }, inv: invView(uid) });
  });

  // 소모품 사용 (지금은 체력 회복만)
  r.post('/use', auth, limit, (req, res) => {
    const id = (req.body || {}).itemId;
    const it = eco.items[id];
    if (!it || it.type !== 'consumable') return fail(res, '사용할 수 없는 아이템이에요.');
    let gained = 0, err = null;
    db.transaction(() => {
      const st = X.staminaNow(eco, charOf(req.user.id), now());
      if (st.cur >= st.max) { err = '체력이 이미 가득해요.'; return; }
      if (!removeItem(req.user.id, id, 1)) { err = '가지고 있지 않아요.'; return; }
      const to = Math.min(st.max, st.cur + it.use.stamina);
      gained = to - st.cur;
      db.prepare('UPDATE characters SET stamina = ?, stamina_at = ? WHERE user_id = ?').run(to, st.since, req.user.id);
    })();
    if (err) return fail(res, err);
    fun().track(req.user.id, 'use_item');
    res.json({ ok: true, used: { id, stamina: gained }, inv: invView(req.user.id) });
  });

  r.post('/sell', auth, limit, (req, res) => {
    const b = req.body || {};
    const it = eco.items[b.itemId];
    if (!it) return fail(res, '없는 아이템이에요.');
    let qty, total = 0, err = null;
    db.transaction(() => {
      const have = haveQty(req.user.id, b.itemId);
      qty = b.all ? have : posInt(b.qty);
      if (!qty) { err = have ? '수량을 확인해주세요.' : '가진 수량이 없어요.'; return; }
      if (!removeItem(req.user.id, b.itemId, qty)) { err = '가진 수량이 부족해요.'; return; }
      total = it.value * qty;
      addGold(req.user.id, total);
    })();
    if (err) return fail(res, err);
    fun().track(req.user.id, 'sell_gold', total);
    res.json({ ok: true, sold: { id: b.itemId, qty, gold: total }, inv: invView(req.user.id) });
  });
  // 잡템(junk) 한 번에 팔기
  r.post('/sell-junk', auth, limit, (req, res) => {
    let total = 0, count = 0;
    db.transaction(() => {
      for (const row of db.prepare('SELECT item_id, qty FROM inventory WHERE user_id = ?').all(req.user.id)) {
        const it = eco.items[row.item_id];
        if (it && it.type === 'junk') { removeItem(req.user.id, row.item_id, row.qty); total += it.value * row.qty; count += row.qty; }
      }
      if (total) addGold(req.user.id, total);
    })();
    fun().track(req.user.id, 'sell_gold', total);
    res.json({ ok: true, sold: { count, gold: total }, inv: invView(req.user.id) });
  });

  r.post('/equip', auth, limit, (req, res) => {
    const id = (req.body || {}).itemId;
    const it = eco.items[id];
    if (!it || it.type !== 'equipment') return fail(res, '장착할 수 없는 아이템이에요.');
    let err = null;
    db.transaction(() => {
      if (!removeItem(req.user.id, id, 1)) { err = '가지고 있지 않아요.'; return; }
      const cur = db.prepare('SELECT item_id FROM equipment WHERE user_id = ? AND slot = ?').get(req.user.id, it.slot);
      if (cur) addItem(req.user.id, cur.item_id, 1);
      db.prepare('INSERT INTO equipment (user_id, slot, item_id) VALUES (?, ?, ?) ON CONFLICT(user_id, slot) DO UPDATE SET item_id = excluded.item_id').run(req.user.id, it.slot, id);
    })();
    if (err) return fail(res, err);
    res.json({ ok: true, inv: invView(req.user.id) });
  });
  r.post('/unequip', auth, limit, (req, res) => {
    const slot = (req.body || {}).slot;
    let err = null;
    db.transaction(() => {
      const cur = db.prepare('SELECT item_id FROM equipment WHERE user_id = ? AND slot = ?').get(req.user.id, slot);
      if (!cur) { err = '장착한 장비가 없어요.'; return; }
      db.prepare('DELETE FROM equipment WHERE user_id = ? AND slot = ?').run(req.user.id, slot);
      addItem(req.user.id, cur.item_id, 1);
    })();
    if (err) return fail(res, err);
    res.json({ ok: true, inv: invView(req.user.id) });
  });

  // 선물: 장비·재료·골드 (다른 사람의 캐릭터 누구에게나). 장착 중인 장비는 먼저 해제해야 함
  r.post('/gift', auth, limit, (req, res) => {
    const b = req.body || {};
    const toId = Number(b.toUserId);
    const to = Number.isInteger(toId) ? db.prepare('SELECT u.id, u.banned, u.is_system, c.name FROM users u JOIN characters c ON c.user_id = u.id WHERE u.id = ?').get(toId) : null;
    if (!to || to.banned || to.is_system) return fail(res, '받는 사람을 찾을 수 없어요.');
    if (to.id === req.user.id) return fail(res, '자기 자신에게는 선물할 수 없어요.');
    const hasItem = b.itemId !== undefined && b.itemId !== null && b.itemId !== '';
    const hasGold = b.gold !== undefined && b.gold !== null && b.gold !== '' && Number(b.gold) !== 0;
    if (!hasItem && !hasGold) return fail(res, '보낼 아이템이나 골드를 골라주세요.');
    let qty = 0, gold = 0;
    if (hasItem) {
      if (!eco.items[b.itemId]) return fail(res, '없는 아이템이에요.');
      qty = posInt(b.qty === undefined ? 1 : b.qty, 999);
      if (!qty) return fail(res, '수량은 1 이상의 정수여야 해요.');
    }
    if (hasGold) {
      gold = posInt(b.gold, S.giftMaxGold);
      if (!gold) return fail(res, `골드는 1~${S.giftMaxGold} 사이의 정수여야 해요.`);
    }
    const sent = db.prepare('SELECT COUNT(*) AS n FROM gifts WHERE from_user = ? AND created_at > ?').get(req.user.id, now() - 3600000).n;
    if (sent >= 20) return fail(res, '선물은 한 시간에 20번까지 보낼 수 있어요.', 429);
    const message = cleanText(b.message, 100);
    const from = charOf(req.user.id);
    let err = null;
    db.transaction(() => {
      if (hasItem && !removeItem(req.user.id, b.itemId, qty)) { err = '보낼 아이템이 부족해요. (장착 중인 장비는 먼저 해제하세요)'; return; }
      if (gold) {
        if (charOf(req.user.id).gold < gold) { err = '골드가 부족해요.'; return; }
        addGold(req.user.id, -gold); addGold(to.id, gold);
      }
      if (hasItem) addItem(to.id, b.itemId, qty);
      db.prepare('INSERT INTO gifts (from_user, to_user, item_id, qty, gold, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.user.id, to.id, hasItem ? b.itemId : null, qty, gold, message, now());
    })();
    if (err) return fail(res, err);
    const what = [hasItem ? `${itemName(b.itemId)} ×${qty}` : '', gold ? `${gold}G` : ''].filter(Boolean).join(' + ');
    announce(`🎁 ${from.name} → ${to.name}: ${what}${message ? ` — “${message}”` : ''}`);
    emitToUser(to.id, 'gift:received', { from: from.name, what, message });
    ctx.notify(to.id, 'gift', { actorId: req.user.id, text: `${what}${message ? ` — “${message}”` : ''}` });
    fun().track(req.user.id, 'gift_sent');
    res.json({ ok: true, inv: invView(req.user.id) });
  });

  r.get('/gifts', auth, (req, res) => {
    const rows = db.prepare(`
      SELECT g.*, cf.name AS from_name, ct.name AS to_name FROM gifts g
      JOIN characters cf ON cf.user_id = g.from_user JOIN characters ct ON ct.user_id = g.to_user
      WHERE g.from_user = ? OR g.to_user = ? ORDER BY g.id DESC LIMIT 20`).all(req.user.id, req.user.id);
    res.json({ gifts: rows.map((g) => ({
      id: g.id, mine: g.from_user === req.user.id ? 'sent' : 'received', from: g.from_name, to: g.to_name,
      what: [g.item_id ? `${itemName(g.item_id)} ×${g.qty}` : '', g.gold ? `${g.gold}G` : ''].filter(Boolean).join(' + '),
      message: g.message, createdAt: g.created_at })) });
  });

  // 화면이 필요로 하는 정의 (이름, 설명, 제작법, 항아리 보상 목록)
  function defs() {
    return {
      settings: { staminaMax: S.staminaMax, staminaRegenMin: S.staminaRegenMin, giftMaxGold: S.giftMaxGold, jarCooldownSec: S.jarCooldownSec, jarShakeSec: S.jarShakeSec },
      slots: eco.slots, rarities: eco.rarities, items: eco.items,
      spots: eco.spots.map((s) => ({ id: s.id, name: s.name, desc: s.desc, minLevel: s.minLevel, cost: s.cost,
        drops: s.drops.map((d) => d.item) })),
      recipes: eco.recipes,
      jars: eco.jars.map((j) => ({ id: j.id, name: j.name, desc: j.desc, price: j.price,
        prizes: [...new Set(j.prizes.filter((p) => p.item).map((p) => p.item))], hasGold: j.prizes.some((p) => p.gold !== undefined) })),
    };
  }

  // 흔들기가 끝난 항아리를 1초마다 정산 (서버 시작 때 server.js 가 호출)
  let timer = null;
  function start() { if (!timer) { timer = setInterval(() => { try { settleJars(); } catch (e) { console.error('jar settle', e.message); } }, 1000); timer.unref(); } }

  return { router: r, start, itemName, grant, gearOf, invView, defs, addItem, addGold, equippedIds };
}

module.exports = { createTown };
