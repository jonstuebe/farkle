import React from 'react';
import { render } from 'react-dom';
import RouterContainer from './RouterContainer';
// import firebase from 'firebase';
// import reactfire from 'reactfire';

// const config = {
//     apiKey: "AIzaSyBii62DjPh2rQD4Mg5lV6aUfLZmkX-vHYo",
//     authDomain: "project-5176540971467980605.firebaseapp.com",
//     databaseURL: "https://project-5176540971467980605.firebaseio.com",
//     storageBucket: "project-5176540971467980605.appspot.com",
// };

// firebase.initializeApp(config);

// const _games = firebase.database().ref('games');
// const _players = firebase.database().ref('players');

render(<RouterContainer />, document.getElementById('root'));
