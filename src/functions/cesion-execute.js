const { app } = require('@azure/functions');
const {
    DoorsSession, lqfBase, makeSupa, normalizarTipoOperacion, pan0Prog,
    login, lookupFirmante, crearLiquidacion, descargarYSubirPdf, actualizarTasa,
} = require('../doors-helpers');

// TTL del lock de la operación. Cubre un execute completo; si vence con el run todavía
// vivo, el claim por factura (capa 2) sigue impidiendo el doble procesamiento.
const LOCK_TTL_SECONDS  = 900;   // 15 min
// TTL del claim por factura. Muy por encima de lo que tarda una sola (segundos),
// así un claim solo se recupera cuando el run que lo tomó realmente murió.
const CLAIM_TTL_SECONDS = 600;   // 10 min

app.http('cesion-execute', {
    methods:   ['POST'],
    route:     'cesion/execute',
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const key    = request.headers.get('x-internal-key');
        const isMock = key && key === process.env.CMF_INTERNAL_GATEWAY_KEY_SBX;
        const isReal = key && key === process.env.CMF_INTERNAL_GATEWAY_KEY;
        if (!isMock && !isReal) {
            return { status: 401, jsonBody: { ok: false, error: 'Unauthorized' } };
        }

        let body;
        try { body = await request.json(); }
        catch { return { status: 400, jsonBody: { ok: false, error: 'Body JSON inválido' } }; }

        const { jira_cesion_key } = body;
        const montoAprobadoRaw    = (body.monto_aprobado      != null && body.monto_aprobado      !== '') ? body.monto_aprobado      : null;
        const porcentajeOverride  = (body.porcentaje_anticipo != null && body.porcentaje_anticipo !== '') ? parseFloat(body.porcentaje_anticipo) : null;
        // Custom field de la cesión en Jira: "Cesión Puntual" o "Factoring" (si no viene: cesión)
        const tipoOperacion       = normalizarTipoOperacion(body.tipo_operacion);
        if (!jira_cesion_key) {
            return { status: 400, jsonBody: { ok: false, error: 'jira_cesion_key es requerido' } };
        }
        if (!tipoOperacion) {
            return { status: 400, jsonBody: { ok: false, error: `tipo_operacion inválido: ${body.tipo_operacion}. Valores válidos: "Cesión Puntual" o "Factoring"` } };
        }

        if (isMock) {
            return {
                status: 200,
                jsonBody: {
                    ok: true,
                    facturas: [
                        { ok: true,  jira_factura_key: jira_cesion_key + '-FC1', doors_liq_numero: '99001', cesion_numero: 51, pdf_filename: 'meridiano/47987.pdf', monto_anticipo: 50000,  skipped: false, error_msg: null },
                        { ok: true,  jira_factura_key: jira_cesion_key + '-FC2', doors_liq_numero: '99000', cesion_numero: 50, pdf_filename: 'meridiano/47987.pdf', monto_anticipo: 30000,  skipped: true,  error_msg: null },
                        { ok: false, jira_factura_key: jira_cesion_key + '-FC3', doors_liq_numero: null,    cesion_numero: null, pdf_filename: null,                monto_anticipo: null,   skipped: false, error_msg: 'SBX mock: Doors timeout al crear liquidación' },
                    ],
                },
            };
        }

        const supa = makeSupa();

        const { data: rows, error: re } = await supa
            .from('doors_liquidaciones_facturas')
            .select('*')
            .eq('jira_cesion_key', jira_cesion_key)
            .order('id');

        if (re || !rows?.length) {
            return { status: 404, jsonBody: { ok: false, error: `No se encontraron registros para cesión ${jira_cesion_key}` } };
        }

        // Validar estados
        const enProbing = rows.filter(r => r.status === 'probing');
        if (enProbing.length) {
            return { status: 409, jsonBody: { ok: false, error: `Hay ${enProbing.length} documento(s) todavía en probing: ${enProbing.map(r => r.jira_factura_key).join(', ')}` } };
        }
        const conErrorProbe = rows.filter(r => r.status === 'error_probe');
        if (conErrorProbe.length) {
            return { status: 422, jsonBody: { ok: false, error: `Documentos con error de probe: ${conErrorProbe.map(r => r.jira_factura_key).join(', ')}` } };
        }

        // Separar FC de NC/ND
        const facturas = rows.filter(r => r.tipo_documento === 'FC');
        const notas    = rows.filter(r => r.tipo_documento !== 'FC');

        if (!facturas.length) {
            return { status: 400, jsonBody: { ok: false, error: 'La cesión no tiene facturas (FC) para procesar' } };
        }

        // Total de importes de NCs/NDs → se resta de la factura más grande
        const totalNotas = notas.reduce((sum, r) => sum + parseFloat(r.importe_original || 0), 0);

        // Factura con mayor importe_original (absorbe el ajuste de NC/ND)
        const maxFactura = facturas.reduce((max, r) =>
            parseFloat(r.importe_original) > parseFloat(max.importe_original) ? r : max
        );

        // importe_efectivo: la factura de mayor importe absorbe el ajuste de NC/ND
        const facturasConMontos = facturas.map(r => {
            const importeOriginal = parseFloat(r.importe_original || 0);
            const importeEfectivo = r.id === maxFactura.id
                ? importeOriginal - totalNotas
                : importeOriginal;
            return { ...r, importe_efectivo: importeEfectivo };
        });

        if (montoAprobadoRaw != null) {
            // Modo monto (cesión con escritura): prorratear monto_aprobado proporcional a importe_efectivo
            const montoAprobado = parseFloat(montoAprobadoRaw);
            const totalEfectivo = facturasConMontos.reduce((s, f) => s + f.importe_efectivo, 0);
            let acumulado = 0;
            for (let i = 0; i < facturasConMontos.length; i++) {
                const f        = facturasConMontos[i];
                const esUltima = i === facturasConMontos.length - 1;
                const monto    = esUltima
                    ? Math.round((montoAprobado - acumulado) * 100) / 100
                    : Math.round(montoAprobado * f.importe_efectivo / totalEfectivo * 100) / 100;
                f.monto_anticipo = Math.max(0, Math.min(monto, f.importe_efectivo));
                f.monto_garantia = Math.round((f.importe_efectivo - f.monto_anticipo) * 100) / 100;
                acumulado        = Math.round((acumulado + f.monto_anticipo) * 100) / 100;
            }
        } else {
            // Modo % (factoring): porcentajeOverride del body, o porcentaje_anticipo de cada factura
            for (const f of facturasConMontos) {
                const pct        = porcentajeOverride != null ? porcentajeOverride : parseFloat(f.porcentaje_anticipo || 0);
                f.monto_anticipo = Math.round(f.importe_efectivo * pct / 100 * 100) / 100;
                f.monto_garantia = Math.round((f.importe_efectivo - f.monto_anticipo) * 100) / 100;
            }
        }

        const lqf = lqfBase(facturas[0].sociedad);

        // Capa 1 — lock por cesión: impide que dos execute concurrentes trabajen la misma
        // operación. Si el dueño anterior murió, el TTL deja que este run lo tome.
        // Se toma acá, después de todas las validaciones: nada entre este punto y el try
        // puede fallar, así que el lock nunca queda tomado por un camino que no lo libera.
        const lockOwner = context.invocationId || `exec-${jira_cesion_key}`;
        const { data: gotLock, error: le } = await supa.rpc('cesion_try_lock', {
            p_key: jira_cesion_key, p_owner: lockOwner, p_ttl_seconds: LOCK_TTL_SECONDS,
        });
        if (le) {
            context.error('Error al pedir el lock:', le.message);
            return { status: 500, jsonBody: { ok: false, error: `No se pudo tomar el lock: ${le.message}` } };
        }
        if (!gotLock) {
            context.log(`Lock ocupado para ${jira_cesion_key} — hay otro execute en curso`);
            return { status: 409, jsonBody: { ok: false, error: `Ya hay un execute en curso para la cesión ${jira_cesion_key}. Esperá a que termine antes de reintentar.` } };
        }
        context.log(`Lock tomado para ${jira_cesion_key} (owner: ${lockOwner})`);

        const s   = new DoorsSession();
        const resultados = [];

        try {
            await login(s);
            context.log('Login Doors OK | tipo_operacion:', tipoOperacion, '→', pan0Prog(tipoOperacion));

            const razonSocial = rows[0].razon_social
                || await lookupFirmante(s, rows[0].sociedad, rows[0].cuit_deudor);

            for (let i = 0; i < facturasConMontos.length; i++) {
                const factura = facturasConMontos[i];

                if (factura.status === 'ok') {
                    context.log(`Factura ${factura.jira_factura_key} ya procesada, saltando`);
                    resultados.push({ ok: true, jira_factura_key: factura.jira_factura_key, doors_liq_numero: factura.doors_liq_numero, cesion_numero: factura.cesion_numero, pdf_filename: factura.pdf_filename, monto_anticipo: factura.monto_anticipo, skipped: true, error_msg: null });
                    continue;
                }

                // Capa 2 — claim atómico: gana una sola corrida. Cierra la ventana entre
                // "Doors creó la liquidación" y "Supabase dice ok", que es lo que produjo
                // liquidaciones duplicadas cuando dos execute corrieron en paralelo.
                const { data: claimed, error: ce } = await supa.rpc('cesion_claim_factura', {
                    p_id: factura.id, p_stale_seconds: CLAIM_TTL_SECONDS,
                });
                if (ce) {
                    context.error(`Error al reclamar ${factura.jira_factura_key}:`, ce.message);
                    resultados.push({ ok: false, jira_factura_key: factura.jira_factura_key, doors_liq_numero: null, cesion_numero: null, pdf_filename: null, monto_anticipo: factura.monto_anticipo, skipped: false, error_msg: `No se pudo reclamar la factura: ${ce.message}` });
                    continue;
                }
                if (!claimed) {
                    // Otra corrida la tiene o ya la terminó. `rows` es un snapshot previo al lock,
                    // así que releemos para devolver el número de liquidación real y no un null
                    // que dejaría el ticket de Jira sin transicionar.
                    const { data: actual } = await supa
                        .from('doors_liquidaciones_facturas')
                        .select('status, doors_liq_numero, cesion_numero, pdf_filename, monto_anticipo, error_msg')
                        .eq('id', factura.id)
                        .single();
                    const f = actual || factura;
                    context.log(`Factura ${factura.jira_factura_key} tomada por otra corrida (status: ${f.status}), saltando`);
                    resultados.push({ ok: f.status === 'ok', jira_factura_key: factura.jira_factura_key, doors_liq_numero: f.doors_liq_numero ?? null, cesion_numero: f.cesion_numero ?? null, pdf_filename: f.pdf_filename ?? null, monto_anticipo: f.monto_anticipo ?? factura.monto_anticipo, skipped: true, error_msg: f.status === 'ok' ? null : (f.error_msg || 'La factura está siendo procesada por otra corrida') });
                    continue;
                }

                let recId = null;
                try {
                    const rowParaDoors = {
                        ...factura,
                        tipo_operacion:           tipoOperacion,
                        razon_social:             razonSocial,
                        fecha_operacion_ddmmyyyy: factura.fecha_operacion_ddmmyyyy || isoToDdMmYyyy(factura.fecha_operacion),
                        fecha_dep_ddmmyyyy:       factura.fecha_dep_ddmmyyyy       || isoToDdMmYyyy(factura.fecha_dep),
                        fecha_emision_ddmmyyyy:   factura.fecha_emision_ddmmyyyy   || isoToDdMmYyyy(factura.fecha_emision),
                    };

                    const result = await crearLiquidacion(s, lqf, rowParaDoors);
                    recId        = result.recId;
                    const { liqNum } = result;
                    context.log(`Liquidación creada para ${factura.jira_factura_key}:`, liqNum);

                    // El nº de cesión lo asigna Doors y sale del PDF, que ya bajamos acá.
                    // Es dato exacto: no hay que calcularlo ni sondearlo.
                    const { path: pdfPath, cesionNumero } = await descargarYSubirPdf(s, lqf, liqNum, factura.sociedad, supa);
                    context.log('PDF subido:', pdfPath, '| cesion:', cesionNumero);

                    // Sin número no se toca la tasa: escribirla en una cuenta adivinada es
                    // justamente el bug que trajo esto. La liquidación quedó bien igual,
                    // así que se marca ok y se avisa para corregir la tasa a mano.
                    let avisoTasa = null;
                    if (cesionNumero == null) {
                        avisoTasa = `No se pudo leer el nº de cesión del PDF de la liquidación ${liqNum}: la tasa NO se actualizó en Doors`;
                        context.error(avisoTasa);
                    } else {
                        await actualizarTasa(s, factura.cliente_codigo, cesionNumero, factura.tasa_anual);
                        context.log(`Tasa actualizada → cesion ${cesionNumero}`);
                    }

                    await supa.from('doors_liquidaciones_facturas').update({
                        doors_rec_id:     recId,
                        doors_liq_numero: liqNum,
                        cesion_numero:    cesionNumero,
                        pdf_filename:     pdfPath,
                        razon_social:     razonSocial,
                        importe_efectivo: factura.importe_efectivo,
                        monto_anticipo:   factura.monto_anticipo,
                        status:           'ok',
                        error_msg:        avisoTasa,
                        processing_since: null,
                    }).eq('id', factura.id);

                    resultados.push({ ok: true, jira_factura_key: factura.jira_factura_key, doors_liq_numero: liqNum, cesion_numero: cesionNumero, pdf_filename: pdfPath, monto_anticipo: factura.monto_anticipo, skipped: false, error_msg: avisoTasa });

                } catch (facturaError) {
                    context.error(`Error procesando ${factura.jira_factura_key}:`, facturaError.message);

                    if (recId) {
                        try { await s.get(`${lqf}/${pan0Prog(tipoOperacion)}?id=${recId}&atras=1`); } catch {}
                    }

                    await supa.from('doors_liquidaciones_facturas').update({
                        status:           'error',
                        error_msg:        facturaError.message,
                        processing_since: null,
                    }).eq('id', factura.id);

                    resultados.push({ ok: false, jira_factura_key: factura.jira_factura_key, doors_liq_numero: null, cesion_numero: null, pdf_filename: null, monto_anticipo: factura.monto_anticipo, skipped: false, error_msg: facturaError.message });
                }
            }

            // Marcar NC/ND como ok (no se cargan en Doors)
            for (const nota of notas) {
                if (nota.status !== 'ok') {
                    await supa.from('doors_liquidaciones_facturas')
                        .update({ status: 'ok', error_msg: null })
                        .eq('id', nota.id);
                }
            }

            return {
                status: 200,
                jsonBody: { ok: true, facturas: resultados },
            };

        } catch (error) {
            context.error('Error en execute:', error.message);
            return { status: 500, jsonBody: { ok: false, error: error.message } };

        } finally {
            // Liberar el lock pase lo que pase. `cesion_unlock` solo borra si seguimos siendo
            // dueños: si el TTL venció y otro run lo tomó, no se lo pisamos.
            try {
                const { data: released } = await supa.rpc('cesion_unlock', {
                    p_key: jira_cesion_key, p_owner: lockOwner,
                });
                context.log(released
                    ? `Lock liberado para ${jira_cesion_key}`
                    : `Lock de ${jira_cesion_key} ya no era nuestro (venció el TTL y lo tomó otro run)`);
            } catch (ue) {
                // El lock vence solo por TTL, así que no dejamos la cesión trabada.
                context.error('No se pudo liberar el lock:', ue.message);
            }
        }
    },
});

function isoToDdMmYyyy(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('T')[0].split('-');
    return `${d}-${m}-${y}`;
}
