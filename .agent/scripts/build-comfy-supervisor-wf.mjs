// build-comfy-supervisor-wf.mjs — installe/maj le workflow "Comfy Render Supervisor"
// dans le n8n de Babel. Actions: status | warmup | render | shutdown.
// Auth webhook: headerAuth "Hephaistos Bridge". Exec: n8n-sandbox-local :18080
// (x-api-key = N8N_SANDBOX_SERVICE_API_KEY, déjà dans l'env du n8n de Babel).
// MCP: POST :8767/mcp (kaggle__*). Tunnel: X-Hephaistos-Token = KAGGLE_COMFY_TOKEN.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DB = process.env.N8N_DB || path.join(os.homedir(), '.n8n', 'database.sqlite');
const WF_ID = 'comfySupv01render01';
const WEBHOOK_PATH = 'comfy-render';
const BRIDGE_CRED = { httpHeaderAuth: { id: '4ae21b16-46a3-40d9-9635-28717f0e0fce', name: 'Hephaistos Bridge' } };
const TUNNEL = process.env.COMFY_TUNNEL || 'https://comfyui.example.invalid';
const TOKEN_EXPR = '={{ $env.KAGGLE_COMFY_TOKEN }}';
// Dossier des kernels poussables (notebook+metadata+patch_tunnel par profile).
// Chemin machine → variable d'env requise sur la machine qui build/push.
const PATCH_BASE = (process.env.COMFY_PATCH_BASE || '').replace(/\\/g, '/');
// kernel -> { dir de push (notebook+metadata+patch_tunnel), profile manifest par defaut }
const KDIRS = {
    'comfyui-batch-gpu':   { dir: `${PATCH_BASE}/kaggle`,          profile: 'video' },
    'comfyui-flux-gpu':    { dir: `${PATCH_BASE}/kaggle-flux`,     profile: 'flux' },
    'comfyui-wan-gpu':     { dir: `${PATCH_BASE}/kaggle-wan`,      profile: 'wan' },
    'comfyui-hunyuan-gpu': { dir: `${PATCH_BASE}/kaggle-hunyuan`,  profile: 'hunyuan' },
};
const OUTDIR = process.env.COMFY_OUTDIR || 'ComfyUI_outputs/n8n';

const uuid = () => crypto.randomUUID();
const node = (o) => o;

// Helper partagé (dupliqué dans les Code nodes — n8n n'a pas de fonctions communes)
const SBX = `// Exec via n8n-sandbox-local :18080 (bash host, env hérité)
// Clé lue depuis api-key.txt (fs autorisé) — N8N_SANDBOX_SERVICE_API_KEY n'existe
// que si n8n a été lancé via n8n-run.cmd, pas fiable.
const SBX_KEY = ($env.N8N_SANDBOX_SERVICE_API_KEY || require('fs').readFileSync($env.N8N_SANDBOX_KEY_FILE || (process.env.ProgramFiles || 'C:/Program Files') + '/servers/n8n-sandbox-local/api-key.txt', 'utf8')).trim();
const sbx = async (command, timeoutMs = 120000) => {
  const H = { 'x-api-key': SBX_KEY, 'Content-Type': 'application/json' };
  const base = 'http://127.0.0.1:18080';
  await this.helpers.httpRequest({ method: 'POST', url: base + '/sandboxes', headers: H,
    body: JSON.stringify({ id: 'comfy-supervisor' }), timeout: 15000, returnFullResponse: true, ignoreHttpStatusErrors: true });
  // Credentials kaggle : KAGGLE_API_TOKEN (env utilisateur, transmis au sandbox).
  // L'access_token fichier est un token OAuth différent — ne pas l'utiliser.
  const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1');
  const env = { HOME: home, KAGGLE_CONFIG_DIR: home + '/.kaggle' };
  if ($env.KAGGLE_API_TOKEN) env.KAGGLE_API_TOKEN = $env.KAGGLE_API_TOKEN;
  if ($env.KAGGLE_USERNAME) env.KAGGLE_USERNAME = $env.KAGGLE_USERNAME;
  if ($env.KAGGLE_KEY) env.KAGGLE_KEY = $env.KAGGLE_KEY;
  if ($env.KAGGLE_COMFY_TOKEN) env.KAGGLE_COMFY_TOKEN = $env.KAGGLE_COMFY_TOKEN;
  const nd = await this.helpers.httpRequest({ method: 'POST', url: base + '/sandboxes/comfy-supervisor/executions',
    headers: H, body: JSON.stringify({ command, timeout_ms: timeoutMs, env }), timeout: timeoutMs + 30000 });
  const events = String(nd).trim().split('\\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const exit = events.find(e => e.type === 'exit') || {};
  const stdout = events.filter(e => e.type === 'stdout').map(e => e.data || '').join('');
  const stderr = events.filter(e => e.type === 'stderr').map(e => e.data || '').join('');
  return { code: exit.exit_code ?? -1, success: exit.success === true, stdout, stderr };
};`;

const nodes = [
    node({
        parameters: { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'responseNode', authentication: 'headerAuth', options: {} },
        id: uuid(), name: 'WebhookComfy', type: 'n8n-nodes-base.webhook', typeVersion: 2,
        webhookId: 'comfy-render-svc', position: [-920, 300], credentials: BRIDGE_CRED,
    }),
    node({
        parameters: {
            jsCode: `// Parse la requête : action + options. actions: status|warmup|render|shutdown
const body = ($json.body && typeof $json.body === 'object') ? $json.body : $json;
let merged = body;
// Chemin svc/* : le runner envoie {prompt:"<sortie agent>"} — l'agent embarque
// un JSON {action,kernel,profile,workflow,...} dans le texte. On l'extrait.
if (!body.action && typeof body.prompt === 'string') {
  let j = null;
  try { j = JSON.parse(body.prompt); } catch {}
  if (!j) {
    const a = body.prompt.indexOf('{'), b = body.prompt.lastIndexOf('}');
    if (a >= 0 && b > a) { try { j = JSON.parse(body.prompt.slice(a, b + 1)); } catch {} }
  }
  if (j && typeof j === 'object' && !Array.isArray(j)) merged = { ...body, ...j };
}
const action = String(merged.action || 'status').toLowerCase();
const KDIRS = ${JSON.stringify(KDIRS)};
const kernel = String(merged.kernel || 'comfyui-batch-gpu');
const ctx = {
  action,
  kernel,
  profile: merged.profile || KDIRS[kernel].profile,
  workflow: merged.workflow || null,
  maxWaitMin: Number(merged.maxWaitMin) || 10,
  renderWaitMin: Number(merged.renderWaitMin) || 20,
  pollSec: Number(merged.pollSec) || 15,
  keepAlive: merged.keepAlive === true,
  outDir: merged.outDir || ${JSON.stringify(OUTDIR)},
};
if (!['status','warmup','render','shutdown'].includes(action)) {
  throw new Error('action invalide: ' + action + ' (status|warmup|render|shutdown)');
}
if (!KDIRS[kernel]) {
  throw new Error('kernel invalide: ' + kernel + ' (' + Object.keys(KDIRS).join('|') + ')');
}
if (action === 'render' && (!ctx.workflow || typeof ctx.workflow !== 'object')) {
  throw new Error('action=render exige {workflow: <json API ComfyUI>} dans le body (ou JSON embarque dans prompt)');
}
return [{ json: ctx }];`,
        },
        id: uuid(), name: 'Parse', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-700, 300],
    }),
    node({
        parameters: {
            method: 'GET', url: `${TUNNEL}/system_stats`,
            sendHeaders: true,
            headerParameters: { parameters: [{ name: 'X-Hephaistos-Token', value: TOKEN_EXPR }] },
            options: { response: { response: { neverError: true } }, timeout: 15000 },
        },
        id: uuid(), name: 'CheckTunnel', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [-480, 300],
    }),
    node({
        parameters: {
            rules: {
                values: [
                    { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'c1', leftValue: '={{ $("Parse").item.json.action }}', rightValue: 'status', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'status' },
                    { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'c2', leftValue: '={{ $("Parse").item.json.action }}', rightValue: 'shutdown', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'shutdown' },
                ],
            },
            options: { fallbackOutput: 'extra', renameFallbackOutput: 'run' },
        },
        id: uuid(), name: 'Dispatch', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [-260, 300],
    }),
    // ── branche status : état kernel via MCP kaggle (mux :8767) ──
    node({
        parameters: {
            jsCode: `// Statut kernel via MCP mux :8767 (tools/call kaggle__kernel_session_status)
let kernel = null;
const kslug = ($('Parse').item.json.kernel || 'comfyui-batch-gpu');
try {
  const rpc = await this.helpers.httpRequest({ method: 'POST', url: 'http://127.0.0.1:8767/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'kaggle__kernel_session_status', arguments: { user_name: $env.KAGGLE_USERNAME || '', kernel_slug: kslug } } }),
    timeout: 30000 });
  const line = String(rpc).split('\\n').find(l => l.startsWith('data: '));
  if (line) { const j = JSON.parse(line.slice(6)); kernel = j.result || j.error || j; }
} catch (e) { kernel = { error: String(e) }; }
const up = Boolean($('CheckTunnel').item.json && ($('CheckTunnel').item.json.system || $('CheckTunnel').item.json.statusCode === 200));
return [{ json: { action: 'status', tunnelUp: up, kernel } }];`,
        },
        id: uuid(), name: 'KernelStatus', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-40, 80],
    }),
    // ── branche run (warmup|render) ──
    node({
        parameters: {
            conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
                conditions: [{ id: 'up', leftValue: '={{ Boolean($json.system) || Boolean($json.devices) || $json.statusCode === 200 }}', rightValue: true, operator: { type: 'boolean', operation: 'true' } }],
                combinator: 'and',
            },
        },
        id: uuid(), name: 'IfTunnelUp', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [-40, 500],
    }),
    node({
        parameters: {
            jsCode: SBX + `
const ctx = $('Parse').item.json;
const KDIRS = ${JSON.stringify(KDIRS)};
const kdir = (KDIRS[ctx.kernel] || KDIRS['comfyui-batch-gpu']).dir;
const cmd = 'cd "' + kdir + '" && KAGGLE_NOWAIT=1 CF_PROFILE=' + ctx.profile + ' python patch_tunnel.py';
const r = await sbx(cmd, 240000); // NOWAIT=1 : patch + push seul (~2min), le wait est dans WaitTunnel
return [{ json: { pushCode: r.code, pushOk: r.success, pushLog: (r.stdout + ' ' + r.stderr).slice(-1200), action: ctx.action } }];`,
        },
        id: uuid(), name: 'PushKernel', type: 'n8n-nodes-base.code', typeVersion: 2, position: [180, 640],
    }),
    node({
        parameters: {
            jsCode: `// Poll tunnel borné à 240s/invocation (limite task-runner 300s) — reboucle via IfIter.
const ctx = $('Parse').item.json, BUDGET = 240000;
const iter = ($json.iter || 0) + 1;
const maxIter = Math.max(1, Math.ceil(ctx.maxWaitMin * 60000 / BUDGET));
const deadline = Date.now() + BUDGET, poll = ctx.pollSec;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let up = false, last = 0;
while (Date.now() < deadline) {
  try {
    const r = await this.helpers.httpRequest({ method: 'GET', url: ${JSON.stringify(TUNNEL)} + '/system_stats',
      headers: { 'X-Hephaistos-Token': $env.KAGGLE_COMFY_TOKEN || '' },
      timeout: 15000, returnFullResponse: true, ignoreHttpStatusErrors: true });
    last = r.statusCode; if (r.statusCode === 200) { up = true; break; }
  } catch (e) { last = -1; }
  await sleep(poll * 1000);
}
return [{ json: { tunnelUp: up, lastStatus: last, iter, maxIter, pushCode: $json.pushCode, pushLog: $json.pushLog } }];`,
        },
        id: uuid(), name: 'WaitTunnel', type: 'n8n-nodes-base.code', typeVersion: 2, position: [420, 640],
    }),
    node({
        parameters: {
            conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
                conditions: [{ id: 'up', leftValue: '={{ $json.tunnelUp }}', rightValue: true, operator: { type: 'boolean', operation: 'true' } }],
                combinator: 'and',
            },
        },
        id: uuid(), name: 'IfTunnelNow', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [560, 760],
    }),
    node({
        parameters: {
            conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
                conditions: [{ id: 'i', leftValue: '={{ $json.iter }}', rightValue: '={{ $json.maxIter }}', operator: { type: 'number', operation: 'lt' } }],
                combinator: 'and',
            },
        },
        id: uuid(), name: 'IfIterT', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [780, 760],
    }),
    node({
        parameters: {},
        id: uuid(), name: 'MergeUp', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [640, 500],
    }),
    node({
        parameters: {
            conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
                conditions: [{ id: 'r', leftValue: '={{ $("Parse").item.json.action }}', rightValue: 'render', operator: { type: 'string', operation: 'equals' } }],
                combinator: 'and',
            },
        },
        id: uuid(), name: 'IfRender', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [860, 500],
    }),
    node({
        parameters: {
            jsCode: `// Soumet le workflow ComfyUI (format API), poll /history, télécharge les sorties (fs autorisé).
const ctx = $('Parse').item.json;
const fs = require('fs'); const path = require('path');
const TOK = $env.KAGGLE_COMFY_TOKEN || '';
const H = { 'X-Hephaistos-Token': TOK, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BUDGET = 240000;
const riter = ($json.riter || 0) + 1;
const rmax = Math.max(1, Math.ceil(ctx.renderWaitMin * 60000 / BUDGET));
let pid = $json.promptId || null;
if (!pid) {
  const sub = await this.helpers.httpRequest({ method: 'POST', url: ${JSON.stringify(TUNNEL)} + '/prompt',
    headers: H, body: JSON.stringify({ prompt: ctx.workflow }), timeout: 30000 });
  pid = (sub && (sub.prompt_id || sub.promptId)) || null;
  if (!pid) throw new Error('POST /prompt rejeté: ' + JSON.stringify(sub).slice(0, 300));
}
const deadline = Date.now() + BUDGET;
let files = [], done = false;
while (Date.now() < deadline) {
  await sleep(ctx.pollSec * 1000);
  const h = await this.helpers.httpRequest({ method: 'GET', url: ${JSON.stringify(TUNNEL)} + '/history/' + pid,
    headers: { 'X-Hephaistos-Token': TOK }, timeout: 20000 });
  const run = h && h[pid];
  if (run && run.outputs) {
    for (const nid of Object.keys(run.outputs)) {
      const out = run.outputs[nid];
      for (const k of ['images','gifs','videos']) {
        for (const f of (out[k] || [])) {
          const q = 'filename=' + encodeURIComponent(f.filename) + '&subfolder=' + encodeURIComponent(f.subfolder || '') + '&type=' + (f.type || 'output');
          files.push({ file: f.filename, url: '/view?' + q });
        }
      }
    }
    done = files.length > 0 || (run.status && run.status.completed === true);
    if (done) break;
  }
}
// Téléchargement direct en fs (NODE_FUNCTION_ALLOW_BUILTIN=fs,path,os) — seulement si done
const saved = [], failed = [];
if (done) fs.mkdirSync(ctx.outDir, { recursive: true });
for (const f of files) {
  try {
    const buf = await this.helpers.httpRequest({ method: 'GET', url: ${JSON.stringify(TUNNEL)} + f.url,
      headers: { 'X-Hephaistos-Token': TOK }, encoding: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(path.join(ctx.outDir, f.file), Buffer.from(buf));
    saved.push(f.file);
  } catch (e) { failed.push(f.file + ': ' + String(e).slice(0, 80)); }
}
return [{ json: { promptId: pid, renderDone: done, files, saved, failed, outDir: ctx.outDir, riter, rmax } }];`,
        },
        id: uuid(), name: 'RenderDownload', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1080, 420],
    }),
    node({
        parameters: {
            conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
                conditions: [{ id: 'd', leftValue: '={{ $json.renderDone }}', rightValue: true, operator: { type: 'boolean', operation: 'true' } }],
                combinator: 'and',
            },
        },
        id: uuid(), name: 'IfRDone', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [1260, 420],
    }),
    node({
        parameters: {
            conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
                conditions: [{ id: 'i', leftValue: '={{ $json.riter }}', rightValue: '={{ $json.rmax }}', operator: { type: 'number', operation: 'lt' } }],
                combinator: 'and',
            },
        },
        id: uuid(), name: 'IfIterR', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [1440, 520],
    }),
    // Auto-clôture GPU après render (sauf keepAlive) : /shutdown + kernels stop
    node({
        parameters: {
            jsCode: SBX + `
const ctx = $('Parse').item.json;
if (ctx.keepAlive) return [{ json: { autoShutdown: false } }];
const TOK = $env.KAGGLE_COMFY_TOKEN || '';
let sdHttp = null;
try {
  await this.helpers.httpRequest({ method: 'POST', url: ${JSON.stringify(TUNNEL)} + '/shutdown',
    headers: { 'X-Hephaistos-Token': TOK }, timeout: 15000 });
  sdHttp = 200;
} catch (e) { sdHttp = String(e).slice(0, 80); }
const r = await sbx('yes | kaggle kernels stop ' + ($env.KAGGLE_USERNAME || '') + '/' + ctx.kernel, 120000);
return [{ json: { autoShutdown: true, shutdownHttp: sdHttp, stopCode: r.code, stopLog: (r.stdout + ' ' + r.stderr).slice(-600) } }];`,
        },
        id: uuid(), name: 'AutoShutdown', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1500, 420],
    }),
    // ── branche shutdown ──
    node({
        parameters: {
            method: 'POST', url: `${TUNNEL}/shutdown`,
            sendHeaders: true,
            headerParameters: { parameters: [{ name: 'X-Hephaistos-Token', value: TOKEN_EXPR }] },
            options: { response: { response: { neverError: true } }, timeout: 15000 },
        },
        id: uuid(), name: 'ShutdownGuard', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [-40, 160],
    }),
    node({
        parameters: {
            jsCode: SBX + `
const ctx = $('Parse').item.json;
const r = await sbx('yes | kaggle kernels stop ' + ($env.KAGGLE_USERNAME || '') + '/' + ctx.kernel, 120000);
return [{ json: { stopCode: r.code, stopLog: (r.stdout + ' ' + r.stderr).slice(-600) } }];`,
        },
        id: uuid(), name: 'StopKernel', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 160],
    }),
    node({
        parameters: {
            jsCode: `// Rapport final pour toutes les branches.
const ctx = $('Parse').item.json;
const parts = { action: ctx.action, profile: ctx.profile, kernel: ctx.kernel };
for (const k of ['statusCode','tunnelUp','lastStatus','kernel','promptId','renderDone','files','saved','failed','outDir','pushCode','pushOk','pushLog','stopCode','stopLog','dlLog','autoShutdown','shutdownHttp']) {
  if ($json[k] !== undefined) parts[k] = $json[k];
}
try { parts.tunnelBefore = ($('CheckTunnel').item.json.system || $('CheckTunnel').item.json.devices) ? 200 : $('CheckTunnel').item.json.statusCode; } catch {}
try { parts.shutdownHttp = $('ShutdownGuard').item.json.statusCode; } catch {}
parts.ok = ctx.action === 'status' ? parts.tunnelBefore === 200
  : ctx.action === 'shutdown' ? true
  : ctx.action === 'render' ? Boolean(parts.renderDone && !(parts.failed || []).length)
  : Boolean(parts.tunnelUp ?? parts.tunnelBefore === 200);
parts.at = new Date().toISOString();
return [{ json: parts }];`,
        },
        id: uuid(), name: 'Report', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1500, 300],
    }),
    node({
        parameters: { respondWith: 'json', responseBody: '={{ $json }}' },
        id: uuid(), name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [1720, 300],
    }),
];

const connections = {
    WebhookComfy: { main: [[{ node: 'Parse', type: 'main', index: 0 }]] },
    Parse: { main: [[{ node: 'CheckTunnel', type: 'main', index: 0 }]] },
    CheckTunnel: { main: [[{ node: 'Dispatch', type: 'main', index: 0 }]] },
    Dispatch: {
        main: [
            [{ node: 'KernelStatus', type: 'main', index: 0 }],        // status → MCP kernel status
            [{ node: 'ShutdownGuard', type: 'main', index: 0 }],       // shutdown
            [{ node: 'IfTunnelUp', type: 'main', index: 0 }],          // fallback warmup|render
        ],
    },
    KernelStatus: { main: [[{ node: 'Report', type: 'main', index: 0 }]] },
    IfTunnelUp: {
        main: [
            [{ node: 'MergeUp', type: 'main', index: 0 }],             // tunnel déjà up
            [{ node: 'PushKernel', type: 'main', index: 0 }],          // down → patch_tunnel + push
        ],
    },
    PushKernel: { main: [[{ node: 'WaitTunnel', type: 'main', index: 0 }]] },
    WaitTunnel: { main: [[{ node: 'IfTunnelNow', type: 'main', index: 0 }]] },
    IfTunnelNow: { main: [
        [{ node: 'MergeUp', type: 'main', index: 1 }],        // tunnel up
        [{ node: 'IfIterT', type: 'main', index: 0 }],        // pas encore up
    ] },
    IfIterT: { main: [
        [{ node: 'WaitTunnel', type: 'main', index: 0 }],     // reboucle (budget 240s/itération)
        [{ node: 'Report', type: 'main', index: 0 }],         // timeout → rapport d'échec
    ] },
    MergeUp: { main: [[{ node: 'IfRender', type: 'main', index: 0 }]] },
    IfRender: {
        main: [
            [{ node: 'RenderDownload', type: 'main', index: 0 }],      // action=render
            [{ node: 'Report', type: 'main', index: 0 }],              // action=warmup → rapport
        ],
    },
    RenderDownload: { main: [[{ node: 'IfRDone', type: 'main', index: 0 }]] },
    IfRDone: { main: [
        [{ node: 'AutoShutdown', type: 'main', index: 0 }],   // rendu terminé → clôture GPU (sauf keepAlive)
        [{ node: 'IfIterR', type: 'main', index: 0 }],        // pas fini → reboucle ou timeout
    ] },
    AutoShutdown: { main: [[{ node: 'Report', type: 'main', index: 0 }]] },
    IfIterR: { main: [
        [{ node: 'RenderDownload', type: 'main', index: 0 }], // reboucle poll /history
        [{ node: 'Report', type: 'main', index: 0 }],         // timeout → rapport d'échec
    ] },
    ShutdownGuard: { main: [[{ node: 'StopKernel', type: 'main', index: 0 }]] },
    StopKernel: { main: [[{ node: 'Report', type: 'main', index: 0 }]] },
    Report: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] },
};

const db = new DatabaseSync(DB);
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const existing = db.prepare('SELECT id, active FROM workflow_entity WHERE id = ?').get(WF_ID);
const versionId = uuid();
if (existing) {
    db.prepare('UPDATE workflow_entity SET nodes=?, connections=?, versionId=?, updatedAt=? WHERE id=?')
        .run(JSON.stringify(nodes), JSON.stringify(connections), versionId, now, WF_ID);
    console.log('UPDATED', WF_ID);
} else {
    db.prepare(`INSERT INTO workflow_entity
        (id, name, active, nodes, connections, settings, staticData, pinData, versionId, triggerCount, createdAt, updatedAt, isArchived, versionCounter)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(WF_ID, 'Comfy Render Supervisor', 1, JSON.stringify(nodes), JSON.stringify(connections),
            JSON.stringify({ executionOrder: 'v1' }), null, null, versionId, 1, now, now, 0, 1);
    db.prepare("INSERT OR REPLACE INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt) VALUES (?,'ntOu5whDa1jU2U4X','workflow:owner',?,?)")
        .run(WF_ID, now, now);
    console.log('INSERTED', WF_ID);
}
// publish : history + published_version + activeVersionId
db.prepare('INSERT INTO workflow_history (versionId, workflowId, authors, createdAt, updatedAt, nodes, connections, name, autosaved) VALUES (?,?,?,?,?,?,?,?,0)')
    .run(versionId, WF_ID, 'devin', now, now, JSON.stringify(nodes), JSON.stringify(connections), 'Comfy Render Supervisor');
db.prepare('INSERT OR REPLACE INTO workflow_published_version (workflowId, publishedVersionId, createdAt, updatedAt) VALUES (?,?,?,?)')
    .run(WF_ID, versionId, now, now);
db.prepare('UPDATE workflow_entity SET activeVersionId=?, active=1 WHERE id=?').run(versionId, WF_ID);
db.close();
console.log('OK — actif+publié, webhook:', `POST http://127.0.0.1:5678/webhook/${WEBHOOK_PATH}`);
console.log('nodes:', nodes.length, '| versionId:', versionId);
