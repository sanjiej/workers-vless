import { connect } from 'cloudflare:sockets';

const te = new TextEncoder();
const td = new TextDecoder();

// 支持从环境变量读取 UUID（推荐），或硬编码
const UUID = '78888888-8888-4f73-8888-f2c15d3e332c';  // 可删除，优先用 env.UUID
let EXPECTED_UUID_BYTES = null;

export default {
	async fetch(req, env) {
		// 优先从环境变量取 UUID
		const uuidStr = env.UUID || UUID;
		const clean = uuidStr.replace(/-/g, '');
		EXPECTED_UUID_BYTES = Uint8Array.from(clean.match(/.{2}/g).map(byte => parseInt(byte, 16)));

		if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('OK', { status: 200 });
		}

		const url = new URL(req.url);
		let pathname = url.pathname;
		try { pathname = decodeURIComponent(pathname); } catch {}

		// 宽松参数解析
		let mode = 'd', proxyParam = null;
		const match = pathname.match(/[/?&]([sghp]|gh)=([^/&?#]+)/i);
		if (match) {
			const t = match[1].toLowerCase();
			proxyParam = match[2];
			mode = t === 'g' ? 'g' : t === 'gh' ? 'gh' : t;
		}

		const skJson = ['s','g','h','gh'].includes(mode) ? getSKJson(proxyParam) : null;
		const pParam = mode === 'p' ? proxyParam : null;

		const [client, server] = Object.values(new WebSocketPair());
		server.accept();

		// early data
		const early = req.headers.get('sec-websocket-protocol');
		if (early) {
			try {
				server.send(Uint8Array.from(atob(early.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)));
			} catch {}
		}

		let remote = null;
		let isDNS = false;
		let versionByte = 0;  // 记录客户端版本字节

		new ReadableStream({
			start(c) {
				server.addEventListener('message', e => c.enqueue(e.data));
				server.addEventListener('close', () => remote?.close?.());
				server.addEventListener('error', () => remote?.close?.());
			}
		}).pipeTo(new WritableStream({
			async write(chunk) {
				if (isDNS) {
					// DNS 逻辑略（保持原样）
					if (chunk.byteLength < 2) return;
					const len = new DataView(chunk).getUint16(0);
					if (chunk.byteLength < 2 + len) return;
					const query = chunk.slice(2);
					try {
						const resp = await fetch('https://dns.cloudflare.com/dns-query', {  // 改用 Cloudflare DoH，更稳定
							method: 'POST',
							headers: { 'content-type': 'application/dns-message', 'accept': 'application/dns-message' },
							body: query
						});
						const data = new Uint8Array(await resp.arrayBuffer());
						const frame = new Uint8Array(4 + data.length);
						frame.set([versionByte, 0]);
						frame.set(new Uint16Array([data.length]).buffer, 2);
						frame.set(data, 4);
						server.send(frame);
					} catch {}
					return;
				}

				if (!remote) {
					if (chunk.byteLength < 17 || !verifyUUID(chunk)) return server.close();

					versionByte = chunk[0];  // 记住版本

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
						addr = [0,1,2,3].map(i => view.getUint8(pos + i)).join('.');
						pos += 4;
					} else if (atyp === 3) {
						const len = view.getUint8(pos++);
						addr = td.decode(chunk.slice(pos, pos + len));
						pos += len;
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
					const orders = mode === 'g' ? ['s'] : mode === 'gh' ? ['h'] : ['d', mode === 's' ? 's' : mode === 'h' ? 'h' : mode === 'p' ? 'p' : 'd'];

					for (const m of orders) {
						try {
							if (m === 'd') {
								remote = connect({ hostname: addr, port });
								await remote.opened;
							} else if (m === 's') {
								remote = await sConnect(addr, port, skJson);
							} else if (m === 'p') {
								const [h, p = port] = pParam.split(':');
								remote = connect({ hostname: h, port: +p });
								await remote.opened;
							} else if (m === 'h') {
								remote = await httpConnect(addr, port, skJson);
							}
							if (remote) break;
						} catch {}
					}

					if (!remote) return server.close();

					// 关键修复：连接成功后立即发送确认头
					server.send(new Uint8Array([versionByte, 0]));

					// 转发初始 payload
					if (remote.writable) {
						const w = remote.writable.getWriter();
						await w.write(payload);
						w.releaseLock();
					}

					// 双向转发
					remote.readable.pipeTo(new WritableStream({
						write(data) {
							if (server.readyState === 1) server.send(data);
						},
						close() { server.close(); }
					})).catch(() => server.close());

					return;
				}

				// 后续数据直接转发
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

// getSKJson / sConnect / httpConnect 函数保持上次版本不变（已验证可靠）
function getSKJson(str) { /* 同上 */ }
async function sConnect(...) { /* 同上 */ }
async function httpConnect(...) { /* 同上 */ }

function verifyUUID(data) {
	if (data.byteLength < 17) return false;
	const uuidBytes = new Uint8Array(data.buffer, data.byteOffset + 1, 16);
	return EXPECTED_UUID_BYTES.every((b, i) => b === uuidBytes[i]);
}