// Datos de prueba completos para el sistema de actas: usuarios de todos los roles, reuniones en
// cada estado (programadas, en curso, finalizadas y canceladas), orden del dia con propuestas
// aprobadas/rechazadas/pendientes, asistencia, chat con conversaciones largas, una votacion por
// cada punto tratado, acuerdos, actas, alertas de inasistencia y notificaciones.
//
// Uso:  npm run db:seed:demo
//
// Es re-ejecutable: antes de sembrar borra las reuniones demo anteriores (IDs deterministas) y
// todo lo que cuelga de ellas. Los usuarios demo se actualizan con upsert, no se duplican.
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { join, resolve } from 'path';
import prisma from '../prismaClient';
import {
  AbsenceAlertReviewStatus,
  AgendaStatus,
  AttendanceStatus,
  Condicion,
  Dedicacion,
  Escalafon,
  MeetingCategory,
  MeetingMode,
  MeetingType,
  NotificationType,
  PollOption,
  PollStatus,
  Role,
  Status,
} from '../../generated/prisma';

const DEMO_PASSWORD = 'Demo2026*';
const DEMO_DOMAIN = 'demo.uptm.edu.ve';
const TZ = process.env.APP_TIMEZONE || 'America/Caracas';
const CARACAS_OFFSET_HOURS = 4; // UTC-4 todo el año, sin horario de verano
const ABSENCE_ALERT_THRESHOLD = 3;
const AUTO_CANCEL_REASON =
  'La reunión no se realizó en la fecha programada y fue cancelada automáticamente por el sistema.';
const PREVIOUS_MINUTE_POINT = {
  title: 'Lectura del acta anterior',
  description:
    'Lectura, revisión y consideración del acta de la reunión anterior como primer punto obligatorio del orden del día.',
};
const UPLOADS_ROOT = resolve(__dirname, '..', '..', 'uploads');

/* ------------------------------------------------------------------ */
/* Utilidades                                                           */
/* ------------------------------------------------------------------ */

// PRNG con semilla fija: cada ejecucion genera exactamente los mismos datos.
let rngState = 20261030;
function rng(): number {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min;
const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)];
const chance = (probability: number) => rng() < probability;
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// UUID determinista a partir de una clave: permite limpiar las reuniones demo al re-ejecutar.
function demoId(key: string): string {
  const hex = createHash('sha1').update(`seed-demo:${key}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

const NOW = new Date();
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);
const addDays = (date: Date, days: number) => addMinutes(date, days * 24 * 60);
const minDate = (a: Date, b: Date) => (a.getTime() < b.getTime() ? a : b);

// Fecha/hora institucional (Caracas) -> Date UTC.
const caracas = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour + CARACAS_OFFSET_HOURS, minute));

const caracasParts = (date: Date) => {
  const shifted = new Date(date.getTime() - CARACAS_OFFSET_HOURS * 3_600_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
  };
};

// Proximo dia habil (lunes a viernes) a `daysAhead` dias de hoy, a la hora indicada de Caracas.
function futureWeekday(daysAhead: number, hour: number, minute = 0): Date {
  const today = caracasParts(NOW);
  let date = caracas(today.year, today.month, today.day + daysAhead, hour, minute);
  while ([0, 6].includes(caracasParts(date).weekday)) {
    date = addDays(date, 1);
  }
  return date;
}

// Primera hora en punto dentro del horario institucional entre 2 y 23 horas a partir de ahora:
// sirve para la reunion "dentro de las proximas 24 horas" (ventana de propuestas ya cerrada).
function withinNext24Hours(): Date {
  for (let hours = 23; hours >= 2; hours--) {
    const candidate = new Date(NOW.getTime() + hours * 3_600_000);
    candidate.setUTCMinutes(0, 0, 0);
    const { hour } = caracasParts(candidate);
    if (hour >= 8 && hour <= 16 && candidate.getTime() > NOW.getTime() + 3_600_000) {
      return candidate;
    }
  }
  return addMinutes(NOW, 20 * 60);
}

const formatHour = (date: Date) =>
  date.toLocaleTimeString('es-VE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
const formatDate = (date: Date) =>
  date.toLocaleDateString('es-VE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/* ------------------------------------------------------------------ */
/* Usuarios                                                             */
/* ------------------------------------------------------------------ */

type UserSeed = {
  key: string;
  email: string;
  name: string;
  role: Role;
  isActive?: boolean;
  cedula?: string;
  pnf?: string;
  periodoAcademico?: string;
  tramo?: string;
  sede?: string;
  phoneNumber?: string;
  dedicacion?: Dedicacion;
  escalafon?: Escalafon;
  condicion?: Condicion;
};

const staff: UserSeed[] = [
  {
    key: 'coord',
    email: `coordinacion@${DEMO_DOMAIN}`,
    name: 'Marisela Contreras Duque',
    role: Role.ADMIN,
    cedula: 'V9876543',
    phoneNumber: '04147351290',
    sede: 'SOCOPO',
  },
  {
    key: 'adminInactivo',
    email: `rbriceno@${DEMO_DOMAIN}`,
    name: 'Rafael Briceño Villamizar',
    role: Role.ADMIN,
    isActive: false,
    cedula: 'V7123456',
    phoneNumber: '04161239876',
    sede: 'BARINAS',
  },
  {
    key: 'sec',
    email: `secretaria@${DEMO_DOMAIN}`,
    name: 'Yusmary del Carmen Peña Rondón',
    role: Role.SECRETARIO,
    cedula: 'V15432876',
    phoneNumber: '04245568123',
    sede: 'SOCOPO',
  },
  {
    key: 'sec2',
    email: `secretaria2@${DEMO_DOMAIN}`,
    name: 'Carmen Elena Linares Torres',
    role: Role.SECRETARIO,
    cedula: 'V17654321',
    phoneNumber: '04269874512',
    sede: 'BARINAS',
  },
  {
    key: 'secInactiva',
    email: `nramirez@${DEMO_DOMAIN}`,
    name: 'Nelly Josefina Ramírez Gil',
    role: Role.SECRETARIO,
    isActive: false,
    cedula: 'V8456123',
    phoneNumber: '04125550193',
    sede: 'SOCOPO',
  },
];

const teacherNames: Array<[key: string, name: string, email: string]> = [
  ['d01', 'José Gregorio Albarrán Uzcátegui', 'jalbarran'],
  ['d02', 'María Alejandra Rivas Montilla', 'mrivas'],
  ['d03', 'Luis Alberto Mora Pernía', 'lmora'],
  ['d04', 'Ana Karina Salas Quintero', 'asalas'],
  ['d05', 'Pedro Rafael Guerrero Díaz', 'pguerrero'],
  ['d06', 'Yelitza Coromoto Barrios Sulbarán', 'ybarrios'],
  ['d07', 'Carlos Eduardo Méndez Rangel', 'cmendez'],
  ['d08', 'Rosmary Andreína Torres Vivas', 'rtorres'],
  ['d09', 'Héctor Julio Paredes Castillo', 'hparedes'],
  ['d10', 'Daniela Valentina Ochoa Pérez', 'dochoa'],
  ['d11', 'Freddy Antonio Lobo Márquez', 'flobo'],
  ['d12', 'Glenda Maritza Uzcátegui Rojas', 'guzcategui'],
  ['d13', 'Wilmer José Quintero Araujo', 'wquintero'],
  ['d14', 'Lisbeth Carolina Durán Molina', 'lduran'],
  ['d15', 'Jesús Manuel Ramírez Soto', 'jramirez'],
  ['d16', 'Mayerlin Susana Contreras Gil', 'mcontreras'],
  ['d17', 'Orlando Enrique Peña Valero', 'opena'],
  ['d18', 'Zulay Beatriz Márquez Angulo', 'zmarquez'],
  ['d19', 'Ramón Antonio Vielma', 'rvielma'],
  ['d20', 'Gabriela Inés Sánchez Rondón', 'gsanchez'],
];

const PNFS = [
  'SISTEMAS E INFORMATICA',
  'SISTEMAS E INFORMATICA',
  'SISTEMAS E INFORMATICA',
  'ADMINISTRACION',
  'CONTADURIA PUBLICA',
  'AGROALIMENTACION',
  'ELECTRICIDAD',
];
const SEDES = ['SOCOPO', 'SOCOPO', 'BARINAS', 'SANTA BARBARA', 'BARINITAS'];
const TRAMOS = ['I', 'II', 'III', 'IV', 'V'];
const PHONE_PREFIXES = ['0414', '0424', '0416', '0426', '0412'];

const teachers: UserSeed[] = teacherNames.map(([key, name, emailUser], index) => {
  const seniority = index % 4;
  const base: UserSeed = {
    key,
    email: `${emailUser}@${DEMO_DOMAIN}`,
    name,
    role: Role.DOCENTE,
  };

  // d19: perfil incompleto (solo datos minimos) para probar vistas con campos vacios.
  if (key === 'd19') {
    return base;
  }

  return {
    ...base,
    // d20: docente jubilada, cuenta desactivada.
    isActive: key !== 'd20',
    cedula: String(9_000_000 + index * 734_219 + randInt(0, 999)),
    pnf: pick(PNFS),
    periodoAcademico: chance(0.75) ? '2025-2026' : '2024-2025',
    tramo: TRAMOS[Math.min(seniority + randInt(0, 1), 4)],
    sede: pick(SEDES),
    phoneNumber: `${pick(PHONE_PREFIXES)}${String(randInt(1_000_000, 9_999_999))}`,
    dedicacion: [Dedicacion.EXCLUSIVA, Dedicacion.TIEMPO_COMPLETO, Dedicacion.MEDIO_TIEMPO, Dedicacion.TIEMPO_CONVENCIONAL][
      (index + randInt(0, 1)) % 4
    ],
    escalafon: [Escalafon.INSTRUCTOR, Escalafon.ASISTENTE, Escalafon.AGREGADO, Escalafon.TITULAR][seniority],
    condicion: seniority >= 2 ? Condicion.ORDINARIO : pick([Condicion.CONTRATADO, Condicion.INTERINO, Condicion.ORDINARIO]),
  };
});

// Usuarios del seed basico (seed-test-users.ts): si existen se suman a algunas reuniones para
// que tambien vean datos al iniciar sesion con sus cuentas de siempre.
const LEGACY_TEACHER_EMAILS: Record<string, string> = {
  x1: 'docente1@uni.com',
  x2: 'docente2@uni.com',
  x3: 'docente3@uni.com',
};

const users = new Map<string, { id: string; name: string; role: Role }>();
const userId = (key: string) => {
  const user = users.get(key);
  if (!user) throw new Error(`Usuario demo desconocido: ${key}`);
  return user.id;
};

async function seedUsers() {
  const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, 10);

  for (const seed of [...staff, ...teachers]) {
    const data = {
      name: seed.name,
      role: seed.role,
      isActive: seed.isActive ?? true,
      cedula: seed.cedula ?? null,
      pnf: seed.pnf ?? null,
      periodoAcademico: seed.periodoAcademico ?? null,
      tramo: seed.tramo ?? null,
      sede: seed.sede ?? null,
      phoneNumber: seed.phoneNumber ?? null,
      dedicacion: seed.dedicacion ?? null,
      escalafon: seed.escalafon ?? null,
      condicion: seed.condicion ?? null,
      password: hashedPassword,
    };
    const user = await prisma.user.upsert({
      where: { email: seed.email },
      update: data,
      create: { email: seed.email, ...data },
    });
    users.set(seed.key, { id: user.id, name: user.name, role: user.role });
  }

  for (const [key, email] of Object.entries(LEGACY_TEACHER_EMAILS)) {
    const legacy = await prisma.user.findUnique({ where: { email } });
    if (legacy && legacy.isActive && legacy.role === Role.DOCENTE) {
      users.set(key, { id: legacy.id, name: legacy.name, role: legacy.role });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Temas del orden del dia y frases del chat                            */
/* ------------------------------------------------------------------ */

type Topic = { title: string; description: string; comments: string[]; action: string };

const TOPICS: Topic[] = [
  {
    title: 'Planificación del trayecto inicial 2026-2027',
    description:
      'Organización de secciones, horarios y docentes responsables del trayecto inicial para el próximo período académico, considerando la matrícula estimada de 180 estudiantes.',
    comments: [
      'Con la matrícula estimada necesitamos al menos seis secciones; el año pasado con cinco quedaron aulas con más de 40 estudiantes.',
      'Propongo que las secciones de la tarde arranquen a la 1:30 para que los estudiantes que vienen de los caseríos alcancen el transporte.',
      'Ojo que dos de los facilitadores del trayecto inicial están en comisión de servicio hasta enero, hay que cubrir esas horas.',
      'Puedo asumir una sección de Matemática del trayecto inicial si me liberan una de Algorítmica.',
    ],
    action: 'Elaborar la propuesta de distribución de secciones del trayecto inicial y remitirla a Control de Estudios.',
  },
  {
    title: 'Distribución de carga académica del lapso 2026-II',
    description:
      'Revisión de la carga horaria asignada a cada docente para el lapso 2026-II, atendiendo a dedicación, escalafón y unidades curriculares disponibles.',
    comments: [
      'En mi caso tengo 22 horas asignadas siendo de dedicación exclusiva; me faltarían 2 horas para completar.',
      'Revisando la tabla, hay tres docentes de medio tiempo con más horas de las que corresponden.',
      'Sugiero respetar la continuidad: quien dio la unidad en el lapso I la continúe en el lapso II con el mismo grupo.',
      'Solicito que se considere mi carga de tutorías de proyecto como parte de las horas de docencia.',
      'La tabla final debería publicarse al menos una semana antes del inicio del lapso.',
    ],
    action: 'Ajustar la tabla de carga académica 2026-II y publicarla en la cartelera digital.',
  },
  {
    title: 'Calendario de defensas de proyecto sociotecnológico',
    description:
      'Aprobación de las fechas, jurados y modalidad de las defensas de proyecto del trayecto III y IV.',
    comments: [
      'Propongo hacer las defensas en dos semanas, no en una sola, porque son 34 equipos.',
      '¿Se van a permitir defensas virtuales para los equipos que están haciendo el proyecto fuera de Socopó?',
      'Cada jurado debería tener máximo cuatro defensas por día para poder revisar con calma los informes.',
      'Recordemos que las comunidades beneficiarias deben estar invitadas a las defensas.',
    ],
    action: 'Publicar el cronograma de defensas con jurados asignados y notificarlo a los equipos.',
  },
  {
    title: 'Asignación de tutores para proyectos del trayecto III',
    description:
      'Designación de tutores académicos para los 12 proyectos sociotecnológicos inscritos en el trayecto III.',
    comments: [
      'Me ofrezco como tutor de los dos proyectos de sistemas de inventario, tengo experiencia en esa área.',
      'No conviene que un mismo docente tenga más de tres proyectos; el seguimiento se vuelve imposible.',
      'El proyecto de la cooperativa agrícola necesita un cotutor del PNF de Agroalimentación.',
    ],
    action: 'Emitir las cartas de designación de tutores y enviarlas a cada equipo de proyecto.',
  },
  {
    title: 'Mantenimiento del laboratorio de computación',
    description:
      'Solicitud de mantenimiento preventivo y correctivo de los 30 equipos del laboratorio 2, incluyendo reemplazo de fuentes de poder y reinstalación de software.',
    comments: [
      'De los 30 equipos solo funcionan 19; cuatro tienen la fuente dañada desde el apagón de agosto.',
      'Podemos organizar una jornada de mantenimiento con los estudiantes del trayecto II como parte de la práctica profesional.',
      'Hay que pedir también un regulador de voltaje; sin eso vamos a seguir perdiendo equipos.',
      'Yo tengo el inventario actualizado, se los comparto por correo después de la reunión.',
    ],
    action: 'Enviar oficio a la Dirección de Servicios Generales solicitando el mantenimiento del laboratorio 2.',
  },
  {
    title: 'Electiva propuesta: Desarrollo de aplicaciones móviles',
    description:
      'Propuesta de nueva unidad curricular electiva para el trayecto IV con 4 horas semanales y contenido sobre desarrollo móvil multiplataforma.',
    comments: [
      'Es una electiva que los estudiantes vienen pidiendo desde hace tiempo, apoyo la propuesta.',
      '¿Con qué equipos se dictaría? Muchos estudiantes no tienen teléfonos con Android reciente.',
      'Se puede trabajar con emuladores en el laboratorio, siempre y cuando se haga el mantenimiento que discutimos.',
      'Sugiero que el programa analítico pase primero por la comisión curricular antes de aprobarla definitivamente.',
    ],
    action: 'Remitir el programa analítico de la electiva a la Comisión Curricular para su revisión.',
  },
  {
    title: 'Revisión de unidades curriculares del trayecto IV',
    description:
      'Análisis de la pertinencia de los contenidos de Auditoría Informática y Seguridad Informática frente a las necesidades del entorno.',
    comments: [
      'Los contenidos de Seguridad Informática tienen referencias de hace más de diez años; hay que actualizarlos.',
      'Propongo incluir un módulo de respaldo y recuperación de datos, es lo que más piden las empresas de la zona.',
      'Cualquier cambio de contenido debe hacerse sin alterar las unidades de crédito aprobadas por el ministerio.',
    ],
    action: 'Conformar una mesa de trabajo para actualizar los programas de Auditoría y Seguridad Informática.',
  },
  {
    title: 'Plan de formación docente en herramientas digitales',
    description:
      'Programa de talleres de formación sobre plataformas virtuales, evaluación en línea y producción de recursos educativos digitales.',
    comments: [
      'Podríamos aprovechar los sábados para los talleres, entre semana es muy difícil con la carga actual.',
      'Me ofrezco a facilitar el taller de Moodle, ya lo he dictado en la sede Barinas.',
      'Sería bueno que los talleres otorguen certificado con horas académicas para el ascenso.',
      'Hay que considerar a los colegas que tienen problemas de conectividad en sus casas.',
    ],
    action: 'Diseñar el cronograma de talleres de formación digital y gestionar la certificación ante la Dirección Académica.',
  },
  {
    title: 'Jornada de inducción para estudiantes de nuevo ingreso',
    description:
      'Organización de la jornada de bienvenida e inducción institucional para la nueva cohorte, incluyendo recorrido por las instalaciones y charla de normativa.',
    comments: [
      'El año pasado la inducción fue muy larga; propongo reducirla a una mañana.',
      'Podemos invitar a egresados que estén trabajando para que den testimonio a los nuevos.',
      'Hay que coordinar con Bienestar Estudiantil el tema del comedor ese día.',
    ],
    action: 'Coordinar con Bienestar Estudiantil la logística de la jornada de inducción.',
  },
  {
    title: 'Reprogramación de evaluaciones por suspensión del servicio eléctrico',
    description:
      'Ajuste del cronograma de evaluaciones afectadas por las suspensiones del servicio eléctrico de las últimas tres semanas.',
    comments: [
      'Perdí dos semanas completas de clases presenciales; necesito al menos 10 días adicionales para cerrar notas.',
      'Propongo que las evaluaciones pendientes puedan hacerse en modalidad virtual asíncrona.',
      'Hay que cuidar que la extensión no choque con el cierre del lapso en Control de Estudios.',
      'Los estudiantes de los caseríos tampoco tienen luz para conectarse; lo virtual no resuelve todo.',
    ],
    action: 'Solicitar a Control de Estudios la extensión de la fecha de carga de notas.',
  },
  {
    title: 'Solicitud de permiso para estudios de postgrado',
    description:
      'Consideración de la solicitud de permiso remunerado de un docente para cursar estudios doctorales en la UNELLEZ.',
    comments: [
      'La formación de postgrado beneficia directamente al programa; apoyo la solicitud.',
      'Hay que definir quién cubriría las unidades curriculares durante el permiso.',
      'Según el reglamento, el docente debe tener al menos dos años de antigüedad como ordinario; entiendo que sí cumple.',
    ],
    action: 'Tramitar la solicitud de permiso ante el Consejo de Núcleo con el aval de este Consejo.',
  },
  {
    title: 'Informe de rendimiento estudiantil del lapso anterior',
    description:
      'Presentación de los índices de aprobación, reprobación y deserción por trayecto y unidad curricular del lapso 2026-I.',
    comments: [
      'Preocupa la deserción del 23% en el trayecto inicial; es el valor más alto de los últimos cuatro años.',
      'En Matemática II la reprobación pasó del 30% al 45%. Hay que revisar qué está pasando.',
      'Varios estudiantes abandonaron por razones económicas, no académicas; habría que articular con Bienestar.',
      'Sugiero que este informe se presente cada lapso, no solo al final del año.',
      'Puedo preparar las gráficas comparativas para la próxima reunión.',
    ],
    action: 'Preparar el informe comparativo de rendimiento con gráficas por trayecto.',
  },
  {
    title: 'Participación en el congreso regional de innovación tecnológica',
    description:
      'Propuesta de presentar cuatro proyectos estudiantiles en el congreso regional de innovación que se realizará en Barinas.',
    comments: [
      'Tenemos al menos dos proyectos con resultados muy buenos que podrían ganar.',
      '¿La universidad cubrirá el transporte de los estudiantes?',
      'Me comprometo a revisar los resúmenes antes de enviarlos.',
    ],
    action: 'Enviar los resúmenes de los proyectos seleccionados al comité organizador del congreso.',
  },
  {
    title: 'Actualización del reglamento interno de evaluación',
    description:
      'Revisión de los artículos referentes a evaluaciones diferidas, recuperación y porcentaje mínimo de asistencia.',
    comments: [
      'El artículo 14 sobre diferidos es ambiguo; no queda claro quién autoriza.',
      'Propongo bajar el mínimo de asistencia del 75% al 70% por la situación del transporte.',
      'No estoy de acuerdo con bajar la asistencia, eso afecta la calidad de la formación.',
      'Cualquier modificación debe ser aprobada luego por el Consejo Universitario.',
    ],
    action: 'Redactar el borrador con las modificaciones al reglamento interno de evaluación.',
  },
  {
    title: 'Dotación de equipos de proyección para aulas',
    description:
      'Solicitud de cuatro video beam y dos pantallas para las aulas del edificio B.',
    comments: [
      'Actualmente hay un solo video beam para todo el edificio y hay que reservarlo con días de anticipación.',
      'Podemos plantearlo como proyecto con la alcaldía, ellos han donado equipos a otras instituciones.',
      'Mientras tanto propongo un cuaderno de préstamo controlado por secretaría.',
    ],
    action: 'Elaborar la solicitud formal de dotación de equipos de proyección.',
  },
  {
    title: 'Conformación de la comisión de servicio comunitario',
    description:
      'Designación de los integrantes de la comisión que coordinará los proyectos de servicio comunitario del año 2027.',
    comments: [
      'Propongo que la comisión tenga un representante por cada sede.',
      'Me postulo para la comisión, coordiné el servicio comunitario en 2024.',
      'Es importante incluir a un representante estudiantil.',
    ],
    action: 'Emitir la resolución de conformación de la comisión de servicio comunitario.',
  },
  {
    title: 'Horario de atención a estudiantes',
    description:
      'Establecimiento de un horario fijo de atención y asesoría a estudiantes por parte de cada docente.',
    comments: [
      'Cada docente podría publicar dos horas semanales de atención en la cartelera.',
      'Muchos estudiantes escriben por WhatsApp a cualquier hora; un horario fijo ayudaría a ordenar eso.',
      'Sugiero que también exista la opción de atención virtual.',
    ],
    action: 'Recopilar y publicar los horarios de atención de cada docente.',
  },
  {
    title: 'Convenio con la Alcaldía del municipio Antonio José de Sucre para pasantías',
    description:
      'Propuesta de convenio para que estudiantes del trayecto IV realicen pasantías en las direcciones de tecnología de la alcaldía.',
    comments: [
      'La alcaldía ya manifestó interés por escrito, tenemos la carta de intención.',
      'Hay que definir si los pasantes recibirán algún tipo de ayuda económica.',
      'El convenio debería incluir que la alcaldía nos ceda equipos en desuso para el laboratorio.',
    ],
    action: 'Remitir el borrador del convenio a la Consultoría Jurídica para su revisión.',
  },
  {
    title: 'Concurso de credenciales para ascenso en el escalafón',
    description:
      'Información sobre la apertura del concurso de credenciales y requisitos para el ascenso de categoría.',
    comments: [
      '¿Cuál es la fecha límite para consignar los trabajos de ascenso?',
      'Los requisitos cambiaron este año; ahora piden publicación en revista arbitrada.',
      'Sería útil organizar un taller sobre cómo preparar el trabajo de ascenso.',
    ],
    action: 'Difundir la convocatoria del concurso de credenciales entre todos los docentes.',
  },
  {
    title: 'Programa de tutorías para estudiantes repitientes',
    description:
      'Creación de un programa de acompañamiento académico para estudiantes que repiten unidades curriculares.',
    comments: [
      'Los estudiantes de trayectos superiores podrían ser tutores pares con reconocimiento de horas de servicio.',
      'Hay que identificar primero a los estudiantes en riesgo; Control de Estudios tiene esos datos.',
      'Propongo empezar con un piloto en Matemática y Algorítmica.',
    ],
    action: 'Solicitar a Control de Estudios el listado de estudiantes repitientes por unidad curricular.',
  },
  {
    title: 'Uso de la plataforma virtual institucional',
    description:
      'Evaluación del uso del aula virtual institucional y propuesta para que todas las unidades curriculares publiquen sus materiales en ella.',
    comments: [
      'La plataforma se cae con frecuencia; antes de exigir su uso hay que garantizar que funcione.',
      'Yo la uso en todas mis unidades y a los estudiantes les ha resultado muy útil.',
      'Propongo un plazo de un lapso para que todos migren sus materiales.',
    ],
    action: 'Levantar un diagnóstico del uso de la plataforma virtual por unidad curricular.',
  },
  {
    title: 'Actividades del aniversario de la universidad',
    description:
      'Planificación de las actividades académicas, culturales y deportivas por el aniversario institucional.',
    comments: [
      'Podemos organizar una feria de proyectos abierta a la comunidad.',
      'Propongo un torneo de programación entre las distintas sedes.',
      'Hay que cuidar el presupuesto; con lo que hay alcanza para refrigerios y certificados.',
    ],
    action: 'Conformar la comisión organizadora de las actividades del aniversario.',
  },
  {
    title: 'Presupuesto para salidas de campo',
    description:
      'Solicitud de recursos para las visitas técnicas a empresas y comunidades del trayecto II y III.',
    comments: [
      'Sin transporte institucional las salidas de campo son prácticamente imposibles.',
      'Algunas empresas ofrecieron recibirnos en sus instalaciones sin costo.',
      'Propongo priorizar las salidas vinculadas a los proyectos sociotecnológicos.',
    ],
    action: 'Presentar el presupuesto de salidas de campo ante la Dirección de Administración.',
  },
  {
    title: 'Casos de estudiantes con prosecución condicionada',
    description:
      'Análisis de 7 casos de estudiantes que solicitan prosecución con unidades curriculares pendientes.',
    comments: [
      'Tres de los casos tienen solo una unidad pendiente y buen índice académico; soy partidaria de aprobarlos.',
      'Debemos ser cuidadosos con el precedente; el reglamento es claro sobre la prelación.',
      'Sugiero revisar caso por caso y no aprobarlos en bloque.',
    ],
    action: 'Notificar a Control de Estudios la decisión sobre los casos de prosecución condicionada.',
  },
  {
    title: 'Plan de contingencia ante fallas de conectividad',
    description:
      'Medidas para garantizar la continuidad académica ante fallas de internet y electricidad en la sede.',
    comments: [
      'Propongo que cada unidad curricular tenga material descargable para trabajar sin conexión.',
      'Se podría habilitar la biblioteca como espacio de conexión con la planta eléctrica.',
      'Las reuniones virtuales deberían tener siempre un respaldo por llamada telefónica.',
    ],
    action: 'Redactar el plan de contingencia académica y socializarlo con todos los docentes.',
  },
];

const T = Object.fromEntries(TOPICS.map((topic, index) => [index, topic])) as Record<number, Topic>;

const GREETINGS = [
  'Buenos días a todos.',
  'Buen día, presente.',
  'Saludos colegas, conectado desde la sede Barinas.',
  'Buenos días 👋',
  'Presente. Disculpen, tengo algo de inestabilidad en la conexión.',
  'Buen día, aquí estoy.',
  'Saludos a todos, presente.',
  'Buenos días, colegas. Me disculpan si tengo que apagar la cámara, la señal está débil.',
];
const AFTERNOON_GREETINGS = [
  'Buenas tardes a todos.',
  'Buenas tardes, presente.',
  'Saludos colegas, buenas tardes.',
  'Buenas tardes 👋',
  'Presente. Buenas tardes a todos.',
];

const FILLERS = [
  'Estoy de acuerdo con lo planteado, pero sugiero que fijemos una fecha límite para cumplirlo.',
  '¿Quién quedaría como responsable de hacer el seguimiento?',
  'Apoyo la propuesta.',
  'Coincido con la profesora, es un tema que venimos arrastrando desde hace varias reuniones.',
  'Una pregunta: ¿esto requiere aprobación del Consejo de Núcleo o lo resolvemos aquí?',
  'Me parece bien, siempre que no afecte la carga horaria de los colegas.',
  'Pido que quede asentado en el acta que hice esta observación.',
  'Creo que deberíamos discutirlo con más calma, pero no me opongo.',
  'Totalmente de acuerdo 👍',
  'Yo me puedo encargar de esa parte.',
  'Recordemos que esto ya se había aprobado en principio en la reunión anterior.',
  'Por favor, que se envíe el documento por correo para revisarlo con detalle.',
  'No tengo objeción.',
  'Tengo una duda sobre los plazos, ¿son días hábiles o continuos?',
  'Comparto la preocupación, pero no veo otra alternativa por ahora.',
  'Se escucha entrecortado, ¿pueden repetir la última parte?',
  'De acuerdo, siempre y cuando se informe a los estudiantes con tiempo.',
  'Sugiero que lo votemos ya, creo que está suficientemente discutido.',
];

const LONG_REMARKS = [
  'Quiero dejar constancia de algo que me preocupa: cada lapso estamos tomando decisiones sobre la marcha porque la información llega tarde. Si Control de Estudios nos enviara los listados con al menos dos semanas de anticipación podríamos planificar mejor, asignar las secciones de forma equilibrada y evitar que algunos colegas terminen con 26 horas mientras otros quedan con 12. Propongo que se envíe una comunicación formal solicitándolo.',
  'Yo entiendo la propuesta y en principio la comparto, pero hay que ser realistas con los recursos. Ahora mismo no tenemos transporte, el laboratorio está a media capacidad y varios colegas están dando clases en dos sedes. Si aprobamos esto sin un plan de ejecución claro, dentro de tres meses vamos a estar discutiendo lo mismo. Mi sugerencia es aprobarlo con un cronograma y un responsable por cada actividad.',
  'Respecto a este punto, en la sede Barinas lo aplicamos el año pasado y funcionó bastante bien. La clave fue designar a un coordinador por trayecto que recogiera las inquietudes de los estudiantes y las trajera al consejo una vez al mes. Puedo compartir el formato que usamos y el informe de resultados para que lo tomemos como referencia.',
  'Antes de votar quisiera aclarar que no estoy en contra del fondo de la propuesta, sino de la forma. El documento que se nos envió tiene inconsistencias en las fechas y no especifica de dónde saldrán los recursos. Si se corrigen esos aspectos, cuenten con mi voto a favor en la próxima reunión.',
];

const VOTE_REACTIONS = ['Perfecto, gracias.', 'De acuerdo.', 'Excelente.', 'Listo, votado ✅', 'Gracias, secretaria.', 'Ok 👍'];

const REJECTION_REASONS = [
  'El punto excede las competencias del Consejo de Carrera; debe elevarse al Consejo de Núcleo.',
  'Ya fue tratado y aprobado en la reunión anterior; se incluye su seguimiento en el punto de acuerdos.',
  'La propuesta no incluye la documentación de soporte requerida. Puede volver a presentarse con los anexos.',
  'No corresponde a la naturaleza de esta reunión; se sugiere presentarlo en el CID Pedagógico.',
];

const JUSTIFICATIONS = [
  'Reposo médico de 72 horas (consignó constancia del CDI).',
  'Comisión de servicio en el Consejo Universitario en Barinas.',
  'Fallecimiento de familiar directo.',
  'Cita médica programada con anticipación; consignó constancia.',
  'Participación como jurado en defensa de proyecto en la sede Santa Bárbara.',
  'Falla del transporte desde Santa Bárbara; notificó por escrito antes de la reunión.',
];

/* ------------------------------------------------------------------ */
/* Definicion de reuniones                                              */
/* ------------------------------------------------------------------ */

type VoteMood = 'favor' | 'contra' | 'reñido';

type PointCfg = {
  topic: number;
  by?: string; // clave del proponente; sin `by` lo propone el organizador (punto base)
  status?: AgendaStatus; // solo para propuestas de docentes
  vote?: VoteMood;
};

type MeetingCfg = {
  key: string;
  title: string;
  description: string;
  date: Date;
  createdAt?: Date;
  location: string;
  type: MeetingType;
  category: MeetingCategory;
  modality: MeetingMode;
  organizer: string;
  invitees: string[];
  phase: Status;
  absent?: string[];
  justified?: Record<string, string>;
  absentWithNote?: Record<string, string>;
  late?: string[];
  points: PointCfg[];
  consolidated?: boolean;
  // EN_CURSO
  discussed?: number; // puntos tratados (incluye la lectura del acta)
  voting?: boolean;
  openLastPoll?: boolean;
  evidence?: boolean;
  // PROGRAMADA con ventana de asistencia abierta
  confirmedEarly?: string[];
  // CANCELADA
  cancel?: { by?: string; reason: string; at?: Date; interruptedAfter?: number };
};

const has = (key: string) => users.has(key);
const legacy = (...keys: string[]) => keys.filter(has);
const ALL_ACTIVE_TEACHERS = () =>
  teachers.filter((teacher) => teacher.isActive !== false).map((teacher) => teacher.key);

function meetingConfigs(): MeetingCfg[] {
  const consejo = ['sec', 'coord', 'd01', 'd02', 'd03', 'd05', 'd06', 'd07', 'd08', 'd09', 'd11', 'd12', 'd14'];
  const cid = ['sec', 'd02', 'd04', 'd06', 'd10', 'd12', 'd13', 'd15', 'd16', 'd18'];
  const asamblea = ['sec', 'coord', ...ALL_ACTIVE_TEACHERS()];

  const salaReuniones = 'Sala de reuniones, Edificio Administrativo – Núcleo Socopó';
  const meet = (code: string) => `Google Meet: meet.google.com/${code}`;

  const enCursoLargaDate = addMinutes(NOW, -110);
  const enCursoDebateDate = addMinutes(NOW, -45);
  const enCursoSinQuorumDate = addMinutes(NOW, -30);
  const startsSoonDate = addMinutes(new Date(Math.ceil(NOW.getTime() / 300_000) * 300_000), 10);

  return [
    /* ---------------- FINALIZADAS (año 2025) ---------------- */
    {
      key: 'f2025-consejo-oct',
      title: 'Consejo de Carrera Ordinario N° 008-2025',
      description: 'Reunión ordinaria del Consejo de Carrera del PNF en Informática correspondiente al mes de octubre.',
      date: caracas(2025, 10, 17, 9),
      location: salaReuniones,
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: [...consejo, 'd04'],
      phase: Status.FINALIZADA,
      absent: ['d04', 'd11'],
      justified: { d07: JUSTIFICATIONS[0] },
      points: [
        { topic: 1, vote: 'favor' },
        { topic: 11, by: 'd05', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 4, by: 'd09', status: AgendaStatus.APROBADO, vote: 'reñido' },
        { topic: 21, by: 'd03', status: AgendaStatus.RECHAZADO },
      ],
    },
    {
      key: 'f2025-cid-nov',
      title: 'CID Pedagógico – Seguimiento del lapso 2025-II',
      description: 'Consejo Interdisciplinario Pedagógico para el seguimiento de la ejecución del lapso 2025-II.',
      date: caracas(2025, 11, 14, 14),
      location: meet('cid-pdg-nov'),
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CID_PEDAGOGICO,
      modality: MeetingMode.VIRTUAL,
      organizer: 'sec',
      invitees: cid,
      phase: Status.FINALIZADA,
      absent: ['d04'],
      late: ['d13'],
      points: [
        { topic: 7, vote: 'favor' },
        { topic: 19, by: 'd12', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 16, by: 'd16', status: AgendaStatus.APROBADO, vote: 'contra' },
      ],
    },
    {
      key: 'f2025-asamblea-dic',
      title: 'Asamblea Extraordinaria de Docentes – Cierre del año 2025',
      description: 'Asamblea extraordinaria para la evaluación de la gestión 2025 y propuestas para el año 2026.',
      date: caracas(2025, 12, 5, 9),
      location: 'Auditorio principal + transmisión por Google Meet',
      type: MeetingType.EXTRAORDINARIA,
      category: MeetingCategory.ASAMBLEA,
      modality: MeetingMode.HIBRIDA,
      organizer: 'coord',
      invitees: asamblea,
      phase: Status.FINALIZADA,
      absent: ['d04', 'd17'],
      justified: { d09: JUSTIFICATIONS[1], d18: JUSTIFICATIONS[3] },
      late: ['d05', 'd14'],
      points: [
        { topic: 21, vote: 'favor' },
        { topic: 11, vote: 'favor' },
        { topic: 13, by: 'd01', status: AgendaStatus.APROBADO, vote: 'reñido' },
        { topic: 8, by: 'd06', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 22, by: 'd15', status: AgendaStatus.RECHAZADO },
      ],
    },

    /* ---------------- FINALIZADAS (año 2026) ---------------- */
    {
      key: 'f2026-consejo-ene',
      title: 'Consejo de Carrera Ordinario N° 001-2026',
      description: 'Primera reunión ordinaria del año. Planificación del lapso 2026-I.',
      date: caracas(2026, 1, 23, 9),
      location: salaReuniones,
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: [...consejo, ...legacy('x1', 'x2')],
      phase: Status.FINALIZADA,
      absent: ['d02', 'd03'],
      points: [
        { topic: 1, vote: 'favor' },
        { topic: 9, vote: 'favor' },
        { topic: 2, by: 'd07', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 17, by: 'd12', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 13, by: 'd08', status: AgendaStatus.RECHAZADO },
      ],
    },
    {
      key: 'f2026-asamblea-feb',
      title: 'Asamblea Extraordinaria – Situación del servicio eléctrico',
      description: 'Asamblea extraordinaria convocada por las suspensiones del servicio eléctrico que afectan la actividad académica.',
      date: caracas(2026, 2, 20, 10),
      location: 'Auditorio principal',
      type: MeetingType.EXTRAORDINARIA,
      category: MeetingCategory.ASAMBLEA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: asamblea,
      phase: Status.FINALIZADA,
      absent: ['d03', 'd17'],
      justified: { d02: JUSTIFICATIONS[0] },
      absentWithNote: { d11: JUSTIFICATIONS[5] },
      points: [
        { topic: 9, vote: 'favor' },
        { topic: 24, vote: 'favor' },
        { topic: 23, by: 'd09', status: AgendaStatus.APROBADO, vote: 'reñido' },
      ],
    },
    {
      key: 'f2026-cid-mar',
      title: 'CID Pedagógico – Evaluación de unidades curriculares',
      description: 'Revisión del desarrollo de las unidades curriculares y del rendimiento estudiantil.',
      date: caracas(2026, 3, 13, 14),
      location: 'Aula B-4 + Google Meet',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CID_PEDAGOGICO,
      modality: MeetingMode.HIBRIDA,
      organizer: 'sec',
      invitees: [...cid, 'd03'],
      phase: Status.FINALIZADA,
      absent: ['d02'],
      absentWithNote: { d13: 'Notificó retraso por falla del transporte, no llegó a la reunión.' },
      points: [
        { topic: 11, vote: 'favor' },
        { topic: 6, by: 'd10', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 20, by: 'd16', status: AgendaStatus.APROBADO, vote: 'contra' },
        { topic: 19, by: 'd06', status: AgendaStatus.APROBADO, vote: 'favor' },
      ],
    },
    {
      key: 'f2026-consejo-may',
      title: 'Consejo de Carrera Ordinario N° 002-2026',
      description: 'Reunión ordinaria del Consejo de Carrera. Avance de proyectos sociotecnológicos.',
      date: caracas(2026, 5, 8, 9),
      location: salaReuniones,
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: [...consejo, ...legacy('x1', 'x2', 'x3')],
      phase: Status.FINALIZADA,
      absent: ['d02', 'd03', ...legacy('x3')],
      justified: { d06: JUSTIFICATIONS[4] },
      late: ['d14'],
      points: [
        { topic: 3, vote: 'favor' },
        { topic: 2, vote: 'favor' },
        { topic: 4, by: 'd01', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 10, by: 'd05', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 14, by: 'd09', status: AgendaStatus.APROBADO, vote: 'contra' },
        { topic: 15, by: 'd07', status: AgendaStatus.RECHAZADO },
      ],
    },
    {
      key: 'f2026-consejo-jun',
      title: 'Consejo de Carrera Extraordinario – Calendario de defensas',
      description: 'Reunión extraordinaria virtual para aprobar el calendario de defensas del trayecto IV.',
      date: caracas(2026, 6, 19, 15),
      location: meet('cdc-ext-jun'),
      type: MeetingType.EXTRAORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.VIRTUAL,
      organizer: 'sec',
      invitees: consejo,
      phase: Status.FINALIZADA,
      absent: ['d03'],
      points: [{ topic: 2, vote: 'favor' }, { topic: 3, by: 'd11', status: AgendaStatus.APROBADO, vote: 'reñido' }],
    },
    {
      key: 'f2026-consejo-sep',
      title: 'Consejo de Carrera Ordinario N° 003-2026',
      description: 'Reunión ordinaria de inicio del lapso 2026-II. Quedan puntos pendientes por tratar en la próxima sesión.',
      date: caracas(2026, 9, 25, 9),
      location: salaReuniones,
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.HIBRIDA,
      organizer: 'coord',
      invitees: [...consejo, ...legacy('x1', 'x2')],
      phase: Status.FINALIZADA,
      absent: ['d11'],
      justified: { d02: JUSTIFICATIONS[2] },
      // Se acaba el tiempo antes del ultimo punto aprobado: queda DIFERIDO para la proxima reunion.
      discussed: 3,
      points: [
        { topic: 1, vote: 'favor' },
        { topic: 0, by: 'd08', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 18, by: 'd12', status: AgendaStatus.APROBADO, vote: 'reñido' },
        // Pendientes sin revisar: se arrastran como "acta anterior" de la proxima reunion del consejo.
        { topic: 15, by: 'd05', status: AgendaStatus.PENDIENTE },
        { topic: 24, by: 'd14', status: AgendaStatus.PENDIENTE },
        { topic: 22, by: 'd09', status: AgendaStatus.RECHAZADO },
      ],
    },
    {
      key: 'f2026-cid-oct',
      title: 'CID Pedagógico – Plan de formación docente',
      description: 'Consejo Interdisciplinario Pedagógico para revisar el plan de formación y los talleres del lapso.',
      date: caracas(2026, 10, 16, 14),
      location: 'Aula B-4',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CID_PEDAGOGICO,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'sec',
      invitees: [...cid, ...legacy('x3')],
      phase: Status.FINALIZADA,
      absent: ['d18'],
      justified: { d04: JUSTIFICATIONS[3] },
      points: [
        { topic: 7, vote: 'favor' },
        { topic: 20, by: 'd13', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 16, by: 'd15', status: AgendaStatus.APROBADO, vote: 'reñido' },
        { topic: 5, by: 'd10', status: AgendaStatus.PENDIENTE },
      ],
    },

    /* ---------------- CANCELADAS ---------------- */
    {
      key: 'c2026-consejo-abr',
      title: 'Consejo de Carrera Ordinario – Abril 2026',
      description: 'Reunión ordinaria del mes de abril.',
      date: caracas(2026, 4, 17, 9),
      location: salaReuniones,
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: consejo,
      phase: Status.CANCELADA,
      cancel: {
        by: 'coord',
        at: caracas(2026, 4, 15, 11, 20),
        reason: 'Coincide con la jornada nacional de vacunación en la que participa la mayoría del personal. Se reprogramará en mayo.',
      },
      points: [
        { topic: 1 },
        { topic: 14, by: 'd07', status: AgendaStatus.APROBADO },
        { topic: 4, by: 'd01', status: AgendaStatus.PENDIENTE },
      ],
    },
    {
      key: 'c2026-asamblea-jul',
      title: 'Asamblea Ordinaria de Docentes – Julio 2026',
      description: 'Asamblea ordinaria de mitad de año. Suspendida durante la sesión por falla eléctrica.',
      date: caracas(2026, 7, 10, 10),
      location: 'Auditorio principal',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.ASAMBLEA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: asamblea,
      phase: Status.CANCELADA,
      absent: ['d17', 'd03'],
      justified: { d10: JUSTIFICATIONS[1] },
      cancel: {
        by: 'sec',
        interruptedAfter: 2,
        reason:
          'Suspensión del servicio eléctrico en toda la sede durante la sesión. Sin planta eléctrica operativa no fue posible continuar.',
      },
      points: [
        { topic: 11, vote: 'favor' },
        { topic: 21, vote: 'favor' },
        { topic: 23, by: 'd13', status: AgendaStatus.APROBADO, vote: 'reñido' },
        { topic: 8, by: 'd06', status: AgendaStatus.APROBADO },
      ],
    },
    {
      key: 'c2026-cid-auto',
      title: 'CID Pedagógico – Revisión de programas',
      description: 'Reunión que no llegó a realizarse: el sistema la canceló automáticamente al día siguiente.',
      date: caracas(2026, 10, 23, 9),
      location: 'Aula B-4',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CID_PEDAGOGICO,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'sec',
      invitees: cid,
      phase: Status.CANCELADA,
      cancel: { at: caracas(2026, 10, 24, 0, 1), reason: AUTO_CANCEL_REASON },
      points: [{ topic: 6 }, { topic: 19, by: 'd02', status: AgendaStatus.APROBADO }],
    },
    {
      key: 'c2026-consejo-ext-futura',
      title: 'Consejo de Carrera Extraordinario – Prosecución condicionada',
      description: 'Reunión extraordinaria para tratar casos de prosecución. Cancelada con anticipación.',
      date: futureWeekday(10, 10),
      createdAt: addDays(NOW, -6),
      location: salaReuniones,
      type: MeetingType.EXTRAORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: consejo,
      phase: Status.CANCELADA,
      cancel: {
        by: 'coord',
        at: addDays(NOW, -1),
        reason: 'Los casos serán tratados directamente por el Consejo de Núcleo según convocatoria recibida.',
      },
      points: [{ topic: 23 }],
    },

    /* ---------------- EN CURSO ---------------- */
    {
      key: 'e-consejo-votando',
      title: 'Consejo de Carrera Ordinario N° 004-2026',
      description: 'Reunión ordinaria en curso con la fase de votación abierta y una votación pendiente.',
      date: enCursoLargaDate,
      createdAt: addDays(NOW, -12),
      location: 'Sala de reuniones + Google Meet',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.HIBRIDA,
      organizer: 'coord',
      invitees: [...consejo, ...legacy('x1', 'x2', 'x3')],
      phase: Status.EN_CURSO,
      absent: ['d11'],
      justified: { d03: JUSTIFICATIONS[0] },
      late: ['d09'],
      consolidated: true,
      voting: true,
      discussed: 5,
      openLastPoll: true,
      evidence: true,
      points: [
        { topic: 15, by: 'd05', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 1, vote: 'favor' },
        { topic: 24, by: 'd14', status: AgendaStatus.APROBADO, vote: 'reñido' },
        { topic: 12, by: 'd01', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 10, by: 'd08', status: AgendaStatus.APROBADO, vote: 'favor' },
        { topic: 13, by: 'd07', status: AgendaStatus.RECHAZADO },
      ],
    },
    {
      key: 'e-cid-debate',
      title: 'CID Pedagógico – Planificación del lapso 2026-II',
      description: 'Reunión en curso con quórum. Aún en debate: la fase de votación no se ha iniciado.',
      date: enCursoDebateDate,
      createdAt: addDays(NOW, -9),
      location: 'Aula B-4',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CID_PEDAGOGICO,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'sec',
      invitees: [...cid, ...legacy('x1')],
      phase: Status.EN_CURSO,
      absent: ['d18'],
      consolidated: true,
      voting: false,
      discussed: 2,
      points: [
        { topic: 5, by: 'd10', status: AgendaStatus.APROBADO },
        { topic: 7 },
        { topic: 19, by: 'd13', status: AgendaStatus.APROBADO },
      ],
    },
    {
      key: 'e-consejo-sin-quorum',
      title: 'Consejo de Carrera Extraordinario – Convenio de pasantías',
      description: 'Reunión en curso SIN quórum: la secretaría no está presente, por lo que no puede abrirse la votación.',
      date: enCursoSinQuorumDate,
      createdAt: addDays(NOW, -4),
      location: meet('cdc-pas-ext'),
      type: MeetingType.EXTRAORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.VIRTUAL,
      organizer: 'coord',
      invitees: ['sec', 'd01', 'd05', 'd07', 'd09', 'd12'],
      phase: Status.EN_CURSO,
      justified: { sec: 'Reposo médico de 48 horas.' },
      absent: ['d07', 'd12'],
      consolidated: true,
      voting: false,
      discussed: 0,
      points: [{ topic: 17 }],
    },

    /* ---------------- PROGRAMADAS ---------------- */
    {
      key: 'p-cid-inicia-pronto',
      title: 'CID Pedagógico – Seguimiento de proyectos sociotecnológicos',
      description: 'Reunión a punto de iniciar: la ventana de asistencia ya está abierta y algunos docentes confirmaron.',
      date: startsSoonDate,
      createdAt: addDays(NOW, -7),
      location: 'Aula B-2',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CID_PEDAGOGICO,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'sec',
      invitees: [...cid, ...legacy('x2')],
      phase: Status.PROGRAMADA,
      confirmedEarly: ['sec', 'd06', 'd10', 'd12', ...legacy('x2')],
      consolidated: true,
      points: [{ topic: 3 }, { topic: 2, by: 'd16', status: AgendaStatus.APROBADO }],
    },
    {
      key: 'p-consejo-24h',
      title: 'Consejo de Carrera Ordinario N° 005-2026',
      description:
        'Faltan menos de 24 horas: la recepción de puntos para docentes ya cerró y hay propuestas pendientes por revisar.',
      date: withinNext24Hours(),
      createdAt: addDays(NOW, -8),
      location: salaReuniones,
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.HIBRIDA,
      organizer: 'coord',
      invitees: [...consejo, ...legacy('x1', 'x2', 'x3')],
      phase: Status.PROGRAMADA,
      points: [
        { topic: 1 },
        { topic: 12, by: 'd01', status: AgendaStatus.PENDIENTE },
        { topic: 6, by: 'd01', status: AgendaStatus.APROBADO },
        { topic: 24, by: 'd06', status: AgendaStatus.PENDIENTE },
        { topic: 22, by: 'd09', status: AgendaStatus.RECHAZADO },
        { topic: 18, by: 'd12', status: AgendaStatus.PENDIENTE },
        ...(has('x1') ? [{ topic: 20, by: 'x1', status: AgendaStatus.PENDIENTE }] : []),
      ],
    },
    {
      key: 'p-asamblea-semana',
      title: 'Asamblea General de Docentes – Cierre del año 2026',
      description: 'Asamblea ordinaria de cierre de año. La recepción de puntos sigue abierta.',
      date: futureWeekday(7, 9),
      createdAt: addDays(NOW, -3),
      location: 'Auditorio principal + transmisión por Google Meet',
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.ASAMBLEA,
      modality: MeetingMode.HIBRIDA,
      organizer: 'coord',
      invitees: asamblea,
      phase: Status.PROGRAMADA,
      points: [
        { topic: 11 },
        { topic: 21 },
        { topic: 13, by: 'd09', status: AgendaStatus.APROBADO },
        { topic: 8, by: 'd17', status: AgendaStatus.PENDIENTE },
        { topic: 16, by: 'd17', status: AgendaStatus.PENDIENTE },
        { topic: 4, by: 'd18', status: AgendaStatus.RECHAZADO },
        { topic: 0, by: 'd15', status: AgendaStatus.PENDIENTE },
      ],
    },
    {
      key: 'p-cid-consolidada',
      title: 'CID Pedagógico – Electivas del trayecto IV',
      description: 'Reunión con orden del día ya consolidado por la secretaría.',
      date: futureWeekday(14, 14),
      createdAt: addDays(NOW, -2),
      location: meet('cid-elec-tiv'),
      type: MeetingType.ORDINARIA,
      category: MeetingCategory.CID_PEDAGOGICO,
      modality: MeetingMode.VIRTUAL,
      organizer: 'sec',
      invitees: cid,
      phase: Status.PROGRAMADA,
      consolidated: true,
      points: [
        { topic: 5 },
        { topic: 6, by: 'd04', status: AgendaStatus.APROBADO },
        { topic: 20, by: 'd18', status: AgendaStatus.APROBADO },
        { topic: 14, by: 'd13', status: AgendaStatus.RECHAZADO },
      ],
    },
    {
      key: 'p-consejo-recien-creada',
      title: 'Consejo de Carrera Extraordinario – Presupuesto 2027',
      description: 'Reunión recién creada: solo tiene el punto obligatorio y aún no tiene convocados.',
      date: futureWeekday(21, 10, 30),
      createdAt: addMinutes(NOW, -90),
      location: salaReuniones,
      type: MeetingType.EXTRAORDINARIA,
      category: MeetingCategory.CONSEJO_CARRERA,
      modality: MeetingMode.PRESENCIAL,
      organizer: 'coord',
      invitees: [],
      phase: Status.PROGRAMADA,
      points: [],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Generacion de cada reunion                                           */
/* ------------------------------------------------------------------ */

type Totals = Record<string, number>;
const totals: Totals = {
  reuniones: 0,
  puntos: 0,
  asistencias: 0,
  mensajes: 0,
  votaciones: 0,
  votos: 0,
  acuerdos: 0,
  actas: 0,
};

async function seedMeeting(cfg: MeetingCfg) {
  const meetingId = demoId(`meeting:${cfg.key}`);
  const organizerId = userId(cfg.organizer);
  const invitees = [...new Set(cfg.invitees.filter(has))];
  const createdAt = minDate(cfg.createdAt ?? addDays(cfg.date, -14), addMinutes(NOW, -60));

  const cancelledInSession = cfg.phase === Status.CANCELADA && cfg.cancel?.interruptedAfter !== undefined;
  const started = cfg.phase === Status.FINALIZADA || cfg.phase === Status.EN_CURSO || cancelledInSession;
  const votingPhase = cfg.phase === Status.FINALIZADA || cancelledInSession || Boolean(cfg.voting);

  /* ---- Asistencia ---- */
  const attendanceRows = invitees.map((key) => {
    let status: AttendanceStatus = AttendanceStatus.PENDIENTE;
    let excuse: string | null = null;
    let markedAt: Date | null = null;

    if (started) {
      if (cfg.justified?.[key]) {
        status = AttendanceStatus.JUSTIFICADA;
        excuse = cfg.justified[key];
        markedAt = addMinutes(cfg.date, -randInt(5, 14));
      } else if (cfg.absentWithNote?.[key]) {
        status = AttendanceStatus.AUSENTE;
        excuse = cfg.absentWithNote[key];
        markedAt = addMinutes(cfg.date, randInt(10, 25));
      } else if (cfg.absent?.includes(key)) {
        status = AttendanceStatus.AUSENTE; // la convierte el cierre de asistencia, sin marca
      } else {
        status = AttendanceStatus.PRESENTE;
        markedAt = cfg.late?.includes(key)
          ? addMinutes(cfg.date, randInt(8, 22)) // llego tarde: la secretaria corrige la asistencia
          : addMinutes(cfg.date, -randInt(0, 14));
      }
    } else if (cfg.confirmedEarly?.includes(key)) {
      status = AttendanceStatus.PRESENTE;
      markedAt = minDate(addMinutes(cfg.date, -randInt(3, 14)), addMinutes(NOW, -1));
      if (markedAt.getTime() < addMinutes(cfg.date, -15).getTime()) markedAt = addMinutes(cfg.date, -15);
    }

    return {
      id: randomUUID(),
      userId: userId(key),
      meetingId,
      status,
      excuse,
      markedAt,
      createdAt,
    };
  });

  // Misma regla de quorum que MeetingService.refreshQuorum.
  const statusOf = (key: string) => attendanceRows[invitees.indexOf(key)]?.status;
  const secretaryInvited = invitees.some((key) => users.get(key)?.role === Role.SECRETARIO);
  const isPresiding = (key: string) =>
    secretaryInvited ? users.get(key)?.role === Role.SECRETARIO : users.get(key)?.role === Role.ADMIN && key === cfg.organizer;
  const presentKeys = invitees.filter((key) => statusOf(key) === AttendanceStatus.PRESENTE);
  const presidingPresent = presentKeys.some(isPresiding);
  const participantPresent = presentKeys.some((key) => !isPresiding(key));
  const hasQuorum =
    cfg.category === MeetingCategory.ASAMBLEA ? presidingPresent : presidingPresent && participantPresent;

  // Quien conduce el chat: la secretaria presente; si no, la coordinacion organizadora.
  const presiderKey = presentKeys.find((key) => users.get(key)?.role === Role.SECRETARIO) ?? cfg.organizer;
  const speakers = presentKeys.filter((key) => key !== presiderKey);
  const voters = presentKeys; // votan todos los convocados presentes

  /* ---- Orden del dia ---- */
  const pointsCfg: Array<PointCfg & { base: boolean; mandatory?: boolean }> = [
    { topic: -1, base: true, mandatory: true, vote: 'favor' },
    ...cfg.points.map((point) => ({ ...point, base: !point.by || users.get(point.by)?.role !== Role.DOCENTE })),
  ];
  const proposalWindowEnd = minDate(addDays(cfg.date, -1), addMinutes(NOW, -30));

  const agendaRows = pointsCfg.map((point, index) => {
    const topic = point.mandatory ? PREVIOUS_MINUTE_POINT : T[point.topic];
    const status = point.base ? AgendaStatus.APROBADO : point.status ?? AgendaStatus.PENDIENTE;
    const proposerKey = point.mandatory ? null : point.by ?? cfg.organizer;
    const pointCreatedAt = point.base
      ? addSeconds(createdAt, index)
      : new Date(createdAt.getTime() + rng() * Math.max(proposalWindowEnd.getTime() - createdAt.getTime(), 60_000));
    const reviewed = status !== AgendaStatus.PENDIENTE && !point.base;
    return {
      id: randomUUID(),
      title: topic.title,
      description: topic.description,
      status,
      reviewComment: status === AgendaStatus.RECHAZADO ? pick(REJECTION_REASONS) : null,
      isBasePoint: point.base,
      meetingId,
      proposerId: proposerKey ? userId(proposerKey) : null,
      createdAt: pointCreatedAt,
      updatedAt: reviewed ? minDate(addMinutes(pointCreatedAt, randInt(60, 1800)), addMinutes(NOW, -5)) : pointCreatedAt,
      _cfg: point,
      _topic: point.mandatory ? null : T[point.topic],
    };
  });
  agendaRows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Puntos que se tratan en la sesion: los aprobados, en el orden del dia.
  const sessionPoints = agendaRows.filter((row) => row.status === AgendaStatus.APROBADO);
  const discussedCount =
    cfg.phase === Status.FINALIZADA
      ? Math.min(cfg.discussed ?? sessionPoints.length, sessionPoints.length)
      : cancelledInSession
        ? (cfg.cancel?.interruptedAfter ?? 0) + 1
        : Math.min(cfg.discussed ?? 0, sessionPoints.length);

  /* ---- Chat, votaciones y acuerdos ---- */
  const chatRows: Array<{ id: string; meetingId: string; authorId: string; content: string; createdAt: Date }> = [];
  const pollRows: Array<{
    id: string;
    meetingId: string;
    agendaPointId: string;
    question: string;
    status: PollStatus;
    createdById: string;
    createdAt: Date;
    closedAt: Date | null;
  }> = [];
  const voteRows: Array<{
    id: string;
    pollId: string;
    voterId: string;
    option: PollOption;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const decisions: Array<{ title: string; favor: number; contra: number; approved: boolean; pending?: boolean }> = [];
  const actionRows: Array<{
    id: string;
    description: string;
    deadline: Date | null;
    completed: boolean;
    responsibleId: string;
    meetingId: string;
  }> = [];

  let clock = addMinutes(cfg.date, randInt(1, 3));
  const tick = (minSeconds: number, maxSeconds: number) => {
    clock = addSeconds(clock, randInt(minSeconds, maxSeconds));
    return clock;
  };
  const say = (key: string, content: string, min = 25, max = 110) =>
    chatRows.push({ id: randomUUID(), meetingId, authorId: userId(key), content, createdAt: tick(min, max) });
  let votingStartedAt: Date | null = null;
  let closedAt: Date | null = null;
  let cancelAt: Date | null = cfg.cancel?.at ?? null;

  const morning = caracasParts(cfg.date).hour < 12;

  if (cfg.phase === Status.PROGRAMADA && cfg.confirmedEarly?.length) {
    // Algunos docentes ya entraron al chat antes de iniciar.
    clock = addMinutes(cfg.date, -12);
    const early = cfg.confirmedEarly.filter((key) => key !== presiderKey && has(key));
    say(presiderKey, 'Buenas, colegas. En unos minutos iniciamos; vayan confirmando su asistencia en el sistema por favor.', 5, 30);
    early.slice(0, 3).forEach((key) => say(key, pick(morning ? GREETINGS : AFTERNOON_GREETINGS), 20, 60));
    if (clock.getTime() > NOW.getTime()) {
      // Si la reunion empieza muy pronto, el chat previo queda en el pasado inmediato.
      const shift = clock.getTime() - NOW.getTime() + 30_000;
      chatRows.forEach((row) => (row.createdAt = new Date(row.createdAt.getTime() - shift)));
    }
  }

  if (started) {
    say(
      presiderKey,
      `${morning ? 'Buenos días' : 'Buenas tardes'}, colegas. Siendo las ${formatHour(clock)} damos inicio a la ${cfg.title}.`,
      0,
      20,
    );
    shuffle(speakers)
      .slice(0, Math.min(speakers.length, randInt(3, 7)))
      .forEach((key) => say(key, pick(morning ? GREETINGS : AFTERNOON_GREETINGS), 10, 45));

    say(
      presiderKey,
      `Se verifica el quórum: ${presentKeys.length} de ${invitees.length} convocados presentes. ${
        hasQuorum ? 'Hay quórum reglamentario, podemos continuar.' : 'No hay quórum reglamentario.'
      }`,
    );

    if (!hasQuorum) {
      say(speakers[0] ?? presiderKey, 'Sin la secretaria no podemos abrir las votaciones, ¿verdad?');
      say(
        presiderKey,
        'Correcto. El sistema no permite iniciar la fase de votación sin quórum. Podemos avanzar en la discusión del convenio y dejar la decisión para una nueva convocatoria.',
      );
      speakers.slice(1, 3).forEach((key) => say(key, pick(FILLERS)));
      say(speakers[0] ?? presiderKey, 'Yo tengo listo el borrador del convenio, lo comparto por aquí para que lo vayan revisando.');
    } else {
      say(
        presiderKey,
        `El orden del día consta de ${sessionPoints.length} puntos. ${
          votingPhase
            ? 'Se abre la fase de votación: votaremos cada punto al terminar su discusión desde el panel de votaciones.'
            : 'Primero haremos la discusión de los puntos y luego abriremos las votaciones.'
        }`,
      );
      if (votingPhase) votingStartedAt = new Date(clock.getTime());

      sessionPoints.slice(0, discussedCount).forEach((point, index) => {
        const isLastDiscussed = index === discussedCount - 1;
        const interrupted = cancelledInSession && isLastDiscussed;
        const leaveOpen = cfg.phase === Status.EN_CURSO && cfg.openLastPoll && isLastDiscussed;
        const topic = point._topic;
        const proposerKey = point._cfg.by && presentKeys.includes(point._cfg.by) ? point._cfg.by : null;

        say(presiderKey, `Punto ${index + 1}: ${point.title}. ${point.description}`, 40, 120);

        if (!topic) {
          // Lectura del acta anterior.
          say(presiderKey, 'Se dio lectura al acta anterior, que fue enviada al correo de todos. ¿Alguna observación?');
          if (speakers.length && chance(0.5)) {
            say(pick(speakers), 'Solo una corrección: en la lista de asistentes faltó una colega que llegó tarde.');
            say(presiderKey, 'Tomado, se corrige antes de cargarla firmada.');
          } else {
            speakers.slice(0, 2).forEach((key) => say(key, 'Sin observaciones.', 10, 40));
          }
          // La lectura del acta anterior se aprueba sin votacion.
          say(presiderKey, 'Queda aprobada la lectura del acta anterior. Este punto no se somete a votación.');
          return;
        } else {
          if (proposerKey) {
            say(proposerKey, `Como proponente del punto, explico brevemente: ${topic.description}`, 40, 120);
          }
          const comments = shuffle(topic.comments).slice(0, randInt(2, topic.comments.length));
          comments.forEach((comment) => say(pick(speakers.length ? speakers : [presiderKey]), comment, 45, 150));
          for (let i = 0; i < randInt(1, 4); i++) {
            say(pick(speakers.length ? speakers : [presiderKey]), pick(FILLERS), 20, 90);
          }
          if (chance(0.35) && speakers.length) say(pick(speakers), pick(LONG_REMARKS), 90, 180);
          if (proposerKey && chance(0.6)) say(proposerKey, 'Gracias por los aportes, los incorporo a la propuesta.');
        }

        if (!votingPhase) {
          say(presiderKey, 'Queda registrado. Lo someteremos a votación cuando abramos la fase de votación.');
          return;
        }

        /* Votacion del punto */
        say(presiderKey, `Sometemos a votación el punto "${point.title}". Por favor emitan su voto en el panel.`);
        const poll = {
          id: randomUUID(),
          meetingId,
          agendaPointId: point.id,
          question: `¿Se aprueba el punto "${point.title}"?`,
          status: PollStatus.CLOSED as PollStatus,
          createdById: userId(presiderKey),
          createdAt: tick(5, 20),
          closedAt: null as Date | null,
        };
        pollRows.push(poll);

        const mood = point._cfg.vote ?? 'favor';
        const pFavor = mood === 'favor' ? 0.88 : mood === 'contra' ? 0.25 : 0.52;
        const partial = interrupted || leaveOpen;
        const pollVoters = partial
          ? shuffle(voters).slice(0, Math.max(1, Math.floor(voters.length * (0.45 + rng() * 0.25))))
          : shuffle(voters);
        let favor = 0;
        let contra = 0;
        pollVoters.forEach((key) => {
          const option = chance(pFavor) ? PollOption.A_FAVOR : PollOption.EN_CONTRA;
          if (option === PollOption.A_FAVOR) favor++;
          else contra++;
          const createdVote = tick(4, 35);
          // ~10% cambia su voto antes del cierre (upsert del voto).
          const changed = chance(0.1);
          voteRows.push({
            id: randomUUID(),
            pollId: poll.id,
            voterId: userId(key),
            option,
            createdAt: createdVote,
            updatedAt: changed ? addSeconds(createdVote, randInt(20, 90)) : createdVote,
          });
        });
        if (pollVoters.length > 3 && chance(0.5)) say(pick(pollVoters), pick(VOTE_REACTIONS), 5, 25);

        if (leaveOpen) {
          poll.status = PollStatus.OPEN;
          const missing = voters.length - pollVoters.length;
          say(presiderKey, `Faltan ${missing} por votar. Recuerden que la votación no se puede cerrar hasta que voten todos los presentes.`);
          if (speakers.length) say(pick(speakers), 'Se me cayó la conexión, ya entro a votar.');
          decisions.push({ title: point.title, favor, contra, approved: false, pending: true });
          return;
        }

        if (interrupted) {
          say(presiderKey, 'Colegas, se acaba de ir la luz en toda la sede y la planta no arrancó. Vamos a tener que suspender.', 10, 40);
          if (speakers.length) say(pick(speakers), 'Desde aquí tampoco hay luz. Quedo atento a la nueva convocatoria.', 10, 40);
          cancelAt = tick(60, 180);
          poll.closedAt = cancelAt; // al cancelar se cierran las votaciones abiertas
          return;
        }

        poll.closedAt = tick(10, 40);
        const approved = favor > contra;
        decisions.push({ title: point.title, favor, contra, approved });
        say(
          presiderKey,
          `Cerrada la votación del punto "${point.title}": ${favor} a favor, ${contra} en contra. El punto queda ${
            approved ? 'APROBADO' : 'NO APROBADO'
          }.`,
          5,
          30,
        );
        if (!approved && speakers.length) say(pick(speakers), 'Propongo que se reformule y se traiga de nuevo en la próxima reunión.');

        if (approved && topic) {
          const presentTeachers = presentKeys.filter((key) => users.get(key)?.role === Role.DOCENTE);
          const responsibleKey =
            proposerKey && users.get(proposerKey)?.role === Role.DOCENTE
              ? proposerKey
              : presentTeachers.length
                ? pick(presentTeachers)
                : presiderKey;
          const deadline = addDays(cfg.date, randInt(7, 45));
          actionRows.push({
            id: randomUUID(),
            description: topic.action,
            deadline: chance(0.9) ? deadline : null,
            completed: deadline.getTime() < NOW.getTime() ? chance(0.7) : chance(0.15),
            responsibleId: userId(responsibleKey),
            meetingId,
          });
        }
      });

      if (cfg.phase === Status.FINALIZADA) {
        // Igual que MeetingService.closeMeeting: lo aprobado que no se voto queda diferido.
        const votedPointIds = new Set(pollRows.map((poll) => poll.agendaPointId));
        const deferred = sessionPoints.filter((point) => !point._cfg.mandatory && !votedPointIds.has(point.id));
        deferred.forEach((point) => (point.status = AgendaStatus.DIFERIDO));
        if (deferred.length > 0) {
          say(
            presiderKey,
            `Por falta de tiempo no alcanzamos a tratar: ${deferred.map((point) => `"${point.title}"`).join(', ')}. Queda${
              deferred.length === 1 ? '' : 'n'
            } diferido${deferred.length === 1 ? '' : 's'} para la próxima reunión.`,
          );
          if (speakers.length) say(pick(speakers), 'De acuerdo, que quede de primero en la próxima convocatoria.');
        }
        say(
          presiderKey,
          `${deferred.length ? 'Sin más tiempo' : 'Agotado el orden del día'}, se levanta la sesión a las ${formatHour(addSeconds(clock, 60))}. El acta firmada será cargada al sistema.`,
        );
        shuffle(speakers)
          .slice(0, randInt(2, 4))
          .forEach((key) => say(key, pick(['Gracias a todos.', 'Feliz resto de día.', 'Gracias, buena reunión.', 'Hasta luego 👋']), 5, 30));
        closedAt = tick(120, 300);
      }
    }
  }

  // En reuniones en curso, todo lo generado debe quedar en el pasado: se comprime la linea de tiempo.
  if (cfg.phase === Status.EN_CURSO && clock.getTime() > NOW.getTime() - 60_000) {
    const start = cfg.date.getTime();
    const factor = (NOW.getTime() - 60_000 - start) / (clock.getTime() - start);
    const remap = (date: Date) => new Date(start + (date.getTime() - start) * factor);
    chatRows.forEach((row) => (row.createdAt = remap(row.createdAt)));
    pollRows.forEach((row) => {
      row.createdAt = remap(row.createdAt);
      if (row.closedAt) row.closedAt = remap(row.closedAt);
    });
    voteRows.forEach((row) => {
      row.createdAt = remap(row.createdAt);
      row.updatedAt = remap(row.updatedAt);
    });
    if (votingStartedAt) votingStartedAt = remap(votingStartedAt);
  }

  /* ---- Acta (Minute) y resumen final ---- */
  const presentCount = presentKeys.length;
  const deferredCount = agendaRows.filter((row) => row.status === AgendaStatus.DIFERIDO).length;
  const finalSummary =
    cfg.phase === Status.FINALIZADA
      ? [
          `Resumen final de la reunion ${cfg.title}.`,
          `Asistentes registrados: ${presentCount}/${invitees.length}.`,
          `Puntos votados: ${pollRows.length}.`,
          `Puntos diferidos a la proxima reunion: ${deferredCount}.`,
          `Acta firmada cargada al sistema.`,
        ].join(' ')
      : null;

  let minuteContent: string | null = null;
  if (cfg.phase === Status.FINALIZADA) {
    const nameOf = (key: string) => users.get(key)?.name ?? key;
    const lines = [
      `ACTA DE ${cfg.title.toUpperCase()}`,
      '',
      `En ${cfg.location}, el día ${formatDate(cfg.date)}, siendo las ${formatHour(cfg.date)}, se reunieron los miembros convocados en sesión ${
        cfg.type === MeetingType.ORDINARIA ? 'ordinaria' : 'extraordinaria'
      } (modalidad ${cfg.modality.toLowerCase()}).`,
      '',
      'ASISTENTES:',
      ...presentKeys.map((key) => `  - ${nameOf(key)}`),
      '',
      'INASISTENCIAS:',
      ...(invitees.filter((key) => !presentKeys.includes(key)).map((key) => {
        const row = attendanceRows[invitees.indexOf(key)];
        return `  - ${nameOf(key)} (${row.status === AttendanceStatus.JUSTIFICADA ? `justificada: ${row.excuse}` : row.excuse ? `ausente: ${row.excuse}` : 'injustificada'})`;
      }) || []),
      '',
      `QUÓRUM: ${hasQuorum ? 'Alcanzado' : 'No alcanzado'} (${presentCount}/${invitees.length}).`,
      '',
      'ORDEN DEL DÍA Y DECISIONES:',
      ...sessionPoints.map((point, index) => {
        const decision = decisions.find((item) => item.title === point.title);
        const result = point._cfg.mandatory
          ? 'Aprobado sin votación.'
          : point.status === AgendaStatus.DIFERIDO
            ? 'DIFERIDO a la próxima reunión (no se alcanzó a tratar).'
            : decision
              ? `${decision.approved ? 'APROBADO' : 'NO APROBADO'} con ${decision.favor} votos a favor y ${decision.contra} en contra.`
              : 'Sin votación.';
        return `  ${index + 1}. ${point.title}: ${result}`;
      }),
      '',
      'ACUERDOS Y RESPONSABLES:',
      ...actionRows.map((action) => {
        const responsible = [...users.values()].find((user) => user.id === action.responsibleId)?.name ?? '';
        return `  - ${action.description} Responsable: ${responsible}.${action.deadline ? ` Plazo: ${formatDate(action.deadline)}.` : ''}`;
      }),
      '',
      `No habiendo más puntos que tratar, se levantó la sesión a las ${formatHour(closedAt ?? cfg.date)}.`,
      '',
      `${users.get(presiderKey)?.name ?? ''} — Secretaría`,
      `${users.get(cfg.organizer)?.name ?? ''} — Coordinación`,
    ];
    minuteContent = lines.join('\n');
  }

  /* ---- Acta firmada (archivo de evidencia) ---- */
  let evidenceSignaturesUrl: string | null = null;
  if (cfg.phase === Status.FINALIZADA || cfg.evidence) {
    const key = `meetings/${meetingId}/evidence/acta-firmada-demo.pdf`;
    const target = join(UPLOADS_ROOT, key);
    fs.mkdirSync(join(UPLOADS_ROOT, 'meetings', meetingId, 'evidence'), { recursive: true });
    fs.writeFileSync(target, buildPdf([cfg.title, formatDate(cfg.date), 'Acta firmada - documento de prueba']));
    evidenceSignaturesUrl = `/uploads/${key}`;
  }

  // En una reunion presencial la discusion ocurre en sala: no hay conversacion en el chat.
  // La linea de tiempo generada se conserva para fechar votaciones y votos.
  if (cfg.modality === MeetingMode.PRESENCIAL) {
    chatRows.length = 0;
  }

  /* ---- Insercion ---- */
  const attendanceFinalized = started;
  await prisma.$transaction(
    async (tx) => {
      await tx.meeting.create({
        data: {
          id: meetingId,
          title: cfg.title,
          description: cfg.description,
          date: cfg.date,
          location: cfg.location,
          meetingType: cfg.type,
          meetingCategory: cfg.category,
          modality: cfg.modality,
          quorumMinimo: cfg.category === MeetingCategory.ASAMBLEA ? 1 : 2,
          hasQuorum,
          attendanceOpensAt: addMinutes(cfg.date, -15),
          attendanceClosesAt: cfg.date,
          attendanceFinalized,
          attendanceFinalizedAt: attendanceFinalized ? cfg.date : null,
          agendaConsolidated: started || Boolean(cfg.consolidated),
          votingOpen: cfg.phase === Status.EN_CURSO && votingPhase && hasQuorum,
          votingStartedAt: votingPhase && hasQuorum ? votingStartedAt : null,
          votingStartedById: votingPhase && hasQuorum && votingStartedAt ? userId(presiderKey) : null,
          evidenceSignaturesUrl,
          isClosed: cfg.phase === Status.FINALIZADA,
          closedAt: cfg.phase === Status.FINALIZADA ? closedAt : null,
          finalSummary,
          status: cfg.phase,
          cancellationReason: cfg.phase === Status.CANCELADA ? cfg.cancel?.reason ?? null : null,
          cancelledAt: cfg.phase === Status.CANCELADA ? cancelAt : null,
          cancelledById: cfg.phase === Status.CANCELADA && cfg.cancel?.by ? userId(cfg.cancel.by) : null,
          organizerId,
        },
      });

      if (attendanceRows.length) await tx.attendance.createMany({ data: attendanceRows });
      await tx.agendaPoint.createMany({
        data: agendaRows.map(({ _cfg, _topic, ...row }) => row),
      });
      if (chatRows.length) await tx.chatMessage.createMany({ data: chatRows });
      if (pollRows.length) await tx.poll.createMany({ data: pollRows });
      if (voteRows.length) await tx.pollVote.createMany({ data: voteRows });
      if (actionRows.length) await tx.actionItem.createMany({ data: actionRows });
      if (minuteContent) {
        await tx.minute.create({ data: { meetingId, content: minuteContent, createdAt: closedAt ?? cfg.date } });
      }
    },
    { timeout: 60_000 },
  );

  totals.reuniones++;
  totals.puntos += agendaRows.length;
  totals.asistencias += attendanceRows.length;
  totals.mensajes += chatRows.length;
  totals.votaciones += pollRows.length;
  totals.votos += voteRows.length;
  totals.acuerdos += actionRows.length;
  totals.actas += minuteContent ? 1 : 0;

  return {
    clave: cfg.key,
    estado: cfg.phase,
    fecha: cfg.date.toISOString().slice(0, 16).replace('T', ' '),
    quorum: hasQuorum ? 'si' : 'no',
    convocados: invitees.length,
    presentes: presentCount,
    puntos: agendaRows.length,
    mensajes: chatRows.length,
    votaciones: pollRows.length,
    votos: voteRows.length,
  };
}

// PDF minimo valido (una pagina con texto) para que la descarga del acta firmada funcione.
function buildPdf(lines: string[]): Buffer {
  const escape = (text: string) =>
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/([()\\])/g, '\\$1');
  const stream = [
    'BT /F1 16 Tf 72 740 Td',
    ...lines.map((line, index) => `${index === 0 ? '' : '0 -24 Td '}(${escape(line)}) Tj`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => (pdf += `${String(offset).padStart(10, '0')} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/* ------------------------------------------------------------------ */
/* Alertas de inasistencia y notificaciones                             */
/* ------------------------------------------------------------------ */

// Replica triggerAbsenceThresholdAlerts: 3 inasistencias injustificadas (AUSENTE sin excusa) en
// reuniones con asistencia finalizada y no canceladas, por docente y año.
async function seedAbsenceAlerts(meetingIds: string[]) {
  const absences = await prisma.attendance.findMany({
    where: {
      meetingId: { in: meetingIds },
      status: AttendanceStatus.AUSENTE,
      OR: [{ excuse: null }, { excuse: '' }],
      user: { role: Role.DOCENTE },
      meeting: { attendanceFinalized: true, status: { not: Status.CANCELADA } },
    },
    include: { meeting: { select: { id: true, date: true, title: true } }, user: { select: { id: true, name: true } } },
    orderBy: { meeting: { date: 'asc' } },
  });

  const byTeacherYear = new Map<string, typeof absences>();
  for (const absence of absences) {
    const key = `${absence.userId}:${absence.meeting.date.getFullYear()}`;
    byTeacherYear.set(key, [...(byTeacherYear.get(key) ?? []), absence]);
  }

  const secretaries = await prisma.user.findMany({
    where: { role: Role.SECRETARIO, isActive: true },
    select: { id: true },
  });
  const reviewerId = userId('sec');
  const reviewPlan = [AbsenceAlertReviewStatus.PENDIENTE, AbsenceAlertReviewStatus.REVISADA, AbsenceAlertReviewStatus.DESCARTADA];
  const reviewNotes: Record<string, string> = {
    [AbsenceAlertReviewStatus.REVISADA]:
      'Se conversó con el docente y se le notificó por escrito. Se compromete a asistir a las próximas convocatorias.',
    [AbsenceAlertReviewStatus.DESCARTADA]:
      'Se verificó que las inasistencias coinciden con un reposo médico consignado tarde en Talento Humano.',
  };

  const result: Array<Record<string, string | number>> = [];
  let index = 0;
  for (const [key, list] of byTeacherYear) {
    if (list.length < ABSENCE_ALERT_THRESHOLD) continue;
    const [teacherId, yearText] = key.split(':');
    const academicYear = Number(yearText);
    const exists = await prisma.absenceAlert.findUnique({
      where: { teacherId_academicYear_threshold: { teacherId, academicYear, threshold: ABSENCE_ALERT_THRESHOLD } },
    });
    if (exists) continue;

    const trigger = list[ABSENCE_ALERT_THRESHOLD - 1];
    const notifiedAt = addMinutes(trigger.meeting.date, randInt(30, 120));
    const reviewStatus = reviewPlan[index++ % reviewPlan.length];
    const reviewedAt = reviewStatus === AbsenceAlertReviewStatus.PENDIENTE ? null : addDays(notifiedAt, randInt(1, 5));
    const summary = `Docente ${trigger.user.name} alcanzó ${ABSENCE_ALERT_THRESHOLD} inasistencias injustificadas en ${academicYear}.`;

    const alert = await prisma.absenceAlert.create({
      data: {
        teacherId,
        meetingId: trigger.meeting.id,
        academicYear,
        threshold: ABSENCE_ALERT_THRESHOLD,
        absencesCount: ABSENCE_ALERT_THRESHOLD,
        summary,
        notifiedAt,
        reviewStatus,
        reviewNotes: reviewNotes[reviewStatus] ?? null,
        reviewedAt,
        reviewedById: reviewedAt ? reviewerId : null,
      },
    });

    await prisma.systemNotification.create({
      data: {
        type: NotificationType.ABSENCE_ALERT,
        title: 'Alerta de inasistencia docente',
        message: summary,
        actionHref: '/dashboard/sanctions',
        absenceAlertId: alert.id,
        createdAt: notifiedAt,
        recipients: {
          create: secretaries.map((secretary) => ({
            userId: secretary.id,
            createdAt: notifiedAt,
            // Pendiente: sin leer. Revisada: leida por quien reviso. Descartada: leida y descartada.
            readAt: reviewedAt && (secretary.id === reviewerId || reviewStatus === AbsenceAlertReviewStatus.DESCARTADA) ? reviewedAt : null,
            dismissedAt: reviewStatus === AbsenceAlertReviewStatus.DESCARTADA && reviewedAt ? addMinutes(reviewedAt, 5) : null,
          })),
        },
      },
    });

    result.push({ docente: trigger.user.name, año: academicYear, inasistencias: list.length, revision: reviewStatus });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Limpieza                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(configKeys: string[]) {
  const demoUsers = await prisma.user.findMany({
    where: { email: { endsWith: `@${DEMO_DOMAIN}` } },
    select: { id: true, role: true },
  });
  const demoStaffIds = demoUsers.filter((user) => user.role !== Role.DOCENTE).map((user) => user.id);
  const demoUserIds = demoUsers.map((user) => user.id);

  const byOrganizer = await prisma.meeting.findMany({
    where: { organizerId: { in: demoStaffIds } },
    select: { id: true },
  });
  const meetingIds = [...new Set([...configKeys.map((key) => demoId(`meeting:${key}`)), ...byOrganizer.map((m) => m.id)])];

  const alerts = await prisma.absenceAlert.findMany({
    where: { OR: [{ meetingId: { in: meetingIds } }, { teacherId: { in: demoUserIds } }] },
    select: { id: true },
  });
  const alertIds = alerts.map((alert) => alert.id);

  await prisma.$transaction([
    prisma.notificationRecipient.deleteMany({ where: { notification: { absenceAlertId: { in: alertIds } } } }),
    prisma.systemNotification.deleteMany({ where: { absenceAlertId: { in: alertIds } } }),
    prisma.absenceAlert.deleteMany({ where: { id: { in: alertIds } } }),
    prisma.pollVote.deleteMany({ where: { poll: { meetingId: { in: meetingIds } } } }),
    prisma.poll.deleteMany({ where: { meetingId: { in: meetingIds } } }),
    prisma.chatMessage.deleteMany({ where: { meetingId: { in: meetingIds } } }),
    prisma.agendaPoint.deleteMany({ where: { meetingId: { in: meetingIds } } }),
    prisma.attendance.deleteMany({ where: { meetingId: { in: meetingIds } } }),
    prisma.actionItem.deleteMany({ where: { meetingId: { in: meetingIds } } }),
    prisma.minute.deleteMany({ where: { meetingId: { in: meetingIds } } }),
    prisma.meeting.deleteMany({ where: { id: { in: meetingIds } } }),
  ]);

  for (const id of meetingIds) {
    fs.rmSync(join(UPLOADS_ROOT, 'meetings', id), { recursive: true, force: true });
  }
  return meetingIds.length;
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('Sembrando usuarios demo...');
  await seedUsers();

  const configs = meetingConfigs();
  const removed = await cleanup(configs.map((cfg) => cfg.key));
  console.log(`Limpieza: ${removed} reuniones demo anteriores eliminadas (si existían).`);

  const summary = [];
  for (const cfg of configs) {
    summary.push(await seedMeeting(cfg));
  }
  const alerts = await seedAbsenceAlerts(configs.map((cfg) => demoId(`meeting:${cfg.key}`)));

  console.log('\nReuniones creadas:');
  console.table(summary);
  console.log('Alertas de inasistencia:');
  console.table(alerts);
  console.log('Totales:');
  console.table(totals);

  console.log(`\nCredenciales (contraseña para todas las cuentas demo: ${DEMO_PASSWORD})`);
  console.table(
    [...staff, ...teachers].map((user) => ({
      email: user.email,
      nombre: user.name,
      rol: user.role,
      activo: user.isActive === false ? 'NO' : 'si',
    })),
  );
  const legacyKeys = Object.keys(LEGACY_TEACHER_EMAILS).filter(has);
  if (legacyKeys.length) {
    console.log(`Usuarios existentes incluidos en reuniones: ${legacyKeys.map((key) => LEGACY_TEACHER_EMAILS[key]).join(', ')}`);
  }
}

main()
  .catch((error) => {
    console.error('Error sembrando datos demo:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
