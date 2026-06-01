const { app, output } = require('@azure/functions');
const { makeSupa, parseDate, DOORS_USER } = require('../doors-helpers');

const probeQueue = output.storageQueue({
    queueName:  'cesion-probe',
    connection: 'AzureWebJobsStorage',
});

app.http('cesion-prepare', {
    methods:      ['POST'],
    route:        'cesion/prepare',
    authLevel:    'anonymous',
    extraOutputs: [probeQueue],
    handler: async (request, context) => {
        const key = request.headers.get('x-internal-key');
        if (!key || key !== process.env.CMF_INTERNAL_GATEWAY_KEY) {
            return { status: 401, jsonBody: { ok: false, error: 'Unauthorized' } };
        }

        let req;
        try { req = await request.json(); }
        catch { return { status: 400, jsonBody: { ok: false, error: 'Body JSON inválido' } }; }

        const required = ['jira_cesion_key','sociedad','cliente_codigo','fecha_operacion',
                          'fecha_dep','letra','prefijo','numero','fecha_emision',
                          'importe_original','cuit_deudor','tasa_anual'];
        const missing = required.filter(f => req[f] == null || req[f] === '');
        if (missing.length) {
            return { status: 400, jsonBody: { ok: false, error: `Campos requeridos: ${missing.join(', ')}` } };
        }
        if (!['Meridiano', 'Pamat', 'Mancia'].includes(req.sociedad)) {
            return { status: 400, jsonBody: { ok: false, error: `sociedad inválida: ${req.sociedad}` } };
        }

        const supa = makeSupa();

        const ERROR_STATUSES = ['error', 'error_probe'];

        // Validar duplicado de factura
        const { data: facRows } = await supa
            .from('doors_liquidaciones_facturas')
            .select('id, status, doors_liq_numero')
            .eq('sociedad', req.sociedad)
            .eq('letra',    req.letra)
            .eq('prefijo',  req.prefijo)
            .eq('numero',   req.numero);

        const dup = (facRows || []).find(r => !ERROR_STATUSES.includes(r.status));
        if (dup) {
            return {
                status: 409,
                jsonBody: {
                    ok:    false,
                    error: `Factura ya registrada (liq. Doors ${dup.doors_liq_numero || 'pendiente'}, status: ${dup.status})`,
                    existing_id: dup.id,
                },
            };
        }

        // Validar que no exista ya una row para este jira_cesion_key en estado no-error
        const { data: jiraRows } = await supa
            .from('doors_liquidaciones_facturas')
            .select('id, status')
            .eq('jira_cesion_key', req.jira_cesion_key);

        const dupJira = (jiraRows || []).find(r => !ERROR_STATUSES.includes(r.status));
        if (dupJira) {
            return {
                status: 409,
                jsonBody: {
                    ok:    false,
                    error: `jira_cesion_key ${req.jira_cesion_key} ya tiene un proceso en curso (status: ${dupJira.status})`,
                    existing_id: dupJira.id,
                },
            };
        }

        // Insertar row con todos los datos + status 'probing'
        const { data: row, error: ie } = await supa
            .from('doors_liquidaciones_facturas')
            .insert({
                jira_cesion_key:     req.jira_cesion_key,
                jira_factura_key:    req.jira_factura_key    || null,
                sociedad:            req.sociedad,
                cliente_codigo:      req.cliente_codigo,
                nro_escritura:       req.nro_escritura        || null,
                tipo_ganancias:      req.tipo_ganancias       || '6',
                porcentaje_anticipo: req.porcentaje_anticipo  || 0,
                porcentaje_garantia: req.porcentaje_garantia  || 0,
                observaciones:       req.observaciones        || null,
                letra:               req.letra,
                prefijo:             req.prefijo,
                numero:              req.numero,
                fecha_operacion:     parseDate(req.fecha_operacion),
                fecha_emision:       parseDate(req.fecha_emision),
                fecha_dep:           parseDate(req.fecha_dep),
                // Guardamos las fechas en DD-MM-YYYY para pasarlas a Doors en execute
                fecha_operacion_ddmmyyyy: req.fecha_operacion,
                fecha_emision_ddmmyyyy:   req.fecha_emision,
                fecha_dep_ddmmyyyy:       req.fecha_dep,
                importe_original:    req.importe_original,
                cuit_deudor:         req.cuit_deudor,
                tasa_anual:          req.tasa_anual,
                status:              'probing',
                usuario_doors:       DOORS_USER,
            })
            .select()
            .single();

        if (ie) {
            context.error('Supabase insert error:', ie);
            return { status: 500, jsonBody: { ok: false, error: `Supabase: ${ie.message}` } };
        }

        // Encolar el probe
        context.extraOutputs.set(probeQueue, JSON.stringify({ jira_cesion_key: req.jira_cesion_key }));
        context.log('Probe encolado para:', req.jira_cesion_key);

        return {
            status: 200,
            jsonBody: {
                ok:              true,
                jira_cesion_key: req.jira_cesion_key,
                status:          'probing',
                id:              row.id,
            },
        };
    },
});
