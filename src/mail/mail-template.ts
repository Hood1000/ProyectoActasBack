import { readFileSync } from 'fs';
import { join } from 'path';
import type { Attachment } from 'nodemailer/lib/mailer';

export type EmailTone = 'info' | 'success' | 'warning' | 'danger';

export interface EmailContent {
  preheader: string;
  eyebrow: string;
  title: string;
  // Texto plano; **texto** se muestra en negrita.
  paragraphs: string[];
  details?: { label: string; value: string }[];
  action?: { label: string; url: string; showFallbackLink?: boolean };
  note?: string;
  tone?: EmailTone;
}

const BRAND = {
  navy: '#102a71',
  ink: '#0f172a',
  orange: '#f97316',
  page: '#eef2f8',
  border: '#dbe3f0',
  text: '#334155',
  muted: '#64748b',
};

const TONES: Record<EmailTone, { pill: string; pillText: string; noteBg: string; noteBorder: string }> = {
  info: { pill: BRAND.orange, pillText: '#ffffff', noteBg: '#eff6ff', noteBorder: '#1d4ed8' },
  success: { pill: '#10b981', pillText: '#ffffff', noteBg: '#ecfdf5', noteBorder: '#0f766e' },
  warning: { pill: '#f59e0b', pillText: '#1f2937', noteBg: '#fff7ed', noteBorder: BRAND.orange },
  danger: { pill: '#e11d48', pillText: '#ffffff', noteBg: '#fff1f2', noteBorder: '#e11d48' },
};

const FONT = `'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

const INLINE_ASSETS = [
  { cid: 'upt-logo', filename: 'upt-logo.png', contentType: 'image/png' },
  { cid: 'upt-campus', filename: 'upt-campus.jpg', contentType: 'image/jpeg' },
];
const assetCache = new Map<string, Buffer>();

function loadAsset(filename: string): Buffer {
  let content = assetCache.get(filename);
  if (!content) {
    content = readFileSync(join(__dirname, 'assets', filename));
    assetCache.set(filename, content);
  }
  return content;
}

// Adjunta como imagenes embebidas (CID) los recursos que el HTML referencia.
export function inlineAttachmentsFor(html: unknown): Attachment[] {
  if (typeof html !== 'string') return [];
  return INLINE_ASSETS
    .filter((asset) => html.includes(`cid:${asset.cid}`))
    .map((asset) => ({
      cid: asset.cid,
      filename: asset.filename,
      contentType: asset.contentType,
      contentDisposition: 'inline' as const,
      content: loadAsset(asset.filename),
    }));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function richText(value: string): string {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0f172a;">$1</strong>');
}

function plainText(value: string): string {
  return value.replace(/\*\*(.+?)\*\*/g, '$1');
}

// URL absoluta del frontend para una ruta interna; null si FRONTEND_URL no es valida.
export function appUrl(path = '/'): string | null {
  const configuredUrl = process.env.FRONTEND_URL;
  if (!configuredUrl) return null;
  try {
    const url = new URL(configuredUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function renderEmail(content: EmailContent): { html: string; text: string } {
  const tone = TONES[content.tone ?? 'info'];
  const homeUrl = appUrl('/');

  const paragraphs = content.paragraphs
    .map((paragraph) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BRAND.text};">${richText(paragraph)}</p>`)
    .join('');

  const details = content.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;border-collapse:separate;">
        ${content.details.map((detail, index) => `<tr><td style="padding:14px 18px;${index ? 'border-top:1px solid #e2e8f0;' : ''}">
          <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${BRAND.muted};">${escapeHtml(detail.label)}</div>
          <div style="margin-top:4px;font-size:15px;font-weight:600;line-height:1.45;color:${BRAND.ink};">${escapeHtml(detail.value)}</div>
        </td></tr>`).join('')}
      </table>`
    : '';

  const action = content.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr>
        <td bgcolor="${BRAND.orange}" style="border-radius:10px;background:${BRAND.orange};">
          <a href="${escapeHtml(content.action.url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(content.action.label)}</a>
        </td>
      </tr></table>
      ${content.action.showFallbackLink ? `<p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:${BRAND.muted};">Si el bot&oacute;n no funciona, copia y pega este enlace en tu navegador:<br><a href="${escapeHtml(content.action.url)}" target="_blank" style="color:#1d4ed8;word-break:break-all;">${escapeHtml(content.action.url)}</a></p>` : ''}`
    : '';

  const note = content.note
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr>
        <td style="padding:14px 18px;background:${tone.noteBg};border-left:4px solid ${tone.noteBorder};border-radius:8px;font-size:14px;line-height:1.6;color:${BRAND.text};">${richText(content.note)}</td>
      </tr></table>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(content.title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};font-family:${FONT};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(content.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${BRAND.page}" style="background:${BRAND.page};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;border-collapse:separate;">
        <tr><td height="6" bgcolor="${BRAND.orange}" style="height:6px;line-height:6px;font-size:0;background:${BRAND.orange};">&nbsp;</td></tr>
        <tr><td bgcolor="#ffffff" style="padding:18px 28px;background:#ffffff;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="64" valign="middle"><img src="cid:upt-logo" width="64" height="64" alt="UPT Jos&eacute; F&eacute;lix Ribas" style="display:block;width:64px;height:64px;border:0;"></td>
            <td valign="middle" style="padding-left:14px;font-family:${FONT};">
              <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.muted};">Universidad Polit&eacute;cnica Territorial</div>
              <div style="margin-top:2px;font-size:19px;font-weight:800;color:${BRAND.navy};">Jos&eacute; F&eacute;lix Ribas</div>
            </td>
            <td align="right" valign="middle" style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.5px;color:${BRAND.orange};white-space:nowrap;">Sistema de Actas</td>
          </tr></table>
        </td></tr>
        <tr><td style="font-size:0;line-height:0;"><img src="cid:upt-campus" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
        <tr><td bgcolor="${BRAND.navy}" style="padding:6px 28px 28px;background:${BRAND.navy};font-family:${FONT};">
          <span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${tone.pill};color:${tone.pillText};font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(content.eyebrow)}</span>
          <h1 style="margin:14px 0 0;font-size:25px;line-height:1.3;font-weight:800;color:#ffffff;">${escapeHtml(content.title)}</h1>
        </td></tr>
        <tr><td style="padding:30px 28px 22px;font-family:${FONT};">
          ${paragraphs}${details}${action}${note}
        </td></tr>
        <tr><td bgcolor="${BRAND.ink}" style="padding:22px 28px;background:${BRAND.ink};font-family:${FONT};font-size:12px;line-height:1.6;color:#94a3b8;">
          Mensaje autom&aacute;tico del <strong style="color:#e2e8f0;">Sistema de Actas</strong> de la Universidad Polit&eacute;cnica Territorial Jos&eacute; F&eacute;lix Ribas. Por favor, no respondas a este correo.
          ${homeUrl ? `<br><a href="${escapeHtml(homeUrl)}" target="_blank" style="color:${BRAND.orange};font-weight:700;text-decoration:none;">Ir al Sistema de Actas &rarr;</a>` : ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    content.title,
    '',
    ...content.paragraphs.map(plainText),
    ...(content.details?.length ? ['', ...content.details.map((detail) => `${detail.label}: ${detail.value}`)] : []),
    ...(content.action ? ['', `${content.action.label}: ${content.action.url}`] : []),
    ...(content.note ? ['', plainText(content.note)] : []),
    '',
    '--',
    'Sistema de Actas - Universidad Politecnica Territorial Jose Felix Ribas',
    ...(homeUrl ? [homeUrl] : []),
  ].join('\n');

  return { html, text };
}
