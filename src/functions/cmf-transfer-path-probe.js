const { app } = require('@azure/functions');
const https = require('https');
const querystring = require('querystring');

let cmfTokenCache = {
    accessToken: null,
    expiresAt: 0
};

function httpsRequest({ method, url, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);

        const options = {
            method,
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers
        };

        const req = https.request(options, (res) => {
            let responseBody = '';

            res.on('data', (chunk) => {
                responseBody += chunk;
            });

            res.on('end', () => {
                const contentType = res.headers['content-type'] || '';
                let parsed = responseBody;

                if (contentType.includes('application/json')) {
                    try {
                        parsed = JSON.parse(responseBody);
                    } catch {
                        // dejar texto crudo
                    }
                }

                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: parsed
                });
            });
        });

        req.on('error', reject);

        if (body) req.write(body);
        req.end();
    });
}

async function getCmfBearerToken(context) {
    const skewSeconds = parseInt(process.env.CMF_TOKEN_REFRESH_SKEW_SECONDS || '60', 10);
    const now = Math.floor(Date.now() / 1000);

    if (
        cmfTokenCache.accessToken &&
        cmfTokenCache.expiresAt &&
        now < (cmfTokenCache.expiresAt - skewSeconds)
    ) {
        return cmfTokenCache.accessToken;
    }

    const formBody = querystring.stringify({
        clientId: process.env.CMF_CLIENT_ID,
        clientSecret: process.env.CMF_CLIENT_SECRET
    });

    const response = await httpsRequest({
        method: 'POST',
        url: process.env.CMF_AUTH_URL,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(formBody)
        },
        body: formBody
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Error autenticando en CMF. Status ${response.statusCode}: ${JSON.stringify(response.body)}`);
    }

    const accessToken = response.body.access_token;
    const expiresIn = response.body.expires_in || 300;

    if (!accessToken) {
        throw new Error(`CMF no devolvió access_token: ${JSON.stringify(response.body)}`);
    }

    cmfTokenCache = {
        accessToken,
        expiresAt: now + expiresIn
    };

    context.log('Token CMF obtenido/renovado correctamente');
    return accessToken;
}

app.http('cmf-transfer-path-probe', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const internalKey = request.headers.get('x-internal-key');
            if (!internalKey || internalKey !== process.env.CMF_INTERNAL_GATEWAY_KEY) {
                return {
                    status: 401,
                    jsonBody: { ok: false, error: 'Unauthorized' }
                };
            }

            const body = await request.json();

            // Payload base: mantenemos contrato v1 para ver si alguna ruta v2 lo acepta
            const payload = {
                cuenta_origen: body.cuenta_origen,
                destino: body.destino,
                importe: body.importe || '1.00',
                moneda: body.moneda || 'ARS',
                concepto: body.concepto || 'VAR',
                referencia: body.referencia || 'TEST PATH PROBE'
            };

            if (!payload.cuenta_origen || !payload.destino) {
                return {
                    status: 400,
                    jsonBody: {
                        ok: false,
                        error: 'cuenta_origen y destino son obligatorios'
                    }
                };
            }

            const token = await getCmfBearerToken(context);
            const rawBody = JSON.stringify(payload);

            const candidates = [
                '/cmf/transfers/v2/transfers',
                '/cmf/transferencias/v2/transferencias',
                '/cmf/transfers/v2/transferencias',
                '/cmf/transfer/v2/transfer',
                '/cmf/transfers/v2/transfers/execute'
            ];

            const results = [];

            for (const path of candidates) {
                const url = `${process.env.CMF_BASE_URL}${path}`;
                context.log(`Probing CMF transfer path: ${url}`);

                try {
                    const response = await httpsRequest({
                        method: 'POST',
                        url,
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': `Bearer ${token}`,
                            'Content-Length': Buffer.byteLength(rawBody)
                        },
                        body: rawBody
                    });

                    results.push({
                        path,
                        status: response.statusCode,
                        body: response.body
                    });
                } catch (err) {
                    results.push({
                        path,
                        status: null,
                        error: err.message
                    });
                }
            }

            return {
                status: 200,
                jsonBody: {
                    ok: true,
                    tested: candidates.length,
                    payload,
                    results
                }
            };
        } catch (error) {
            context.error('Error en cmf-transfer-path-probe', error);
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