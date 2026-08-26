const { app } = require('@azure/functions');
const { DoorsSession, makeSupa, login } = require('../doors-helpers');
const { parseCsvCheques } = require('../cheques-csv');
const { crearLiquidacionCheques, bancoDeModalidad, ISSUE_TYPES, MODALIDADES } = require('../cheques-doors');

const SERVER = 'http://mancia3.login-erp.com:82';
const FN     = `${SERVER}/mnpc/finan_fn`;   // los cheques van bajo MNPC, no bajo la sociedad

// Cubre un alta completa. Es el mismo lock por operación que usan las cesiones de
// facturas: la tabla y las RPC son genéricas, solo cambia la clave.
const LOCK_TTL_SECONDS = 600;

// Defaults de la pantalla. Se pueden pisar por parámetro, pero ninguno se inventa:
// si el caller no manda tasa, no se asume una.
const DEFAULTS = { gastos_administ: 3, tasa_gastos: 35, dias_promedio: 7, moneda: 1 };

// Freno de despliegue. Mientras no esté la app setting, `confirmar: true` se rechaza:
// el paso de confirmación es el único del flujo que nunca se ejecutó contra Doors, así que
// hasta validarlo el modo simulación es una propiedad del entorno y no algo que dependa de
// que el caller mande el default correcto. Se habilita sin redeploy:
//   az functionapp config appsettings set ... --settings CHEQUES_PERMITIR_CONFIRMAR=true
const PERMITIR_CONFIRMAR = process.env.CHEQUES_PERMITIR_CONFIRMAR === 'true';

function hoyDdMmYyyy() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

// Baja el CSV: o de una URL directa, o de un bucket de Supabase Storage.
async function bajarCsv(body, supa) {
    if (body.csv_url) {
        const r = await fetch(body.csv_url);
        if (!r.ok) throw new Error(`No se pudo bajar el CSV (${r.status}) de ${body.csv_url}`);
        return { nombre: body.csv_nombre || 'cheques.csv', datos: Buffer.from(await r.arrayBuffer()) };
    }
    const { data, error } = await supa.storage.from(body.csv_bucket).download(body.csv_path);
    if (error) throw new Error(`No se pudo bajar el CSV de ${body.csv_bucket}/${body.csv_path}: ${error.message}`);
    return {
        nombre: body.csv_nombre || body.csv_path.split('/').pop(),
        datos:  Buffer.from(await data.arrayBuffer()),
    };
}

app.http('cheques-execute', {
    methods:   ['POST'],
    route:     'cheques/execute',
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const key = request.headers.get('x-internal-key');
        if (!key || key !== process.env.CMF_INTERNAL_GATEWAY_KEY) {
            return { status: 401, jsonBody: { ok: false, error: 'Unauthorized' } };
        }

        let body;
        try {
            const crudo = await request.text();
            try { body = JSON.parse(crudo); }
            catch (pe) {
                context.error('Body JSON inválido:', pe.message, '| body:', crudo.slice(0, 1000));
                return { status: 400, jsonBody: { ok: false, error: `Body JSON inválido: ${pe.message}`,
                                                  body_recibido: crudo.slice(0, 500) } };
            }
        } catch (be) {
            return { status: 400, jsonBody: { ok: false, error: `No se pudo leer el body: ${be.message}` } };
        }

        const faltan = ['operacion_key', 'cliente_codigo', 'tasa_anual', 'gastos_gestion']
            .filter(c => body[c] == null || body[c] === '');
        if (faltan.length) {
            return { status: 400, jsonBody: { ok: false, error: `Campos requeridos: ${faltan.join(', ')}` } };
        }
        if (!body.csv_url && !(body.csv_bucket && body.csv_path)) {
            return { status: 400, jsonBody: { ok: false, error: 'Falta el archivo: mandá csv_url, o csv_bucket + csv_path' } };
        }

        // Los dos salen de custom fields de Jira, así que el match es exacto: no se
        // normaliza nada. Si el combo emite otro valor es un error de configuración y tiene
        // que verse. Ninguno se asume: cargar un lote de garantía como cartera lo deja mal
        // clasificado en Doors y no se nota mirando la liquidación.
        const issueTypeId = String(body.issue_type_id ?? '');
        const modalidad   = body.modalidad;
        if (!ISSUE_TYPES[issueTypeId]) {
            return { status: 400, jsonBody: { ok: false,
                error: `issue_type_id inválido o ausente: ${JSON.stringify(body.issue_type_id ?? null)}. ` +
                       `Valores válidos: ${Object.entries(ISSUE_TYPES).map(([k, v]) => `${k} (${v})`).join(', ')}.` } };
        }
        if (!MODALIDADES.includes(modalidad)) {
            return { status: 400, jsonBody: { ok: false,
                error: `modalidad inválida o ausente: ${JSON.stringify(modalidad ?? null)}. ` +
                       `Valores válidos: ${MODALIDADES.join(', ')}.` } };
        }
        const banco = bancoDeModalidad(issueTypeId, modalidad);
        if (!banco) {
            return { status: 422, jsonBody: { ok: false,
                error: `No conocemos el código de Doors para ${ISSUE_TYPES[issueTypeId]} + ${modalidad}. ` +
                       `Hay que buscarlo en el lookup del campo Banco (val-pan3) y agregarlo a BANCOS.` } };
        }

        const confirmar = body.confirmar === true || body.confirmar === 'true';
        if (confirmar && !PERMITIR_CONFIRMAR) {
            return { status: 409, jsonBody: { ok: false,
                error: 'La función está desplegada en modo simulación: confirmar está deshabilitado. ' +
                       'Corré con confirmar=false para llegar hasta el resumen, o habilitá la app setting ' +
                       'CHEQUES_PERMITIR_CONFIRMAR=true cuando el paso de confirmación esté validado.' } };
        }
        const cab = {
            fecha:           body.fecha || hoyDdMmYyyy(),
            cliente_codigo:  String(body.cliente_codigo),
            tasa_anual:      body.tasa_anual,
            gastos_gestion:  body.gastos_gestion,
            gastos_administ: body.gastos_administ ?? DEFAULTS.gastos_administ,
            tasa_gastos:     body.tasa_gastos     ?? DEFAULTS.tasa_gastos,
            dias_promedio:   body.dias_promedio   ?? DEFAULTS.dias_promedio,
            moneda:          body.moneda          ?? DEFAULTS.moneda,
            observacion:     body.observacion,
            lector:          body.lector,
            banco,
        };

        const supa = makeSupa();

        // ── el archivo, antes de tocar Doors ──────────────────────────────────
        let archivo, csv;
        try {
            archivo = await bajarCsv(body, supa);
            csv     = parseCsvCheques(archivo.datos);
        } catch (e) {
            return { status: 400, jsonBody: { ok: false, error: e.message } };
        }
        if (csv.errores.length) {
            return { status: 422, jsonBody: { ok: false, error: 'El CSV tiene errores', errores: csv.errores } };
        }
        // Si el caller mandó sus propios totales, tienen que coincidir: un desajuste
        // significa que el archivo no es el que cree que es.
        if (body.cantidad_cheques != null && Number(body.cantidad_cheques) !== csv.cantidad) {
            return { status: 422, jsonBody: { ok: false,
                error: `El archivo tiene ${csv.cantidad} cheques y el parámetro dice ${body.cantidad_cheques}` } };
        }
        if (body.monto_total != null && Math.abs(Number(body.monto_total) - csv.monto) > 0.01) {
            return { status: 422, jsonBody: { ok: false,
                error: `El archivo suma ${csv.monto} y el parámetro dice ${body.monto_total}` } };
        }

        // ── lock por operación ────────────────────────────────────────────────
        const lockKey   = `CHEQ:${body.operacion_key}`;
        const lockOwner = context.invocationId || `cheq-${body.operacion_key}`;
        const { data: gotLock, error: le } = await supa.rpc('cesion_try_lock', {
            p_key: lockKey, p_owner: lockOwner, p_ttl_seconds: LOCK_TTL_SECONDS,
        });
        if (le)       return { status: 500, jsonBody: { ok: false, error: `No se pudo tomar el lock: ${le.message}` } };
        if (!gotLock) return { status: 409, jsonBody: { ok: false, error: `Ya hay un alta en curso para ${body.operacion_key}` } };

        const s = new DoorsSession();
        try {
            await login(s);
            context.log(`Login Doors OK | operación ${body.operacion_key} | ${csv.cantidad} cheques por ${csv.monto} | ${ISSUE_TYPES[issueTypeId]}+${modalidad}=banco ${banco} | confirmar=${confirmar}`);

            const r = await crearLiquidacionCheques(s, FN, cab, archivo, csv, confirmar);
            context.log(`Registro ${r.recId} | confirmado=${r.confirmado} | liq=${r.liqNum}`);

            return {
                status: 200,
                jsonBody: {
                    ok: true,
                    confirmado:       r.confirmado,
                    doors_rec_id:     r.recId,
                    doors_liq_numero: r.liqNum,
                    cantidad_cheques: csv.cantidad,
                    monto_total:      csv.monto,
                    tipo_cheque:      ISSUE_TYPES[issueTypeId],
                    modalidad,
                    banco,
                    resumen:          r.resumen,
                    // en modo simulación el registro queda abierto en Doors, en estado Alta
                    aviso: r.confirmado ? null
                        : `No se confirmó: el registro ${r.recId} queda en estado Alta en Doors. ` +
                          `Volvé a llamar con confirmar=true para cerrarlo.`,
                },
            };
        } catch (e) {
            context.error(`Error en cheques-execute (${body.operacion_key}):`, e.message);
            return { status: 502, jsonBody: { ok: false, error: e.message,
                                              cantidad_cheques: csv.cantidad, monto_total: csv.monto } };
        } finally {
            try {
                await supa.rpc('cesion_unlock', { p_key: lockKey, p_owner: lockOwner });
            } catch (ue) {
                context.error('No se pudo liberar el lock:', ue.message);
            }
        }
    },
});
