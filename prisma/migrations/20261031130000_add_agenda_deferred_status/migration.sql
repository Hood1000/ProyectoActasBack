-- Puntos aprobados que no se alcanzaron a votar al finalizar la reunion: se arrastran a la proxima.
-- Idempotente: se puede aplicar con `prisma migrate deploy` o con `prisma db execute`.
ALTER TYPE "AgendaStatus" ADD VALUE IF NOT EXISTS 'DIFERIDO';
