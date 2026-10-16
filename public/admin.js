'use strict';
(function () {
  const $ = (s) => document.querySelector(s);

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

  let timer;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(timer);
    timer = setTimeout(() => { t.className = 'toast'; }, 2800);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch { /* 빈 응답 */ }
    if (res.status === 401) { location.href = '/'; throw new Error('로그인이 필요합니다.'); }
    if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
    return data;
  }

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '-');
  const act = (fn) => async () => { try { await fn(); } catch (e) { toast(e.message, true); } };

  let current = 'users';
  function setTab(tab) {
    current = tab;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('primary', b.dataset.tab === tab));
    render();
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  async function render() {
    const view = $('#view');
    try {
      if (current === 'users') await renderUsers(view);
      else if (current === 'threads') await renderThreads(view);
      else if (current === 'posts') await renderPosts(view);
      else if (current === 'reports') await renderReports(view);
      else if (current === 'balance') await renderBalance(view);
      else await renderInvites(view);
    } catch (e) { view.textContent = ''; view.append(h('p', { class: 'error' }, e.message)); }
    refreshReportCount();
  }

  async function refreshReportCount() {
    try {
      const [a, b] = await Promise.all([api('/api/admin/reports'), api('/api/admin/post-reports')]);
      const n = a.reports.length + b.reports.length;
      $('#reportCount').textContent = n ? `(${n})` : '';
    } catch { /* 무시 */ }
  }

  // ----- 유저 -----
  async function renderUsers(view) {
    const { users } = await api('/api/admin/users');
    view.textContent = '';
    const rows = users.map((u) => {
      const muted = u.mutedUntil > Date.now();
      const btns = h('div', { class: 'btn-row' });
      if (!u.isAdmin) {
        btns.append(
          muted
            ? h('button', { class: 'btn small', type: 'button', onclick: act(async () => { await api(`/api/admin/users/${u.id}/unmute`, { method: 'POST' }); render(); }) }, '뮤트 해제')
            : h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
              const m = window.prompt('몇 분 동안 채팅을 막을까요?', '30');
              if (!m) return;
              await api(`/api/admin/users/${u.id}/mute`, { method: 'POST', body: { minutes: Number(m) } });
              render();
            }) }, '뮤트'),
          u.banned
            ? h('button', { class: 'btn small', type: 'button', onclick: act(async () => { await api(`/api/admin/users/${u.id}/unban`, { method: 'POST' }); render(); }) }, '정지 해제')
            : h('button', { class: 'btn small danger', type: 'button', onclick: act(async () => {
              if (!window.confirm(`${u.charName || u.username} 계정을 정지할까요?`)) return;
              await api(`/api/admin/users/${u.id}/ban`, { method: 'POST' });
              render();
            }) }, '정지'),
          u.image ? h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
            if (!window.confirm('프로필 이미지를 삭제할까요?')) return;
            await api(`/api/admin/users/${u.id}/image`, { method: 'DELETE' });
            render();
          }) }, '이미지 삭제') : null,
          h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
            const pw = window.prompt('새 비밀번호 (8자 이상)');
            if (!pw) return;
            await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: { password: pw } });
            toast('비밀번호를 바꿨어요.');
          }) }, '비번 재설정'));
      }
      return h('tr', {},
        h('td', {}, h('div', {}, u.charName || '(없음)', u.isAdmin ? h('span', { class: 'tag good' }, '관리자') : null),
          h('div', { class: 'muted' }, '@' + u.username)),
        h('td', {},
          u.online ? h('span', { class: 'tag good' }, '접속 중') : null,
          muted ? h('span', { class: 'tag bad' }, '뮤트') : null,
          u.banned ? h('span', { class: 'tag bad' }, '정지') : null),
        h('td', { class: 'muted' }, fmt(u.createdAt)),
        h('td', {}, btns));
    });
    view.append(h('div', { class: 'card scroll-x' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '캐릭터'), h('th', {}, '상태'), h('th', {}, '가입일'), h('th', {}, '관리'))),
        h('tbody', {}, rows))));
  }

  // ----- 채널 · 스레드 -----
  async function renderThreads(view) {
    const { threads } = await api('/api/admin/threads');
    view.textContent = '';

    const chName = h('input', { placeholder: '새 채널 이름 (예: 던전 정보)', maxlength: 60, style: 'max-width:260px' });
    view.append(h('div', { class: 'card btn-row', style: 'align-items:center' },
      chName,
      h('button', { class: 'btn primary small', type: 'button', onclick: act(async () => {
        await api('/api/admin/channels', { method: 'POST', body: { title: chName.value } });
        render();
      }) }, '채널 만들기')));

    const rows = threads.map((t) => h('tr', {},
      h('td', {}, h('div', {}, (t.kind === 'channel' ? '# ' : '') + t.title,
        t.locked ? h('span', { class: 'tag bad' }, '잠김') : null),
      h('div', { class: 'muted' }, t.kind === 'channel' ? '고정 채널' : `만든 사람: ${t.creator || '-'}`)),
      h('td', {}, String(t.messageCount)),
      h('td', { class: 'muted' }, fmt(t.lastMessageAt)),
      h('td', {}, h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
          await api(`/api/admin/threads/${t.id}/lock`, { method: 'POST', body: { locked: !t.locked } });
          render();
        }) }, t.locked ? '잠금 해제' : '잠그기'),
        t.kind === 'thread' ? h('button', { class: 'btn small danger', type: 'button', onclick: act(async () => {
          if (!window.confirm(`스레드 "${t.title}"를 삭제할까요? 모든 유저 화면에서 사라집니다.`)) return;
          await api(`/api/admin/threads/${t.id}`, { method: 'DELETE' });
          render();
        }) }, '삭제') : null))));
    view.append(h('div', { class: 'card scroll-x' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '이름'), h('th', {}, '글 수'), h('th', {}, '마지막 활동'), h('th', {}, '관리'))),
        h('tbody', {}, rows))));
  }

  // ----- 신고 -----
  async function renderPosts(view) {
    const { posts } = await api('/api/admin/posts');
    view.textContent = '';
    if (!posts.length) { view.append(h('div', { class: 'card muted' }, '타임라인에 글이 아직 없어요.')); return; }
    for (const p of posts) {
      view.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, `#${p.id} · ${fmt(p.createdAt)}${p.parentId ? ' · 답글' : ''}${p.quote ? ' · 리포스트/인용' : ''}`),
        h('div', { style: 'margin:6px 0' }, h('strong', {}, p.user.name), ': ', p.deleted ? h('span', { class: 'muted' }, '(삭제됨)') : p.body),
        p.deleted ? null : h('button', { class: 'btn small danger', type: 'button', onclick: act(async () => {
          if (!window.confirm('이 글을 삭제할까요?')) return;
          await api('/api/posts/' + p.id, { method: 'DELETE' });
          render();
        }) }, '삭제')));
    }
  }

  async function renderReports(view) {
    const { reports } = await api('/api/admin/reports');
    const pr = (await api('/api/admin/post-reports')).reports;
    view.textContent = '';
    if (!reports.length && !pr.length) { view.append(h('div', { class: 'card muted' }, '처리할 신고가 없어요.')); return; }
    for (const r of pr) {
      view.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, `[타임라인 글] ${fmt(r.createdAt)} · 신고자 @${r.reporter}`),
        h('div', { style: 'margin:6px 0' }, h('strong', {}, r.author), ': ', r.deleted ? '(삭제됨)' : r.body),
        r.reason ? h('div', { class: 'muted' }, '사유: ' + r.reason) : null,
        h('div', { class: 'btn-row', style: 'margin-top:8px' },
          r.deleted ? h('span', { class: 'tag' }, '이미 삭제됨') : h('button', { class: 'btn small danger', type: 'button', onclick: act(async () => {
            await api('/api/posts/' + r.postId, { method: 'DELETE' });
            render();
          }) }, '글 삭제'),
          h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
            await api(`/api/admin/post-reports/${r.id}/resolve`, { method: 'POST' });
            render();
          }) }, '문제 없음(처리 완료)'))));
    }
    for (const r of reports) {
      view.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, `${fmt(r.createdAt)} · 신고자 @${r.reporter}`),
        h('div', { style: 'margin:6px 0' }, h('strong', {}, r.author), ': ', r.body),
        r.reason ? h('div', { class: 'muted' }, '사유: ' + r.reason) : null,
        h('div', { class: 'btn-row', style: 'margin-top:8px' },
          r.deleted ? h('span', { class: 'tag' }, '이미 삭제됨') : h('button', { class: 'btn small danger', type: 'button', onclick: act(async () => {
            await api(`/api/admin/messages/${r.messageId}`, { method: 'DELETE' });
            render();
          }) }, '메시지 삭제'),
          h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
            await api(`/api/admin/reports/${r.id}/resolve`, { method: 'POST' });
            render();
          }) }, '문제 없음(처리 완료)'))));
    }
  }

  // ----- 초대코드 -----
  async function renderInvites(view) {
    const { invites } = await api('/api/admin/invites');
    view.textContent = '';
    const count = h('input', { type: 'number', min: 1, max: 30, value: 5, style: 'width:80px' });
    view.append(h('div', { class: 'card btn-row', style: 'align-items:center' },
      '새 초대코드', count, '개',
      h('button', { class: 'btn primary small', type: 'button', onclick: act(async () => {
        await api('/api/admin/invites', { method: 'POST', body: { count: Number(count.value) } });
        render();
      }) }, '만들기')));

    const unused = invites.filter((i) => !i.usedBy);
    view.append(h('div', { class: 'card' },
      h('div', { style: 'margin-bottom:8px' }, `사용 가능 (${unused.length})`),
      unused.length ? h('div', { class: 'btn-row' }, unused.map((i) =>
        h('span', { class: 'btn small code', title: '클릭하면 복사', onclick: () => {
          navigator.clipboard.writeText(i.code).then(() => toast('복사했어요: ' + i.code)).catch(() => toast(i.code));
        } }, i.code))) : h('span', { class: 'muted' }, '남은 코드가 없어요.')));

    const used = invites.filter((i) => i.usedBy);
    if (used.length) {
      view.append(h('div', { class: 'card scroll-x' },
        h('div', { style: 'margin-bottom:8px' }, `사용됨 (${used.length})`),
        h('table', {}, h('tbody', {}, used.map((i) =>
          h('tr', {}, h('td', { class: 'code' }, i.code), h('td', {}, '@' + i.usedBy), h('td', { class: 'muted' }, fmt(i.usedAt))))))));
    }
  }

  // ----- 밸런스 (숫자 조정) -----
  // 바꾼 칸은 pending 에 모아 두었다가 [저장] 한 번에 보냅니다. 서버가 전체를 검증하고 통과하면 즉시 반영돼요.
  const bal = { pending: new Map(), query: '', open: new Set(), data: null, error: '' };

  async function renderBalance(view, data) {
    bal.data = data || await api('/api/admin/balance');
    const { fields, history, warnings } = bal.data;
    view.textContent = '';

    const errBox = h('div', { class: 'bal-error' }, bal.error);
    const count = h('strong', {}, String(bal.pending.size));
    const note = h('input', { placeholder: '메모 (선택, 예: 도적 두목 너무 셈)', maxlength: 100, style: 'max-width:260px' });
    const save = act(async () => {
      if (!bal.pending.size) { toast('바뀐 값이 없어요.'); return; }
      try {
        const r = await api('/api/admin/balance', { method: 'POST', body: { changes: Object.fromEntries(bal.pending), note: note.value } });
        bal.pending.clear(); bal.error = '';
        toast(r.changed ? `${r.changed}개 값을 바꿨어요. 바로 적용됐어요.` : '바뀐 값이 없어요.');
        await renderBalance(view, r);
      } catch (e) { bal.error = e.message; errBox.textContent = e.message; throw e; }
    });
    const search = h('input', { type: 'search', placeholder: '찾기 (예: 두목, 화염구, 항아리)', value: bal.query, style: 'max-width:260px' });

    view.append(h('div', { class: 'card' },
      h('div', { class: 'muted', style: 'margin-bottom:8px' },
        '숫자를 고치고 [저장]을 누르면 서버를 끄지 않아도 바로 적용돼요. 잘못된 값은 저장되지 않고 이유를 알려줘요. ',
        '이미 진행 중인 전투의 적 HP 등은 그대로이고, 다음 의뢰부터 바뀌어요. 접속 중인 사람은 새로고침하면 설명 문구도 바뀌어요.'),
      h('div', { class: 'btn-row', style: 'align-items:center' },
        search, note,
        h('button', { class: 'btn primary small', type: 'button', onclick: save }, '저장 (', count, '개)'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { bal.pending.clear(); bal.error = ''; renderBalance(view, bal.data); } }, '고친 것 취소'),
        h('a', { class: 'btn small', href: '/api/admin/balance/export', download: 'balance-content.json' }, '현재 수치 내려받기'),
        h('button', { class: 'btn small danger', type: 'button', onclick: act(async () => {
          if (!window.confirm('관리자가 바꾼 값을 모두 지우고 기본값(content 파일)으로 돌릴까요? 기록은 남아서 다시 되돌릴 수 있어요.')) return;
          const r = await api('/api/admin/balance/reset', { method: 'POST' });
          bal.pending.clear();
          toast('기본값으로 돌렸어요.');
          await renderBalance(view, r);
        }) }, '모두 기본값으로')),
      errBox,
      (warnings || []).map((w) => h('div', { class: 'bal-warn' }, '⚠ ' + w))));

    // 묶음별로 접어서 보여줌
    const groups = new Map();
    for (const f of fields) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    const list = h('div', { class: 'card' });
    const rowsOf = [];
    for (const [g, fs] of groups) {
      const rows = fs.map((f) => {
        const cur = bal.pending.has(f.key) ? bal.pending.get(f.key) : f.value;
        let input;
        if (f.kind === 'choice') {
          input = h('select', {}, f.options.map((o) => h('option', { value: o, selected: String(cur) === o }, (f.optionLabels || {})[o] || o)));
        } else {
          input = h('input', { type: f.kind === 'number' ? 'number' : 'text', step: 'any', value: String(cur) });
        }
        const row = h('div', { class: 'bal-row' + (bal.pending.has(f.key) ? ' dirty' : '') },
          h('span', { class: 'bal-label' }, f.label,
            f.changed ? h('span', { class: 'tag good', title: '관리자가 바꾼 값' }, '조정됨') : null),
          input,
          h('span', { class: 'muted' }, `기본 ${(f.optionLabels || {})[f.base] || f.base}`));
        const onEdit = () => {
          const v = f.kind === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value;
          if (String(v) === String(f.value)) bal.pending.delete(f.key); else bal.pending.set(f.key, v);
          row.classList.toggle('dirty', bal.pending.has(f.key));
          count.textContent = String(bal.pending.size);
        };
        input.addEventListener(f.kind === 'choice' ? 'change' : 'input', onEdit);
        row.dataset.search = (g + ' ' + f.label).toLowerCase();
        return row;
      });
      const changedN = fs.filter((f) => f.changed).length;
      const det = h('details', { class: 'bal-group', open: bal.open.has(g) },
        h('summary', {}, g, changedN ? h('span', { class: 'tag good' }, `조정 ${changedN}`) : null),
        h('div', { class: 'bal-rows' }, rows));
      det.addEventListener('toggle', () => { if (det.open) bal.open.add(g); else bal.open.delete(g); });
      list.append(det);
      rowsOf.push([det, rows]);
    }
    const applySearch = () => {
      bal.query = search.value;
      const q = search.value.trim().toLowerCase();
      for (const [det, rows] of rowsOf) {
        let any = false;
        rows.forEach((r) => { const ok = !q || r.dataset.search.includes(q); r.style.display = ok ? '' : 'none'; any = any || ok; });
        det.style.display = any ? '' : 'none';
        if (q && any) det.open = true;
      }
    };
    search.addEventListener('input', applySearch);
    view.append(list);
    applySearch();

    // 변경 기록 + 되돌리기
    const hist = h('div', { class: 'card' }, h('div', { style: 'margin-bottom:6px' }, '변경 기록 (최근 50개)'));
    if (!history.length) hist.append(h('div', { class: 'muted' }, '아직 바꾼 적이 없어요.'));
    for (const e of history) {
      const shown = e.changes.slice(0, 8);
      hist.append(h('div', { class: 'bal-hist' },
        h('div', {}, h('strong', {}, `#${e.id}`), ` ${fmt(e.at)} · @${e.by || '-'}`, e.note ? ` · ${e.note}` : ''),
        h('ul', {}, shown.map((c) => h('li', {}, `${c.label}: ${c.from} → ${c.to}`)),
          e.changes.length > shown.length ? h('li', { class: 'muted' }, `외 ${e.changes.length - shown.length}개`) : null),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
            if (!window.confirm(`#${e.id} 변경 직전 상태로 되돌릴까요?`)) return;
            const r = await api('/api/admin/balance/revert', { method: 'POST', body: { id: e.id, mode: 'before' } });
            bal.pending.clear();
            toast('되돌렸어요.');
            await renderBalance(view, r);
          }) }, '이 변경 전으로 되돌리기'),
          h('button', { class: 'btn small', type: 'button', onclick: act(async () => {
            if (!window.confirm(`#${e.id} 저장 직후 상태로 맞출까요?`)) return;
            const r = await api('/api/admin/balance/revert', { method: 'POST', body: { id: e.id } });
            bal.pending.clear();
            toast('그 시점으로 맞췄어요.');
            await renderBalance(view, r);
          }) }, '이 시점으로 맞추기'))));
    }
    view.append(hist);
  }

  setTab('users');
})();
