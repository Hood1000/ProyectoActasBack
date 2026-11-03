import { describeMailError } from './mail-error';

describe('describeMailError', () => {
  it('reports nodemailer timeouts with a hint about blocked ports', () => {
    const error = Object.assign(new Error('Connection timeout to smtp.private.test'), { code: 'ETIMEDOUT', command: 'CONN' });
    const description = describeMailError(error);
    expect(description).toContain('code=ETIMEDOUT');
    expect(description).toContain('puerto bloqueado');
    expect(description).toContain('command=CONN');
    expect(description).not.toContain('private');
  });

  it('reports SMTP auth rejections with the response code', () => {
    const error = Object.assign(new Error('535 user private@example.test rejected'), { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 });
    const description = describeMailError(error);
    expect(description).toContain('code=EAUTH');
    expect(description).toContain('responseCode=535');
    expect(description).not.toContain('private');
  });

  it('keeps only fixed configuration messages', () => {
    expect(describeMailError(new Error('Configuracion SMTP incompleta'))).toBe('Configuracion SMTP incompleta');
    expect(describeMailError(new Error('private details'))).toBe('causa desconocida');
  });

  it('ignores codes that do not look like error identifiers', () => {
    expect(describeMailError({ code: 'user@private.test', command: 'RCPT TO:<private@example.test>' })).toBe('causa desconocida');
    expect(describeMailError(null)).toBe('causa desconocida');
  });
});
