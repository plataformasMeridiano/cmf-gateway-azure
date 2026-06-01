const { app }       = require('@azure/functions');
const { DoorsSession, makeSupa, login, getMaxCesion } = require('../doors-helpers');

app.storageQueue('cesion-probe', {
    queueName:  'cesion-probe',
    connection: 'AzureWebJobsStorage',
    handler: async (message, context) => {
        const { jira_cesion_key } = typeof message === 'string' ? JSON.parse(message) : message;
        context.log('Probe iniciado para:', jira_cesion_key);

        const supa = makeSupa();

        // Leer la row de Supabase
        const { data: row, error: re } = await supa
            .from('doors_liquidaciones_facturas')
            .select('id, cliente_codigo, sociedad, status')
            .eq('jira_cesion_key', jira_cesion_key)
            .single();

        if (re || !row) {
            context.error('Row no encontrada para:', jira_cesion_key);
            return;
        }

        if (row.status !== 'probing') {
            context.log('Row no está en probing, ignorando. Status:', row.status);
            return;
        }

        const s = new DoorsSession();

        try {
            await login(s);
            context.log('Login OK');

            const cesionActual = await getMaxCesion(s, row.cliente_codigo);
            context.log('cesion_actual:', cesionActual, 'para cliente:', row.cliente_codigo);

            await supa
                .from('doors_liquidaciones_facturas')
                .update({ cesion_actual: cesionActual, status: 'ready' })
                .eq('id', row.id);

            context.log('Probe completado:', jira_cesion_key, '→ cesion_actual =', cesionActual);

        } catch (error) {
            context.error('Error en probe:', error.message);
            await supa
                .from('doors_liquidaciones_facturas')
                .update({ status: 'error_probe', error_msg: error.message })
                .eq('id', row.id);
        }
    },
});
