// Lectura y validación del CSV de cheques que consume Doors.
//
// Formato (modelo: "farmacia el clasico 24.2"): ISO-8859-1, CRLF, separador ';', 15 columnas.
// NO es UTF-8 — el encabezado trae "Fecha de emisión" y "N° de cheque" con bytes latin-1.
//
// Doors deriva los campos del ítem del CMC7 y del CUIT del emisor; el resto de las columnas
// (banco emisor, estado, endosos) son informativas. Igual se validan todas, porque un archivo
// mal armado se carga en silencio y el error recién aparece en la grilla.

const COLUMNAS = [
    'Emitido por', 'Endosado por', 'Banco emisor', 'Fecha de emisión', 'Fecha de Pago',
    'Fecha de Vencimiento', 'Monto', 'CheqID', 'N° de cheque', 'Estado',
    'Tipo de Documento del Emisor', 'CMC7', 'GrupoID', 'Endosos', 'Cesiones',
];

// Doors archiva todos los eCheqs bajo un pseudo-banco, no bajo el banco emisor real.
const BANCO_ECHEQ = '99';
const SUCURSAL_ECHEQ = '0';

function partirLinea(linea) {
    // El formato no usa comillas: los valores no traen ';' y los endosos separan con '|'.
    return linea.split(';');
}

// El CMC7 de 29 dígitos: banco(3) + ?(3) + C.P.(4) + nro de cheque(8) + cuenta(11).
// Verificado contra lo que Doors muestra en la grilla de val-pan3.
function desarmarCmc7(cmc7) {
    if (!/^\d{29}$/.test(cmc7)) return null;
    return {
        banco_bcra: cmc7.slice(0, 3),
        cp:         String(parseInt(cmc7.slice(6, 10), 10)),
        nro_cheque: String(parseInt(cmc7.slice(10, 18), 10)),
        cuenta:     String(parseInt(cmc7.slice(18), 10)),
    };
}

function aIso(fecha) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha || '');
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
}

// "$273948.6" → 273948.6. El formato no lleva separador de miles.
function aMonto(txt) {
    const m = /^\$?(\d+(?:\.\d+)?)$/.exec(String(txt || '').trim());
    return m ? parseFloat(m[1]) : null;
}

/**
 * Parsea el CSV y valida fila por fila.
 *
 * @param {Buffer} buf  contenido crudo del archivo
 * @returns {{ cheques: object[], cantidad: number, monto: number, errores: string[] }}
 *          `monto` viene redondeado a 2 decimales: es el control que espera Doors y la suma
 *          de floats arrastra error (0.1+0.2). `errores` vacío ⇒ el archivo sirve.
 */
function parseCsvCheques(buf) {
    const texto  = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
    const lineas = texto.split(/\r?\n/).filter(l => l.trim() !== '');
    const errores = [];

    if (!lineas.length) return { cheques: [], cantidad: 0, monto: 0, errores: ['El archivo está vacío'] };

    const cab = partirLinea(lineas[0]);
    if (cab.length !== COLUMNAS.length || COLUMNAS.some((c, i) => cab[i] !== c)) {
        errores.push(`Encabezado inesperado. Se esperaba: ${COLUMNAS.join(';')}`);
        return { cheques: [], cantidad: 0, monto: 0, errores };
    }

    const cheques = [];
    const vistos  = new Map();   // CheqID → nº de fila, para detectar repetidos dentro del archivo

    for (let i = 1; i < lineas.length; i++) {
        const campos = partirLinea(lineas[i]);
        const fila   = i + 1;
        if (campos.length !== COLUMNAS.length) {
            errores.push(`Fila ${fila}: tiene ${campos.length} columnas y se esperaban ${COLUMNAS.length}`);
            continue;
        }
        const r = Object.fromEntries(COLUMNAS.map((c, j) => [c, campos[j].trim()]));

        const monto = aMonto(r['Monto']);
        const cmc7  = desarmarCmc7(r['CMC7']);
        const fPago = aIso(r['Fecha de Pago']);

        if (monto == null)  errores.push(`Fila ${fila}: monto inválido (${r['Monto']})`);
        if (!cmc7)          errores.push(`Fila ${fila}: CMC7 inválido, se esperaban 29 dígitos (${r['CMC7']})`);
        if (!fPago)         errores.push(`Fila ${fila}: "Fecha de Pago" inválida (${r['Fecha de Pago']})`);
        if (!/^\d{11}$/.test(r['Tipo de Documento del Emisor'])) {
            errores.push(`Fila ${fila}: CUIT del emisor inválido (${r['Tipo de Documento del Emisor']})`);
        }
        // El nº de cheque también viaja dentro del CMC7 y Doors usa ese: si no coinciden,
        // el ítem se carga con un número distinto al que dice el archivo.
        if (cmc7 && String(parseInt(r['N° de cheque'], 10)) !== cmc7.nro_cheque) {
            errores.push(`Fila ${fila}: "N° de cheque" (${r['N° de cheque']}) no coincide con el del CMC7 (${cmc7.nro_cheque})`);
        }
        if (r['CheqID'] && vistos.has(r['CheqID'])) {
            errores.push(`Fila ${fila}: CheqID ${r['CheqID']} repetido (ya estaba en la fila ${vistos.get(r['CheqID'])})`);
        }
        vistos.set(r['CheqID'], fila);

        cheques.push({
            fila,
            cheq_id:        r['CheqID'],
            emisor_cuit:    r['Tipo de Documento del Emisor'],
            emisor_nombre:  r['Emitido por'],
            endosado_por:   r['Endosado por'] === '--' ? null : r['Endosado por'],
            banco_nombre:   r['Banco emisor'],
            estado:         r['Estado'],
            cmc7:           r['CMC7'],
            monto,
            fecha_emision:  aIso(r['Fecha de emisión']),
            fecha_pago:     fPago,
            fecha_vto:      aIso(r['Fecha de Vencimiento']),
            // lo que Doors termina mostrando en la grilla de val-pan3
            doors: cmc7 ? { banco: BANCO_ECHEQ, sucursal: SUCURSAL_ECHEQ, ...cmc7 } : null,
        });
    }

    if (!cheques.length) errores.push('El archivo no tiene ningún cheque');

    const monto = Math.round(cheques.reduce((s, c) => s + (c.monto || 0), 0) * 100) / 100;
    return { cheques, cantidad: cheques.length, monto, errores };
}

module.exports = { parseCsvCheques, desarmarCmc7, COLUMNAS, BANCO_ECHEQ, SUCURSAL_ECHEQ };
