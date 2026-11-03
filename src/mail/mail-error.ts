// Mensajes fijos que lanzan MailService y PasswordRecoveryService; no contienen datos del usuario.
const knownMessages = [
  'Configuracion SMTP incompleta',
  'Las credenciales SMTP deben configurarse juntas',
  'Transporte de correo no reconocido',
  'Configuracion Gmail API incompleta',
  'No se pudo enviar el correo mediante Gmail API',
  'Respuesta Gmail API incompleta',
  'Configuracion de recuperacion incompleta',
  'Configuracion de recuperacion invalida',
];

const hints: Record<string, string> = {
  ETIMEDOUT: 'el servidor SMTP no respondio (puerto bloqueado por el hosting o host incorrecto)',
  ECONNECTION: 'no se pudo conectar al servidor SMTP (puerto bloqueado por el hosting o host incorrecto)',
  ESOCKET: 'la conexion SMTP se corto (revisar puerto y SSL: 465 usa SSL, 587 usa STARTTLS)',
  EDNS: 'SMTP_HOST no se pudo resolver',
  EAUTH: 'credenciales SMTP rechazadas (en Gmail usar contrasena de aplicacion)',
  EENVELOPE: 'remitente o destinatario rechazado por el servidor',
  EMESSAGE: 'el servidor rechazo el mensaje',
  ERR_INVALID_URL: 'FRONTEND_URL no es una URL valida',
};

// Describe un fallo de envio solo con campos tecnicos seguros (codigo, comando, estado), nunca con el mensaje original.
export function describeMailError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'causa desconocida';
  const { code, command, responseCode, message } = error as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) {
    parts.push(`code=${code}`);
    if (hints[code]) parts.push(hints[code]);
  }
  if (typeof command === 'string' && /^[A-Z ]{1,20}$/.test(command)) parts.push(`command=${command}`);
  if (typeof responseCode === 'number') parts.push(`responseCode=${responseCode}`);
  if (typeof message === 'string' && knownMessages.includes(message)) parts.push(message);
  return parts.length ? parts.join(', ') : 'causa desconocida';
}
