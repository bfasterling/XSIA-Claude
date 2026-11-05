/**
 * Crea un agente de demostración y un par de distribuidores de ejemplo.
 * Uso: npm run seed:demo
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT });
const db = getFirestore();
const ref = db.collection('agents').doc('demo');
await ref.set(
  {
    name: 'Asesor Demo',
    slug: 'demo',
    description: 'Agente de demostración de XSIA Claude',
    status: 'active',
    instructions: {
      main: 'Eres un asesor comercial automotriz profesional y amable. Respondes en español de México.',
      specific: 'Representas a una red de distribuidores. Ayudas a elegir vehículo, resolver dudas y agendar contacto con un asesor.',
      welcomeMessage: '¡Hola! Soy tu asesor virtual. ¿Qué vehículo te interesa?',
      responseStyle: 'Respuestas breves, en primera persona, con viñetas cuando ayuden.',
      ctaCriteria: 'Sugiere hasta 3 pasos: ver versiones, cotizar, buscar distribuidor, hablar con asesor.',
    },
    distribution: { published: true, starterCtas: ['Ver modelos', 'Cotizar', 'Buscar distribuidor'] },
    dealers: { mode: 'internal', defaultCount: 3 },
    voice: { enabled: true, mode: 'stable', voiceName: 'es-US-Neural2-A', languageCode: 'es-US', silenceMs: 1200, sensitivity: 0.5, speakingRate: 1 },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
  { merge: true },
);
await db.collection('dealers').doc('CDMX01').set({ name: 'Distribuidor Polanco', brand: 'Demo', city: 'Ciudad de México', state: 'CDMX', zip: '11560', lat: 19.4333, lng: -99.1950 });
await db.collection('dealers').doc('GDL01').set({ name: 'Distribuidor Guadalajara Américas', brand: 'Demo', city: 'Guadalajara', state: 'Jalisco', zip: '44630', lat: 20.6866, lng: -103.3707 });
await db.collection('dealers').doc('MTY01').set({ name: 'Distribuidor Monterrey Valle', brand: 'Demo', city: 'San Pedro Garza García', state: 'Nuevo León', zip: '66220', lat: 25.6517, lng: -100.3596 });
console.log('✔ Agente demo creado: /c/demo');
