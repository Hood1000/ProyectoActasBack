import prisma from '../prismaClient';
import * as bcrypt from 'bcryptjs';
import { Condicion, Dedicacion, Role } from '../../generated/prisma';

type SeedUser = {
  email: string;
  name: string;
  password: string;
  role: Role;
  cedula?: string;
  pnf?: string;
  periodoAcademico?: string;
  dedicacion?: Dedicacion;
  tramo?: string;
  sede?: string;
  condicion?: Condicion;
  phoneNumber?: string;
};

const users: SeedUser[] = [
  {
    email: 'admin@universidad.com',
    name: 'Administrador',
    password: 'admin123',
    role: Role.ADMIN,
    cedula: 'V10000001',
    phoneNumber: '04140000001',
  },
  {
    email: 'secretaria@uni.com',
    name: 'Secretaria Uno',
    password: 'secret123',
    role: Role.SECRETARIO,
    cedula: 'V10000002',
    phoneNumber: '04140000002',
  },
  {
    email: 'docente1@uni.com',
    name: 'Docente Uno',
    password: 'docente123',
    role: Role.DOCENTE,
    cedula: 'V10000003',
    phoneNumber: '04140000003',
  },
  {
    email: 'docente2@uni.com',
    name: 'BERNARDINO QUINTERO ANGEL',
    password: 'docente123',
    role: Role.DOCENTE,
    cedula: '11707696',
    pnf: 'SISTEMAS E INFORMATICA',
    periodoAcademico: '2024-2025',
    dedicacion: Dedicacion.EXCLUSIVA,
    tramo: 'III',
    sede: 'SOCOPO',
    condicion: Condicion.ORDINARIO,
    phoneNumber: '04140000004',
  },
  {
    email: 'docente3@uni.com',
    name: 'Docente Tres',
    password: 'docente123',
    role: Role.DOCENTE,
    cedula: 'V10000005',
    phoneNumber: '04140000005',
  },
];

async function upsertSeedUser(input: SeedUser) {
  const hashedPassword = await bcrypt.hash(input.password, 10);

  const user = await prisma.user.upsert({
    where: { email: input.email },
    update: {
      name: input.name,
      password: hashedPassword,
      role: input.role,
      cedula: input.cedula,
      pnf: input.pnf,
      periodoAcademico: input.periodoAcademico,
      dedicacion: input.dedicacion,
      tramo: input.tramo,
      sede: input.sede,
      condicion: input.condicion,
      phoneNumber: input.phoneNumber,
      isActive: true,
    },
    create: {
      email: input.email,
      name: input.name,
      password: hashedPassword,
      role: input.role,
      cedula: input.cedula,
      pnf: input.pnf,
      periodoAcademico: input.periodoAcademico,
      dedicacion: input.dedicacion,
      tramo: input.tramo,
      sede: input.sede,
      condicion: input.condicion,
      phoneNumber: input.phoneNumber,
      isActive: true,
    },
  });

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
  };
}

async function main() {
  const results = [];
  for (const user of users) {
    const result = await upsertSeedUser(user);
    results.push(result);
  }

  console.log('Usuarios de prueba listos:');
  console.table(results);
}

main()
  .catch((error) => {
    console.error('Error sembrando usuarios de prueba:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
