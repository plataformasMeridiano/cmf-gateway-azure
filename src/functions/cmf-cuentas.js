const { app } = require('@azure/functions');
const https = require('https');
const querystring = require('querystring');
const { createClient } = require('@supabase/supabase-js');

let cmfTokenCache = {
  accessToken: null,
  expiresAt: 0
};

function makeSupa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY,
    { realtime: { transport: require('ws') } });
}

async function logRequest(endpoint, request, cmfResponse, errorMsg, url) {
  try {
    const supa = makeSupa();
    await supa.from('cmf_requests_log').insert({
      endpoint,
      ok:         cmfResponse ? cmfResponse.statusCode >= 200 && cmfResponse.statusCode < 300 : false,
      request:    request    || null,
      cmf_status: cmfResponse?.statusCode  || null,
      cmf_code:   cmfResponse?.body?.respuesta?.codigo      || null,
      cmf_desc:   cmfResponse?.body?.respuesta?.descripcion || null,
      cmf_body:   typeof cmfResponse?.body === 'object' ? cmfResponse.body : null,
      error_msg:  errorMsg   || null,
      url:        url        || null,
    });
  } catch { /* no interrumpir el flujo si falla el log */ }
}

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
            // deja responseBody como texto
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

    if (body) {
      req.write(body);
    }

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

app.http('cmf-cuentas', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const internalKey = request.headers.get('x-internal-key');

      if (!internalKey || internalKey !== process.env.CMF_INTERNAL_GATEWAY_KEY) {
        return {
          status: 401,
          jsonBody: {
            ok: false,
            error: 'Unauthorized'
          }
        };
      }

      if (!process.env.CMF_BASE_URL || !process.env.CMF_AUTH_URL || !process.env.CMF_CLIENT_ID || !process.env.CMF_CLIENT_SECRET) {
        return {
          status: 500,
          jsonBody: {
            ok: false,
            error: 'Faltan variables de entorno de CMF'
          }
        };
      }

      const token = await getCmfBearerToken(context);

      const cmfUrl = `${process.env.CMF_BASE_URL}/cmf/cuentas/v2/cuentas`;
      context.log('CMF cuentas URL:', cmfUrl);

      const cmfResponse = await httpsRequest({
        method: 'GET',
        url: cmfUrl,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      await logRequest('cmf-cuentas', null, cmfResponse, null, request.url);

      return {
        status: cmfResponse.statusCode,
        jsonBody: {
          ok: cmfResponse.statusCode >= 200 && cmfResponse.statusCode < 300,
          cmf_status: cmfResponse.statusCode,
          data: cmfResponse.body
        }
      };
    } catch (error) {
      context.error('Error en cmf-cuentas', error);
      await logRequest('cmf-cuentas', null, null, error.message, request.url);

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