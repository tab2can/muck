/**
 * Shared chat toolbar for DM + server text channels:
 * search, pins, emoji, reactions, reply, message menu.
 */
const EMOJIS = ['😀','😂','🥲','😍','😘','😎','🤔','😢','😡','👍','👎','❤️','🔥','🎉','💯','👀','🙏','🤡','💀','✨','⭐','💬','✅','❌','👋','🤝','💪','🫶','😴'];

export function initChatFeatures(api) {
  const {
    $, toast, escapeHtml, initials, formatTime, userChipHtml,
    getSocket, getState, setState, openGroupChannel,
    startDmCall, endDmCall, toggleDmMic, toggleDmDeafen, toggleDmCam, toggleDmScreen,
    updatePanel, markReply, jumpToMessage, prependOlderForJump,
  } = api;

  let groupSelected = new Set();
  let searchTimer = null;
  let panelMode = null; // null | 'search' | 'pins'
  let emojiTarget = null;
  let replyDraft = null;

  function st() { return getState(); }
  function kind() {
    return st().activeView === 'chat' ? 'channel' : 'dm';
  }
  function activeChannelId() {
    return kind() === 'channel' ? st().activeChannelId : st().activeDmChannelId;
  }
  function messagesContainerId() {
    return kind() === 'channel' ? 'chat-messages' : 'dm-messages';
  }
  function searchEvent() {
    return kind() === 'channel' ? 'search-channel' : 'search-dm';
  }
  function pinEvent() {
    return kind() === 'channel' ? 'pin-channel-message' : 'pin-dm-message';
  }
  function getPinsEvent() {
    return kind() === 'channel' ? 'get-channel-pins' : 'get-dm-pins';
  }
  function reactEvent() {
    return kind() === 'channel' ? 'react-channel-message' : 'react-dm-message';
  }
  function inputId() {
    return kind() === 'channel' ? 'chat-input' : 'dm-input';
  }
  function replyBarId() {
    return kind() === 'channel' ? 'chat-reply-bar' : 'dm-reply-bar';
  }
  function replyTextId() {
    return kind() === 'channel' ? 'chat-reply-text' : 'dm-reply-text';
  }
  function emojiPanelId() {
    return 'chat-emoji-panel';
  }
  function searchResultsId() {
    return 'chat-search-results';
  }
  function pinsResultsId() {
    return 'chat-pins-results';
  }

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
    const open = !!st().dmProfileOpen && panelMode == null && kind() === 'dm';
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
    if ($(searchResultsId())) $(searchResultsId()).innerHTML = '';
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

  async function jumpAndFlash(msgId, ts) {
    const container = $(messagesContainerId());
    let el = container?.querySelector(`[data-msg-id="${CSS.escape(String(msgId))}"]`);
    if (!el && prependOlderForJump) {
      el = await prependOlderForJump(kind(), msgId, ts);
    }
    if (!el) {
      toast('Mesaj henüz yüklenemedi.');
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-flash');
    setTimeout(() => el.classList.remove('msg-flash'), 1200);
    jumpToMessage?.(msgId);
  }

  function renderSearchResults(results, query) {
    const box = $(searchResultsId());
    const count = $('chat-search-count');
    const ctx = $('chat-search-context');
    const state = st();
    if (!box) return;
    box.innerHTML = '';
    if (count) count.textContent = `${results.length} Sonuç`;
    if (ctx) {
      if (kind() === 'channel') ctx.textContent = state.chatTitle || '# kanal';
      else {
        ctx.textContent = state.activeGroupId
          ? (state.activeGroupTitle || 'Grup')
          : `@ ${state.activeDmFriendName || ''}`;
      }
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
      btn.addEventListener('click', () => jumpAndFlash(m.id, m.ts));
      box.appendChild(btn);
    }
    showRightPanelMode('search');
  }

  function runSearch(q) {
    const channelId = activeChannelId();
    if (!channelId || !q.trim()) {
      closeSearchPanel();
      return;
    }
    getSocket()?.emit(searchEvent(), { channelId, query: q }, (res) => {
      if (res?.error) { toast(res.error); return; }
      renderSearchResults(res.results || res.messages || [], q);
    });
  }

  function renderPins(pins) {
    const box = $(pinsResultsId());
    if (!box) return;
    box.innerHTML = '';
    if (!pins?.length) {
      box.innerHTML = '<p class="friends-empty-hint">Sabitlenmiş mesaj yok.</p>';
    } else {
      for (const p of pins) {
        const mid = p.messageId || p.id;
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
        btn.addEventListener('click', () => jumpAndFlash(mid, p.ts));
        box.appendChild(btn);
      }
    }
    showRightPanelMode('pins');
  }

  function openPins() {
    const channelId = activeChannelId();
    if (!channelId) return;
    if (panelMode === 'pins') { closePinsPanel(); return; }
    getSocket()?.emit(getPinsEvent(), { channelId }, (res) => {
      if (res?.error) { toast(res.error); return; }
      setState({ dmPins: res.pins || [] });
      renderPins(res.pins || []);
    });
  }

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

  function buildEmojiPanel() {
    const panel = $(emojiPanelId());
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
        getSocket()?.emit(reactEvent(), {
          channelId: emojiTarget.channelId,
          messageId: emojiTarget.messageId,
          emoji,
        });
      } else {
        const input = $(inputId());
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
    const panel = $(emojiPanelId());
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
    $(emojiPanelId())?.classList.add('hidden');
    emojiTarget = null;
  }

  function isPinned(msgId) {
    return (st().dmPins || []).some((p) => String(p.messageId || p.id) === String(msgId));
  }

  function openMessageMenu(x, y, msg, channelId) {
    const menu = $('ctx-menu');
    if (!menu || !msg) return;
    api.closeCtxMenu?.();
    const add = (opts) => menu.appendChild(api.ctxItem(opts));
    const sep = () => menu.appendChild(api.ctxSep());
    const state = st();
    const chId = channelId || activeChannelId();
    const pinned = isPinned(msg.id);

    add({
      label: 'Tepki Ekle',
      onClick: () => {
        api.closeCtxMenu?.();
        showEmojiPanel({ mode: 'react', messageId: msg.id, channelId: chId }, null);
        const panel = $(emojiPanelId());
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
        startReply(msg);
      },
    });
    if (kind() === 'dm') {
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
                  getSocket()?.emit('send-dm', { friendId: fid, text: msg.text }, (res) => {
                    if (res?.error) toast(res.error);
                    else toast('Mesaj iletildi');
                  });
                },
              },
            ]);
        },
      });
    }
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
      label: pinned ? 'Sabiti Kaldır' : 'Mesajı Sabitle',
      onClick: () => {
        api.closeCtxMenu?.();
        getSocket()?.emit(pinEvent(), { channelId: chId, messageId: msg.id, pinned: !pinned }, (res) => {
          if (res?.error) toast(res.error);
          else {
            toast(pinned ? 'Sabit kaldırıldı' : 'Mesaj sabitlendi');
            setState({ dmPins: res.pins || [] });
            if (panelMode === 'pins') renderPins(res.pins || []);
          }
        });
      },
    });
    if (kind() === 'dm' && state.activeDmFriendId && !state.activeGroupId) {
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
        const url = kind() === 'channel' && state.activeServer
          ? `${location.origin}/channels/${state.activeServer.id}/${chId}?msg=${msg.id}`
          : `${location.origin}/channels/@me/${chId}?msg=${msg.id}`;
        try { await navigator.clipboard.writeText(url); toast('Bağlantı kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    });
    const myId = String(state.currentUserId || '');
    if (myId && String(msg.fromId || msg.userId || '') === myId) {
      sep();
      add({
        label: 'Mesajı Düzenle',
        onClick: () => {
          api.closeCtxMenu?.();
          api.startEditMessage?.(msg.id);
        },
      });
      add({
        label: 'Mesajı Sil',
        danger: true,
        onClick: () => {
          api.closeCtxMenu?.();
          api.deleteMessage?.(msg.id);
        },
      });
    }
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

  function startReply(msg) {
    replyDraft = {
      id: msg.id,
      fromId: msg.fromId || msg.userId,
      text: msg.text,
      username: msg.username || msg.author || '—',
    };
    markReply?.(replyDraft);
    $(replyBarId())?.classList.remove('hidden');
    if ($(replyTextId())) $(replyTextId()).textContent = replyDraft.text;
    $(inputId())?.focus();
  }

  function clearReply() {
    replyDraft = null;
    markReply?.(null);
    $('dm-reply-bar')?.classList.add('hidden');
    $('chat-reply-bar')?.classList.add('hidden');
  }

  function getReplyDraft() { return replyDraft; }

  function showCallStage(visible) {
    $('dm-call-stage')?.classList.toggle('hidden', !visible);
    if (!visible) {
      $('dm-call-stage')?.classList.remove('ringing', 'incoming');
      $('dm-call-banner')?.classList.add('hidden');
      $('dm-call-incoming-actions')?.classList.add('hidden');
    }
  }

  function updateCallStage(name) {
    const n = name || '—';
    if ($('dm-call-name')) $('dm-call-name').textContent = n;
    if ($('dm-call-avatar')) $('dm-call-avatar').textContent = initials(n);
  }

  function setCallRinging(ringing, statusText) {
    const stage = $('dm-call-stage');
    const banner = $('dm-call-banner');
    stage?.classList.toggle('ringing', !!ringing);
    banner?.classList.toggle('hidden', !ringing && !statusText);
    if (statusText && $('dm-call-status')) $('dm-call-status').textContent = statusText;
    if (!ringing && !statusText) banner?.classList.add('hidden');
    if (!ringing && statusText) {
      banner?.classList.remove('hidden');
      clearTimeout(setCallRinging._t);
      setCallRinging._t = setTimeout(() => banner?.classList.add('hidden'), 1800);
    }
  }

  function wireSearchAndPins(prefix) {
    $(`${prefix}-btn-pins`)?.addEventListener('click', openPins);
    $(`${prefix}-pins-close`)?.addEventListener('click', closePinsPanel);
    $(`${prefix}-search-close`)?.addEventListener('click', () => {
      closeSearchPanel();
      if ($(`${prefix}-search-input`)) $(`${prefix}-search-input`).value = '';
      if ($('chat-search-input') && prefix === 'dm') {
        /* no-op */
      }
    });
  }

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
  $('chat-btn-pins')?.addEventListener('click', openPins);
  $('chat-pins-close')?.addEventListener('click', closePinsPanel);
  $('dm-pins-close')?.addEventListener('click', closePinsPanel);
  $('dm-search-close')?.addEventListener('click', () => {
    closeSearchPanel();
    if ($('dm-search-input')) $('dm-search-input').value = '';
    if ($('chat-search-input')) $('chat-search-input').value = '';
  });
  $('chat-search-close')?.addEventListener('click', () => {
    closeSearchPanel();
    if ($('chat-search-input')) $('chat-search-input').value = '';
    if ($('dm-search-input')) $('dm-search-input').value = '';
  });
  const onSearchInput = (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => runSearch(q), 220);
  };
  $('dm-search-input')?.addEventListener('input', onSearchInput);
  $('chat-search-input')?.addEventListener('input', onSearchInput);
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
  $('dm-call-deafen')?.addEventListener('click', () => toggleDmDeafen?.());
  $('dm-call-cam')?.addEventListener('click', () => toggleDmCam?.());
  $('dm-call-screen')?.addEventListener('click', () => toggleDmScreen?.());

  function onEmojiBtn(e) {
    e.stopPropagation();
    if (!$(emojiPanelId())?.classList.contains('hidden') && emojiTarget?.mode === 'insert') {
      hideEmojiPanel();
      return;
    }
    showEmojiPanel({ mode: 'insert' }, e.currentTarget);
  }
  $('dm-emoji-btn')?.addEventListener('click', onEmojiBtn);
  $('chat-emoji-btn')?.addEventListener('click', onEmojiBtn);
  $('dm-reply-cancel')?.addEventListener('click', clearReply);
  $('chat-reply-cancel')?.addEventListener('click', clearReply);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#chat-emoji-panel') && !e.target.closest('#dm-emoji-btn') && !e.target.closest('#chat-emoji-btn')) {
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
    setCallRinging,
    closeSearchPanel,
    closePinsPanel,
    renderPins,
    openGroupModal,
    closeGroupModal,
    getReplyDraft,
    startReply,
    clearReply,
    showEmojiPanel,
    hideEmojiPanel,
    getPanelMode: () => panelMode,
    runSearch,
    openPins,
  };
}

/** Geri uyumluluk */
export function initDmFeatures(api) {
  return initChatFeatures(api);
}
