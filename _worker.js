import { connect } from 'cloudflare:sockets';

const te = new TextEncoder();
const td = new TextDecoder();

export default {
	async fetch(req, env) {
		// 支持环境变量 UUID，没有则用硬编码
		const uuidStr = env.UUID || '78888888-8888-4f73-8888-f2c15d3e332c';
		const clean = uuidStr.replace(/-/g, '');
		const EXPECTED_UUID_BYTES = Uint8Array.from(clean.match(/.{2}/g).map(byte => parseInt(byte, 16)));

		if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('OK', { status: 200 });
		}

		const url = new URL(req.url);
		let pathname = url.pathname;
		try { pathname = decodeURIComponent(pathname); } catch {}

		// 宽松参数解析
		let mode = 'd';
		let proxyParam = null;
		const match = pathname.match(/[/?&]([sghp]|gh)=([^/&?#]+)/i);
		if (match) {
			const t = match[1].toLowerCase();
			proxyParam = match[2];
			mode = t === 'g' ? 'g' : t === 'gh' ? 'gh' : t;
		}

		const skJson = ['s', 'g', 'h', 'gh'].includes(mode) ? parseProxyParam(proxyParam) : null;
		const pParam = mode === 'p' ? proxyParam : null;

		const [client, server] = Object.values(new WebSocketPair());
		server.accept();

		let remote = null;
		let isDNS = false;
		let versionByte = 0;

		// early data
		const early = req.headers.get('sec-websocket-protocol');
		if (early) {
			try {
				const bin = Uint8Array.from(atob(early.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
				server.send(bin);
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
					if (chunk.byteLength < 2) return;
					const len = new DataView(chunk).getUint16(0);
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
					const uuidPart = new Uint8Array(chunk, 1, 16);
					if (!EXPECTED_UUID_BYTES.every((b, i) => b === uuidPart[i])) return server.close();

					versionByte = chunk[0];

					const view = new DataView(chunk.buffer, chunk.byteOffset);
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
					} else {
						return server.close();
					}

					const payload = chunk.slice(pos + (atyp === 1 ? 4 : view.getUint8(pos - 1)));

					if (cmd === 2) {
						if (port !== 53) return server.close();
						isDNS = true;
						if (payload.byteLength) server.send(payload);
						return;
					}

					// 修复：正确定义连接顺序
					let orders = ['d'];
					if (mode === 'g') orders = ['s'];
					else if (mode === 'gh') orders = ['h'];
					else if (mode === 's') orders = ['d', 's'];
					else if (mode === 'h') orders = ['d', 'h'];
					else if (mode === 'p') orders = ['d', 'p'];

					for (const m of orders) {
						try {
							if (m === 'd') {
								remote = connect({ hostname: addr, port });
								await remote.opened;
							} else if (m === 's') {
								remote = await socks5Connect(addr, port, skJson);
							} else if (m === 'p') {
								const [h, p = port] = pParam.split(':');
								remote = connect({ hostname: h, port: +p });
								await remote.opened;
							} else if (m === 'h') {
								remote = await httpCONNECT(addr, port, skJson);
							}
							if (remote) break;
						} catch (e) {
							// 继续下一个
						}
					}

					if (!remote) return server.close();

					// 立即发送确认头
					if (server.readyState === 1) server.send(new Uint8Array([versionByte, 0]));

					// 转发初始 payload
					if (remote.writable) {
						const writer = remote.writable.getWriter();
						await writer.write(payload);
						writer.releaseLock();
					}

					// 下行转发
					remote.readable.pipeTo(new WritableStream({
						write(data) {
							if (server.readyState === 1) server.send(data);
						},
						close() { server.close(); }
					})).catch(() => server.close());

					return;
				}

				// 后续数据转发
				if (remote.writable) {
					const writer = remote.writable.getWriter();
					await writer.write(chunk);
					writer.releaseLock();
				}
			}
		})).catch(() => {});

		return new Response(null, { status: 101, webSocket: client });
	}
};

function parseProxyParam(str) {
	if (!str) return null;
	const hasAuth = str.includes('@');
	const [cred, server] = hasAuth ? str.split('@') : [null, str];
	const [user, pass] = hasAuth ? cred.split(':') : [null, null];
	const [host, port = 443] = server.split(':');
	return { user, pass, host, port: Number(port) };
}

async function socks5Connect(addr, port, proxy) {
	const sock = connect({ hostname: proxy.host, port: proxy.port });
	await sock.opened;

	const writer = sock.writable.getWriter();
	const reader = sock.readable.getReader();

	await writer.write(new Uint8Array([5, 2, 0, 2]));
	const { value: authResp } = await reader.read();
	const method = authResp[1];

	if (method === 2 && proxy.user) {
		const u = te.encode(proxy.user);
		const p = te.encode(proxy.pass || '');
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

async function httpCONNECT(addr, port, proxy) {
	const sock = connect({ hostname: proxy.host, port: proxy.port });
	await sock.opened;

	const auth = proxy.user ? `Basic ${btoa(`${proxy.user}:${proxy.pass || ''}`)}` : '';
	const request = `CONNECT ${addr}:${port} HTTP/1.1\r\nHost: ${addr}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n\r\n`;

	const writer = sock.writable.getWriter();
	await writer.write(te.encode(request));
	writer.releaseLock();

	const reader = sock.readable.getReader();
	let buffer = new Uint8Array(0);
	let headerEnd = -1;

	while (headerEnd === -1) {
		const { value, done } = await reader.read();
		if (done) throw new Error('Proxy closed early');
		const tmp = new Uint8Array(buffer.length + value.length);
		tmp.set(buffer);
		tmp.set(value, buffer.length);
		buffer = tmp;
		const text = td.decode(buffer);
		headerEnd = text.indexOf('\r\n\r\n');
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