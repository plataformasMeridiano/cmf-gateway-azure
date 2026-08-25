// Alta de "Liquidación de cheques" en Doors (cesión de cheques).
//
// Empresa MNPC, módulo finan_fn. El camino es el mismo patrón que las liquidaciones de
// facturas, con una diferencia: la cabecera sube un CSV y Doors arma los ítems solo.
//
//   val-pan0-tl1.php  → crea el registro y devuelve el id
//   val-pan2.php?id=N → cabecera + upload del CSV   (multipart)
//   val-pan3.php?id=N → grilla de ítems ya cargados
//   val-pan4.php      → resumen; el id va en el POST, no en la URL
//
// Se entra por `val-pan0.php` = menú "Liquidaciones → Alta de Liquidación" (id777),
// confirmado con el usuario el 2026-08-25.
// El otro menú, "Alta de Liquidación para pago Cesion" (id1401), llega a las MISMAS
// pantallas por `val-pan0-tl1.php`, y lo único que los distingue es `SW_TL1`/`PAGINICIAL`
// (vacío vs "1"). La pantalla no dice en cuál estás — mismo problema que id1250/id1333 en
// facturas, donde cargar por el menú equivocado dejó liquidaciones con el tipo mal.

const PAN0 = 'val-pan0.php';

// "1.234.567,89" → 1234567.89
function numeroAr(txt) {
    if (txt == null) return null;
    const m = String(txt).replace(/\s|&nbsp;/g, '').match(/-?[\d.]*\d(?:,\d+)?/);
    if (!m) return null;
    return parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
}

function textoPlano(html) {
    return html.replace(/<script[\s\S]*?<\/script>/gi, '')
               .replace(/<[^>]+>/g, ' ')
               .replace(/&nbsp;?/gi, ' ')
               .replace(/\s+/g, ' ');
}

// Campos de todos los <form> de la página, indexados por el name del form.
function formularios(html) {
    const out = {};
    for (const trozo of html.split(/<form\b/i).slice(1)) {
        const cab  = trozo.slice(0, trozo.indexOf('>') + 1);
        const nom  = (cab.match(/name\s*=\s*['"]([^'"]+)['"]/i) || [])[1] || '';
        const cuerpo = trozo.slice(0, trozo.search(/<\/form>/i));
        const campos = {};
        for (const m of cuerpo.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
            const g = (a) => (m[0].match(new RegExp(`${a}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1];
            const n = g('name');
            if (n && (g('type') || '').toLowerCase() !== 'file') campos[n] = g('value') ?? '';
        }
        out[nom] = campos;
    }
    return out;
}

function errorDoors(paso, html, url) {
    const t = textoPlano(html).trim().slice(0, 400);
    return new Error(`Doors rechazó el paso ${paso}${url ? ` (url: ${url})` : ''}: ${t}`);
}

/**
 * Recorre el alta hasta el resumen. Si `confirmar` es false —el default— NO confirma:
 * deja el registro abierto en estado Alta y devuelve el resumen que calculó Doors.
 * Sirve para validar contra datos reales sin persistir nada.
 *
 * @param {DoorsSession} s      sesión ya logueada
 * @param {object} cab          cabecera (ver cheques-execute)
 * @param {object} archivo      { nombre, datos: Buffer } — el CSV, tal cual, sin transcodificar
 * @param {object} totales      { cantidad, monto } calculados del CSV
 * @param {boolean} confirmar
 */
async function crearLiquidacionCheques(s, fn, cab, archivo, totales, confirmar) {
    // ── pan0: crear el registro ───────────────────────────────────────────────
    const r0 = await s.post(`${fn}/${PAN0}`, { CONF: '1' });
    const m0 = r0.url.match(/[?&]id=(\d+)/);
    if (!m0) throw errorDoors('pan0 (alta del registro)', r0.body, r0.url);
    const recId = m0[1];

    // ── pan2: cabecera + CSV ──────────────────────────────────────────────────
    // CCHE y TCHE son el control del archivo: con 0 y 0 Doors sube el CSV, no levanta
    // ningún cheque y NO avisa. Por eso salen del parseo del propio archivo.
    const r2 = await s.postMultipart(`${fn}/val-pan2.php`, {
        CONF: '1', id: recId, ABM: 'A', LIQ: '',
        MAX_FILE_SIZE: '10000000',
        FEC:      cab.fecha,
        CLI:      cab.cliente_codigo,
        TASA:     String(cab.tasa_anual),
        TIPLIQ:   '',
        PGAS1:    String(cab.gastos_gestion),
        PGASBAN:  '0',
        PGASADM:  String(cab.gastos_administ),
        GASFIJO:  '0',
        PTASA:    String(cab.tasa_gastos),
        DPROMPAR: String(cab.dias_promedio),
        PANT:     '0',
        MONEDA:   String(cab.moneda),
        OBS:      cab.observacion || '',
        LECTOR:   cab.lector || '',
        CCHE:     String(totales.cantidad),
        TCHE:     String(totales.monto),
    }, [{ campo: 'userfile', filename: archivo.nombre, contentType: 'text/csv', data: archivo.datos }]);

    // Doors avisa "Numero de cheque ya ingresado en liq NNNNN item N" y ofrece seguir.
    // No se sigue: en producción eso es un duplicado real y hay que mirarlo.
    const dup = textoPlano(r2.body).match(/ya ingresado[^.<]{0,120}/i);
    if (dup) {
        throw new Error(`Doors detectó un cheque ya cargado: ${dup[0].trim()}. ` +
                        `No se confirmó nada; revisá la liquidación que menciona.`);
    }

    // ── pan3: verificar que el archivo se haya levantado ──────────────────────
    const r3 = await s.get(`${fn}/val-pan3.php?id=${recId}`);
    const cont = textoPlano(r3.body).match(/Can\s*C:\s*(\d+)\s*Monto:\s*([\d.,]+)/i);
    if (!cont) throw errorDoors('pan3 (grilla de ítems)', r3.body);

    const cargados = parseInt(cont[1], 10);
    const montoDoors = numeroAr(cont[2]);
    if (cargados !== totales.cantidad || Math.abs(montoDoors - totales.monto) > 0.01) {
        throw new Error(
            `Doors levantó ${cargados} cheque(s) por ${montoDoors} y el archivo tiene ` +
            `${totales.cantidad} por ${totales.monto}. No se confirmó nada.`);
    }

    // ── pan4: resumen ─────────────────────────────────────────────────────────
    const r4 = await s.post(`${fn}/val-pan4.php`, { ABM: 'A', id: recId });
    const texto = textoPlano(r4.body);
    const leer = (etiqueta) => {
        const m = texto.match(new RegExp(`${etiqueta}\\s*([\\d.]+,\\d{2}|-[\\d.]+,\\d{2})`, 'i'));
        return m ? numeroAr(m[1]) : null;
    };
    const resumen = {
        total:           leer('Total'),
        gastos_gestion:  leer('Gastos Gestion'),
        intereses:       leer('Intereses'),
        iva:             leer('IVA'),
        neto:            leer('Neto'),
        cheques:         cargados,
    };
    if (resumen.total == null) throw errorDoors('pan4 (resumen)', r4.body);

    if (!confirmar) {
        return { recId, liqNum: null, confirmado: false, resumen };
    }

    // ── confirmar ─────────────────────────────────────────────────────────────
    // Los campos del form de confirmación se reenvían tal cual vinieron: son muchos
    // ocultos de configuración (SW_*, GASCHE*, PAGINA…) y hardcodearlos es frágil.
    const forms  = formularios(r4.body);
    const nombre = Object.keys(forms).find(n => /cont|conf|sig/i.test(n)) || Object.keys(forms)[0];
    const campos = { ...(forms[nombre] || {}), id: recId, ABM: 'A', CONF: '1' };

    const rc = await s.post(`${fn}/val-pan4.php`, campos);
    // En facturas el número sale del `msj=NNNNN` de la URL de retorno. Acá se espera lo
    // mismo, pero si no aparece NO se inventa: se devuelve error con el cuerpo.
    const mn = rc.url.match(/msj=(\d+)/) || textoPlano(rc.body).match(/liquidaci[óo]n\s*(?:n[º°]?\s*)?(\d{4,})/i);
    if (!mn) throw errorDoors('confirmación (no se pudo leer el nº de liquidación)', rc.body, rc.url);

    return { recId, liqNum: mn[1], confirmado: true, resumen };
}

module.exports = { crearLiquidacionCheques, numeroAr, textoPlano, formularios, PAN0 };
