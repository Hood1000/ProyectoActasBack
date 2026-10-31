-- Cada votacion queda fijada a un punto del orden del dia: es obligatorio y a lo sumo una por punto.
-- Idempotente: se puede aplicar con `prisma migrate deploy` o con `prisma db execute`.

-- AlterTable
ALTER TABLE "Poll" ADD COLUMN IF NOT EXISTS "agendaPointId" TEXT;

-- Votaciones creadas antes de este cambio: se enlazan al punto aprobado de su reunion cuyo
-- titulo aparece en la pregunta, solo si hay un unico candidato y ese punto no tiene votacion.
WITH candidates AS (
  SELECT po."id" AS "pollId", MIN(ap."id") AS "agendaPointId"
  FROM "Poll" po
  JOIN "AgendaPoint" ap
    ON ap."meetingId" = po."meetingId"
   AND ap."status" = 'APROBADO'
   AND po."question" ILIKE '%' || ap."title" || '%'
  WHERE po."agendaPointId" IS NULL
  GROUP BY po."id"
  HAVING COUNT(*) = 1
),
unique_points AS (
  SELECT DISTINCT ON (c."agendaPointId") c."pollId", c."agendaPointId"
  FROM candidates c
  WHERE NOT EXISTS (SELECT 1 FROM "Poll" taken WHERE taken."agendaPointId" = c."agendaPointId")
  ORDER BY c."agendaPointId", c."pollId"
)
UPDATE "Poll" po
SET "agendaPointId" = u."agendaPointId"
FROM unique_points u
WHERE po."id" = u."pollId";

-- Si queda alguna votacion sin punto no se adivina: se detiene la migracion para revisarla a mano
-- (UPDATE "Poll" SET "agendaPointId" = '<id del punto>' WHERE "id" = '<id de la votacion>').
DO $$
DECLARE
  pending TEXT;
BEGIN
  SELECT string_agg(format('%s (%s)', "id", "question"), E'\n') INTO pending
  FROM "Poll" WHERE "agendaPointId" IS NULL;

  IF pending IS NOT NULL THEN
    RAISE EXCEPTION E'Hay votaciones sin punto del orden del dia; enlazalas antes de continuar:\n%', pending;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Poll" ALTER COLUMN "agendaPointId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Poll_agendaPointId_key" ON "Poll"("agendaPointId");

-- AddForeignKey
ALTER TABLE "Poll" DROP CONSTRAINT IF EXISTS "Poll_agendaPointId_fkey";
ALTER TABLE "Poll" ADD CONSTRAINT "Poll_agendaPointId_fkey" FOREIGN KEY ("agendaPointId") REFERENCES "AgendaPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
