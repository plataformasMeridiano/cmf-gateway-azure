const { app } = require('@azure/functions');
const { makeSupa } = require('../doors-helpers');

app.http('cesion-status', {
    methods:   ['GET'],
    route:     'cesion/status',
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const key = request.headers.get('x-internal-key');
        if (!key || key !== process.env.CMF_INTERNAL_GATEWAY_KEY) {
            return { status: 401, jsonBody: { ok: false, error: 'Unauthorized' } };
        }

        const jira_cesion_key = request.query.get('jira_cesion_key');
        if (!jira_cesion_key) {
            return { status: 400, jsonBody: { ok: false, error: 'jira_cesion_key es requerido' } };
        }

        const supa = makeSupa();

        const { data: rows, error } = await supa
            .from('doors_liquidaciones_facturas')
            .select('jira_factura_key, tipo_documento, status, error_msg')
            .eq('jira_cesion_key', jira_cesion_key)
            .not('status', 'in', '(ready,ok)');

        if (error) {
            context.error('Supabase error:', error.message);
            return { status: 500, jsonBody: { ok: false, error: error.message } };
        }

        return {
            status: 200,
            jsonBody: {
                ok:            true,
                all_ready:     rows.length === 0,
                pending_count: rows.length,
                pending:       rows,
            },
        };
    },
});
