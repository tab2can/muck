/**
 * DM toolbar: search, pins, group create, profile toggle, call UI.
 * Wired from app.js via initDmFeatures(api).
 */
export function initDmFeatures(api) {
  const {
    $, toast, escapeHtml, initials, formatTime, userChipHtml,
    getSocket, getState, setState, openGroupChannel, openDM,
    startDmCall, endDmCall, toggleDmMic, toggleDmCam, toggleDmScreen,
    leaveVoiceIfNeeded, confirmLeaveGroup, showModal, closeModal,
  } = api;

  let groupSelected = new Set();
  let searchTimer = null;

  function st() { return getState(); }

  function highlight(text, q) {
    const raw = String(text || '');
    const query = String(q || '').trim();
    if (!query) return escapeHtml(raw);
    const lower = raw.toLowerCase();
    const ql = query.toLowerCase();
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const idx = lower.indexOf(ql, i);
      if (idx < 0) { out += escapeHtml(raw.slice(i)); break; }
      out += escapeHtml(raw.slice(i, idx));
      out += `<mark>${escapeHtml(raw.slice(idx, idx + query.length))}</mark>`;
      i = idx + query.length;
    }
    return out;
  }

  function syncProfileBtn() {
    const btn = $('dm-btn-profile');
    const open = !!st().dmProfileOpen;
    btn?.classList.toggle('active', open);
    if (btn) btn.title = open ? 'Kullanıcı Profilini Gizle' : 'Kullanıcı Profilini Göster';
  }

  function setProfileOpen(open) {
    setState({ dmProfileOpen: !!open });
    try { localStorage.setItem('muck_dm_profile', open ? 'on' : 'off'); } catch {}
    syncProfileBtn();
    api.updatePanel?.();
  }

  function closeSearchPanel() {
    $('dm-search-panel')?.classList.add('hidden');
    $('dm-search-results').innerHTML = '';
  }

  function closePinsPanel() {
    $('dm-pins-panel')?.classList.add('hidden');
  }

  function renderSearchResults(results, query) {
    const box = $('dm-search-results');
    const count = $('dm-search-count');
    const ctx = $('dm-search-context');
    const state = st();
    if (!box) return;
    box.innerHTML = '';
    if (count) count.textContent = `${results.length} Sonuç`;
    if (ctx) ctx.textContent = state.activeGroupId
      ? (state.activeGroupTitle || 'Grup')
      : `@ ${state.activeDmFriendName || ''}`;
    for (const m of results) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dm-result-card';
      btn.innerHTML = `
        <div class="dm-result-top">
          <span class="user-chip-avatar user-chip-avatar--sm">${escapeHtml(initials(m.username))}</span>
          <span class="dm-result-meta">
            <div class="dm-result-name">${escapeHtml(m.username)}</div>
            <div class="dm-result-time">${escapeHtml(formatDateTime(m.ts))}</div>
          </span>
        </div>
        <div class="dm-result-text">${highlight(m.text, query)}</div>`;
      btn.addEventListener('click', () => {
        closeSearchPanel();
        const el = document.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.classList.add('msg-flash');
        setTimeout(() => el?.classList.remove('msg-flash'), 1200);
      });
      box.appendChild(btn);
    }
    $('dm-search-panel')?.classList.toggle('hidden', false);
    closePinsPanel();
  }

  function formatDateTime(ts) {
    try {
      return new Date(ts).toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  }

  function runSearch(q) {
    const channelId = st().activeDmChannelId;
    if (!channelId || !q.trim()) { closeSearchPanel(); return; }
    getSocket()?.emit('search-dm', { channelId, query: q }, (res) => {
      if (res?.error) { toast(res.error); return; }
      renderSearchResults(res.results || [], q);
    });
  }

  function renderPins(pins) {
    const box = $('dm-pins-results');
    if (!box) return;
    box.innerHTML = '';
    if (!pins?.length) {
      box.innerHTML = '<p class="friends-empty-hint">Sabitlenmiş mesaj yok.</p>';
    } else {
      for (const p of pins) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dm-result-card';
        btn.innerHTML = `
          <div class="dm-result-top">
            <span class="user-chip-avatar user-chip-avatar--sm">${escapeHtml(initials(p.username))}</span>
            <span class="dm-result-meta">
              <div class="dm-result-name">${escapeHtml(p.username)}</div>
              <div class="dm-result-time">${escapeHtml(formatDateTime(p.ts))}</div>
            </span>
          </div>
          <div class="dm-result-text">${escapeHtml(p.text)}</div>`;
        box.appendChild(btn);
      }
    }
    $('dm-pins-panel')?.classList.remove('hidden');
    closeSearchPanel();
  }

  function openPins() {
    const channelId = st().activeDmChannelId;
    if (!channelId) return;
    getSocket()?.emit('get-dm-pins', { channelId }, (res) => {
      if (res?.error) { toast(res.error); return; }
      setState({ dmPins: res.pins || [] });
      renderPins(res.pins || []);
    });
  }

  /* ---- Group DM modal ---- */
  function openGroupModal() {
    groupSelected = new Set();
    const friendId = st().activeDmFriendId;
    if (friendId) groupSelected.add(friendId);
    $('group-dm-search').value = '';
    renderGroupPicker();
    updateGroupHint();
    $('group-dm-overlay')?.classList.remove('hidden');
    $('group-dm-search')?.focus();
  }

  function closeGroupModal() {
    $('group-dm-overlay')?.classList.add('hidden');
  }

  function updateGroupHint() {
    const remaining = Math.max(0, 9 - groupSelected.size);
    const el = $('group-dm-hint');
    if (el) el.textContent = `${remaining} kişi daha ekleyebilirsin.`;
  }

  function renderGroupPicker() {
    const list = $('group-dm-list');
    const q = ($('group-dm-search')?.value || '').trim().toLowerCase();
    if (!list) return;
    list.innerHTML = '';
    for (const f of st().friends || []) {
      if (q && !f.username.toLowerCase().includes(q)) continue;
      const selected = groupSelected.has(f.id);
      const li = document.createElement('li');
      li.className = 'group-dm-row' + (selected ? ' selected' : '');
      li.innerHTML = `
        ${userChipHtml(f.username, !!f.online, { size: 'md', subtitle: `@${f.username}` })}
        <span class="group-dm-check${selected ? ' on' : ''}"></span>`;
      li.addEventListener('click', () => {
        if (groupSelected.has(f.id)) groupSelected.delete(f.id);
        else {
          if (groupSelected.size >= 9) { toast('En fazla 10 kişi olabilir.'); return; }
          groupSelected.add(f.id);
        }
        renderGroupPicker();
        updateGroupHint();
      });
      list.appendChild(li);
    }
  }

  function createGroup() {
    const memberIds = [...groupSelected];
    if (!memberIds.length) { toast('En az bir kişi seç.'); return; }
    getSocket()?.emit('create-group-dm', { memberIds }, (res) => {
      if (res?.error) { toast(res.error); return; }
      closeGroupModal();
      openGroupChannel?.(res.channel);
    });
  }

  /* ---- Message context menu ---- */
  function openMessageMenu(x, y, msg, channelId) {
    const menu = $('ctx-menu');
    if (!menu || !msg) return;
    api.closeCtxMenu?.();
    const add = (opts) => menu.appendChild(api.ctxItem(opts));
    const sep = () => menu.appendChild(api.ctxSep());

    add({
      label: 'Metni Kopyala',
      onClick: async () => {
        api.closeCtxMenu?.();
        try { await navigator.clipboard.writeText(msg.text || ''); toast('Kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    });
    add({
      label: 'Mesajı Sabitle',
      onClick: () => {
        api.closeCtxMenu?.();
        getSocket()?.emit('pin-dm-message', { channelId, messageId: msg.id, pinned: true }, (res) => {
          if (res?.error) toast(res.error);
          else { toast('Mesaj sabitlendi'); setState({ dmPins: res.pins || [] }); }
        });
      },
    });
    sep();
    if (st().settings?.developer) {
      add({
        label: "Mesaj ID'sini Kopyala",
        right: 'ID',
        onClick: async () => {
          api.closeCtxMenu?.();
          try { await navigator.clipboard.writeText(String(msg.id)); toast('Mesaj ID kopyalandı'); }
          catch { toast('Kopyalanamadı'); }
        },
      });
    }
    api.placeCtxMenu?.(menu, x, y);
  }

  /* ---- Call UI ---- */
  function showCallStage(visible) {
    $('dm-call-stage')?.classList.toggle('hidden', !visible);
  }

  function updateCallStage(name) {
    $('dm-call-name').textContent = name || '—';
    $('dm-call-avatar').textContent = initials(name);
  }

  /* ---- Wire DOM ---- */
  $('dm-btn-profile')?.addEventListener('click', () => setProfileOpen(!st().dmProfileOpen));
  $('dm-btn-pins')?.addEventListener('click', () => {
    if ($('dm-pins-panel')?.classList.contains('hidden') === false) closePinsPanel();
    else openPins();
  });
  $('dm-pins-close')?.addEventListener('click', closePinsPanel);
  $('dm-search-close')?.addEventListener('click', () => {
    closeSearchPanel();
    if ($('dm-search-input')) $('dm-search-input').value = '';
  });
  $('dm-search-input')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => runSearch(q), 220);
  });
  $('dm-btn-group')?.addEventListener('click', openGroupModal);
  $('group-dm-close')?.addEventListener('click', closeGroupModal);
  $('group-dm-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('group-dm-overlay')) closeGroupModal();
  });
  $('group-dm-search')?.addEventListener('input', renderGroupPicker);
  $('group-dm-create')?.addEventListener('click', createGroup);
  $('dm-btn-call')?.addEventListener('click', () => startDmCall?.());
  $('dm-call-end')?.addEventListener('click', () => endDmCall?.());
  $('dm-call-mic')?.addEventListener('click', () => toggleDmMic?.());
  $('dm-call-cam')?.addEventListener('click', () => toggleDmCam?.());
  $('dm-call-screen')?.addEventListener('click', () => toggleDmScreen?.());

  // Restore profile preference
  try {
    const v = localStorage.getItem('muck_dm_profile');
    if (v === 'off') setState({ dmProfileOpen: false });
    else if (v === 'on') setState({ dmProfileOpen: true });
  } catch {}
  syncProfileBtn();

  return {
    syncProfileBtn,
    setProfileOpen,
    openMessageMenu,
    showCallStage,
    updateCallStage,
    closeSearchPanel,
    closePinsPanel,
    renderPins,
    openGroupModal,
    closeGroupModal,
  };
}
