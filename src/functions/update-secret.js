const { app } = require("@azure/functions");
const { SecretClient } = require("@azure/keyvault-secrets");
const { ManagedIdentityCredential } = require("@azure/identity");

const VAULT_URL = "https://alycs-secrets.vault.azure.net/";

const ALLOWED_SECRETS = new Set([
  "PUENTE-PASSWORD", "PUENTE-USUARIO", "PUENTE-DOCUMENTO",
  "ADCAP-PASSWORD", "ADCAP-USUARIO",
  "BACS-PASSWORD", "BACS-USUARIO",
  "MAX-PASSWORD", "MAX-USUARIO",
  "CONOSUR-PASSWORD", "CONOSUR-USUARIO",
  "CONOSUR-PAMAT-PASSWORD", "CONOSUR-PAMAT-USUARIO",
  "CONOSUR-MANCIA-PASSWORD", "CONOSUR-MANCIA-USUARIO",
  "WIN-PASSWORD", "WIN-USUARIO", "WIN-DOCUMENTO",
  "METRO-PASSWORD", "METRO-USUARIO", "METRO-DOCUMENTO",
  "DHALMORE-PASSWORD", "DHALMORE-USUARIO",
  "CRITERIA-PASSWORD", "CRITERIA-USUARIO",
  "DA-VALORES-PASSWORD", "DA-VALORES-USUARIO",
  "IEB-PASSWORD", "IEB-USUARIO", "IEB-DOCUMENTO",
  "ALLARIA-PASSWORD", "ALLARIA-USUARIO", "ALLARIA-TOTP-SECRET",
  // Segunda cuenta de Puente (Pamat). No la usa ningún scraper: se publica para
  // que la página de claves sea el listado completo de accesos.
  "PUENTE-PAMAT-PASSWORD", "PUENTE-PAMAT-USUARIO", "PUENTE-PAMAT-DOCUMENTO",
  // ALYCs sin scraper — sus credenciales viven solo en la página de claves.
  "AURUM-PASSWORD", "AURUM-USUARIO",
  "BALANZ-PASSWORD", "BALANZ-USUARIO",
  "COCOS-PASSWORD", "COCOS-USUARIO", "COCOS-DOCUMENTO",
  "COCOS-DJOY-PASSWORD", "COCOS-DJOY-USUARIO",
  "COCOS-MTEPER-PASSWORD", "COCOS-MTEPER-USUARIO",
  "COCOS-MDELLAROSSA-PASSWORD", "COCOS-MDELLAROSSA-USUARIO",
  "CONSULTATIO-PASSWORD", "CONSULTATIO-USUARIO",
  "PHAROS-PASSWORD", "PHAROS-USUARIO", "PHAROS-DOCUMENTO",
  "SOUTHENTRUST-PASSWORD", "SOUTHENTRUST-USUARIO",
  "SOUTHENTRUST-PAMAT-PASSWORD", "SOUTHENTRUST-PAMAT-USUARIO",
  "SOUTHENTRUST-MANCIA-PASSWORD", "SOUTHENTRUST-MANCIA-USUARIO",
  "STONEX-PASSWORD", "STONEX-USUARIO",
  "VALO-PASSWORD", "VALO-USUARIO",
  "ALYCBUR-PASSWORD", "ALYCBUR-USUARIO",
  "ALYCBUR-LEGAJOS-PASSWORD", "ALYCBUR-LEGAJOS-USUARIO",
  "ST-SECURITIES-PASSWORD", "ST-SECURITIES-USUARIO",
  "COHEN-PASSWORD", "COHEN-USUARIO",
  // 2ª cuenta de Valo (finanzas@), alta 2026-08-27. La original (VALO-PASSWORD)
  // sigue siendo la de info@ — son dos cuentas distintas, no un reemplazo.
  "VALO-FINANZAS-PASSWORD", "VALO-FINANZAS-USUARIO",
]);

const kvClient = new SecretClient(VAULT_URL, new ManagedIdentityCredential());

/**
 * Auditoría: una fila en `rotacion_secrets` (Supabase) por cada intento de
 * escritura — ok, rechazado por whitelist o error del vault. NUNCA el valor.
 *
 * Venía del prototipo KeyVaultUpdater y se perdió al pasar update-secret a
 * cmf-gateway: hasta 2026-10 la tabla estaba vacía y no había traza de ninguna
 * rotación. Best-effort: si Supabase falla, la rotación no se corta.
 */
async function auditar(context, issueKey, secretName, status, errorMsg = null) {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    context.warn("Auditoría deshabilitada: faltan SUPABASE_URL / SUPABASE_KEY");
    return;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rotacion_secrets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ issue_key: issueKey || null, secret_name: secretName, status, error_msg: errorMsg }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) context.warn(`Auditoría: Supabase respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    context.warn(`Auditoría: no se pudo registrar en Supabase: ${e.message}`);
  }
}

app.http("update-secret", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "Body inválido — se esperaba JSON" } };
    }

    const secretName = (body.secret_name ?? "").trim().toUpperCase();
    const secretValue = (body.secret_value ?? "").trim();
    const issueKey = String(body.issueKey ?? "").trim();   // ticket de CONF, o etiqueta de una carga manual

    if (!secretName || !secretValue) {
      return { status: 400, jsonBody: { error: "secret_name y secret_value son requeridos" } };
    }

    // Whitelist:
    //  - ALYCs: lista fija.
    //  - Cuentas bancarias: prefijo BANCO- (BANCO-{BANCO}-{ENTIDAD}-PASSWORD),
    //    se aceptan por prefijo para no enumerar cada cuenta.
    //  - DNI/CUIT: los portales con 3 identificadores (usuario + DNI + clave)
    //    guardan el DNI en {X}-DOCUMENTO. Se permite si su {X}-PASSWORD ya está
    //    permitido, así no hay que enumerar el -DOCUMENTO de cada ALYC.
    const isDocumentoDeSecretPermitido =
      secretName.endsWith("-DOCUMENTO") &&
      ALLOWED_SECRETS.has(secretName.replace(/-DOCUMENTO$/, "-PASSWORD"));

    const isAllowed =
      ALLOWED_SECRETS.has(secretName) ||
      secretName.startsWith("BANCO-") ||
      isDocumentoDeSecretPermitido;

    if (!isAllowed) {
      const msg = `'${secretName}' no está en la lista de secrets permitidos`;
      await auditar(context, issueKey, secretName, "rechazado", msg);
      return { status: 403, jsonBody: { error: msg } };
    }

    try {
      await kvClient.setSecret(secretName, secretValue);
      context.log(`[${issueKey || "-"}] Secret '${secretName}' actualizado OK`);
      // Se audita antes de republicar Confluence: la rotación ya está hecha y la
      // republicación puede tardar o fallar sin que eso cambie el resultado.
      await auditar(context, issueKey, secretName, "ok");

      // Republicar la página de Confluence que corresponda (ALYCs o Bancos).
      // Best-effort: si falla, la rotación ya está hecha y no se reporta error;
      // el detalle vuelve en `page_refresh` para poder diagnosticarlo.
      let pageRefresh;
      try {
        const { refreshTarget, targetDeSecret } = require("./refresh-creds-page");
        const target = targetDeSecret(secretName);
        pageRefresh = { target, ...(await refreshTarget(target, { ctx: context })) };
      } catch (e) {
        context.error(`No se pudo republicar la página de Confluence: ${e.message}`);
        pageRefresh = { ok: false, error: e.message };
      }

      return { status: 200, jsonBody: { ok: true, secret: secretName, page_refresh: pageRefresh } };
    } catch (err) {
      context.error(`Error actualizando '${secretName}':`, err);
      await auditar(context, issueKey, secretName, "error", err.message);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
