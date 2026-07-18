import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const blobs = await list({ limit: 100 });

    // Filter for CSV, PDF, Excel and zip files, sort by date descending (latest first)
    const fundFiles = blobs.blobs
      .filter(b => /\.(csv|pdf|xlsx?|zip)$/i.test(b.pathname))
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      .map(b => ({
        name: b.pathname.split('/').pop(),
        url: b.url,
        size: b.size,
        uploaded: b.uploadedAt,
      }));

    res.status(200).json({
      success: true,
      files: fundFiles,
      latest: fundFiles[0] || null,
    });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list files', details: error.message });
  }
}
