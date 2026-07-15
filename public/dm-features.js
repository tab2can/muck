/**
 * DM toolbar: search (right panel), pins, group, profile, call, emoji, reactions, msg menu.
 */
const EMOJIS = ['😀','😂','🥲','😍','😘','😎','🤔','😢','😡','👍','👎','❤️','🔥','🎉','💯','👀','🙏','🤡','💀','✨','⭐','💬','✅','❌','👋','🤝','💪','🫶','😴','🤝'];

export function initDmFeatures(api) {
  const {
    $, toast, escapeHtml, initials, formatTime, userChipHtml,
    getSocket, getState, setState, openGroupChannel,
    startDmCall, endDmCall, toggleDmMic, toggleDmCam, toggleDmScreen,
    updatePanel, markReply,
  } = api;

  let groupSelected = new Set();
  let searchTimer = null;
  let panelMode = null; // null | 'search' | 'pins'
  let emojiTarget = null; // null | { mode:'insert' } | { mode:'react', messageId, channelId }
  let replyDraft = null;

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

  function formatDateTime(ts) {
    try {
      return new Date(ts).toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  }

  function syncProfileBtn() {
    const btn = $('dm-btn-profile');
    const open = !!st().dmProfileOpen && panelMode == null;
    btn?.classList.toggle('active', open);
    if (btn) btn.title = open ? 'Kullanıcı Profilini Gizle' : 'Kullanıcı Profilini Göster';
  }

  function setProfileOpen(open) {
    panelMode = null;
    setState({ dmProfileOpen: !!open, dmPanelMode: null });
    try { localStorage.setItem('muck_dm_profile', open ? 'on' : 'off'); } catch {}
    syncProfileBtn();
    updatePanel?.();
  }

  function showRightPanelMode(mode) {
    panelMode = mode;
    setState({ dmPanelMode: mode, dmProfileOpen: true });
    syncProfileBtn();
    updatePanel?.();
  }

  function closeSearchPanel() {
    if (panelMode === 'search') {
      panelMode = null;
      setState({ dmPanelMode: null });
      updatePanel?.();
    }
    if ($('dm-search-results')) $('dm-search-results').innerHTML = '';
    syncProfileBtn();
  }

  function closePinsPanel() {
    if (panelMode === 'pins') {
      panelMode = null;
      setState({ dmPanelMode: null });
      updatePanel?.();
    }
    syncProfileBtn();
  }

  function renderSearchResults(results, query) {
    const box = $('dm-search-results');
    const count = $('dm-search-count');
    const ctx = $('dm-search-context');
    const state = st();
    if (!box) return;
    box.innerHTML = '';
    if (count) count.textContent = `${results.length} Sonuç`;
    if (ctx) {
      ctx.textContent = state.activeGroupId
        ? (state.activeGroupTitle || 'Grup')
        : `@ ${state.activeDmFriendName || ''}`;
    }
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
        const el = document.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.classList.add('msg-flash');
        setTimeout(() => el?.classList.remove('msg-flash'), 1200);
      });
      box.appendChild(btn);
    }
    showRightPanelMode('search');
  }

  function runSearch(q) {
    const channelId = st().activeDmChannelId;
    if (!channelId || !q.trim()) {
      closeSearchPanel();
      return;
    }
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
    showRightPanelMode('pins');
  }

  function openPins() {
    const channelId = st().activeDmChannelId;
    if (!channelId) return;
    if (panelMode === 'pins') { closePinsPanel(); return; }
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

  /* ---- Emoji panel ---- */
  function buildEmojiPanel() {
    const panel = $('dm-emoji-panel');
    if (!panel || panel.dataset.ready) return;
    panel.innerHTML = EMOJIS.map((e) =>
      `<button type="button" class="emoji-cell" data-emoji="${e}">${e}</button>`
    ).join('');
    panel.dataset.ready = '1';
    panel.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-emoji]');
      if (!cell) return;
      const emoji = cell.dataset.emoji;
      if (emojiTarget?.mode === 'react') {
        getSocket()?.emit('react-dm-message', {
          channelId: emojiTarget.channelId,
          messageId: emojiTarget.messageId,
          emoji,
        });
      } else {
        const input = $('dm-input');
        if (input) {
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? input.value.length;
          input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
          input.focus();
          const pos = start + emoji.length;
          input.setSelectionRange(pos, pos);
        }
      }
      hideEmojiPanel();
    });
  }

  function showEmojiPanel(target, anchorEl) {
    buildEmojiPanel();
    emojiTarget = target;
    const panel = $('dm-emoji-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.left = `${Math.min(r.left, window.innerWidth - 280)}px`;
      panel.style.bottom = `${window.innerHeight - r.top + 8}px`;
      panel.style.top = 'auto';
    } else {
      panel.style.position = 'absolute';
      panel.style.left = '';
      panel.style.bottom = '56px';
      panel.style.right = '12px';
      panel.style.top = 'auto';
    }
  }

  function hideEmojiPanel() {
    $('dm-emoji-panel')?.classList.add('hidden');
    emojiTarget = null;
  }

  /* ---- Message context menu ---- */
  function openMessageMenu(x, y, msg, channelId) {
    const menu = $('ctx-menu');
    if (!menu || !msg) return;
    api.closeCtxMenu?.();
    const add = (opts) => menu.appendChild(api.ctxItem(opts));
    const sep = () => menu.appendChild(api.ctxSep());
    const state = st();

    add({
      label: 'Tepki Ekle',
      onClick: () => {
        api.closeCtxMenu?.();
        showEmojiPanel({ mode: 'react', messageId: msg.id, channelId }, null);
        const panel = $('dm-emoji-panel');
        if (panel) {
          panel.style.position = 'fixed';
          panel.style.left = `${Math.min(x, window.innerWidth - 280)}px`;
          panel.style.top = `${Math.min(y, window.innerHeight - 220)}px`;
          panel.style.bottom = 'auto';
        }
      },
    });
    sep();
    add({
      label: 'Yanıtla',
      onClick: () => {
        api.closeCtxMenu?.();
        replyDraft = {
          id: msg.id,
          fromId: msg.fromId,
          text: msg.text,
          username: msg.username || msg.author || '—',
        };
        markReply?.(replyDraft);
        $('dm-reply-bar')?.classList.remove('hidden');
        if ($('dm-reply-text')) $('dm-reply-text').textContent = replyDraft.text;
        $('dm-input')?.focus();
      },
    });
    add({
      label: 'İlet',
      onClick: () => {
        api.closeCtxMenu?.();
        const friends = state.friends || [];
        if (!friends.length) { toast('İletecek arkadaş yok'); return; }
        const opts = friends.map((f) =>
          `<option value="${escapeHtml(f.id)}">${escapeHtml(f.username)}</option>`
        ).join('');
        api.showModal?.('İlet',
          `<p>Mesajı kime iletsin?</p><select class="modal-input" id="forward-friend">${opts}</select>`,
          [
            { label: 'İptal', className: 'btn-secondary', onClick: api.closeModal },
            {
              label: 'İlet', className: 'btn-primary', onClick: () => {
                const fid = $('forward-friend')?.value;
                api.closeModal?.();
                if (!fid) return;
                getSocket()?.emit('send-dm', {
                  friendId: fid,
                  text: msg.text,
                }, (res) => {
                  if (res?.error) toast(res.error);
                  else toast('Mesaj iletildi');
                });
              },
            },
          ]);
      },
    });
    sep();
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
    if (state.activeDmFriendId && !state.activeGroupId) {
      add({
        label: 'Okunmadı Olarak İşaretle',
        onClick: () => {
          api.closeCtxMenu?.();
          getSocket()?.emit('dm-unread', { friendId: state.activeDmFriendId }, (res) => {
            if (res?.error) toast(res.error);
            else toast('Okunmadı olarak işaretlendi');
          });
        },
      });
    }
    add({
      label: 'Mesaj Bağlantısını Kopyala',
      onClick: async () => {
        api.closeCtxMenu?.();
        const url = `${location.origin}/channels/@me/${channelId}?msg=${msg.id}`;
        try { await navigator.clipboard.writeText(url); toast('Bağlantı kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    });
    sep();
    add({
      label: 'Mesaj Bildir',
      danger: true,
      onClick: () => {
        api.closeCtxMenu?.();
        toast('Mesaj bildirildi. Teşekkürler.');
      },
    });
    if (state.settings?.developer) {
      sep();
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

  function clearReply() {
    replyDraft = null;
    markReply?.(null);
    $('dm-reply-bar')?.classList.add('hidden');
  }

  function getReplyDraft() { return replyDraft; }

  /* ---- Call UI ---- */
  function showCallStage(visible) {
    $('dm-call-stage')?.classList.toggle('hidden', !visible);
  }

  function updateCallStage(name) {
    $('dm-call-name').textContent = name || '—';
    $('dm-call-avatar').textContent = initials(name);
  }

  /* ---- Wire DOM ---- */
  $('dm-btn-profile')?.addEventListener('click', () => {
    if (panelMode) {
      panelMode = null;
      setState({ dmPanelMode: null, dmProfileOpen: true });
      updatePanel?.();
      syncProfileBtn();
      return;
    }
    setProfileOpen(!st().dmProfileOpen);
  });
  $('dm-btn-pins')?.addEventListener('click', openPins);
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
  $('dm-emoji-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!$('dm-emoji-panel')?.classList.contains('hidden') && emojiTarget?.mode === 'insert') {
      hideEmojiPanel();
      return;
    }
    showEmojiPanel({ mode: 'insert' }, e.currentTarget);
  });
  $('dm-reply-cancel')?.addEventListener('click', clearReply);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#dm-emoji-panel') && !e.target.closest('#dm-emoji-btn')) {
      hideEmojiPanel();
    }
  });

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
    getReplyDraft,
    clearReply,
    showEmojiPanel,
    hideEmojiPanel,
    getPanelMode: () => panelMode,
  };
}
