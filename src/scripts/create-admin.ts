import prisma from '../prismaClient';
import * as bcrypt from 'bcryptjs';

async function main() {
  const email = 'admin@universidad.com';
  const password = 'admin123';
  const name = 'Administrador';
  const role = 'ADMIN';

  const hashedPassword = await bcrypt.hash(password, 10);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log('El usuario admin ya existe.');
    return;
  }

  await prisma.user.create({
    data: {
      email,
      name,
      password: hashedPassword,
      role,
    },
  });
  console.log('Usuario admin creado con éxito.');
}

main().finally(() => prisma.$disconnect());
