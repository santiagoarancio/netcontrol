/**
 * NetControl Proxy — Node.js
 * Corre en tu PC y sirve como puente entre la app (celular) y el router
 * 
 * Uso: node proxy.js
 * Luego abrís: http://TU_IP_LOCAL:3000
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ROUTER_IP = '192.168.100.1';
const ROUTER_PORT = 80;

// ── Sesión del router ──────────────────────────────────────────────────────
let sessionCookie = '';

// ── Helper: request al router ─────────────────────────────────────────────
function routerRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ROUTER_IP,
      port: ROUTER_PORT,
      ...options,
      headers: {
        'Cookie': sessionCookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'NetControl/1.0',
        ...(options.headers || {}),
      }
    }, (res) => {
      // Guardar cookies de sesión
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        sessionCookie = setCookie.map(c => c.split(';')[0]).join('; ');
        console.log('Cookie de sesión guardada:', sessionCookie);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Encontrar URLs reales del router ──────────────────────────────────────
async function findRouterPages() {
  const pagesToTry = [
    '/userlogin.html',
    '/login.html', 
    '/index.html',
    '/cgi-bin/luci',
    '/home.asp',
    '/main.asp',
  ];
  
  for (const p of pagesToTry) {
    try {
      const r = await routerRequest({ path: p, method: 'GET' });
      if (r.status === 200) {
        console.log(`Página encontrada: ${p}`);
        return p;
      }
    } catch(e) {}
  }
  return '/';
}

// ── Login al router ────────────────────────────────────────────────────────
async function loginRouter(user, pass) {
  // Intentar diferentes endpoints de login según firmware
  const loginEndpoints = [
    { path: '/login.cgi',        body: `Username=${user}&Password=${pass}` },
    { path: '/cgi-bin/login.cgi',body: `username=${user}&password=${pass}` },
    { path: '/login',            body: `username=${user}&password=${pass}&submit=Login` },
    { path: '/userlogin.cgi',    body: `UserName=${user}&PassWord=${pass}` },
    { path: '/cgi-bin/luci',     body: `luci_username=${user}&luci_password=${pass}` },
  ];

  for (const ep of loginEndpoints) {
    try {
      console.log(`Intentando login en: ${ep.path}`);
      const r = await routerRequest({
        path: ep.path,
        method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(ep.body) }
      }, ep.body);
      
      console.log(`  Status: ${r.status}, Cookie: ${sessionCookie ? 'sí' : 'no'}`);
      
      if (r.status === 200 || r.status === 302 || r.status === 301) {
        if (sessionCookie || r.headers.location) {
          console.log('Login exitoso en:', ep.path);
          return { ok: true, endpoint: ep.path };
        }
      }
    } catch(e) {
      console.log(`  Error: ${e.message}`);
    }
  }
  return { ok: false };
}

// ── Obtener dispositivos DHCP ──────────────────────────────────────────────
async function getDevices() {
  const dhcpPages = [
    '/html/bbsp/common/amp_dhcp_client_list.asp',
    '/html/amp_dhcp_client_list.asp',
    '/cgi-bin/dhcp_clients',
    '/dhcpinfo.html',
    '/DHCPTable.asp',
    '/connected_devices.html',
    '/st_dhcp.html',
    '/Status_Lan.asp',
  ];

  for (const p of dhcpPages) {
    try {
      const r = await routerRequest({ path: p, method: 'GET' });
      if (r.status === 200 && r.body.length > 100) {
        console.log(`Dispositivos encontrados en: ${p}`);
        return { ok: true, html: r.body, page: p };
      }
    } catch(e) {}
  }

  // Intentar la página principal y buscar tabla ARP
  try {
    const r = await routerRequest({ path: '/', method: 'GET' });
    return { ok: true, html: r.body, page: '/' };
  } catch(e) {}

  return { ok: false, html: '', page: '' };
}

// ── Parsear dispositivos del HTML ──────────────────────────────────────────
function parseDevices(html) {
  const devices = [];
  
  // Patrón MAC universal
  const macPattern = /([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/g;
  const ipPattern = /192\.168\.\d{1,3}\.\d{1,3}/g;
  
  const macs = [...new Set(html.match(macPattern) || [])];
  const ips  = [...new Set(html.match(ipPattern) || [])].filter(ip => ip !== '192.168.100.1');
  
  // Intentar extraer por filas de tabla
  const rowReg = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowReg.exec(html)) !== null) {
    const row = match[1];
    const mac = row.match(/([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/)?.[0];
    const ip  = row.match(/192\.168\.\d+\.\d+/)?.[0];
    const nameMatch = row.match(/<td[^>]*>([a-zA-Z0-9\-_\.]+)<\/td>/g);
    
    if (mac && ip && ip !== '192.168.100.1') {
      const name = nameMatch?.[0]?.replace(/<[^>]+>/g, '').trim() || 'Dispositivo';
      if (!devices.find(d => d.mac === mac)) {
        devices.push({ mac, ip, name, status: 'online' });
      }
    }
  }
  
  // Fallback: combinar MACs e IPs encontradas
  if (devices.length === 0 && macs.length > 0) {
    macs.forEach((mac, i) => {
      devices.push({
        mac,
        ip: ips[i] || `192.168.100.${10 + i}`,
        name: 'Dispositivo',
        status: 'online'
      });
    });
  }
  
  return devices;
}

// ── Bloquear/desbloquear MAC ───────────────────────────────────────────────
async function blockMAC(mac, block = true) {
  const endpoints = [
    '/html/bbsp/common/amp_wifi_mac_filter.asp',
    '/cgi-bin/mac_filter',
    '/wifiMacFilter.cgi',
  ];

  for (const ep of endpoints) {
    try {
      const body = block
        ? `action=add&mac=${encodeURIComponent(mac)}&FilterMode=Blacklist`
        : `action=del&mac=${encodeURIComponent(mac)}`;
      
      const r = await routerRequest({
        path: ep, method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(body) }
      }, body);
      
      if (r.status === 200) return { ok: true };
    } catch(e) {}
  }
  return { ok: false };
}

// ── Servidor HTTP ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS — permite requests desde cualquier origen
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  const parsed = url.parse(req.url, true);
  const route  = parsed.pathname;

  // Leer body POST
  let body = '';
  req.on('data', chunk => body += chunk);
  await new Promise(r => req.on('end', r));
  const params = new URLSearchParams(body);

  console.log(`${req.method} ${route}`);

  try {
    // ── GET /status ──────────────────────────────────────────────────────
    if (route === '/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        router: ROUTER_IP,
        session: !!sessionCookie,
        version: '1.0'
      }));

    // ── POST /login ──────────────────────────────────────────────────────
    } else if (route === '/login' && req.method === 'POST') {
      const user = params.get('user') || 'root';
      const pass = params.get('pass') || 'adminHW';
      const result = await loginRouter(user, pass);
      res.writeHead(200);
      res.end(JSON.stringify(result));

    // ── GET /devices ─────────────────────────────────────────────────────
    } else if (route === '/devices') {
      const result = await getDevices();
      const devices = result.ok ? parseDevices(result.html) : [];
      res.writeHead(200);
      res.end(JSON.stringify({ ok: result.ok, devices, page: result.page, count: devices.length }));

    // ── GET /rawhtml — para debugging ────────────────────────────────────
    } else if (route === '/rawhtml') {
      const page = parsed.query.page || '/';
      const r = await routerRequest({ path: page, method: 'GET' });
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(r.body);

    // ── POST /block ───────────────────────────────────────────────────────
    } else if (route === '/block' && req.method === 'POST') {
      const mac    = params.get('mac');
      const action = params.get('action') || 'block';
      const result = await blockMAC(mac, action === 'block');
      res.writeHead(200);
      res.end(JSON.stringify(result));

    // ── GET / — servir la app HTML ────────────────────────────────────────
    } else if (route === '/' || route === '/index.html') {
      const appPath = path.join(__dirname, 'netcontrol-app.html');
      if (fs.existsSync(appPath)) {
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(fs.readFileSync(appPath));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'netcontrol-app.html no encontrado en la misma carpeta' }));
      }

    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
    }

  } catch(e) {
    console.error('Error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // Obtener IP local
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
      }
    }
  }

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       NetControl Proxy v1.0          ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  PC:     http://localhost:${PORT}       ║`);
  console.log(`║  Celular: http://${localIP}:${PORT}  ║`);
  console.log('║                                      ║');
  console.log('║  Dejá esta ventana abierta           ║');
  console.log('║  Ctrl+C para detener                 ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`Router objetivo: http://${ROUTER_IP}`);
  console.log('Esperando conexiones...\n');
});
