// Detecta el tipo real del archivo por sus primeros bytes. El mimetype que envia el
// navegador lo controla el cliente, asi que no sirve como validacion.
export type DetectedFile = { contentType: string; extension: string };

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);

export function detectFileSignature(buffer: Buffer): DetectedFile | null {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {
    return { contentType: 'application/pdf', extension: '.pdf' };
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', extension: '.png' };
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', extension: '.jpg' };
  }
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', extension: '.webp' };
  }
  // Word 97-2003 (.doc) usa el contenedor OLE2.
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { contentType: 'application/msword', extension: '.doc' };
  }
  // .docx es un zip; se confirma buscando la carpeta "word/" entre las entradas.
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) && buffer.includes('word/')) {
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: '.docx',
    };
  }
  return null;
}
