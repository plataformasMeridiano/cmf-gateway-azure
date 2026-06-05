const { app }       = require('@azure/functions');
const { DoorsSession, makeSupa, login, getMaxCesion } = require('../doors-helpers');

app.storageQueue('cesion-probe', {
    queueName:  'cesion-probe',
    connection: 'AzureWebJobsStorage',
    handler: async (message, context) => {
        const { jira_factura_key } = typeof message === 'string' ? JSON.parse(message) : message;
        context.log('Probe iniciado para:', jira_factura_key);

        const supa = makeSupa();

        // Leer la row de Supabase
        const { data: row, error: re } = await supa
            .from('doors_liquidaciones_facturas')
            .select('id, cliente_codigo, sociedad, status')
            .eq('jira_factura_key', jira_factura_key)
            .single();

        if (re || !row) {
            context.error('Row no encontrada para:', jira_factura_key);
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

            const { error: ue } = await supa
                .from('doors_liquidaciones_facturas')
                .update({ cesion_actual: cesionActual, status: 'ready' })
                .eq('id', row.id);

            if (ue) throw new Error(`Supabase update (ready): ${ue.message}`);
            context.log('Probe completado:', jira_factura_key, '→ cesion_actual =', cesionActual);

        } catch (error) {
            context.error('Error en probe:', error.message);
            try {
                const { error: ue } = await supa
                    .from('doors_liquidaciones_facturas')
                    .update({ status: 'error_probe', error_msg: error.message })
                    .eq('id', row.id);
                if (ue) context.error('No se pudo actualizar error_probe en Supabase:', ue.message);
            } catch (supaError) {
                context.error('Excepción al actualizar error_probe en Supabase:', supaError.message);
            }
        }
    },
});
