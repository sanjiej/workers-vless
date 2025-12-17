import { connect } from 'cloudflare:sockets';

const te = new TextEncoder();
const td = new TextDecoder();

export default {
  async fetch(request, env) {
    // 支持环境变量 UUID，优先使用 env.UUID
    const uuidStr = env.UUID || '78888888-8888-4f73-8888-f2c15d3e332c';
    const cleanUUID = uuidStr.replace(/-/g, '');
    const EXPECTED_UUID = Uint8Array.from(cleanUUID.match(/.{2}/g).map(b => parseInt(b, 16)));

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('OK', { status: 200 });
    }

    const url = new URL(request.url);
    let path = url.pathname + url.search;
    try { path = decodeURIComponent(path); } catch {}

    let mode = 'd';
    let proxyParam = null;
    const paramMatch = path.match(/[/?&]([sghp]|gh)=([^/&?#]+)/i);
    if (paramMatch) {
      const type = paramMatch[1].toLowerCase();
      proxyParam = paramMatch[2];
      mode = type === 'g' ? 'g' : type === 'gh' ? 'gh' : type;
    }

    const proxyConfig = ['s','g','h','gh'].includes(mode) ? parseProxy(proxyParam) : null;
    const directProxy = mode === 'p' ? proxyParam : null;

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    let remoteSocket = null;
    let isDNS = false;
    let clientVersion = 0;

    // Early Data
    const earlyDataHeader = request.headers.get('sec-websocket-protocol');
    if (earlyDataHeader) {
      try {
        const earlyData = Uint8Array.from(atob(earlyDataHeader.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        server.send(earlyData);
      } catch {}
    }

    const readable = new ReadableStream({
      start(controller) {
        server.addEventListener('message', msg => controller.enqueue(msg.data));
        server.addEventListener('close', () => controller.close());
        server.addEventListener('error', () => controller.error());
      }
    }).pipeTo(new WritableStream({
      async write(chunk) {
        if (isDNS) {
          // DNS over UDP
          const length = new DataView(chunk).getUint16(0);
          const query = chunk.slice(2, 2 + length);
          try {
            const resp = await fetch('https://1.1.1.1/dns-query', {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: query
            });
            const answer = new Uint8Array(await resp.arrayBuffer());
            const responseFrame = new Uint8Array(4 + answer.length);
            responseFrame.set([clientVersion, 0]);
            responseFrame.set(new Uint16Array([answer.length]).buffer, 2);
            responseFrame.set(answer, 4);
            server.send(responseFrame);
          } catch {}
          return;
        }

        if (!remoteSocket) {
          // 第一包：验证 UUID
          if (chunk.byteLength < 17) return server.close();
          const uuidView = new Uint8Array(chunk, 1, 16);
          if (!EXPECTED_UUID.every((b, i) => b === uuidView[i])) return server.close();

          clientVersion = chunk[0];

          const view = new DataView(chunk.buffer);
          const optLen = view.getUint8(17);
          const command = view.getUint8(18 + optLen);

          let pos = 19 + optLen;
          const port = view.getUint16(pos);
          pos += 2;
          const atyp = view.getUint8(pos++);
          let address = '';
          let addrBytes = 0;

          if (atyp === 1) { // IPv4
            address = `${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}`;
            addrBytes = 4;
          } else if (atyp === 3) { // Domain
            const domainLen = view.getUint8(pos++);
            address = td.decode(new Uint8Array(chunk.buffer, chunk.byteOffset + pos, domainLen));
            addrBytes = 1 + domainLen;
            pos += domainLen;
          } else {
            return server.close();
          }

          const payload = chunk.slice(pos);

          if (command === 2) { // UDP
            if (port !== 53) return server.close();
            isDNS = true;
            if (payload.byteLength) server.send(payload);
            return;
          }

          // TCP 连接顺序
          const tryOrder = mode === 'g' ? ['s'] :
                           mode === 'gh' ? ['h'] :
                           mode === 's' ? ['d', 's'] :
                           mode === 'h' ? ['d', 'h'] :
                           mode === 'p' ? ['d', 'p'] : ['d'];

          for (const type of tryOrder) {
            try {
              if (type === 'd') {
                remoteSocket = connect({ hostname: address, port });
                await remoteSocket.opened;
              } else if (type === 's' && proxyConfig) {
                remoteSocket = await socks5Handshake(address, port, proxyConfig);
              } else if (type === 'p' && directProxy) {
                const [host, p = port] = directProxy.split(':');
                remoteSocket = connect({ hostname: host, port: Number(p) });
                await remoteSocket.opened;
              } else if (type === 'h' && proxyConfig) {
                remoteSocket = await httpConnectTunnel(address, port, proxyConfig);
              }
              if (remoteSocket) break;
            } catch (e) {}
          }

          if (!remoteSocket) return server.close();

          // 立即发送 VLESS 响应头
          server.send(new Uint8Array([clientVersion, 0]));

          // 转发初始 payload
          const writer = remoteSocket.writable.getWriter();
          if (payload.byteLength) await writer.write(payload);
          writer.releaseLock();

          // 双向转发
          remoteSocket.readable.pipeTo(new WritableStream({
            write(data) {
              if (server.readyState === 1) server.send(data);
            },
            close() { server.close(); }
          })).catch(() => server.close());

          return;
        }

        // 后续数据直接转发
        const writer = remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
      }
    })).catch(() => {});

    return new Response(null, { status: 101, webSocket: client });
  }
};

function parseProxy(str) {
  if (!str) return null;
  const hasAuth = str.includes('@');
  const [auth, server] = hasAuth ? str.split('@') : [null, str];
  const [user, pass] = auth ? auth.split(':') : [null, null];
  const [host, port = 443] = server.split(':');
  return { user, pass, host, port: Number(port) };
}

async function socks5Handshake(targetAddr, targetPort, proxy) {
  const sock = connect({ hostname: proxy.host, port: proxy.port });
  await sock.opened;

  const w = sock.writable.getWriter();
  const r = sock.readable.getReader();

  await w.write(new Uint8Array([5, 2, 0, 2]));
  const { value: authMethodResp } = await r.read();
  const method = authMethodResp[1];

  if (method === 2 && proxy.user) {
    const u = te.encode(proxy.user);
    const p = te.encode(proxy.pass || '');
    await w.write(new Uint8Array([1, u.length, ...u, p.length, ...p]));
    await r.read();
  }

  const domain = te.encode(targetAddr);
  await w.write(new Uint8Array([5, 1, 0, 3, domain.length, ...domain, targetPort >> 8, targetPort & 0xff]));
  await r.read();

  w.releaseLock();
  r.releaseLock();
  return sock;
}

async function httpConnectTunnel(targetAddr, targetPort, proxy) {
  const sock = connect({ hostname: proxy.host, port: proxy.port });
  await sock.opened;

  const authHeader = proxy.user ? `Basic ${btoa(`${proxy.user}:${proxy.pass || ''}`)}` : '';
  const connectReq = `CONNECT ${targetAddr}:${targetPort} HTTP/1.1\r\nHost: ${targetAddr}:${targetPort}\r\n${authHeader ? `Proxy-Authorization: ${authHeader}\r\n` : ''}\r\n\r\n`;

  const w = sock.writable.getWriter();
  await w.write(te.encode(connectReq));
  w.releaseLock();

  const reader = sock.readable.getReader();
  let buffer = new Uint8Array(0);
  let headerEnd = -1;

  while (headerEnd === -1) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Proxy connection closed');
    const newBuf = new Uint8Array(buffer.length + value.length);
    newBuf.set(buffer);
    newBuf.set(value, buffer.length);
    buffer = newBuf;
    headerEnd = td.decode(buffer).indexOf('\r\n\r\n');
  }

  const headerText = td.decode(buffer.slice(0, headerEnd + 4));
  if (!headerText.includes('200')) throw new Error('Proxy CONNECT failed');

  const remaining = buffer.slice(headerEnd + 4);
  const { readable: newReadable, writable: newWritable } = new TransformStream();
  if (remaining.length) {
    new ReadableStream({ start(c) { c.enqueue(remaining); c.close(); } }).pipeTo(newWritable);
  }
  sock.readable.pipeTo(newWritable);

  reader.releaseLock();
  return { readable: newReadable, writable: sock.writable };
}