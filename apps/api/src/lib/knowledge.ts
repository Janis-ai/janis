import mammoth from 'mammoth';
// Import the lib entry directly — pdf-parse's index.js detects a missing
// module.parent under ESM and returns test data instead of the parser.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export interface KnowledgeLlm {
  apiKey: string;
  baseUrl: string;
  model: string;
  headers?: Record<string, string>;
}

export class UnsupportedFileError extends Error {}

const MAX_FILE_CHARS = 80_000;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm',
  'log', 'yaml', 'yml', 'ini', 'cfg', 'rst', 'tex',
]);

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function ext(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function clean(text: string): string {
  // strip nulls/control chars that break DB storage and prompt quality
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, MAX_FILE_CHARS);
}

/**
 * Ask the configured OpenAI-compatible LLM to transcribe/describe an image
 * so it can serve as knowledge text. Gemini + OpenAI vision models both
 * accept data-URI image_url parts.
 */
async function describeImage(buf: Buffer, mime: string, llm: KnowledgeLlm): Promise<string> {
  if (!llm.apiKey) {
    throw new UnsupportedFileError('images need an LLM configured to extract knowledge');
  }
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${llm.apiKey}`,
      ...(llm.headers ?? {}),
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract all readable text from this image, then describe anything else a support agent would need to answer questions about it (labels, options, diagrams, product details). Output plain text only — no preamble.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${buf.toString('base64')}` },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`vision extraction failed: HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('vision extraction returned nothing');
  return text;
}

/** Extract searchable text from an uploaded file. Throws UnsupportedFileError for unknown types. */
export async function extractKnowledgeText(
  buf: Buffer,
  mime: string,
  name: string,
  llm: KnowledgeLlm,
): Promise<string> {
  const e = ext(name);

  if (mime === 'application/pdf' || e === 'pdf') {
    const data = await pdfParse(buf);
    const text = clean(data.text ?? '');
    if (!text) {
      throw new Error('no readable text in PDF (may be a scan — convert or upload as images)');
    }
    return text;
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    e === 'docx'
  ) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const text = clean(value ?? '');
    if (!text) throw new Error('no readable text in document');
    return text;
  }

  if (IMAGE_MIMES.has(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(e)) {
    const imageMime = IMAGE_MIMES.has(mime) ? mime : `image/${e === 'jpg' ? 'jpeg' : e}`;
    return clean(await describeImage(buf, imageMime, llm));
  }

  if (mime.startsWith('text/') || TEXT_EXTS.has(e) || mime === 'application/json') {
    const text = clean(buf.toString('utf8'));
    if (!text) throw new Error('file is empty');
    return text;
  }

  throw new UnsupportedFileError(
    `unsupported file type (${mime || e || 'unknown'}) — use PDF, DOCX, text files, or images`,
  );
}
