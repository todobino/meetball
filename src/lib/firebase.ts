import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyBC1WUHFmBTgrqZV2rFnpFnkYx_LqQpuI8',
  authDomain: 'meetball-6088e.firebaseapp.com',
  projectId: 'meetball-6088e',
  storageBucket: 'meetball-6088e.firebasestorage.app',
  messagingSenderId: '856425031494',
  appId: '1:856425031494:web:3f844d97bf93c28aba6747',
}

const app = initializeApp(firebaseConfig)

export const db = getFirestore(app)
