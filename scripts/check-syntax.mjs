// Fast syntax gate for the inline application script in index.html.
// Compiling with vm.Script surfaces the exact class of error (e.g. smart quotes
// used as string delimiters) that once silently broke every interaction.
import vm from 'node:vm';
import { extractInlineScript } from '../tests/harness.mjs';

try {
  const src = extractInlineScript();
  new vm.Script(src, { filename: 'index.inline.js' });
  console.log('OK: inline script parses cleanly');
} catch (err) {
  console.error('SYNTAX ERROR in index.html inline script:');
  console.error('  ' + err.message);
  process.exit(1);
}
