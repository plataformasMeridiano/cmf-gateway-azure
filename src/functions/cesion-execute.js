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
        const key = request.headers.get('x-internal-key');
        if (!key || key !== process.env.CMF_INTERNAL_GATEWAY_KEY) {
            return { status: 401, jsonBody: { ok: false, error: 'Unauthorized' } };
        }

        let body;
        try { body = await request.json(); }
        catch { return { status: 400, jsonBody: { ok: false, error: 'Body JSON inválido' } }; }

        const { jira_factura_key } = body;
        if (!jira_factura_key) {
            return { status: 400, jsonBody: { ok: false, error: 'jira_factura_key es requerido' } };
        }

        const supa = makeSupa();

        // Leer row de Supabase
        const { data: row, error: re } = await supa
            .from('doors_liquidaciones_facturas')
            .select('*')
            .eq('jira_factura_key', jira_factura_key)
            .single();

        if (re || !row) {
            return { status: 404, jsonBody: { ok: false, error: `No se encontró registro para ${jira_factura_key}` } };
        }

        // Validar estado
        if (row.status === 'ok') {
            return {
                status: 200,
                jsonBody: {
                    ok: true, already_done: true,
                    doors_liq_numero: row.doors_liq_numero,
                    cesion_numero:    row.cesion_numero,
                    razon_social:     row.razon_social,
                    pdf_path:         row.pdf_filename,
                },
            };
        }
        if (row.status === 'probing') {
            return { status: 409, jsonBody: { ok: false, error: 'El probe todavía está en curso' } };
        }
        if (row.status === 'error_probe') {
            return { status: 422, jsonBody: { ok: false, error: `El probe falló: ${row.error_msg}` } };
        }
        if (row.status !== 'ready') {
            return { status: 409, jsonBody: { ok: false, error: `Estado inesperado: ${row.status}` } };
        }

        const lqf = lqfBase(row.sociedad);
        const s   = new DoorsSession();
        let recId = null;

        try {
            await login(s);
            context.log('Login Doors OK');

            // Resolver razón social (si no está en la row, la buscamos)
            const razonSocial = row.razon_social || await lookupFirmante(s, row.sociedad, row.cuit_deudor);

            const cesionNumero = (row.cesion_actual || 0) + 1;
            context.log('Cesion numero:', cesionNumero);

            // Enriquecer la row con los campos DD-MM-YYYY que necesita crearLiquidacion
            const rowParaDoors = {
                ...row,
                razon_social: razonSocial,
                // crearLiquidacion espera fecha_operacion_ddmmyyyy, fecha_dep_ddmmyyyy, fecha_emision_ddmmyyyy
                // Si no están en la row (tabla vieja), los derivamos de las columnas ISO
                fecha_operacion_ddmmyyyy: row.fecha_operacion_ddmmyyyy || isoToDdMmYyyy(row.fecha_operacion),
                fecha_dep_ddmmyyyy:       row.fecha_dep_ddmmyyyy       || isoToDdMmYyyy(row.fecha_dep),
                fecha_emision_ddmmyyyy:   row.fecha_emision_ddmmyyyy   || isoToDdMmYyyy(row.fecha_emision),
            };

            const result = await crearLiquidacion(s, lqf, rowParaDoors);
            recId = result.recId;
            const { liqNum } = result;
            context.log('Liquidación creada:', liqNum);

            const pdfPath = await descargarYSubirPdf(s, lqf, liqNum, row.sociedad, supa);
            context.log('PDF subido:', pdfPath);

            await actualizarTasa(s, row.cliente_codigo, cesionNumero, row.tasa_anual);
            context.log('Tasa actualizada → cesion', cesionNumero);

            await supa.from('doors_liquidaciones_facturas').update({
                doors_rec_id:     recId,
                doors_liq_numero: liqNum,
                cesion_numero:    cesionNumero,
                pdf_filename:     pdfPath,
                razon_social:     razonSocial,
                status:           'ok',
                error_msg:        null,
            }).eq('id', row.id);

            return {
                status: 200,
                jsonBody: {
                    ok:               true,
                    doors_liq_numero: liqNum,
                    cesion_numero:    cesionNumero,
                    razon_social:     razonSocial,
                    pdf_path:         pdfPath,
                },
            };

        } catch (error) {
            context.error('Error en execute:', error.message);

            if (recId) {
                try { await s.get(`${lqfBase(row.sociedad)}/fac-pan0.php?id=${recId}&atras=1`); }
                catch {}
            }

            await supa.from('doors_liquidaciones_facturas').update({
                status:    'error',
                error_msg: error.message,
            }).eq('id', row.id);

            return { status: 500, jsonBody: { ok: false, error: error.message } };
        }
    },
});

function isoToDdMmYyyy(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('T')[0].split('-');
    return `${d}-${m}-${y}`;
}
