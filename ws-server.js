// Minimal dependency-free WebSocket server (RFC 6455), text frames only.
// No npm install required - works anywhere Node runs.
const crypto = require('crypto');
const EventEmitter = require('events');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => { this.alive = false; this.emit('close'); });
    socket.on('error', (err) => { this.alive = false; this.emit('close'); });
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (true) {
      const frame = this._tryParseFrame(this._buf);
      if (!frame) break;
      this._buf = this._buf.slice(frame.totalLength);
      this._handleFrame(frame);
    }
  }

  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const byte0 = buf[0];
    const fin = (byte0 & 0x80) !== 0;
    const opcode = byte0 & 0x0f;
    const byte1 = buf[1];
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      payloadLen = high * 0x100000000 + low;
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null;

    let payload = buf.slice(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    return { fin, opcode, payload, totalLength: offset + payloadLen };
  }

  _handleFrame(frame) {
    if (frame.opcode === 0x8) { // close
      this._sendRaw(this._buildFrame(0x8, Buffer.alloc(0)));
      this.socket.end();
      return;
    }
    if (frame.opcode === 0x9) { // ping -> pong
      this._sendRaw(this._buildFrame(0xA, frame.payload));
      return;
    }
    if (frame.opcode === 0xA) return; // pong, ignore

    if (frame.opcode === 0x0) {
      // continuation
      this._fragments.push(frame.payload);
      if (frame.fin) {
        const full = Buffer.concat(this._fragments);
        this._fragments = [];
        this._emitMessage(this._fragOpcode, full);
        this._fragOpcode = null;
      }
      return;
    }

    // new message (text=0x1 or binary=0x2)
    if (!frame.fin) {
      this._fragOpcode = frame.opcode;
      this._fragments = [frame.payload];
      return;
    }
    this._emitMessage(frame.opcode, frame.payload);
  }

  _emitMessage(opcode, payload) {
    if (opcode === 0x1) {
      this.emit('message', payload.toString('utf8'));
    }
  }

  _buildFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len % 0x100000000, 6);
    }
    return Buffer.concat([header, payload]);
  }

  _sendRaw(buf) {
    if (this.alive && this.socket.writable) {
      try { this.socket.write(buf); } catch (e) { /* ignore */ }
    }
  }

  send(str) {
    this._sendRaw(this._buildFrame(0x1, Buffer.from(str, 'utf8')));
  }

  close() {
    try { this._sendRaw(this._buildFrame(0x8, Buffer.alloc(0))); this.socket.end(); } catch (e) {}
  }
}

function attachWebSocketServer(httpServer, { path: wsPath = '/ws' } = {}) {
  const emitter = new EventEmitter();

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== wsPath) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', ''
    ].join('\r\n');
    socket.write(responseHeaders);
    const conn = new WSConnection(socket);
    emitter.emit('connection', conn, req);
  });

  return emitter;
}

module.exports = { attachWebSocketServer };
