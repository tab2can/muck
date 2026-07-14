// Varsayılan: yalnızca STUN. Gerçek TURN /api/ice ile gelir (coturn).
const FALLBACK_ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
};

let iceConfig = { ...FALLBACK_ICE };
let iceLoadedAt = 0;

async function loadIceServers() {
  // 30 dk taze tut
  if (Date.now() - iceLoadedAt < 30 * 60 * 1000 && iceConfig.iceServers?.length) {
    return iceConfig;
  }
  try {
    const r = await fetch('/api/ice', { credentials: 'same-origin' });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        iceConfig = { iceServers: data.iceServers, iceCandidatePoolSize: 10 };
        iceLoadedAt = Date.now();
        if (!data.turn) {
          console.warn('[voice] TURN kapalı — farklı ağlarda ses/kamera çalışmayabilir. deploy/install-turn.sh çalıştırın.');
        }
        return iceConfig;
      }
    }
  } catch (e) {
    console.warn('[voice] /api/ice alınamadı:', e.message);
  }
  return iceConfig;
}

// Mesh P2P ses/kamera/ekran yöneticisi.
// Katılımcılar ve peer bağlantıları socketId ile anahtarlanır. Sinyalizasyon
// "perfect negotiation" kullanır. Kamera ve ekran ayrı MediaStream'ler (msid)
// ile gönderilir; stream id'leri voice-state ile paylaşılır, böylece karşı
// taraf hangi video'nun kamera hangisinin ekran olduğunu ayırt eder.
export function createVoiceManager({ socket, username, onUpdate, onSpeaking }) {
  let channelId = null;

  // Yerel akışlar (her biri ayrı msid taşır)
  const micStream = new MediaStream();
  let cameraTrack = null;
  let screenTrack = null;
  let camStream = null;    // MediaStream([cameraTrack])
  let screenStream = null; // MediaStream([screenTrack])
  let audioTrack = null;
  let muted = false;
  let deafened = false; // kulaklık kapalı: uzak sesleri duyma
  let cameraOn = false;
  let screenOn = false;

  const peers = new Map(); // socketId -> { pc, polite, makingOffer, ignoreOffer }
  const pendingIce = new Map(); // socketId -> RTCIceCandidateInit[]
  const audioEls = new Map(); // socketId -> HTMLAudioElement
  const remoteAudio = new Map(); // socketId -> MediaStream (ses oynatma)
  const remoteVideoById = new Map(); // socketId -> Map(streamId -> MediaStream)
  const participants = new Map(); // socketId -> { userId, username, muted, camera, screen, camId, screenId }

  // Konuşma algılama (VAD) — yeşil halka için
  let audioCtx = null;
  const analysers = new Map(); // key -> { analyser, source, data }
  const speakingNow = new Map(); // key -> bool
  const lastLoudAt = new Map(); // key -> timestamp
  let vadRaf = 0;
  const SPEAK_THRESHOLD = 0.025;
  const SPEAK_HOLD_MS = 280;

  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function emitSpeaking() {
    if (!onSpeaking) return;
    const flags = {};
    for (const [k, v] of speakingNow) flags[k] = v;
    onSpeaking(flags);
  }

  function setSpeaking(key, on) {
    if (speakingNow.get(key) === on) return;
    speakingNow.set(key, on);
    emitSpeaking();
  }

  function attachAnalyser(key, stream) {
    detachAnalyser(key);
    if (!stream?.getAudioTracks?.().length) return;
    try {
      const ctx = ensureAudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);
      analysers.set(key, { analyser, source, data: new Uint8Array(analyser.fftSize) });
      startVadLoop();
    } catch (e) {
      console.warn('Analyser bağlanamadı:', e.message);
    }
  }

  function detachAnalyser(key) {
    const a = analysers.get(key);
    if (a) {
      try { a.source.disconnect(); } catch {}
      analysers.delete(key);
    }
    const was = speakingNow.get(key);
    speakingNow.delete(key);
    lastLoudAt.delete(key);
    if (was) emitSpeaking();
  }

  function rmsLevel(analyser, data) {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  function startVadLoop() {
    if (vadRaf) return;
    const tick = () => {
      vadRaf = 0;
      if (!analysers.size) return;
      const now = performance.now();
      for (const [key, { analyser, data }] of analysers) {
        // Kendi mikimiz kapalıysa konuşuyor sayma
        if (key === 'self' && (muted || !audioTrack || !audioTrack.enabled)) {
          setSpeaking('self', false);
          continue;
        }
        const level = rmsLevel(analyser, data);
        if (level >= SPEAK_THRESHOLD) lastLoudAt.set(key, now);
        const recent = (lastLoudAt.get(key) || 0) + SPEAK_HOLD_MS > now;
        setSpeaking(key, recent);
      }
      vadRaf = requestAnimationFrame(tick);
    };
    vadRaf = requestAnimationFrame(tick);
  }

  function stopVad() {
    if (vadRaf) { cancelAnimationFrame(vadRaf); vadRaf = 0; }
    for (const key of [...analysers.keys()]) detachAnalyser(key);
    speakingNow.clear();
    emitSpeaking();
  }

  function applyDeafened() {
    for (const el of audioEls.values()) {
      el.muted = deafened;
      el.volume = deafened ? 0 : 1;
    }
  }

  function ensureAudioEl(socketId, stream) {
    let el = audioEls.get(socketId);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      audioEls.set(socketId, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = deafened;
    el.volume = deafened ? 0 : 1;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
    attachAnalyser(socketId, stream);
  }

  function removeAudioEl(socketId) {
    detachAnalyser(socketId);
    const el = audioEls.get(socketId);
    if (el) { try { el.srcObject = null; el.remove(); } catch {} }
    audioEls.delete(socketId);
  }

  // Uzak video akışlarını bul (camId eşleşmezse sıraya göre yedek).
  function remoteVideosOf(socketId) {
    const byId = remoteVideoById.get(socketId);
    return byId ? [...byId.values()] : [];
  }
  function pickCameraStream(socketId, camId) {
    const byId = remoteVideoById.get(socketId);
    if (!byId) return null;
    if (camId && byId.has(camId)) return byId.get(camId);
    // Canlı video track'i olan ilk akış
    for (const ms of byId.values()) {
      if (ms.getVideoTracks().some((t) => t.readyState === 'live')) return ms;
    }
    return remoteVideosOf(socketId)[0] || null;
  }
  function pickScreenStream(socketId, screenId, camId) {
    const byId = remoteVideoById.get(socketId);
    if (!byId) return null;
    if (screenId && byId.has(screenId)) return byId.get(screenId);
    const all = remoteVideosOf(socketId);
    if (camId && byId.has(camId)) {
      return all.find((ms) => ms.id !== camId) || (all.length >= 2 ? all[1] : null);
    }
    if (all.length >= 2) return all[1];
    if (all.length === 1 && !camId) return all[0];
    return null;
  }

  function emit() {
    const remote = [...participants.entries()].map(([sid, p]) => ({
      socketId: sid,
      userId: p.userId,
      username: p.username,
      muted: p.muted,
      camera: p.camera,
      screen: p.screen,
      cameraStream: p.camera ? pickCameraStream(sid, p.camId) : null,
      screenStream: p.screen ? pickScreenStream(sid, p.screenId, p.camId) : null,
    }));
    onUpdate({
      local: {
        muted, deafened, cameraOn, screenOn,
        cameraStream: cameraOn ? camStream : null,
        screenStream: screenOn ? screenStream : null,
      },
      remote,
    });
  }

  function broadcastState() {
    socket.emit('voice-state', {
      muted, deafened, camera: cameraOn, screen: screenOn,
      camId: camStream?.id || null,
      screenId: screenStream?.id || null,
    });
  }

  async function ensureMic() {
    if (audioTrack) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioTrack = s.getAudioTracks()[0];
      if (audioTrack) {
        micStream.addTrack(audioTrack);
        attachAnalyser('self', micStream);
      }
    } catch (e) {
      audioTrack = null;
      console.warn('Mikrofon alınamadı, dinleme modunda:', e.message);
    }
  }

  function createPeer(socketId, polite) {
    const state = { pc: new RTCPeerConnection(iceConfig), polite, makingOffer: false, ignoreOffer: false };
    const { pc } = state;

    // Mevcut yerel track'leri uygun stream (msid) ile ekle.
    micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
    if (cameraTrack && camStream) pc.addTrack(cameraTrack, camStream);
    if (screenTrack && screenStream) pc.addTrack(screenTrack, screenStream);

    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('voice-offer', { targetId: socketId, offer: pc.localDescription });
      } catch (err) {
        console.warn('negotiationneeded hatası:', err.message);
      } finally {
        state.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('voice-ice', { targetId: socketId, candidate });
    };

    pc.ontrack = ({ track, streams }) => {
      track.enabled = true;
      if (track.kind === 'audio') {
        let a = remoteAudio.get(socketId);
        if (!a) { a = new MediaStream(); remoteAudio.set(socketId, a); }
        if (!a.getTracks().includes(track)) a.addTrack(track);
        ensureAudioEl(socketId, a);
      } else {
        const streamId = streams?.[0]?.id || `v-${track.id}`;
        let byId = remoteVideoById.get(socketId);
        if (!byId) { byId = new Map(); remoteVideoById.set(socketId, byId); }
        let ms = byId.get(streamId);
        if (!ms) { ms = streams?.[0] || new MediaStream(); byId.set(streamId, ms); }
        if (!ms.getTracks().includes(track)) ms.addTrack(track);
        track.onended = () => { try { ms.removeTrack(track); } catch {} emit(); };
        track.onmute = () => emit();
        track.onunmute = () => emit();
      }
      emit();
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log(`[voice] peer ${socketId} connection:`, s);
      if (s === 'failed') {
        try { pc.restartIce(); } catch {}
      } else if (s === 'closed') {
        removePeer(socketId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[voice] peer ${socketId} ice:`, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch {}
      }
    };

    peers.set(socketId, state);
    return state;
  }

  function removePeer(socketId) {
    const st = peers.get(socketId);
    if (st) { try { st.pc.close(); } catch {} }
    peers.delete(socketId);
    pendingIce.delete(socketId);
    remoteAudio.delete(socketId);
    remoteVideoById.delete(socketId);
    removeAudioEl(socketId);
    participants.delete(socketId);
    emit();
  }

  async function flushIce(socketId) {
    const st = peers.get(socketId);
    const queue = pendingIce.get(socketId);
    if (!st || !queue?.length) return;
    pendingIce.delete(socketId);
    for (const candidate of queue) {
      try { await st.pc.addIceCandidate(candidate); }
      catch (err) { console.warn('ICE kuyruk hatası:', err.message); }
    }
  }

  async function onDescription(socketId, userId, uname, description) {
    if (!participants.has(socketId)) {
      participants.set(socketId, {
        userId, username: uname, muted: false, deafened: false,
        camera: false, screen: false, camId: null, screenId: null,
      });
    }
    await loadIceServers();
    let st = peers.get(socketId);
    if (!st) st = createPeer(socketId, true);
    const { pc } = st;
    try {
      const offerCollision = description.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
      st.ignoreOffer = !st.polite && offerCollision;
      if (st.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      await flushIce(socketId);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('voice-answer', { targetId: socketId, answer: pc.localDescription });
      }
      emit();
    } catch (err) {
      console.warn('Sinyalizasyon hatası:', err.message);
    }
  }

  async function onIce(socketId, candidate) {
    const st = peers.get(socketId);
    if (!st) return;
    if (!st.pc.remoteDescription) {
      let q = pendingIce.get(socketId);
      if (!q) { q = []; pendingIce.set(socketId, q); }
      q.push(candidate);
      return;
    }
    try { await st.pc.addIceCandidate(candidate); }
    catch (err) { if (!st.ignoreOffer) console.warn('ICE eklenemedi:', err.message); }
  }

  function addTrackToPeers(track, stream) {
    for (const { pc } of peers.values()) pc.addTrack(track, stream);
  }
  function removeTrackFromPeers(track) {
    for (const { pc } of peers.values()) {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) pc.removeTrack(sender);
    }
  }

  return {
    getChannelId: () => channelId,
    isMuted: () => muted,
    isDeafened: () => deafened,
    isCameraOn: () => cameraOn,
    isScreenOn: () => screenOn,
    getCameraStream: () => camStream,
    getScreenStream: () => screenStream,

    async join(chId, existing) {
      channelId = chId;
      muted = false; deafened = false; cameraOn = false; screenOn = false;
      await loadIceServers();
      await ensureMic();
      for (const p of existing) {
        participants.set(p.socketId, {
          userId: p.userId, username: p.username,
          muted: !!p.muted, deafened: !!p.deafened,
          camera: !!p.camera, screen: !!p.screen,
          camId: p.camId || null, screenId: p.screenId || null,
        });
        createPeer(p.socketId, false);
      }
      emit();
    },

    onPeerJoined(socketId, userId, uname) {
      if (!participants.has(socketId)) {
        participants.set(socketId, {
          userId, username: uname, muted: false, deafened: false,
          camera: false, screen: false, camId: null, screenId: null,
        });
      }
      emit();
    },

    onPeerLeft(socketId) { removePeer(socketId); },

    onPresence(list) {
      for (const p of list) {
        if (p.socketId === socket.id) continue;
        const cur = participants.get(p.socketId);
        if (cur) {
          cur.muted = p.muted;
          cur.deafened = !!p.deafened;
          cur.camera = p.camera; cur.screen = p.screen;
          cur.camId = p.camId || null; cur.screenId = p.screenId || null;
        }
      }
      emit();
    },

    onDescription, onIce,

    toggleMic() {
      muted = !muted;
      if (audioTrack) audioTrack.enabled = !muted;
      if (muted) setSpeaking('self', false);
      broadcastState();
      emit();
    },

    toggleDeafen() {
      deafened = !deafened;
      applyDeafened();
      broadcastState();
      emit();
    },

    async toggleCamera() {
      if (cameraOn) {
        if (cameraTrack) { removeTrackFromPeers(cameraTrack); cameraTrack.stop(); }
        cameraTrack = null; camStream = null; cameraOn = false;
      } else {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          cameraTrack = s.getVideoTracks()[0];
          camStream = new MediaStream([cameraTrack]);
          addTrackToPeers(cameraTrack, camStream);
          cameraTrack.onended = () => { if (cameraOn) this.toggleCamera(); };
          cameraOn = true;
        } catch (err) { console.warn('Kamera açılamadı:', err.message); return; }
      }
      broadcastState();
      emit();
    },

    async toggleScreen() {
      if (screenOn) {
        if (screenTrack) { removeTrackFromPeers(screenTrack); screenTrack.stop(); }
        screenTrack = null; screenStream = null; screenOn = false;
      } else {
        try {
          const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          screenTrack = s.getVideoTracks()[0];
          screenStream = new MediaStream([screenTrack]);
          addTrackToPeers(screenTrack, screenStream);
          screenTrack.onended = () => { if (screenOn) this.toggleScreen(); };
          screenOn = true;
        } catch (err) { if (err.name !== 'NotAllowedError') console.warn('Ekran paylaşılamadı:', err.message); return; }
      }
      broadcastState();
      emit();
    },

    leave() {
      stopVad();
      for (const sid of [...peers.keys()]) removePeer(sid);
      for (const sid of [...audioEls.keys()]) removeAudioEl(sid);
      [audioTrack, cameraTrack, screenTrack].forEach((t) => { try { t?.stop(); } catch {} });
      micStream.getTracks().forEach((t) => { try { micStream.removeTrack(t); } catch {} });
      audioTrack = cameraTrack = screenTrack = null;
      camStream = screenStream = null;
      cameraOn = screenOn = false; muted = false; deafened = false;
      channelId = null;
      socket.emit('leave-voice');
    },
  };
}
