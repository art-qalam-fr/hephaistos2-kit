/**
 * comfyui-proxy — point d'entree unique :8190 pour le frontend ComfyUI.
 *
 * Portabilite : l'extension iframes toujours http://127.0.0.1:8190, jamais
 * l'URL directe — c'est ce proxy qui choisit le backend par requete :
 *   1. COMFYUI_BACKEND explicite (ex. https://comfi.exemple.fr distant),
 *   2. ComfyUI local 127.0.0.1:8000 s'il repond,
 *   3. COMFYUI_REMOTE en repli (tunnel distant, optionnel).
 *
 * HTTP : forward generique (headers preserves, Set-Cookie reecrit en path=/).
 * WS   : upgrade TCP brut — le /ws de ComfyUI (queue, progress, previews)
 *        traverse le proxy comme un vrai socket, pas de polling.
 *
 * Env : COMFYUI_PROXY_PORT (def. 8190), COMFYUI_LOCAL (def. http://127.0.0.1:8000),
 *       COMFYUI_BACKEND, COMFYUI_REMOTE.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.COMFYUI_PROXY_PORT || 8190);
const LOCAL = process.env.COMFYUI_LOCAL || 'http://127.0.0.1:8000';
const FIXED = process.env.COMFYUI_BACKEND || '';
const REMOTE = process.env.COMFYUI_REMOTE || '';

// Mode de routage : 'auto' (local d'abord, remote en repli), 'local' ou
// 'remote' forcés. Persisté dans ~/.hephaistos/comfyui-mode.json pour
// survivre aux restarts du proxy. Pilotable via GET/POST /ctl/mode.
const MODE_FILE = path.join(os.homedir(), '.hephaistos', 'comfyui-mode.json');
const MODES = new Set(['auto', 'local', 'remote']);
let mode = MODES.has(process.env.COMFYUI_MODE) ? process.env.COMFYUI_MODE : 'auto';
try {
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    if (!process.env.COMFYUI_MODE && MODES.has(saved.mode)) mode = saved.mode;
} catch { /* pas de fichier : auto */ }

let cachedBackend = null;
let cachedAt = 0;

function probe(url) {
    return new Promise((resolve) => {
        try {
            const u = new URL(url);
            const mod = u.protocol === 'https:' ? 'node:https' : 'node:http';
            import(mod).then((m) => {
                const req = m.request(u, { method: 'HEAD', timeout: 3000 }, (res) => {
                    res.resume();
                    // 530 = Cloudflare "origin unreachable" : le tunnel repond
                    // mais rien ne tourne derriere -> compter comme down.
                    resolve(res.statusCode > 0 && res.statusCode !== 530);
                });
                req.on('timeout', () => { req.destroy(); resolve(false); });
                req.on('error', () => resolve(false));
                req.end();
            }).catch(() => resolve(false));
        } catch { resolve(false); }
    });
}

async function pickBackend() {
    if (FIXED) return FIXED.replace(/\/+$/, '');
    if (mode === 'local') return LOCAL;
    if (mode === 'remote') return REMOTE || null;
    if (cachedBackend && Date.now() - cachedAt < 15000) return cachedBackend;
    let backend = null;
    if (await probe(LOCAL)) backend = LOCAL;
    else if (REMOTE && await probe(REMOTE)) backend = REMOTE;
    if (backend) { cachedBackend = backend; cachedAt = Date.now(); }
    return backend;
}

async function ctlState() {
    const [localUp, remoteUp] = await Promise.all([probe(LOCAL), REMOTE ? probe(REMOTE) : false]);
    return { ok: true, mode, backend: await pickBackend(), local: LOCAL, remote: REMOTE || null, localUp, remoteUp };
}

function saveMode(m) {
    try {
        fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
        fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: m }));
    } catch { /* non bloquant */ }
}

const server = http.createServer(async (req, res) => {
    // Controle du mode de routage (auto|local|remote) — loopback only.
    if (req.url === '/ctl/mode') {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', async () => {
                try {
                    const m = JSON.parse(body || '{}').mode;
                    if (!MODES.has(m)) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: `mode invalide: ${m}` }));
                        return;
                    }
                    mode = m; cachedBackend = null; saveMode(m);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(await ctlState()));
                } catch (e) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: String(e) }));
                }
            });
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await ctlState()));
        return;
    }
    const backend = await pickBackend();
    if (!backend) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Aucun backend ComfyUI joignable (local :8000 KO, COMFYUI_REMOTE absent).' }));
        return;
    }
    const target = new URL(req.url, backend);
    const mod = target.protocol === 'https:' ? (await import('node:https')).default : http;
    const headers = { ...req.headers, host: target.host };
    delete headers['if-none-match']; // les caches 304 stale cassent les previews
    // ComfyUI >=0.4x rejette les requetes cross-site (403 en iframe webview) :
    // on lisse les entetes fetch pour que l'upstream voie une requete neutre.
    for (const h of Object.keys(headers)) {
        if (h.startsWith('sec-fetch-') || h === 'origin' || h === 'referer') delete headers[h];
    }
    const upstream = mod.request(target, { method: req.method, headers }, (up) => {
        const out = { ...up.headers };
        if (out['set-cookie']) {
            out['set-cookie'] = (Array.isArray(out['set-cookie']) ? out['set-cookie'] : [out['set-cookie']])
                .map((c) => c.replace(/;\s*Domain=[^;]+/i, '').replace(/;\s*Secure/i, ''));
        }
        res.writeHead(up.statusCode, out);
        up.pipe(res);
    });
    upstream.on('error', (e) => {
        cachedBackend = null; // re-probe a la prochaine requete
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `backend ${backend} : ${e.message}` }));
    });
    req.pipe(upstream);
});

// WebSocket /ws — upgrade brut : on ecrit la requete telle quelle sur le
// socket backend puis on pipe dans les deux sens.
server.on('upgrade', async (req, client, head) => {
    const backend = await pickBackend();
    if (!backend) { client.destroy(); return; }
    const u = new URL(backend);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const upstream = net.connect(port, u.hostname, () => {
        const headers = Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${v}`).join('\r\n');
        upstream.write(`GET ${req.url} HTTP/1.1\r\nHost: ${u.host}\r\n${headers}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => { cachedBackend = null; client.destroy(); });
    client.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () =>
    console.log(`comfyui-proxy on :${PORT} (mode: ${mode}, local: ${LOCAL}${REMOTE ? `, remote: ${REMOTE}` : ''}${FIXED ? `, fixed: ${FIXED}` : ''})`));
