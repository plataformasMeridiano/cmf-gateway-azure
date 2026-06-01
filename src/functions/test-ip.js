const { app } = require('@azure/functions');
const https = require('https');

app.http('test-ip', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const data = await new Promise((resolve, reject) => {
                https.get('https://api.ipify.org?format=json', (res) => {
                    let body = '';

                    res.on('data', (chunk) => {
                        body += chunk;
                    });

                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(body));
                        } catch (err) {
                            reject(new Error('Respuesta no JSON: ' + body));
                        }
                    });
                }).on('error', (err) => {
                    reject(err);
                });
            });

            return {
                status: 200,
                jsonBody: {
                    ok: true,
                    outbound_ip: data.ip
                }
            };
        } catch (error) {
            context.error('Error obteniendo IP pública', error);

            return {
                status: 500,
                jsonBody: {
                    ok: false,
                    error: error.message
                }
            };
        }
    }
});