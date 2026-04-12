import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

const OUTPUT_DIR = path.join(os.homedir(), 'Desktop', 'Image Generations');

export interface ImageGenResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

/**
 * Generate an image via OpenAI gpt-image-1 and save to ~/Desktop/Image Generations/.
 */
export async function generateImage(
  prompt: string,
  apiKey: string,
  size: string = '1024x1024',
): Promise<ImageGenResult> {
  if (!apiKey) {
    return { success: false, error: 'OpenAI API Key nicht konfiguriert. Bitte in den Einstellungen hinterlegen.' };
  }

  // Validate size
  const validSizes = ['1024x1024', '1536x1024', '1024x1536'];
  if (!validSizes.includes(size)) size = '1024x1024';

  try {
    logger.info(`ImageGen: generating image — prompt: "${prompt.slice(0, 80)}…", size: ${size}`);

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`ImageGen: API error ${res.status}: ${body.slice(0, 200)}`);
      return { success: false, error: `OpenAI API Fehler ${res.status}: ${body.slice(0, 150)}` };
    }

    const json = await res.json() as { data: Array<{ b64_json?: string; url?: string }> };
    const imageData = json.data?.[0];

    if (!imageData) {
      return { success: false, error: 'Kein Bild in der API-Antwort erhalten.' };
    }

    // Ensure output directory exists
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Generate filename with timestamp
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    // Short slug from prompt for filename
    const slug = prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '').toLowerCase();
    const filename = `image_${ts}_${slug}.png`;
    const filePath = path.join(OUTPUT_DIR, filename);

    if (imageData.b64_json) {
      // Base64 response — decode and write
      fs.writeFileSync(filePath, Buffer.from(imageData.b64_json, 'base64'));
    } else if (imageData.url) {
      // URL response — download and write
      const imgRes = await fetch(imageData.url);
      if (!imgRes.ok) {
        return { success: false, error: `Bild-Download fehlgeschlagen: ${imgRes.status}` };
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
    } else {
      return { success: false, error: 'API-Antwort enthielt weder b64_json noch url.' };
    }

    logger.success(`ImageGen: saved to ${filePath}`);
    return { success: true, filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`ImageGen: ${msg}`);
    return { success: false, error: `Bildgenerierung fehlgeschlagen: ${msg}` };
  }
}
