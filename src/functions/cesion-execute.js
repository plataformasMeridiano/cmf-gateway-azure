const { app } = require('@azure/functions');
const {
    DoorsSession, lqfBase, makeSupa,
    login, lookupFirmante, crearLiquidacion, descargarYSubirPdf, actualizarTasa,
} = require('../doors-helpers');

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
        if (!jira_cesion_key) {
            return { status: 400, jsonBody: { ok: false, error: 'jira_cesion_key es requerido' } };
        }

        if (isMock) {
            return {
                status: 200,
                jsonBody: {
                    ok: true,
                    facturas: [
                        { ok: true,  jira_factura_key: jira_cesion_key + '-FC1', doors_liq_numero: '99001', cesion_numero: 51, pdf_filename: 'meridiano/47987.pdf', skipped: false, error_msg: null },
                        { ok: true,  jira_factura_key: jira_cesion_key + '-FC2', doors_liq_numero: '99000', cesion_numero: 50, pdf_filename: 'meridiano/47987.pdf', skipped: true,  error_msg: null },
                        { ok: false, jira_factura_key: jira_cesion_key + '-FC3', doors_liq_numero: null,    cesion_numero: null, pdf_filename: null,                skipped: false, error_msg: 'SBX mock: Doors timeout al crear liquidación' },
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

        // Calcular importe_efectivo y monto_anticipo por factura
        const facturasConMontos = facturas.map(r => {
            const importeOriginal = parseFloat(r.importe_original || 0);
            const importeEfectivo = r.id === maxFactura.id
                ? importeOriginal - totalNotas
                : importeOriginal;
            const pct           = parseFloat(r.porcentaje_anticipo || 0);
            const montoAnticipo = Math.round(importeEfectivo * pct / 100 * 100) / 100;
            const montoGarantia = Math.round((importeEfectivo - montoAnticipo) * 100) / 100;
            return { ...r, importe_efectivo: importeEfectivo, monto_anticipo: montoAnticipo, monto_garantia: montoGarantia };
        });

        // cesion_actual: el probe guarda el mismo valor para todos los docs de la operación
        const cesionBase = rows[0].cesion_actual || 0;

        const lqf = lqfBase(facturas[0].sociedad);
        const s   = new DoorsSession();
        const resultados = [];

        try {
            await login(s);
            context.log('Login Doors OK');

            const razonSocial = rows[0].razon_social
                || await lookupFirmante(s, rows[0].sociedad, rows[0].cuit_deudor);

            // Procesar cada FC en orden (el índice determina el cesion_numero)
            for (let i = 0; i < facturasConMontos.length; i++) {
                const factura      = facturasConMontos[i];
                const cesionNumero = cesionBase + 1 + i;

                if (factura.status === 'ok') {
                    context.log(`Factura ${factura.jira_factura_key} ya procesada, saltando`);
                    resultados.push({ ok: true, jira_factura_key: factura.jira_factura_key, doors_liq_numero: factura.doors_liq_numero, cesion_numero: factura.cesion_numero, pdf_filename: factura.pdf_filename, skipped: true, error_msg: null });
                    continue;
                }

                let recId = null;
                try {
                    const rowParaDoors = {
                        ...factura,
                        razon_social:             razonSocial,
                        fecha_operacion_ddmmyyyy: factura.fecha_operacion_ddmmyyyy || isoToDdMmYyyy(factura.fecha_operacion),
                        fecha_dep_ddmmyyyy:       factura.fecha_dep_ddmmyyyy       || isoToDdMmYyyy(factura.fecha_dep),
                        fecha_emision_ddmmyyyy:   factura.fecha_emision_ddmmyyyy   || isoToDdMmYyyy(factura.fecha_emision),
                    };

                    const result = await crearLiquidacion(s, lqf, rowParaDoors);
                    recId        = result.recId;
                    const { liqNum } = result;
                    context.log(`Liquidación creada para ${factura.jira_factura_key}:`, liqNum);

                    const pdfPath = await descargarYSubirPdf(s, lqf, liqNum, factura.sociedad, supa);
                    context.log('PDF subido:', pdfPath);

                    await actualizarTasa(s, factura.cliente_codigo, cesionNumero, factura.tasa_anual);
                    context.log(`Tasa actualizada → cesion ${cesionNumero}`);

                    await supa.from('doors_liquidaciones_facturas').update({
                        doors_rec_id:     recId,
                        doors_liq_numero: liqNum,
                        cesion_numero:    cesionNumero,
                        pdf_filename:     pdfPath,
                        razon_social:     razonSocial,
                        importe_efectivo: factura.importe_efectivo,
                        monto_anticipo:   factura.monto_anticipo,
                        status:           'ok',
                        error_msg:        null,
                    }).eq('id', factura.id);

                    resultados.push({ ok: true, jira_factura_key: factura.jira_factura_key, doors_liq_numero: liqNum, cesion_numero: cesionNumero, pdf_filename: pdfPath, skipped: false, error_msg: null });

                } catch (facturaError) {
                    context.error(`Error procesando ${factura.jira_factura_key}:`, facturaError.message);

                    if (recId) {
                        try { await s.get(`${lqf}/fac-pan0.php?id=${recId}&atras=1`); } catch {}
                    }

                    await supa.from('doors_liquidaciones_facturas').update({
                        status:    'error',
                        error_msg: facturaError.message,
                    }).eq('id', factura.id);

                    resultados.push({ ok: false, jira_factura_key: factura.jira_factura_key, doors_liq_numero: null, cesion_numero: null, pdf_filename: null, skipped: false, error_msg: facturaError.message });
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
        }
    },
});

function isoToDdMmYyyy(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('T')[0].split('-');
    return `${d}-${m}-${y}`;
}
