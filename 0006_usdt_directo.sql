-- Soporte para la nueva modalidad "USDT directo a Binance": el cliente ya no
-- recibe la moneda local del pais destino, sino una transferencia de USDT
-- directa a su cuenta de Binance. Disponible para cualquier ruta.

ALTER TABLE operaciones ADD COLUMN modo_entrega TEXT DEFAULT 'local';
ALTER TABLE operaciones ADD COLUMN destinatario_tipo TEXT DEFAULT '';
ALTER TABLE operaciones ADD COLUMN destinatario_valor TEXT DEFAULT '';
