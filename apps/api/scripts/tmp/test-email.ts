import { createDb } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
// direct Resend send to verify the domain works now
const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  body: JSON.stringify({
    from: 'Janis <alerts@inbound.janis.ai>',
    to: ['michael.nathanson@gmail.com'],
    subject: 'Janis alert — live concierge verification results ready',
    text: 'The concierge verification battery is done and saved as regression tests.\n\nTranscript: https://app.janis.ai/conversations/1fb291f8-c3f9-422d-bf3d-09766829efb6\nTests: https://app.janis.ai/agents/13e45248-77e9-4006-b8a5-76c442e522bd/tests\n\n(sent from alerts@inbound.janis.ai — verifying the Resend domain fix)',
  }),
});
console.log('resend:', res.status, await res.text());
process.exit(0);
