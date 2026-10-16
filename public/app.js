'use strict';
(function () {
  // ---------- 유틸 ----------
  const $ = (sel) => document.querySelector(sel);
  const BASE_TITLE = '블랙리스트 용병단';

  // 안전한 DOM 생성: 유저 입력은 항상 textContent 로만 들어갑니다 (XSS 방지)
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2800);
  }

  async function api(path, { method = 'GET', body, form } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (form) opts.body = form;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch { /* 빈 응답 */ }
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/register')) {
      showAuth();
      throw new Error(data.error || '로그인이 필요합니다.');
    }
    if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
    return data;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDateTime(ts) {
    return new Date(ts).toLocaleString('ko-KR');
  }
  function relTime(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    return `${Math.floor(s / 86400)}일 전`;
  }

  function avatar(src, name, cls = '') {
    if (src) return h('img', { class: 'avatar ' + cls, src, alt: name, loading: 'lazy' });
    return h('div', { class: 'avatar ph ' + cls, 'aria-label': name }, (name || '?').slice(0, 1));
  }

  // 브라우저 저장소는 막혀 있을 수 있으니 항상 try/catch
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  };


  // ---------- 상태 ----------
  const state = {
    me: null, character: null, classes: [], limits: {}, maxImageMb: 2,
    roster: [], onlineIds: new Set(), socket: null, firstConnect: true,
    view: 'home', tab: 'home', unread: 0,
    feed: { posts: [], hasMore: false, tag: '', pending: 0 }, detail: null, replyTarget: null,
    roomId: null, oldestId: null, lastMsgId: 0, viewing: null,
    game: null, run: null, runCollapsed: false, inv: null, townTab: 'farm', townResult: '', gift: null, runUi: { ally: '', enemy: '' }, skew: 0, lastRunFetch: 0,
  };

  // ---------- 화면 전환 ----------
  function showAuth() {
    if (state.socket) { state.socket.disconnect(); state.socket = null; }
    $('#game').hidden = true;
    $('#auth').hidden = false;
    document.title = BASE_TITLE;
  }

  // ---------- 로그인 / 가입 ----------
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('#loginForm').hidden = btn.dataset.form !== 'login';
    $('#registerForm').hidden = btn.dataset.form !== 'register';
    $('#authError').textContent = '';
  }));

  async function submitAuth(e, url) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    $('#authError').textContent = '';
    try {
      await api(url, { method: 'POST', body: data });
      e.target.reset();
      await init();
    } catch (err) {
      $('#authError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  $('#loginForm').addEventListener('submit', (e) => submitAuth(e, '/api/login'));
  $('#registerForm').addEventListener('submit', (e) => submitAuth(e, '/api/register'));

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* 이미 로그아웃 */ }
    showAuth();
  });

  // ---------- 화면(뷰) 전환 ----------
  const VIEWS = ['home', 'quests', 'room', 'town', 'notif'];
  const TAB_OF = { home: 'home', quests: 'quests', room: 'quests', town: 'town', notif: 'notif' };

  function setView(v) {
    if (state.view === 'room' && v !== 'room') leaveRoom();
    state.view = v;
    VIEWS.forEach((x) => { $('#view' + x[0].toUpperCase() + x.slice(1)).hidden = x !== v; });
    document.querySelectorAll('.side-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === TAB_OF[v]));
    state.tab = TAB_OF[v];
    document.body.dataset.tab = state.tab;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    if (v === 'quests') { renderQuestBoard(); loadRunList(); }
    else if (v === 'town') { loadInv(); }
    else if (v === 'notif') loadNotifs();
    else if (v === 'home') { refreshTrends(); if (state.feed.pending && !state.detail) loadFeed(true); }
  }

  // 모바일: 프로필·단원 탭은 화면 보기만 바꾸고 메인 뷰는 그대로 둠
  function setTab(tab) {
    if (VIEWS.includes(tab)) { setView(tab); return; }
    state.tab = tab;
    document.body.dataset.tab = tab;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  }
  document.querySelectorAll('.tabbar button').forEach((btn) => btn.addEventListener('click', () => {
    const t = btn.dataset.tab;
    if (t === 'home' && state.view === 'home' && state.tab === 'home') { closeDetail(); $('#homeScroll').scrollTop = 0; }
    setTab(t);
  }));
  document.querySelectorAll('.side-nav button').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.view === 'home' && state.view === 'home') closeDetail();
    setView(btn.dataset.view);
  }));
  $('#peopleBtn').addEventListener('click', () => setTab('people'));

  // ---------- 초기화 ----------
  async function init() {
    let data;
    try { data = await api('/api/me'); } catch { return; } // 401 이면 showAuth 가 호출됨
    state.me = data.user;
    state.character = data.character;
    state.classes = data.classes;
    state.limits = data.limits;
    state.maxImageMb = data.maxImageMb;
    state.game = data.game;
    state.unread = data.unreadNotifications || 0;
    state.feed = { posts: [], hasMore: false, tag: '', pending: 0 };
    state.detail = null;
    state.roomId = null;
    state.run = null;

    $('#auth').hidden = true;
    $('#game').hidden = false;
    $('#adminLink').hidden = !state.me.isAdmin;
    $('#messageList').textContent = '';
    updateBadges();
    await Promise.all([loadRoster(), loadInv()]);
    setView('home');
    closeDetail();
    await loadFeed(true);
    showMyProfile();
    connectSocket();
  }

  function updateBadges() {
    const n = state.unread;
    document.querySelectorAll('.notif-badge').forEach((b) => { b.hidden = n === 0; b.textContent = n > 99 ? '99+' : String(n); });
    document.title = (n ? `(${n > 99 ? '99+' : n}) ` : '') + BASE_TITLE;
  }

  // ---------- 명단 ----------
  async function loadRoster() {
    try {
      const { characters } = await api('/api/characters');
      state.roster = characters;
      state.onlineIds = new Set(characters.filter((c) => c.online).map((c) => c.userId));
      renderRoster();
    } catch (e) { toast(e.message, true); }
  }

  function renderRoster() {
    const list = $('#rosterList');
    list.textContent = '';
    const sorted = [...state.roster].sort((a, b) => {
      const ao = state.onlineIds.has(a.userId), bo = state.onlineIds.has(b.userId);
      if (ao !== bo) return ao ? -1 : 1;
      return a.name.localeCompare(b.name, 'ko');
    });
    for (const c of sorted) {
      const on = state.onlineIds.has(c.userId);
      list.append(h('li', { class: on ? 'online' : 'offline' },
        h('button', { type: 'button', onclick: () => { showProfile(c.id); setTab('profile'); } },
          avatar(c.image, c.name, 'sm'),
          h('div', {},
            h('div', { class: 'r-name' }, c.name),
            h('div', { class: 'r-sub' }, [c.class, c.title].filter(Boolean).join(' · ') || ' ')),
          h('span', { style: 'margin-left:auto', class: 'dot' }))));
    }
    $('#onlineCount').textContent = `(접속 ${state.onlineIds.size} / ${state.roster.length})`;
  }

  // ---------- 타임라인 ----------
  const POST_MAX = () => (state.limits && state.limits.post) || 280;
  const nameSet = () => new Set(state.roster.map((c) => c.name));
  const charByName = (n) => state.roster.find((c) => c.name === n);
  const TRAIL = /[.,!?…~)\]」』”’"'。、]+$/;

  // 본문 → DOM (@멘션, #태그는 눌러볼 수 있게). 항상 텍스트 노드로만 넣어 XSS 방지
  function richText(text) {
    const out = [];
    const re = /(@[^\s@#]+|#[\p{L}\p{N}_]{1,30})/gu;
    const names = nameSet();
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const tok = m[0];
      if (tok[0] === '#') {
        const tag = tok.slice(1).toLowerCase();
        out.push(h('button', { type: 'button', class: 'hashtag', onclick: (e) => { e.stopPropagation(); setTag(tag); } }, tok));
      } else {
        const stripped = tok.replace(TRAIL, '');
        const name = stripped.slice(1);
        const tail = tok.slice(stripped.length);
        if (names.has(name)) {
          out.push(h('button', { type: 'button', class: 'mention', onclick: (e) => { e.stopPropagation(); const c = charByName(name); if (c) { showProfile(c.id); setTab('profile'); } } }, stripped));
          if (tail) out.push(tail);
        } else out.push(tok);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function quoteCard(q) {
    if (q.deleted) return h('div', { class: 'quote-card' }, h('div', { class: 'qc-body muted' }, '삭제된 글입니다.'));
    return h('div', { class: 'quote-card', onclick: (e) => { e.stopPropagation(); openDetail(q.id); } },
      h('div', { class: 'qc-head' }, q.user.name),
      h('div', { class: 'qc-body' }, richText(q.body)));
  }

  function renderPost(p, opts = {}) {
    const mine = p.user.id === state.me.id;
    const isRepost = p.quote && !p.body && !p.deleted;
    const head = h('div', { class: 'p-head' },
      h('button', { type: 'button', class: 'who', onclick: (e) => { e.stopPropagation(); showProfile(p.user.charId); setTab('profile'); } }, p.user.name),
      p.isSystem ? h('span', { class: 'official' }, '공식') : (p.user.class ? h('span', { class: 'p-class' }, p.user.class) : null),
      h('time', { title: fmtDateTime(p.createdAt) }, relTime(p.createdAt)));
    const main = h('div', { class: 'p-main' }, head);
    if (p.replyTo && !opts.root) main.append(h('div', { class: 'p-reply' }, `↪ @${p.replyTo} 에게 답글`));
    if (isRepost) main.append(h('div', { class: 'p-reply' }, '🔁 리포스트'));
    if (p.deleted) main.append(h('div', { class: 'p-body gone' }, '삭제된 글입니다.'));
    else if (p.body) main.append(h('div', { class: 'p-body' + (p.kind === 'act' ? ' act' : '') }, p.kind === 'act' ? [`${p.user.name} `, richText(p.body)] : richText(p.body)));
    if (p.quote && !p.deleted) main.append(quoteCard(p.quote));
    if (!opts.compact && !p.deleted) main.append(actionRow(p, opts));
    const el = h('article', {
      class: 'post' + (p.isSystem ? ' sys' : '') + (opts.focus ? ' focus' : '') + (opts.root ? ' root-big' : ''), 'data-id': p.id,
      onclick: (e) => { if (opts.noOpen) return; if (e.target.closest('button,a,textarea,input,select,form')) return; openDetail(p.id); },
    }, p.isSystem ? h('div', { class: 'avatar ph' }, '📜') : avatar(p.user.image, p.user.name, 'sm'), main);
    return el;
  }

  function actionRow(p, opts) {
    const row = h('div', { class: 'p-actions' });
    row.append(h('button', { type: 'button', class: 'pa', title: '답글', onclick: (e) => { e.stopPropagation(); startReply(p); } }, `💬 ${p.replyCount || ''}`.trim()));
    if (!p.isSystem) row.append(h('button', { type: 'button', class: 'pa', title: '리포스트 / 인용', onclick: (e) => { e.stopPropagation(); toggleQuoteForm(p, row); } }, `🔁 ${p.repostCount || ''}`.trim()));
    row.append(h('button', { type: 'button', class: 'pa like' + (p.liked ? ' on' : ''), title: '좋아요', onclick: (e) => { e.stopPropagation(); toggleLike(p); } }, `${p.liked ? '♥' : '♡'} ${p.likeCount || ''}`.trim()));
    if (!p.isSystem && p.user.id !== state.me.id) row.append(h('button', { type: 'button', class: 'pa', title: '신고', onclick: (e) => { e.stopPropagation(); reportPost(p); } }, '⚑'));
    if (p.user.id === state.me.id || state.me.isAdmin) row.append(h('button', { type: 'button', class: 'pa danger', title: '삭제', onclick: (e) => { e.stopPropagation(); deletePost(p); } }, '🗑'));
    return row;
  }

  // 같은 id의 카드를 모두 새 데이터로 교체
  function repaint(p) {
    document.querySelectorAll(`#feedList .post[data-id="${p.id}"], #detailView .post[data-id="${p.id}"]`).forEach((old) => {
      const inDetail = !!old.closest('#detailView');
      const isRoot = old.classList.contains('root-big');
      const focus = old.classList.contains('focus');
      old.replaceWith(renderPost(p, { root: inDetail && isRoot, focus, noOpen: inDetail }));
    });
  }
  function findPost(id) {
    const f = state.feed.posts.find((x) => x.id === id);
    if (f) return f;
    const d = state.detail;
    if (d) { if (d.root && d.root.id === id) return d.root; return d.replies.find((x) => x.id === id); }
    return null;
  }

  async function toggleLike(p) {
    try {
      const r = await api(`/api/posts/${p.id}/like`, { method: 'POST' });
      p.liked = r.liked; p.likeCount = r.likeCount;
      repaint(p);
    } catch (e) { toast(e.message, true); }
  }
  async function reportPost(p) {
    const reason = window.prompt('신고 사유를 적어주세요 (생략 가능)');
    if (reason === null) return;
    try { await api(`/api/posts/${p.id}/report`, { method: 'POST', body: { reason } }); toast('신고가 접수되었습니다.'); }
    catch (e) { toast(e.message, true); }
  }
  async function deletePost(p) {
    if (!window.confirm('이 글을 삭제할까요?')) return;
    try { await api('/api/posts/' + p.id, { method: 'DELETE' }); } catch (e) { toast(e.message, true); }
  }

  function toggleQuoteForm(p, row) {
    const host = row.parentElement;
    const old = host.querySelector('.quote-form');
    if (old) { old.remove(); return; }
    const ta = h('textarea', { maxlength: POST_MAX(), rows: 2, placeholder: '비워두면 그대로 리포스트, 적으면 인용해요' });
    const btn = h('button', { class: 'btn small primary', type: 'submit' }, '🔁 리포스트');
    ta.addEventListener('input', () => { btn.textContent = ta.value.trim() ? '✎ 인용하기' : '🔁 리포스트'; });
    const f = h('form', { class: 'quote-form', onclick: (e) => e.stopPropagation() }, ta,
      h('div', { class: 'row' }, btn, h('button', { class: 'btn small ghost', type: 'button', onclick: () => f.remove() }, '취소')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const r = await api('/api/posts', { method: 'POST', body: { body: ta.value, quoteId: p.id } });
        f.remove();
        toast('올렸어요.');
        if (state.view === 'home' && !state.detail) addToFeed(r.post);
        p.repostCount = (p.repostCount || 0) + 1;
        repaint(p);
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    });
    host.append(f);
    ta.focus();
  }

  // --- 피드 ---
  function addToFeed(post) {
    if (!post || state.feed.posts.some((x) => x.id === post.id) || post.parentId) return;
    if (state.feed.tag && !(post.body || '').toLowerCase().includes('#' + state.feed.tag)) return;
    state.feed.posts.unshift(post);
    const empty = $('#feedList .empty-note');
    if (empty) empty.remove();
    $('#feedList').prepend(renderPost(post));
  }

  async function loadFeed(reset) {
    const f = state.feed;
    const list = $('#feedList');
    if (reset) { f.posts = []; f.pending = 0; list.textContent = ''; $('#newPostsBtn').hidden = true; }
    const before = !reset && f.posts.length ? `&before=${f.posts[f.posts.length - 1].id}` : '';
    const q = `/api/feed?${f.tag ? 'tag=' + encodeURIComponent(f.tag) : ''}${before}`;
    try {
      const { posts, hasMore } = await api(q);
      posts.forEach((p) => { if (!f.posts.some((x) => x.id === p.id)) { f.posts.push(p); list.append(renderPost(p)); } });
      f.hasMore = hasMore;
      if (!f.posts.length) list.append(h('div', { class: 'empty-note' }, f.tag ? `#${f.tag} 글이 아직 없어요.` : '아직 글이 없어요. 첫 글을 올려보세요!'));
      $('#feedMore').hidden = !hasMore;
    } catch (e) { toast(e.message, true); }
  }
  $('#feedMore').addEventListener('click', () => loadFeed(false));

  function setTag(tag) {
    state.feed.tag = tag || '';
    $('#homeTitle').textContent = tag ? `#${tag}` : '타임라인';
    $('#tagClear').hidden = !tag;
    setView('home');
    closeDetail();
    loadFeed(true);
    $('#homeScroll').scrollTop = 0;
  }
  $('#tagClear').addEventListener('click', () => setTag(''));

  async function refreshTrends() {
    try {
      const { tags } = await api('/api/tags');
      const box = $('#trendBox');
      box.textContent = '';
      box.hidden = !tags.length;
      if (!tags.length) return;
      box.append(h('div', { class: 'section-title' }, '🔥 요즘 이야기'));
      tags.forEach((t) => box.append(h('button', { type: 'button', class: 'tg', onclick: () => setTag(t.tag) }, `#${t.tag} ${t.count}`)));
    } catch { /* 무시 */ }
  }

  // 새 글 배너
  function showPending() {
    const b = $('#newPostsBtn');
    b.hidden = state.feed.pending === 0;
    b.textContent = `새 글 ${state.feed.pending}개 보기`;
  }
  $('#newPostsBtn').addEventListener('click', () => { loadFeed(true); $('#homeScroll').scrollTop = 0; });

  // --- 글쓰기 ---
  const composeText = $('#composeText');
  function updateCompose() { $('#composeCount').textContent = `${composeText.value.length} / ${POST_MAX()}`; }
  composeText.addEventListener('input', updateCompose);
  $('#composeKind').addEventListener('change', () => {
    composeText.placeholder = $('#composeKind').value === 'act' ? '행동을 서술하세요 (예: 칼자루를 고쳐 쥔다)' : '지금 무슨 일이 일어나고 있나요? (280자, @이름 으로 부르고 #태그 를 달 수 있어요)';
  });
  composeText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composeForm').requestSubmit(); });
  $('#composeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = composeText.value.trim();
    if (!body) return;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('/api/posts', { method: 'POST', body: { body, kind: $('#composeKind').value } });
      composeText.value = '';
      updateCompose();
      addToFeed(r.post);
      refreshTrends();
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  });

  // --- 상세 / 답글 ---
  function closeDetail() {
    state.detail = null;
    state.replyTarget = null;
    $('#detailView').hidden = true;
    $('#detailView').textContent = '';
    $('#feedView').hidden = false;
    $('#homeBack').hidden = true;
    $('#homeTitle').textContent = state.feed.tag ? `#${state.feed.tag}` : '타임라인';
    $('#tagClear').hidden = !state.feed.tag;
  }
  $('#homeBack').addEventListener('click', closeDetail);

  async function openDetail(id, replyTo) {
    try {
      const d = await api('/api/posts/' + id);
      state.detail = d;
      state.replyTarget = null;
      if (state.view !== 'home') setView('home');
      setTab('home');
      $('#feedView').hidden = true;
      $('#detailView').hidden = false;
      $('#homeBack').hidden = false;
      $('#tagClear').hidden = true;
      $('#homeTitle').textContent = '글';
      renderDetail();
      const focus = $(`#detailView .post[data-id="${d.focusId}"]`);
      if (focus && d.focusId !== d.root.id) focus.scrollIntoView({ block: 'center' });
      else $('#homeScroll').scrollTop = 0;
      if (replyTo) startReply(replyTo);
    } catch (e) { toast(e.message, true); }
  }

  function renderDetail() {
    const d = state.detail;
    const view = $('#detailView');
    view.textContent = '';
    view.append(renderPost(d.root, { root: true, noOpen: true }));
    const rb = replyBox();
    view.append(rb);
    if (!d.replies.length) view.append(h('div', { class: 'empty-note' }, '아직 답글이 없어요.'));
    d.replies.forEach((p) => view.append(renderPost(p, { focus: p.id === d.focusId && p.id !== d.root.id, noOpen: true })));
  }

  function replyBox() {
    const t = state.replyTarget;
    const ta = h('textarea', { id: 'replyText', maxlength: POST_MAX(), rows: 2, placeholder: '답글을 남겨보세요' });
    if (t) ta.value = `@${t.user.name} `;
    const kind = h('select', { 'aria-label': '말투' }, h('option', { value: 'say' }, '대사'), h('option', { value: 'act' }, '지문'));
    const btn = h('button', { class: 'btn primary small', type: 'submit' }, '답글');
    const f = h('form', { class: 'reply-box', id: 'replyBox' },
      t ? h('div', { class: 'muted' }, `↪ ${t.user.name} 님에게 답글 `, h('button', { type: 'button', class: 'btn small ghost', onclick: () => { state.replyTarget = null; refreshReplyBox(); } }, '대상 해제')) : null,
      ta, h('div', { class: 'compose-bar' }, kind, h('span'), btn));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) f.requestSubmit(); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) return;
      btn.disabled = true;
      try {
        const d = state.detail;
        await api('/api/posts', { method: 'POST', body: { body, kind: kind.value, parentId: (state.replyTarget || d.root).id } });
        state.replyTarget = null;
        const fp = state.feed.posts.find((x) => x.id === d.root.id);
        if (fp) { fp.replyCount = (fp.replyCount || 0) + 1; repaint(fp); }
        await reloadDetail();
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    });
    return f;
  }
  function refreshReplyBox() {
    const old = $('#replyBox');
    if (old) { const nb = replyBox(); old.replaceWith(nb); return nb; }
    return null;
  }
  async function reloadDetail() {
    const d0 = state.detail;
    if (!d0) return;
    const sc = $('#homeScroll').scrollTop;
    const draft = $('#replyText') ? $('#replyText').value : '';
    try {
      const d = await api('/api/posts/' + d0.root.id);
      d.focusId = d0.focusId;
      state.detail = d;
      renderDetail();
      $('#homeScroll').scrollTop = sc;
      if (draft && state.replyTarget === null && $('#replyText')) $('#replyText').value = draft;
    } catch { closeDetail(); toast('글이 삭제되었어요.', true); }
  }

  // 💬 버튼: 상세가 아니면 상세로 이동, 상세면 답글 대상 지정
  function startReply(p) {
    if (!state.detail) { openDetail(p.id, p.rootId ? p : null).then(() => { const t = $('#replyText'); if (t) t.focus(); }); return; }
    state.replyTarget = p.id === state.detail.root.id ? null : p;
    const nb = refreshReplyBox();
    const ta = nb ? nb.querySelector('textarea') : null;
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  // --- 알림 ---
  const NOTIF_TEXT = { reply: '님이 답글을 남겼어요', mention: '님이 나를 언급했어요', like: '님이 ♥를 눌렀어요', repost: '님이 내 글을 리포스트했어요', gift: '님이 선물을 보냈어요' };
  const NOTIF_ICON = { reply: '💬', mention: '＠', like: '♥', repost: '🔁', gift: '🎁' };
  async function loadNotifs() {
    try {
      const { items } = await api('/api/notifications');
      const box = $('#notifList');
      box.textContent = '';
      if (!items.length) box.append(h('div', { class: 'empty-note' }, '아직 알림이 없어요.'));
      items.forEach((n) => box.append(h('div', {
        class: 'notif-item' + (n.read ? '' : ' unread'),
        onclick: () => { if (n.postId) openDetail(n.postId); },
      }, h('div', { class: 'n-ico' }, NOTIF_ICON[n.type] || '🔔'),
        h('div', {},
          h('div', {}, h('b', {}, n.actor || '누군가'), NOTIF_TEXT[n.type] || '', n.text ? ` — ${n.text}` : ''),
          n.snippet ? h('div', { class: 'n-snip' }, n.snippet) : null,
          h('time', { class: 'muted' }, relTime(n.createdAt))))));
      if (items.some((n) => !n.read)) {
        api('/api/notifications/read', { method: 'POST' }).catch(() => {});
      }
      state.unread = 0;
      updateBadges();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- 의뢰 방 (조사·전투 + 실시간 채팅) ----------
  const box = () => $('#messages');
  function nearBottom() { const b = box(); return b.scrollHeight - b.scrollTop - b.clientHeight < 120; }
  function scrollBottom(force) { if (force || nearBottom()) { const b = box(); b.scrollTop = b.scrollHeight; } }

  async function openRoom(threadId, runId) {
    state.roomId = threadId;
    state.run = null;
    state.lastMsgId = 0;
    $('#runPanel').hidden = true;
    $('#chatTitle').textContent = '의뢰 방';
    $('#chatSub').textContent = '';
    $('#messageList').textContent = '';
    setView('room');
    updateChatHeader();
    try {
      await loadHistory();
      if (runId) await loadRun(runId);
    } catch (e) { toast(e.message, true); setView('quests'); return; }
    sendRead();
  }
  function leaveRoom() {
    state.roomId = null;
    state.run = null;
    $('#runPanel').hidden = true;
  }
  $('#roomBack').addEventListener('click', () => setView('quests'));

  let readTimer;
  function sendRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      if (!state.roomId || !state.lastMsgId) return;
      api(`/api/threads/${state.roomId}/read`, { method: 'POST', body: { lastId: state.lastMsgId } }).catch(() => {});
    }, 400);
  }

  function updateChatHeader() {
    if (!state.roomId) return;
    const r = state.run;
    if (r) {
      $('#chatTitle').textContent = r.title;
      $('#chatSub').textContent = `${PHASE_LABEL[r.phase] || ''}`;
    }
    const ko = !state.me.isAdmin && r && r.myStatus === 'ko';
    const input = $('#chatInput');
    input.disabled = ko;
    input.placeholder = ko ? '💀 전투불능 — 이 의뢰에서는 발언할 수 없어요 (구경·응원은 가능)' : ($('#kindSelect').value === 'act' ? '행동을 서술하세요 (예: 칼자루를 고쳐 쥔다)' : '대사를 입력하세요');
    $('#composer button[type=submit]').disabled = ko;
    $('#kindSelect').disabled = ko;
  }

  function renderMsg(m) {
    const mine = state.me && m.user.id === state.me.id;
    const nameBtn = h('button', {
      type: 'button', class: 'who',
      onclick: () => { showProfile(m.user.charId); setTab('profile'); },
    }, m.user.name);

    const actions = h('span', { class: 'actions' });
    if (!mine) actions.append(h('button', { type: 'button', class: 'act-btn', title: '신고', onclick: () => reportMsg(m.id) }, '⚑ 신고'));
    if (state.me.isAdmin) actions.append(h('button', { type: 'button', class: 'act-btn', title: '삭제', onclick: () => deleteMsg(m.id) }, '✕ 삭제'));

    if (m.kind === 'sys' || m.kind === 'roll') {
      return h('div', { class: 'msg ' + m.kind, 'data-id': m.id },
        h('div', { class: 'msg-main' },
          h('span', { class: 'tag-sys' }, m.kind === 'roll' ? '🎲 판정' : '📜 진행'),
          h('div', { class: 'msg-body' }, m.body)),
        h('span', { class: 'actions' }, state.me.isAdmin ? h('button', { type: 'button', class: 'act-btn', onclick: () => deleteMsg(m.id) }, '✕ 삭제') : null));
    }
    if (m.kind === 'act') {
      return h('div', { class: 'msg act', 'data-id': m.id },
        h('div', { class: 'msg-main' },
          h('div', { class: 'msg-body' }, nameBtn, ' ', m.body)),
        actions);
    }
    return h('div', { class: 'msg say', 'data-id': m.id },
      avatar(m.user.image, m.user.name, 'sm'),
      h('div', { class: 'msg-main' },
        h('div', { class: 'msg-head' }, nameBtn, h('time', { title: fmtDateTime(m.createdAt) }, fmtTime(m.createdAt)), actions),
        h('div', { class: 'msg-body' }, m.body)));
  }

  async function loadHistory() {
    const id = state.roomId;
    const { messages } = await api(`/api/threads/${id}/messages`);
    if (id !== state.roomId) return;
    const list = $('#messageList');
    list.textContent = '';
    if (!messages.length) list.append(h('div', { class: 'msg system', 'data-empty': '1' }, '아직 아무도 말하지 않았어요.'));
    messages.forEach((m) => list.append(renderMsg(m)));
    state.oldestId = messages.length ? messages[0].id : null;
    state.lastMsgId = messages.length ? messages[messages.length - 1].id : 0;
    $('#loadOlder').hidden = messages.length < 50;
    scrollBottom(true);
  }

  $('#loadOlder').addEventListener('click', async () => {
    if (!state.oldestId || !state.roomId) return;
    const b = box();
    const prevHeight = b.scrollHeight;
    const { messages } = await api(`/api/threads/${state.roomId}/messages?before=${state.oldestId}`);
    const list = $('#messageList');
    for (let i = messages.length - 1; i >= 0; i--) list.prepend(renderMsg(messages[i]));
    if (messages.length) state.oldestId = messages[0].id;
    $('#loadOlder').hidden = messages.length < 50;
    b.scrollTop = b.scrollHeight - prevHeight;
  });

  function onChatMessage(m) {
    if (m.threadId !== state.roomId) return;
    const stick = nearBottom() || (state.me && m.user.id === state.me.id);
    const empty = document.querySelector('#messageList [data-empty]');
    if (empty) empty.remove();
    $('#messageList').append(renderMsg(m));
    state.lastMsgId = m.id;
    if (stick) scrollBottom(true);
    sendRead();
  }

  async function reportMsg(id) {
    const reason = window.prompt('신고 사유를 적어주세요 (생략 가능)');
    if (reason === null) return;
    try { await api('/api/report', { method: 'POST', body: { messageId: id, reason } }); toast('신고가 접수되었습니다.'); }
    catch (e) { toast(e.message, true); }
  }
  async function deleteMsg(id) {
    if (!window.confirm('이 메시지를 삭제할까요?')) return;
    try { await api('/api/admin/messages/' + id, { method: 'DELETE' }); }
    catch (e) { toast(e.message, true); }
  }

  const kindSelect = $('#kindSelect');
  kindSelect.addEventListener('change', updateChatHeader);

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const body = input.value.trim();
    if (!body || !state.socket || !state.roomId) return;
    if (!state.socket.connected) return toast('연결이 끊겨 있어요. 잠시 후 다시 시도해주세요.', true);
    state.socket.emit('chat:send', { threadId: state.roomId, kind: kindSelect.value, body }, (res) => {
      if (res && res.error) toast(res.error, true);
      else input.value = '';
    });
  });

  // ---------- 소켓 ----------
  function setConn(on) {
    const el = $('#connState');
    el.textContent = on ? '연결됨' : '연결 끊김';
    el.className = 'conn ' + (on ? 'on' : 'off');
  }

  let detailTimer, runListTimer;
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.firstConnect = true;
    const socket = io({ transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('connect', async () => {
      setConn(true);
      if (!state.firstConnect) { // 끊긴 동안 놓친 것 복구
        if (state.view === 'home' && !state.detail) loadFeed(true);
        if (state.detail) reloadDetail();
        if (state.view === 'room' && state.roomId) {
          loadHistory().then(() => (state.run ? loadRun(state.run.id) : null)).catch(() => {});
        }
        try { const d = await api('/api/me'); state.unread = d.unreadNotifications || 0; updateBadges(); } catch { /* 무시 */ }
      }
      state.firstConnect = false;
    });
    socket.on('disconnect', () => setConn(false));
    socket.on('connect_error', (err) => {
      setConn(false);
      if (err && err.message === 'unauthorized') showAuth();
    });
    socket.on('kicked', () => { toast('접속이 종료되었습니다.', true); showAuth(); });

    // 타임라인
    socket.on('post:new', ({ id, parentId, rootId, userId }) => {
      const mine = userId === state.me.id;
      if (parentId) {
        const root = state.feed.posts.find((x) => x.id === rootId);
        if (root && !mine) { root.replyCount = (root.replyCount || 0) + 1; repaint(root); }
        if (state.detail && state.detail.root.id === rootId) {
          clearTimeout(detailTimer);
          detailTimer = setTimeout(reloadDetail, 200);
        }
        return;
      }
      if (mine || state.feed.posts.some((x) => x.id === id)) return;
      if (state.feed.tag) return; // 태그 보기 중에는 배너를 띄우지 않음
      state.feed.pending += 1;
      if (state.view === 'home' && !state.detail) showPending();
      else if (state.view === 'home') showPending();
    });
    socket.on('post:update', ({ id, likeCount }) => {
      const p = findPost(id);
      if (p && p.likeCount !== likeCount) { p.likeCount = likeCount; repaint(p); }
    });
    socket.on('post:deleted', ({ id, rootId }) => {
      const i = state.feed.posts.findIndex((x) => x.id === id);
      if (i >= 0) { state.feed.posts.splice(i, 1); document.querySelectorAll(`#feedList .post[data-id="${id}"]`).forEach((e) => e.remove()); }
      if (state.detail) {
        if (state.detail.root.id === id) { closeDetail(); toast('글이 삭제되었어요.'); }
        else if (state.detail.root.id === rootId) reloadDetail();
      }
    });
    socket.on('notify', () => {
      state.unread += 1;
      updateBadges();
      if (state.view === 'notif') loadNotifs();
    });

    // 의뢰 방
    socket.on('chat:message', onChatMessage);
    socket.on('chat:deleted', ({ id, threadId }) => {
      if (threadId === state.roomId) {
        const el = document.querySelector(`.msg[data-id="${id}"]`);
        if (el) el.remove();
      }
    });
    socket.on('threads:changed', () => {
      if (state.view !== 'quests') return;
      clearTimeout(runListTimer);
      runListTimer = setTimeout(loadRunList, 400);
    });
    socket.on('run:update', ({ runId, threadId }) => {
      if (threadId === state.roomId) loadRun(runId);
      else if (state.view === 'quests') { clearTimeout(runListTimer); runListTimer = setTimeout(loadRunList, 400); }
    });
    socket.on('gift:received', ({ from, what, message }) => {
      toast(`🎁 ${from} 님이 선물을 보냈어요: ${what}${message ? ` — “${message}”` : ''}`);
      loadInv();
    });
    socket.on('run:ko', ({ threadId }) => {
      toast('💀 전투불능! 잠시 뒤 의뢰 목록으로 돌아갑니다.', true);
      setTimeout(() => { if (state.roomId === threadId && state.view === 'room') setView('quests'); }, 2500);
    });
    socket.on('presence', (list) => {
      state.onlineIds = new Set(list.map((p) => p.userId));
      if (list.some((p) => !state.roster.find((c) => c.userId === p.userId))) loadRoster();
      else renderRoster();
    });
  }
  setInterval(() => { // "N분 전" 갱신
    if ($('#game').hidden || state.view !== 'home') return;
    document.querySelectorAll('#feedList .post time, #detailView .post time').forEach((t) => {
      const p = findPost(Number(t.closest('.post').dataset.id));
      if (p) t.textContent = relTime(p.createdAt);
    });
  }, 60000);


  // 프로필에 보이는 "쓴 글" 목록
  function profilePosts(charId, name) {
    const wrap = h('div', { class: 'profile-posts', style: 'padding:10px 14px 0' }, h('div', { class: 'section-title' }, `${name} 님이 쓴 글`));
    api(`/api/characters/${charId}/posts`).then(({ posts }) => {
      if (!posts.length) wrap.append(h('div', { class: 'muted' }, '아직 쓴 글이 없어요.'));
      posts.slice(0, 10).forEach((p) => wrap.append(renderPost(p, { compact: true })));
    }).catch(() => {});
    return wrap;
  }

  // ---------- 프로필 ----------
  function showProfile(charId) {
    if (state.character && charId === state.character.id) return showMyProfile();
    api('/api/characters/' + charId).then(({ character: c }) => {
      state.viewing = c.id;
      const view = $('#profileView');
      view.textContent = '';
      const section = (title, text) => h('div', {},
        h('div', { class: 'section-title' }, title),
        text ? h('div', { class: 'text' }, text) : h('div', { class: 'text empty' }, '아직 작성되지 않았어요.'));
      view.append(h('div', { class: 'profile' },
        h('div', { class: 'head' },
          avatar(c.image, c.name, 'lg'),
          h('div', {},
            h('div', { class: 'pname' }, c.name),
            c.title ? h('div', { class: 'ptitle' }, c.title) : null,
            c.class ? h('span', { class: 'badge' }, c.class) : null,
            h('div', { class: 'muted' }, c.online ? '● 접속 중' : '○ 오프라인'))),
        sheetView(c, false),
        equipmentView(c),
        section('외형', c.appearance),
        section('설정', c.bio),
        profilePosts(c.id, c.name),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: showMyProfile }, '내 프로필로 돌아가기'))));
    }).catch((e) => toast(e.message, true));
  }


  function showMyProfile() {
    state.viewing = null;
    const c = state.character;
    const L = state.limits;
    const view = $('#profileView');
    view.textContent = '';

    const name = h('input', { value: c.name, maxlength: L.name[1], required: true });
    const cls = h('select', {}, h('option', { value: '' }, '(선택 안 함)'),
      state.classes.map((k) => h('option', { value: k, selected: k === c.class }, k)));
    const title = h('input', { value: c.title, maxlength: L.title, placeholder: '예: 빚에 쫓기는 전직 기사' });
    const appearance = h('textarea', { maxlength: L.appearance, placeholder: '머리색, 체격, 눈에 띄는 특징…' }, c.appearance);
    const bio = h('textarea', { maxlength: L.bio, rows: 6, placeholder: '과거, 성격, 용병단에 오게 된 사연…' }, c.bio);
    const bioCount = h('div', { class: 'count' }, `${c.bio.length} / ${L.bio}`);
    bio.addEventListener('input', () => { bioCount.textContent = `${bio.value.length} / ${L.bio}`; });

    const imgHolder = h('div', {}, avatar(c.image, c.name, 'lg'));
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      if (f.size > state.maxImageMb * 1024 * 1024) { toast(`이미지는 ${state.maxImageMb}MB 이하여야 합니다.`, true); return; }
      const fd = new FormData();
      fd.append('image', f);
      try {
        const r = await api('/api/character/image', { method: 'POST', form: fd });
        state.character.image = r.image;
        imgHolder.replaceChildren(avatar(r.image + '?t=' + Date.now(), state.character.name, 'lg'));
        toast('이미지를 올렸어요.');
        loadRoster();
      } catch (e) { toast(e.message, true); }
      fileInput.value = '';
    });
    const removeBtn = h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
      try {
        await api('/api/character/image', { method: 'DELETE' });
        state.character.image = '';
        imgHolder.replaceChildren(avatar('', state.character.name, 'lg'));
        loadRoster();
      } catch (e) { toast(e.message, true); }
    } }, '이미지 삭제');

    const form = h('form', { class: 'profile' },
      h('div', { class: 'head' },
        imgHolder,
        h('div', { style: 'display:grid;gap:6px' },
          h('button', { class: 'btn small', type: 'button', onclick: () => fileInput.click() }, '이미지 올리기'),
          removeBtn,
          h('small', {}, `jpg·png·webp, ${state.maxImageMb}MB 이하`),
          fileInput)),
      h('label', {}, '캐릭터 이름', name),
      h('label', {}, '클래스', cls, h('small', {}, '의뢰를 한 번 시작하면 클래스는 바꿀 수 없어요.')),
      h('label', {}, '한 줄 소개', title),
      h('label', {}, '외형', appearance),
      h('label', {}, '설정', bio, bioCount),
      h('button', { class: 'btn primary', type: 'submit' }, '프로필 저장'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/character', {
          method: 'PUT',
          body: { name: name.value, class: cls.value, title: title.value, appearance: appearance.value, bio: bio.value },
        });
        state.character = r.character;
        renderSheetBox();
        toast('저장했어요.');
        loadRoster();
      } catch (err) { toast(err.message, true); }
    });

    view.append(
      h('div', { class: 'section-title', style: 'padding:12px 14px 0;color:var(--accent);font-family:var(--serif);font-weight:700' }, '내 프로필'),
      h('div', { id: 'sheetBox', style: 'padding:10px 14px 0' }),
      h('div', { id: 'invBox', style: 'padding:10px 14px 0' }),
      form,
      profilePosts(c.id, c.name));
    renderSheetBox();
    renderInvBox();
  }

  // ---------- 능력치 ----------
  const STAT_ORDER = ['str', 'dex', 'int', 'cha'];
  function sheetView(c, mine) {
    const G = state.game;
    if (!c.class || !G.classes[c.class]) {
      return h('div', { class: 'sheet' }, h('div', { class: 'muted' }, mine ? '클래스를 고르면 능력치와 스킬이 정해져요.' : '아직 클래스를 고르지 않았어요.'));
    }
    const sk = G.classes[c.class].skill;
    const pct = c.nextXp ? Math.min(100, Math.round(((c.xp) / c.nextXp) * 100)) : 100;
    return h('div', { class: 'sheet' },
      h('div', { class: 'lv' }, h('span', {}, `Lv.${c.level} ${c.class}`), h('span', { class: 'muted' }, `HP ${c.maxHp} · 방어도 ${c.ac}`)),
      h('div', { class: 'bar xpbar', title: '경험치' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'muted' }, c.nextXp ? `경험치 ${c.xp} / ${c.nextXp}` : `경험치 ${c.xp} (최대 레벨)`),
      h('div', { class: 'stat-grid' }, STAT_ORDER.map((st) => h('div', {},
        G.statNames[st], h('b', {}, (c.stats[st] >= 0 ? '+' : '') + c.stats[st]),
        (mine && c.statPoints > 0 && c.stats[st] < G.statCap)
          ? h('button', { class: 'btn small primary', type: 'button', title: `${G.statNames[st]} +1`, onclick: () => spendStat(st) }, '＋') : null))),
      mine && c.statPoints > 0 ? h('div', { class: 'muted', style: 'color:var(--accent)' }, `분배할 스탯 포인트 ${c.statPoints}개`) : null,
      h('div', { class: 'skill-box' }, `⚔ 공격: ${G.statNames[G.classes[c.class].attackStat]} 기반 ${G.classes[c.class].weapon}`, h('br'), `✦ 스킬 ‘${sk.name}’ (쿨타임 ${sk.cooldown}라운드): ${sk.desc}`));
  }
  function renderSheetBox() {
    const box = $('#sheetBox');
    if (box && state.character) box.replaceChildren(sheetView(state.character, true));
  }
  async function spendStat(stat) {
    try {
      const r = await api('/api/character/stat', { method: 'POST', body: { stat } });
      state.character = r.character;
      renderSheetBox();
    } catch (e) { toast(e.message, true); }
  }
  async function refreshCharacter() {
    try { const d = await api('/api/me'); state.character = d.character; renderSheetBox(); await loadInv(); } catch { /* 무시 */ }
  }

  // ---------- 의뢰 게시판 / 의뢰 패널 ----------
  const PHASE_ICON = { investigation: '🔎', combat: '⚔', won: '✅', lost: '☠', abandoned: '🏳' };
  const PHASE_LABEL = { investigation: '조사 중', combat: '전투 중', won: '완료', lost: '실패', abandoned: '포기' };

  async function renderQuestBoard() {
    const boxEl = $('#questBoard');
    try {
      const { quests, active } = await api('/api/quests');
      boxEl.textContent = '';
      boxEl.append(h('h3', {}, '📜 의뢰 게시판'));
      if (active) {
        boxEl.append(h('div', { class: 'run-banner' }, '진행 중인 의뢰가 있어요. ',
          h('button', { class: 'btn small primary', type: 'button', onclick: () => openRoom(active.threadId, active.runId) }, '이어서 하기')));
      }
      quests.forEach((q) => boxEl.append(h('div', { class: 'quest-card' },
        h('div', { class: 'q-main' },
          h('div', { class: 'q-title' }, q.title),
          h('div', { class: 'q-meta' }, `권장 Lv.${q.recommendedLevel} · 보상 경험치 ${q.rewardXp}${q.clears ? ` · 클리어 ${q.clears}회` : ''}`),
          h('div', { class: 'muted' }, q.summary)),
        h('button', { class: 'btn primary small', type: 'button', disabled: !!active, onclick: () => startQuest(q.id) }, '수락'))));
    } catch (e) { toast(e.message, true); }
  }
  async function loadRunList() {
    const el = $('#activeRuns');
    try {
      const { runs } = await api('/api/runs');
      if (state.view !== 'quests') return;
      el.textContent = '';
      if (!runs.length) return;
      el.append(h('h3', {}, '👀 진행 중 · 최근 의뢰'));
      runs.forEach((r) => el.append(h('div', { class: 'quest-card' },
        h('div', { class: 'q-main' },
          h('div', { class: 'q-title' }, `${PHASE_ICON[r.phase] || ''} ${r.title}`),
          h('div', { class: 'q-meta' }, `${r.owner} · ${PHASE_LABEL[r.phase] || r.phase}${r.round ? ` · ${r.round}라운드` : ''} · ${relTime(r.createdAt)}`)),
        h('button', { class: 'btn small', type: 'button', onclick: () => openRoom(r.threadId, r.id) }, '들어가기'))));
    } catch { /* 무시 */ }
  }

  async function startQuest(id) {
    try {
      const r = await api(`/api/quests/${id}/start`, { method: 'POST' });
      await openRoom(r.threadId, r.runId);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function loadRun(runId) {
    state.lastRunFetch = Date.now();
    try {
      const { run } = await api(`/api/runs/${runId}`);
      if (run.threadId !== state.roomId) return;
      const prev = state.run;
      if (prev && prev.combat && run.combat && prev.combat.round !== run.combat.round) lineInput.value = '';
      state.run = run;
      if (run.combat) state.skew = run.combat.serverNow - Date.now();
      renderRun();
      updateChatHeader();
      if (prev && prev.active && !run.active && run.isPlayer) refreshCharacter();
    } catch (e) { toast(e.message, true); }
  }

  async function runCall(path, body, okMsg) {
    try {
      await api(`/api/runs/${state.run.id}/${path}`, { method: 'POST', body: body || {} });
      if (path === 'investigate') lineInput.value = '';
      if (okMsg) toast(okMsg);
      await loadRun(state.run.id);
    } catch (e) { toast(e.message, true); }
  }

  const lineInput = h('input', { class: 'run-line-input', maxlength: 60, placeholder: '행동을 한 줄로 서술 (선택 · 판정 보너스는 없어요)', autocomplete: 'off' });
  const hpBar = (hp, max, enemy) => h('div', { class: 'bar' + (enemy ? ' enemy' : '') }, h('i', { style: `width:${max ? Math.max(0, Math.round((hp / max) * 100)) : 0}%` }));

  function renderRun() {
    const r = state.run;
    const el = $('#runPanel');
    if (!r) { el.hidden = true; return; }
    el.textContent = '';
    el.append(h('div', { class: 'run-head' },
      h('h3', {}, `${PHASE_ICON[r.phase] || ''} ${r.title}`),
      h('span', { class: 'phase-tag ' + r.phase }, PHASE_LABEL[r.phase] || r.phase),
      h('button', { class: 'btn small ghost', type: 'button', id: 'runFold', onclick: () => { state.runCollapsed = !state.runCollapsed; renderRun(); } },
        state.runCollapsed ? '펼치기 ▾' : '접기 ▴')));
    if (state.runCollapsed) {
      const cb = r.combat;
      el.append(h('div', { class: 'run-line' },
        r.phase === 'combat' && cb ? [`⚔ ${cb.round}라운드 · `, h('span', { class: 'run-clock', id: 'runClock' }, ''),
          ` · ${cb.enemies.map((e) => `${e.name} ${e.hp}/${e.maxHp}`).join(', ')}`] : '펼치면 행동 버튼이 나와요.'));
      el.hidden = false;
      tickRun();
      return;
    }

    if (r.phase === 'investigation') renderInvestigation(el, r);
    else if (r.combat) renderCombat(el, r);
    if (!r.active) {
      const msg = { won: '🏆 의뢰를 완료했어요. 이 방은 뒤풀이 수다방으로 계속 쓸 수 있어요.', lost: '☠ 의뢰에 실패했어요. 다시 도전할 수 있어요.', abandoned: '🏳 포기한 의뢰예요.' }[r.phase];
      if (msg) el.append(h('div', { class: 'run-banner' }, msg));
      if (r.myStatus === 'ko') el.append(h('div', { class: 'run-line' }, '전투불능 상태라 이 방에서는 발언할 수 없어요. 의뢰 목록에서 다시 시작해보세요.'));
    }
    el.hidden = false;
  }

  function renderInvestigation(el, r) {
    const inv = r.investigation;
    const alerts = '●'.repeat(Math.min(inv.alert, inv.alertLimit)) + '○'.repeat(Math.max(0, inv.alertLimit - inv.alert));
    el.append(h('div', { class: 'run-line' }, `🔎 조사 행동 ${inv.actionsLeft}/${inv.maxActions}회 남음 · 경계도 ${alerts}`));
    if (r.isOwner) {
      el.append(h('div', { class: 'run-choices' }, inv.choices.map((c) => h('button', {
        type: 'button', class: 'btn run-choice' + (c.done ? ' done' : ''), disabled: c.done,
        onclick: () => runCall('investigate', { choiceId: c.id, line: lineInput.value }),
      }, h('span', {}, (c.done ? '✓ ' : '') + c.label), h('small', {}, `${c.statName} ${c.bonus >= 0 ? '+' : ''}${c.bonus} · ${c.diffLabel}`)))));
      el.append(lineInput);
      el.append(h('div', { class: 'run-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => runCall('advance') }, '조사를 마치고 전투로'),
        h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => confirmAbandon() }, '포기')));
    } else {
      el.append(h('div', { class: 'run-line' }, '조사를 지켜보는 중이에요. 아래 채팅으로 함께 떠들어보세요!'));
    }
  }

  function confirmAbandon() { if (window.confirm('의뢰를 포기할까요? 보상은 없어요.')) runCall('abandon'); }

  function renderCombat(el, r) {
    const cb = r.combat;
    const live = r.phase === 'combat';
    if (live) el.append(h('div', { class: 'run-line' }, `⚔ ${cb.round}라운드 · `, h('span', { class: 'run-clock', id: 'runClock' }, '')));
    cb.enemies.forEach((e) => el.append(h('div', { class: 'run-unit' + (e.hp <= 0 ? ' ko' : '') },
      h('span', {}, `👹 ${e.name}`), h('span', {}, `HP ${e.hp}/${e.maxHp} · 방어도 ${e.ac}${e.guarding ? ' (+방어)' : ''}`),
      hpBar(e.hp, e.maxHp, true),
      e.intent && live ? h('div', { class: 'intent', style: 'grid-column:1/-1' }, `👁 다음 행동: ${e.intent}`) : null)));
    cb.players.forEach((p) => {
      const canCheer = live && p.userId !== state.me.id && p.status === 'active';
      el.append(h('div', { class: 'run-unit' + (p.status === 'ko' ? ' ko' : '') },
        h('span', {}, `🧑 ${p.name} (${p.cls})${p.status === 'ko' ? ' 💀' : ''}${p.submitted ? ' ✔' : ''}${p.cheers ? ` 📣${p.cheers}` : ''}${p.cd > 0 ? ` · 쿨 ${p.cd}` : ''}`),
        h('span', {}, `HP ${p.hp}/${p.maxHp}`, canCheer ? ' ' : null,
          canCheer ? h('button', { class: 'btn cheer-btn', type: 'button', disabled: cb.myCheer !== null || p.cheers >= cb.cheerMax,
            title: cb.myCheer !== null ? '이번 라운드엔 이미 응원했어요' : '이번 라운드 명중·위력 +1', onclick: () => runCall('cheer', { targetUserId: p.userId }) }, '📣 응원') : null),
        hpBar(p.hp, p.maxHp, false)));
    });
    if (live && r.isOwner && cb.me && cb.me.status === 'active') renderActions(el, r);
    else if (live && !r.isOwner) el.append(h('div', { class: 'run-line' }, '구경 중 — 채팅으로 떠들고, 📣 응원으로 힘을 보태세요.'));
    tickRun();
  }

  function renderActions(el, r) {
    const cb = r.combat, me = cb.me, sk = me.skill;
    const aliveEnemies = cb.enemies.filter((e) => e.hp > 0);
    const allies = cb.players.filter((p) => p.status === 'active');
    const sel = (key, opts, fallback) => {
      const s = h('select', { 'aria-label': key }, opts.map((o) => h('option', { value: o.v, selected: String(o.v) === String(state.runUi[key] || fallback) }, o.t)));
      s.addEventListener('change', () => { state.runUi[key] = s.value; });
      return s;
    };
    const extra = () => ({
      targetEnemyId: (aliveEnemies.length > 1 ? (state.runUi.enemy || aliveEnemies[0].id) : undefined),
      targetUserId: sk.target === 'ally' ? Number(state.runUi.ally || state.me.id) : undefined,
    });
    const act = (action, rush) => runCall('act', { action, line: lineInput.value, rush: !!rush, ...extra() });
    const label = { attack: '⚔ 공격', skill: `✦ ${sk.name}`, defend: '🛡 방어' };
    const pending = me.pending;
    el.append(lineInput);
    el.append(h('div', { class: 'run-actions' },
      aliveEnemies.length > 1 ? sel('enemy', aliveEnemies.map((e) => ({ v: e.id, t: e.name })), aliveEnemies[0].id) : null,
      h('button', { class: 'btn' + (pending && pending.action === 'attack' ? ' primary' : ''), type: 'button', onclick: () => act('attack') }, label.attack),
      sk.target === 'ally' ? sel('ally', allies.map((p) => ({ v: p.userId, t: p.userId === state.me.id ? '나' : p.name })), state.me.id) : null,
      h('button', { class: 'btn' + (pending && pending.action === 'skill' ? ' primary' : ''), type: 'button', disabled: me.cd > 0, title: sk.desc, onclick: () => act('skill') },
        label.skill + (me.cd > 0 ? ` (쿨 ${me.cd})` : '')),
      h('button', { class: 'btn' + (pending && pending.action === 'defend' ? ' primary' : ''), type: 'button', onclick: () => act('defend') }, label.defend)));
    if (pending) {
      el.append(h('div', { class: 'run-actions' },
        h('span', { class: 'run-line' }, `선택: ${label[pending.action]} — 다른 행동을 눌러 바꿀 수 있어요.`),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => act(pending.action, true) }, '⏩ 지금 진행')));
    }
    el.append(h('div', { class: 'run-actions' },
      h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => confirmAbandon() }, '포기')));
  }

  // 남은 시간 표시 (서버 시계 기준으로 보정)
  function tickRun() {
    const r = state.run;
    const clock = document.getElementById('runClock');
    if (!r || !r.combat || r.phase !== 'combat' || !clock) return;
    const cb = r.combat;
    const target = cb.readyAt || cb.deadline;
    const left = Math.ceil((target - (Date.now() + state.skew)) / 1000);
    clock.textContent = cb.readyAt ? `곧 진행돼요 (${Math.max(0, left)}초)` : `행동 마감까지 ${Math.max(0, left)}초`;
    if (left < -3 && Date.now() - state.lastRunFetch > 3000) loadRun(r.id); // 알림을 놓쳤을 때 대비
  }
  setInterval(tickRun, 500);

  // ---------- 인벤토리 / 마을 장터 ----------
  const ECO = () => state.game.economy;
  const itemDef = (id) => ECO().items[id] || { name: id, rarity: 'common', type: 'junk', value: 0, desc: '' };
  const rarityLabel = (id) => ECO().rarities[itemDef(id).rarity];
  const itemSpan = (id, qty) => h('span', { class: 'r-' + itemDef(id).rarity, title: itemDef(id).desc }, itemDef(id).name + (qty > 1 ? ` ×${qty}` : ''));
  const haveQty = (id) => ((state.inv && state.inv.items.find((x) => x.id === id)) || { qty: 0 }).qty;
  const SLOT_ORDER = ['weapon', 'armor', 'trinket'];

  async function loadInv() {
    try { state.inv = (await api('/api/inventory')).inv; renderInvBox(); renderTown(); } catch { /* 무시 */ }
  }
  // 경제 행동 공통: 호출 → 인벤토리 갱신 → 화면 갱신
  async function econ(path, body) {
    try {
      const r = await api(path, { method: 'POST', body: body || {} });
      state.inv = r.inv;
      if (['/api/equip', '/api/unequip'].includes(path)) await refreshCharacter(); // HP·방어도 변화
      renderInvBox(); renderTown();
      return r;
    } catch (e) { toast(e.message, true); return null; }
  }
  const stamText = (inv) => `체력 ${inv.stamina.cur}/${inv.stamina.max}${inv.stamina.nextInSec ? ` (+1까지 ${Math.ceil(inv.stamina.nextInSec / 60)}분)` : ''}`;

  function equipmentView(c) {
    const eq = c.equipment || {};
    const slots = ECO().slots;
    return h('div', {}, h('div', { class: 'section-title' }, '장비'),
      h('div', { class: 'inv-slots' }, SLOT_ORDER.filter((k) => slots[k]).map((k) => h('div', {},
        h('span', { class: 'muted' }, slots[k]),
        eq[k] ? h('span', { class: 'r-' + eq[k].rarity, title: itemDef(eq[k].id).desc }, eq[k].name) : h('span', { class: 'muted' }, '비어 있음')))));
  }

  function renderInvBox() {
    const box = $('#invBox');
    if (!box || !state.inv || !state.character) return;
    const inv = state.inv, slots = ECO().slots;
    const kids = [h('div', { class: 'inv-head' }, h('span', {}, '🎒 가방'), h('span', { class: 'pill gold' }, `💰 ${inv.gold}G`), h('span', { class: 'pill' }, stamText(inv)))];
    if (state.gift) kids.push(giftForm());
    kids.push(h('div', { class: 'inv-slots' }, SLOT_ORDER.filter((k) => slots[k]).map((k) => {
      const id = inv.equipment[k];
      return h('div', {}, h('span', {}, `${slots[k]}: `, id ? itemSpan(id) : h('span', { class: 'muted' }, '비어 있음'), id ? h('small', {}, ` ${itemDef(id).desc}`) : null),
        id ? h('button', { class: 'btn small', type: 'button', onclick: () => econ('/api/unequip', { slot: k }) }, '해제') : null);
    })));
    if (!inv.items.length) kids.push(h('div', { class: 'muted' }, '가방이 비어 있어요. 마을 장터에서 채집해보세요!'));
    inv.items.forEach((row) => {
      const d = itemDef(row.id);
      kids.push(h('div', { class: 'inv-item' },
        h('div', {}, itemSpan(row.id, row.qty), h('small', {}, ` · ${rarityLabel(row.id)} · 판매가 ${d.value}G`)),
        d.desc ? h('small', {}, d.desc) : null,
        h('div', { class: 'row' },
          d.type === 'equipment' ? h('button', { class: 'btn', type: 'button', onclick: () => econ('/api/equip', { itemId: row.id }) }, '장착') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => econ('/api/sell', { itemId: row.id, qty: 1 }) }, '1개 판매'),
          row.qty > 1 ? h('button', { class: 'btn', type: 'button', onclick: () => econ('/api/sell', { itemId: row.id, all: true }) }, '전부 판매') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => { state.gift = { itemId: row.id }; renderInvBox(); } }, '🎁 선물'))));
    });
    kids.push(h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => { state.gift = { itemId: null }; renderInvBox(); } }, '🎁 골드 선물'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: showGiftLog }, '선물 기록')));
    box.replaceChildren(h('div', { class: 'inv-box' }, kids));
  }

  function giftForm() {
    const g = state.gift;
    const to = h('select', {}, h('option', { value: '' }, '받는 사람 선택'),
      state.roster.filter((c) => c.userId !== state.me.id).map((c) => h('option', { value: c.userId }, c.name)));
    const qty = g.itemId ? h('input', { type: 'number', min: 1, max: haveQty(g.itemId), value: 1, 'aria-label': '수량' }) : null;
    const gold = h('input', { type: 'number', min: 0, max: ECO().settings.giftMaxGold, placeholder: g.itemId ? '골드도 함께 (선택)' : '보낼 골드', 'aria-label': '골드' });
    const msg = h('input', { maxlength: 100, placeholder: '한마디 (선택)', autocomplete: 'off' });
    const f = h('form', { class: 'gift-form' },
      h('div', {}, g.itemId ? ['🎁 ', itemSpan(g.itemId), ' 선물'] : '🎁 골드 선물'),
      to, qty, gold, msg,
      h('div', { class: 'btn-line' }, h('button', { class: 'btn primary small', type: 'submit' }, '보내기'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { state.gift = null; renderInvBox(); } }, '취소')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!to.value) return toast('받는 사람을 골라주세요.', true);
      const body = { toUserId: Number(to.value), message: msg.value };
      if (g.itemId) { body.itemId = g.itemId; body.qty = Number(qty.value); }
      if (Number(gold.value) > 0) body.gold = Number(gold.value);
      const r = await econ('/api/gift', body);
      if (r) { state.gift = null; renderInvBox(); toast('선물을 보냈어요!'); }
    });
    return f;
  }

  async function showGiftLog() {
    try {
      const { gifts } = await api('/api/gifts');
      const lines = gifts.length ? gifts.map((g) => `${g.mine === 'sent' ? `→ ${g.to} 에게` : `← ${g.from} 에게서`}  ${g.what}${g.message ? ` “${g.message}”` : ''}`).join('\n') : '아직 선물 기록이 없어요.';
      window.alert('최근 선물 기록\n\n' + lines);
    } catch (e) { toast(e.message, true); }
  }

  // ----- 마을 장터 패널 -----
  const TOWN_TABS = [['farm', '🧺 채집'], ['craft', '🔨 제작'], ['jar', '🏺 도박항아리'], ['shop', '💰 상점']];
  function renderTown() {
    const el = $('#townPanel');
    if (!el || state.view !== 'town' || !state.inv || !state.game) return;
    const inv = state.inv, tab = state.townTab;
    el.textContent = '';
    el.append(h('div', { class: 'town-head' }, h('h3', {}, '🏘 마을 장터'), h('span', { class: 'pill gold' }, `💰 ${inv.gold}G`), h('span', { class: 'pill' }, stamText(inv))));
    el.append(h('div', { class: 'town-tabs' }, TOWN_TABS.map(([k, label]) => h('button', {
      type: 'button', class: 'btn small' + (k === tab ? ' active' : ''), onclick: () => { state.townTab = k; renderTown(); } }, label))));
    if (state.townResult) el.append(h('div', { class: 'town-result' }, state.townResult));
    if (tab === 'farm') townFarm(el); else if (tab === 'craft') townCraft(el); else if (tab === 'jar') townJar(el); else townShop(el);
  }
  const dropNames = (ids) => ids.map((id) => itemDef(id).name).join(', ');

  function townFarm(el) {
    const lvl = state.character.level;
    ECO().spots.forEach((s) => el.append(h('div', { class: 'town-row' },
      h('div', { class: 't-main' }, h('div', { class: 't-title' }, s.name), h('div', { class: 't-meta' }, `${s.desc} · Lv.${s.minLevel}+ · 체력 ${s.cost}`),
        h('div', { class: 't-meta' }, `나올 수 있는 것: ${dropNames(s.drops)}`)),
      h('button', { class: 'btn primary small', type: 'button', disabled: lvl < s.minLevel || state.inv.stamina.cur < s.cost, onclick: async () => {
        const r = await econ('/api/farm', { spotId: s.id });
        if (!r) return;
        const x = r.result;
        state.townResult = x.nothing ? `🍂 ${s.name}: ${x.text}` : `🧺 ${s.name}: ${itemDef(x.item).name}${x.qty > 1 ? ` ×${x.qty}` : ''} 획득! (${rarityLabel(x.item)})`;
        renderTown();
      } }, '채집'))));
  }

  function townCraft(el) {
    const stats = state.character.stats, names = state.game.statNames;
    ECO().recipes.forEach((rc) => {
      const ok = state.inv.gold >= rc.gold && Object.entries(rc.inputs).every(([id, n]) => haveQty(id) >= n);
      const o = itemDef(rc.output);
      el.append(h('div', { class: 'town-row' },
        h('div', { class: 't-main' },
          h('div', { class: 't-title' }, itemSpan(rc.output), h('small', {}, ` · ${rc.name} · ${o.desc}`)),
          h('div', { class: 't-meta' }, Object.entries(rc.inputs).map(([id, n]) => h('span', { class: haveQty(id) >= n ? 'need-ok' : 'need-no' }, `${itemDef(id).name} ${haveQty(id)}/${n}  `)),
            h('span', { class: state.inv.gold >= rc.gold ? 'need-ok' : 'need-no' }, rc.gold ? `${rc.gold}G` : '')),
          h('div', { class: 't-meta' }, `${names[rc.stat]} 판정 목표 ${rc.dc} (내 보정 ${stats[rc.stat] >= 0 ? '+' : ''}${stats[rc.stat]}) · 실패하면 수수료만 잃고, 대실패면 재료도 절반 잃어요 · 대성공이면 2개!`)),
        h('button', { class: 'btn primary small', type: 'button', disabled: !ok, onclick: async () => {
          const r = await econ('/api/craft', { recipeId: rc.id });
          if (!r) return;
          const x = r.result, ro = x.roll;
          const head = `🎲 d20(${ro.nat})${ro.bonus >= 0 ? '+' : ''}${ro.bonus}=${ro.total} vs ${ro.dc}`;
          state.townResult = ro.success ? `${head}\n🔨 ${ro.crit ? '대성공! ' : '성공! '}${itemDef(x.output).name} ×${x.qty} 완성` : `${head}\n💥 ${ro.fumble ? '대실패… 재료 절반이 못쓰게 됐다.' : '실패… 수수료만 날렸다.'}`;
          renderTown();
        } }, '제작')));
    });
  }

  function townJar(el) {
    el.append(h('div', { class: 'muted' }, '골드를 내고 항아리를 깨요. 본전은 보통 못 건지지만, 가끔 대박이 터집니다. 희귀 이상은 모두에게 공지돼요.'));
    ECO().jars.forEach((j) => el.append(h('div', { class: 'town-row' },
      h('div', { class: 't-main' }, h('div', { class: 't-title' }, j.name), h('div', { class: 't-meta' }, j.desc),
        h('div', { class: 't-meta' }, `나올 수 있는 것: ${j.hasGold ? '골드, ' : ''}${dropNames(j.prizes)}`)),
      h('button', { class: 'btn primary small', type: 'button', disabled: state.inv.gold < j.price, onclick: async () => {
        const r = await econ('/api/jar', { jarId: j.id });
        if (!r) return;
        const x = r.result;
        state.townResult = x.gold !== undefined ? `🏺 ${j.name}: 골드 ${x.gold}G!` : `🏺 ${j.name}: ${itemDef(x.item).name}${x.qty > 1 ? ` ×${x.qty}` : ''}! (${rarityLabel(x.item)})`;
        renderTown();
      } }, `깨기 ${j.price}G`))));
  }

  function townShop(el) {
    const junk = state.inv.items.filter((x) => itemDef(x.id).type === 'junk');
    el.append(h('div', { class: 'town-row' }, h('div', { class: 't-main' }, h('div', { class: 't-title' }, '잡템 한꺼번에 팔기'),
      h('div', { class: 't-meta' }, junk.length ? junk.map((x) => `${itemDef(x.id).name} ×${x.qty}`).join(', ') : '팔 잡템이 없어요.')),
      h('button', { class: 'btn primary small', type: 'button', disabled: !junk.length, onclick: async () => {
        const r = await econ('/api/sell-junk');
        if (r) { state.townResult = `💰 잡템 ${r.sold.count}개를 팔아 ${r.sold.gold}G를 받았다.`; renderTown(); }
      } }, '전부 팔기')));
    state.inv.items.forEach((x) => {
      const d = itemDef(x.id);
      el.append(h('div', { class: 'town-row' },
        h('div', { class: 't-main' }, h('div', { class: 't-title' }, itemSpan(x.id, x.qty)), h('div', { class: 't-meta' }, `개당 ${d.value}G`)),
        h('button', { class: 'btn small', type: 'button', onclick: async () => { const r = await econ('/api/sell', { itemId: x.id, qty: 1 }); if (r) { state.townResult = `💰 ${d.name} 1개를 ${d.value}G에 팔았다.`; renderTown(); } } }, '1개'),
        x.qty > 1 ? h('button', { class: 'btn small', type: 'button', onclick: async () => { const r = await econ('/api/sell', { itemId: x.id, all: true }); if (r) { state.townResult = `💰 ${d.name} ${r.sold.qty}개를 ${r.sold.gold}G에 팔았다.`; renderTown(); } } }, '전부') : null));
    });
    if (!state.inv.items.length) el.append(h('div', { class: 'muted' }, '가방이 비어 있어요.'));
  }
  // 스태미나 회복 표시는 30초마다 서버값으로 갱신
  setInterval(() => { if (state.inv && state.inv.stamina.nextInSec > 0 && !$('#game').hidden) loadInv(); }, 60000);


  // 새로고침해도 로그인 유지: 세션 쿠키가 있으면 바로 입장
  init();
})();
