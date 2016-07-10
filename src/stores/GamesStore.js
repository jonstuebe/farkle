import Reflux from 'reflux';
import Actions from '../actions/Actions';

let defaultData = [
    {
        id: 29459,
        details: 'Tortor Pharetra Euismod Adipiscing Sollicitudin',
        players: ['Jon', 'Josh', 'Kevin'],
        active: false,
    },
    // {
    //     id: 29459,
    //     details: 'Tortor Pharetra Euismod Adipiscing Sollicitudin',
    //     players: ['Jon', 'Josh', 'Kevin'],
    //     active: false,
    // },
    // {
    //     id: 29459,
    //     details: 'Tortor Pharetra Euismod Adipiscing Sollicitudin',
    //     players: ['Jon', 'Josh', 'Kevin'],
    //     active: false,
    // },
    // {
    //     id: 29459,
    //     details: 'Tortor Pharetra Euismod Adipiscing Sollicitudin',
    //     players: ['Jon', 'Josh', 'Kevin'],
    //     active: false,
    // },
];

const GamesStore = Reflux.createStore({

    listenables: Actions,

    onCreateGame() {
        console.log('create game');
    },

    getInitialState() {
        return defaultData;
    },

});

export default GamesStore;
