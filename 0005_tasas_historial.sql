-- Registro (append-only) de cada vez que se actualiza la tasa activa de una moneda,
-- para poder ver la evolucion de compra/venta en el tiempo.

CREATE TABLE IF NOT EXISTS tasas_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moneda TEXT NOT NULL,
  tasa_compra REAL,
  tasa_venta REAL,
  guardado_por TEXT,
  guardado_en TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasas_historial_moneda ON tasas_historial (moneda, guardado_en);
