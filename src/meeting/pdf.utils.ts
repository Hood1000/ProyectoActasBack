import * as fs from 'fs';
import { join } from 'path';
import puppeteer from 'puppeteer';

let letterheadCache: string | undefined;

// Membrete institucional embebido en base64: Puppeteer carga el HTML sin URL base y el
// reporte anual archivado en .html debe verse sin depender de archivos externos.
export function letterheadHtml(): string {
  if (letterheadCache === undefined) {
    const path = join(process.cwd(), 'assets', 'membrete.jpg');
    letterheadCache = fs.existsSync(path)
      ? `<header class="letterhead" style="margin: 0 0 16px;"><img alt="Membrete institucional" src="data:image/jpeg;base64,${fs.readFileSync(path).toString('base64')}" style="display: block; width: 100%; height: auto;" /></header>`
      : '';
  }
  return letterheadCache;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
