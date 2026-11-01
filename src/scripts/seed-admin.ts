import * as bcrypt from 'bcryptjs';
import { Role } from '../../generated/prisma';
import prisma from '../prismaClient';

const requiredEnv = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} es obligatorio.`);
  return value;
};

const email = requiredEnv('ADMIN_EMAIL');
const password = requiredEnv('ADMIN_PASSWORD');
const name = process.env.ADMIN_NAME?.trim() || 'Administrador';

async function main() {
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, password: hashedPassword, role: Role.ADMIN, isActive: true },
    create: { email, name, password: hashedPassword, role: Role.ADMIN, isActive: true },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  console.log('Usuario administrador listo:');
  console.table([user]);
}

main()
  .catch((error) => {
    console.error('Error creando el usuario administrador:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
