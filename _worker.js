import { connect } from 'cloudflare:sockets';

const te = new TextEncoder();
const td = new TextDecoder();

// 支持环境变量 UUID，优先使用 env.UUID（推荐设置自己的真实 UUID）
const UUID = env.UUID || '78888888-8888-4f73-8888-f2c15d3e332c';
const EXPECTED_UUID_BYTES = Uint8Array.from(UUID.replace(/-/g, '').match(/.{2}/g).map(b => parseInt(b, 16)));

function verifyUUID(data) {
	if (data.byteLength < 17) return false;
	const uuidBytes = new Uint8Array(data, 1, 16);
	return EXPECTED_UUID_BYTES.every((b, i) => b === uuidBytes[i]);
}

const SK_CACHE = new Map();

function getSKJson(path) {
	const cached = SK_CACHE.get(path);
	if (cached) return cached;

	const hasAuth = path.includes('@');
	const [cred, server] = hasAuth ? path.split('@') : [null, path];
	const [user = null, pass = null] = hasAuth ? cred.split(':') : [null, null];
	const [host, port = 443] = server.split(':');

	const result = { user, pass, host, port: Number(port) };
	SK_CACHE.set(path, result);
	return result;
}

const orderCache = {
	'p': ['d', 'p'],
	's': ['d', 's'],
	'g': ['s'],
	'h': ['d', 'h'],
	'gh': ['h'],
	'default': ['d']
};

function getOrder(mode) {
	return orderCache[mode] || orderCache['default'];
}

async function sConnect(targetHost, targetPort, skJson) {
	const sock = connect({ hostname: skJson.host, port: skJson.port });
	await sock.opened;

	const w = sock.writable.getWriter();
	const r = sock.readable.getReader();

	await w.write(new Uint8Array([5, 2, 0, 2]));
	const { value: authResp } = await r.read();
	const method = authResp[1];

	if (method === 2 && skJson.user) {
		const u = te.encode(skJson.user);
		const p = te.encode(skJson.pass || '');
		await w.write(new Uint8Array([1, u.length, ...u, p.length, ...p]));
		await r.read();
	}

	const domain = te.encode(targetHost);
	await w.write(new Uint8Array([5, 1, 0, 3, domain.length, ...domain, targetPort >> 8, targetPort & 0xff]));
	await r.read();

	w.releaseLock();
	r.releaseLock();
	return sock;
}

async function httpConnect(address, port, skJson) {
	const sock = connect({ hostname: skJson.host, port: skJson.port });
	await sock.opened;

	const auth = skJson.user ? `Basic ${btoa(`${skJson.user}:${skJson.pass || ''}`)}` : '';
	const request = `CONNECT ${address}:${port} HTTP/1.1\r\nHost: ${address}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}Proxy-Connection: Keep-Alive\r\n\r\n`;

	const w = sock.writable.getWriter();
	await w.write(te.encode(request));
	w.releaseLock();

	const reader = sock.readable.getReader();
	let buffer = new Uint8Array(0);
	let headerEnd = -1;

	while (headerEnd === -1) {
		const { value, done } = await reader.read();
		if (done) throw new Error('HTTP proxy closed early');
		const tmp = new Uint8Array(buffer.length + value.length);
		tmp.set(buffer);
		tmp.set(value, buffer.length);
		buffer = tmp;
		headerEnd = td.decode(buffer).indexOf('\r\n\r\n');
	}

	if (!td.decode(buffer.slice(0, headerEnd + 4)).includes('200')) {
		throw new Error('HTTP CONNECT failed');
	}

	const remaining = buffer.slice(headerEnd + 4);
	const { readable: newReadable, writable: newWritable } = new TransformStream();
	if (remaining.length > 0) {
		new ReadableStream({ start(c) { c.enqueue(remaining); c.close(); } }).pipeTo(newWritable).catch(() => {});
	}
	sock.readable.pipeTo(newWritable).catch(() => {});

	reader.releaseLock();
	return { readable: newReadable, writable: sock.writable };
}

export default {
	async fetch(req, env) {
		if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response("Hello World", { status: 200 });
		}

		const u = new URL(req.url);
		let pathname = u.pathname;

		// 处理 URL 编码路径（如 %2Fs=xxx）
		if (pathname.includes('%')) {
			try { pathname = decodeURIComponent(pathname); } catch {}
		}

		let mode = 'd';
		let skJson = null;
		let pParam = null;

		// 保持你原来的路径解析方式
		if (pathname.includes('/s=')) {
			mode = 's';
			skJson = getSKJson(pathname.split('/s=')[1].split('/')[0]);
		} else if (pathname.includes('/g=')) {
			mode = 'g';
			skJson = getSKJson(pathname.split('/g=')[1].split('/')[0]);
		} else if (pathname.includes('/p=')) {
			mode = 'p';
			pParam = pathname.split('/p=')[1].split('/')[0];
		} else if (pathname.includes('/h=')) {
			mode = 'h';
			skJson = getSKJson(pathname.split('/h=')[1].split('/')[0]);
		} else if (pathname.includes('/gh=')) {
			mode = 'gh';
			skJson = getSKJson(pathname.split('/gh=')[1].split('/')[0]);
		}

		const [client, ws] = Object.values(new WebSocketPair());
		ws.accept();

		let remote = null;
		let isDNS = false;
		let versionByte = 0;

		// Early Data
		const early = req.headers.get('sec-websocket-protocol');
		if (early) {
			try {
				ws.send(Uint8Array.from(atob(early.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
			} catch {}
		}

		new ReadableStream({
			start(ctrl) {
				ws.addEventListener('message', e => ctrl.enqueue(e.data));
				ws.addEventListener('close', () => remote?.close?.());
				ws.addEventListener('error', () => remote?.close?.());
			}
		}).pipeTo(new WritableStream({
			async write(data) {
				if (isDNS) {
					// DNS 逻辑保持但简化
					if (data.byteLength < 2) return;
					const len = new DataView(data.buffer).getUint16(0);
					if (data.byteLength < 2 + len) return;
					const query = data.slice(2, 2 + len);
					try {
						const resp = await fetch('https://1.1.1.1/dns-query', {
							method: 'POST',
							headers: { 'content-type': 'application/dns-message' },
							body: query
						});
						const result = new Uint8Array(await resp.arrayBuffer());
						const frame = new Uint8Array(4 + result.length);
						frame.set([versionByte, 0]);
						frame.set(new Uint16Array([result.length]).buffer, 2);
						frame.set(result, 4);
						if (ws.readyState === 1) ws.send(frame);
					} catch {}
					return;
				}

				if (!remote) {
					if (data.byteLength < 24 || !verifyUUID(data)) return ws.close();

					versionByte = data[0];

					const view = new DataView(data.buffer);
					const optLen = view.getUint8(17);
					const cmd = view.getUint8(18 + optLen);
					if (cmd !== 1 && cmd !== 2) return ws.close();

					let pos = 19 + optLen;
					const port = view.getUint16(pos);
					pos += 2;
					const type = view.getUint8(pos++);
					let addr = '';
					let addrLen = 0;

					if (type === 1) {
						addr = `${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}.${view.getUint8(pos++)}`;
						addrLen = 4;
					} else if (type === 2) {
						const len = view.getUint8(pos++);
						addr = td.decode(data.slice(pos, pos + len));
						addrLen = 1 + len;
						pos += len;
					} else if (type === 3) {
						const ipv6 = [];
						for (let i = 0; i < 8; i++, pos += 2) {
							ipv6.push(view.getUint16(pos).toString(16));
						}
						addr = ipv6.join(':');
						addrLen = 16;
					} else {
						return ws.close();
					}

					const payload = data.slice(pos);

					if (cmd === 2) {
						if (port !== 53) return ws.close();
						isDNS = true;
						if (payload.byteLength) ws.send(payload);
						return;
					}

					// 按你的模式尝试连接
					for (const method of getOrder(mode)) {
						try {
							if (method === 'd') {
								remote = connect({ hostname: addr, port });
								await remote.opened;
							} else if ((method === 's' || method === 'g') && skJson) {
								remote = await sConnect(addr, port, skJson);
							} else if (method === 'p' && pParam) {
								const [ph, pp = port] = pParam.split(':');
								remote = connect({ hostname: ph, port: +pp });
								await remote.opened;
							} else if ((method === 'h' || method === 'gh') && skJson) {
								remote = await httpConnect(addr, port, skJson);
							}
							if (remote) break;
						} catch {}
					}

					if (!remote) return ws.close();

					// 关键：立即发送响应头
					if (ws.readyState === 1) ws.send(new Uint8Array([versionByte, 0]));

					// 转发初始 payload
					const w = remote.writable.getWriter();
					await w.write(payload);
					w.releaseLock();

					// 下行直接转发（不再加任何头或控流）
					remote.readable.pipeTo(new WritableStream({
						write(chunk) {
							if (ws.readyState === 1) ws.send(chunk);
						},
						close() { ws.close(); }
					})).catch(() => ws.close());

					return;
				}

				// 后续数据直接转发
				const w = remote.writable.getWriter();
				await w.write(data);
				w.releaseLock();
			}
		})).catch(() => {});

		return new Response(null, { status: 101, webSocket: client });
	}
};