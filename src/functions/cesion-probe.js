const { app }       = require('@azure/functions');
// El probe ya no calcula el número de cesión: lo asigna Doors al crear la liquidación y
// execute lo lee del PDF. Queda como chequeo previo de que Doors responde y las
// credenciales sirven, antes de que la operación se dé por lista para ejecutar.
const { DoorsSession, makeSupa, login } = require('../doors-helpers');

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

        const s = new DoorsSession();

        try {
            await login(s);
            context.log('Login OK — Doors responde');

            const { error: ue } = await supa
                .from('doors_liquidaciones_facturas')
                .update({ status: 'ready' })
                .eq('id', row.id);

            if (ue) throw new Error(`Supabase update (ready): ${ue.message}`);
            context.log('Probe completado:', jira_factura_key);

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
