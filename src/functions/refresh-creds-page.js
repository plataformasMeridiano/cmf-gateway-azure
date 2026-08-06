const { app } = require("@azure/functions");
const { SecretClient } = require("@azure/keyvault-secrets");
const { ManagedIdentityCredential } = require("@azure/identity");

/**
 * refresh-creds-page — regenera las páginas de Confluence con el listado de
 * usuarios y claves, leyendo la metadata de JSM Assets y los valores del Key Vault.
 *
 *   Assets (quién es quién)      →  objeto "Usuarios Alycs" (119) / "Usuarios Banco" (253)
 *                                   atributos: Usuario, DNI Usuario, Secret ID, Estado,
 *                                   y la referencia al padre (ALyC / Cuenta) para agrupar
 *   Key Vault (los valores)      →  {Secret ID} = contraseña, {Secret ID}-DOCUMENTO = DNI/CUIT
 *   Confluence (el resultado)    →  una página por entidad (ALYCs / Bancos)
 *
 * POST /api/refresh-creds-page                → regenera las dos páginas
 * POST /api/refresh-creds-page?target=bancos  → solo bancos (o target=alycs)
 * POST /api/refresh-creds-page?dryRun=true    → devuelve las filas y el HTML SIN escribir
 *
 * Auth: Function key (x-functions-key), igual que update-secret.
 *
 * Ojo con la autenticación: son DOS mecanismos distintos.
 *   • Confluence → token "with scopes" (ATSTT…) como **Bearer** vía api.atlassian.com.
 *   • Assets     → token clásico (ATATT…) con **Basic email:token**, y además exige
 *                  el header `X-Atlassian-Token: no-check` (sin él, AQL da 403).
 *
 * Env vars:
 *   ATLASSIAN_API_TOKEN         token "with scopes" para Confluence (Bearer)
 *   ATLASSIAN_ASSETS_TOKEN      token clásico ATATT… para Assets (Basic con ATLASSIAN_EMAIL)
 *   ATLASSIAN_EMAIL             email de la cuenta dueña del token de Assets
 *   ATLASSIAN_CLOUD_ID          cloud id del tenant
 *   ATLASSIAN_WORKSPACE_ID      workspace de Assets (default: el de Meridiano)
 *   CONFLUENCE_CREDS_PAGE_ID    página de ALYCs (default 143753217)
 *   CONFLUENCE_BANCOS_PAGE_ID   página de Bancos (default 157908993)
 */

const VAULT_URL = "https://alycs-secrets.vault.azure.net/";
const kvClient = new SecretClient(VAULT_URL, new ManagedIdentityCredential());

const CLOUD_ID = process.env.ATLASSIAN_CLOUD_ID || "4975c4c5-1b46-466c-a226-d36c8e0edc0d";
const WORKSPACE_ID = process.env.ATLASSIAN_WORKSPACE_ID || "bd25a35d-a315-4a3b-b50f-f35892b6aea2";
const TOKEN = process.env.ATLASSIAN_API_TOKEN || "";                    // Confluence (Bearer)
const ASSETS_EMAIL = process.env.ATLASSIAN_EMAIL || "";                 // Assets (Basic)
const ASSETS_TOKEN = process.env.ATLASSIAN_ASSETS_TOKEN || "";          // Assets (Basic)

const ASSETS_BASE = `https://api.atlassian.com/jsm/assets/workspace/${WORKSPACE_ID}/v1`;
const CONFLUENCE_BASE = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/rest/api`;

// Qué se genera en cada página
const TARGETS = {
  alycs: {
    objectTypeId: "119",
    pageId: process.env.CONFLUENCE_CREDS_PAGE_ID || "143753217",
    columna: "ALyC",
    // atributo de referencia al "dueño" del usuario, para agrupar las filas
    refAttrs: ["ALyC", "Alyc"],
    // Filas que no salen de Assets y hay que preservar (gestión manual)
    manuales: [
      ["Petrini", "Usuario"], ["Petrini", "Contraseña"],
      ["Pharos", "Usuario"], ["Pharos", "Contraseña"],
      ["Stonex", "Usuario"], ["Stonex", "Contraseña"],
      ["Valo", "Usuario"], ["Valo", "Contraseña"],
    ],
  },
  bancos: {
    objectTypeId: "253",
    pageId: process.env.CONFLUENCE_BANCOS_PAGE_ID || "157908993",
    columna: "Banco",
    refAttrs: ["Cuenta"],
    manuales: [],
  },
};

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

/** Confluence: Bearer vía api.atlassian.com (token "with scopes"). */
async function confluenceGet(url) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GET ${url.replace(/https:\/\/[^/]+/, "")} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

/** Assets: Basic email:token + X-Atlassian-Token (sin ese header, AQL responde 403). */
function assetsHeaders() {
  const basic = Buffer.from(`${ASSETS_EMAIL}:${ASSETS_TOKEN}`).toString("base64");
  return {
    Authorization: `Basic ${basic}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Atlassian-Token": "no-check",
  };
}

async function assetsGet(url) {
  const r = await fetch(url, { headers: assetsHeaders() });
  if (!r.ok) throw new Error(`GET assets ${url.replace(ASSETS_BASE, "")} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

/**
 * Ids de los objetos de un tipo. NO se pide includeAttributes: en la respuesta de
 * AQL los atributos vienen sin el nombre (solo el id), así que después se trae
 * cada objeto con GET /object/{id}?includeAttributes=true, que sí lo incluye.
 */
async function assetsIdsDeTipo(objectTypeId) {
  const ids = [];
  let startAt = 0;
  for (let guard = 0; guard < 40; guard++) {
    const r = await fetch(`${ASSETS_BASE}/object/aql?startAt=${startAt}&maxResults=100`, {
      method: "POST",
      headers: assetsHeaders(),
      body: JSON.stringify({ qlQuery: `objectTypeId = ${objectTypeId}` }),
    });
    if (!r.ok) throw new Error(`AQL → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const values = j.values || [];
    ids.push(...values.map((v) => v.id));
    if (values.length < 100 || j.isLast === true) break;
    startAt += values.length;
  }
  return ids;
}

// ── Helpers de atributos de Assets ────────────────────────────────────────────

function attrOf(obj, nombres) {
  const lista = Array.isArray(obj?.attributes) ? obj.attributes : [];
  const buscados = (Array.isArray(nombres) ? nombres : [nombres]).map((n) => n.toLowerCase());
  return lista.find((a) => buscados.includes((a?.objectTypeAttribute?.name || "").trim().toLowerCase()));
}

/** Valor plano de un atributo (texto, select, boolean). */
function valorDe(obj, nombres) {
  const v = attrOf(obj, nombres)?.objectAttributeValues?.[0];
  const val = v?.displayValue ?? v?.value;
  return val == null ? "" : String(val).trim();
}

/** Label del objeto referenciado (ej. la Cuenta / la ALyC dueña del usuario). */
function refLabelDe(obj, nombres) {
  const v = attrOf(obj, nombres)?.objectAttributeValues?.[0];
  return String(v?.referencedObject?.label ?? v?.displayValue ?? "").trim();
}

// ── Key Vault ─────────────────────────────────────────────────────────────────

async function leerSecret(nombre) {
  try {
    const s = await kvClient.getSecret(nombre);
    return s.value ?? "";
  } catch (err) {
    if (err.statusCode === 404 || err.code === "SecretNotFound") return null; // no cargado aún
    throw err;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function renderTabla(columna, filas, manuales) {
  const th = `<tr><th><p><strong>${esc(columna)}</strong></p></th><th><p><strong>Campo</strong></p></th>`
    + `<th><p><strong>Valor</strong></p></th><th><p><strong>Gestión</strong></p></th></tr>`;

  const tr = (entidad, campo, valor, gestion) =>
    `<tr><td><p>${esc(entidad)}</p></td><td><p>${esc(campo)}</p></td>`
    + `<td><p>${esc(valor)}</p></td><td><p>${esc(gestion)}</p></td></tr>`;

  const cuerpo = filas.map((f) => tr(f.entidad, f.campo, f.valor, "Auto")).join("");
  const manual = manuales.map(([e, c]) => tr(e, c, "(gestión manual)", "Manual")).join("");

  const stamp = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
  return `<p><em>Actualizado automáticamente: ${esc(stamp)}. Las filas marcadas `
    + `<strong>Manual</strong> se editan directamente en esta página.</em></p>`
    + `<table><tbody>${th}${cuerpo}${manual}</tbody></table>`;
}

async function actualizarPagina(pageId, html) {
  const actual = await confluenceGet(`${CONFLUENCE_BASE}/content/${pageId}?expand=version`);
  const r = await fetch(`${CONFLUENCE_BASE}/content/${pageId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      id: String(pageId),
      type: "page",
      title: actual.title,
      version: { number: (actual.version?.number || 0) + 1, message: "refresh-creds-page" },
      body: { storage: { value: html, representation: "storage" } },
    }),
  });
  if (!r.ok) throw new Error(`PUT page ${pageId} → ${r.status}: ${(await r.text()).slice(0, 250)}`);
  const j = await r.json();
  return { pageId: String(pageId), version: j.version?.number };
}

// ── Armado de filas para un target ────────────────────────────────────────────

async function filasDe(target, ctx) {
  const ids = await assetsIdsDeTipo(target.objectTypeId);
  const filas = [];
  const avisos = [];

  // 1) Leer las cuentas (un objeto Assets = un juego de credenciales)
  const cuentas = [];
  for (const id of ids) {
    const obj = await assetsGet(`${ASSETS_BASE}/object/${id}?includeAttributes=true`);
    const estado = valorDe(obj, ["Estado"]);
    if (estado && /inactiv|baja/i.test(estado)) continue;  // no listar cuentas dadas de baja

    cuentas.push({
      id,
      base: refLabelDe(obj, target.refAttrs) || valorDe(obj, ["Name"]) || `objeto ${id}`,
      nombre: valorDe(obj, ["Name"]),
      perfil: valorDe(obj, ["Tipo perfil"]),
      usuario: valorDe(obj, ["Usuario"]),
      secretId: valorDe(obj, ["Secret ID"]),
      dniAssets: valorDe(obj, ["DNI Usuario"]),
    });
  }

  // 2) Desambiguar cuando una misma entidad tiene varias cuentas
  //    (ej. ConoSur → MN / Pamat / Mancia): si no se distinguen, no se sabe qué
  //    usuario va con qué clave. Se usa el "Tipo perfil", o el sufijo del Name
  //    ("ConoSur - Mancia" → "Mancia"), o el usuario como último recurso.
  const porBase = {};
  for (const c of cuentas) porBase[c.base] = (porBase[c.base] || 0) + 1;
  for (const c of cuentas) {
    if (porBase[c.base] > 1) {
      let suf = c.perfil
        || (c.nombre.includes(" - ") ? c.nombre.split(" - ").slice(1).join(" - ") : "")
        || c.usuario;
      // "meridianonorte (MN)" → "MN": si el sufijo ya trae un paréntesis, ese es el alias
      const m = /\(([^)]+)\)\s*$/.exec(suf);
      if (m) suf = m[1].trim();
      c.entidad = suf ? `${c.base} (${suf})` : `${c.base} [${c.id}]`;
    } else {
      c.entidad = c.base;
    }
  }

  // 3) Armar las filas, trayendo los valores del vault
  for (const c of cuentas) {
    if (!c.secretId) {
      if (c.usuario) filas.push({ entidad: c.entidad, campo: "Usuario", valor: c.usuario });
      avisos.push(`${c.entidad}: objeto Assets ${c.id} sin 'Secret ID' — no puedo traer la clave`);
      continue;
    }

    // Usuario: el vault manda ({X}-USUARIO) porque es lo que usan los scrapers;
    // el atributo de Assets puede quedar viejo (ej. WIN quedó en 'meridiano'
    // después de migrar a Fermi, cuando el usuario real pasó a ser un email).
    const usuarioVault = /-PASSWORD$/i.test(c.secretId)
      ? await leerSecret(c.secretId.replace(/-PASSWORD$/i, "-USUARIO"))
      : null;
    const usuario = usuarioVault || c.usuario;
    if (usuario) filas.push({ entidad: c.entidad, campo: "Usuario", valor: usuario });
    if (usuarioVault && c.usuario && usuarioVault !== c.usuario) {
      avisos.push(`${c.entidad}: el 'Usuario' de Assets ('${c.usuario}') difiere del vault ('${usuarioVault}') — se publicó el del vault`);
    }

    const pass = await leerSecret(c.secretId);
    filas.push({
      entidad: c.entidad,
      campo: "Contraseña",
      valor: pass === null ? "(sin cargar en el vault)" : pass,
    });

    // DNI/CUIT: solo para los portales que lo piden (3 identificadores)
    if (/-PASSWORD$/i.test(c.secretId)) {
      const dni = await leerSecret(c.secretId.replace(/-PASSWORD$/i, "-DOCUMENTO"));
      if (dni !== null || c.dniAssets) {
        filas.push({ entidad: c.entidad, campo: "DNI / CUIT", valor: dni ?? c.dniAssets });
      }
    }
  }

  // Orden estable: por entidad y con Usuario → Contraseña → DNI
  const ordenCampo = { "Usuario": 0, "Contraseña": 1, "DNI / CUIT": 2 };
  filas.sort((a, b) =>
    a.entidad.localeCompare(b.entidad, "es") ||
    (ordenCampo[a.campo] ?? 9) - (ordenCampo[b.campo] ?? 9));

  ctx.log(`[${target.objectTypeId}] ${ids.length} objetos → ${filas.length} filas, ${avisos.length} avisos`);
  return { filas, avisos, objetos: ids.length };
}

// ── Handler ───────────────────────────────────────────────────────────────────

app.http("refresh-creds-page", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (request, context) => {
    if (!TOKEN) {
      return { status: 500, jsonBody: { error: "Falta ATLASSIAN_API_TOKEN en el Function App" } };
    }

    const q = new URL(request.url).searchParams;
    const dryRun = q.get("dryRun") === "true";
    const pedido = (q.get("target") || "").toLowerCase();
    const targets = pedido
      ? (TARGETS[pedido] ? { [pedido]: TARGETS[pedido] } : null)
      : TARGETS;

    if (!targets) {
      return { status: 400, jsonBody: { error: `target inválido: use ${Object.keys(TARGETS).join(" | ")}` } };
    }

    const resultado = {};
    for (const [nombre, target] of Object.entries(targets)) {
      try {
        const { filas, avisos, objetos } = await filasDe(target, context);
        const html = renderTabla(target.columna, filas, target.manuales);
        resultado[nombre] = {
          ok: true, objetos, filas: filas.length, avisos,
          ...(dryRun
            ? { dryRun: true, preview: filas, html_len: html.length }
            : { pagina: await actualizarPagina(target.pageId, html) }),
        };
      } catch (err) {
        context.error(`[${nombre}] ${err.message}`);
        resultado[nombre] = { ok: false, error: err.message };
      }
    }

    const ok = Object.values(resultado).every((r) => r.ok);
    return { status: ok ? 200 : 502, jsonBody: { ok, dryRun, ...resultado } };
  },
});
