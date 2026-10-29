import { PDFDocument, StandardFonts } from 'pdf-lib';

/** A real, compressed PDF shared by API and browser tests. */
export async function testPdf(pages = 2): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`PigeonBox document - page ${i}`, { x: 48, y: 700, size: 22, font });
  }
  return Uint8Array.from(await pdf.save({ useObjectStreams: true }));
}
