/**
 * Asigna rol admin a un usuario existente de Firebase Auth.
 * Uso: npm run bootstrap:admin -- correo@empresa.com
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const email = process.argv[2];
if (!email) {
  console.error('Uso: npm run bootstrap:admin -- correo@empresa.com');
  process.exit(1);
}
initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT });
const user = await getAuth().getUserByEmail(email);
await getFirestore()
  .collection('users')
  .doc(user.uid)
  .set({ email: email.toLowerCase(), role: 'admin', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
console.log(`✔ ${email} ahora es administrador (uid ${user.uid})`);
