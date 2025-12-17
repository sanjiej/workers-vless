import { connect } from 'cloudflare:sockets';

const te = new TextEncoder();
const td = new TextDecoder();

export default {
  async fetch(request, env) {
    // 支持环境变量 UUID，优先使用 env.UUID（强烈推荐设置）
    const uuidStr = env.UUID || '78888888-8888-4f73-8888-f2c15d3e332c';
    const clean = uuidStr.replace(/-/g, '');
    const EXPECTED_UUID = Uint8Array.from(clean.match(/.{2}/g).map(b => parseInt(b, 16)));

    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Hello World', { status: 200 });
    }

    const url = new URL(request.url);
    let path = url.pathname + url.search;
    try { path = decodeURIComponent(path); } catch {}

    // 宽松解析模式参数
    let mode = 'd';
    let proxyParam = null;
    const match = path.match(/[/?&]([sghp]|gh)=([^/&?#]+)/i);
    if (match) {
      const t = match[1].toLowerCase();
      proxyParam = match[2];
      mode = t === 'g' ? 'g' : t === 'gh' ? 'gh' : t;
    }

    const proxyConfig = ['s', 'g', 'h', 'gh'].includes(mode) ? parseProxy(proxyParam) : null;
    const directProxy = mode === 'p' ? proxyParam : null;

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    let remote = null;
    let isDNS = false;
    let versionByte = 0;
    let headerSent = false;

    // Early Data 支持
    const earlyHeader = request.headers.get('sec-websocket-protocol');
    if (earlyHeader) {
      try {
        const earlyData = Uint8Array.from(atob(earlyHeader.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        server.send(earlyData);
      } catch {}
    }

    new ReadableStream({
      start(controller) {
        server.addEventListener('message', e => controller.enqueue(e.data));
        server.addEventListener('close', () => { remote?.close?.(); controller.close(); });
        server.addEventListener('error', () => { remote?.close?.(); controller.error(); });
      }
    }).pipeTo(new WritableStream({
      async write(chunk) {
        if (isDNS) {
          // DNS 处理（保持原逻辑但简化）
          if (chunk.byteLength < 2) return;
          const len = new DataView(chunk.buffer).getUint16(0);
          if (chunk.byteLength < 2 + len) return;
          const query = chunk.slice(2, 2 + len);
          try {
            const resp = await fetch('https://1.1.1.1/dns-query', {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: query
            });
            const data = new Uint8Array(await resp.arrayBuffer());
            const frame = new Uint8Array(4 + data.length);
            frame.set([versionByte, 0]);
            frame.set(new Uint16Array([data.length]).buffer, 2);
            frame.set(data, 4);
            if (server.readyState === 1) server.send(frame);
          } catch {}
          return;
        }

        if (!remote) {
          // UUID 验证
          if (chunk.byteLength < 17) return server.close();
          const uuidView = new Uint8Array(chunk.buffer, chunk.byteOffset + 1, 16);
          if (!EXPECTED_UUID.every((b, i) => b === uuidView[i])) return server.close();

          versionByte = chunk[0]; // 记录版本字节

          const view = new DataView(chunk.buffer, chunk.byteOffset);
          const optLen = view.getUint8(17);
          const cmd = view.getUint8(18 + optLen);
          if (cmd !== 1 && cmd !== 2) return server.close();

          let pos = 19 + optLen;
          const port = view.getUint16(pos);
          pos += 2;
          const atyp = view.getUint8(pos++);
          let addr = '';
          let addrLen = 0;

          if (atyp === 1) { // IPv4
            addr = `${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}`;
            addrLen = 4;
          } else if (atyp === 3) { // Domain
            const dlen = view.getUint8(pos++);
            addr = td.decode(new Uint8Array(chunk.buffer, chunk.byteOffset + pos, dlen));
            addrLen = 1 + dlen;
            pos += dlen;
          } else if (atyp === 4) { // IPv6（简单支持）
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
              ipv6.push(view.getUint16(pos).toString(16));
              pos += 2;
            }
            addr = ipv6.join(':');
            addrLen = 16;
          } else {
            return server.close();
          }

          const payload = chunk.slice(pos);

          if (cmd === 2) {
            if (port !== 53) return server.close();
            isDNS = true;
            if (payload.byteLength) server.send(payload);
            return;
          }

          // 连接顺序
          const order = mode === 'g' ? ['s'] :
                        mode === 'gh' ? ['h'] :
                        mode === 's' ? ['d', 's'] :
                        mode === 'h' ? ['d', 'h'] :
                        mode === 'p' ? ['d', 'p'] : ['d'];

          for (const type of order) {
            try {
              if (type === 'd') {
                remote = connect({ hostname: addr, port });
                await remote.opened;
              } else if ((type === 's' || type === 'g') && proxyConfig) {
                remote = await socks5Connect(addr, port, proxyConfig);
              } else if (type === 'p' && directProxy) {
                const [h, p = port] = directProxy.split(':');
                remote = connect({ hostname: h, port: +p });
                await remote.opened;
              } else if ((type === 'h' || type === 'gh') && proxyConfig) {
                remote = await httpConnectTunnel(addr, port, proxyConfig);
              }
              if (remote) break;
            } catch {}
          }

          if (!remote) return server.close();

          // 关键修复：立即发送响应头
          if (server.readyState === 1) server.send(new Uint8Array([versionByte, 0]));

          // 转发初始 payload
          const w = remote.writable.getWriter();
          if (payload.byteLength) await w.write(payload);
          w.releaseLock();

          // 下行直接转发（不再加头）
          remote.readable.pipeTo(new WritableStream({
            write(data) {
              if (server.readyState === 1) server.send(data);
            },
            close() { server.close(); }
          })).catch(() => server.close());

          return;
        }

        // 后续数据直接转发
        const w = remote.writable.getWriter();
        await w.write(chunk);
        w.releaseLock();
      }
    })).catch(() => {});

    return new Response(null, { status: 101, webSocket: client });
  }
};

// 解析代理参数 user:pass@host:port
function parseProxy(str) {
  if (!str) return null;
  const hasAuth = str.includes('@');
  const [auth, server] = hasAuth ? str.split('@') : [null, str];
  const [user, pass] = hasAuth ? auth.split(':') : [null, null];
  const [host, port = 443] = server.split(':');
  return { user, pass, host, port: Number(port) };
}

async function socks5Connect(addr, port, proxy) {
  const sock = connect({ hostname: proxy.host, port: proxy.port });
  await sock.opened;

  const w = sock.writable.getWriter();
  const r = sock.readable.getReader();

  await w.write(new Uint8Array([5, 2, 0, 2]));
  const { value: resp } = await r.read();
  const method = resp[1];

  if (method === 2 && proxy.user) {
    const u = te.encode(proxy.user);
    const p = te.encode(proxy.pass || '');
    await w.write(new Uint8Array([1, u.length, ...u, p.length, ...p]));
    await r.read();
  }

  const domain = te.encode(addr);
  await w.write(new Uint8Array([5, 1, 0, 3, domain.length, ...domain, port >> 8, port & 0xff]));
  await r.read();

  w.releaseLock();
  r.releaseLock();
  return sock;
}

async function httpConnectTunnel(addr, port, proxy) {
  const sock = connect({ hostname: proxy.host, port: proxy.port });
  await sock.opened;

  const auth = proxy.user ? `Basic ${btoa(`${proxy.user}:${proxy.pass || ''}`)}` : '';
  const req = `CONNECT ${addr}:${port} HTTP/1.1\r\nHost: ${addr}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n\r\n`;

  const w = sock.writable.getWriter();
  await w.write(te.encode(req));
  w.releaseLock();

  const reader = sock.readable.getReader();
  let buffer = new Uint8Array(0);
  let headerEnd = -1;

  while (headerEnd === -1) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Proxy closed');
    const tmp = new Uint8Array(buffer.length + value.length);
    tmp.set(buffer);
    tmp.set(value, buffer.length);
    buffer = tmp;
    headerEnd = td.decode(buffer).indexOf('\r\n\r\n');
  }

  if (!td.decode(buffer.slice(0, headerEnd + 4)).includes('200')) throw new Error('CONNECT failed');

  const remaining = buffer.slice(headerEnd + 4);
  const { readable: newR, writable: newW } = new TransformStream();
  if (remaining.length) {
    new ReadableStream({ start(c) { c.enqueue(remaining); c.close(); } }).pipeTo(newW);
  }
  sock.readable.pipeTo(newW);

  reader.releaseLock();
  return { readable: newR, writable: sock.writable };
}