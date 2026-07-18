import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, content } = req.body;

    if (!name || !content) {
      return res.status(400).json({ error: 'Missing name or content' });
    }

    // Content should be base64 encoded
    const buffer = Buffer.from(content, 'base64');
    const timestamp = Date.now();
    const blobName = `funds/${timestamp}-${name}`;

    const blob = await put(blobName, buffer, { access: 'public' });

    return res.status(200).json({
      success: true,
      url: blob.url,
      name: blob.pathname,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({
      error: 'Upload failed',
      details: error.message
    });
  }
}
