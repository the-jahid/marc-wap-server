import { BadRequestException, Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { OfficeParser, type SupportedFileType } from 'officeparser';
import type { UploadedKnowledgeFile } from './uploaded-knowledge-file.type';

const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SUPPORTED_OFFICE_TYPES = new Set<SupportedFileType>([
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'pdf',
  'rtf',
  'csv',
  'md',
  'html',
]);
const OCR_FALLBACK_TYPES = new Set<SupportedFileType>([
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'pdf',
  'rtf',
]);

type ExtractionAttempt = {
  label: string;
  extract: () => Promise<string>;
};

@Injectable()
export class DocumentTextService {
  async extractText(file: UploadedKnowledgeFile): Promise<string> {
    const fileName = file.originalname.toLowerCase();
    const mimeType = file.mimetype.toLowerCase();
    const officeFileType = this.getOfficeFileType(fileName);

    if (this.isPdfFile(fileName, mimeType, officeFileType)) {
      return this.extractPdfDocument(file.buffer);
    }

    if (this.isDocxFile(fileName, mimeType, officeFileType)) {
      return this.extractDocxDocument(file.buffer);
    }

    if (officeFileType) {
      return this.extractOfficeDocument(file.buffer, officeFileType);
    }

    return this.ensureExtractedText(this.extractPlainText(file.buffer));
  }

  private async extractPdfDocument(buffer: Buffer): Promise<string> {
    return this.extractFirstReadableText(
      [
        {
          label: 'PDF text layer',
          extract: () => this.extractPdfText(buffer),
        },
        {
          label: 'Office PDF parser',
          extract: () => this.extractOfficeParserText(buffer, 'pdf'),
        },
        {
          label: 'PDF OCR',
          extract: () =>
            this.extractOfficeParserText(buffer, 'pdf', { useOcr: true }),
        },
      ],
      'No readable text could be extracted from this PDF. If it is scanned or image-only, OCR did not find text.',
      'Could not extract text from PDF file',
    );
  }

  private async extractDocxDocument(buffer: Buffer): Promise<string> {
    return this.extractFirstReadableText(
      [
        {
          label: 'DOCX text',
          extract: () => this.extractDocxText(buffer),
        },
        {
          label: 'Office DOCX parser',
          extract: () => this.extractOfficeParserText(buffer, 'docx'),
        },
        {
          label: 'DOCX OCR',
          extract: () =>
            this.extractOfficeParserText(buffer, 'docx', { useOcr: true }),
        },
      ],
      'No readable text could be extracted from this DOCX document. If it only contains images, OCR did not find text.',
      'Could not extract text from DOCX file',
    );
  }

  private async extractOfficeDocument(
    buffer: Buffer,
    fileType: SupportedFileType,
  ): Promise<string> {
    const attempts: ExtractionAttempt[] = [
      {
        label: `${fileType.toUpperCase()} parser`,
        extract: () => this.extractOfficeParserText(buffer, fileType),
      },
    ];

    if (OCR_FALLBACK_TYPES.has(fileType)) {
      attempts.push({
        label: `${fileType.toUpperCase()} OCR`,
        extract: () =>
          this.extractOfficeParserText(buffer, fileType, { useOcr: true }),
      });
    }

    return this.extractFirstReadableText(
      attempts,
      `No readable text could be extracted from this ${fileType.toUpperCase()} document.`,
      `Could not extract text from ${fileType.toUpperCase()} file`,
    );
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });

    try {
      const result = await parser.getText({
        pageJoiner: '\n\n',
        parseHyperlinks: true,
      });

      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  private async extractDocxText(buffer: Buffer): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });

    return result.value;
  }

  private extractPlainText(buffer: Buffer): string {
    return buffer.toString('utf8').split(String.fromCharCode(0)).join('');
  }

  private async extractOfficeParserText(
    buffer: Buffer,
    fileType: SupportedFileType,
    options: { useOcr?: boolean } = {},
  ): Promise<string> {
    const useOcr = options.useOcr === true;
    const ast = await OfficeParser.parseOffice(buffer, {
      fileType,
      newlineDelimiter: '\n',
      ignoreComments: true,
      ignoreHeadersAndFooters: true,
      ignoreInternalLinks: true,
      ignoreSlideMasters: true,
      extractAttachments: useOcr,
      ocr: useOcr,
      ocrConfig: useOcr
        ? {
            language: 'eng',
            timeout: {
              autoTerminate: 1000,
            },
          }
        : undefined,
    });

    return ast.toText();
  }

  private async extractFirstReadableText(
    attempts: ExtractionAttempt[],
    emptyMessage: string,
    errorPrefix: string,
  ): Promise<string> {
    let firstError: string | null = null;

    for (const attempt of attempts) {
      try {
        const normalized = this.normalizeExtractedText(
          await attempt.extract(),
        );

        if (normalized) {
          return normalized;
        }
      } catch (error) {
        firstError ??= `${attempt.label}: ${this.errorToMessage(error)}`;
      }
    }

    if (firstError) {
      throw new BadRequestException(`${errorPrefix}: ${firstError}`);
    }

    throw new BadRequestException(emptyMessage);
  }

  private getOfficeFileType(fileName: string): SupportedFileType | null {
    const extension = fileName.split('.').pop();

    if (
      !extension ||
      !SUPPORTED_OFFICE_TYPES.has(extension as SupportedFileType)
    ) {
      return null;
    }

    return extension as SupportedFileType;
  }

  private isPdfFile(
    fileName: string,
    mimeType: string,
    fileType: SupportedFileType | null,
  ): boolean {
    return (
      fileType === 'pdf' || mimeType.includes('pdf') || fileName.endsWith('.pdf')
    );
  }

  private isDocxFile(
    fileName: string,
    mimeType: string,
    fileType: SupportedFileType | null,
  ): boolean {
    return (
      fileType === 'docx' ||
      mimeType === DOCX_MIME_TYPE ||
      fileName.endsWith('.docx')
    );
  }

  private normalizeExtractedText(text: string): string | null {
    const normalized = text
      .split(String.fromCharCode(0))
      .join('')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();

    return normalized || null;
  }

  private ensureExtractedText(text: string): string {
    const normalized = this.normalizeExtractedText(text);

    if (!normalized) {
      throw new BadRequestException(
        'No readable text could be extracted from this file',
      );
    }

    return normalized;
  }

  private errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
