// Signaling server: pairs one viewer with one sharing browser and relays WebRTC SDP/ICE.
// Screen video, chat and files never pass through here; they go peer-to-peer over WebRTC.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const MAX_CODE_FAILURES = 5;
const LOCKOUT_MS = 30_000;

// ICE_SERVERS: JSON array of RTCIceServer, e.g. a TURN server for viewers behind strict NAT.
const ICE_SERVERS = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: 'stun:stun.l.google.com:19302' }];

function handleHttp(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ iceServers: ICE_SERVERS }));
    return;
  }
  const file = path.resolve(PUBLIC_DIR, pathname.slice(1) || 'index.html');
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)]) {
    res.writeHead(404).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' }).end(data);
  });
}

// Screen capture needs a secure context: localhost works over HTTP, any other address needs HTTPS.
const server = process.env.TLS_CERT && process.env.TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handleHttp)
  : http.createServer(handleHttp);

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const peers = new Map(); // peer id -> ws

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function newHostId() {
  let id;
  do id = String(crypto.randomInt(100_000_000, 1_000_000_000));
  while (peers.has(id));
  return id;
}

// The confirmation code is single-use: it changes after every request it admitted and after repeated failures.
function rotateCode(host, reason) {
  host.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  host.failures = 0;
  send(host, { type: 'code', code: host.code, reason });
}

function codeMatches(host, code) {
  const given = Buffer.from(String(code ?? '').replace(/\D/g, ''));
  const expected = Buffer.from(host.code);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function unpair(ws) {
  const partner = peers.get(ws.partner);
  ws.partner = null;
  if (partner && partner.partner === ws.peerId) {
    partner.partner = null;
    send(partner, { type: 'hangup' });
  }
}

function cancelPending(ws) {
  const other = peers.get(ws.pending);
  ws.pending = null;
  if (!other || other.pending !== ws.peerId) return;
  other.pending = null;
  if (ws.role === 'viewer') {
    send(other, { type: 'cancelled', from: ws.peerId });
    rotateCode(other, 'used');
  } else {
    send(other, { type: 'rejected' });
  }
}

wss.on('connection', ws => {
  ws.peerId = null;
  ws.role = null;
  ws.partner = null;
  ws.pending = null;

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'register': {
        if (ws.role) return;
        ws.role = 'host';
        ws.peerId = newHostId();
        ws.lockedUntil = 0;
        peers.set(ws.peerId, ws);
        send(ws, { type: 'registered', id: ws.peerId });
        rotateCode(ws, 'new');
        return;
      }
      case 'newcode': {
        if (ws.role === 'host' && !ws.pending) rotateCode(ws, 'manual');
        return;
      }
      case 'connect': {
        if (ws.role) return;
        const host = peers.get(String(msg.id ?? '').replace(/\D/g, ''));
        if (!host || host.role !== 'host') return send(ws, { type: 'error', reason: 'offline' });
        if (host.partner || host.pending) return send(ws, { type: 'error', reason: 'busy' });
        if (Date.now() < host.lockedUntil) return send(ws, { type: 'error', reason: 'locked' });
        if (!codeMatches(host, msg.code)) {
          if (++host.failures >= MAX_CODE_FAILURES) {
            host.lockedUntil = Date.now() + LOCKOUT_MS;
            rotateCode(host, 'failures');
          }
          return send(ws, { type: 'error', reason: 'badcode' });
        }
        ws.role = 'viewer';
        ws.peerId = 'v' + crypto.randomBytes(8).toString('hex');
        peers.set(ws.peerId, ws);
        ws.pending = host.peerId;
        host.pending = ws.peerId;
        const name = String(msg.name ?? '').trim().slice(0, 64) || 'Visitante';
        send(host, { type: 'request', from: ws.peerId, name });
        return;
      }
      case 'accept':
      case 'reject': {
        if (ws.role !== 'host' || !ws.pending || ws.pending !== msg.to) return;
        const viewer = peers.get(ws.pending);
        ws.pending = null;
        rotateCode(ws, 'used');
        if (!viewer) return;
        viewer.pending = null;
        if (msg.type === 'reject') return send(viewer, { type: 'rejected' });
        ws.partner = viewer.peerId;
        viewer.partner = ws.peerId;
        send(viewer, { type: 'accepted' });
        return;
      }
      case 'signal': {
        if (ws.partner) send(peers.get(ws.partner), { type: 'signal', data: msg.data });
        return;
      }
      case 'hangup': {
        unpair(ws);
        return;
      }
    }
  });

  ws.on('close', () => {
    cancelPending(ws);
    unpair(ws);
    if (ws.peerId) peers.delete(ws.peerId);
  });
});

server.listen(PORT, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`RemoteDesk on ${scheme}://localhost:${PORT}`);
});
