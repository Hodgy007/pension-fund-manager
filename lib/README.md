# Vendored libraries

Third-party readers, committed here rather than loaded from a CDN. The page
handles salary, date of birth and pot values, so it makes **no third-party
requests for code**: nothing to block, nothing to intercept, and the app works
offline or behind a proxy that blocks CDNs.

| File | Package | Version | Used for |
|------|---------|---------|----------|
| `xlsx.full.min.js` | [`xlsx`](https://www.npmjs.com/package/xlsx) (SheetJS) | 0.18.5 | reading `.xlsx` / `.xls` / `.csv` price histories |
| `jszip.min.js` | [`jszip`](https://www.npmjs.com/package/jszip) | 3.10.1 | expanding a dropped `.zip` of downloads |
| `pdf.min.js`, `pdf.worker.min.js` | [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) | bundled | reading factsheet and annual statement PDFs |

## Updating

Take the file from the published package rather than a CDN mirror, so the
provenance is the registry tarball:

```bash
npm pack xlsx@<version>
tar xzf xlsx-<version>.tgz
cp package/dist/xlsx.full.min.js lib/
```

Then update the version in the table above, reload the page and re-upload a
spreadsheet, a zip and a PDF to confirm all three readers still work.
