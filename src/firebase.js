// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyC0meS1FmFsnOmZkYHI79be1ine0bYoEEk",
  authDomain: "livetennis-4efe0.firebaseapp.com",
  databaseURL: "https://livetennis-4efe0-default-rtdb.firebaseio.com",
  projectId: "livetennis-4efe0",
  storageBucket: "livetennis-4efe0.firebasestorage.app",
  messagingSenderId: "24185996205",
  appId: "1:24185996205:web:c941330ea0dfadb8d89724",
  measurementId: "G-H6WDQ4PV86"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
