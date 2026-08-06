// ---------------------------------------------------------------------------
// VALIA · Worker backend
// Maneja login simple (nombre + PIN), guardado de tasas por usuario, e
// historial de operaciones en D1. Todo lo que no es /api/* se sirve como
// archivo estatico desde /public via el binding ASSETS.
// ---------------------------------------------------------------------------

const PEPPER = "valia-2026-pepper"; // constante fija, no secreta pero evita colisiones triviales

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
    await env.DB.prepare(
      `INSERT INTO operaciones
        (user_id, fecha, iso_fecha, operador, cliente_id, nombre, ruta, pais_origen, pais_destino,
         monto, monto_destino, moneda_origen, moneda_destino, tasa_aplicada, ganancia, usdt_movido,
         referido, notas, tasa_compra, tasa_venta, margen_real)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        h.margenReal || 0
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
