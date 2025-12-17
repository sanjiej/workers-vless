import { connect } from 'cloudflare:sockets';

const te = new TextEncoder();
const td = new TextDecoder();

const UUID = '78888888-8888-4f73-8888-f2c15d3e332c';
const EXPECTED_UUID_BYTES = Uint8Array.from(UUID.replace(/-/g, '').match(/.{2}/g).map(b => parseInt(b, 16)));

function verifyUUID(data) {
	if (data.byteLength < 17) return false;
	const uuidBytes = new Uint8Array(data, 1, 16);
	return EXPECTED_UUID_BYTES.every((b, i) => b === uuidBytes[i]);
}

const SK_CACHE = new Map();

function getSKJson(str) {
	if (!str) return null;
	const cached = SK_CACHE.get(str);
	if (cached) return cached;

	const hasAuth = str.includes('@');
	const [cred, server] = hasAuth ? str.split('@') : [null, str];
	const [user, pass] = hasAuth ? cred.split(':') : [null, null];
	const [host, port = 443] = server.split(':');

	const result = { user, pass, host, port: Number(port) };
	SK_CACHE.set(str, result);
	return result;
}

async function sConnect(addr, port, skJson) {
	const sock = connect({ hostname: skJson.host, port: skJson.port });
	await sock.opened;

	const writer = sock.writable.getWriter();
	const reader = sock.readable.getReader();

	await writer.write(new Uint8Array([5, 2, 0, 2]));
	const { value: resp } = await reader.read();
	const method = resp[1];

	if (method === 2 && skJson.user) {
		const u = te.encode(skJson.user);
		const p = te.encode(skJson.pass || '');
		await writer.write(new Uint8Array([1, u.length, ...u, p.length, ...p]));
		await reader.read();
	}

	const domain = te.encode(addr);
	await writer.write(new Uint8Array([5, 1, 0, 3, domain.length, ...domain, port >> 8, port & 0xff]));
	await reader.read();

	writer.releaseLock();
	reader.releaseLock();
	return sock;
}

async function httpConnect(addr, port, skJson) {
	const sock = connect({ hostname: skJson.host, port: skJson.port });
	await sock.opened;

	const auth = skJson.user ? `Basic ${btoa(`${skJson.user}:${skJson.pass || ''}`)}` : '';
	const request = `CONNECT ${addr}:${port} HTTP/1.1\r\nHost: ${addr}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n\r\n`;

	const writer = sock.writable.getWriter();
	await writer.write(te.encode(request));
	writer.releaseLock();

	const reader = sock.readable.getReader();
	let buffer = new Uint8Array(0);
	let headerEnd = -1;

	while (headerEnd === -1) {
		const { value, done } = await reader.read();
		if (done) throw new Error('Proxy closed');

		const tmp = new Uint8Array(buffer.length + value.length);
		tmp.set(buffer); tmp.set(value, buffer.length);
		buffer = tmp;

		const text = td.decode(buffer);
		headerEnd = text.indexOf('\r\n\r\n');
	}

	if (!td.decode(buffer.slice(0, headerEnd + 4)).includes('200')) {
		throw new Error('HTTP CONNECT failed');
	}

	const remaining = buffer.slice(headerEnd + 4);
	const { readable: newReadable, writable: newWritable } = new TransformStream();
	if (remaining.length) {
		new ReadableStream({ start(c) { c.enqueue(remaining); c.close(); } }).pipeTo(newWritable).catch(() => {});
	}
	sock.readable.pipeTo(newWritable).catch(() => {});

	reader.releaseLock();
	return { readable: newReadable, writable: sock.writable };
}

export default {
	async fetch(req) {
		if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('OK', { status: 200 });
		}

		const url = new URL(req.url);
		let pathname = url.pathname;
		try { pathname = decodeURIComponent(pathname); } catch {}

		// 宽松解析参数
		let mode = 'd', proxyParam = null;
		const match = pathname.match(/[/?&]([sghp]|gh)=([^/&?]+)/i);
		if (match) {
			const type = match[1].toLowerCase();
			proxyParam = match[2];
			if (type === 's') mode = 's';
			else if (type === 'g') mode = 'g';
			else if (type === 'p') mode = 'p';
			else if (type === 'h') mode = 'h';
			else if (type === 'gh') mode = 'gh';
		}

		const skJson = ['s','g','h','gh'].includes(mode) ? getSKJson(proxyParam) : null;
		const pParam = mode === 'p' ? proxyParam : null;

		const [client, server] = Object.values(new WebSocketPair());
		server.accept();

		let remote = null;
		let isDNS = false;
		let headerSent = false;

		// early data
		const early = req.headers.get('sec-websocket-protocol');
		if (early) {
			try { server.send(Uint8Array.from(atob(early.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0))); } catch {}
		}

		new ReadableStream({
			start(c) {
				server.addEventListener('message', e => c.enqueue(e.data));
				server.addEventListener('close', () => c.close());
				server.addEventListener('error', () => c.error());
			}
		}).pipeTo(new WritableStream({
			async write(chunk) {
				if (isDNS) {
					// DNS 处理保持不变
					const len = new DataView(chunk).getUint16(0);
					const query = chunk.slice(2, 2 + len);
					try {
						const resp = await fetch('https://1.1.1.1/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: query });
						const data = new Uint8Array(await resp.arrayBuffer());
						const frame = new Uint8Array(2 + data.length + 2);
						frame.set([chunk[0], 0]);
						frame.set(new Uint16Array([data.length]).buffer, 2);
						frame.set(data, 4);
						server.send(frame);
					} catch {}
					return;
				}

				if (!remote) {
					if (chunk.byteLength < 24 || !verifyUUID(chunk)) return server.close();

					const view = new DataView(chunk);
					const optLen = view.getUint8(17);
					const cmd = view.getUint8(18 + optLen);
					if (cmd !== 1 && cmd !== 2) return server.close();

					let pos = 19 + optLen;
					const port = view.getUint16(pos);
					pos += 2;
					const atyp = view.getUint8(pos++);

					let addr = '';
					if (atyp === 1) {
						addr = `${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}`;
					} else if (atyp === 3) {
						const len = view.getUint8(pos++);
						addr = td.decode(chunk.slice(pos, pos + len));
					} else if (atyp === 4) {
						// 简单 IPv6 支持（字符串形式）
						addr = [...new Uint8Array(chunk, pos, 16)].map(b => b.toString(16).padStart(2,'0')).reduce((a,b,i) => a + (i%2? b : b+':'), '').replace(/:0+/g, ':');
						pos += 16;
					} else return server.close();

					const payload = chunk.slice(pos);

					if (cmd === 2) {
						if (port !== 53) return server.close();
						isDNS = true;
						if (payload.byteLength) server.send(payload);
						return;
					}

					// 尝试连接顺序
					const orders = mode === 'g' || mode === 'gh' ? [mode] : 
								   mode === 'p' ? ['d', 'p'] : 
								   mode === 's' || mode === 'h' ? ['d', mode] : ['d'];

					for (const m of orders) {
						try {
							if (m === 'd') {
								remote = connect({ hostname: addr, port });
								await Promise.race([remote.opened, new Promise((_, rej) => setTimeout(() => rej('timeout'), 5000))]);
							} else if (m === 's' || m === 'g') {
								remote = await sConnect(addr, port, skJson);
							} else if (m === 'p') {
								const [h, p = port] = pParam.split(':');
								remote = connect({ hostname: h, port: +p });
								await remote.opened;
							} else if (m === 'h' || m === 'gh') {
								remote = await httpConnect(addr, port, skJson);
							}
							if (remote) break;
						} catch {}
					}

					if (!remote) return server.close();

					if (remote.writable) {
						const w = remote.writable.getWriter();
						await w.write(payload);
						w.releaseLock();
					}

					remote.readable.pipeTo(new WritableStream({
						write(data) {
							if (server.readyState !== 1) return;
							if (!headerSent) {
								const header = new Uint8Array([chunk[0], 0]);
								const combined = new Uint8Array(header.length + data.byteLength);
								combined.set(header); combined.set(data, header.length);
								server.send(combined);
								headerSent = true;
							} else {
								server.send(data);
							}
						}
					})).catch(() => server.close());

					return;
				}

				if (remote.writable) {
					const w = remote.writable.getWriter();
					await w.write(chunk);
					w.releaseLock();
				}
			}
		})).catch(() => {});

		return new Response(null, { status: 101, webSocket: client });
	}
};