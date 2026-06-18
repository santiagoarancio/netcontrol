/**
 * NetControl Proxy — Termux
 * Puente entre la app (Chrome Android) y el router HG8145V5
 * Uso: node proxy.js → luego abrir http://localhost:3000
 */
const http = require('http');
const fs   = require('fs');
const url  = require('url');
const path = require('path');

const PORT       = 3000;
const ROUTER     = '192.168.100.1';
const ROUTER_PORT = 80;
let cookie = '';
let lastLogin = 0;
const SESSION_TTL = 10 * 60 * 1000;

function rq(opts, body) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('Timeout')), 8000);
    const r = http.request({
      hostname: ROUTER, port: ROUTER_PORT, ...opts,
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0',
        'Referer': `http://${ROUTER}/`,
        ...(opts.headers || {})
      }
    }, (rs) => {
      clearTimeout(to);
      const sc = rs.headers['set-cookie'];
      if (sc) cookie = sc.map(c => c.split(';')[0]).join('; ');
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => res({ status: rs.statusCode, body: d }));
    });
    r.on('error', e => { clearTimeout(to); rej(e); });
    if (body) r.write(body);
    r.end();
  });
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

async function login(u = 'root', pw = 'adminHW') {
  if (cookie && Date.now() - lastLogin < SESSION_TTL) return { ok: true, cached: true };
  const eps = [
    { path: '/login.cgi',         body: `Username=${u}&Password=${pw}` },
    { path: '/cgi-bin/login.cgi', body: `username=${u}&password=${pw}` },
    { path: '/login',             body: `username=${u}&password=${pw}` },
    { path: '/userlogin.cgi',     body: `UserName=${u}&PassWord=${pw}` },
  ];
  for (const ep of eps) {
    try {
      const r = await rq({ path: ep.path, method: 'POST' }, ep.body);
      if ((r.status === 200 || r.status === 302) && cookie) {
        lastLogin = Date.now();
        console.log(`[LOGIN OK] ${ep.path}`);
        return { ok: true, endpoint: ep.path };
      }
    } catch(e) {}
  }
  return { ok: false, error: 'No se pudo autenticar' };
}

function parseDevices(html) {
  const devs = []; const seen = new Set();
  const rr = /<tr[\s\S]*?<\/tr>/gi; let m;
  while ((m = rr.exec(html)) !== null) {
    const row = m[0];
    const mac = row.match(/([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/)?.[0]?.toUpperCase();
    const ip  = row.match(/\b(192\.168\.\d+\.\d+)\b/)?.[1];
    if (!mac || !ip || ip === ROUTER || seen.has(mac)) continue;
    seen.add(mac);
    const cells = (row.match(/<td[^>]*>([^<]+)<\/td>/g) || []).map(c => c.replace(/<[^>]+>/g, '').trim());
    const name = cells.find(t => t && t !== mac && !/^\d+$/.test(t) && !/192\.168/.test(t)) || 'Dispositivo';
    devs.push({ mac, ip, name, status: 'online' });
  }
  if (devs.length === 0) {
    const macs = [...new Set((html.match(/([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/g) || []).map(x => x.toUpperCase()))];
    const ips  = [...new Set((html.match(/\b192\.168\.\d+\.\d+\b/g) || []).filter(i => i !== ROUTER))];
    macs.forEach((mac, i) => { if (!seen.has(mac)) { seen.add(mac); devs.push({ mac, ip: ips[i] || `192.168.100.${100+i}`, name: 'Dispositivo', status: 'online' }); } });
  }
  return devs;
}

async function getDevices() {
  const pages = [
    '/html/bbsp/common/amp_dhcp_client_list.asp',
    '/html/amp_dhcp_client_list.asp',
    '/dhcpinfo.html', '/st_dhcp.html', '/Status_Lan.asp',
    '/userdevinfo.asp', '/connected_devices.html', '/cgi-bin/dhcp_clients',
  ];
  for (const pg of pages) {
    try {
      const r = await rq({ path: pg, method: 'GET' });
      if (r.status === 200 && r.body.length > 200) {
        const d = parseDevices(r.body);
        if (d.length > 0) { console.log(`[DEVICES] ${d.length} en ${pg}`); return { ok: true, devices: d, page: pg }; }
      }
    } catch(e) {}
  }
  try { const r = await rq({ path: '/', method: 'GET' }); const d = parseDevices(r.body); return { ok: d.length > 0, devices: d, page: '/' }; } catch(e) {}
  return { ok: false, devices: [], page: '' };
}

async function setMAC(mac, block) {
  const eps = ['/html/bbsp/common/amp_wifi_mac_filter.asp', '/html/amp_wifi_mac_filter.asp', '/cgi-bin/mac_filter'];
  for (const ep of eps) {
    try {
      const body = block ? `action=add&mac=${encodeURIComponent(mac)}&FilterMode=Blacklist` : `action=del&mac=${encodeURIComponent(mac)}`;
      const r = await rq({ path: ep, method: 'POST' }, body);
      if (r.status === 200) return { ok: true };
    } catch(e) {}
  }
  return { ok: false };
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }
  const p = url.parse(req.url, true).pathname;
  let body = ''; req.on('data', c => body += c); await new Promise(r => req.on('end', r));
  const params = new URLSearchParams(body);
  console.log(`[${req.method}] ${p}`);
  try {
    if (p === '/' || p === '/index.html' || p === '/app') {
      const f = path.join(__dirname, 'netcontrol-app.html');
      if (fs.existsSync(f)) {
        let html = fs.readFileSync(f, 'utf8');
        html = html.replace('let demoMode = false;', 'let demoMode = false; window.PROXY_URL = "";');
        res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(html);
      } else json(res, 404, { error: 'netcontrol-app.html no encontrado' });
    }
    else if (p === '/status') json(res, 200, { ok: true, router: ROUTER, session: !!cookie });
    else if (p === '/login') {
      const r = await login(params.get('user') || 'root', params.get('pass') || 'adminHW');
      json(res, 200, r);
    }
    else if (p === '/devices') {
      if (!cookie) await login();
      const r = await getDevices();
      json(res, 200, r);
    }
    else if (p === '/block') {
      if (!cookie) await login();
      const r = await setMAC(params.get('mac'), (params.get('action') || 'block') === 'block');
      json(res, 200, r);
    }
    else if (p === '/rawhtml') {
      if (!cookie) await login();
      const r = await rq({ path: url.parse(req.url, true).query.page || '/', method: 'GET' });
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end(r.body);
    }
    else json(res, 404, { error: 'not found' });
  } catch(e) { console.error('[ERR]', e.message); json(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => {
  console.log('\n========================================');
  console.log('  NetControl Proxy activo');
  console.log(`  Abri en Chrome: http://localhost:${PORT}`);
  console.log('  Router: http://' + ROUTER);
  console.log('  Deja Termux abierto en segundo plano');
  console.log('========================================\n');
});
