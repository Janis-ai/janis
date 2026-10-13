import '../../src/loadEnv.js';
import { fetchUrlText } from '../../src/lib/urlSource.js';
for (const u of [
  'https://jonathanferrier.com/properties/44-moberly-avenue',
  'https://jonathanferrier.com/properties/211walmerrd',
]) {
  const r = await fetchUrlText(u);
  console.log(u, '→', r.imageUrl ?? '(no image)');
}
process.exit(0);
