import { detectFileSignature } from './file-signature';

describe('detectFileSignature', () => {
  it('detects supported formats by their magic bytes', () => {
    expect(detectFileSignature(Buffer.from('%PDF-1.4'))?.extension).toBe('.pdf');
    expect(detectFileSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.extension).toBe('.png');
    expect(detectFileSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.extension).toBe('.jpg');
    expect(detectFileSignature(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))?.extension).toBe('.webp');
    expect(detectFileSignature(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....word/document.xml')]))?.extension).toBe('.docx');
  });

  it('rejects unknown content and zips that are not Word documents', () => {
    expect(detectFileSignature(Buffer.from('MZ executable'))).toBeNull();
    expect(detectFileSignature(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('payload.js')]))).toBeNull();
  });
});
