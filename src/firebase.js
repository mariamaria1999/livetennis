import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

// 1. Go to https://console.firebase.google.com -> create a free project.
// 2. In the project, go to "Build" -> "Realtime Database" -> "Create Database"
//    -> pick a location -> start in "test mode" (or set the rules shown in
//    README.md so anyone can read/write, since this app has no login).
// 3. Go to Project settings (gear icon) -> General -> "Your apps" -> click the
//    web icon (</>) to register a web app -> copy the firebaseConfig object
//    it gives you and paste it below, replacing every "REPLACE_ME" value.
const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  databaseURL: 'https://REPLACE_ME-default-rtdb.firebaseio.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const firebaseConfigured = !Object.values(firebaseConfig).some((v) => String(v).includes('REPLACE_ME'));
