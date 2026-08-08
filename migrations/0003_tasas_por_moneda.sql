-- Reemplaza el manejo de tasas "por ruta y por usuario" (config_rutas) por una
-- unica fuente de verdad compartida, por moneda, controlada solo por el admin.
--
-- moneda: 'VES' | 'CLP' | 'PEN' | 'COP'
-- tasa_compra / tasa_venta: valores activos, usados para calcular todas las operaciones
-- sugerido_compra / sugerido_venta: ultima sugerencia calculada desde Binance P2P (pendiente de confirmar)
-- sugerido_en: fecha/hora ISO en que se calculo la sugerencia
-- confirmado_por / confirmado_en: quien y cuando confirmo/edito la tasa activa por ultima vez

CREATE TABLE IF NOT EXISTS tasas_monedas (
  moneda TEXT PRIMARY KEY,
  tasa_compra REAL DEFAULT 0,
  tasa_venta REAL DEFAULT 0,
  sugerido_compra REAL,
  sugerido_venta REAL,
  sugerido_en TEXT,
  confirmado_por TEXT,
  confirmado_en TEXT
);

INSERT OR IGNORE INTO tasas_monedas (moneda, tasa_compra, tasa_venta) VALUES
  ('VES', 0, 0),
  ('CLP', 0, 0),
  ('PEN', 0, 0),
  ('COP', 0, 0);
