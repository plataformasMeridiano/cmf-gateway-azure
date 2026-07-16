const { app }       = require('@azure/functions');
const { DoorsSession, makeSupa, login, getMaxCesion } = require('../doors-helpers');

app.storageQueue('cesion-probe', {
    queueName:  'cesion-probe',
    connection: 'AzureWebJobsStorage',
    handler: async (message, context) => {
        const { jira_factura_key } = typeof message === 'string' ? JSON.parse(message) : message;
        context.log('Probe iniciado para:', jira_factura_key);

        const supa = makeSupa();

        // Leer el row en probing (toma el más reciente si hubo re-prepare con duplicados)
        const { data: rows, error: re } = await supa
            .from('doors_liquidaciones_facturas')
            .select('id, jira_cesion_key, cliente_codigo, status')
            .eq('jira_factura_key', jira_factura_key)
            .eq('status', 'probing')
            .order('created_at', { ascending: false })
            .limit(1);

        if (re || !rows?.length) {
            context.log('No hay row en probing para:', jira_factura_key, '— ignorando');
            return;
        }
        const row = rows[0];

        // Si la cesión tiene jira_cesion_key, reusar cesion_actual ya calculado por un hermano
        // (evita abrir N sesiones a Doors en paralelo para el mismo cliente)
        if (row.jira_cesion_key) {
            const { data: hermanos } = await supa
                .from('doors_liquidaciones_facturas')
                .select('cesion_actual')
                .eq('jira_cesion_key', row.jira_cesion_key)
                .not('cesion_actual', 'is', null)
                .limit(1);

            if (hermanos?.length) {
                const cesionActual = hermanos[0].cesion_actual;
                context.log(`Reutilizando cesion_actual=${cesionActual} de hermano para ${jira_factura_key}`);
                await supa
                    .from('doors_liquidaciones_facturas')
                    .update({ cesion_actual: cesionActual, status: 'ready' })
                    .eq('id', row.id);
                return;
            }
        }

        // Primero en llegar (o sin jira_cesion_key): abre Doors y calcula
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
                await supa
                    .from('doors_liquidaciones_facturas')
                    .update({ status: 'error_probe', error_msg: error.message })
                    .eq('id', row.id);
            } catch (supaError) {
                context.error('Excepción al actualizar error_probe:', supaError.message);
            }
        }
    },
});
