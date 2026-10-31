<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Recuperacion de contrasena local (Windows, sin Docker)

El usuario inicia el flujo desde **Olvide mi contrasena** en el login. Se envia
unicamente a su correo registrado un enlace privado, de un solo uso, que vence
en 30 minutos. No hay correos, copias ni aprobaciones del administrador.
Solicitar el enlace no cambia la clave; confirmarla invalida las sesiones
anteriores de esa cuenta, incluidas las conexiones del chat.

### Mailpit

Usar el ejecutable Windows de una [release oficial de Mailpit](https://github.com/axllent/mailpit/releases)
y verificar el SHA-256 publicado antes de extraerlo. La instalacion local actual
esta en `%LOCALAPPDATA%\ActasTools\mailpit\v1.32.0`.

```powershell
& "$env:LOCALAPPDATA\ActasTools\mailpit\v1.32.0\mailpit.exe" --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
```

No iniciar una segunda instancia si el panel ya esta disponible. Usar Ctrl+C
para detener la instancia iniciada en la terminal. No configurar relay ni
forwarding y no exponer los puertos a la red.

El panel esta en http://127.0.0.1:8025. **Mailpit captura los mensajes localmente;
no los entrega a Gmail, Outlook ni otras bandejas reales.** No necesita cuenta
ni servicio de pago. Quien tenga acceso al panel puede leer los enlaces de
prueba; usar cuentas de demostracion y no datos reales.

Configurar en `.env`, conservando las demas variables:

```dotenv
MAIL_TRANSPORT=smtp
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_FROM="Sistema de Actas <no-reply@actas.test>"
FRONTEND_URL=http://localhost:5174
```

Las credenciales SMTP son opcionales, pero si se usa autenticacion deben estar
ambas presentes. `FRONTEND_URL` debe coincidir con el origen real de Vite,
sin credenciales, query ni fragmento. Incluir ese origen en `CORS_ORIGINS`.
El enlace usa un fragmento que no se envia al servidor web; la pantalla lo
retira de la barra y lo mantiene solo en memoria. Tras recargar esa pantalla,
reabrir el enlace original del correo. No se envian tokens en logs o respuestas.

### Gmail API: entrega real por HTTPS

Cuando la red bloquea los puertos SMTP 465/587, `MAIL_TRANSPORT=gmail-api`
envia mediante HTTPS (443). La cuenta Gmail autorizada es el remitente;
la recuperacion sigue dirigida unicamente al correo registrado del usuario,
sin copias ni aprobacion del administrador. Este transporte tambien se aplica
a los correos existentes de reuniones y alertas, conservando sus destinatarios.

Gmail API requiere **OAuth de usuario**: la contrasena de aplicacion SMTP y las
cuentas de servicio de Cloud Storage no sirven para autorizar una cuenta Gmail
personal. No compartir credenciales, codigos ni tokens por chat o capturas.

1. Crear o seleccionar un proyecto en [Google Cloud Console](https://console.cloud.google.com/)
  y habilitar **Gmail API** en la biblioteca de APIs.
2. Configurar Google Auth Platform (marca y audiencia externa). Durante pruebas,
  agregar como usuario de prueba solamente la cuenta Gmail que enviara los correos.
3. Crear un cliente OAuth de tipo **Aplicacion de escritorio** y descargar su JSON
  fuera del repositorio. No usar el JSON de una cuenta de servicio.
4. Autorizar esa cuenta con el [flujo oficial de escritorio](https://developers.google.com/identity/protocols/oauth2/native-app):
  navegador del sistema, callback local de loopback, PKCE y validacion de `state`.
  Solicitar solo `https://www.googleapis.com/auth/gmail.send`, acceso offline y
  consentimiento para obtener un refresh token. No solicitar lectura del correo.
5. Introducir los valores en el `.env` local ignorado por Git, sin publicarlos.
  `GMAIL_FROM` debe ser la cuenta autorizada o un alias de envio verificado en Gmail.
  Cambiar `MAIL_TRANSPORT` solo cuando todos los valores esten disponibles:

```dotenv
MAIL_TRANSPORT=gmail-api
GMAIL_CLIENT_ID=<id-del-cliente-oauth>
GMAIL_CLIENT_SECRET=<secreto-del-cliente-oauth>
GMAIL_REFRESH_TOKEN=<refresh-token-obtenido-con-consentimiento>
GMAIL_FROM="Sistema de Actas <cuenta-remitente@gmail.com>"
```

Recompilar y reiniciar el backend para aplicar los cambios. La biblioteca oficial
renueva el access token automaticamente. No se reintenta automaticamente el envio
ante fallos de red ni se cambia a SMTP, para evitar envios duplicados. Los errores
de OAuth/API no exponen credenciales ni el contenido del mensaje. Si falla la
recuperacion, se conserva la clave y se revoca el enlace recien emitido.

**Limites:** Gmail API se puede usar sin contratar Workspace, sujeto a cuotas,
limites de la cuenta y controles antispam; una respuesta de envio no garantiza
que el mensaje llegue a la bandeja principal. En modo externo **Testing**, el
refresh token con permiso Gmail vence a los **7 dias**. Para uso continuo revisar
la publicacion y los requisitos de verificacion de Google; no asumir autorizacion
permanente. Una revocacion, cambio de clave de Gmail u otras politicas tambien
pueden exigir volver a autorizar. No eliminar la configuracion SMTP: para volver
a Mailpit, seleccionar `MAIL_TRANSPORT=smtp` y sus valores locales.

`FRONTEND_URL` debe apuntar al frontend real. Un enlace con `localhost` solo sirve
en el equipo donde se ejecuta la aplicacion; otros equipos requieren una URL
accesible y HTTPS en produccion. Las pruebas unitarias simulan Gmail API; la
entrega real debe verificarse tras autorizar la cuenta, sin cambiar claves reales
como parte de una prueba automatizada.

### Base de datos y arranque

Antes de agregar estructuras, crear y verificar un respaldo con `pg_dump`
en formato custom y `pg_restore --list`. Conservarlo fuera del repositorio.
El schema incorpora `PasswordResetToken` y `User.authVersion`. Aplicar solamente
el SQL aditivo e idempotente de esta funcionalidad; no usar `prisma migrate`,
`db push` ni `reset` por el historial divergente de esta base:

```powershell
npx prisma db execute --file scripts/add-password-recovery.sql
npm run build
```

Si 5000 y 5173 estan ocupados, usar dos terminales sin detener sus procesos.
Desde `Back/`:

```powershell
$env:PORT="5001"
npm run start:prod
```

Desde `front/`:

```powershell
$env:VITE_API_URL="http://localhost:5001"
npm run dev -- --host localhost --port 5174 --strictPort
```

Abrir http://localhost:5174, solicitar el enlace con una cuenta de prueba,
inspeccionar su HTML, texto y destinatario en Mailpit, y confirmar una clave
nueva. La clave anterior debe dejar de funcionar y reutilizar el enlace debe
fallar. Comprobar tambien que una cuenta inexistente recibe la misma respuesta
generica y que no existe mensaje administrativo.

### Pruebas y limites

```powershell
npx jest src/auth/password-recovery.service.spec.ts src/auth/session.service.spec.ts src/auth/recovery-rate-limit.guard.spec.ts src/mail/mail.service.spec.ts src/meeting/meeting-chat.gateway.spec.ts --runInBand
```

El token se almacena como SHA-256; la clave usa bcrypt. Se admiten al menos
6 caracteres y hasta 72 bytes UTF-8. El consumo es transaccional con reintentos
de conflictos de serializacion y revoca los otros enlaces del mismo usuario.
Se limita la emision a una por minuto por cuenta y los intentos a 20 por IP
y 5 por correo/token en 15 minutos. El limitador de intentos y los eventos de
desconexion son locales a una sola instancia; varias instancias requieren
almacenamiento/eventos compartidos. Las respuestas no revelan si el correo
existe; el tiempo de respuesta puede depender del proveedor porque el envio es
sincrono. Una entrega productiva requiere cola de correo, un transporte real
(SMTP con TLS o Gmail API) y HTTPS; Mailpit no sustituye un proveedor de entrega.

No hay fallback que muestre contrasenas o enlaces si el correo falla. La clave
actual se conserva y el token del envio fallido se revoca. El usuario puede
volver a solicitarlo respetando los limites. Un nuevo enlace invalida el anterior.

## Historial de asistencia y amonestaciones

En **Asistencia**, solo ADMIN puede abrir **Historial por docente**: resumen
paginado, busqueda por nombre o cedula, filtros de ano/mes y detalle por reunion.
Incluye docentes desactivados para conservar el historial. SECRETARIO mantiene
el registro operativo por reunion, sin acceso al historial completo ni a sus
porcentajes. DOCENTE no puede consultar registros de otros usuarios.

Solo se cuentan filas de asistencia de usuarios DOCENTE en reuniones donde
estaban convocados, con asistencia finalizada, no canceladas y no futuras.
PENDIENTE no entra en el calculo. El porcentaje es presentes dividido entre
presentes + ausentes + justificadas, por 100; una justificacion no cuenta como
presencia. Sin registros evaluables se muestra **Sin datos**, no 0 %. Los
limites mensuales usan America/Caracas, con inicio incluido y fin excluido.

Al crear una reunion sin `invitedUserIds`, se convocan y guardan todos los
usuarios activos (ADMIN, SECRETARIO y DOCENTE) dentro de la misma transaccion.
Las estadisticas y el umbral de faltas siguen siendo exclusivos de DOCENTE.
Una lista explicita, incluso vacia,
se respeta. No se reconstruyen convocatorias antiguas, ni se crean faltas
retroactivas para docentes nuevos o reuniones sin registros de asistencia.

En **Inasistencias**, ADMIN y SECRETARIO consultan los casos con al menos
**3 faltas injustificadas en el ano**, no en el mes. Una ausencia con texto
de justificacion no sustenta una amonestacion. Consultar casos y registrar o
finalizar asistencia no genera nuevas alertas, correos ni amonestaciones.
Los correos y recordatorios normales de reuniones no cambian.

Solo SECRETARIO puede **Emitir y guardar**, escribiendo el motivo y la accion
realizada. El servidor revalida rol activo, umbral y duplicados dentro de una
transaccion serializable. Se conserva un caso por docente/ano/umbral de 3;
solicitudes simultaneas no crean dos documentos. La emision guarda fecha,
responsable, contenido y una copia de las inasistencias y nombres de respaldo.
Las correcciones posteriores actualizan las estadisticas, no esa evidencia.
No se envia automaticamente por correo ni por notificacion. El docente ve
solo sus documentos en **Mis amonestaciones**; pueden abrirse e imprimirse.

Los endpoints de reportes y documentos son:

- `GET /meetings/attendance/history` y `GET /meetings/attendance/history/:teacherId`: ADMIN.
- `GET /meetings/absence-cases`: ADMIN y SECRETARIO.
- `POST /meetings/absence-cases/:teacherId/warning`: SECRETARIO; cuerpo `{ "year": 2026, "content": "..." }`.
- `GET /meetings/warnings` y `GET /meetings/warnings/:warningId`: personal autorizado; DOCENTE solo sus documentos.

### Actualizacion aditiva y pruebas

Antes de aplicar cambios, crear y verificar un respaldo custom con `pg_dump`
y `pg_restore --list`, fuera del repositorio. La estructura reutiliza
`AbsenceAlert` y agrega `issuedAt`, `issuedById` y `evidence`. Desde `Back/`,
aplicar el SQL idempotente y recompilar, sin `prisma migrate`, `db push` ni reset:

```powershell
npx prisma db execute --file scripts/add-manual-warnings.sql
npm run build
npx jest src/meeting/attendance-report.service.spec.ts src/meeting/meeting.service.spec.ts --runInBand
```

Reiniciar la instancia del backend que usa el frontend para cargar el codigo
compilado. Los reportes aceptan `page` (desde 1) y `limit` (1 a 100). Un filtro
mensual requiere `year`; los casos y documentos se filtran por ano, no por mes.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
