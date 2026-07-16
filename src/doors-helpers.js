// Módulo compartido: sesión HTTP con Doors + helpers de negocio
const http        = require('http');
const https       = require('https');
const querystring = require('querystring');

const SERVER         = 'http://mancia3.login-erp.com:82';
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

// Convierte cualquier formato (DD-MM-YYYY o YYYY-MM-DD) a YYYY-MM-DD para Supabase
function parseDate(input) {
    if (!input) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(input)) return input.slice(0, 10);  // ya es ISO
    const [d, m, y] = input.split('-');
    return `${y}-${m}-${d}`;
}

// Convierte cualquier formato a DD-MM-YYYY para Doors
function toDdMmYyyy(input) {
    if (!input) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(input)) {
        const [y, m, d] = input.split('T')[0].split('-');
        return `${d}-${m}-${y}`;
    }
    return input;  // ya es DD-MM-YYYY
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

// ── Pasos Doors ───────────────────────────────────────────────────────────────

async function login(s) {
    await s.get(`${MNPC}/sisdoors/index.php`);
    await s.post(`${MNPC}/sisdoors/login.php`, { s: '1', boton: 'Login' });
    const r = await s.post(`${MNPC}/sisdoors/login.php`, {
        conf: '1', estado: '0', s: '1', usr: DOORS_USER, pwd: DOORS_PASS,
    });
    if (!r.url.includes('mymenu')) throw new Error('Login a Doors falló');
}

async function lookupFirmante(s, sociedad, cuit) {
    const base   = lqfBase(sociedad);
    const fnBase = new URL('../finan_fn/', base + '/').href;
    const r      = await s.get(`${fnBase}ayu_fn_firmante.php?valor=${encodeURIComponent(cuit)}&validar=true`);
    const data   = JSON.parse(r.body);
    if (data.ERROR) throw new Error(`CUIT ${cuit} no encontrado en Doors`);
    return data.DES;
}

async function getMaxCesion(s, clienteCodigo) {
    const cc  = `${MNPC}/finan_cc`;
    const pad = clienteCodigo.padStart(5, '0');

    const existe = async (n) => {
        const id = `1.04.${pad}.${String(n).padStart(3, '0')}`;
        const r  = await s.post(`${cc}/adicxcta-abm.php`, {
            ID: id, ABM: 'M', PAGINA: `${MNPC}/finan_cc/adicxcta-ini.php?`,
        });
        return r.body.includes('TASA_ACT_CIE');
    };

    // Hallar el bloque de 50 que contiene el máximo: escalar de a 50 hasta no encontrar
    let techo = 50;
    while (techo <= 500 && await existe(techo)) techo += 50;

    // Escanear hacia abajo dentro del bloque [techo-50 .. techo-1]
    for (let n = techo - 1; n >= Math.max(1, techo - 50); n--) {
        if (await existe(n)) return n;
    }
    return 0;
}

async function crearLiquidacion(s, lqf, row) {
    const r0  = await s.post(`${lqf}/fac-pan0.php`, { CONF: '1' });
    const m0  = r0.url.match(/[?&]id=(\d+)/);
    if (!m0) throw new Error(`No se obtuvo ID en pan0. URL: ${r0.url}`);
    const recId = m0[1];

    // Validar el CUIT del firmante en la sesión de Doors (requerido antes de pan3)
    const fnBase = new URL('../finan_fn/', lqf + '/').href;
    await s.get(`${fnBase}ayu_fn_firmante.php?valor=${encodeURIComponent(row.cuit_deudor)}&validar=true`);

    const r2 = await s.post(`${lqf}/fac-pan2.php`, {
        id: recId, CONF: '1', ABM: 'A', LIQ: '', PIMPCHE: '0',
        FECHA:      row.fecha_operacion_ddmmyyyy,
        CLIENTE:    row.cliente_codigo,
        NROESC:     row.nro_escritura    || '',
        MONTO:      String(row.monto_anticipo || 0),
        GARANTIA:   String(row.monto_garantia || 0),
        OBS:        row.observaciones    || '',
        TIPO_RG:    row.tipo_ganancias   || '6',
        MONEDA_FAC: '1',
    });
    // pan2 OK: debe mostrar el formulario de ítem (campo ABMITEM presente)
    if (!r2.body.includes('ABMITEM')) {
        throw doorsError('pan2 (cabecera)', r2.body);
    }

    const r3 = await s.post(`${lqf}/fac-pan3.php`, {
        id: recId, CONF: '1', ABM: 'A', ABMITEM: '', ITEM: '', SCROLL: '',
        LET:     row.letra,
        PREF:    row.prefijo,
        NUM:     row.numero,
        FECDEP:  row.fecha_dep_ddmmyyyy,
        FECEMI:  row.fecha_emision_ddmmyyyy,
        IMPORTE: String(row.importe_efectivo ?? row.importe_original),
        PORIVA:  '0',
        NETO:    String(row.importe_efectivo ?? row.importe_original),
        VALCAR: '', MAV: '', IMP_ME: '',
        FIR1:     row.cuit_deudor,
        FIR1_ANT: '',
        FIR1_NOM: row.razon_social,
    });
    // pan3 OK: el ítem debe aparecer en la grilla
    // Doors muestra el número sin ceros a la izquierda (ej: "1234" no "00001234")
    const numeroSinCeros = row.numero ? String(parseInt(row.numero, 10)) : null;
    if (numeroSinCeros && !r3.body.includes(numeroSinCeros)) {
        throw doorsError('pan3 (ítem factura)', r3.body);
    }
    // Detectar advertencia de factura duplicada en Doors
    const dupMatch = r3.body.match(/ya ingresado[^<]{0,100}/i);
    if (dupMatch) {
        throw new Error(`Factura ${row.prefijo}-${row.numero} ya existe en Doors (${dupMatch[0].trim().slice(0, 120)})`);
    }

    // pan4: primer POST muestra confirmación, segundo POST confirma
    const r4a = await s.post(`${lqf}/fac-pan4.php`, { id: recId, ABM: 'A' });
    // pan4 primera pasada OK: debe mostrar formulario de confirmación con CONF y SUBMIT
    if (!r4a.body.includes('name=\'CONF\'') && !r4a.body.includes('name="CONF"')) {
        throw doorsError('pan4 (confirmación)', r4a.body);
    }
    const valForm = (f) => {
        const m = r4a.body.match(new RegExp(`name=['"]${f}['"][^>]*value=['"]([^'"]*)['"']`));
        return m ? m[1] : '0';
    };

    const r4 = await s.post(`${lqf}/fac-pan4.php`, {
        id: recId, ABM: 'A', CONF: '1', SUBMIT: '1',
        RETGAN_NUEVA_USU: valForm('RETGAN_NUEVA_USU'),
        GAS_BAN:          valForm('GAS_BAN'),
        GAS_ADM:          valForm('GAS_ADM'),
    });
    const m4 = r4.url.match(/msj=(\d+)/);
    if (!m4) throw doorsError('pan4 (submit)', r4.body, r4.url);

    return { recId, liqNum: m4[1] };
}

async function descargarYSubirPdf(s, lqf, liqNum, sociedad, supa) {
    const r = await s.get(`${lqf}/fac-pdf.php?ID=${liqNum}**SW_INT=1**SW_GAS=1`, true);
    if (!(r.headers['content-type'] || '').includes('application/pdf')) {
        throw new Error(`Respuesta no es PDF: ${r.headers['content-type']}`);
    }
    const path = `${sociedad.toLowerCase()}/${liqNum}.pdf`;
    const { error } = await supa.storage.from(STORAGE_BUCKET).upload(path, r.body, {
        contentType: 'application/pdf',
    });
    if (error) throw new Error(`Storage upload: ${error.message}`);
    return path;
}

async function actualizarTasa(s, clienteCodigo, cesionNumero, tasa) {
    const cc     = `${MNPC}/finan_cc`;
    const pad    = clienteCodigo.padStart(5, '0');
    const id     = `1.04.${pad}.${String(cesionNumero).padStart(3, '0')}`;
    const pagina = `${MNPC}/finan_cc/adicxcta-ini.php?`;

    const r = await s.post(`${cc}/adicxcta-abm.php`, { ID: id, ABM: 'M', PAGINA: pagina });
    if (!r.body.includes('TASA_ACT_CIE')) throw new Error(`Cuenta ${id} no encontrada en adicxcta`);

    const val = (field) => {
        const m = r.body.match(new RegExp(`name=["']${field}["'][^>]*value=["']([^"']*)["']`));
        return m ? m[1] : '0.00';
    };

    await s.post(`${cc}/adicxcta-abm.php`, {
        ID: id, ABM: 'M', CONF: '1', PAGINA: pagina, atras: '1',
        TASA_LIQ:     val('TASA_LIQ'),
        PGAS1_LIQ:    val('PGAS1_LIQ'),
        PGAS2_LIQ:    val('PGAS2_LIQ'),
        TASA_ACT_CIE: String(tasa),
        ID_ACT_CIE:   val('ID_ACT_CIE'),
        TASA_PAS_CIE: val('TASA_PAS_CIE'),
        ID_PAS_CIE:   val('ID_PAS_CIE'),
    });
}

module.exports = {
    DoorsSession, lqfBase, parseDate, toDdMmYyyy, makeSupa,
    login, lookupFirmante, getMaxCesion,
    crearLiquidacion, descargarYSubirPdf, actualizarTasa,
    DOORS_USER,
};
