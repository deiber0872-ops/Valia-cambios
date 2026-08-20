// ---------------------------------------------------------------------------
// VALIA · Worker backend
// Maneja login simple (nombre + PIN), guardado de tasas por usuario, e
// historial de operaciones en D1. Todo lo que no es /api/* se sirve como
// archivo estatico desde /public via el binding ASSETS.
// ---------------------------------------------------------------------------

const PEPPER = "valia-2026-pepper"; // constante fija, no secreta pero evita colisiones triviales

// ---------------------------------------------------------------------------
// Config de sugerencia de tasas via Binance P2P (punto 1-5 definidos con el cliente)
// ---------------------------------------------------------------------------
const MONEDAS = ["VES", "CLP", "PEN", "COP", "EUR"]; // monedas que el admin puede editar en Tasas del dia
const MONEDAS_BINANCE = ["VES", "CLP", "PEN", "COP"]; // EUR no aplica: es un corresponsal privado, no Binance P2P
const KEYWORDS_METODO_PAGO = {
  VES: ["mercantil", "venezuela"],
  CLP: ["especifico", "specific"],
  PEN: ["yape", "bcp"],
  COP: ["nequi"],
};
const UMBRAL_MARGEN_MIN = 4; // %
const TECHO_MARGEN_NOADMIN = 12; // %

const BINANCE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "es-ES,es;q=0.9",
  "Content-Type": "application/json",
  "Referer": "https://p2p.binance.com/",
  "Origin": "https://p2p.binance.com",
};

async function obtenerMetodosPago(fiat) {
  const res = await fetch(`https://p2p.binance.com/bapi/c2c/v1/public/c2c/agent/trade-methods?fiat=${fiat}`, {
    headers: BINANCE_HEADERS,
  });
  if (!res.ok) throw new Error(`trade-methods ${fiat}: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
}

function filtrarIdentificadores(metodos, keywords) {
  return metodos
    .filter((m) => {
      const texto = `${m.identifier || ""} ${m.tradeMethodName || ""}`.toLowerCase();
      return keywords.some((k) => texto.includes(k));
    })
    .map((m) => m.identifier)
    .filter(Boolean);
}

// Endpoint clasico de busqueda de anuncios P2P (POST), el mas usado por trackers de precio.
async function obtenerPrecioPromedio(fiat, tradeType, identifiers) {
  if (!identifiers.length) return null;
  const body = {
    asset: "USDT",
    fiat,
    tradeType, // "BUY" | "SELL"
    page: 1,
    rows: 5,
    payTypes: identifiers,
    publisherType: null,
  };
  const res = await fetch("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", {
    method: "POST",
    headers: BINANCE_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`adv/search ${fiat} ${tradeType}: HTTP ${res.status}`);
  const data = await res.json();
  const ads = (Array.isArray(data?.data) ? data.data : []).slice(0, 5);
  if (!ads.length) return null;
  const precios = ads
    .map((a) => Number(a.adv?.price ?? a.price))
    .filter((p) => !isNaN(p) && p > 0);
  if (!precios.length) return null;
  return precios.reduce((a, b) => a + b, 0) / precios.length;
}

// Calcula la sugerencia para las 4 monedas y la guarda en tasas_monedas.
// Nunca sobreescribe la tasa activa: solo llena sugerido_compra/sugerido_venta.
// Si falla o no hay suficientes ofertas para una moneda, deja esos campos en null (punto 3).
async function actualizarSugerenciasBinance(env) {
  const ahora = new Date().toISOString();
  const resultado = {};
  for (const moneda of MONEDAS_BINANCE) {
    try {
      const metodos = await obtenerMetodosPago(moneda);
      const identifiers = filtrarIdentificadores(metodos, KEYWORDS_METODO_PAGO[moneda]);
      const [compra, venta] = await Promise.all([
        obtenerPrecioPromedio(moneda, "BUY", identifiers),
        obtenerPrecioPromedio(moneda, "SELL", identifiers),
      ]);
      await env.DB.prepare(
        `UPDATE tasas_monedas SET sugerido_compra=?, sugerido_venta=?, sugerido_en=? WHERE moneda=?`
      )
        .bind(compra, venta, ahora, moneda)
        .run();
      resultado[moneda] = { compra, venta, ok: compra != null && venta != null };
    } catch (err) {
      await env.DB.prepare(
        `UPDATE tasas_monedas SET sugerido_compra=NULL, sugerido_venta=NULL, sugerido_en=? WHERE moneda=?`
      )
        .bind(ahora, moneda)
        .run();
      resultado[moneda] = { error: String(err) };
    }
  }
  return resultado;
}

async function hashPin(nombre, pin) {
  const enc = new TextEncoder();
  const data = enc.encode(`${PEPPER}::${nombre.trim().toLowerCase()}::${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function getUserFromToken(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT users.id, users.nombre, users.is_admin
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`
  )
    .bind(token)
    .first();
  return row || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: "server_error", detail: String(err) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  // Se ejecuta solo, todos los dias a las 8:30 AM (ver cron en wrangler.jsonc).
  // Calcula la sugerencia de tasas desde Binance P2P; nunca aplica nada por si sola,
  // solo deja la sugerencia lista para que el admin la confirme (punto 5 definido con el cliente).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(actualizarSugerenciasBinance(env));
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ---------- publico: lista de nombres para el selector de login ----------
  if (path === "/api/users" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT nombre FROM users ORDER BY nombre").all();
    return json({ users: results.map((r) => r.nombre) });
  }

  // ---------- registro: crear cuenta nueva. El primer usuario es admin ----------
  if (path === "/api/register" && method === "POST") {
    const body = await request.json();
    const nombre = (body.nombre || "").trim();
    const pin = (body.pin || "").trim();
    if (!nombre || !/^\d{4}$/.test(pin)) {
      return json({ error: "Nombre y PIN de 4 digitos son obligatorios." }, 400);
    }
    const existente = await env.DB.prepare("SELECT id FROM users WHERE nombre = ?").bind(nombre).first();
    if (existente) return json({ error: "Ese nombre ya tiene una cuenta." }, 409);

    const { results: countRows } = await env.DB.prepare("SELECT COUNT(*) as c FROM users").all();
    const esPrimero = (countRows[0]?.c || 0) === 0;

    const pinHash = await hashPin(nombre, pin);
    const insert = await env.DB.prepare(
      "INSERT INTO users (nombre, pin_hash, is_admin) VALUES (?, ?, ?)"
    )
      .bind(nombre, pinHash, esPrimero ? 1 : 0)
      .run();

    const userId = insert.meta.last_row_id;
    const token = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").bind(token, userId).run();

    return json({ token, nombre, isAdmin: !!esPrimero });
  }

  // ---------- login ----------
  if (path === "/api/login" && method === "POST") {
    const body = await request.json();
    const nombre = (body.nombre || "").trim();
    const pin = (body.pin || "").trim();
    const user = await env.DB.prepare("SELECT * FROM users WHERE nombre = ?").bind(nombre).first();
    if (!user) return json({ error: "No existe ese usuario." }, 404);

    const pinHash = await hashPin(nombre, pin);
    if (pinHash !== user.pin_hash) return json({ error: "PIN incorrecto." }, 401);

    const token = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").bind(token, user.id).run();

    return json({ token, nombre: user.nombre, isAdmin: !!user.is_admin });
  }

  // ---------- todo lo de abajo requiere sesion valida ----------
  const user = await getUserFromToken(env, request);
  if (!user) return json({ error: "Sesion invalida, inicia sesion de nuevo." }, 401);

  if (path === "/api/me" && method === "GET") {
    return json({ nombre: user.nombre, isAdmin: !!user.is_admin });
  }

  // ---------- tasas por moneda (reemplaza config_rutas para tasa_compra/tasa_venta) ----------
  if (path === "/api/tasas" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM tasas_monedas").all();
    return json({ tasas: results });
  }

  if (path === "/api/tasas" && method === "PUT") {
    if (!user.is_admin) return json({ error: "Solo el administrador puede editar las tasas." }, 403);
    const body = await request.json();
    const moneda = String(body.moneda || "").toUpperCase();
    if (!MONEDAS.includes(moneda)) return json({ error: "Moneda invalida." }, 400);

    let tasaCompra, tasaVenta;
    if (body.usarSugerencia) {
      const row = await env.DB.prepare("SELECT * FROM tasas_monedas WHERE moneda = ?").bind(moneda).first();
      if (!row || row.sugerido_compra == null || row.sugerido_venta == null) {
        return json({ error: "No hay sugerencia pendiente para esa moneda." }, 400);
      }
      tasaCompra = row.sugerido_compra;
      tasaVenta = row.sugerido_venta;
    } else {
      tasaCompra = Number(body.tasaCompra) || 0;
      tasaVenta = Number(body.tasaVenta) || 0;
    }

    const ahora = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE tasas_monedas SET tasa_compra=?, tasa_venta=?, confirmado_por=?, confirmado_en=? WHERE moneda=?`
    )
      .bind(tasaCompra, tasaVenta, user.nombre, ahora, moneda)
      .run();
    await env.DB.prepare(
      `INSERT INTO tasas_historial (moneda, tasa_compra, tasa_venta, guardado_por, guardado_en) VALUES (?,?,?,?,?)`
    )
      .bind(moneda, tasaCompra, tasaVenta, user.nombre, ahora)
      .run();
    return json({ ok: true });
  }

  // Historial de una moneda a lo largo del tiempo (solo admin, mismo dueño de Tasas del dia)
  if (path === "/api/tasas/historial" && method === "GET") {
    if (!user.is_admin) return json({ error: "Solo el administrador puede ver esto." }, 403);
    const moneda = String(url.searchParams.get("moneda") || "").toUpperCase();
    if (!MONEDAS.includes(moneda)) return json({ error: "Moneda invalida." }, 400);
    const { results } = await env.DB.prepare(
      `SELECT tasa_compra, tasa_venta, guardado_por, guardado_en FROM tasas_historial
       WHERE moneda = ? ORDER BY guardado_en DESC LIMIT 60`
    )
      .bind(moneda)
      .all();
    return json({ historial: results });
  }

  // Disparo manual de la sugerencia (admin-only) para probar sin esperar al cron de las 8:30am
  if (path === "/api/tasas/sugerir" && method === "POST") {
    if (!user.is_admin) return json({ error: "Solo el administrador puede hacer esto." }, 403);
    const resultado = await actualizarSugerenciasBinance(env);
    return json({ ok: true, resultado });
  }

  // Guarda una sugerencia calculada del lado del navegador (Binance bloquea las IPs de Cloudflare,
  // asi que la consulta la hace el navegador del admin y solo el resultado se guarda aqui).
  if (path === "/api/tasas/sugerencia" && method === "PUT") {
    if (!user.is_admin) return json({ error: "Solo el administrador puede hacer esto." }, 403);
    const body = await request.json();
    const moneda = String(body.moneda || "").toUpperCase();
    if (!MONEDAS.includes(moneda)) return json({ error: "Moneda invalida." }, 400);
    const compra = Number(body.sugeridoCompra);
    const venta = Number(body.sugeridoVenta);
    if (!compra || !venta) return json({ error: "Valores de sugerencia invalidos." }, 400);
    await env.DB.prepare(
      `UPDATE tasas_monedas SET sugerido_compra=?, sugerido_venta=?, sugerido_en=? WHERE moneda=?`
    )
      .bind(compra, venta, new Date().toISOString(), moneda)
      .run();
    return json({ ok: true });
  }

  // ---------- estado (tasas por ruta, ruta activa, modo) ----------
  if (path === "/api/state" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM config_rutas WHERE user_id = ?").bind(user.id).all();
    const prefs = await env.DB.prepare("SELECT * FROM user_prefs WHERE user_id = ?").bind(user.id).first();
    return json({ configRutas: results, prefs: prefs || null });
  }

  if (path === "/api/state" && method === "PUT") {
    const body = await request.json();
    const { configRutas, prefs } = body;

    if (Array.isArray(configRutas)) {
      for (const c of configRutas) {
        await env.DB.prepare(
          `INSERT INTO config_rutas
            (user_id, ruta_key, tasa_compra, tasa_venta, comision_exchange, margen_custom,
             selected_margin, monto_origen, tasa_publicada, tasa_publicada_touched,
             compra_touched, venta_touched)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(user_id, ruta_key) DO UPDATE SET
             tasa_compra=excluded.tasa_compra, tasa_venta=excluded.tasa_venta,
             comision_exchange=excluded.comision_exchange, margen_custom=excluded.margen_custom,
             selected_margin=excluded.selected_margin, monto_origen=excluded.monto_origen,
             tasa_publicada=excluded.tasa_publicada, tasa_publicada_touched=excluded.tasa_publicada_touched,
             compra_touched=excluded.compra_touched, venta_touched=excluded.venta_touched`
        )
          .bind(
            user.id,
            c.ruta_key,
            String(c.tasa_compra ?? ""),
            String(c.tasa_venta ?? ""),
            String(c.comision_exchange ?? ""),
            String(c.margen_custom ?? ""),
            c.selected_margin ?? null,
            String(c.monto_origen ?? ""),
            String(c.tasa_publicada ?? ""),
            c.tasa_publicada_touched ? 1 : 0,
            c.compra_touched ? 1 : 0,
            c.venta_touched ? 1 : 0
          )
          .run();
      }
    }

    if (prefs) {
      await env.DB.prepare(
        `INSERT INTO user_prefs (user_id, ruta_actual, modo_actual) VALUES (?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET ruta_actual=excluded.ruta_actual, modo_actual=excluded.modo_actual`
      )
        .bind(user.id, prefs.ruta_actual || null, prefs.modo_actual || null)
        .run();
    }

    return json({ ok: true });
  }

  // ---------- historial ----------
  if (path === "/api/historial" && method === "GET") {
    const verTodos = url.searchParams.get("all") === "1" && user.is_admin;
    const q = verTodos
      ? env.DB.prepare(
          `SELECT operaciones.*, users.nombre as propietario FROM operaciones
           JOIN users ON users.id = operaciones.user_id ORDER BY operaciones.id DESC`
        )
      : env.DB.prepare("SELECT * FROM operaciones WHERE user_id = ? ORDER BY id DESC").bind(user.id);
    const { results } = await q.all();
    return json({ historial: results });
  }

  if (path === "/api/historial" && method === "POST") {
    const h = await request.json();
    const margenReal = Number(h.margenReal) || 0;
    const referidoId = String(h.referido || "").trim();
    const tieneAprobacion = !!h.aprobadoManual && String(h.motivoAprobacion || "").trim().length > 0;

    // Nivel del cliente (Cliente/Embajador/Aliado) calculado en el servidor, no confiando en el cliente.
    let nivelCliente = "Cliente";
    if (referidoId) {
      const { results: refRows } = await env.DB.prepare(
        "SELECT DISTINCT cliente_id FROM operaciones WHERE referido = ?"
      )
        .bind(referidoId)
        .all();
      const n = refRows.length;
      nivelCliente = n >= 15 ? "Aliado" : n >= 5 ? "Embajador" : "Cliente";
    }

    if (margenReal < UMBRAL_MARGEN_MIN) {
      if (nivelCliente === "Cliente") {
        return json(
          { error: `Margen (${margenReal.toFixed(2)}%) por debajo del minimo permitido (4%).` },
          400
        );
      }
      if (!tieneAprobacion) {
        return json(
          { error: "Esta operacion esta por debajo del margen minimo y necesita aprobacion manual con motivo." },
          400
        );
      }
    }

    if (!user.is_admin && margenReal > TECHO_MARGEN_NOADMIN && !tieneAprobacion) {
      return json(
        {
          error: `Margen (${margenReal.toFixed(2)}%) por encima del maximo permitido para tu usuario (12%). Necesita aprobacion manual con motivo.`,
        },
        400
      );
    }

    await env.DB.prepare(
      `INSERT INTO operaciones
        (user_id, fecha, iso_fecha, operador, cliente_id, nombre, ruta, pais_origen, pais_destino,
         monto, monto_destino, moneda_origen, moneda_destino, tasa_aplicada, ganancia, usdt_movido,
         referido, notas, tasa_compra, tasa_venta, margen_real, aprobado_manual, motivo_aprobacion, nivel_cliente,
         modo_entrega, destinatario_tipo, destinatario_valor)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        user.id,
        h.fecha || "",
        h.isoFecha || "",
        h.operador || user.nombre,
        h.id || "",
        h.nombre || "",
        h.ruta || "",
        h.paisOrigen || "",
        h.paisDestino || "",
        h.monto || 0,
        h.montoDestino || 0,
        h.monedaOrigen || "",
        h.monedaDestino || "",
        h.tasaAplicada || 0,
        h.ganancia || 0,
        h.usdtMovido || 0,
        h.referido || "",
        h.notas || "",
        h.tasaCompra || 0,
        h.tasaVenta || 0,
        h.margenReal || 0,
        tieneAprobacion ? 1 : 0,
        h.motivoAprobacion || "",
        nivelCliente,
        h.modoEntrega || "local",
        h.destinatarioTipo || "",
        h.destinatarioValor || ""
      )
      .run();
    return json({ ok: true });
  }

  if (path === "/api/historial/all" && method === "DELETE") {
    await env.DB.prepare("DELETE FROM operaciones WHERE user_id = ?").bind(user.id).run();
    return json({ ok: true });
  }

  if (path.startsWith("/api/historial/") && method === "DELETE") {
    const id = path.split("/").pop();
    if (user.is_admin) {
      await env.DB.prepare("DELETE FROM operaciones WHERE id = ?").bind(id).run();
    } else {
      await env.DB.prepare("DELETE FROM operaciones WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    }
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}
