-- Agrega EUR a tasas_monedas para la nueva ruta Europa <-> Venezuela
-- (corresponsal privado, no se consulta via Binance para esta moneda).

INSERT OR IGNORE INTO tasas_monedas (moneda, tasa_compra, tasa_venta) VALUES ('EUR', 0, 0);
