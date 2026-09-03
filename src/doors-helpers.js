// Módulo compartido: sesión HTTP con Doors + helpers de negocio
const http        = require('http');
const https       = require('https');
const querystring = require('querystring');
const zlib        = require('zlib');
const crypto      = require('crypto');

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

    // `cuerpo` es null o { buffer, contentType } ya armado por quien llama.
    _raw(method, urlStr, cuerpo, binary) {
        return new Promise((resolve, reject) => {
            const attempt = (m, u, c) => {
                const parsed  = new URL(u);
                const lib     = parsed.protocol === 'https:' ? https : http;
                const body    = c ? c.buffer : null;
                const headers = { Authorization: BASIC_AUTH, Cookie: this._cookieStr() };
                if (body) {
                    headers['Content-Type']   = c.contentType;
                    headers['Content-Length'] = body.length;
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
            attempt(method, urlStr, cuerpo);
        });
    }

    get(url, binary = false) { return this._raw('GET', url, null, binary); }

    post(url, formData, binary = false) {
        const cuerpo = formData ? {
            buffer:      Buffer.from(querystring.stringify(formData), 'latin1'),
            contentType: 'application/x-www-form-urlencoded',
        } : null;
        return this._raw('POST', url, cuerpo, binary);
    }

    /**
     * POST multipart/form-data — para las pantallas de Doors que suben un archivo
     * (la de liquidación de cheques sube el CSV de eCheqs en `val-pan2`).
     *
     * Los archivos se mandan tal cual vinieron, sin transcodificar: el CSV de Doors es
     * ISO-8859-1 y pasarlo por UTF-8 le rompe los acentos del encabezado.
     *
     * @param {object} campos  pares nombre → valor del formulario
     * @param {Array}  files   [{ campo, filename, contentType, data: Buffer }]
     */
    postMultipart(url, campos, files = [], binary = false) {
        const sep    = '----DoorsForm' + crypto.randomBytes(16).toString('hex');
        const partes = [];

        for (const [k, v] of Object.entries(campos || {})) {
            partes.push(Buffer.from(
                `--${sep}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v ?? ''}\r\n`, 'latin1'));
        }
        for (const f of files) {
            partes.push(Buffer.from(
                `--${sep}\r\nContent-Disposition: form-data; name="${f.campo}"; filename="${f.filename}"\r\n` +
                `Content-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`, 'latin1'));
            partes.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'latin1'));
            partes.push(Buffer.from('\r\n', 'latin1'));
        }
        partes.push(Buffer.from(`--${sep}--\r\n`, 'latin1'));

        return this._raw('POST', url, {
            buffer:      Buffer.concat(partes),
            contentType: `multipart/form-data; boundary=${sep}`,
        }, binary);
    }
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

// Campos de un <form> concreto de la página, por su atributo name. Se reenvían tal cual
// vinieron: son formularios con muchos ocultos de configuración y hardcodearlos es frágil.
function camposDeFormulario(html, nombre) {
    for (const trozo of html.split(/<form\b/i).slice(1)) {
        const cab = trozo.slice(0, trozo.indexOf('>') + 1);
        if (((cab.match(/name\s*=\s*["']([^"']+)["']/i) || [])[1]) !== nombre) continue;
        const cuerpo = trozo.slice(0, trozo.search(/<\/form>/i));
        const campos = {};
        for (const m of cuerpo.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
            const g = (a) => (m[0].match(new RegExp(`${a}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1];
            const n = g('name');
            if (n && (g('type') || '').toLowerCase() !== 'file') campos[n] = g('value') ?? '';
        }
        return campos;
    }
    return null;
}

// Total de "Imp.Original" al pie de la grilla de ítems de fac-pan3 — el primer número de
// la fila que arranca con "Total". Sirve para confirmar que el ítem realmente entró.
function totalGrilla(html) {
    const m = html.replace(/<[^>]+>/g, '|').replace(/&nbsp;?/gi, ' ')
                  .match(/Total\s*\|+\s*(-?[\d.]*\d(?:,\d{2})?)/i);
    if (!m) return null;
    return parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
}

// Alícuotas de IVA vigentes en Argentina. El porcentaje se deriva de una división entre
// dos importes redondeados a centavos, así que puede salir 20,999998 en vez de 21: si cae
// bien cerca de una alícuota real, se ajusta.
const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27];
const TOLERANCIA_ALICUOTA = 0.05;   // en puntos porcentuales

/**
 * Porcentaje de IVA a partir del bruto y el neto de la factura, que es lo que Jira tiene
 * cargado ("Monto" y "Monto Neto"). El campo IVA de Jira está vacío en todas, así que el
 * porcentaje se deduce:
 *
 *   %  = (bruto - neto) / neto * 100
 *
 * Devuelve null cuando no hay IVA —falta alguno de los dos, o son iguales— ⇒ el campo va
 * vacío, como lo deja la pantalla por defecto.
 *
 * Si el resultado no cae cerca de ninguna alícuota **no se fuerza**: una factura con dos
 * alícuotas mezcladas da un porcentaje intermedio que es legítimo, y además es el único
 * que reproduce el neto correcto (el % se dedujo justamente para que dé ese neto).
 * Redondearlo a 21 movería la base de la retención de verdad.
 */
function porcentajeIva(bruto, neto) {
    const b = Number(bruto) || 0;
    const n = Number(neto)  || 0;
    if (b <= 0 || n <= 0 || b === n) return null;
    if (n > b) throw new Error(`El neto (${n}) no puede ser mayor que el bruto (${b})`);

    const crudo = ((b - n) / n) * 100;
    const cerca = ALICUOTAS_IVA.find(a => Math.abs(crudo - a) <= TOLERANCIA_ALICUOTA);
    return cerca ?? Math.round(crudo * 100) / 100;
}

// Base de la retención de ganancias. Es exactamente el `Vporiva()` del JS de fac-pan3:
//   neto = redondear(importe / (1 + iva/100), 2)
// Doors NO lo calcula del lado del servidor — lo calcula el navegador y lo manda en un campo
// oculto. Como nosotros no ejecutamos ese JS, lo replicamos acá. Si mandáramos el importe
// bruto como neto, la retención saldría sobre una base más alta de la que corresponde.
function netoGanancias(importe, porcentaje) {
    const iva = 1 + (Number(porcentaje) || 0) / 100;
    return Math.round((Number(importe) / iva) * 100) / 100;
}

function makeSupa() {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY,
        { realtime: { transport: require('ws') } }
    );
}

// Valores del custom field "tipo de operación" de la cesión en Jira → tipo interno
const TIPOS_OPERACION = {
    'cesion puntual': 'cesion',
    'factoring':      'factoraje',
};

// Normaliza el custom field de Jira a 'cesion' | 'factoraje'.
// Ausente o vacío → 'cesion' (retrocompatible: Zapier todavía no manda el campo).
// Valor no reconocido → null, para que el caller lo rechace en vez de asumir un tipo
// y cargar la liquidación por el menú equivocado sin que nadie se entere.
function normalizarTipoOperacion(valor) {
    if (valor == null || String(valor).trim() === '') return 'cesion';
    let v = String(valor).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');   // sacar acentos
    v = v.replace(/\s+/g, ' ').trim();
    return TIPOS_OPERACION[v] || null;
}

// Programa de entrada en Doors según el tipo de operación:
//   cesion    → fac-pan0.php  (menú "Alta de Liquidación (Facturas)", id1250)
//   factoraje → fac-pan0f.php (menú "Alta de Liquidación (Facturas Factoraje)", id1333)
// Las pantallas siguientes (pan2/pan3/pan4/pdf) son las mismas para ambos: el tipo queda
// grabado en el registro según cuál de los dos pan0 lo creó, no por un campo del formulario.
function pan0Prog(tipoOperacion) {
    return tipoOperacion === 'factoraje' ? 'fac-pan0f.php' : 'fac-pan0.php';
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

// Texto plano de un PDF de Doors. Los genera FPDF, así que el texto vive en los content
// streams como operadores Tj/TJ, en claro o comprimidos con Flate (zlib es built-in).
function textoDePdf(buf) {
    const crudo  = buf.toString('latin1');
    const trozos = [];

    const reStream = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let ms;
    while ((ms = reStream.exec(crudo)) !== null) {
        let datos = Buffer.from(ms[1], 'latin1');
        try { datos = zlib.inflateSync(datos); } catch { /* no está comprimido */ }
        trozos.push(datos.toString('latin1'));
    }
    const contenido = trozos.length ? trozos.join('\n') : crudo;

    const salida = [];
    let m;
    const reTj = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    while ((m = reTj.exec(contenido)) !== null) salida.push(m[1]);
    const reTJ = /\[((?:\\.|[^\\[\]])*)\]\s*TJ/g;
    while ((m = reTJ.exec(contenido)) !== null) {
        salida.push([...m[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map(x => x[1]).join(''));
    }

    return salida
        .map(t => t.replace(/\\([()\\])/g, '$1')
                   .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))))
        .join('\n');
}

// Número de cesión que Doors le asignó a la liquidación. Sale del propio PDF
// ("Nro 48378   Cesion 31") y es la única fuente exacta: Doors lo calcula solo
// (máximo + 1 por cliente) y no lo expone por ninguna otra vía.
function extraerCesionDePdf(buf) {
    const m = textoDePdf(buf).match(/Cesion\s*[:\s]\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

async function crearLiquidacion(s, lqf, row) {
    const esFactoraje = row.tipo_operacion === 'factoraje';
    const r0  = await s.post(`${lqf}/${pan0Prog(row.tipo_operacion)}`, { CONF: '1' });
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
        // Factoraje no lleva retención de ganancias: pan0f fija TIPO_RG=0 (campo oculto)
        TIPO_RG:    esFactoraje ? '0' : (row.tipo_ganancias || '6'),
        MONEDA_FAC: '1',
    });
    // pan2 OK: debe mostrar el formulario de ítem (campo ABMITEM presente)
    if (!r2.body.includes('ABMITEM')) {
        throw doorsError('pan2 (cabecera)', r2.body);
    }

    const importe = row.importe_efectivo ?? row.importe_original;
    // El % se deriva del bruto y el neto de la FACTURA, que es a lo que corresponden esos
    // dos montos. Después se aplica sobre el importe que realmente va a Doors (el efectivo,
    // ya descontadas las NC/ND), así la alícuota queda bien y el neto escala con el importe.
    const poriva  = porcentajeIva(row.monto_bruto, row.monto_neto);

    const camposItem = {
        id: recId, CONF: '1', ABM: 'A', ABMITEM: '', ITEM: '', SCROLL: '',
        LET:     row.letra,
        PREF:    row.prefijo,
        NUM:     row.numero,
        FECDEP:  row.fecha_dep_ddmmyyyy,
        FECEMI:  row.fecha_emision_ddmmyyyy,
        IMPORTE: String(importe),
        PORIVA:  poriva == null ? '' : String(poriva),
        NETO:    String(netoGanancias(importe, poriva)),
        VALCAR: '', MAV: '', IMP_ME: '',
        FIR1:     row.cuit_deudor,
        FIR1_ANT: '',
        FIR1_NOM: row.razon_social,
    };
    let r3 = await s.post(`${lqf}/fac-pan3.php`, camposItem);
    // Doors avisa "Factura ya ingresado en liq NNNNN item N — ¿Quiere cargarla de todas
    // maneras?" y NO agrega el ítem hasta que se responda. La advertencia no filtra por
    // cliente, así que puede ser de otro comitente: se responde que sí.
    //
    // Responder es re-postear el ítem con CONTINUA=1 — es lo que hace el botón "Sí", que
    // submitea `formCont`, un espejo oculto de `formItem`. Se reenvían los campos tal como
    // los devolvió Doors, no los nuestros, para no perder nada que la pantalla haya agregado.
    //
    // OJO: un intento anterior (b730dd7, revertido) se limitó a NO tirar el error y siguió
    // derecho a pan4. Doors quedó esperando la respuesta, el ítem nunca entró, y se
    // confirmaron cabeceras vacías: las liq 48376 y 48377 quedaron con importe 0.
    let dupAviso = null;
    const dupMatch = r3.body.match(/ya ingresado[^<]{0,100}/i);
    if (dupMatch) {
        dupAviso = dupMatch[0].trim().slice(0, 120);
        const cont = camposDeFormulario(r3.body, 'formCont');
        if (!cont || !('CONTINUA' in cont)) {
            throw new Error(
                `Factura ${row.prefijo}-${row.numero} ya existe en Doors (${dupAviso}) y no se ` +
                `encontró el formulario de confirmación para continuar.`);
        }
        r3 = await s.post(`${lqf}/fac-pan3.php`, { ...cont, CONTINUA: '1' });
    }

    // El ítem tiene que estar en la grilla. Se mide por el TOTAL al pie, no por buscar el
    // número en el HTML: con el diálogo abierto ese número aparece igual dentro del
    // formulario, así que el control viejo no habría detectado la cabecera vacía.
    const total = totalGrilla(r3.body);
    if (total == null || Math.abs(total - Number(importe)) > 0.01) {
        throw doorsError(
            `pan3 (el ítem no quedó cargado: la grilla totaliza ${total} y se esperaba ${importe}` +
            `${dupAviso ? `; Doors avisó "${dupAviso}"` : ''})`, r3.body);
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
    return { path, cesionNumero: extraerCesionDePdf(r.body) };
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
    normalizarTipoOperacion, pan0Prog,
    login, lookupFirmante, extraerCesionDePdf, netoGanancias, porcentajeIva, totalGrilla, camposDeFormulario,
    crearLiquidacion, descargarYSubirPdf, actualizarTasa,
    DOORS_USER,
};
