import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyC0meS1FmFsnOmZkYHI79be1ine0bYoEEk',
  authDomain: 'livetennis-4efe0.firebaseapp.com',
  databaseURL: 'https://livetennis-4efe0-default-rtdb.firebaseio.com',
  projectId: 'livetennis-4efe0',
  storageBucket: 'livetennis-4efe0.firebasestorage.app',
  messagingSenderId: '24185996205',
  appId: '1:24185996205:web:c941330ea0dfadb8d89724',
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const firebaseConfigured = !Object.values(firebaseConfig).some((v) => String(v).includes('REPLACE_ME'));
