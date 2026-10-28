// Shared by index.html (this computer) and view.html (the remote viewer): the data channel
// protocol, broker peer ids and small UI helpers. Signaling goes through the public PeerJS
// broker, so the site is fully static; screen, chat and files go peer-to-peer over WebRTC.
window.RD = (() => {
  // Refuse to run inside a frame: another site could overlay the page and trick the owner into
  // accepting a request or picking a screen. GitHub Pages cannot send frame-ancestors, so the
  // page enforces it itself; the 'framed' class hides everything (see style.css).
  const framed = window.top !== window.self;
  if (framed) document.documentElement.classList.add('framed');

  const CHUNK = 16 * 1024;
  const HIGH_WATER = 4 * 1024 * 1024;
  const MAX_FILE = 512 * 1024 * 1024;
  const PEER_PREFIX = 'remotedesk-';

  // Broker id for a 9-digit RemoteDesk ID; the prefix keeps us out of other apps' id space.
  function peerIdFor(id) {
    return PEER_PREFIX + id;
  }

  function randomDigits(count) {
    const values = crypto.getRandomValues(new Uint32Array(count));
    return Array.from(values, v => v % 10).join('');
  }

  // Data channel protocol: JSON text messages ({t: ...}) plus binary chunks belonging to the
  // file announced by the latest 'file-start'. The channel is ordered and reliable. Listeners
  // are added (not assigned) because PeerJS keeps its own handlers on the same channel.
  function createChannel(dc, { onClose, onMessage, onTransfer }) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1024 * 1024;
    let incoming = null;
    let sendQueue = Promise.resolve();

    dc.addEventListener('close', () => {
      if (incoming) onTransfer({ ...incoming.meta, dir: 'in', status: 'failed' });
      incoming = null;
      onClose?.();
    });

    dc.addEventListener('message', e => {
      if (typeof e.data !== 'string') {
        if (!incoming) return;
        incoming.chunks.push(e.data);
        incoming.received += e.data.byteLength;
        if (incoming.received > incoming.meta.size) {
          onTransfer({ ...incoming.meta, dir: 'in', status: 'failed' });
          incoming = null;
          return;
        }
        onTransfer({ ...incoming.meta, dir: 'in', status: 'progress', done: incoming.received });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'file-start') {
        const size = Number(msg.size);
        if (typeof msg.id !== 'string' || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) return;
        const meta = { id: msg.id, name: String(msg.name ?? 'arquivo').slice(0, 200), size };
        incoming = { meta, chunks: [], received: 0 };
        onTransfer({ ...meta, dir: 'in', status: 'progress', done: 0 });
      } else if (msg.t === 'file-end') {
        if (!incoming || incoming.meta.id !== msg.id) return;
        const { meta, chunks, received } = incoming;
        incoming = null;
        if (received !== meta.size) return onTransfer({ ...meta, dir: 'in', status: 'failed' });
        // A generic binary type makes the browser download the file instead of rendering it
        // (e.g. a received .html or .svg) inside this site's origin.
        const blob = new Blob(chunks, { type: 'application/octet-stream' });
        onTransfer({ ...meta, dir: 'in', status: 'done', done: received, blob });
      } else {
        onMessage(msg);
      }
    });

    function waitDrain() {
      if (dc.bufferedAmount <= HIGH_WATER) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          dc.removeEventListener('close', fail);
          resolve();
        };
        const fail = () => {
          dc.removeEventListener('bufferedamountlow', done);
          reject(new Error('channel closed'));
        };
        dc.addEventListener('bufferedamountlow', done);
        dc.addEventListener('close', fail, { once: true });
      });
    }

    async function transmit(file, meta) {
      dc.send(JSON.stringify({ t: 'file-start', ...meta }));
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        await waitDrain();
        dc.send(await file.slice(offset, offset + CHUNK).arrayBuffer());
        onTransfer({ ...meta, dir: 'out', status: 'progress', done: Math.min(offset + CHUNK, file.size) });
      }
      dc.send(JSON.stringify({ t: 'file-end', id: meta.id }));
      onTransfer({ ...meta, dir: 'out', status: 'done', done: file.size });
    }

    return {
      send(msg) {
        if (dc.readyState === 'open') dc.send(JSON.stringify(msg));
      },
      sendFile(file) {
        const meta = { id: crypto.randomUUID(), name: file.name, size: file.size };
        if (file.size > MAX_FILE) {
          onTransfer({ ...meta, dir: 'out', status: 'failed', reason: 'muito grande (máx. 512 MB)' });
          return;
        }
        onTransfer({ ...meta, dir: 'out', status: 'queued', done: 0 });
        sendQueue = sendQueue
          .then(() => transmit(file, meta))
          .catch(() => onTransfer({ ...meta, dir: 'out', status: 'failed' }));
      },
    };
  }

  // The area a <video> actually paints inside its box when object-fit is 'contain'.
  function videoContentRect(video) {
    const box = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(box.width / vw, box.height / vh);
    const width = vw * scale;
    const height = vh * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  }

  function formatId(id) {
    return String(id).replace(/(\d{3})(?=\d)/g, '$1 ');
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function appendChat(list, who, text, mine) {
    const item = document.createElement('li');
    item.className = mine ? 'msg mine' : 'msg';
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = who;
    const body = document.createElement('span');
    body.className = 'msg-body';
    body.textContent = text;
    item.append(author, body);
    list.append(item);
    list.scrollTop = list.scrollHeight;
  }

  // One row per transfer id, updated in place as progress events arrive.
  function renderTransfer(list, ev) {
    let row = list.querySelector(`[data-id="${CSS.escape(ev.id)}"]`);
    if (!row) {
      row = document.createElement('li');
      row.className = 'transfer';
      row.dataset.id = ev.id;
      row.innerHTML = '<div class="transfer-head"><span class="transfer-dir"></span><span class="transfer-name"></span></div>'
        + '<progress max="1" value="0"></progress><div class="transfer-meta"></div>';
      row.querySelector('.transfer-dir').textContent = ev.dir === 'in' ? '↓' : '↑';
      row.querySelector('.transfer-name').textContent = ev.name;
      list.append(row);
      list.scrollTop = list.scrollHeight;
    }
    const meta = row.querySelector('.transfer-meta');
    const bar = row.querySelector('progress');
    bar.value = ev.size ? (ev.done ?? 0) / ev.size : 1;
    row.dataset.status = ev.status;
    if (ev.status === 'failed') {
      meta.textContent = `Falhou${ev.reason ? ` — ${ev.reason}` : ''}`;
    } else if (ev.status === 'queued') {
      meta.textContent = `Na fila · ${formatBytes(ev.size)}`;
    } else if (ev.status === 'progress') {
      meta.textContent = `${formatBytes(ev.done ?? 0)} de ${formatBytes(ev.size)}`;
    } else if (ev.status === 'done' && ev.blob) {
      meta.textContent = '';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(ev.blob);
      link.download = ev.name;
      link.textContent = `Baixar · ${formatBytes(ev.size)}`;
      meta.append(link);
    } else if (ev.status === 'done') {
      meta.textContent = `Enviado · ${formatBytes(ev.size)}`;
    }
  }

  // Chat + file panel markup is identical on both pages; getChannel returns the live channel or null.
  function createPanel(getChannel) {
    const panel = document.getElementById('panel');
    const chatList = document.getElementById('chat-list');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const fileInput = document.getElementById('file-input');
    const transferList = document.getElementById('transfer-list');
    let enabled = false;

    function sendFiles(files) {
      const channel = getChannel();
      if (!enabled || !channel) return;
      for (const file of files) channel.sendFile(file);
    }

    chatForm.addEventListener('submit', e => {
      e.preventDefault();
      const text = chatInput.value.trim();
      const channel = getChannel();
      if (!text || !enabled || !channel) return;
      channel.send({ t: 'chat', text });
      appendChat(chatList, 'Você', text, true);
      chatInput.value = '';
    });
    fileInput.addEventListener('change', () => {
      sendFiles(fileInput.files);
      fileInput.value = '';
    });
    panel.addEventListener('dragover', e => {
      if (!enabled) return;
      e.preventDefault();
      panel.classList.add('dropping');
    });
    panel.addEventListener('dragleave', e => {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('dropping');
    });
    panel.addEventListener('drop', e => {
      e.preventDefault();
      panel.classList.remove('dropping');
      sendFiles(e.dataTransfer.files);
    });

    return {
      setEnabled(on) {
        enabled = on;
        panel.classList.toggle('disabled', !on);
        for (const el of [chatInput, fileInput, ...chatForm.querySelectorAll('button')]) el.disabled = !on;
      },
      chat(who, text) {
        appendChat(chatList, who, String(text).slice(0, 2000), false);
      },
      transfer(ev) {
        renderTransfer(transferList, ev);
      },
    };
  }

  return { framed, peerIdFor, randomDigits, createChannel, createPanel, videoContentRect, formatId, formatBytes };
})();
