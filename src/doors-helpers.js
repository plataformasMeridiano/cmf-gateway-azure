// Módulo compartido: sesión HTTP con Doors + helpers de negocio
const http        = require('http');
const https       = require('https');
const querystring = require('querystring');

const SERVER         = 'http://mancia3.dynns.com:82';
const MNPC           = `${SERVER}/mnpc`;
const BASIC_AUTH     = 'Basic ' + Buffer.from('mancia:mnpc1909').toString('base64');
const DOORS_USER     = 'ADucet';
const DOORS_PASS     = 'ADucet';
const STORAGE_BUCKET = 'Cesion-liquidaciones';

// ── Session ───────────────────────────────────────────────────────────────────

class DoorsSession {
    constructor() { this._cookies = {}; }

    _parseCookies(headers) {
        const sc = headers['set-cookie'];
        if (!sc) return;
        for (const h of (Array.isArray(sc) ? sc : [sc])) {
            const part = h.split(';')[0];
            const eq   = part.indexOf('=');
            if (eq > 0) this._cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
        }
    }

    _cookieStr() {
        return Object.entries(this._cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    _raw(method, urlStr, formData, binary) {
        return new Promise((resolve, reject) => {
            const attempt = (m, u, fd) => {
                const parsed  = new URL(u);
                const lib     = parsed.protocol === 'https:' ? https : http;
                const body    = fd ? querystring.stringify(fd) : null;
                const headers = { Authorization: BASIC_AUTH, Cookie: this._cookieStr() };
                if (body) {
                    headers['Content-Type']   = 'application/x-www-form-urlencoded';
                    headers['Content-Length'] = Buffer.byteLength(body);
                }

                const req = lib.request({
                    method: m, hostname: parsed.hostname,
                    port:   parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path:   parsed.pathname + parsed.search,
                    headers, timeout: 30000,
                }, (res) => {
                    this._parseCookies(res.headers);
                    if ([301, 302, 303].includes(res.statusCode) && res.headers.location) {
                        res.resume();
                        attempt('GET', new URL(res.headers.location, u).href, null);
                        return;
                    }
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve({
                        status: res.statusCode, headers: res.headers, url: u,
                        body:   binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf-8'),
                    }));
                });

                req.on('timeout', () => req.destroy(new Error(`Timeout: ${u}`)));
                req.on('error', reject);
                if (body) req.write(body);
                req.end();
            };
            attempt(method, urlStr, formData);
        });
    }

    get(url, binary = false)            { return this._raw('GET',  url, null, binary); }
    post(url, formData, binary = false) { return this._raw('POST', url, formData, binary); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lqfBase(sociedad) {
    const map = { Meridiano: 'meridi', Pamat: 'pamat', Mancia: 'mancia' };
    if (!map[sociedad]) throw new Error(`sociedad inválida: ${sociedad}`);
    return `${SERVER}/${map[sociedad]}/finan_lqf`;
}

function parseDate(ddmmyyyy) {
    const [d, m, y] = ddmmyyyy.split('-');
    return `${y}-${m}-${d}`;
}

function makeSupa() {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY,
        { realtime: { transport: require('ws') } }
    );
}

// Extrae el texto visible de una pantalla Doors y lo adjunta al error
function doorsError(step, body, url) {
    const text = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')  // quitar JS
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
    const suffix = url ? ` | URL: ${url}` : '';
    return new Error(`Doors ${step} falló${suffix} | Pantalla: ${text}`);
}

// ── Pasos Doors (SANDBOX: lookupFirmante/getMaxCesion/crearLiquidacion/PDF/tasa mockeados) ──

async function login(s) {
    await s.get(`${MNPC}/sisdoors/index.php`);
    await s.post(`${MNPC}/sisdoors/login.php`, { s: '1', boton: 'Login' });
    const r = await s.post(`${MNPC}/sisdoors/login.php`, {
        conf: '1', estado: '0', s: '1', usr: DOORS_USER, pwd: DOORS_PASS,
    });
    if (!r.url.includes('mymenu')) throw new Error('Login a Doors falló');
}

async function lookupFirmante(s, sociedad, cuit) {
    return `MOCK RAZÓN SOCIAL (${cuit})`;
}

async function getMaxCesion(s, clienteCodigo) {
    // sbx: deriva el max cesion de los registros reales en Supabase
    const supa = makeSupa();
    const { data } = await supa
        .from('doors_liquidaciones_facturas')
        .select('cesion_numero')
        .eq('cliente_codigo', clienteCodigo)
        .eq('status', 'ok')
        .order('cesion_numero', { ascending: false })
        .limit(1);
    return (data && data.length > 0 && data[0].cesion_numero) ? data[0].cesion_numero : 0;
}

async function crearLiquidacion(s, lqf, row) {
    // sbx mock — genera número en rango 99000-99999 para no colisionar con Doors real
    const supa = makeSupa();
    const { data } = await supa
        .from('doors_liquidaciones_facturas')
        .select('doors_liq_numero')
        .gte('doors_liq_numero', '99000')
        .lte('doors_liq_numero', '99999')
        .order('doors_liq_numero', { ascending: false })
        .limit(1);
    const last  = (data && data.length > 0) ? parseInt(data[0].doors_liq_numero, 10) : 99000;
    const liqNum = String(last + 1);
    return { recId: 'SBX-REC', liqNum };
}


async function descargarYSubirPdf(s, lqf, liqNum, sociedad, supa) {
    // sbx mock — referencia un PDF real existente sin descargar nada de Doors
    return 'meridiano/47987.pdf';
}

async function actualizarTasa(s, clienteCodigo, cesionNumero, tasa) {
    // sbx mock — no toca Doors
}

module.exports = {
    DoorsSession, lqfBase, parseDate, makeSupa,
    login, lookupFirmante, getMaxCesion,
    crearLiquidacion, descargarYSubirPdf, actualizarTasa,
    DOORS_USER,
};
