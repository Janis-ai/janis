import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 3456, height: 2142 } });
await p.setContent(`<body style="margin:0">
  <div style="position:fixed;left:0;right:0;bottom:0;height:96px;background:rgba(12,12,14,.88);
              display:flex;align-items:center;gap:28px;padding:0 60px;
              font:600 44px -apple-system,Helvetica,Arial,sans-serif;color:#fff">
    <span style="color:#7dd3fc;font-weight:800;letter-spacing:1px">JANIS</span>
    <span>Meta App ID 1242623579085955</span>
    <span style="color:#9ca3af">app.janis.ai</span>
    <span style="margin-left:auto;color:#9ca3af;font-size:38px">Term 7.a compliance screencast</span>
  </div></body>`);
await p.screenshot({ path: '/tmp/meta-final/anno.png', omitBackground: true });
await b.close();
console.log('anno ok');
