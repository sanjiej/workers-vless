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
const orderCache = {
	'p': ['d', 'p'],
	's': ['d', 's'],
	'g': ['s'],
	'h': ['d', 'h'],
	'gh': ['h'],
	default: ['d']
};

function getSKJson(path) {
	const cached = SK_CACHE.get(path);
	if (cached) return cached;

	const hasAuth = path.includes('@');
	const [cred, server] = hasAuth ? path.split('@') : [null, path];
	const [user = null, pass = null] = hasAuth ? cred.split(':') : [null, null];
	const [host, port = 443] = (server || '').split(':');

	const result = { user, pass, host, port: +port || 443 };
	SK_CACHE.set(path, result);
	return result;
}

function getOrder(mode) {
	return orderCache[mode] || orderCache.default;
}

// 分片发送，避免 Cloudflare WebSocket 单包限制
function sendFragmented(ws, data, isFirst = false) {
	const header = new Uint8Array([data[0], 0]);
	const maxSize = 16384; // 16KB 安全值

	if (isFirst && data.byteLength <= maxSize) {
		const combined = new Uint8Array(header.length + data.byteLength);
		combined.set(header);
		combined.set(new Uint8Array(data), header.length);
		ws.send(combined);
		return;
	}

	let offset = 0;
	if (isFirst) {
		const firstPart = data.slice(0, maxSize - header.length);
		const combined = new Uint8Array(header.length + firstPart.byteLength);
		combined.set(header);
		combined.set(new Uint8Array(firstPart), header.length);
		ws.send(combined);
		offset = firstPart.byteLength;
	}

	while (offset < data.byteLength) {
		const end = Math.min(offset + maxSize, data.byteLength);
		ws.send(data.slice(offset, end));
		offset = end;
	}
}

async function sConnect(targetHost, targetPort, skJson) {
	const sock = connect({ hostname: skJson.host, port: skJson.port });
	await sock.opened;

	const w = sock.writable.getWriter();
	const r = sock.readable.getReader();

	// SOCKS5 问候
	await w.write(new Uint8Array([5, 2, 0, 2])); // 支持无认证和用户名密码
	const { value: authResp } = await r.read();
	if (!authResp || authResp.byteLength < 2) throw new Error('SOCKS5 auth failed');

	const authMethod = authResp[1];
	if (authMethod === 2 && skJson.user) {
		const user = te.encode(skJson.user);
		const pass = te.encode(skJson.pass || '');
		await w.write(new Uint8Array([1, user.length, ...user, pass.length, ...pass]));
		await r.read(); // 忽略认证响应
	} else if (authMethod !== 0) {
		throw new Error('SOCKS5 no acceptable auth');
	}

	// 请求连接
	const domain = te.encode(targetHost);
	await w.write(new Uint8Array([
		5, 1, 0, 3, domain.length, ...domain,
		targetPort >> 8, targetPort & 0xff
	]));
	await r.read(); // 忽略响应

	w.releaseLock();
	r.releaseLock();
	return sock;
}

async function httpConnect(address, port, skJson) {
	const { host, port: proxyPort, user, pass } = skJson;
	const sock = connect({ hostname: host, port: proxyPort });
	await sock.opened;

	const request = [
		`CONNECT ${address}:${port} HTTP/1.1`,
		`Host: ${address}:${port}`,
		'Proxy-Connection: Keep-Alive',
		'Connection: Keep-Alive',
		user ? `Proxy-Authorization: Basic ${btoa(`${user}:${pass || ''}`)}` : null,
		'', ''
	].filter(Boolean).join('\r\n');

	const writer = sock.writable.getWriter();
	await writer.write(te.encode(request));
	writer.releaseLock();

	// 读取响应直到 \r\n\r\n
	const reader = sock.readable.getReader();
	let buffer = new Uint8Array(0);
	let headerEnd = -1;

	while (headerEnd === -1) {
		const { value, done } = await reader.read();
		if (done) throw new Error('HTTP proxy closed during headers');

		const newBuf = new Uint8Array(buffer.length + value.length);
		newBuf.set(buffer);
		newBuf.set(value, buffer.length);
		buffer = newBuf;

		const text = td.decode(buffer);
		headerEnd = text.indexOf('\r\n\r\n');
	}

	const headersText = td.decode(buffer.slice(0, headerEnd + 4));
	if (!/^HTTP\/1\.[01] 2\d{2}/.test(headersText.split('\r\n')[0])) {
		throw new Error('HTTP proxy connect failed: ' + headersText.split('\r\n')[0]);
	}

	// 剩余数据作为 readable 的起始
	const remaining = buffer.slice(headerEnd + 4);
	const { readable, writable } = new TransformStream();
	if (remaining.length > 0) {
		const enqueueRemaining = new WritableStream({
			write() { },
			start(controller) {
				controller.enqueue(remaining);
				controller.close();
			}
		});
		new ReadableStream({ start(c) { c.enqueue(remaining); c.close(); } })
			.pipeTo(writable).catch(() => {});
	}

	sock.readable.pipeTo(writable).catch(() => {});
	reader.releaseLock();

	return { readable, writable: sock.writable };
}

export default {
	async fetch(req, env) {
		if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Hello World', { status: 200 });
		}

		const url = new URL(req.url);
		let mode = 'd';
		let skJson = null;
		let pParam = null;

		// 处理被编码的路径如 /%3Fs=user:pass@host:port
		if (url.pathname.includes('%')) {
			try {
				const decoded = decodeURIComponent(url.pathname);
				const qIndex = decoded.indexOf('?');
				if (qIndex !== -1) {
					url.pathname = decoded.slice(0, qIndex);
					url.search = decoded.slice(qIndex);
				} else {
					url.pathname = decoded;
				}
			} catch {}
		}

		if (url.pathname.startsWith('/s=')) {
			mode = 's'; skJson = getSKJson(url.pathname.slice(3));
		} else if (url.pathname.startsWith('/g=')) {
			mode = 'g'; skJson = getSKJson(url.pathname.slice(3));
		} else if (url.pathname.startsWith('/p=')) {
			mode = 'p'; pParam = url.pathname.slice(3);
		} else if (url.pathname.startsWith('/h=')) {
			mode = 'h'; skJson = getSKJson(url.pathname.slice(3));
		} else if (url.pathname.startsWith('/gh=')) {
			mode = 'gh'; skJson = getSKJson(url.pathname.slice(4));
		}

		const [client, server] = Object.values(new WebSocketPair());
		server.accept();

		let remote = null;
		let isDNS = false;
		let sentHeader = false;

		// 处理 early data
		const earlyData = req.headers.get('sec-websocket-protocol');
		if (earlyData) {
			try {
				const bin = Uint8Array.from(atob(earlyData.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
				server.send(bin);
			} catch {}
		}

		new ReadableStream({
			start(controller) {
				server.addEventListener('message', e => {
					if (e.data instanceof ArrayBuffer || e.data.buffer instanceof ArrayBuffer) {
						controller.enqueue(e.data);
					}
				});
				server.addEventListener('close', () => { remote?.close(); controller.close(); });
				server.addEventListener('error', () => { remote?.close(); controller.error(); });
			}
		}).pipeTo(new WritableStream({
			async write(chunk) {
				if (isDNS) {
					// DNS 逻辑保持原样
					const len = new DataView(chunk.buffer, chunk.byteOffset, 2).getUint16(0);
					const query = chunk.slice(2, 2 + len);
					try {
						const resp = await fetch('https://1.1.1.1/dns-query', {
							method: 'POST',
							headers: { 'content-type': 'application/dns-message' },
							body: query
						});
						const result = new Uint8Array(await resp.arrayBuffer());
						const header = new Uint8Array([chunk[0], 0]);
						const frame = new Uint8Array(header.length + 2 + result.length);
						frame.set(header);
						frame.set(new Uint8Array(new Uint16Array([result.length]).buffer), header.length);
						frame.set(result, header.length + 2);
						if (server.readyState === 1) server.send(frame);
					} catch {}
					return;
				}

				if (!remote) {
					if (chunk.byteLength < 24 || !verifyUUID(chunk)) {
						server.close();
						return;
					}

					const view = new DataView(chunk);
					const optLen = view.getUint8(17);
					const cmd = view.getUint8(18 + optLen);
					if (cmd !== 1 && cmd !== 2) { server.close(); return; }

					let pos = 19 + optLen;
					const port = view.getUint16(pos);
					const type = view.getUint8(pos + 2);
					pos += 3;

					let addr = '';
					if (type === 1) { // IPv4
						addr = Array.from(new Uint8Array(chunk, pos, 4)).join('.');
						pos += 4;
					} else if (type === 2) { // Domain
						const len = view.getUint8(pos++);
						addr = td.decode(new Uint8Array(chunk, pos, len));
						pos += len;
					} else if (type === 3) { // IPv6 - 暂不常见，跳过
						server.close();
						return;
					} else {
						server.close();
						return;
					}

					const payload = chunk.slice(pos);

					if (cmd === 2) { // UDP DNS
						if (port !== 53) { server.close(); return; }
						isDNS = true;
						return server.send(payload); // 直接转发第一个查询
					}

					// TCP 连接尝试
					for (const method of getOrder(mode)) {
						try {
							if (method === 'd') {
								remote = connect({ hostname: addr, port });
								await remote.opened;
								break;
							} else if ((method === 's' || method === 'g') && skJson) {
								remote = await sConnect(addr, port, skJson);
								break;
							} else if (method === 'p' && pParam) {
								const [ph, pp = port] = pParam.split(':');
								remote = connect({ hostname: ph, port: +pp });
								await remote.opened;
								break;
							} else if ((method === 'h' || method === 'gh') && skJson) {
								const { readable, writable } = await httpConnect(addr, port, skJson);
								remote = { readable, writable };
								break;
							}
						} catch (e) {
							continue;
						}
					}

					if (!remote) {
						server.close();
						return;
					}

					// 转发初始 payload
					const w = remote.writable.getWriter();
					await w.write(payload);
					w.releaseLock();

					// 双向转发（无控速）
					remote.readable.pipeTo(new WritableStream({
						write(chunk) {
							if (server.readyState !== 1) return;
							if (typeof chunk === 'object') { // ArrayBuffer
								sendFragmented(server, chunk, !sentHeader);
								sentHeader = true;
							}
						},
						close() { server.close(); },
						abort() { server.close(); }
					})).catch(() => server.close());

					return;
				}

				// 已建立连接，继续转发
				if (remote?.writable) {
					const w = remote.writable.getWriter();
					await w.write(chunk);
					w.releaseLock();
				}
			}
		})).catch(() => {});

		return new Response(null, { status: 101, webSocket: client });
	}
};