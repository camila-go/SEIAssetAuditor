import { PrismaClient } from '@prisma/client'

/**
 * Single Prisma client per process. The API and the worker each get their own.
 * In dev, reuse across hot reloads so we don't exhaust the connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV === 'development') {
  globalForPrisma.prisma = prisma
}

export type { Prisma, PrismaClient } from '@prisma/client'

/** Prisma transaction client — repositories accept this so callers can compose writes. */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}
