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
]);

const kvClient = new SecretClient(VAULT_URL, new ManagedIdentityCredential());

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

    if (!secretName || !secretValue) {
      return { status: 400, jsonBody: { error: "secret_name y secret_value son requeridos" } };
    }

    if (!ALLOWED_SECRETS.has(secretName)) {
      return { status: 403, jsonBody: { error: `'${secretName}' no está en la lista de secrets permitidos` } };
    }

    try {
      await kvClient.setSecret(secretName, secretValue);
      context.log(`Secret '${secretName}' actualizado OK`);
      return { status: 200, jsonBody: { ok: true, secret: secretName } };
    } catch (err) {
      context.error(`Error actualizando '${secretName}':`, err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
