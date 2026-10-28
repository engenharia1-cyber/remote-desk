// Main screen. It registers this computer with the broker as soon as it opens (ID + confirmation
// code) and owns consent for it: checks the code, approves every request, picks what to capture,
// and is the authority on the access level. Connecting to another computer opens view.html in a
// new tab so this ID stays reachable.
(() => {
  const $ = id => document.getElementById(id);
  const ACCESS_LABEL = { view: 'Somente ver', point: 'Ver + apontar' };
  const ACCESS_HINT = {
    view: 'A outra pessoa só vê a tela.',
    point: 'A outra pessoa vê a tela e pode apontar para mostrar onde clicar.',
  };
  // Code attempts are rate-limited (token bucket) instead of locking the computer out, so someone
  // who only knows the ID cannot block the real visitor by guessing wrong on purpose. At the
  // sustained rate a 6-digit code takes days to guess, and a hit still needs the owner's click.
  const ATTEMPT_BURST = 5;
  const ATTEMPT_REFILL_MS = 2_000;
  const FAILURE_WARN_COUNT = 10;
  const FAILURE_WINDOW_MS = 60_000;
  // Visitors must authenticate soon after connecting; idle or silent connections are dropped.
  const AUTH_TIMEOUT_MS = 10_000;
  const MAX_PENDING_AUTH = 5;
  const IDLE_TITLE = document.title;
  if (RD.framed) return;

  const conn = $('conn');
  const dialog = $('request');
  const accessSelect = $('access');
  const preview = $('preview');
  const previewWrap = $('preview-wrap');
  const pointer = $('pointer');

  let peer = null;
  let hostId = null;
  let code = null;
  let attemptTokens = ATTEMPT_BURST;
  let attemptRefilledAt = Date.now();
  let recentFailures = []; // timestamps of wrong codes inside FAILURE_WINDOW_MS
  let pendingAuth = 0;
  let request = null; // { conn, name, cancelled } while the owner decides or picks a screen
  let session = null; // { name, conn, call, stream, channel }
  let access = readStored('rd.access', v => ACCESS_LABEL[v]) ?? 'point';
  let toastTimer = 0;

  const panel = RD.createPanel(() => session?.channel ?? null);

  function readStored(key, valid) {
    try {
      const value = localStorage.getItem(key);
      return value !== null && valid(value) ? value : null;
    } catch {
      return null;
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  function setConn(state, text) {
    conn.dataset.state = state;
    conn.textContent = text;
  }

  function setIdentity(id) {
    hostId = id;
    $('host-id').textContent = id ? RD.formatId(id) : '··· ··· ···';
    for (const btn of ['copy-id', 'copy-link', 'new-code']) $(btn).disabled = !id;
  }

  function renderAccess() {
    accessSelect.value = access;
    $('access-hint').textContent = ACCESS_HINT[access];
  }

  // The confirmation code is single-use: it changes once a request is admitted, or when the
  // owner asks. Wrong guesses from outside never change it, so the visitor's code stays valid.
  function rotateCode() {
    code = RD.randomDigits(6);
    recentFailures = [];
    $('host-code').textContent = code;
    $('code-warning').hidden = true;
  }

  function takeAttempt() {
    const now = Date.now();
    const earned = Math.floor((now - attemptRefilledAt) / ATTEMPT_REFILL_MS);
    if (earned > 0) {
      attemptTokens = Math.min(ATTEMPT_BURST, attemptTokens + earned);
      attemptRefilledAt += earned * ATTEMPT_REFILL_MS;
    }
    if (attemptTokens === 0) return false;
    if (attemptTokens === ATTEMPT_BURST) attemptRefilledAt = now;
    attemptTokens--;
    return true;
  }

  function noteFailure() {
    const now = Date.now();
    recentFailures = recentFailures.filter(t => now - t < FAILURE_WINDOW_MS);
    recentFailures.push(now);
    if (recentFailures.length < FAILURE_WARN_COUNT) return;
    $('code-warning').textContent = 'Muitas tentativas com código errado no último minuto. Se não estiver esperando ninguém, gere um novo código (↻).';
    $('code-warning').hidden = false;
  }

  // ---------- broker ----------
  function newHostId() {
    return String(1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9)) + RD.randomDigits(8);
  }

  // The ID survives reloads. If it is still held (a reload racing the old registration, or this
  // site open in another tab), retry once, then fall back to a fresh ID for this tab only.
  function startPeer(id, retried = false) {
    setConn('connecting', 'Conectando…');
    const p = new Peer(RD.peerIdFor(id), { debug: 0 });
    peer = p;
    p.on('open', () => {
      if (!readStored('rd.hostId', v => /^\d{9}$/.test(v))) store('rd.hostId', id);
      setConn('online', 'Online');
      setIdentity(id);
    });
    p.on('connection', onIncoming);
    p.on('disconnected', () => {
      if (p.destroyed) return;
      // Sessions already running are peer-to-peer and keep going; only new requests wait.
      setConn('offline', 'Sem conexão. Tentando de novo…');
      setTimeout(() => {
        if (!p.destroyed && p.disconnected) p.reconnect();
      }, 3000);
    });
    p.on('error', err => {
      if (err.type === 'unavailable-id') {
        p.destroy();
        if (!retried) setTimeout(() => startPeer(id, true), 3000);
        else startPeer(newHostId(), true);
      } else if (err.type !== 'peer-unavailable') {
        setConn('offline', 'Sem conexão. Tentando de novo…');
      }
    });
  }

  function onIncoming(dataConn) {
    if (pendingAuth >= MAX_PENDING_AUTH) {
      dataConn.close();
      return;
    }
    pendingAuth++;
    let settled = false;
    const timer = setTimeout(() => settle() && dataConn.close(), AUTH_TIMEOUT_MS);
    function settle() {
      if (settled) return false;
      settled = true;
      pendingAuth--;
      clearTimeout(timer);
      return true;
    }
    const deny = reason => {
      dataConn.send(JSON.stringify({ t: 'denied', reason }));
      setTimeout(() => dataConn.close(), 500);
    };
    dataConn.on('close', settle);
    dataConn.on('open', () => {
      if (session || request) {
        settle();
        return deny('busy');
      }
      // The code and name travel only over the encrypted peer-to-peer channel, never through the
      // broker, so the broker operator never sees a usable ID + code pair.
      const onAuth = e => {
        if (typeof e.data !== 'string') return;
        dataConn.dataChannel.removeEventListener('message', onAuth);
        if (!settle()) return;
        let msg = null;
        try {
          msg = JSON.parse(e.data);
        } catch {}
        if (msg?.t !== 'auth') return deny('badcode');
        if (session || request) return deny('busy');
        if (!takeAttempt()) return deny('slow');
        if (String(msg.code ?? '') !== code) {
          noteFailure();
          return deny('badcode');
        }
        rotateCode();
        showRequest(dataConn, String(msg.name ?? '').trim().slice(0, 64) || 'Visitante');
      };
      dataConn.dataChannel.addEventListener('message', onAuth);
    });
  }

  // ---------- consent ----------
  function showRequest(dataConn, name) {
    const req = { conn: dataConn, name, cancelled: false };
    request = req;
    dataConn.on('close', () => {
      if (request === req) {
        dismissRequest();
        toast('O pedido de acesso foi cancelado.');
      }
    });
    $('req-name').textContent = name;
    $('req-access').textContent = ACCESS_LABEL[access];
    dialog.showModal();
    document.title = 'Pedido de acesso · RemoteDesk';
  }

  function dismissRequest() {
    if (!request) return;
    request.cancelled = true;
    request = null;
    if (dialog.open) dialog.close();
    if (!session) document.title = IDLE_TITLE;
  }

  function refuse(req) {
    req.conn.send(JSON.stringify({ t: 'denied', reason: 'rejected' }));
    setTimeout(() => req.conn.close(), 500);
  }

  function rejectRequest() {
    const req = request;
    if (!req) return;
    dismissRequest();
    refuse(req);
  }

  async function acceptRequest() {
    const req = request;
    if (!req) return;
    dialog.close();
    let stream;
    try {
      // Called directly from the click so the browser accepts it as a user gesture.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false });
    } catch {
      if (!req.cancelled) {
        dismissRequest();
        refuse(req);
        toast('Nenhuma tela foi escolhida, então o pedido foi recusado.');
      }
      return;
    }
    if (req.cancelled || request !== req) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    request = null;
    startSession(req, stream);
  }

  // ---------- session ----------
  function startSession(req, stream) {
    const [track] = stream.getVideoTracks();
    if ('contentHint' in track) track.contentHint = 'detail';

    const s = { name: req.name, conn: req.conn, stream, call: null, channel: null };
    s.channel = RD.createChannel(req.conn.dataChannel, {
      onClose: () => session === s && endSession('A sessão foi encerrada.'),
      onMessage: msg => session === s && onPeerMessage(msg),
      onTransfer: ev => panel.transfer(ev),
    });
    session = s;
    s.channel.send({ t: 'accepted' });
    s.channel.send({ t: 'access', level: access });
    panel.setEnabled(true);

    s.call = peer.call(req.conn.peer, stream);
    s.call.on('close', () => session === s && endSession('A sessão foi encerrada.'));
    s.call.on('error', () => session === s && endSession('A conexão com a outra pessoa falhou.'));
    s.call.peerConnection?.addEventListener('connectionstatechange', () => {
      if (session !== s) return;
      const state = s.call.peerConnection.connectionState;
      if (state === 'connected') setLive(`Compartilhando com ${s.name}`);
      else if (state === 'disconnected') setLive(`Conexão instável com ${s.name}…`);
      else if (state === 'failed') endSession('A conexão com a outra pessoa falhou.');
    });
    track.onended = () => endSession('Você parou de compartilhar a tela.');

    preview.srcObject = stream;
    $('idle').hidden = true;
    $('live').hidden = false;
    $('pointer-label').textContent = s.name;
    setLive(`Conectando com ${s.name}…`);
    document.title = '● Compartilhando · RemoteDesk';
  }

  function setLive(text) {
    $('live-text').textContent = text;
  }

  function endSession(reason) {
    const s = session;
    if (!s) return;
    session = null;
    for (const track of s.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    s.call?.close();
    s.conn.close();
    preview.srcObject = null;
    pointer.hidden = true;
    $('live').hidden = true;
    $('idle').hidden = false;
    panel.setEnabled(false);
    document.title = IDLE_TITLE;
    if (reason) toast(reason);
  }

  function onPeerMessage(msg) {
    switch (msg.t) {
      case 'chat':
        if (typeof msg.text === 'string') panel.chat(session.name, msg.text);
        break;
      case 'ptr':
        if (access === 'point') movePointer(msg.x, msg.y);
        break;
      case 'ping':
        if (access === 'point') showPing(msg.x, msg.y);
        break;
    }
  }

  // ---------- remote pointer on the local preview ----------
  function toPreview(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    const rect = RD.videoContentRect(preview);
    if (!rect) return null;
    const box = previewWrap.getBoundingClientRect();
    return { left: rect.left - box.left + x * rect.width, top: rect.top - box.top + y * rect.height };
  }

  function movePointer(x, y) {
    const p = toPreview(x, y);
    pointer.hidden = !p;
    if (!p) return;
    pointer.style.left = `${p.left}px`;
    pointer.style.top = `${p.top}px`;
  }

  function showPing(x, y) {
    const p = toPreview(x, y);
    if (!p) return;
    const ring = document.createElement('div');
    ring.className = 'ping';
    ring.style.left = `${p.left}px`;
    ring.style.top = `${p.top}px`;
    ring.addEventListener('animationend', () => ring.remove());
    previewWrap.append(ring);
  }

  // ---------- controls ----------
  accessSelect.addEventListener('change', () => {
    if (!ACCESS_LABEL[accessSelect.value]) return;
    access = accessSelect.value;
    store('rd.access', access);
    renderAccess();
    if (access !== 'point') pointer.hidden = true;
    if (session) {
      session.channel.send({ t: 'access', level: access });
      toast(`Nível de acesso: ${ACCESS_LABEL[access]}`);
    }
  });

  $('req-accept').addEventListener('click', acceptRequest);
  $('req-reject').addEventListener('click', rejectRequest);
  dialog.addEventListener('cancel', e => {
    e.preventDefault();
    rejectRequest();
  });
  $('stop').addEventListener('click', () => endSession('Sessão encerrada.'));
  $('new-code').addEventListener('click', () => {
    if (!request) rotateCode();
  });
  $('copy-id').addEventListener('click', () => copy(hostId, 'ID copiado.'));
  $('copy-link').addEventListener('click', () => copy(new URL(`view.html?id=${hostId}`, location.href).href, 'Link copiado. O código você passa separado.'));

  const remoteId = $('remote-id');
  const remoteCode = $('remote-code');
  remoteId.addEventListener('input', () => {
    remoteId.value = RD.formatId(remoteId.value.replace(/\D/g, '').slice(0, 9));
  });
  remoteCode.addEventListener('input', () => {
    remoteCode.value = remoteCode.value.replace(/\D/g, '').slice(0, 6);
  });
  $('remote-form').addEventListener('submit', e => {
    e.preventDefault();
    const id = remoteId.value.replace(/\D/g, '');
    const remote = remoteCode.value;
    const error = $('remote-error');
    if (id.length !== 9) error.textContent = 'O ID tem 9 dígitos.';
    else if (id === hostId) error.textContent = 'Esse é o ID deste computador.';
    else if (remote.length !== 6) error.textContent = 'O código tem 6 dígitos.';
    else {
      // The fragment never leaves the browser; view.js reads it and clears it from the address bar.
      error.textContent = '';
      window.open(`view.html#id=${id}&code=${remote}`, '_blank');
      remoteCode.value = '';
    }
  });

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast('Não foi possível copiar.');
    }
  }

  // ---------- start ----------
  renderAccess();
  rotateCode();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setConn('offline', 'Indisponível');
    $('idle').querySelector('p').textContent = window.isSecureContext
      ? 'Este navegador não permite compartilhar a tela. Use Chrome, Edge ou Firefox no computador.'
      : 'Para compartilhar a tela, abra este site por HTTPS.';
  } else if (typeof Peer !== 'function') {
    setConn('offline', 'Falha ao carregar');
  } else {
    startPeer(readStored('rd.hostId', v => /^\d{9}$/.test(v)) ?? newHostId());
  }
})();
