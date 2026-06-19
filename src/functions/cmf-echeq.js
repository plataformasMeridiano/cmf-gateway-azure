const { app } = require('@azure/functions');
const https = require('https');
const querystring = require('querystring');
const { createClient } = require('@supabase/supabase-js');

let cmfTokenCache = {
  accessToken: null,
  expiresAt: 0
};

function makeSupa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

async function logRequest(endpoint, request, cmfResponse, errorMsg) {
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
    });
  } catch { /* no interrumpir el flujo si falla el log */ }
}

function httpsRequest({ method, url, headers = {}, body = null, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const options = {
      method,
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers,
      timeout: timeoutMs
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        let parsed = responseBody;
        if (contentType.includes('application/json')) {
          try { parsed = JSON.parse(responseBody); } catch { /* dejar texto crudo */ }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Request timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getCmfBearerToken(context) {
  const skewSeconds = parseInt(process.env.CMF_TOKEN_REFRESH_SKEW_SECONDS || '60', 10);
  const now = Math.floor(Date.now() / 1000);

  if (cmfTokenCache.accessToken && cmfTokenCache.expiresAt && now < (cmfTokenCache.expiresAt - skewSeconds)) {
    return cmfTokenCache.accessToken;
  }

  const formBody = querystring.stringify({
    clientId:     process.env.CMF_CLIENT_ID,
    clientSecret: process.env.CMF_CLIENT_SECRET
  });

  const response = await httpsRequest({
    method: 'POST',
    url: process.env.CMF_AUTH_URL,
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody)
    },
    body: formBody
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Error autenticando en CMF. Status ${response.statusCode}: ${JSON.stringify(response.body)}`);
  }

  const accessToken = response.body.access_token;
  const expiresIn   = response.body.expires_in || 300;

  if (!accessToken) throw new Error(`CMF no devolvió access_token: ${JSON.stringify(response.body)}`);

  cmfTokenCache = { accessToken, expiresAt: now + expiresIn };
  context.log('Token CMF obtenido/renovado correctamente');
  return accessToken;
}

// POST /api/cmf-echeq
// Body JSON:
//   select  (string, requerido) — campos a retornar, ej: "cheques.cheque_id,cheques.monto"
//   filter  (string, opcional) — condiciones OData, ej: "cheques.estado eq __ACTIVO__"
//   orderby (string, opcional) — ej: "cheques.fecha_pago!"
//   pag     (string, opcional) — ej: "cheques:1-20"
app.http('cmf-echeq', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const internalKey = request.headers.get('x-internal-key');
      if (!internalKey || internalKey !== process.env.CMF_INTERNAL_GATEWAY_KEY) {
        return { status: 401, jsonBody: { ok: false, error: 'Unauthorized' } };
      }

      let body;
      try { body = await request.json(); }
      catch { return { status: 400, jsonBody: { ok: false, error: 'Body JSON inválido' } }; }

      if (!body.select) {
        return { status: 400, jsonBody: { ok: false, error: 'El campo "select" es obligatorio ($select de CMF)' } };
      }

      const token = await getCmfBearerToken(context);

      const parts = [`$select=${encodeURIComponent(body.select)}`];
      if (body.filter)  parts.push(`$filter=${encodeURIComponent(body.filter)}`);
      if (body.orderby) parts.push(`$orderby=${encodeURIComponent(body.orderby)}`);
      if (body.pag)     parts.push(`$pag=${encodeURIComponent(body.pag)}`);

      const cmfUrl = `${process.env.CMF_BASE_URL}/cmf/cheques/v2/cheques/ListaCheques?${parts.join('&')}`;
      context.log('CMF echeq URL:', cmfUrl);

      const cmfResponse = await httpsRequest({
        method: 'GET',
        url: cmfUrl,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json'
        }
      });

      const cmfCode        = cmfResponse?.body?.respuesta?.codigo      || null;
      const cmfDescription = cmfResponse?.body?.respuesta?.descripcion || null;
      const ok             = cmfResponse.statusCode >= 200 && cmfResponse.statusCode < 300;

      await logRequest('cmf-echeq', body, cmfResponse, null);

      return {
        status: 200,
        jsonBody: { ok, source: 'CMF', cmf_status: cmfResponse.statusCode, cmf_code: cmfCode, cmf_description: cmfDescription, data: cmfResponse.body }
      };
    } catch (error) {
      context.error('Error en cmf-echeq', error);
      await logRequest('cmf-echeq', null, null, error.message);
      return { status: 500, jsonBody: { ok: false, source: 'AZURE', error: error.message } };
    }
  }
});
