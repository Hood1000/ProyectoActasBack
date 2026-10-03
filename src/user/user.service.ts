import { ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma, Role, User } from '../../generated/prisma';
import prisma from '../prismaClient';
import * as bcrypt from 'bcryptjs';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserAdminDto } from './dto/update-user-admin.dto';

@Injectable()
export class UserService implements OnModuleInit, OnModuleDestroy {
  private readonly publicUserSelect = {
    id: true,
    email: true,
    name: true,
    cedula: true,
    pnf: true,
    periodoAcademico: true,
    tramo: true,
    sede: true,
    phoneNumber: true,
    isActive: true,
    role: true,
    dedicacion: true,
    escalafon: true,
    condicion: true,
  } as const;

  async onModuleInit() {
    await prisma.$connect();
  }

  async onModuleDestroy() {
    await prisma.$disconnect();
  }

  async findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  async create(data: Prisma.UserCreateInput): Promise<User> {
    return prisma.user.create({ data });
  }

  async findById(id: string) {
    return prisma.user.findUnique({ where: { id }, select: this.publicUserSelect });
  }

  async findAll(role?: string) {
    if (!role) {
      return prisma.user.findMany({ select: this.publicUserSelect });
    }

    return prisma.user.findMany({ where: { role: role as Role }, select: this.publicUserSelect });
  }

  async updateOwnProfile(authUserId: string, dto: UpdateProfileDto) {
    const user = await this.findById(authUserId);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      cedula: dto.cedula,
      phoneNumber: dto.phoneNumber,
      tramo: dto.tramo,
      ...(dto.email ? { email: dto.email } : {}),
    };

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, 10);
    }

    return prisma.user.update({ where: { id: authUserId }, data, select: this.publicUserSelect });
  }

  async updateAsAdmin(requester: { id: string; role: string }, userId: string, dto: UpdateUserAdminDto) {
    if (requester.id !== userId && requester.role !== 'ADMIN') {
      throw new ForbiddenException('No autorizado para editar este usuario');
    }

    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const data: Prisma.UserUpdateInput = {
      role: dto.role,
      pnf: dto.pnf,
      sede: dto.sede,
      dedicacion: dto.dedicacion,
      condicion: dto.condicion,
    };

    return prisma.user.update({ where: { id: userId }, data, select: this.publicUserSelect });
  }

  async setActiveStatus(userId: string, isActive: boolean) {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return prisma.user.update({
      where: { id: userId },
      data: { isActive },
      select: this.publicUserSelect,
    });
  }
}
