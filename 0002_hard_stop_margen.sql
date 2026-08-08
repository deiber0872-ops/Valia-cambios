-- Agrega soporte para el hard stop de margen minimo (4%).
-- Cuando una operacion cae por debajo del umbral y el cliente es Embajador/Aliado,
-- se permite continuar con aprobacion manual, dejando registro de quien aprobo y por que.

ALTER TABLE operaciones ADD COLUMN aprobado_manual INTEGER DEFAULT 0;
ALTER TABLE operaciones ADD COLUMN motivo_aprobacion TEXT DEFAULT '';
ALTER TABLE operaciones ADD COLUMN nivel_cliente TEXT DEFAULT '';
