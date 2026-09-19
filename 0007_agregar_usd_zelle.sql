-- Agrega USD a tasas_monedas para la nueva ruta Zelle <-> Venezuela.
-- El flujo real: Zelle -> Zinli (con comision) -> USDT via P2P -> Bs via P2P.

INSERT OR IGNORE INTO tasas_monedas (moneda, tasa_compra, tasa_venta) VALUES ('USD', 0, 0);
