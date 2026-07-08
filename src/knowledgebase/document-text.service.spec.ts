import { DocumentTextService } from './document-text.service';
import type { UploadedKnowledgeFile } from './uploaded-knowledge-file.type';

type DocumentTextServiceInternals = {
  extractPdfText: (buffer: Buffer) => Promise<string>;
  extractOfficeParserText: (
    buffer: Buffer,
    fileType: string,
    options?: { useOcr?: boolean },
  ) => Promise<string>;
};

describe('DocumentTextService', () => {
  let service: DocumentTextService;

  beforeEach(() => {
    service = new DocumentTextService();
    jest.restoreAllMocks();
  });

  it('uses the PDF text layer before OCR fallback', async () => {
    const internals = service as unknown as DocumentTextServiceInternals;
    const pdfTextSpy = jest
      .spyOn(internals, 'extractPdfText')
      .mockResolvedValue('Alex Morgan pricing test');
    const officeParserSpy = jest.spyOn(internals, 'extractOfficeParserText');

    await expect(
      service.extractText(
        uploadedFile('Alex Morgan.pdf', 'application/pdf', Buffer.from('pdf')),
      ),
    ).resolves.toBe('Alex Morgan pricing test');
    expect(pdfTextSpy).toHaveBeenCalledWith(expect.any(Buffer));
    expect(officeParserSpy).not.toHaveBeenCalled();
  });

  it('falls back to OCR-capable parsing when a PDF has no text layer', async () => {
    const internals = service as unknown as DocumentTextServiceInternals;
    const officeParserSpy = jest
      .spyOn(internals, 'extractOfficeParserText')
      .mockImplementation(async (_buffer, _fileType, options) =>
        options?.useOcr ? 'OCR fallback text' : '',
      );

    jest.spyOn(internals, 'extractPdfText').mockResolvedValue('');

    await expect(
      service.extractText(uploadedFile('scan.pdf', 'application/pdf')),
    ).resolves.toBe('OCR fallback text');
    expect(officeParserSpy).toHaveBeenLastCalledWith(
      expect.any(Buffer),
      'pdf',
      { useOcr: true },
    );
  });

  it('extracts text from other supported document formats', async () => {
    await expect(
      service.extractText(
        uploadedFile(
          'policy.md',
          'text/markdown',
          Buffer.from('# Return Policy\nRefunds are available within 7 days.'),
        ),
      ),
    ).resolves.toContain('Refunds are available within 7 days.');
  });
});

function uploadedFile(
  originalname: string,
  mimetype: string,
  buffer = Buffer.from('%PDF-1.4\n%%EOF'),
): UploadedKnowledgeFile {
  return {
    originalname,
    mimetype,
    size: buffer.length,
    buffer,
  };
}
